import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import semver from 'semver'
import { knownChecksumsByAsset } from '../src/known-checksums.ts'

const releasesApiUrl = 'https://api.github.com/repos/j178/prek/releases'
const minimumSupportedVersion = '0.0.23'
const installableArchivePattern = /^prek-(.+)\.(tar\.gz|zip)$/
const excludedArchiveNames = new Set(['prek-npm-package.tar.gz'])

export async function run({
  directory = process.cwd(),
  expectedTag = process.env.EXPECTED_RELEASE_TAG || '',
} = {}) {
  const manifestPath = path.join(directory, 'version-manifest.json')
  const checksumsPath = path.join(directory, 'src/known-checksums.ts')
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const previousReleases = await readExistingManifest(manifestPath)
  const previousVersions = new Set(previousReleases.map(release => release.version))
  let result
  for (let attempt = 1; ; attempt += 1) {
    result = await fetchAllReleases(token)
    if (!expectedTag) break
    const reason = releaseReadinessError(result, expectedTag)
    if (!reason) break
    if (attempt === 10) throw new Error(reason)
    console.log(`${reason}; retrying in 15 seconds (${attempt}/10)`)
    await delay(15_000)
  }
  const { checksumsByAsset, releases } = result
  // Historical releases may predate GitHub's digest field. Never erase a known
  // checksum merely because the API no longer supplies one.
  for (const release of releases) {
    for (const asset of release.assets) {
      const key = buildChecksumKey(release.version, asset.name)
      if (!checksumsByAsset.has(key) && knownChecksumsByAsset.has(key)) {
        checksumsByAsset.set(key, knownChecksumsByAsset.get(key))
      }
    }
  }
  const addedVersions = releases
    .map(release => release.version)
    .filter(version => !previousVersions.has(version))

  await writeFile(manifestPath, `${JSON.stringify(releases, null, 2)}\n`)
  await mkdir(path.dirname(checksumsPath), { recursive: true })
  await writeFile(checksumsPath, renderKnownChecksumsFile(checksumsByAsset))
  console.log(`Wrote ${releases.length} prek releases to ${manifestPath}`)
  console.log(`Wrote ${checksumsByAsset.size} known checksums to ${checksumsPath}`)
  if (addedVersions.length === 0) {
    console.log('No new prek releases found')
  } else {
    console.log(`New prek releases: ${addedVersions.join(', ')}`)
  }

  await writeOutputs(addedVersions)
}

async function readExistingManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export async function fetchAllReleases(token) {
  const releases = []
  const checksumsByAsset = new Map()

  for (let page = 1; ; page += 1) {
    const url = `${releasesApiUrl}?per_page=100&page=${page}`
    const response = await fetch(url, {
      headers: buildHeaders(token),
    })
    if (!response.ok) {
      throw new Error(
        `GitHub API request failed for ${url}: ${response.status} ${response.statusText}`,
      )
    }

    const pageReleases = await response.json()
    if (!Array.isArray(pageReleases)) {
      throw new Error(`GitHub API returned a non-array release listing for ${url}`)
    }
    if (pageReleases.length === 0) {
      break
    }

    for (const release of pageReleases) {
      const version = semver.valid(release.tag_name)
      if (!version || semver.lt(version, minimumSupportedVersion) || release.draft) {
        continue
      }

      const assets = Array.isArray(release.assets)
        ? release.assets
            .filter(asset => isInstallableArchive(asset.name))
            .map(asset => {
              const checksum = normalizeDigest(asset.digest)
              if (checksum) {
                checksumsByAsset.set(buildChecksumKey(version, asset.name), checksum)
              }

              return {
                downloadUrl: asset.browser_download_url,
                name: asset.name,
              }
            })
        : []

      if (assets.length === 0) continue

      releases.push({
        assets,
        prerelease: Boolean(release.prerelease),
        publishedAt: release.published_at || release.created_at || '',
        version,
      })
    }

    if (pageReleases.length < 100) {
      break
    }
  }

  if (releases.length === 0) {
    throw new Error(
      'GitHub API returned no installable prek releases; refusing to overwrite known versions',
    )
  }
  return {
    checksumsByAsset,
    releases: releases.sort(compareReleasesDesc),
  }
}

function buildHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'prek-action-known-versions-updater',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

export function normalizeDigest(digest) {
  if (typeof digest !== 'string' || digest.length === 0) {
    return null
  }

  const match = /^sha256:([a-fA-F0-9]{64})$/.exec(digest)
  return match ? match[1].toLowerCase() : null
}

export function releaseReadinessError({ releases, checksumsByAsset }, expectedTag) {
  const version = semver.valid(expectedTag)
  if (!version) throw new Error(`Invalid EXPECTED_RELEASE_TAG: ${expectedTag}`)
  const release = releases.find(candidate => candidate.version === version)
  if (!release?.publishedAt) {
    return `Expected prek release ${expectedTag} is not published yet`
  }
  for (const asset of release.assets) {
    if (!checksumsByAsset.has(buildChecksumKey(version, asset.name))) {
      return `Expected release ${expectedTag} is missing a SHA256 digest for ${asset.name}`
    }
  }
}

function isInstallableArchive(name) {
  return installableArchivePattern.test(name) && !excludedArchiveNames.has(name)
}

function compareReleasesDesc(left, right) {
  return (
    semver.rcompare(left.version, right.version) ||
    right.publishedAt.localeCompare(left.publishedAt)
  )
}

function renderKnownChecksumsFile(checksumsByAsset) {
  const entries = [...checksumsByAsset.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetKey, checksum]) => `  [${JSON.stringify(assetKey)}, ${JSON.stringify(checksum)}]`)
    .join(',\n')
  return (
    '// This file is autogenerated by scripts/update-known-versions.mjs. Do not edit manually.\n' +
    'export const knownChecksumsByAsset = new Map<string, string>([\n' +
    entries +
    '\n])\n'
  )
}

function buildChecksumKey(version, assetName) {
  return `${version}:${assetName}`
}

async function writeOutputs(addedVersions) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  const prTitle =
    addedVersions.length === 0
      ? 'Update prek known versions'
      : `Update known versions for ${formatVersionSummary(addedVersions)}`
  const addedVersionsMarkdown =
    addedVersions.length === 0
      ? '- None'
      : addedVersions.map(version => `- prek ${version}`).join('\n')

  await appendFile(
    outputPath,
    `${[
      `added_versions=${addedVersions.join(',')}`,
      `pr_title=${prTitle}`,
      'added_versions_markdown<<EOF',
      addedVersionsMarkdown,
      'EOF',
    ].join('\n')}\n`,
  )
}

function formatVersionSummary(addedVersions) {
  if (addedVersions.length === 1) {
    return `prek ${addedVersions[0]}`
  }

  return `prek ${addedVersions[0]} and ${addedVersions.length - 1} more`
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
