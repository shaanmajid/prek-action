import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import { getPrekCacheDir } from './prek'
import {
  CACHE_KEY_STATE,
  CACHE_MATCHED_KEY_STATE,
  CACHE_PATHS_STATE,
  PREK_CACHE_KEY_PREFIX,
} from './types'

export type RestorePrekCacheResult = {
  matchedKey?: string
  primaryKey: string
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function restorePrekCache(workingDirectory: string): Promise<RestorePrekCacheResult> {
  core.startGroup('Restore prek cache')

  const cacheDir = await getPrekCacheDir()
  const paths = [cacheDir]
  const primaryKey = await buildCacheKey(workingDirectory)
  core.saveState(CACHE_KEY_STATE, primaryKey)
  core.saveState(CACHE_PATHS_STATE, JSON.stringify(paths))

  let matchedKey: string | undefined
  try {
    const restoredKey = await cache.restoreCache(paths, primaryKey)
    if (restoredKey) {
      core.info(`Restored prek cache with key ${restoredKey}`)
      core.saveState(CACHE_MATCHED_KEY_STATE, restoredKey)
      matchedKey = restoredKey
    } else {
      core.info(`No cache found for key ${primaryKey}`)
    }
  } catch (error) {
    core.warning(`Failed to restore cache: ${formatError(error)}`)
  } finally {
    core.endGroup()
  }

  return { matchedKey, primaryKey }
}

export async function savePrekCache(): Promise<void> {
  const primaryKey = core.getState(CACHE_KEY_STATE)
  const matchedKey = core.getState(CACHE_MATCHED_KEY_STATE)
  const rawPaths = core.getState(CACHE_PATHS_STATE)

  if (!primaryKey || !rawPaths) {
    // restorePrekCache() is the only place that records cache state. When
    // caching is disabled, the post step lands here and intentionally no-ops.
    core.info(
      'No cache state found, skipping cache save (cache disabled or restore step did not run)',
    )
    return
  }

  if (primaryKey === matchedKey) {
    core.info(`Cache hit occurred on the primary key ${primaryKey}, not saving cache.`)
    return
  }

  const paths = JSON.parse(rawPaths) as string[]
  core.startGroup('Save prek cache')
  try {
    const cacheId = await cache.saveCache(paths, primaryKey)
    if (cacheId !== -1) {
      core.info(`Saved prek cache with key ${primaryKey}`)
    }
  } catch (error) {
    // @actions/cache may already log non-fatal save failures and return -1.
    core.warning(`Failed to save cache: ${formatError(error)}`)
  } finally {
    core.endGroup()
  }
}

async function buildCacheKey(workingDirectory: string): Promise<string> {
  const normalizedWorkingDirectory = path.resolve(workingDirectory)
  const hash = await hashConfigFiles(normalizedWorkingDirectory)
  const pythonLocation = process.env.pythonLocation || ''
  const runnerOs = process.env.RUNNER_OS || process.platform
  const runnerArch = process.env.RUNNER_ARCH || process.arch
  return `${PREK_CACHE_KEY_PREFIX}|${runnerOs}|${runnerArch}|${pythonLocation}|${hash}`
}

async function hashConfigFiles(workingDirectory: string): Promise<string> {
  const matcher = await glob.create(getConfigPatterns(workingDirectory).join('\n'), {
    followSymbolicLinks: false,
    implicitDescendants: false,
    matchDirectories: false,
  })
  const files = await matcher.glob()
  const root = await fs.realpath(workingDirectory)
  const digest = crypto.createHash('sha256')
  let count = 0
  for (const file of files.sort()) {
    // Glob does not traverse directory symlinks, but it can still return a
    // symlink named like a config file. Hash only files inside this project.
    let resolved: string
    try {
      resolved = await fs.realpath(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    const relative = path.relative(root, resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue
    }
    if (!(await fs.stat(resolved)).isFile()) {
      continue
    }
    digest.update(path.relative(workingDirectory, file))
    digest.update('\0')
    digest.update(
      crypto
        .createHash('sha256')
        .update(await fs.readFile(file))
        .digest(),
    )
    count++
  }
  return count === 0 ? 'no-config' : digest.digest('hex')
}

function getConfigPatterns(workingDirectory: string): string[] {
  return [
    path.join(workingDirectory, '**', 'prek.toml').replaceAll(path.sep, '/'),
    path.join(workingDirectory, '**', '.pre-commit-config.yaml').replaceAll(path.sep, '/'),
    path.join(workingDirectory, '**', '.pre-commit-config.yml').replaceAll(path.sep, '/'),
  ]
}
