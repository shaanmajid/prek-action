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

function lockedEntry(version: string, source?: string): string {
  const registry = '{ registry = "https://pypi.org/simple" }'
  return `[[package]]\nname = "prek"\nversion = "${version}"\n${source ?? `source = ${registry}`}\n`
}

describe('version-file', () => {
  it.each([
    'uv.lock',
    'poetry.lock',
    'pdm.lock',
    'pylock.toml',
    'pyproject.toml',
  ])('reads a tool-generated %s fixture', async filename => {
    const fixture = new URL(`./fixtures/version-file/${filename}`, import.meta.url)
    expect(await resolve(filename, await fs.readFile(fixture, 'utf8'))).toBe('0.5.5')
  })

  it('reads an older uv format revision', async () => {
    const fixture = new URL('./fixtures/version-file/uv-old.lock', import.meta.url)
    expect(await resolve('uv.lock', await fs.readFile(fixture, 'utf8'))).toBe('0.5.5')
  })

  it.each([
    'uv.lock',
    'poetry.lock',
    'pdm.lock',
  ])('ignores additive metadata in %s', async filename => {
    const fixture = new URL(`./fixtures/version-file/${filename}`, import.meta.url)
    expect(
      await resolve(
        filename,
        `${await fs.readFile(fixture, 'utf8')}\n[future-metadata]\nrevision = 999\n`,
      ),
    ).toBe('0.5.5')
  })

  it.each([
    '__proto__',
    'constructor',
    'toString',
  ])('rejects unsupported filenames inherited by JavaScript objects: %s', async filename => {
    await expect(resolve(filename, '')).rejects.toThrow('Unsupported version-file')
  })

  it.each([
    'pylock.toml',
    'pylock.ci.toml',
  ])('reads exact release versions from %s', async filename => {
    expect(
      await resolve(
        filename,
        'lock-version = "1.1"\n[[packages]]\nname = "prek"\nversion = "9.0.0"\nsdist = { url = "https://mirror.example/prek.tar.gz" }',
      ),
    ).toBe('9.0.0')
  })

  it.each([
    'poetry.lock',
    'pdm.lock',
    'pylock.toml',
  ])('checks all prek entries in %s', async filename => {
    const header = filename === 'pylock.toml' ? 'lock-version = "1.0"\n' : ''
    const section = filename === 'pylock.toml' ? 'packages' : 'package'
    const source =
      filename === 'pylock.toml' ? 'wheels = [{ url = "https://example.com/prek.whl" }]\n' : ''
    const entry = (version: string) =>
      `[[${section}]]\nname = "prek"\nversion = "${version}"\n${source}`
    expect(await resolve(filename, header + entry('0.3.5') + entry('0.3.5'))).toBe('0.3.5')
    await expect(resolve(filename, header + entry('0.3.5') + entry('0.4.0'))).rejects.toThrow(
      'Ambiguous prek versions',
    )
    await expect(
      resolve(filename, `${header}[[${section}]]\nname = "prek"\n${source}`),
    ).rejects.toThrow('Missing locked prek version')
    await expect(resolve(filename, header + entry('invalid'))).rejects.toThrow(
      'Invalid locked prek version',
    )
    await expect(
      resolve(filename, `${header}[[${section}]]\nname = "other"\nversion = "0.3.5"`),
    ).rejects.toThrow('No prek version')
  })

  it('accepts Poetry registry mirrors', async () => {
    expect(
      await resolve(
        'poetry.lock',
        '[[package]]\nname = "prek"\nversion = "0.3.5"\nsource = { type = "legacy", url = "https://mirror.example/simple", reference = "private" }',
      ),
    ).toBe('0.3.5')
  })

  it.each([
    '{ type = "git", url = "https://example.com/fork.git" }',
    '{ type = "file", url = "../prek.whl" }',
    '{ type = "directory", url = "../prek" }',
    '{ type = "url", url = "https://example.com/prek.whl" }',
    '{ type = "legacy" }',
    '{}',
    '"https://example.com/simple"',
  ])('rejects unsupported Poetry sources including mixed duplicates: %s', async source => {
    const supported = '[[package]]\nname = "prek"\nversion = "0.3.5"\n'
    const unsupported = `${supported}source = ${source}\n`
    await expect(resolve('poetry.lock', unsupported)).rejects.toThrow('Unsupported prek source')
    await expect(resolve('poetry.lock', supported + unsupported)).rejects.toThrow(
      'Unsupported prek source',
    )
  })

  it.each([
    'sdist = { path = "../prek.tar.gz" }',
    'sdist = { url = "file:///tmp/prek.tar.gz" }',
    'wheels = [{ url = "file:///tmp/prek.whl" }]',
    'sdist = { path = "../prek.tar.gz", url = "https://example.com/prek.tar.gz" }',
    'wheels = [{ path = "../prek.whl" }]',
    'wheels = [{ path = "../prek.whl", url = "https://example.com/prek.whl" }]',
    'vcs = { type = "git", url = "https://example.com/fork.git" }',
    'directory = { path = "../prek" }',
    'archive = { url = "https://example.com/prek.whl" }',
    '',
    'wheels = []',
    'wheels = ["invalid"]',
    'sdist = "invalid"',
  ])('rejects unsupported pylock sources including mixed duplicates: %s', async source => {
    const entry = '[[packages]]\nname = "prek"\nversion = "0.3.5"\n'
    const supported = `${entry}wheels = [{ url = "https://example.com/prek.whl" }]\n`
    const unsupported = `${entry}${source}\n`
    await expect(resolve('pylock.toml', `lock-version = "1.0"\n${unsupported}`)).rejects.toThrow(
      'Unsupported prek source',
    )
    await expect(
      resolve('pylock.toml', `lock-version = "1.0"\n${supported}${unsupported}`),
    ).rejects.toThrow('Unsupported prek source')
    if (
      source.startsWith('vcs') ||
      source.startsWith('directory') ||
      source.startsWith('archive')
    ) {
      await expect(
        resolve('pylock.toml', `lock-version = "1.0"\n${supported}${source}`),
      ).rejects.toThrow('Unsupported prek source')
    }
  })

  it.each([
    '"2.0"',
    '"invalid"',
    '1',
  ])('rejects unsupported pylock format version %s', async version => {
    await expect(resolve('pylock.toml', `lock-version = ${version}`)).rejects.toThrow(
      'Unsupported pylock lock-version',
    )
  })

  it('rejects a missing pylock format version', async () => {
    await expect(resolve('pylock.toml', '')).rejects.toThrow('Unsupported pylock lock-version')
  })

  it.each([
    'git = "https://example.com/fork.git"',
    'hg = "https://example.com/fork"',
    'svn = "https://example.com/fork"',
    'bzr = "https://example.com/fork"',
    'url = "https://example.com/prek.whl"',
    'path = "../prek"',
    'editable = true',
    'subdirectory = "prek"',
  ])('rejects unsupported PDM sources including mixed duplicates: %s', async source => {
    const supported = '[[package]]\nname = "prek"\nversion = "0.3.5"\n'
    const unsupported = `${supported}${source}\n`
    await expect(resolve('pdm.lock', unsupported)).rejects.toThrow('Unsupported prek source')
    await expect(resolve('pdm.lock', supported + unsupported)).rejects.toThrow(
      'Unsupported prek source',
    )
  })

  it('accepts PDM static registry artifact URLs and editable false', async () => {
    expect(
      await resolve(
        'pdm.lock',
        '[[package]]\nname = "prek"\nversion = "0.3.5"\neditable = false\nfiles = [{url = "https://mirror.example/prek.whl", hash = "sha256:abc"}]',
      ),
    ).toBe('0.3.5')
  })

  it.each([
    'pylock..toml',
    'pylock.ci.dev.toml',
    'Pylock.toml',
  ])('rejects unsupported pylock filename %s', async filename => {
    await expect(resolve(filename, '')).rejects.toThrow('Unsupported version-file')
  })

  it('reads the lockfile used by the CI install smoke test', async () => {
    const fixture = new URL('./fixtures/version-file/uv.lock', import.meta.url)
    expect(await resolve('uv.lock', await fs.readFile(fixture, 'utf8'))).toBe('0.5.5')
  })

  it.each([
    'uv.lock',
  ])('reads exact prek versions from %s without requiring manifest membership', async filename => {
    expect(
      await resolve(
        filename,
        `[[package]]\nname = "other"\nversion = "1.0.0"\n${lockedEntry('9.0.0')}`,
      ),
    ).toBe('9.0.0')
  })

  it.each(['uv.lock'])('rejects ambiguous versions in %s', async filename => {
    const entry = lockedEntry('0.3.5')
    expect(await resolve(filename, entry + entry)).toBe('0.3.5')
    await expect(resolve(filename, entry + lockedEntry('0.4.0'))).rejects.toThrow(
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
  ])('rejects non-registry prek sources in %s, including mixed duplicates', async (filename, source) => {
    const entry = lockedEntry('0.3.5', source)
    await expect(resolve(filename, entry)).rejects.toThrow('Unsupported prek source')
    await expect(resolve(filename, lockedEntry('0.3.5') + entry)).rejects.toThrow(
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

  it.each([
    'prek==0.4.0',
    'prek @ git+https://example.com/fork.git',
  ])('rejects uv dependency overrides: %s', async override => {
    await expect(
      resolve(
        'pyproject.toml',
        `[project]\ndependencies = ["prek==0.3.5"]\n[tool.uv]\noverride-dependencies = ["${override}"]`,
      ),
    ).rejects.toThrow('dependency overrides')
  })

  it.each(['Cargo.lock', 'Cargo.toml'])('rejects unsupported Cargo files: %s', async filename => {
    await expect(resolve(filename, '')).rejects.toThrow('Unsupported version-file')
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
