import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', () => ({ info: vi.fn() }))
vi.mock('../src/manifest', () => ({
  getVersionManifest: vi.fn(async () =>
    ['0.3.0', '0.3.5', '0.3.9', '0.4.0'].map(version => ({
      assets: [],
      prerelease: false,
      publishedAt: '',
      version,
    })),
  ),
}))

import { resolveVersionFile } from '../src/version-file'

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prek-version-file-'))
})
afterEach(async () => {
  await fs.rm(directory, { force: true, recursive: true })
})

async function resolve(filename: string, content: string): Promise<string> {
  const file = path.join(directory, filename)
  await fs.writeFile(file, content)
  return resolveVersionFile(file)
}

function lockedEntry(filename: string, version: string, source?: string): string {
  const registry =
    filename === 'uv.lock'
      ? '{ registry = "https://pypi.org/simple" }'
      : '"registry+https://github.com/rust-lang/crates.io-index"'
  return `[[package]]\nname = "prek"\nversion = "${version}"\n${source ?? `source = ${registry}`}\n`
}

describe('version-file', () => {
  it('reads the lockfile used by the CI install smoke test', async () => {
    const fixture = new URL('./fixtures/version-file/uv.lock', import.meta.url)
    expect(await resolve('uv.lock', await fs.readFile(fixture, 'utf8'))).toBe('0.2.30')
  })

  it.each([
    'uv.lock',
    'Cargo.lock',
  ])('reads exact prek versions from %s without requiring manifest membership', async filename => {
    expect(
      await resolve(
        filename,
        `[[package]]\nname = "other"\nversion = "1.0.0"\n${lockedEntry(filename, '9.0.0')}`,
      ),
    ).toBe('9.0.0')
  })

  it.each(['uv.lock', 'Cargo.lock'])('rejects ambiguous versions in %s', async filename => {
    const entry = lockedEntry(filename, '0.3.5')
    expect(await resolve(filename, entry + entry)).toBe('0.3.5')
    await expect(resolve(filename, entry + lockedEntry(filename, '0.4.0'))).rejects.toThrow(
      'Ambiguous prek versions',
    )
  })

  it.each([
    ['uv.lock', 'source = { git = "https://example.com/fork.git" }'],
    ['uv.lock', 'source = { editable = "." }'],
    ['uv.lock', 'source = { directory = "../prek" }'],
    ['uv.lock', 'source = { path = "../prek" }'],
    ['uv.lock', 'source = { url = "https://example.com/prek.whl" }'],
    ['uv.lock', ''],
    ['Cargo.lock', 'source = "git+https://example.com/fork.git#abc"'],
    ['Cargo.lock', ''],
  ])('rejects non-registry prek sources in %s, including mixed duplicates', async (filename, source) => {
    const entry = lockedEntry(filename, '0.3.5', source)
    await expect(resolve(filename, entry)).rejects.toThrow('Unsupported prek source')
    await expect(resolve(filename, lockedEntry(filename, '0.3.5') + entry)).rejects.toThrow(
      'Unsupported prek source',
    )
  })

  it.each([
    '[project]\ndependencies = ["prek~=0.3.0,!=0.3.9"]',
    '[project.optional-dependencies]\nlint = ["prek~=0.3.0,!=0.3.9"]',
    '[dependency-groups]\nlint = ["prek~=0.3.0,!=0.3.9"]',
  ])('uses native PEP 440 constraints in standard dependency lists', async content => {
    expect(await resolve('pyproject.toml', content)).toBe('0.3.5')
  })

  it('accepts an exact Python pin newer than the manifest', async () => {
    expect(await resolve('pyproject.toml', '[dependency-groups]\nlint = ["prek==9.0.0"]')).toBe(
      '9.0.0',
    )
    expect(await resolve('pyproject.toml', '[dependency-groups]\nlint = ["prek == 9.0.0"]')).toBe(
      '9.0.0',
    )
  })

  it('accepts parenthesized Python version specifiers', async () => {
    expect(
      await resolve('pyproject.toml', '[dependency-groups]\nlint = ["prek (>=0.3.0,<0.4)"]'),
    ).toBe('0.3.9')
  })

  it('does not confuse similarly named dependencies or uv required-version with prek', async () => {
    await expect(
      resolve(
        'pyproject.toml',
        '[project]\ndependencies = ["prek-helper==1.0.0"]\n[tool.uv]\nrequired-version = "0.3.5"',
      ),
    ).rejects.toThrow('No prek version')
  })

  it('rejects conditional and conflicting dependency declarations', async () => {
    await expect(
      resolve(
        'pyproject.toml',
        '[project]\ndependencies = ["prek>=0.3; python_version >= \'3.10\'"]',
      ),
    ).rejects.toThrow('Conditional prek dependencies')
    await expect(
      resolve('pyproject.toml', '[dependency-groups]\na = ["prek==0.3.5"]\nb = ["prek==0.4.0"]'),
    ).rejects.toThrow('Ambiguous prek versions')
  })

  it.each([
    '{ git = "https://example.com/fork.git" }',
    '{ path = "../prek" }',
    '{ url = "https://example.com/prek.whl" }',
    '{ workspace = true }',
    '[{ index = "private", marker = "sys_platform == \'linux\'" }]',
  ])('rejects unsupported uv source overrides: %s', async source => {
    await expect(
      resolve(
        'pyproject.toml',
        `[project]\ndependencies = ["prek==0.3.5"]\n[tool.uv.sources]\nprek = ${source}`,
      ),
    ).rejects.toThrow('Unsupported prek source')
  })

  it('accepts an unconditional uv index override', async () => {
    expect(
      await resolve(
        'pyproject.toml',
        '[project]\ndependencies = ["prek==0.3.5"]\n[tool.uv.sources]\nprek = { index = "private" }',
      ),
    ).toBe('0.3.5')
  })

  it('rejects direct URL requirements even alongside a supported declaration', async () => {
    await expect(
      resolve(
        'pyproject.toml',
        '[project]\ndependencies = ["prek==0.3.5", "prek @ https://example.com/prek.whl"]',
      ),
    ).rejects.toThrow('Unsupported prek source')
  })

  it('rejects Cargo.toml rather than partially implementing Cargo resolution', async () => {
    await expect(resolve('Cargo.toml', '[dependencies]\nprek = "0.3.5"')).rejects.toThrow(
      'Unsupported version-file',
    )
  })

  it('reports missing, malformed, and unsupported files', async () => {
    await expect(resolveVersionFile(path.join(directory, 'uv.lock'))).rejects.toThrow(
      'Could not read version-file',
    )
    await expect(resolve('pyproject.toml', '[invalid')).rejects.toThrow(
      'Could not read version-file',
    )
    await expect(resolve('requirements.txt', 'prek==0.3.5')).rejects.toThrow(
      'Unsupported version-file',
    )
  })
})
