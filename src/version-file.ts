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
    ? value as Table
    : {}
}

function unique(values: string[], source: string): string {
  const versions = [...new Set(values)]
  if (versions.length === 0) throw new Error(`No prek version found in ${source}`)
  if (versions.length > 1) {
    throw new Error(`Ambiguous prek versions in ${source}: ${versions.join(', ')}. Set prek-version explicitly.`)
  }
  return versions[0]!
}

function lockedVersion(data: Table, source: string): string {
  const packages = Array.isArray(data.package) ? data.package : []
  const versions = packages.flatMap(entry => {
    const pkg = table(entry)
    return pkg.name === 'prek' && typeof pkg.version === 'string' ? [pkg.version] : []
  })
  const version = unique(versions, source)
  if (!semver.valid(version)) throw new Error(`Invalid locked prek version in ${source}: ${version}`)
  return version
}

function pythonConstraint(data: Table, source: string): string {
  const project = table(data.project)
  const lists = [project.dependencies, ...Object.values(table(project['optional-dependencies'])),
    ...Object.values(table(data['dependency-groups']))]
  const constraints = lists.flatMap(list => !Array.isArray(list) ? [] : list.flatMap(dep => {
    if (typeof dep !== 'string') return []
    const match = dep.match(/^prek(?:\[[^\]]*\])?\s*(?=[<>=!~;(]|$)(.*)$/i)
    if (!match) return []
    const constraint = match[1]!.trim()
    if (constraint.includes(';')) {
      throw new Error(`Conditional prek dependencies in ${source} are unsupported. Use uv.lock or set prek-version explicitly.`)
    }
    if (constraint && !validRange(constraint)) {
      throw new Error(`Invalid prek PEP 440 specifier in ${source}: ${constraint}`)
    }
    return [constraint]
  }))
  return unique(constraints, source)
}

function cargoConstraint(data: Table, source: string): string {
  const pkg = table(data.package)
  if (pkg.name === 'prek' && typeof pkg.version === 'string') return `=${pkg.version}`
  const workspaceDependencies = table(table(data.workspace).dependencies)
  const tables = [data.dependencies, data['dev-dependencies'], data['build-dependencies'],
    workspaceDependencies]
  const constraints: string[] = []
  for (const dependencies of tables) {
    for (const [name, value] of Object.entries(table(dependencies))) {
      const dependency = table(value)
      if ((dependency.package ?? name) !== 'prek') continue
      const inherited = workspaceDependencies[name]
      const version = typeof value === 'string' ? value : dependency.version ??
        (dependency.workspace === true ? (typeof inherited === 'string' ? inherited : table(inherited).version) : undefined)
      if (typeof version !== 'string') {
        throw new Error(`prek dependency in ${source} has no version. Use Cargo.lock or set prek-version explicitly.`)
      }
      constraints.push(version)
    }
  }
  return unique(constraints, source)
}

// Cargo treats bare versions as caret requirements; npm's semver treats them as exact versions.
function cargoRange(constraint: string): string {
  return constraint.split(',').map(part => {
    const value = part.trim()
    return /^\d/.test(value) && !/[xX*]/.test(value) ? `^${value}` : value
  }).join(' ')
}

export async function resolveVersionFile(filePath: string): Promise<string> {
  const filename = path.basename(filePath)
  if (!['uv.lock', 'pyproject.toml', 'Cargo.lock', 'Cargo.toml'].includes(filename)) {
    throw new Error(`Unsupported version-file: ${filename}. Use uv.lock, pyproject.toml, Cargo.lock, or Cargo.toml.`)
  }
  let data: Table
  try {
    data = parse(await fs.readFile(filePath, 'utf8')) as Table
  } catch (error) {
    throw new Error(`Could not read version-file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  core.info(`Reading prek version from ${filePath}`)
  if (filename.endsWith('.lock')) return lockedVersion(data, filePath)

  const python = filename === 'pyproject.toml'
  const constraint = python ? pythonConstraint(data, filePath) : cargoConstraint(data, filePath)
  const exact = constraint.match(python ? /^==([\d.]+)$/ : /^=([\d.]+)$/)?.[1]
  if (exact && semver.valid(exact)) return exact
  const range = python ? constraint : cargoRange(constraint)
  if (!python && !semver.validRange(range)) {
    throw new Error(`Invalid prek Cargo version requirement in ${filePath}: ${constraint}`)
  }
  const versions = (await getVersionManifest()).filter(release => !release.prerelease).map(release => release.version)
  const version = python
    ? maxSatisfying(versions, range)
    : semver.maxSatisfying(versions, range)
  if (!version) throw new Error(`No prek release satisfies ${constraint || 'any version'} from ${filePath}`)
  return version
}
