import { realpathSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { serializeProductRootContract, withLock } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import {
  captureStableLaunchers,
  expectedStableLaunchers,
  writeStableLaunchers,
} from '../runtime/launchers.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import {
  classifyStableLauncherPair,
  readStableLauncherPair,
  type LauncherFile,
  type ManagedLauncher,
} from '../runtime/stable-launcher-format.js'
import type { RuntimePaths } from '../runtime/types.js'
import { freezeTrustedExecutable, type TrustedExecutable } from './trusted-executable.js'

/**
 * v0.2.0 launchers pin a device number that macOS changes at every restart. `tenon update` run by that
 * release rewrites them in the same format, so the release that is active afterwards repairs them itself:
 * the bootstrap notices a legacy launcher and runs this once. The repair only happens when it is provably
 * the same install: same roots, the Node that is running now, and the digest the launcher pinned.
 */

/** Written by the bootstrap before it starts a repair and removed on success; a fresh marker backs off retries. */
export const LAUNCHER_HEAL_RETRY_MARKER = 'launcher-heal.retry'
const LOCK_DIR_NAME = '.pipeline.lock'

export type LauncherHealOutcome =
  | { readonly outcome: 'repaired' | 'current' }
  | { readonly outcome: 'skipped'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly detail: string }

export interface LauncherHealInput {
  readonly paths: RuntimePaths
  readonly homeDir: string
  /** The Node executing this process (`process.execPath`). */
  readonly runningNode: string
  readonly freezeNode: (path: string) => TrustedExecutable | undefined
}

type Pair = { readonly tenon: LauncherFile; readonly hook: LauncherFile }
type Assessment =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'heal'; readonly trusted: TrustedExecutable }

function managedPair(pair: Pair): readonly ManagedLauncher[] | undefined {
  if (pair.tenon.kind !== 'managed' || pair.hook.kind !== 'managed') return undefined
  return [pair.tenon.launcher, pair.hook.launcher]
}

function assess(pair: Pair, input: LauncherHealInput): Assessment {
  const launchers = managedPair(pair)
  if (launchers === undefined) return { kind: 'skip', reason: 'launchers-not-tenon-generated' }
  const [first, second] = launchers
  if (first === undefined || second === undefined
    || first.nodePath !== second.nodePath || first.rootContract !== second.rootContract) {
    return { kind: 'skip', reason: 'launchers-disagree' }
  }
  const digests = new Set(launchers.filter((launcher) => launcher.legacy).map((launcher) => launcher.digest))
  const [digest] = [...digests]
  if (digests.size !== 1 || digest === undefined) return { kind: 'skip', reason: 'pinned-digest-unreadable' }
  if (first.rootContract !== serializeProductRootContract(input.paths)) return { kind: 'skip', reason: 'roots-differ' }
  let running: string
  try {
    running = realpathSync(input.runningNode)
  } catch {
    return { kind: 'skip', reason: 'running-node-unresolvable' }
  }
  if (running !== first.nodePath) return { kind: 'skip', reason: 'node-path-differs' }
  const trusted = input.freezeNode(first.nodePath)
  if (trusted === undefined) return { kind: 'skip', reason: 'node-untrusted' }
  if (trusted.executable !== first.nodePath) return { kind: 'skip', reason: 'node-path-differs' }
  if (trusted.proof.sha256 !== digest) return { kind: 'skip', reason: 'node-digest-differs' }
  return { kind: 'heal', trusted }
}

/** An install transaction owns the launchers while its lock or a journal exists; leave them to it. */
async function transactionBusy(paths: RuntimePaths): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(paths.managedTransactionRoot)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'install-state-unreadable'
  }
  if (entries.includes(LOCK_DIR_NAME)) return 'install-in-progress'
  return entries.some((name) => !name.startsWith(LOCK_DIR_NAME)) ? 'install-journal-pending' : undefined
}

export async function healLegacyStableLaunchers(input: LauncherHealInput): Promise<LauncherHealOutcome> {
  const { paths, homeDir } = input
  const initial = await readStableLauncherPair(homeDir)
  if (classifyStableLauncherPair(initial) !== 'legacy') return { outcome: 'current' }
  const first = assess(initial, input)
  if (first.kind === 'skip') return { outcome: 'skipped', reason: first.reason }
  const busy = await transactionBusy(paths)
  if (busy !== undefined) return { outcome: 'skipped', reason: busy }

  try {
    await mkdir(paths.managedTransactionRoot, { recursive: true })
    return await withLock(paths.managedTransactionRoot, async (): Promise<LauncherHealOutcome> => {
      const pending = await transactionBusy(paths)
      if (pending !== undefined && pending !== 'install-in-progress') return { outcome: 'skipped', reason: pending }
      const pair = await readStableLauncherPair(homeDir)
      if (classifyStableLauncherPair(pair) !== 'legacy') return { outcome: 'current' }
      const verdict = assess(pair, input)
      if (verdict.kind === 'skip') return { outcome: 'skipped', reason: verdict.reason }
      const { trusted } = verdict
      const checkpoint = await captureStableLaunchers(paths, homeDir)
      await writeStableLaunchers(paths, homeDir, {
        checkpoint,
        nodeExecutable: trusted.executable,
        nodeProof: trusted.proof,
        verifyNode: trusted.assert,
      })
      const written = await captureStableLaunchers(paths, homeDir)
      const expected = expectedStableLaunchers(paths, homeDir, trusted.executable, trusted.proof)
      return JSON.stringify(written) === JSON.stringify(expected)
        ? { outcome: 'repaired' }
        : { outcome: 'failed', detail: 'stable launchers did not converge to the restart-safe format' }
    })
  } catch (error) {
    // A concurrent repair may have won the race; its result is the outcome we wanted.
    const after = await readStableLauncherPair(homeDir).catch(() => undefined)
    if (after !== undefined && classifyStableLauncherPair(after) === 'current') return { outcome: 'current' }
    return { outcome: 'failed', detail: errMsg(error) }
  }
}

export interface LauncherHealEnv {
  homeDir(): string
  runtimeEnv(): NodeJS.ProcessEnv
  runningNode(): string
  freezeNode(path: string): TrustedExecutable | undefined
}

export const REAL_LAUNCHER_HEAL_ENV: LauncherHealEnv = {
  homeDir: () => homedir(),
  runtimeEnv: () => ({ ...process.env }),
  runningNode: () => process.execPath,
  freezeNode: (path) => freezeTrustedExecutable(path),
}

/** Hidden `internal-launcher-heal`: one JSON line for the bootstrap that started it; the exit code stays 0. */
export async function cmdInternalLauncherHeal(
  deps: CliDeps,
  env: LauncherHealEnv = REAL_LAUNCHER_HEAL_ENV,
): Promise<number> {
  const homeDir = env.homeDir()
  let outcome: LauncherHealOutcome
  let paths: RuntimePaths | undefined
  try {
    paths = resolveRuntimePaths({ homeDir, env: env.runtimeEnv() })
    outcome = await healLegacyStableLaunchers({
      paths,
      homeDir,
      runningNode: env.runningNode(),
      freezeNode: env.freezeNode,
    })
  } catch (error) {
    outcome = { outcome: 'failed', detail: errMsg(error) }
  }
  if (paths !== undefined && (outcome.outcome === 'repaired' || outcome.outcome === 'current')) {
    await rm(join(paths.stateRoot, LAUNCHER_HEAL_RETRY_MARKER), { force: true }).catch(() => {})
  }
  deps.io.out(JSON.stringify(outcome))
  return 0
}
