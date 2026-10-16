import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@actions/core', () => ({ info: vi.fn() }))
vi.mock('../src/manifest', () => ({
  getVersionManifest: vi.fn(async () => ['0.3.0', '0.3.5', '0.3.9', '0.4.0'].map(version => ({
    version, prerelease: false, assets: [], publishedAt: '',
  }))),
}))

import { resolveVersionFile } from '../src/version-file'

let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prek-version-file-')) })
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })

async function resolve(filename: string, content: string): Promise<string> {
  const file = path.join(directory, filename)
  await fs.writeFile(file, content)
  return resolveVersionFile(file)
}

describe('version-file', () => {
  it.each(['uv.lock', 'Cargo.lock'])('reads exact prek versions from %s without requiring manifest membership', async filename => {
    expect(await resolve(filename, '[[package]]\nname = "other"\nversion = "1.0.0"\n[[package]]\nname = "prek"\nversion = "9.0.0"')).toBe('9.0.0')
  })

  it('deduplicates identical locked versions but rejects ambiguous versions', async () => {
    const entry = '[[package]]\nname = "prek"\nversion = "0.3.5"\n'
    expect(await resolve('uv.lock', entry + entry)).toBe('0.3.5')
    await expect(resolve('uv.lock', `${entry}[[package]]\nname = "prek"\nversion = "0.4.0"`)).rejects.toThrow('Ambiguous prek versions')
  })

  it.each([
    '[project]\ndependencies = ["prek~=0.3.0,!=0.3.9"]',
    '[project.optional-dependencies]\nlint = ["prek~=0.3.0,!=0.3.9"]',
    '[dependency-groups]\nlint = ["prek~=0.3.0,!=0.3.9"]',
  ])('uses native PEP 440 constraints in standard dependency lists', async content => {
    expect(await resolve('pyproject.toml', content)).toBe('0.3.5')
  })

  it('accepts an exact Python pin newer than the manifest', async () => {
    expect(await resolve('pyproject.toml', '[dependency-groups]\nlint = ["prek==9.0.0"]')).toBe('9.0.0')
    expect(await resolve('pyproject.toml', '[dependency-groups]\nlint = ["prek == 9.0.0"]')).toBe('9.0.0')
  })

  it('accepts parenthesized Python version specifiers', async () => {
    expect(await resolve('pyproject.toml', '[dependency-groups]\nlint = ["prek (>=0.3.0,<0.4)"]')).toBe('0.3.9')
  })

  it('does not confuse similarly named dependencies or uv required-version with prek', async () => {
    await expect(resolve('pyproject.toml', '[project]\ndependencies = ["prek-helper==1.0.0"]\n[tool.uv]\nrequired-version = "0.3.5"')).rejects.toThrow('No prek version')
  })

  it('rejects conditional and conflicting dependency declarations', async () => {
    await expect(resolve('pyproject.toml', '[project]\ndependencies = ["prek>=0.3; python_version >= \'3.10\'"]')).rejects.toThrow('Conditional prek dependencies')
    await expect(resolve('pyproject.toml', '[dependency-groups]\na = ["prek==0.3.5"]\nb = ["prek==0.4.0"]')).rejects.toThrow('Ambiguous prek versions')
  })

  it.each([
    '[dev-dependencies]\nprek = "0.3.0"',
    '[workspace.dependencies]\nprek = { version = "0.3.0" }',
    '[dependencies]\nhooks = { package = "prek", version = "0.3.0" }',
  ])('uses Cargo caret semantics for bare requirements', async content => {
    expect(await resolve('Cargo.toml', content)).toBe('0.3.9')
  })

  it('supports Cargo comma-separated bounds and exact pins', async () => {
    expect(await resolve('Cargo.toml', '[dependencies]\nprek = ">=0.3.0, <0.3.9"')).toBe('0.3.5')
    expect(await resolve('Cargo.toml', '[dependencies]\nprek = "=9.0.0"')).toBe('9.0.0')
  })

  it('never infers prek from the project package version', async () => {
    await expect(resolve('Cargo.toml', '[package]\nname = "my-project"\nversion = "0.3.5"')).rejects.toThrow('No prek version')
  })

  it('accepts the actual prek package version and same-file workspace dependencies', async () => {
    expect(await resolve('Cargo.toml', '[package]\nname = "prek"\nversion = "9.0.0"')).toBe('9.0.0')
    expect(await resolve('Cargo.toml', '[dev-dependencies]\nprek = { workspace = true }\n[workspace.dependencies]\nprek = "0.3.0"')).toBe('0.3.9')
  })

  it('rejects workspace-inherited or path dependencies without explicit versions', async () => {
    await expect(resolve('Cargo.toml', '[dependencies]\nprek = { workspace = true }')).rejects.toThrow('has no version')
  })

  it('reports missing, malformed, and unsupported files', async () => {
    await expect(resolveVersionFile(path.join(directory, 'uv.lock'))).rejects.toThrow('Could not read version-file')
    await expect(resolve('pyproject.toml', '[invalid')).rejects.toThrow('Could not read version-file')
    await expect(resolve('requirements.txt', 'prek==0.3.5')).rejects.toThrow('Unsupported version-file')
  })
})
