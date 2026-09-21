/**
 * `tenon spec apply` 的彩排面：在 `openspec/` 的临时整拷里跑真的 OpenSpec CLI，只回传主规格差异。
 *
 * 上游 `openspec archive` 会同时重写主规格并把 change 目录搬进 archive/，没有 dry-run；
 * 因此差异只能这样取。仓库在这里一个字节都不会被改。
 */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errMsg } from '../deps.js'

const MAX_OUTPUT_BYTES = 256 * 1024

export interface RunOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface SpecTarget {
  readonly path: string
  readonly before: string | null
  readonly after: string
  readonly change: 'created' | 'changed' | 'no-op'
}

/**
 * 彩排结束到写回之间的窗口，只有测试用得上：CAS 冲突是并发产生的，生产里没有别的办法把它
 * 造出来。生产调用不传本参数，行为与没有它时逐字一致。
 */
export interface SpecApplyHooks {
  readonly afterRehearsal?: () => Promise<void>
}

export function runOpenspec(args: readonly string[], cwd: string): Promise<RunOutcome> {
  return new Promise((done) => {
    execFile('openspec', [...args], { cwd, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      done({ code, stdout, stderr })
    })
  })
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function decodeJson(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 彩排失败时把 OpenSpec 自己的话原样带出来，不另造一套解释。 */
function quoted(outcome: RunOutcome, label: string): readonly string[] {
  const head = `${label} 退出码 ${outcome.code}`
  const lines: string[] = []
  for (const rawItem of asArray(decodeJson(outcome.stdout)?.items)) {
    const item = asRecord(rawItem)
    if (item === null || item.valid !== false) continue
    for (const rawIssue of asArray(item.issues)) {
      const issue = asRecord(rawIssue)
      if (issue === null) continue
      lines.push([
        asText(item.id) ?? '?', asText(issue.level) ?? 'ERROR',
        asText(issue.path) ?? '', asText(issue.message) ?? '',
      ].join(' ').trim())
    }
  }
  if (lines.length > 0) return [head, ...lines]
  // 非 JSON 输出（例如 archive）按原文带出。
  const text = `${outcome.stdout}${outcome.stderr}`.trim()
  return [head, ...(text === '' ? [] : text.split('\n'))]
}

/** `openspec/specs/<cap>/spec.md` → `<cap>`。 */
function capabilityOf(path: string): string | undefined {
  return /^openspec\/specs\/([^/]+)\/spec\.md$/u.exec(path)?.[1]
}

export async function readMaybe(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(root, rel), 'utf8')
  } catch {
    return null
  }
}

async function snapshot(root: string): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>()
  let entries
  try {
    entries = await readdir(join(root, 'openspec', 'specs'), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = `openspec/specs/${entry.name}/spec.md`
    const text = await readMaybe(root, path)
    if (text !== null) found.set(path, text)
  }
  return found
}

/**
 * 差异取自同一份临时拷贝的「归档前 / 归档后」，而不是仓库当前内容：before 因此就是彩排开始那一刻
 * 的仓库字节，写回前拿它对仓库做 CAS 才有意义。
 */
function collectTargets(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly SpecTarget[] {
  const targets: SpecTarget[] = []
  for (const path of [...after.keys()].sort()) {
    const next = after.get(path) ?? ''
    const previous = before.get(path) ?? null
    targets.push({
      path,
      before: previous,
      after: next,
      change: previous === null ? 'created' : previous === next ? 'no-op' : 'changed',
    })
  }
  return targets
}

export async function rehearseSpecApply(
  repoRoot: string,
  change: string,
  hooks: SpecApplyHooks | undefined,
): Promise<{ readonly targets: readonly SpecTarget[]; readonly errors: string[] }> {
  const rehearsal = await mkdtemp(join(tmpdir(), 'tenon-spec-apply-'))
  let targets: readonly SpecTarget[] = []
  const errors: string[] = []
  try {
    await cp(join(repoRoot, 'openspec'), join(rehearsal, 'openspec'), {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    })
    const before = await snapshot(rehearsal)
    const validate = await runOpenspec(
      ['validate', change, '--strict', '--no-interactive', '--json'], rehearsal)
    if (validate.code !== 0) errors.push(...quoted(validate, 'openspec validate'))
    if (errors.length === 0) {
      const archive = await runOpenspec(['archive', change, '--yes', '--json'], rehearsal)
      if (archive.code !== 0) errors.push(...quoted(archive, 'openspec archive'))
    }
    if (errors.length === 0) {
      targets = collectTargets(before, await snapshot(rehearsal))
      // 只复验本次真正改到的 capability：别的 capability 合不合格与这个 change 无关，
      // 拿 `--specs` 全量 strict 会让无关旧规格把应用永远挡住。
      for (const target of targets) {
        const capability = target.change === 'no-op' ? undefined : capabilityOf(target.path)
        if (capability === undefined) continue
        const merged = await runOpenspec(
          ['validate', capability, '--type', 'spec', '--strict', '--no-interactive', '--json'],
          rehearsal,
        )
        if (merged.code !== 0) errors.push(...quoted(merged, `openspec validate ${capability}`))
      }
      if (errors.length > 0) targets = []
    }
    await hooks?.afterRehearsal?.()
  } catch (e) {
    errors.push(errMsg(e))
  } finally {
    await rm(rehearsal, { recursive: true, force: true })
  }
  return { targets, errors }
}
