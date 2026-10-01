import { lstat, readFile } from 'node:fs/promises'
import { launcherPaths } from './launchers.js'

/**
 * Recognises the launchers Tenon itself writes (`~/.local/bin/tenon` and `tenon-hook`) and tells the
 * restart-safe format from the v0.2.0 one, whose Node check pins a device number (st_dev). macOS gives
 * the same volume a new device number at every restart, so that format locks the user out after one.
 * Everything else, a symlink or a script somebody else wrote, is reported as unmanaged and left alone.
 */

const HEAD = '#!/bin/sh\nset -eu\nexport TENON_RUNTIME_ROOTS='
const MAX_LAUNCHER_BYTES = 256 * 1024
const QUOTED = String.raw`'(?:[^']|'"'"')*'`
const ROOTS_LINE = new RegExp(`^export TENON_RUNTIME_ROOTS=(${QUOTED})$`, 'u')
const NODE_LINE = new RegExp(`^export TENON_NODE_PATH=(${QUOTED})$`, 'u')
const EXEC_LINE = new RegExp(`^exec (${QUOTED}) (${QUOTED}) (cli|hook) "\\$@"$`, 'u')
/** Every v0.2.0 stat format starts its fields with the device number: `-f '%d:...'` or `-c '%d:...'`. */
const DEVICE_PIN = /-[fc] '%d:/u
const DIGEST_PIN = /\[ "\$tenon_node_digest" = '([0-9a-f]{64})' \]/u

export interface ManagedLauncher {
  readonly mode: 'cli' | 'hook'
  /** The serialized root contract the launcher exports (unquoted). */
  readonly rootContract: string
  /** The Node the launcher execs and, in the legacy format, pins. */
  readonly nodePath: string
  /** True when the persisted Node check includes a device number. */
  readonly legacy: boolean
  /** SHA-256 of the pinned Node, present in the legacy format. */
  readonly digest: string | undefined
}

export type LauncherFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unmanaged' }
  | { readonly kind: 'managed'; readonly launcher: ManagedLauncher }

export type StableLauncherFormat = 'current' | 'legacy' | 'absent' | 'unmanaged'

function unquote(token: string): string {
  return token.slice(1, -1).replaceAll(`'"'"'`, "'")
}

export function parseManagedLauncher(text: string): ManagedLauncher | undefined {
  if (!text.startsWith(HEAD)) return undefined
  const lines = text.split('\n')
  const roots = ROOTS_LINE.exec(lines[2] ?? '')
  const node = lines.map((line) => NODE_LINE.exec(line)).find((match) => match !== null)
  const exec = EXEC_LINE.exec(lines.filter((line) => line !== '').at(-1) ?? '')
  const rootsToken = roots?.[1]
  const nodeToken = node?.[1]
  const execNodeToken = exec?.[1]
  const modeToken = exec?.[3]
  if (rootsToken === undefined || nodeToken === undefined || execNodeToken === undefined) return undefined
  if (modeToken !== 'cli' && modeToken !== 'hook') return undefined
  const nodePath = unquote(nodeToken)
  if (unquote(execNodeToken) !== nodePath) return undefined
  return {
    mode: modeToken,
    rootContract: unquote(rootsToken),
    nodePath,
    legacy: DEVICE_PIN.test(text),
    digest: DIGEST_PIN.exec(text)?.[1],
  }
}

/** Read one launcher without following links; anything that is not a small regular Tenon launcher is unmanaged. */
export async function readLauncherFile(path: string): Promise<LauncherFile> {
  let item
  try {
    item = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unmanaged' }
  }
  if (item.isSymbolicLink() || !item.isFile() || item.size > MAX_LAUNCHER_BYTES) return { kind: 'unmanaged' }
  try {
    const launcher = parseManagedLauncher(await readFile(path, 'utf8'))
    return launcher === undefined ? { kind: 'unmanaged' } : { kind: 'managed', launcher }
  } catch {
    return { kind: 'unmanaged' }
  }
}

export async function readStableLauncherPair(
  homeDir: string,
): Promise<{ readonly tenon: LauncherFile; readonly hook: LauncherFile }> {
  const paths = launcherPaths(homeDir)
  const [tenon, hook] = await Promise.all([readLauncherFile(paths.tenon), readLauncherFile(paths.hook)])
  return { tenon, hook }
}

export function classifyStableLauncherPair(pair: { readonly tenon: LauncherFile; readonly hook: LauncherFile }): StableLauncherFormat {
  const files = [pair.tenon, pair.hook]
  if (files.some((file) => file.kind === 'managed' && file.launcher.legacy)) return 'legacy'
  if (files.every((file) => file.kind === 'missing')) return 'absent'
  return files.every((file) => file.kind === 'managed') ? 'current' : 'unmanaged'
}

export async function inspectStableLauncherFormat(homeDir: string): Promise<StableLauncherFormat> {
  return classifyStableLauncherPair(await readStableLauncherPair(homeDir))
}
