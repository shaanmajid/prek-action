import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as semver from 'semver'
import { parse } from 'smol-toml'
import { resolvePythonVersion } from './python-version'
import { type Table, table, unique, unsupportedSource } from './version-file-common'

type Format = 'uv' | 'poetry' | 'pdm' | 'pylock' | 'pyproject'

const formats = new Map<string, Format>([
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['pdm.lock', 'pdm'],
  ['pyproject.toml', 'pyproject'],
])

function fileFormat(filename: string): Format {
  const format =
    formats.get(filename) ?? (/^pylock(?:\.[^.]+)?\.toml$/.test(filename) ? 'pylock' : undefined)
  if (!format) {
    throw new Error(
      `Unsupported version-file: ${filename}. Use uv.lock, poetry.lock, pdm.lock, pylock.toml (or pylock.<name>.toml), or pyproject.toml.`,
    )
  }
  return format
}

function releaseArtifact(value: unknown): boolean {
  const artifact = table(value)
  return (
    !('path' in artifact) && typeof artifact.url === 'string' && /^https?:\/\//i.test(artifact.url)
  )
}

function registrySource(pkg: Table, format: Format): boolean {
  if (format === 'pylock') {
    const wheels = pkg.wheels
    return (
      !['vcs', 'directory', 'archive'].some(key => key in pkg) &&
      (!('sdist' in pkg) || releaseArtifact(pkg.sdist)) &&
      (!('wheels' in pkg) || (Array.isArray(wheels) && wheels.every(releaseArtifact))) &&
      ('sdist' in pkg || (Array.isArray(wheels) && wheels.length > 0))
    )
  }
  if (format === 'poetry') {
    const source = table(pkg.source)
    return (
      !('source' in pkg) ||
      (source.type === 'legacy' && typeof source.url === 'string' && source.url !== '')
    )
  }
  if (format === 'pdm') {
    return (
      !['git', 'hg', 'svn', 'bzr', 'path', 'url', 'subdirectory'].some(key => key in pkg) &&
      (!('editable' in pkg) || pkg.editable === false)
    )
  }
  if (format === 'uv') {
    const source = table(pkg.source)
    return (
      Object.keys(source).length === 1 &&
      typeof source.registry === 'string' &&
      source.registry !== ''
    )
  }
  return false
}

function lockedVersion(data: Table, source: string, format: Format): string {
  const pylock = format === 'pylock'
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
    if (!registrySource(pkg, format)) unsupportedSource(source)
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

export async function resolveVersionFile(filePath: string): Promise<string> {
  const format = fileFormat(path.basename(filePath))
  let data: Table
  try {
    data = parse(await fs.readFile(filePath, 'utf8')) as Table
  } catch (error) {
    throw new Error(
      `Could not read version-file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  core.info(`Reading prek version from ${filePath}`)
  return format === 'pyproject'
    ? resolvePythonVersion(data, filePath)
    : lockedVersion(data, filePath, format)
}
