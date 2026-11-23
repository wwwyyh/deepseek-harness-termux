/**
 * Degraded link publication: environments that deny link(2) with EACCES/EPERM
 * (SELinux app domains such as MIUI forbid hard links) still publish
 * atomically through rename, while link's never-clobber contract survives.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { publishStagedByLink, type LinkPublishFileSystem } from '../src/publish.ts'

// The materialization integration denies the next link(2) calls; hoisted so
// the factory below can read it while ../src/index.ts is still evaluating.
const refuse = vi.hoisted(() => ({ link: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: (async (...args: Parameters<typeof actual.link>) => {
      if (refuse.link !== null) {
        const code = refuse.link
        throw Object.assign(new Error(`${code}: injected link refusal`), { code })
      }
      return actual.link(...args)
    }),
  }
})

afterEach(() => {
  refuse.link = null
})

/** Filesystem recording each operation, refusing links per the configuration. */
function memoryFileSystem(condition: { denyCode?: string; occupied?: boolean }): {
  fs: LinkPublishFileSystem
  operations: string[]
} {
  const operations: string[] = []
  return {
    operations,
    fs: {
      link: async () => {
        if (condition.denyCode !== undefined) {
          throw Object.assign(new Error(`${condition.denyCode}: injected link refusal`), { code: condition.denyCode })
        }
        operations.push('link')
      },
      rename: async () => { operations.push('rename') },
      stat: async () => {
        if (!condition.occupied) throw Object.assign(new Error('ENOENT: injected absence'), { code: 'ENOENT' })
        return {}
      },
    },
  }
}

describe('publishStagedByLink', () => {
  it('links when the environment allows hard links', async () => {
    const { fs, operations } = memoryFileSystem({})
    const degraded: string[] = []
    await publishStagedByLink(fs, '/staged', '/final', target => degraded.push(target))
    expect(operations).toEqual(['link'])
    expect(degraded).toEqual([])
  })

  it.each(['EACCES', 'EPERM'] as const)('degrades a denied %s link to rename when the target is absent', async (code) => {
    const { fs, operations } = memoryFileSystem({ denyCode: code })
    const degraded: string[] = []
    await publishStagedByLink(fs, '/staged', '/final', target => degraded.push(target))
    expect(operations).toEqual(['rename'])
    expect(degraded).toEqual(['/final'])
  })

  it('keeps the EEXIST refusal when a denied link meets an existing target', async () => {
    const { fs, operations } = memoryFileSystem({ denyCode: 'EPERM', occupied: true })
    const degraded: string[] = []
    await expect(publishStagedByLink(fs, '/staged', '/final', target => degraded.push(target)))
      .rejects.toMatchObject({ code: 'EEXIST' })
    expect(operations).toEqual([])
    expect(degraded).toEqual([])
  })

  it('propagates unrelated link failures unchanged', async () => {
    const { fs, operations } = memoryFileSystem({ denyCode: 'EXDEV' })
    const degraded: string[] = []
    await expect(publishStagedByLink(fs, '/staged', '/final', target => degraded.push(target)))
      .rejects.toMatchObject({ code: 'EXDEV' })
    expect(operations).toEqual([])
    expect(degraded).toEqual([])
  })
})

function meta(id: string, cwd = '/work'): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, cwd, isSeeded: false }
}

const EVENTS = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const

describe('materialization under a denied link', () => {
  it.skipIf(process.platform === 'win32')('publishes a new session by rename and leaves no temp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-publish-'))
    const ctx = new Context()
    try {
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const backend: SessionPersistence = ctx.sessionPersistence
      refuse.link = 'EACCES'
      const handle = await backend.create(meta('degraded'))
      await handle.append([...EVENTS])
      refuse.link = null
      await handle.close()
      const reader = await backend.open(SessionId('degraded'), 'read')
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
      await reader.close()
    } finally {
      refuse.link = null
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
