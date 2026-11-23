/**
 * Shared atomic publication for the JSONL backend's publish sites: hard-link
 * first, degrading to rename(2) where the environment denies link(2).
 * @module @deepseek-ai/dsh-session-persistence-jsonl/publish
 */

/** Filesystem operations the degraded link publication needs. */
export interface LinkPublishFileSystem {
  link(existingPath: string, newPath: string): Promise<void>
  rename(existingPath: string, newPath: string): Promise<void>
  stat(path: string): Promise<unknown>
}

/**
 * Publish one staged file at its final path with a hard link, degrading to
 * rename(2) when link(2) is denied with EACCES/EPERM — SELinux app domains
 * (MIUI and similar ROMs) forbid hard links — and the target does not exist.
 * The caller holds the session's exclusive write lease, so the rename
 * publication is equivalent; link's never-clobber contract survives because
 * an existing target rejects with EEXIST instead of being replaced.
 * @param fs - filesystem operations to publish through.
 * @param from - staged file to publish.
 * @param to - final path to publish at.
 * @param onDegraded - observability hook receiving the target path when the
 *   rename degradation runs.
 */
export async function publishStagedByLink(
  fs: LinkPublishFileSystem,
  from: string,
  to: string,
  onDegraded: (target: string) => void,
): Promise<void> {
  try {
    await fs.link(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') throw error
    // Keep link()'s EEXIST semantics: never replace an existing target.
    const occupied = await fs.stat(to).then(() => true, () => false)
    if (occupied) {
      throw Object.assign(new Error(`EEXIST: link denied and target exists, "${to}"`), { code: 'EEXIST' })
    }
    onDegraded(to)
    await fs.rename(from, to)
  }
}
