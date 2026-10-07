import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { freezeTrustedExecutable } from '../commands/trusted-executable.js'
import { ManagedRuntimeIndeterminateError } from './installer-contract.js'
import { REAL_RUNTIME_INSTALLER } from './installer.js'
import { captureStableLaunchers, expectedStableLaunchers } from './launchers.js'
import { resolveRuntimePaths } from './paths.js'
import { RuntimeReleaseStore } from './release-store.js'
import { rollbackJournalPath, rollbackPrivateLauncherPath } from './runtime-rollback-journal.js'
import type { RuntimeSelection } from './types.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function freshRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pipeline-rollback-${label}-`))
  roots.push(root)
  return root
}

async function candidateCopy(root: string, suffix: string): Promise<string> {
  const candidate = join(root, `candidate${suffix}`)
  const entries = [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'adapters',
    'hooks',
    'packages/cli/dist/tenon.mjs',
    'packages/dashboard-app/dist',
    'packages/server/dist/dashboard.mjs',
    'runtime/tenon-bootstrap.mjs',
    'skills',
    'templates',
    'tools/verify-skills.sh',
  ]
  for (const entry of entries) {
    await cp(join(repoRoot, entry), join(candidate, entry), { recursive: true, preserveTimestamps: false })
  }
  if (suffix !== '-one') {
    const bootstrap = join(candidate, 'runtime', 'tenon-bootstrap.mjs')
    await writeFile(bootstrap, `${await readFile(bootstrap, 'utf8')}\n// ${suffix}\n`, 'utf8')
  }
  return candidate
}

/** Copying the real payload is the slow part and activation only reads it, so every test shares one pair of candidates. */
let sharedCandidates: Promise<{ readonly root: string; readonly one: string; readonly two: string }> | undefined
function candidatePair() {
  sharedCandidates ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-rollback-candidates-'))
    return { root, one: await candidateCopy(root, '-one'), two: await candidateCopy(root, '-two') }
  })()
  return sharedCandidates
}

afterAll(async () => {
  if (sharedCandidates !== undefined) await rm((await sharedCandidates).root, { recursive: true, force: true })
})

/** Two activations of candidates that differ by one comment: the first ends up as `previous`, the second as `active`. */
async function install(label: string) {
  const root = await freshRoot(label)
  const { one, two } = await candidatePair()
  const home = join(root, 'home')
  const scope = { homeDir: home, env: {} }
  const first = await REAL_RUNTIME_INSTALLER.withManagedTransaction(scope, (transaction) => transaction.activate(one, 'codex'))
  const second = await REAL_RUNTIME_INSTALLER.withManagedTransaction(scope, (transaction) => transaction.activate(two, 'codex'))
  return { root, home, scope, first, second, paths: resolveRuntimePaths({ homeDir: home, env: {} }) }
}

type Install = Awaited<ReturnType<typeof install>>

async function writeJournal(fixture: Install, before: RuntimeSelection, launchers: Awaited<ReturnType<typeof captureStableLaunchers>>) {
  await mkdir(fixture.paths.managedTransactionRoot, { recursive: true })
  await writeFile(rollbackJournalPath(fixture.paths), `${JSON.stringify({
    version: 1,
    transactionId: '44444444-4444-4444-8444-444444444444',
    beforeSelection: before,
    target: {
      revision: before.revision + 1,
      activeRelease: before.previousRelease,
      previousRelease: before.activeRelease,
    },
    launchers,
  }, null, 2)}\n`)
}

const trustedNode = (() => {
  try {
    return freezeTrustedExecutable(process.execPath)
  } catch {
    return undefined
  }
})()

