/** Offline deployment packing: closure selection, missing-tarball refusal, and the written manifest. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENTRY, KOFFI_OVERRIDE, packOfflineDeploy, tarballName } from './pack-offline-deploy.ts'

const roots: string[] = []

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** One workspace package of the miniature repository, with its manifest and optional tarball. */
interface FixturePackage {
  name: string
  version: string
  /** Directory under the repository root holding this package's manifest. */
  directory: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  private?: boolean
}

/**
 * A miniature repository shaped like the workspace: an entry CLI depending on
 * a transitive chain, a workspace package reachable only through a
 * peerDependency, a private package, an external registry dependency, and a
 * test-support package that only devDependencies reference.
 */
function repository(): { cwd: string; packed: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-offline-deploy-'))
  roots.push(cwd)
  const packages: FixturePackage[] = [
    {
      name: ENTRY,
      version: '1.0.0',
      directory: 'apps/cli',
      dependencies: {
        '@deepseek-ai/dsh-app-boot': 'workspace:*',
        commander: '^12.0.0',
      },
      optionalDependencies: { '@deepseek-ai/dsh-node-addon-system': 'workspace:~' },
      devDependencies: { vitest: '^4.0.0', '@deepseek-ai/dsh-test-support': 'workspace:*' },
    },
    {
      name: '@deepseek-ai/dsh-app-boot',
      version: '1.0.0',
      directory: 'packages/boot/app-boot',
      dependencies: { '@deepseek-ai/dsh-home-paths': 'workspace:*' },
      peerDependencies: { '@deepseek-ai/cordis-scope': 'workspace:~' },
    },
    {
      name: '@deepseek-ai/cordis-scope',
      version: '0.1.0',
      directory: 'vendor/scope',
    },
    {
      name: '@deepseek-ai/dsh-home-paths',
      version: '1.0.0',
      directory: 'packages/util/home-paths',
    },
    {
      name: '@deepseek-ai/dsh-node-addon-system',
      version: '0.1.0',
      directory: 'native/system/packages/entry',
    },
    { name: '@deepseek-ai/dsh-private-root', version: '1.0.0', directory: 'packages/boot/private-root', private: true },
    {
      name: '@deepseek-ai/dsh-test-support',
      version: '1.0.0',
      directory: 'packages/test-support/support',
      dependencies: { vitest: '^4.0.0' },
    },
  ]
  for (const pkg of packages) {
    mkdirSync(join(cwd, pkg.directory), { recursive: true })
    const { directory, ...manifest } = pkg
    writeFileSync(join(cwd, directory, 'package.json'), JSON.stringify(manifest))
  }
  const packed = join(cwd, 'packed')
  mkdirSync(packed)
  return { cwd, packed }
}

/** Write a tarball stand-in for `pkg` into the packed directory. */
function pack(packed: string, name: string, version: string): string {
  const filename = tarballName(name, version)
  writeFileSync(join(packed, filename), `${name}@${version}`)
  return filename
}

/** The full set of tarballs the miniature closure needs. */
function packAll(packed: string): void {
  pack(packed, ENTRY, '1.0.0')
  pack(packed, '@deepseek-ai/dsh-app-boot', '1.0.0')
  pack(packed, '@deepseek-ai/dsh-home-paths', '1.0.0')
  pack(packed, '@deepseek-ai/cordis-scope', '0.1.0')
  pack(packed, '@deepseek-ai/dsh-node-addon-system', '0.1.0')
}

/** The manifest fields of a written deployment set. */
interface DeploymentManifest {
  name: string
  private: boolean
  dependencies: Record<string, string>
  overrides: Record<string, string>
}

/** Read the manifest of a packed deployment set. */
function manifestOf(outDir: string): DeploymentManifest {
  return JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as DeploymentManifest
}

