import { runRemoteGit } from '../commands/remote-git.js'
import type { SetupEnv } from '../commands/setup.js'

type RunEnv = Pick<SetupEnv, 'runCommand'>

export interface UpstreamCheckout {
  readonly repo: string
  readonly commit: string
  readonly dir: string
}

const COMMIT = /^[0-9a-f]{40}$/
const CHECKOUT_TIMEOUT_MS = 300_000
const CHECKOUT_ATTEMPTS = 2
const LOCAL_TIMEOUT_MS = 60_000

/** URLs are built only from a repo that `parseUpstreamSkillSources` already validated as owner/name. */
export function upstreamRepoUrl(repo: string): string {
  return `https://github.com/${repo}.git`
}

function failure(label: string, run: ReturnType<typeof runRemoteGit>): string {
  const detail = run.result.stderr.trim().split(/\r?\n/u).at(-1) || `exit ${run.result.code}`
  return `git ${label} ${run.attempts > 1 ? `failed after ${run.attempts} attempts` : 'failed'}: ${detail}`
}

export function resolveDefaultBranchHead(
  env: RunEnv,
  repo: string,
): { readonly ok: true; readonly commit: string } | { readonly ok: false; readonly detail: string } {
  const run = runRemoteGit(env, ['ls-remote', '--symref', upstreamRepoUrl(repo), 'HEAD'])
  if (run.result.code !== 0) return { ok: false, detail: failure('ls-remote', run) }
  for (const line of run.result.stdout.split(/\r?\n/u)) {
    const [oid, ref] = line.trim().split(/\s+/u)
    if (ref === 'HEAD' && oid !== undefined && COMMIT.test(oid)) return { ok: true, commit: oid }
  }
  return { ok: false, detail: 'git ls-remote did not advertise HEAD' }
}

function sparsePatterns(paths: readonly string[]): string[] {
  const skillPatterns = paths.map((path) => (path === '.' ? '/*' : `/${path}/`))
  return [...new Set([...skillPatterns, '/LICENSE*', '/LICENCE*', '/COPYING*', '/README*'])]
}

/** Blob-less shallow clone, sparse to the skill paths plus root license/readme files; checkout downloads the blobs. */
export function checkoutUpstreamPaths(
  env: RunEnv,
  repo: string,
  paths: readonly string[],
  workDir: string,
): { readonly ok: true; readonly checkout: UpstreamCheckout } | { readonly ok: false; readonly detail: string } {
  const budget = { timeoutMs: CHECKOUT_TIMEOUT_MS, attempts: CHECKOUT_ATTEMPTS }
  const cloned = runRemoteGit(env, [
    'clone', '--quiet', '--depth=1', '--filter=blob:none', '--no-checkout', '--single-branch', upstreamRepoUrl(repo), workDir,
  ], budget)
  if (cloned.result.code !== 0) return { ok: false, detail: failure('clone', cloned) }
  const sparse = runRemoteGit(env, ['-C', workDir, 'sparse-checkout', 'set', '--no-cone', ...sparsePatterns(paths)], budget)
  if (sparse.result.code !== 0) return { ok: false, detail: failure('sparse-checkout', sparse) }
  const checkedOut = runRemoteGit(env, ['-C', workDir, 'checkout', '--quiet'], budget)
  if (checkedOut.result.code !== 0) return { ok: false, detail: failure('checkout', checkedOut) }
  const head = env.runCommand('git', ['-C', workDir, 'rev-parse', 'HEAD'], { timeoutMs: LOCAL_TIMEOUT_MS })
  const commit = head.stdout.trim()
  if (head.code !== 0 || !COMMIT.test(commit)) return { ok: false, detail: 'git rev-parse HEAD failed' }
  return { ok: true, checkout: { repo, commit, dir: workDir } }
}

/** Every tree entry under `path` at HEAD (`[]` when the path is absent); `null` when git itself fails. */
export function treeEntryModes(
  env: RunEnv,
  checkoutDir: string,
  path: string,
): readonly { readonly mode: string; readonly path: string }[] | null {
  const scope = path === '.' ? [] : ['--', path]
  const listed = env.runCommand('git', ['-C', checkoutDir, 'ls-tree', '-r', '--full-tree', 'HEAD', ...scope], { timeoutMs: LOCAL_TIMEOUT_MS })
  if (listed.code !== 0) return null
  const entries: { mode: string; path: string }[] = []
  for (const line of listed.stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const [mode] = line.slice(0, tab).split(' ')
    if (mode !== undefined) entries.push({ mode, path: line.slice(tab + 1) })
  }
  return entries
}
