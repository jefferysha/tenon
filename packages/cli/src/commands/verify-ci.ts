/**
 * `tenon verify --ci`：在没有用户本机封存的 CI 里，对已提交的内容独立重算记录链、计划、用例结论与受保护文件批准。
 * exit：0 通过；2 有 error 级发现；1 用法或环境错误。只读：不加锁、不写仓库（只写 `--out` / `--also` 指定的输出文件）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  buildCiReport, candidateFingerprint, ciExitCode, createChangedFilesSession, renderCiMarkdown, renderCiText, toSarif,
  type CandidateMode, type CiFinding, type CiSelector, type CiVerifyOptions, type CiVerifyReport,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'
import { headCommit, isShallow, readEvidenceNotes } from './verify-ci-git.js'
import { verifyChange, type VerifyContext } from './verify-ci-change.js'
import { selectChanges } from './verify-ci-select.js'

export const VERIFY_FORMATS = ['text', 'json', 'sarif', 'markdown'] as const
export type VerifyFormat = (typeof VERIFY_FORMATS)[number]

export interface VerifyCiCmdOpts {
  readonly ci?: boolean
  readonly change?: string
  readonly allOpen?: boolean
  readonly since?: string
  readonly step?: string
  readonly format?: string
  readonly out?: string
  readonly also?: readonly string[]
  readonly candidate?: string
  readonly requireAnchor?: boolean
}

function isFormat(value: string): value is VerifyFormat {
  return (VERIFY_FORMATS as readonly string[]).includes(value)
}

function render(report: CiVerifyReport, format: VerifyFormat): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`
  if (format === 'sarif') return `${JSON.stringify(toSarif(report), null, 2)}\n`
  return format === 'markdown' ? renderCiMarkdown(report) : renderCiText(report)
}

interface Parsed {
  readonly selector: CiSelector
  readonly options: CiVerifyOptions
  readonly format: VerifyFormat
  readonly also: readonly { readonly format: VerifyFormat; readonly file: string }[]
}

function parseOptions(opts: VerifyCiCmdOpts): Parsed | string {
  if (opts.ci !== true) return '目前只有 CI 模式：请加 --ci（在没有用户本机封存的环境里对已提交内容独立校验）'
  const selectors = [opts.change !== undefined, opts.allOpen === true, opts.since !== undefined].filter(Boolean).length
  if (selectors !== 1) return '需要且只能选一个任务范围：--change <name> | --all-open | --since <ref>'
  const selector: CiSelector = opts.change !== undefined ? { kind: 'change', change: opts.change }
    : opts.since !== undefined ? { kind: 'since', ref: opts.since } : { kind: 'all-open' }
  const format = opts.format ?? 'text'
  if (!isFormat(format)) return `--format 只支持 ${VERIFY_FORMATS.join(' | ')}（收到 '${format}'）`
  const candidate = opts.candidate ?? 'error'
  if (candidate !== 'error' && candidate !== 'warn' && candidate !== 'off') return `--candidate 只支持 error | warn | off（收到 '${candidate}'）`
  const also: { format: VerifyFormat; file: string }[] = []
  for (const entry of opts.also ?? []) {
    const eq = entry.indexOf('=')
    const kind = eq > 0 ? entry.slice(0, eq) : ''
    const file = eq > 0 ? entry.slice(eq + 1) : ''
    if (!isFormat(kind) || file === '') return `--also 的形式是 <format>=<file>，format 为 ${VERIFY_FORMATS.join(' | ')}（收到 '${entry}'）`
    also.push({ format: kind, file })
  }
  return { selector, options: { candidate: candidate as CandidateMode, requireAnchor: opts.requireAnchor === true }, format, also }
}

async function writeOutput(cwd: string, file: string, text: string): Promise<void> {
  const target = resolve(cwd, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text, 'utf8')
}

async function isFinishedChange(deps: CliDeps, dir: string): Promise<boolean> {
  try {
    return str((await deps.store.read(dir)).fields.archived) === 'true'
  } catch {
    return false
  }
}

export async function cmdVerifyCi(deps: CliDeps, opts: VerifyCiCmdOpts): Promise<number> {
  const parsed = parseOptions(opts)
  if (typeof parsed === 'string') {
    deps.io.err(`ERROR: ${parsed}`)
    return 1
  }
  const selection = await selectChanges(deps, parsed.selector, (dir) => isFinishedChange(deps, dir))
  if (!selection.ok) {
    deps.io.err(`ERROR: ${selection.error}`)
    return 1
  }
  let candidatePromise: Promise<string> | undefined
  const candidate = parsed.options.candidate === 'off' ? undefined : (): Promise<string> => {
    candidatePromise ??= candidateFingerprint(deps.cwd)
    return candidatePromise
  }
  const ctx: VerifyContext = {
    deps, options: parsed.options, stepOverride: opts.step, candidate,
    anchors: await readEvidenceNotes(deps.cwd), session: createChangedFilesSession(deps.cwd), shallow: await isShallow(deps.cwd),
  }
  const changes = []
  for (const selected of selection.changes) changes.push(await verifyChange(ctx, selected))
  const global: CiFinding[] = []
  const report = buildCiReport({
    tenon: deps.pluginVersion ?? 'unknown', generatedAt: deps.clock(), head: await headCommit(deps.cwd),
    selector: parsed.selector, options: parsed.options, changes, findings: global,
  })
  try {
    if (opts.out !== undefined) await writeOutput(deps.cwd, opts.out, render(report, parsed.format))
    for (const extra of parsed.also) await writeOutput(deps.cwd, extra.file, render(report, extra.format))
  } catch (error) {
    deps.io.err(`ERROR: 写输出文件失败：${errMsg(error)}`)
    return 1
  }
  // 写了 --out 时 stdout 仍给人读的摘要（CI 日志里直接可见）；没写 --out 时 stdout 就是所选格式。
  const shown = opts.out === undefined ? parsed.format : 'text'
  deps.io.out(render(report, shown).replace(/\n$/u, ''))
  return ciExitCode(report)
}
