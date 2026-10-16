import { maxSatisfying, validRange } from '@renovatebot/pep440'
import * as semver from 'semver'
import { getVersionManifest } from './manifest'
import { type Table, table, unique, unsupportedSource } from './version-file-common'

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
        const selection = table(entry)
        const keys = Object.keys(selection)
        return keys.length !== 1 || keys[0] !== 'index' || typeof selection.index !== 'string'
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

export async function resolvePythonVersion(data: Table, filePath: string): Promise<string> {
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
