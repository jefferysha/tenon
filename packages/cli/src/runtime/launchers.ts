import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { serializeProductRootContract } from '@tenon/kernel'
import { nodeIdentityGuard } from './stable-launcher-node-guard.js'
import type {
  RuntimeLauncherFileSnapshot,
  RuntimeLauncherSnapshot,
  RuntimePaths,
  TrustedExecutableProof,
} from './types.js'
export interface StableLauncherPaths {
  readonly tenon: string
  readonly hook: string
}
export interface StableLauncherWriteOptions {
  readonly checkpoint?: RuntimeLauncherSnapshot
  readonly nodeExecutable?: string
  readonly nodeProof?: TrustedExecutableProof
  /** Frozen physical Node proof replayed immediately before each public launcher publication. */
  readonly verifyNode?: () => void
  /** Test-only race hook: runs after pair proof and before the public path is atomically captured. */
  readonly beforeReplace?: (path: string) => Promise<void>
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
function launcherText(
  paths: RuntimePaths,
  mode: 'cli' | 'hook',
  nodeExecutable: string,
  nodeProof?: TrustedExecutableProof,
): string {
  const bootstrap = join(paths.bootstrapRoot, 'active.mjs')
  const rootContract = serializeProductRootContract(paths)
  const missing = mode === 'hook'
    ? 'exit 0'
    : 'printf "tenon runtime bootstrap unavailable; run tenon setup --codex or tenon setup --claude\\n" >&2\n  exit 1'
  return `#!/bin/sh
set -eu
export TENON_RUNTIME_ROOTS=${shellQuote(rootContract)}
# N-1 bootstrap ABI: previous verified releases read these exact roots during rollback.
export TENON_RUNTIME_DATA_ROOT=${shellQuote(paths.dataRoot)}
export TENON_RUNTIME_STATE_ROOT=${shellQuote(paths.stateRoot)}
export TENON_RUNTIME_CONFIG_ROOT=${shellQuote(paths.configRoot)}
export TENON_NODE_PATH=${shellQuote(nodeExecutable)}
[ -f ${shellQuote(bootstrap)} ] || { ${missing}; }
${nodeIdentityGuard(nodeProof)}
exec ${shellQuote(nodeExecutable)} ${shellQuote(bootstrap)} ${mode} "$@"
`
}
/** Exact public v1.0.1 launcher bytes; compare-only compatibility, never execute through PATH. */
function legacyLauncherTextV101(paths: RuntimePaths, mode: 'cli' | 'hook'): string {
  const bootstrap = join(paths.bootstrapRoot, 'active.mjs')
  const rootContract = serializeProductRootContract(paths)
  const missing = mode === 'hook'
    ? 'exit 0'
    : 'printf "tenon runtime bootstrap unavailable; run tenon setup --codex or tenon setup --claude\\n" >&2\n  exit 1'
  return `#!/usr/bin/env bash
set -eu
export TENON_RUNTIME_ROOTS=${shellQuote(rootContract)}
# N-1 bootstrap ABI: previous verified releases read these exact roots during rollback.
export TENON_RUNTIME_DATA_ROOT=${shellQuote(paths.dataRoot)}
export TENON_RUNTIME_STATE_ROOT=${shellQuote(paths.stateRoot)}
export TENON_RUNTIME_CONFIG_ROOT=${shellQuote(paths.configRoot)}
[ -f ${shellQuote(bootstrap)} ] || { ${missing}; }
exec node ${shellQuote(bootstrap)} ${mode} "$@"
`
}
export function stableLauncherPaths(homeDir: string): StableLauncherPaths {
  const binDir = join(homeDir, '.local', 'bin')
  return {
    tenon: join(binDir, 'tenon'),
    hook: join(binDir, 'tenon-hook'),
  }
}
async function captureLauncher(path: string): Promise<RuntimeLauncherFileSnapshot> {
  try {
    const item = await lstat(path)
    if (item.isSymbolicLink() || !item.isFile()) {
      throw new Error(`launcher 不是可安全替换的普通文件: ${path}`)
    }
    return {
      path,
      state: {
        kind: 'file',
        content: await readFile(path, 'utf8'),
        mode: item.mode & 0o777,
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, state: { kind: 'missing' } }
    throw error
  }
}
/** Capture the exact user-owned state before any activation writes a stable launcher. */
export async function captureStableLaunchers(
  _paths: RuntimePaths,
  homeDir = homedir(),
): Promise<RuntimeLauncherSnapshot> {
  const paths = stableLauncherPaths(homeDir)
  const [tenon, hook] = await Promise.all([
    captureLauncher(paths.tenon),
    captureLauncher(paths.hook),
  ])
  return { tenon, hook }
}
/** Compute the exact launcher bytes/mode this release is allowed to own after commit. */
export function expectedStableLaunchers(
  paths: RuntimePaths,
  homeDir = homedir(),
  nodeExecutable = process.execPath,
  nodeProof?: TrustedExecutableProof,
): RuntimeLauncherSnapshot {
  const stable = stableLauncherPaths(homeDir)
  return {
    tenon: {
      path: stable.tenon,
      state: { kind: 'file', content: launcherText(paths, 'cli', nodeExecutable, nodeProof), mode: 0o755 },
    },
    hook: {
      path: stable.hook,
      state: { kind: 'file', content: launcherText(paths, 'hook', nodeExecutable, nodeProof), mode: 0o755 },
    },
  }
}
export function expectedLegacyStableLaunchersV101(
  paths: RuntimePaths,
  homeDir = homedir(),
): RuntimeLauncherSnapshot {
  const stable = stableLauncherPaths(homeDir)
  return {
    tenon: {
      path: stable.tenon,
      state: { kind: 'file', content: legacyLauncherTextV101(paths, 'cli'), mode: 0o755 },
    },
    hook: {
      path: stable.hook,
      state: { kind: 'file', content: legacyLauncherTextV101(paths, 'hook'), mode: 0o755 },
    },
  }
}
function sameLauncherState(
  left: RuntimeLauncherFileSnapshot['state'],
  right: RuntimeLauncherFileSnapshot['state'],
  compareMode = true,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'missing' || right.kind === 'missing') return true
  return left.content === right.content && (!compareMode || left.mode === right.mode)
}

function sameLauncherFile(
  left: RuntimeLauncherFileSnapshot,
  right: RuntimeLauncherFileSnapshot,
  compareMode = true,
): boolean {
  return left.path === right.path && sameLauncherState(left.state, right.state, compareMode)
}
/**
 * Prove a crash-interrupted launcher publication belongs solely to this installer transaction.
 * Each file must still be either its exact checkpoint state or the committed content. Committed
 * content may retain an intermediate mode because atomic content publication precedes chmod.
 */
export function installerOwnedStableLauncherTransition(
  current: RuntimeLauncherSnapshot,
  checkpoint: RuntimeLauncherSnapshot,
  committed: RuntimeLauncherSnapshot,
): boolean {
  return (['tenon', 'hook'] as const).every((name) => {
    const value = current[name]
    const before = checkpoint[name]
    const expected = committed[name]
    return sameLauncherFile(value, before) || sameLauncherFile(value, expected, false)
  })
}

function launcherStateAllowed(
  value: RuntimeLauncherFileSnapshot['state'],
  checkpoint: RuntimeLauncherFileSnapshot['state'],
  committed: RuntimeLauncherFileSnapshot['state'],
): boolean {
  return sameLauncherState(value, checkpoint)
    || sameLauncherState(value, committed, false)
}

function transitionMarker(
  target: RuntimeLauncherFileSnapshot,
  checkpoint: RuntimeLauncherFileSnapshot,
  committed: RuntimeLauncherFileSnapshot,
): string {
  return `${JSON.stringify({ version: 1, target, checkpoint, committed })}\n`
}

async function installerOwnedCapturedLauncherTransition(
  current: RuntimeLauncherFileSnapshot,
  target: RuntimeLauncherFileSnapshot,
  checkpoint: RuntimeLauncherFileSnapshot,
  committed: RuntimeLauncherFileSnapshot,
): Promise<boolean> {
  if (current.path !== target.path
    || target.path !== checkpoint.path
    || target.path !== committed.path
    || current.state.kind !== 'missing') return false

  const owner = `${target.path}.tenon-transition-owner`
  const root = `${target.path}.tenon-transition-v1`
  try {
    const [ownerItem, rootItem, ownerMarker] = await Promise.all([
      lstat(owner),
      lstat(root),
      readFile(owner, 'utf8'),
    ])
    if (!ownerItem.isFile() || ownerItem.isSymbolicLink()
      || !rootItem.isDirectory() || rootItem.isSymbolicLink()
      || ownerMarker !== transitionMarker(target, checkpoint, committed)) return false

    const previous = await captureLauncher(join(root, 'previous'))
    return previous.state.kind === 'file'
      && launcherStateAllowed(previous.state, checkpoint.state, committed.state)
  } catch {
    return false
  }
}

async function claimTransition(
  target: RuntimeLauncherFileSnapshot,
  checkpoint: RuntimeLauncherFileSnapshot,
  committed: RuntimeLauncherFileSnapshot,
): Promise<{ readonly owner: string; readonly root: string }> {
  const owner = `${target.path}.tenon-transition-owner`
  const root = `${target.path}.tenon-transition-v1`
  const marker = transitionMarker(target, checkpoint, committed)
  try {
    await writeFile(owner, marker, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || await readFile(owner, 'utf8').catch(() => '') !== marker) {
      throw new Error(`launcher transition owner 不可证明: ${target.path}`)
    }
  }
  try {
    await mkdir(root, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const item = await lstat(root).catch(() => null)
    if (item === null || !item.isDirectory() || item.isSymbolicLink()) {
      throw new Error(`launcher transition root 不可证明: ${target.path}`)
    }
  }
  return { owner, root }
}

async function cleanupTransition(owner: string, root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await rm(owner, { force: true })
}

/**
 * Finish the cleanup half of a publication that already linked the exact target into place.
 * An unrelated owner marker is deliberately left alone. Once the marker matches this exact
 * transition, every remaining private byte and the hard-link identity must still be provable;
 * otherwise cleanup fails closed instead of erasing evidence that compensation may need.
 */
async function cleanupCommittedTransition(
  target: RuntimeLauncherFileSnapshot,
  checkpoint: RuntimeLauncherFileSnapshot,
  committed: RuntimeLauncherFileSnapshot,
): Promise<boolean> {
  const owner = `${target.path}.tenon-transition-owner`
  const root = `${target.path}.tenon-transition-v1`
  const marker = await readFile(owner, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (marker === null || marker !== transitionMarker(target, checkpoint, committed)) return false

  const rootItem = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  // cleanupTransition removes the private root before the owner marker. A crash in that narrow
  // gap is already fully committed, so only the exact matching marker remains to retire.
  if (rootItem === null) {
    await rm(owner)
    return true
  }
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink()) {
    throw new Error(`launcher committed transition root 不可证明: ${target.path}`)
  }

  const previous = await captureLauncher(join(root, 'previous'))
  const previousMissing = await readFile(join(root, 'previous-missing'), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  const previousProven = previous.state.kind === 'file'
    ? launcherStateAllowed(previous.state, checkpoint.state, committed.state)
    : previousMissing === 'missing\n'
  if (!previousProven) {
    throw new Error(`launcher committed transition previous state 不可证明: ${target.path}`)
  }

  const stagedPath = join(root, 'next')
  const staged = await captureLauncher(stagedPath)
  if (!sameLauncherState(staged.state, target.state)) {
    throw new Error(`launcher committed transition staged state 不可证明: ${target.path}`)
  }
  const [publicItem, stagedItem] = await Promise.all([lstat(target.path), lstat(stagedPath)])
  if (!publicItem.isFile() || publicItem.isSymbolicLink()
    || !stagedItem.isFile() || stagedItem.isSymbolicLink()
    || publicItem.dev !== stagedItem.dev || publicItem.ino !== stagedItem.ino) {
    throw new Error(`launcher committed transition hard-link identity 不可证明: ${target.path}`)
  }
  await cleanupTransition(owner, root)
  return true
}

async function captureTransitionInput(
  target: RuntimeLauncherFileSnapshot,
  checkpoint: RuntimeLauncherFileSnapshot,
  committed: RuntimeLauncherFileSnapshot,
  root: string,
): Promise<void> {
  const previous = join(root, 'previous')
  const missing = join(root, 'previous-missing')
  const previousState = await captureLauncher(previous)
  if (previousState.state.kind !== 'missing') {
    if (!launcherStateAllowed(previousState.state, checkpoint.state, committed.state)) {
      throw new Error(`stable launcher transition captured third-party bytes: ${target.path}`)
    }
    return
  }
  try {
    if ((await readFile(missing, 'utf8')) === 'missing\n') return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const current = await captureLauncher(target.path)
  if (current.state.kind === 'missing') {
    if (!launcherStateAllowed(current.state, checkpoint.state, committed.state)) {
      throw new Error(`stable launcher transition contains an unowned missing state: ${target.path}`)
    }
    await writeFile(missing, 'missing\n', { flag: 'wx', mode: 0o600 })
    return
  }
  await rename(target.path, previous)
  const captured = await captureLauncher(previous)
  if (launcherStateAllowed(captured.state, checkpoint.state, committed.state)) return
  const publicState = await captureLauncher(target.path)
  if (publicState.state.kind === 'missing') {
    await link(previous, target.path)
  }
  throw new Error(`stable launcher transition captured third-party bytes: ${target.path}`)
}

async function replaceLauncherNoOverwrite(
  target: RuntimeLauncherFileSnapshot,
  checkpoint: RuntimeLauncherFileSnapshot,
  committed: RuntimeLauncherFileSnapshot,
): Promise<void> {
  await mkdir(dirname(target.path), { recursive: true })
  // Stable launcher bytes are release-independent. An idempotent setup or explicit rollback often
  // already has the exact hardened target; returning here avoids creating a needless capture gap
  // after the selection has committed.
  const existing = await captureLauncher(target.path)
  if (sameLauncherState(existing.state, target.state)) {
    await cleanupCommittedTransition(target, checkpoint, committed)
    return
  }
  const transition = await claimTransition(target, checkpoint, committed)
  const previous = join(transition.root, 'previous')
  try {
    await captureTransitionInput(target, checkpoint, committed, transition.root)
    const current = await captureLauncher(target.path)
    if (sameLauncherState(current.state, target.state)) {
      await cleanupTransition(transition.owner, transition.root)
      return
    }
    if (current.state.kind !== 'missing') {
      throw new Error(`launcher 在证明后被外部修改，拒绝覆盖: ${target.path}`)
    }
    if (target.state.kind === 'missing') {
      await cleanupTransition(transition.owner, transition.root)
      return
    }
    const staged = join(transition.root, 'next')
    try {
      await writeFile(staged, target.state.content, { flag: 'wx', mode: target.state.mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || await readFile(staged, 'utf8').catch(() => '') !== target.state.content) throw error
    }
    await chmod(staged, target.state.mode)
    await link(staged, target.path)
    const published = await captureLauncher(target.path)
    if (!sameLauncherState(published.state, target.state)) {
      throw new Error(`stable launcher no-replace publication 未收敛: ${target.path}`)
    }
    await cleanupTransition(transition.owner, transition.root)
  } catch (error) {
    const publicState = await captureLauncher(target.path).catch(() => null)
    if (publicState?.state.kind === 'missing') {
      const captured = await captureLauncher(previous).catch(() => null)
      if (captured !== null && captured.state.kind === 'file') {
        await link(previous, target.path).catch(() => {})
      }
      await cleanupTransition(transition.owner, transition.root).catch(() => {})
    }
    throw error
  }
}

/** Finish only a byte-proven old/new partial pair after selection has already committed. */
export async function convergeStableLaunchers(
  paths: RuntimePaths,
  checkpoint: RuntimeLauncherSnapshot,
  homeDir = homedir(),
  options: Pick<StableLauncherWriteOptions, 'nodeExecutable' | 'nodeProof' | 'verifyNode'> = {},
): Promise<RuntimeLauncherSnapshot> {
  options.verifyNode?.()
  const committed = expectedStableLaunchers(paths, homeDir, options.nodeExecutable, options.nodeProof)
  await writeStableLaunchers(paths, homeDir, { checkpoint, ...options })
  const converged = await captureStableLaunchers(paths, homeDir)
  if (!sameLauncherFile(converged.tenon, committed.tenon)
    || !sameLauncherFile(converged.hook, committed.hook)) {
    throw new Error('stable launcher pair did not converge to the committed state')
  }
  return converged
}

/** Restore both launchers to their exact pre-activation existence, bytes, and mode. */
export async function restoreStableLaunchers(
  snapshot: RuntimeLauncherSnapshot,
  committed?: RuntimeLauncherSnapshot,
): Promise<void> {
  const current = await Promise.all([
    captureLauncher(snapshot.tenon.path),
    captureLauncher(snapshot.hook.path),
  ])
  for (const [index, value] of current.entries()) {
    const before = index === 0 ? snapshot.tenon : snapshot.hook
    const owned = index === 0 ? committed?.tenon : committed?.hook
    if (!sameLauncherState(value.state, before.state)
      && (owned === undefined || !sameLauncherState(value.state, owned.state, false))
      && !await installerOwnedCapturedLauncherTransition(
        value,
        before,
        before,
        owned ?? before,
      )) {
      throw new Error(`launcher 在 activation 后被外部修改，拒绝覆盖: ${value.path}`)
    }
  }
  const allowed = committed ?? snapshot
  await replaceLauncherNoOverwrite(snapshot.tenon, snapshot.tenon, allowed.tenon)
  await replaceLauncherNoOverwrite(snapshot.hook, snapshot.hook, allowed.hook)
}

/** Write stable user-level launchers only after a managed release has been verified and activated. */
export async function writeStableLaunchers(
  paths: RuntimePaths,
  homeDir = homedir(),
  options: StableLauncherWriteOptions = {},
): Promise<StableLauncherPaths> {
  const { tenon, hook } = stableLauncherPaths(homeDir)
  const binDir = join(homeDir, '.local', 'bin')
  await mkdir(binDir, { recursive: true })
  options.verifyNode?.()
  const expected = expectedStableLaunchers(paths, homeDir, options.nodeExecutable, options.nodeProof)
  const checkpoint = options.checkpoint ?? {
    tenon: { path: tenon, state: { kind: 'missing' as const } },
    hook: { path: hook, state: { kind: 'missing' as const } },
  }
  const current = await captureStableLaunchers(paths, homeDir)
  const pairOwned = installerOwnedStableLauncherTransition(current, checkpoint, expected)
    || await Promise.all((['tenon', 'hook'] as const).map(async (name) => {
      const value = current[name]
      return sameLauncherFile(value, checkpoint[name])
        || sameLauncherFile(value, expected[name], false)
        || installerOwnedCapturedLauncherTransition(
          value,
          expected[name],
          checkpoint[name],
          expected[name],
        )
    })).then((proofs) => proofs.every(Boolean))
  if (!pairOwned) {
    throw new Error('stable launcher pair contains a third-party byte or path state')
  }
  options.verifyNode?.()
  await options.beforeReplace?.(tenon)
  await replaceLauncherNoOverwrite(expected.tenon, checkpoint.tenon, expected.tenon)
  options.verifyNode?.()
  await options.beforeReplace?.(hook)
  await replaceLauncherNoOverwrite(expected.hook, checkpoint.hook, expected.hook)
  return { tenon, hook }
}
