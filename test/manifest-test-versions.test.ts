import { describe, expect, it } from 'vitest'
// @ts-expect-error The CI selector is a standalone JavaScript script.
import { assertSmokeChecksums, selectTestVersions } from '../scripts/manifest-test-versions.mjs'

const releases = (versions: string[]) => versions.map(version => ({ version }))

describe('manifest smoke test versions', () => {
  it('selects all additions, including prereleases and older backports', () => {
    expect(
      selectTestVersions(
        releases(['0.6.0-beta.1', '0.5.5', '0.4.9', '0.3.0']),
        releases(['0.5.5', '0.3.0']),
      ),
    ).toEqual(['0.6.0-beta.1', '0.4.9'])
  })

  it('falls back to the newest entry when no version was added', () => {
    const manifest = releases(['0.6.0-beta.1', '0.5.5'])
    expect(selectTestVersions(manifest, manifest)).toEqual(['0.6.0-beta.1'])
  })

  it('rejects an empty manifest', () => {
    expect(() => selectTestVersions([])).toThrow(/no releases/)
  })

  it('requires runner checksums even if the manifest omits their archives', () => {
    expect(() =>
      assertSmokeChecksums([{ assets: [], version: '0.5.5' }], ['0.5.5'], new Map()),
    ).toThrow(/No bundled checksum/)
  })

  it('accepts bundled runner checksums but rejects an unknown additional archive', () => {
    const release = { assets: [] as Array<{ name: string }>, version: '0.5.5' }
    expect(() => assertSmokeChecksums([release], ['0.5.5'])).not.toThrow()

    release.assets.push({ name: 'prek-unknown-target.zip' })
    expect(() => assertSmokeChecksums([release], ['0.5.5'])).toThrow(/prek-unknown-target/)
  })
})
