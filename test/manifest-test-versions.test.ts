import { describe, expect, it } from 'vitest'
// @ts-expect-error The CI selector is a standalone JavaScript script.
import { selectTestVersions } from '../scripts/manifest-test-versions.mjs'

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
})
