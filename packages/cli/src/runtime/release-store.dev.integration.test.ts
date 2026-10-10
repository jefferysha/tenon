import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TENON_RELEASE_VERSION } from '../commands/plugin-host.js'
import { resolveRuntimePaths } from './paths.js'
import { parseManifest, readReleaseManifest } from './release-store-codecs.js'
import { RuntimeReleaseStore } from './release-store.js'
import type { RuntimeDevSource } from './types.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'a'.repeat(40), dirty: true,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}

async function candidate(): Promise<{ root: string; candidate: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-dev-store-'))
  roots.push(root)
  const target = join(root, 'candidate')
  for (const entry of [
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json', 'adapters', 'hooks', 'packages/cli/dist/tenon.mjs',
    'packages/dashboard-app/dist', 'packages/server/dist/dashboard.mjs', 'runtime/tenon-bootstrap.mjs',
    'skills', 'templates', 'tools/verify-skills.sh',
  ]) await cp(join(repoRoot, entry), join(target, entry), { recursive: true, preserveTimestamps: false })
  return { root, candidate: target }
}

function storeFor(root: string): RuntimeReleaseStore {
  return new RuntimeReleaseStore({
    paths: resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: root, platform: 'linux' }),
    now: () => '2026-10-07T00:00:00Z',
    retainedReleases: 3,
  })
}

describe('RuntimeReleaseStore development releases', () => {
  it('publishes a development release whose manifest carries devSource and a distinct release id', async () => {
    const { root, candidate: payload } = await candidate()
    const store = storeFor(root)
    const stable = await store.stageAndActivate(payload, 'claude', TENON_RELEASE_VERSION)
    const dev = await store.stageAndActivate(payload, 'claude', TENON_RELEASE_VERSION, undefined, DEV)
    expect(dev.release.releaseId).not.toBe(stable.release.releaseId)
    expect(dev.release).toMatchObject({ version: 2, devSource: DEV })
    expect(dev.release).not.toHaveProperty('stableTarget')
    expect(await readReleaseManifest(dev.releaseRoot)).toMatchObject({ devSource: DEV })
    expect(dev.selection.previousRelease).toBe(stable.release.releaseId)
    const inspected = await store.inspect()
    expect(inspected.activeValid).toBe(true)
    expect(inspected.active).toMatchObject({ devSource: DEV })
  })

  it('refuses a development source together with a stable target', async () => {
    const { root, candidate: payload } = await candidate()
    await expect(storeFor(root).stageAndActivate(
      payload, 'claude', TENON_RELEASE_VERSION,
      { version: TENON_RELEASE_VERSION, tag: `v${TENON_RELEASE_VERSION}`, commit: 'd'.repeat(40) },
      DEV,
    )).rejects.toThrow('互斥')
  })

  it('refuses a development source for an adapter host', async () => {
    const { root, candidate: payload } = await candidate()
    await expect(storeFor(root).stageAndActivate(payload, 'adapter', TENON_RELEASE_VERSION, undefined, DEV))
      .rejects.toThrow('原生宿主')
  })

  it('stored manifests of earlier development releases stay parseable', async () => {
    const { root, candidate: payload } = await candidate()
    const dev = await storeFor(root).stageAndActivate(payload, 'codex', TENON_RELEASE_VERSION, undefined, DEV)
    expect(parseManifest(JSON.stringify(dev.release))).toMatchObject({ devSource: DEV })
  })
})