describe('offline deployment packing', () => {
  it('packs exactly the runtime closure: dependencies, optionalDependencies, and peerDependencies through workspace manifests, nothing else', () => {
    const { cwd, packed } = repository()
    // Deliberately packed yet outside the closure: a test-support package and
    // a private workspace root. Neither may reach the deployment set.
    packAll(packed)
    pack(packed, '@deepseek-ai/dsh-test-support', '1.0.0')
    pack(packed, '@deepseek-ai/dsh-private-root', '1.0.0')

    const { closure, outDir } = packOfflineDeploy({ cwd, outDir: 'deploy', sources: ['packed'] })

    expect(closure[0]).toBe(ENTRY)
    expect(new Set(closure)).toEqual(new Set([
      ENTRY,
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/cordis-scope',
      '@deepseek-ai/dsh-node-addon-system',
    ]))
    // A workspace peer must ship: npm would otherwise resolve the stable
    // registry release, whose peer range can reject the pre-release set.
    // devDependencies never join (the CLI dev-depends on test-support), registry
    // dependencies have no tarball to copy, and the private package stays out
    // although packed.
    expect(closure).not.toContain('@deepseek-ai/dsh-test-support')
    expect(closure).not.toContain('@deepseek-ai/dsh-private-root')
    expect(closure).not.toContain('commander')
    expect(closure).not.toContain('vitest')
    expect(readdirSync(join(outDir, 'tgz')).sort()).toEqual([
      tarballName(ENTRY, '1.0.0'),
      tarballName('@deepseek-ai/dsh-app-boot', '1.0.0'),
      tarballName('@deepseek-ai/dsh-home-paths', '1.0.0'),
      tarballName('@deepseek-ai/cordis-scope', '0.1.0'),
      tarballName('@deepseek-ai/dsh-node-addon-system', '0.1.0'),
    ].sort())
  })

  it('refuses a missing closure tarball by naming the package and its expected file, writing nothing', () => {
    const { cwd, packed } = repository()
    packAll(packed)
    rmSync(join(packed, 'deepseek-ai-dsh-home-paths-1.0.0.tgz'))

    expect(() => packOfflineDeploy({ cwd, outDir: 'deploy', sources: ['packed'] }))
      .toThrow('packed tarballs missing for: @deepseek-ai/dsh-home-paths (deepseek-ai-dsh-home-paths-1.0.0.tgz)')
    // A partial deployment set would fail on the target machine instead.
    expect(existsSync(join(cwd, 'deploy'))).toBe(false)
  })

  it('refuses a workspace peer dependency that has no tarball instead of leaving it to the registry', () => {
    const { cwd, packed } = repository()
    packAll(packed)
    // Only the peer edge reaches cordis-scope; dropping its tarball must fail
    // the pack rather than ship a set whose npm install pulls the stable release.
    rmSync(join(packed, tarballName('@deepseek-ai/cordis-scope', '0.1.0')))

    expect(() => packOfflineDeploy({ cwd, outDir: 'deploy', sources: ['packed'] }))
      .toThrow(`packed tarballs missing for: @deepseek-ai/cordis-scope (${tarballName('@deepseek-ai/cordis-scope', '0.1.0')})`)
  })

  it('refuses an absent source directory and a run without any source', () => {
    const { cwd, packed } = repository()
    packAll(packed)

    expect(() => packOfflineDeploy({ cwd, outDir: 'deploy', sources: ['nowhere'] }))
      .toThrow(`packed directory not found: ${join(cwd, 'nowhere')}`)
    expect(() => packOfflineDeploy({ cwd, outDir: 'deploy', sources: [] }))
      .toThrow('usage: pack-offline-deploy')
  })

  it('writes every dependency as a relative file: entry pointing at the copied tarball, plus the koffi override and installer', () => {
    const { cwd, packed } = repository()
    packAll(packed)

    const { outDir } = packOfflineDeploy({ cwd, outDir: 'deploy', sources: ['packed'] })

    const manifest = manifestOf(outDir)
    expect(manifest.private).toBe(true)
    expect(manifest.dependencies).toEqual({
      [ENTRY]: `file:tgz/${tarballName(ENTRY, '1.0.0')}`,
      '@deepseek-ai/dsh-app-boot': `file:tgz/${tarballName('@deepseek-ai/dsh-app-boot', '1.0.0')}`,
      '@deepseek-ai/dsh-home-paths': `file:tgz/${tarballName('@deepseek-ai/dsh-home-paths', '1.0.0')}`,
      '@deepseek-ai/cordis-scope': `file:tgz/${tarballName('@deepseek-ai/cordis-scope', '0.1.0')}`,
      '@deepseek-ai/dsh-node-addon-system': `file:tgz/${tarballName('@deepseek-ai/dsh-node-addon-system', '0.1.0')}`,
    })
    // Every file: target exists, so a plain npm install resolves locally.
    for (const [name, reference] of Object.entries(manifest.dependencies)) {
      expect(existsSync(join(outDir, reference.slice('file:'.length))), name).toBe(true)
    }
    expect(manifest.overrides).toEqual({ koffi: KOFFI_OVERRIDE })
    const installer = readFileSync(join(outDir, 'install.sh'), 'utf8')
    expect(installer.startsWith('#!/usr/bin/env sh\n')).toBe(true)
    expect(installer).toContain('npm install --no-audit --no-fund')
  })

  it('globs tarballs from every source directory and replaces a previous deployment set in place', () => {
    const { cwd, packed } = repository()
    packAll(packed)
    // Split the sources: move one tarball into a second packed directory.
    const second = join(cwd, 'packed-native')
    mkdirSync(second)
    const native = tarballName('@deepseek-ai/dsh-node-addon-system', '0.1.0')
    writeFileSync(join(second, native), readFileSync(join(packed, native)))
    rmSync(join(packed, native))
    // A stale artifact from a previous run must not survive the rewrite.
    mkdirSync(join(cwd, 'deploy', 'tgz'), { recursive: true })
    writeFileSync(join(cwd, 'deploy', 'tgz', 'stale.tgz'), 'stale')

    packOfflineDeploy({ cwd, outDir: 'deploy', sources: ['packed', 'packed-native'] })

    expect(readdirSync(join(cwd, 'deploy', 'tgz')).sort()).toEqual([
      tarballName(ENTRY, '1.0.0'),
      tarballName('@deepseek-ai/dsh-app-boot', '1.0.0'),
      tarballName('@deepseek-ai/dsh-home-paths', '1.0.0'),
      tarballName('@deepseek-ai/cordis-scope', '0.1.0'),
      native,
    ].sort())
  })

  it('derives the npm tarball filename by scoping the package name', () => {
    expect(tarballName('@deepseek-ai/dsh', '0.2.1-alpha.2')).toBe('deepseek-ai-dsh-0.2.1-alpha.2.tgz')
    expect(tarballName('koffi', '3.3.2')).toBe('koffi-3.3.2.tgz')
  })
})