describe('settling a rollback journal that an earlier release left behind', () => {
  // v0.2.1 to v0.3.1: the bootstrap flipped the selection, audited the rollback, refused the installer's launcher and
  // kept runtime-rollback.json, and every later `tenon update` and `tenon setup` refused on that file.
  it('finishes a flipped rollback before setup or update runs, instead of refusing', async () => {
    const fixture = await install('settle-flipped')
    const before = (await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection
    const launchers = await captureStableLaunchers(fixture.paths, fixture.home)
    const committed = await new RuntimeReleaseStore({ paths: fixture.paths }).rollbackToPrevious()
    await writeJournal(fixture, before, launchers)
    const withProof = trustedNode === undefined ? fixture.scope : {
      ...fixture.scope,
      trustedNodePath: trustedNode.executable,
      trustedNodeProof: trustedNode.proof,
      verifyTrustedNode: trustedNode.assert,
    }

    let ran = false
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(withProof, async () => { ran = true })

    expect(ran).toBe(true)
    await expect(readFile(rollbackJournalPath(fixture.paths), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const after = await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)
    expect(after.selection).toEqual(committed.selection)
    expect(after.selection.activeRelease).toBe(fixture.first.release.releaseId)
    expect(after.activeValid).toBe(true)
    const expected = expectedStableLaunchers(fixture.paths, fixture.home, trustedNode?.executable, trustedNode?.proof)
    expect(await captureStableLaunchers(fixture.paths, fixture.home)).toEqual(expected)
  }, 120_000)

  it('discards a journal whose rollback never flipped the selection and leaves the install as it was', async () => {
    const fixture = await install('settle-unflipped')
    const before = (await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection
    const launchers = await captureStableLaunchers(fixture.paths, fixture.home)
    await writeJournal(fixture, before, launchers)

    let ran = false
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(fixture.scope, async () => { ran = true })

    expect(ran).toBe(true)
    await expect(readFile(rollbackJournalPath(fixture.paths), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection).toEqual(before)
    expect(await captureStableLaunchers(fixture.paths, fixture.home)).toEqual(launchers)
  }, 120_000)

  it('keeps refusing when the selection is neither the journal start nor its target', async () => {
    const fixture = await install('settle-foreign')
    const before = (await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection
    const launchers = await captureStableLaunchers(fixture.paths, fixture.home)
    await writeJournal(fixture, { ...before, revision: before.revision - 1 }, launchers)

    let ran = false
    await expect(REAL_RUNTIME_INSTALLER.withManagedTransaction(fixture.scope, async () => { ran = true }))
      .rejects.toBeInstanceOf(ManagedRuntimeIndeterminateError)

    expect(ran).toBe(false)
    await expect(readFile(rollbackJournalPath(fixture.paths), 'utf8')).resolves.toContain('44444444-4444-4444-8444-444444444444')
    expect((await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection).toEqual(before)
  }, 120_000)
})

describe('private launcher copies of an abandoned rollback', () => {
  const TRANSACTION = '44444444-4444-4444-8444-444444444444'

  // `<launcher>.tenon-rollback-<id>.previous` is the copy a bootstrap rollback moves a launcher to while it publishes the target.
  // One install serves every phase: each phase writes its own journal and copies and leaves the launcher pair as it found it.
  it('goes with the journal when it is the recorded checkpoint, and only then', async () => {
    const fixture = await install('private-copies')
    const bin = join(fixture.home, '.local', 'bin')
    const before = (await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection
    const launchers = await captureStableLaunchers(fixture.paths, fixture.home)
    const checkpoint = (name: 'tenon' | 'hook'): { readonly path: string; readonly content: string } => {
      const state = launchers[name].state
      if (state.kind !== 'file') throw new Error('the installer must have written both launchers')
      return { path: launchers[name].path, content: state.content }
    }
    const copyOf = (name: 'tenon' | 'hook', transaction = TRANSACTION): string => rollbackPrivateLauncherPath(checkpoint(name).path, transaction)
    const writeCopy = async (path: string, content: string): Promise<void> => {
      await writeFile(path, content, { mode: 0o755 })
      await chmod(path, 0o755)
    }
    const settle = async (): Promise<void> => {
      await REAL_RUNTIME_INSTALLER.withManagedTransaction(fixture.scope, async () => undefined)
    }
    const journalGone = async (): Promise<void> => {
      await expect(readFile(rollbackJournalPath(fixture.paths), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const privateFiles = async (): Promise<string[]> => (await readdir(bin)).filter((name) => name.includes('.tenon-rollback-')).sort()

    // 1. Both copies are byte-for-byte the checkpoint: both are dropped, the launchers stay.
    await writeJournal(fixture, before, launchers)
    await writeCopy(copyOf('tenon'), checkpoint('tenon').content)
    await writeCopy(copyOf('hook'), checkpoint('hook').content)
    await settle()
    await journalGone()
    expect(await privateFiles()).toEqual([])
    expect(await captureStableLaunchers(fixture.paths, fixture.home)).toEqual(launchers)

    // 2. A copy with other bytes, a copy of another transaction and a copy with another mode are not the checkpoint: they stay.
    const other = '55555555-5555-4555-8555-555555555555'
    await writeJournal(fixture, before, launchers)
    await writeCopy(copyOf('tenon'), `${checkpoint('tenon').content}# somebody's edit\n`)
    await writeCopy(copyOf('hook', other), checkpoint('hook').content)
    await writeFile(copyOf('hook'), checkpoint('hook').content, { mode: 0o600 })
    await chmod(copyOf('hook'), 0o600)
    await settle()
    await journalGone()
    expect(await privateFiles()).toEqual([copyOf('hook'), copyOf('hook', other), copyOf('tenon')].map((path) => path.slice(bin.length + 1)).sort())
    expect(await readFile(copyOf('tenon'), 'utf8')).toContain("somebody's edit")
    for (const path of [copyOf('tenon'), copyOf('hook'), copyOf('hook', other)]) await rm(path)

    // 3. The rollback had taken the launcher aside and never wrote the target: the copy is the only original left, so it goes back
    // to the launcher path before it is dropped.
    await writeJournal(fixture, before, launchers)
    await rm(checkpoint('tenon').path)
    await writeCopy(copyOf('tenon'), checkpoint('tenon').content)
    await settle()
    await journalGone()
    expect(await privateFiles()).toEqual([])
    expect(await captureStableLaunchers(fixture.paths, fixture.home)).toEqual(launchers)
    expect((await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection).toEqual(before)
  }, 120_000)
})

describe('explicit rollback ordering', () => {
  it('refuses a launcher it cannot prove before the selection flips and removes the journal', async () => {
    const fixture = await install('rollback-third-party')
    const before = (await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection
    const launchers = await captureStableLaunchers(fixture.paths, fixture.home)
    // An earlier attempt wrote the journal, then somebody replaced the launcher before the flip.
    await writeJournal(fixture, before, launchers)
    const bin = join(fixture.home, '.local', 'bin')
    const thirdParty = '#!/bin/sh\n# a wrapper somebody else owns\n'
    await writeFile(join(bin, 'tenon'), thirdParty, { mode: 0o755 })

    await expect(REAL_RUNTIME_INSTALLER.rollback(fixture.scope)).rejects.toThrow(/cannot prove/u)

    expect((await REAL_RUNTIME_INSTALLER.inspect(fixture.scope)).selection).toEqual(before)
    await expect(readFile(rollbackJournalPath(fixture.paths), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(bin, 'tenon'), 'utf8')).toBe(thirdParty)
    expect((await readdir(bin)).filter((name) => name.includes('.tenon-'))).toEqual([])

    // Not wedged: the next setup or update takes the transaction.
    let ran = false
    await REAL_RUNTIME_INSTALLER.withManagedTransaction(fixture.scope, async () => { ran = true })
    expect(ran).toBe(true)
  }, 120_000)
})
