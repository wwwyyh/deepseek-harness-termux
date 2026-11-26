// Assemble a self-contained npm deployment set for off-registry installs
// (Termux/Android). Usage, from the repository root:
//   tsx scripts/release/pack-offline-deploy.ts <outDir> <packed-dir> [<packed-dir> ...]
// Computes the runtime dependency closure of @deepseek-ai/dsh (dependencies,
// optionalDependencies, and peerDependencies through workspace manifests), copies the matching
// tarballs into <outDir>/tgz, and writes <outDir>/package.json whose
// dependencies point at them through relative file: entries, so the directory
// installs on any machine with plain `npm install`. Packages outside the
// closure (test-support tooling with heavy test-runner dependencies, product
// assemblies) stay out, exactly as a registry install of the CLI would leave
// them.
import { copyFileSync, existsSync, globSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Workspace manifest locations holding publishable packages. */
const patterns = [
  'packages/*/*/package.json',
  'apps/*/package.json',
  'vendor/*/package.json',
  'native/system/packages/entry/package.json',
]

/** The CLI whose runtime closure the deployment set installs. */
export const ENTRY = '@deepseek-ai/dsh'

/**
 * @deepseek-ai/libreoffice-kit (external) pins koffi 3.1.1 exactly; that
 * version does not compile on Android/bionic (the statx bug fixed upstream
 * in 3.3.2). Force one tree-wide koffi so npm dedupes the nested copy away.
 */
export const KOFFI_OVERRIDE = '3.3.2'

/** Where the deployment set lands when no output directory is given. */
const DEFAULT_OUT_DIR = 'dist/offline-deploy'

/** The fields of a workspace manifest the closure walk reads. */
interface WorkspaceManifest {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** Inputs of one offline deployment packing run. */
export interface PackOfflineDeployOptions {
  /** Repository root whose workspace manifests define the package graph. */
  cwd: string
  /** Directory receiving `tgz/`, `package.json`, and `install.sh`. */
  outDir: string
  /** Directories holding the packed tarballs to copy from. */
  sources: readonly string[]
}

/** Outcome of one packing run. */
export interface PackOfflineDeployResult {
  /** Names in the closure, in discovery order starting at the entry. */
  closure: readonly string[]
  /** Absolute path of the written deployment directory. */
  outDir: string
}

/** The npm tarball filename a published package resolves to. */
export function tarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

/**
 * Collect every publishable workspace manifest under `cwd`, keyed by name.
 * @param cwd - Repository root to glob from.
 * @returns Package name to parsed manifest; private manifests are skipped.
 */
export function readWorkspaceManifests(cwd: string): Map<string, WorkspaceManifest> {
  const manifests = new Map<string, WorkspaceManifest>()
  for (const pattern of patterns) {
    for (const manifestPath of globSync(pattern, { cwd }).sort()) {
      const manifest = JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8')) as WorkspaceManifest
      if (manifest.private === true) continue
      manifests.set(manifest.name, manifest)
    }
  }
  return manifests
}

/**
 * Walk dependencies, optionalDependencies, and peerDependencies from `entry`
 * through workspace manifests only; registry dependencies have no manifest and
 * end the walk. Workspace peers must join: npm resolves a missing peer from
 * the registry, whose stable release may reject the pre-release versions the
 * deployment set carries.
 * @param manifests - Publishable workspace manifests by name.
 * @param entry - Package name to start from.
 * @returns Closure names in breadth-first discovery order, entry first.
 */
export function runtimeClosure(manifests: ReadonlyMap<string, Pick<WorkspaceManifest, 'dependencies' | 'optionalDependencies' | 'peerDependencies'>>, entry: string): string[] {
  const closure = new Set([entry])
  for (let frontier = [entry]; frontier.length > 0;) {
    const next = []
    for (const name of frontier) {
      // Every name in the closure was admitted through manifests.has().
      const manifest = manifests.get(name)
      if (manifest === undefined) throw new Error(`${name} is in the closure without a workspace manifest`)
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
        for (const dependency of Object.keys(manifest[section] ?? {})) {
          if (manifests.has(dependency) && !closure.has(dependency)) {
            closure.add(dependency)
            next.push(dependency)
          }
        }
      }
    }
    frontier = next
  }
  return [...closure]
}

/**
 * Assemble the deployment set: verify every closure tarball is packed, copy
 * the tarballs, and write the `file:` manifest and installer.
 * @param options - `cwd` (repository root), `outDir`, and `sources` (packed
 *   tarball directories), all resolved against `cwd`.
 * @returns The closure names and the written directory.
 * @throws When no source directory is given, the entry is not a workspace
 *   manifest, a source directory is absent, or any closure tarball is missing.
 */
export function packOfflineDeploy(options: PackOfflineDeployOptions): PackOfflineDeployResult {
  const { cwd } = options
  const outDir = resolve(cwd, options.outDir)
  const sources = options.sources.map(directory => resolve(cwd, directory))
  if (sources.length === 0) {
    throw new Error('usage: pack-offline-deploy <outDir> <packed-dir> [<packed-dir> ...]')
  }

  const manifests = readWorkspaceManifests(cwd)
  if (!manifests.has(ENTRY)) throw new Error(`${ENTRY} is not among the workspace manifests`)

  const closure = runtimeClosure(manifests, ENTRY)

  const available = new Map<string, string>()
  for (const directory of sources) {
    if (!existsSync(directory)) throw new Error(`packed directory not found: ${directory}`)
    for (const name of readdirSync(directory).filter(name => name.endsWith('.tgz'))) {
      available.set(name, join(directory, name))
    }
  }

  const tarballFor = (name: string): string => {
    const version = manifests.get(name)?.version
    if (version === undefined) throw new Error(`${name} is in the closure without a workspace manifest`)
    return tarballName(name, version)
  }
  const missing = closure.filter(name => !available.has(tarballFor(name)))
  if (missing.length > 0) {
    throw new Error(`packed tarballs missing for: ${missing.map(name => `${name} (${tarballFor(name)})`).join(', ')}`)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, 'tgz'), { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const name of closure) {
    const filename = tarballFor(name)
    // The missing check above admitted every closure tarball.
    const source = available.get(filename)
    if (source === undefined) throw new Error(`${filename} passed the missing check but is not packed`)
    copyFileSync(source, join(outDir, 'tgz', filename))
    dependencies[name] = `file:tgz/${filename}`
  }

  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-offline-deploy',
    version: '0.0.0',
    private: true,
    dependencies,
    overrides: {
      koffi: KOFFI_OVERRIDE,
    },
  }, null, 2)}\n`)

  writeFileSync(join(outDir, 'install.sh'), `#!/usr/bin/env sh
# Install the packed DeepSeek Harness from local tarballs; only external
# dependencies (koffi, node-pty, commander, ...) come from the npm registry.
set -e
cd "$(dirname "$0")"
npm install --no-audit --no-fund
echo
echo "Run with: ./node_modules/.bin/dsh web"
`)

  return { closure, outDir }
}

if (import.meta.main) {
  const [outDirArgument, ...sourceArguments] = process.argv.slice(2)
  const { closure, outDir } = packOfflineDeploy({
    cwd: process.cwd(),
    outDir: outDirArgument ?? DEFAULT_OUT_DIR,
    sources: sourceArguments,
  })
  console.log(`offline deploy set: ${String(closure.length)} packages (closure of ${ENTRY}) in ${outDir}`)
  console.log('scp -r the whole directory to the target, then: sh install.sh')
}
