import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockContext = vi.hoisted(() => ({
  cacheDir: '/tmp/prek-cache',
  infos: [] as string[],
}))

const toolkitMocks = vi.hoisted(() => ({
  exec: vi.fn<
    (
      commandLine: string,
      args?: string[],
      options?: { listeners?: { stdout?: (data: Buffer) => void } },
    ) => Promise<number>
  >(),
}))

vi.mock('@actions/core', () => ({
  endGroup: vi.fn(),
  info: vi.fn((message: string) => {
    mockContext.infos.push(message)
  }),
  startGroup: vi.fn(),
}))

vi.mock('@actions/exec', () => ({
  exec: toolkitMocks.exec,
}))

const { getPrekCacheDir, pruneCache, runPrek } = await import('../src/prek')

describe('runPrek', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toolkitMocks.exec.mockResolvedValue(0)
  })

  it('checks all files even when extra arguments are supplied', async () => {
    await runPrek('/tmp/project', '--verbose', true)
    expect(toolkitMocks.exec).toHaveBeenCalledWith(
      'prek',
      ['run', '--show-diff-on-failure', '--color=always', '--all-files', '--verbose'],
      expect.objectContaining({ cwd: '/tmp/project', ignoreReturnCode: true }),
    )
  })

  it('allows selected filenames and preserves argument quoting', async () => {
    await runPrek('/tmp/project', '--files "file with spaces.txt" 中文', false)
    expect(toolkitMocks.exec).toHaveBeenCalledWith(
      'prek',
      [
        'run',
        '--show-diff-on-failure',
        '--color=always',
        '--files',
        'file with spaces.txt',
        '中文',
      ],
      expect.any(Object),
    )
  })

  it('leaves file selection to prek when disabled with no extra arguments', async () => {
    await runPrek('/tmp/project', '', false)
    expect(toolkitMocks.exec).toHaveBeenCalledWith(
      'prek',
      ['run', '--show-diff-on-failure', '--color=always'],
      expect.any(Object),
    )
  })
})

describe('getPrekCacheDir', () => {
  beforeEach(() => {
    mockContext.cacheDir = '/tmp/prek-cache'
    mockContext.infos = []
    vi.clearAllMocks()

    toolkitMocks.exec.mockImplementation(async (_commandLine, _args, options) => {
      options?.listeners?.stdout?.(Buffer.from(`${mockContext.cacheDir}\n`))
      return 0
    })
  })

  it('prefers the CLI-reported path', async () => {
    await expect(getPrekCacheDir()).resolves.toBe('/tmp/prek-cache')
    expect(toolkitMocks.exec).toHaveBeenCalledWith(
      'prek',
      ['cache', 'dir', '--no-log-file', '--color=never'],
      expect.any(Object),
    )
    expect(mockContext.infos).toEqual(['Using prek cache dir /tmp/prek-cache'])
  })

  it('queries and prunes the cache in the same directory as prek run', async () => {
    const workingDirectory = path.join(os.tmpdir(), 'project')
    await getPrekCacheDir(workingDirectory)
    expect(toolkitMocks.exec).toHaveBeenCalledWith(
      'prek',
      ['cache', 'dir', '--no-log-file', '--color=never'],
      expect.objectContaining({ cwd: workingDirectory }),
    )
    await pruneCache(workingDirectory)
    expect(toolkitMocks.exec).toHaveBeenCalledWith(
      'prek',
      ['cache', 'gc', '-v'],
      expect.objectContaining({ cwd: workingDirectory }),
    )
  })

  it('resolves a relative PREK_HOME against the working directory in the fallback', async () => {
    const originalEnv = { ...process.env }
    process.env.PREK_HOME = '.prek-cache'
    toolkitMocks.exec.mockResolvedValue(2)
    const workingDirectory = path.join(os.tmpdir(), 'project')
    try {
      await expect(getPrekCacheDir(workingDirectory)).resolves.toBe(
        path.join(workingDirectory, '.prek-cache'),
      )
    } finally {
      process.env = originalEnv
    }
  })

  it('falls back to PREK_HOME when the CLI probe fails', async () => {
    const originalEnv = { ...process.env }
    const prekHome = path.join(os.tmpdir(), 'prek-action-prek-home')
    process.env.PREK_HOME = prekHome
    toolkitMocks.exec.mockResolvedValue(2)

    try {
      await expect(getPrekCacheDir()).resolves.toBe(prekHome)
    } finally {
      process.env = originalEnv
    }

    expect(mockContext.infos).toEqual([`Falling back to default prek cache dir ${prekHome}`])
  })

  it('falls back to XDG_CACHE_HOME/prek when CLI probe fails and PREK_HOME is unset', async () => {
    const originalEnv = { ...process.env }

    delete process.env.PREK_HOME
    if (process.platform === 'win32') {
      process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'prek-action-localappdata')
      delete process.env.XDG_CACHE_HOME
    } else {
      process.env.XDG_CACHE_HOME = path.join(os.tmpdir(), 'prek-action-xdg-cache')
    }

    const expected =
      process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || '', 'prek')
        : path.join(process.env.XDG_CACHE_HOME || '', 'prek')

    toolkitMocks.exec.mockResolvedValue(2)

    try {
      await expect(getPrekCacheDir()).resolves.toBe(expected)
    } finally {
      process.env = originalEnv
    }

    expect(mockContext.infos).toEqual([`Falling back to default prek cache dir ${expected}`])
  })
})
