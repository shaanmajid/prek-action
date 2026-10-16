import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Inputs } from '../src/types'

const mockContext = vi.hoisted(() => ({
  failures: [] as string[],
  inputs: {
    extraArgs: '--all-files',
    installOnly: false,
    prekVersion: 'latest',
    showVerboseLogs: false,
    versionFile: '',
    workingDirectory: '/tmp/repo',
  } as Inputs,
  outputs: [] as Array<[string, string]>,
  restoreResult: {
    matchedKey: 'prek-v1|0.3.6|Linux|X64|/opt/python|hash',
    primaryKey: 'prek-v1|0.3.6|Linux|X64|/opt/python|hash',
  } as { matchedKey?: string; primaryKey: string },
}))

const coreMocks = vi.hoisted(() => ({
  endGroup: vi.fn(),
  getState: vi.fn(() => ''),
  info: vi.fn(),
  saveState: vi.fn(),
  setFailed: vi.fn((message: string) => {
    mockContext.failures.push(message)
  }),
  setOutput: vi.fn((name: string, value: string) => {
    mockContext.outputs.push([name, value])
  }),
  startGroup: vi.fn(),
  warning: vi.fn(),
}))

const dependencyMocks = vi.hoisted(() => ({
  getInputs: vi.fn(() => mockContext.inputs),
  installPrek: vi.fn(async () => '/tmp/prek'),
  normalizeVersion: vi.fn((version: string) => `v${version.replace(/^v/, '')}`),
  pruneCache: vi.fn(async () => {}),
  resolveVersion: vi.fn(async () => '0.3.6'),
  resolveVersionFile: vi.fn(async () => '0.3.5'),
  restorePrekCache: vi.fn(async () => mockContext.restoreResult),
  runPrek: vi.fn(async () => 0),
  savePrekCache: vi.fn(async () => {}),
  showVerboseLogs: vi.fn(async () => {}),
}))

vi.mock('@actions/core', () => coreMocks)
vi.mock('../src/cache', () => ({
  restorePrekCache: dependencyMocks.restorePrekCache,
  savePrekCache: dependencyMocks.savePrekCache,
}))
vi.mock('../src/inputs', () => ({
  getInputs: dependencyMocks.getInputs,
}))
vi.mock('../src/install', () => ({
  installPrek: dependencyMocks.installPrek,
}))
vi.mock('../src/manifest', () => ({
  normalizeVersion: dependencyMocks.normalizeVersion,
  resolveVersion: dependencyMocks.resolveVersion,
}))
vi.mock('../src/version-file', () => ({
  resolveVersionFile: dependencyMocks.resolveVersionFile,
}))
vi.mock('../src/prek', () => ({
  pruneCache: dependencyMocks.pruneCache,
  runPrek: dependencyMocks.runPrek,
  showVerboseLogs: dependencyMocks.showVerboseLogs,
}))

async function importMainModule() {
  vi.resetModules()
  return import('../src/main')
}

function resetMockContext(): void {
  mockContext.failures = []
  mockContext.inputs = {
    cache: true,
    extraArgs: '--all-files',
    installOnly: false,
    prekVersion: 'latest',
    showVerboseLogs: false,
    versionFile: '',
    workingDirectory: '/tmp/repo',
  }
  mockContext.outputs = []
  mockContext.restoreResult = {
    matchedKey: 'prek-v1|0.3.6|Linux|X64|/opt/python|hash',
    primaryKey: 'prek-v1|0.3.6|Linux|X64|/opt/python|hash',
  }
}

describe('run', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMockContext()
  })

  it('reads version-file relative to working-directory when no version is supplied', async () => {
    mockContext.inputs.prekVersion = ''
    mockContext.inputs.versionFile = 'uv.lock'
    const { run } = await importMainModule()
    await run()
    expect(dependencyMocks.resolveVersionFile).toHaveBeenCalledWith('/tmp/repo/uv.lock')
    expect(dependencyMocks.resolveVersion).toHaveBeenCalledWith('0.3.5')
  })

  it('lets explicit latest override version-file', async () => {
    mockContext.inputs.versionFile = 'uv.lock'
    const { run } = await importMainModule()
    await run()
    expect(dependencyMocks.resolveVersionFile).not.toHaveBeenCalled()
    expect(dependencyMocks.resolveVersion).toHaveBeenCalledWith('latest')
  })

  it('defaults to latest without a version or version-file', async () => {
    mockContext.inputs.prekVersion = ''
    const { run } = await importMainModule()
    await run()
    expect(dependencyMocks.resolveVersion).toHaveBeenCalledWith('latest')
  })

  it('sets cache-hit when the restored cache key matches the primary key', async () => {
    const { run } = await importMainModule()

    await run()

    expect(mockContext.outputs).toEqual([
      ['prek-version', 'v0.3.6'],
      ['cache-hit', 'true'],
    ])
    expect(mockContext.failures).toEqual([])
  })

  it('skips cache restore and sets cache-hit=false when cache is disabled', async () => {
    mockContext.inputs.cache = false

    const { run } = await importMainModule()

    await run()

    expect(dependencyMocks.restorePrekCache).not.toHaveBeenCalled()
    expect(mockContext.outputs).toEqual([
      ['prek-version', 'v0.3.6'],
      ['cache-hit', 'false'],
    ])
    expect(dependencyMocks.runPrek).toHaveBeenCalled()
    expect(mockContext.failures).toEqual([])
  })

  it('reports a cache miss via cache-hit=false and skips prek execution for install-only', async () => {
    mockContext.inputs.installOnly = true
    mockContext.restoreResult = {
      matchedKey: undefined,
      primaryKey: 'prek-v1|0.3.6|Linux|X64|/opt/python|hash',
    }

    const { run } = await importMainModule()

    await run()

    expect(dependencyMocks.runPrek).not.toHaveBeenCalled()
    expect(mockContext.outputs).toEqual([
      ['prek-version', 'v0.3.6'],
      ['cache-hit', 'false'],
    ])
  })
})

describe('runPost', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetMockContext()
  })

  it('saves the cache through the post path', async () => {
    const { runPost } = await importMainModule()

    await runPost()

    expect(dependencyMocks.savePrekCache).toHaveBeenCalledTimes(1)
  })
})
