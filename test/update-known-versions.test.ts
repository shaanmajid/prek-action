import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { knownChecksumsByAsset } from '../src/known-checksums'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

// The updater runs directly on Node 24, including its checked-in TypeScript map.
// @ts-expect-error The repository's standalone maintenance script is JavaScript.
import {
  fetchAllReleases,
  normalizeDigest,
  releaseReadinessError,
  run,
} from '../scripts/update-known-versions.mjs'

const digest = 'a'.repeat(64)
const names = [
  'prek-aarch64-apple-darwin.tar.gz',
  'prek-x86_64-apple-darwin.tar.gz',
  'prek-x86_64-pc-windows-msvc.zip',
  'prek-x86_64-unknown-linux-gnu.tar.gz',
]
function release(version = '0.5.5') {
  return {
    assets: names.map(name => ({
      browser_download_url: `https://github.com/j178/prek/releases/download/v${version}/${name}`,
      digest: `sha256:${digest}`,
      name,
    })),
    published_at: '2026-10-01T00:00:00Z',
    tag_name: `v${version}`,
  }
}
function respond(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => body, ok: true }))
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('known-version release updater', () => {
  it('preserves the public array schema and excludes drafts and non-installable releases', async () => {
    respond([release('0.5.4'), { ...release(), draft: true }, { ...release(), assets: [] }])
    const result = await fetchAllReleases('')
    expect(result.releases).toEqual([
      {
        assets: names.map(name => ({
          downloadUrl: `https://github.com/j178/prek/releases/download/v0.5.4/${name}`,
          name,
        })),
        prerelease: false,
        publishedAt: '2026-10-01T00:00:00Z',
        version: '0.5.4',
      },
    ])
    expect(result.checksumsByAsset.get(`0.5.4:${names[0]}`)).toBe(digest)
  })

  it.each([
    {},
    [],
    [{ ...release(), assets: [] }],
  ])('rejects unusable API responses before writing (%j)', async body => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'prek-updater-'))
    const manifestPath = path.join(directory, 'version-manifest.json')
    await writeFile(manifestPath, '[]\n')
    respond(body)
    try {
      await expect(run({ directory })).rejects.toThrow(/non-array|no installable/)
      expect(await readFile(manifestPath, 'utf8')).toBe('[]\n')
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('requires the expected release and complete archive digests', async () => {
    respond([release()])
    const result = await fetchAllReleases('')
    expect(releaseReadinessError(result, 'v0.5.5')).toBeUndefined()
    expect(releaseReadinessError(result, 'v0.5.6')).toMatch(/not published/)
    result.checksumsByAsset.delete(`0.5.5:${names[0]}`)
    expect(releaseReadinessError(result, 'v0.5.5')).toMatch(/missing a SHA256/)
  })

  it('fails without writing when the triggering release remains unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'prek-updater-'))
    const manifestPath = path.join(directory, 'version-manifest.json')
    await writeFile(manifestPath, '[]\n')
    respond([release()])
    try {
      const result = expect(run({ directory, expectedTag: 'v0.5.6' })).rejects.toThrow(
        /not published/,
      )
      await result
      expect(await readFile(manifestPath, 'utf8')).toBe('[]\n')
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('retains a bundled historical checksum when GitHub omits the digest', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'prek-updater-'))
    const checksumKey = '0.5.5:prek-x86_64-unknown-linux-gnu.tar.gz'
    const response = release()
    response.assets[3].digest = ''
    respond([response])
    try {
      await run({ directory })
      expect(await readFile(path.join(directory, 'src/known-checksums.ts'), 'utf8')).toContain(
        `[${JSON.stringify(checksumKey)}, ${JSON.stringify(knownChecksumsByAsset.get(checksumKey))}]`,
      )
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('escapes release asset names in generated TypeScript', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'prek-updater-'))
    const response = release()
    response.assets[0].name = 'prek-quoted"target.tar.gz'
    respond([response])
    try {
      await run({ directory })
      expect(await readFile(path.join(directory, 'src/known-checksums.ts'), 'utf8')).toContain(
        `[${JSON.stringify(`0.5.5:${response.assets[0].name}`)}, ${JSON.stringify(digest)}]`,
      )
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('accepts only full SHA256 digests', () => {
    expect(normalizeDigest(`sha256:${'A'.repeat(64)}`)).toBe(digest)
    for (const value of [
      null,
      '',
      digest,
      'sha256:abc',
      `sha512:${digest}`,
      `sha256:${'z'.repeat(64)}`,
    ]) {
      expect(normalizeDigest(value)).toBeNull()
    }
  })
})
