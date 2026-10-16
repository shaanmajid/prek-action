import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from '@actions/core'
import * as semver from 'semver'
import { parse } from 'smol-toml'
import { resolvePythonVersion } from './python-version'
import { type Table, table, unique, unsupportedSource } from './version-file-common'

function releaseArtifact(value: unknown): boolean {
  const artifact = table(value)
  return (
    !('path' in artifact) && typeof artifact.url === 'string' && /^https?:\/\//i.test(artifact.url)
  )
}

function resolvePylock(data: Table, source: string): string {
  if (typeof data['lock-version'] !== 'string' || !/^1\.\d+$/.test(data['lock-version'])) {
    throw new Error(`Unsupported pylock lock-version in ${source}. Expected major version 1.`)
  }
  return lockedVersion(data.packages, source, pkg => {
    const wheels = pkg.wheels
    return (
      !['vcs', 'directory', 'archive'].some(key => key in pkg) &&
      (!('sdist' in pkg) || releaseArtifact(pkg.sdist)) &&
      (!('wheels' in pkg) || (Array.isArray(wheels) && wheels.every(releaseArtifact))) &&
      ('sdist' in pkg || (Array.isArray(wheels) && wheels.length > 0))
    )
  })
}

function resolvePoetry(data: Table, source: string): string {
  return lockedVersion(data.package, source, pkg => {
    const pkgSource = table(pkg.source)
    return (
      !('source' in pkg) ||
      (pkgSource.type === 'legacy' && typeof pkgSource.url === 'string' && pkgSource.url !== '')
    )
  })
}

function resolvePdm(data: Table, source: string): string {
  return lockedVersion(
    data.package,
    source,
    pkg =>
      !['git', 'hg', 'svn', 'bzr', 'path', 'url', 'subdirectory'].some(key => key in pkg) &&
      (!('editable' in pkg) || pkg.editable === false),
  )
}

function resolveUv(data: Table, source: string): string {
  return lockedVersion(data.package, source, pkg => {
    const pkgSource = table(pkg.source)
    return (
      Object.keys(pkgSource).length === 1 &&
      typeof pkgSource.registry === 'string' &&
      pkgSource.registry !== ''
    )
  })
}

function lockedVersion(
  entries: unknown,
  source: string,
  registrySource: (pkg: Table) => boolean,
): string {
  const packages = Array.isArray(entries) ? entries : []
  const versions = packages.flatMap(entry => {
    const pkg = table(entry)
    if (pkg.name !== 'prek') return []
    if (!registrySource(pkg)) unsupportedSource(source)
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

function toml(resolve: (data: Table, source: string) => string | Promise<string>) {
  return (content: string, source: string) => {
    let data: Table
    try {
      data = parse(content) as Table
    } catch (error) {
      throw new Error(
        `Could not parse version-file ${source}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return resolve(data, source)
  }
}

const handlers = [
  { filename: /^uv\.lock$/, resolve: toml(resolveUv) },
  { filename: /^poetry\.lock$/, resolve: toml(resolvePoetry) },
  { filename: /^pdm\.lock$/, resolve: toml(resolvePdm) },
  { filename: /^pylock(?:\.[^.]+)?\.toml$/, resolve: toml(resolvePylock) },
  { filename: /^pyproject\.toml$/, resolve: toml(resolvePythonVersion) },
]

export async function resolveVersionFile(filePath: string): Promise<string> {
  const filename = path.basename(filePath)
  const handler = handlers.find(handler => handler.filename.test(filename))
  if (!handler) {
    throw new Error(
      `Unsupported version-file: ${filename}. Use uv.lock, poetry.lock, pdm.lock, pylock.toml (or pylock.<name>.toml), or pyproject.toml.`,
    )
  }
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(
      `Could not read version-file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  core.info(`Reading prek version from ${filePath}`)
  return handler.resolve(content, filePath)
}
