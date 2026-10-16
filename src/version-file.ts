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

function lockedVersion(data: Table, source: string, filename: string): string {
  const packages = Array.isArray(data.package) ? data.package : []
  const versions = packages.flatMap(entry => {
    const pkg = table(entry)
    if (pkg.name !== 'prek') return []
    const registry =
      filename === 'uv.lock'
        ? Object.keys(table(pkg.source)).length === 1 &&
          typeof table(pkg.source).registry === 'string' &&
          table(pkg.source).registry !== ''
        : typeof pkg.source === 'string' && pkg.source.startsWith('registry+')
    if (!registry) unsupportedSource(source)
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
  if (!['uv.lock', 'pyproject.toml', 'Cargo.lock'].includes(filename)) {
    throw new Error(
      `Unsupported version-file: ${filename}. Use uv.lock, pyproject.toml, or Cargo.lock.`,
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
  if (filename.endsWith('.lock')) return lockedVersion(data, filePath, filename)

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
