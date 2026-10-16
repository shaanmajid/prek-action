import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function selectTestVersions(releases, previousReleases = []) {
  const previousVersions = new Set(previousReleases.map(release => release.version))
  const addedVersions = releases
    .map(release => release.version)
    .filter(version => !previousVersions.has(version))
  if (addedVersions.length > 0) return addedVersions
  if (!releases[0]) throw new Error('Checked-in manifest has no releases')
  return [releases[0].version]
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
  appendFileSync(process.env.GITHUB_OUTPUT, `versions=${JSON.stringify(versions)}\n`)
}
