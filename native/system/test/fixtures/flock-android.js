/**
 * A separate process keeps the faked android platform away from other tests:
 * android ships no platform package, so every lock goes through the koffi
 * libc fallback. Real kernel flock semantics with a real descriptor pair.
 */
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
try {
  Object.defineProperty(process, 'platform', { value: 'android' });
  const { tryLockExclusive } = await import('../../packages/entry/lib/flock.js');
  assert.equal(typeof tryLockExclusive, 'function');
  const root = mkdtempSync(join(tmpdir(), 'node-addon-system-flock-android-'));
  try {
    const owner = openSync(join(root, 'lock'), 'a+', 0o600);
    const contender = openSync(join(root, 'lock'), 'a+', 0o600);
    try {
      const acquired = tryLockExclusive(owner.fd);
      assert.ok(acquired instanceof Promise);
      assert.equal(await acquired, undefined);
      // Contention through the libc fallback keeps the addon's error shape.
      await assert.rejects(tryLockExclusive(contender.fd), (error) => {
        assert.equal(error.code, 'EAGAIN');
        assert.equal(error.errno, 11);
        assert.ok(error.errno > 0);
        assert.equal(error.syscall, 'flock');
        return true;
      });
      closeSync(owner.fd);
      assert.equal(await tryLockExclusive(contender.fd), undefined);
    } finally {
      try { closeSync(owner.fd); } catch { /* the success path already closed it */ }
      try { closeSync(contender.fd); } catch { /* never closed only on failure */ }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} finally {
  Object.defineProperty(process, 'platform', descriptor);
}
await new Promise((resolve, reject) => {
  process.send({ type: 'ready' }, (error) => error ? reject(error) : resolve());
});
process.disconnect();
