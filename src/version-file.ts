import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import { maxSatisfying, validRange } from '@renovatebot/pep440'
import * as semver from 'semver'
import { parse } from 'smol-toml'
import { getVersionManifest } from './manifest'

type Table = Record<string, unknown>

function table(value: unknown): Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Table)
    : {}
}

function unique(values: string[], source: string): string {
  const versions = [...new Set(values)]
  if (versions.length === 0) throw new Error(`No prek version found in ${source}`)
  if (versions.length > 1) {
    throw new Error(
      `Ambiguous prek versions in ${source}: ${versions.join(', ')}. Set prek-version explicitly.`,
    )
  }
  return versions[0]
}

function unsupportedSource(source: string): never {
  throw new Error(
    `Unsupported prek source in ${source}. version-file selects an official prek release; set prek-version explicitly for the release you want.`,
  )
}

function releaseArtifact(value: unknown): boolean {
  const artifact = table(value)
  return (
    !('path' in artifact) && typeof artifact.url === 'string' && /^https?:\/\//i.test(artifact.url)
  )
}

function registrySource(pkg: Table, filename: string): boolean {
  if (/^pylock(?:\.[^.]+)?\.toml$/.test(filename)) {
    const wheels = pkg.wheels
    return (
      !['vcs', 'directory', 'archive'].some(key => key in pkg) &&
      (!('sdist' in pkg) || releaseArtifact(pkg.sdist)) &&
      (!('wheels' in pkg) || (Array.isArray(wheels) && wheels.every(releaseArtifact))) &&
      ('sdist' in pkg || (Array.isArray(wheels) && wheels.length > 0))
    )
  }
  if (filename === 'poetry.lock') {
    const source = table(pkg.source)
    return (
      !('source' in pkg) ||
      (source.type === 'legacy' && typeof source.url === 'string' && source.url !== '')
    )
  }
  if (filename === 'pdm.lock') {
    return (
      !['git', 'hg', 'svn', 'bzr', 'path', 'url', 'subdirectory'].some(key => key in pkg) &&
      (!('editable' in pkg) || pkg.editable === false)
    )
  }
  if (filename === 'uv.lock') {
    return (
      Object.keys(table(pkg.source)).length === 1 &&
      typeof table(pkg.source).registry === 'string' &&
      table(pkg.source).registry !== ''
    )
  }
  return typeof pkg.source === 'string' && pkg.source.startsWith('registry+')
}

function lockedVersion(data: Table, source: string, filename: string): string {
  const pylock = /^pylock(?:\.[^.]+)?\.toml$/.test(filename)
  if (
    pylock &&
    (typeof data['lock-version'] !== 'string' || !/^1\.\d+$/.test(data['lock-version']))
  ) {
    throw new Error(`Unsupported pylock lock-version in ${source}. Expected major version 1.`)
  }
  const entries = pylock ? data.packages : data.package
  const packages = Array.isArray(entries) ? entries : []
  const versions = packages.flatMap(entry => {
    const pkg = table(entry)
    if (pkg.name !== 'prek') return []
    if (!registrySource(pkg, filename)) unsupportedSource(source)
    if (typeof pkg.version !== 'string') {
      throw new Error(`Missing locked prek version in ${source}`)
    }
    return [pkg.version]
  })
  const version = unique(versions, source)
  if (!semver.valid(version))
    throw new Error(`Invalid locked prek version in ${source}: ${version}`)
  return version
}

function pythonConstraint(data: Table, source: string): string {
  const uv = table(table(data.tool).uv)
  if (
    Array.isArray(uv['override-dependencies']) &&
    uv['override-dependencies'].some(
      dep => typeof dep === 'string' && /^prek(?:\[[^\]]*\])?(?=\s|[<>=!~;(@]|$)/i.test(dep.trim()),
    )
  ) {
    throw new Error(
      `prek dependency overrides in ${source} are unsupported. Use uv.lock or set prek-version explicitly.`,
    )
  }
  const sources = table(uv.sources)
  for (const [name, value] of Object.entries(sources)) {
    if (name.toLowerCase() !== 'prek') continue
    const entries = Array.isArray(value) ? value : [value]
    if (
      entries.some(entry => {
        const keys = Object.keys(table(entry))
        return keys.length !== 1 || keys[0] !== 'index' || typeof table(entry).index !== 'string'
      })
    ) {
      unsupportedSource(source)
    }
  }
  const project = table(data.project)
  const lists = [
    project.dependencies,
    ...Object.values(table(project['optional-dependencies'])),
    ...Object.values(table(data['dependency-groups'])),
  ]
  const constraints = lists.flatMap(list =>
    !Array.isArray(list)
      ? []
      : list.flatMap(dep => {
          if (typeof dep !== 'string') return []
          const match = dep.trim().match(/^prek(?:\[[^\]]*\])?\s*(?=[<>=!~;(@]|$)(.*)$/i)
          if (!match) return []
          if (match[1].trim().startsWith('@')) unsupportedSource(source)
          const constraint = match[1]
            .trim()
            .replace(/^\((.*)\)$/, '$1')
            .trim()
          if (constraint.includes(';')) {
            throw new Error(
              `Conditional prek dependencies in ${source} are unsupported. Use uv.lock or set prek-version explicitly.`,
            )
          }
          if (constraint && !validRange(constraint)) {
            throw new Error(`Invalid prek PEP 440 specifier in ${source}: ${constraint}`)
          }
          return [constraint]
        }),
  )
  return unique(constraints, source)
}

export async function resolveVersionFile(filePath: string): Promise<string> {
  const filename = path.basename(filePath)
  const pylock = /^pylock(?:\.[^.]+)?\.toml$/.test(filename)
  if (
    !['uv.lock', 'poetry.lock', 'pdm.lock', 'pyproject.toml', 'Cargo.lock'].includes(filename) &&
    !pylock
  ) {
    throw new Error(
      `Unsupported version-file: ${filename}. Use uv.lock, poetry.lock, pdm.lock, pylock.toml (or pylock.<name>.toml), pyproject.toml, or Cargo.lock.`,
    )
  }
  let data: Table
  try {
    data = parse(await fs.readFile(filePath, 'utf8')) as Table
  } catch (error) {
    throw new Error(
      `Could not read version-file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  core.info(`Reading prek version from ${filePath}`)
  if (filename.endsWith('.lock') || pylock) return lockedVersion(data, filePath, filename)

  const constraint = pythonConstraint(data, filePath)
  const exact = constraint.match(/^==\s*([^,\s]+)$/)?.[1]
  if (exact && semver.valid(exact)) return exact
  const versions = (await getVersionManifest())
    .filter(release => !release.prerelease)
    .map(release => release.version)
  const version = maxSatisfying(versions, constraint)
  if (!version)
    throw new Error(`No prek release satisfies ${constraint || 'any version'} from ${filePath}`)
  return version
}
