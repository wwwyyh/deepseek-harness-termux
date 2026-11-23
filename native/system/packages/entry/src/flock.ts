/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { getSystemErrorName } from 'node:util'

interface FlockBinding {
  tryLock(fd: number, callback: (errno: number) => void): void
}

/** libc `flock(int, int)` resolved through koffi for the fallback path. */
type LibcFlock = (fd: number, operation: number) => number

const LOCK_EX = 2
const LOCK_NB = 4
/**
 * EAGAIN: the errno `flock(2)` reports for contention under LOCK_NB. The koffi
 * fallback cannot read errno after the call, and contention is the only
 * failure a correct caller can observe on an open descriptor, so the fallback
 * always reports this code, spelled directly because `getSystemErrorName` maps
 * errnos differently off POSIX hosts.
 */
const EAGAIN = 11

let binding: FlockBinding | undefined
/** Memoized addon-load failure; a platform package does not appear mid-process. */
let bindingUnavailable = false
let libcFlock: LibcFlock | undefined

/** Whether the running platform reaches flock(2) through any supported path. */
function unsupportedPlatformError(): Error | undefined {
  const { platform, arch } = process
  // bionic (android) provides flock(2); the koffi fallback reaches it below.
  if (platform === 'linux' || platform === 'darwin' || platform === 'android') return undefined
  return Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
    code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
    syscall: 'flock',
  })
}

/**
 * Load the prebuilt system addon, or undefined when this installation has
 * none for the running platform. Load failures memoize.
 */
function tryLoadBinding(): FlockBinding | undefined {
  if (binding !== undefined) return binding
  if (bindingUnavailable) return undefined
  const { platform, arch } = process
  // android ships no platform package; its libc flock(2) serves the fallback.
  if (platform === 'android') return undefined
  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  try {
    const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
    binding = require(join(dirname(manifest), 'bin', filename)) as FlockBinding
    return binding
  } catch {
    bindingUnavailable = true
    return undefined
  }
}

/**
 * Attempt one exclusive, nonblocking flock through the libc, for platforms
 * whose libc provides `flock(2)` while no prebuilt system addon ships
 * (Android's bionic, or an installation missing its platform package). koffi
 * loads only on this path, so addon-backed callers never load it.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition.
 * @throws A contention-shaped error (code EAGAIN, positive errno, syscall
 *   'flock') on every refusal.
 */
async function koffiAcquire(fd: number): Promise<void> {
  if (libcFlock === undefined) {
    const koffi = (await import('koffi')).default
    const libc = koffi.load('libc.so')
    libcFlock = libc.func('int flock(int fd, int operation)') as LibcFlock
  }
  if (libcFlock(fd, LOCK_EX | LOCK_NB) === 0) return
  throw Object.assign(new Error('EAGAIN: flock failed'), { code: 'EAGAIN', errno: EAGAIN, syscall: 'flock' })
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The addon path runs the syscall in asynchronous work, so acquisition can
 * occur after this call returns. Keep fd open until the promise settles; no
 * path opens, duplicates, or closes the descriptor. Closing the locked
 * descriptor releases the lock once all descriptors for its open file
 * description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Unsupported platforms reject;
 *   importing alone loads no addon. A missing addon binding degrades to the
 *   libc call instead of rejecting.
 */
export async function tryLockExclusive(fd: number): Promise<void> {
  const unsupported = unsupportedPlatformError()
  if (unsupported !== undefined) throw unsupported
  const native = tryLoadBinding()
  if (native !== undefined) {
    const errno = await new Promise<number>((resolve) => {
      native.tryLock(fd, resolve)
    })
    if (errno === 0) return
    const code = getSystemErrorName(-errno)
    throw Object.assign(new Error(`${code}: flock failed`), {
      code,
      errno,
      syscall: 'flock',
    })
  }
  await koffiAcquire(fd)
}
