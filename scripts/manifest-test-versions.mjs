import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { knownChecksumsByAsset } from '../src/known-checksums.ts'

// The hosted runners in ci.yml use Linux/Windows x64 and macOS arm64.
const smokeArchiveNames = [
  'prek-x86_64-unknown-linux-gnu.tar.gz',
  'prek-x86_64-pc-windows-msvc.zip',
  'prek-aarch64-apple-darwin.tar.gz',
]

export function selectTestVersions(releases, previousReleases = []) {
  const previousVersions = new Set(previousReleases.map(release => release.version))
  const addedVersions = releases
    .map(release => release.version)
    .filter(version => !previousVersions.has(version))
  if (addedVersions.length > 0) return addedVersions
  if (!releases[0]) throw new Error('Checked-in manifest has no releases')
  return [releases[0].version]
}

export function assertSmokeChecksums(releases, versions, checksums = knownChecksumsByAsset) {
  for (const release of releases) {
    if (!versions.includes(release.version)) continue
    const archives = new Set([...smokeArchiveNames, ...release.assets.map(asset => asset.name)])
    for (const archive of archives) {
      if (!/^[a-f\d]{64}$/i.test(checksums.get(`${release.version}:${archive}`) || '')) {
        throw new Error(`No bundled checksum for smoke test: ${release.version}:${archive}`)
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const releases = JSON.parse(readFileSync('version-manifest.json', 'utf8'))
  const previousReleases = process.env.BASE_SHA
    ? JSON.parse(
        execFileSync('git', ['show', `${process.env.BASE_SHA}:version-manifest.json`], {
          encoding: 'utf8',
        }),
      )
    : releases
  const versions = selectTestVersions(releases, previousReleases)
  assertSmokeChecksums(releases, versions)
  appendFileSync(process.env.GITHUB_OUTPUT, `versions=${JSON.stringify(versions)}\n`)
}
