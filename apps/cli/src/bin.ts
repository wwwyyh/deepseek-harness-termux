#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createRequire } from 'node:module'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const version = getDshRuntimeVersion()
  const { manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

/**
 * Whether the builtin addon can supply Node internal modules. On non-glibc
 * platforms such as Android/bionic no usable binding ships and every addon
 * lookup refuses to run; profile resolution then needs `--expose-internals`.
 */
function builtinAddonUsable(): boolean {
  try {
    const require = createRequire(import.meta.url)
    const addon = require('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    addon.requireBuiltin('internal/modules/cjs/loader')
    return true
  } catch {
    return false
  }
}

/**
 * Relaunch this CLI under `--expose-internals` and exit with its outcome, so
 * profile resolution can require Node internals directly where the builtin
 * addon is unusable. One-shot: the relaunch carries the flag in
 * `process.execArgv`, which is also why NODE_OPTIONS cannot replace this —
 * Node rejects that flag in NODE_OPTIONS.
 */
async function relaunchWithExposedInternals(script: string): Promise<never> {
  const { spawn } = await import('node:child_process')
  const child = spawn(
    process.execPath,
    [...process.execArgv, '--expose-internals', script, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  )
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  if (outcome.signal !== null) process.kill(process.pid, outcome.signal)
  process.exit(outcome.code ?? 0)
}

if (import.meta.main) {
  const script = process.argv[1]
  if (script !== undefined && !process.execArgv.includes('--expose-internals') && !builtinAddonUsable()) {
    await relaunchWithExposedInternals(script)
  }
  await runCli()
}
