/**
 * Fallback flock semantics with a mocked koffi libc, for platforms without a
 * prebuilt system addon (Android/bionic): the faked platform keeps the addon
 * search away, so every call exercises the koffi path. Real-kernel behavior
 * on Linux is pinned by native/system's own flock suite; these tests keep
 * the Promise contract and the shared error shape covered on every host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  vi.doUnmock('koffi')
  vi.resetModules()
  if (platformDescriptor !== undefined) Object.defineProperty(process, 'platform', platformDescriptor)
})

type LibcFlock = (fd: number, operation: number) => number

async function importFlock(
  platform: NodeJS.Platform,
  flock: LibcFlock,
): Promise<typeof import('@deepseek-ai/node-addon-system/flock')> {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: () => ({
        func: (prototype: string) => {
          expect(prototype).toBe('int flock(int fd, int operation)')
          return flock
        },
      }),
    },
  }))
  return import('@deepseek-ai/node-addon-system/flock')
}

describe('flock koffi fallback', () => {
  it('acquires through libc with LOCK_EX | LOCK_NB and resolves to void', async () => {
    const calls: Array<[fd: number, operation: number]> = []
    const { tryLockExclusive } = await importFlock('android', (fd, operation) => {
      calls.push([fd, operation])
      return 0
    })
    const acquired = tryLockExclusive(4)
    expect(acquired).toBeInstanceOf(Promise)
    await expect(acquired).resolves.toBeUndefined()
    expect(calls).toEqual([[4, 6]])
  })

  it('maps a refusing libc call to the shared contention error shape', async () => {
    const { tryLockExclusive } = await importFlock('android', () => -1)
    await expect(tryLockExclusive(7)).rejects.toMatchObject({ code: 'EAGAIN', errno: 11, syscall: 'flock' })
  })

  it('rejects when koffi itself cannot load the libc', async () => {
    Object.defineProperty(process, 'platform', { value: 'android' })
    vi.resetModules()
    vi.doMock('koffi', () => ({
      default: {
        load: () => {
          throw new Error('injected libc.so refusal')
        },
      },
    }))
    const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock')
    await expect(tryLockExclusive(9)).rejects.toThrow(/injected libc\.so refusal/)
  })

  it('still rejects platforms without any flock path', async () => {
    const { tryLockExclusive } = await importFlock('win32', () => 0)
    await expect(tryLockExclusive(4)).rejects.toMatchObject({ code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM' })
  })
})
