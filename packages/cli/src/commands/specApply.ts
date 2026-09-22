/**
 * `tenon spec apply <change> [--dry-run] [--json]` —— 把 change 的 delta spec 应用进主规格。
 *
 * 差异由 specApplyRehearsal 在临时整拷里取；这里只负责前置校验、CAS 写回、applied-spec.md 与回执。
 *
 * exit 0 = 通过，1 = 用法或状态，2 = 校验/彩排失败，3 = 没有 openspec CLI，4 = 主规格被人改过。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  readDocumentLedger, renderDocumentTemplate, sha256Hex, SPEC_APPLY_RECEIPT_FILE,
  type DocumentLocale, type DocumentRecord,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { isValidChangeName, resolveChangeDir } from '../paths.js'
import { refuseArchived } from '../archivedGuard.js'
import { resolveChangeDocumentLocale } from '../documentLocale.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import {
  asArray, asRecord, asText, decodeJson, readMaybe, rehearseSpecApply, runOpenspec,
  type SpecApplyHooks, type SpecTarget,
} from './specApplyRehearsal.js'

/** 回执文件名的真相源在 kernel：ship 出口的 spec-migration-applied guard 读的是同一份。 */
export const SPEC_APPLY_RECEIPT = SPEC_APPLY_RECEIPT_FILE
const APPLIED_SPEC_FILE = 'applied-spec.md'

export type { SpecApplyHooks } from './specApplyRehearsal.js'

/**
 * 已经应用过、且 delta 与主规格都没再动过 → 全部 no-op。
 *
 * 上游 archive 不是幂等的：对同一个 change 再跑一次会把需求又合并一遍。所以「再应用一次」
 * 必须在彩排之前，用上一份回执与盘上字节回答，而不是靠彩排本身。
 */
async function alreadyApplied(
  repoRoot: string,
  dir: string,
  deltas: readonly { readonly path: string; readonly sha256: string }[],
): Promise<readonly SpecTarget[] | null> {
  const raw = await readMaybe(dir, SPEC_APPLY_RECEIPT)
  const receipt = raw === null ? null : decodeJson(raw)
  if (receipt === null || receipt.mode !== 'apply' || receipt.result !== 'pass') return null
  const recorded = asArray(receipt.deltas)
    .map((row) => asRecord(row))
    .map((row) => `${asText(row?.path) ?? ''}:${asText(row?.sha256) ?? ''}`).sort()
  const current = deltas.map((delta) => `${delta.path}:${delta.sha256}`).sort()
  if (recorded.length !== current.length || recorded.some((row, index) => row !== current[index])) return null
  const targets: SpecTarget[] = []
  for (const row of asArray(receipt.targets)) {
    const target = asRecord(row)
    const path = asText(target?.path)
    if (path === undefined) return null
    const text = await readMaybe(repoRoot, path)
    if (text === null || sha256Hex(text) !== asText(target?.after_sha256)) return null
    targets.push({ path, before: text, after: text, change: 'no-op' })
  }
  return targets
}

/**
 * applied-spec.md：登记面用的回执文档。骨架仍由 document 模板渲染（标题与章节顺序与
 * `tenon document scaffold` 逐字一致），逐条替换占位行为本次真实落盘的内容。
 */
async function writeAppliedSpec(
  dir: string,
  change: string,
  targets: readonly SpecTarget[],
): Promise<void> {
  const locale = await resolveChangeDocumentLocale(dir, undefined, true)
  const skeleton = renderDocumentTemplate('applied-spec', locale as DocumentLocale, { change })
  const bodies = [
    `delta spec 已应用到 ${targets.filter((target) => target.change !== 'no-op').length} 份主规格。`,
    targets.map((target) => `- ${target.path}（${target.change}）`).join('\n'),
    SPEC_APPLY_RECEIPT,
  ]
  let filled = 0
  const lines = skeleton.split('\n').map((line) =>
    line.startsWith('> [') ? bodies[filled++] ?? line : line)
  await writeFile(join(dir, APPLIED_SPEC_FILE), lines.join('\n'), 'utf8')
}

function targetView(target: SpecTarget): Record<string, unknown> {
  return {
    path: target.path,
    before_sha256: target.before === null ? null : sha256Hex(target.before),
    after_sha256: sha256Hex(target.after),
    change: target.change,
  }
}

interface ApplyOpts {
  readonly dryRun?: boolean
  readonly json?: boolean
}

export async function cmdSpecApply(
  deps: CliDeps,
  change: string,
  opts: ApplyOpts,
  hooks?: SpecApplyHooks,
): Promise<number> {
  if (!isValidChangeName(change)) {
    deps.io.err(`ERROR: change-name 非法: '${change}' (仅允许 a-z A-Z 0-9 - _)`)
    return 1
  }
  const dir = resolveChangeDir(deps.cwd, change)
  let state
  try {
    state = await deps.store.read(dir)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (await refuseArchived(deps, change)) return 1
  let deltas: readonly DocumentRecord[]
  try {
    if (effectiveWorkflowForState(deps, state)?.capabilities.documents.governed !== true) {
      deps.io.err(`ERROR: 任务 '${change}' 的工作流未开启 openspec，无需应用规格`)
      return 1
    }
    deltas = (await readDocumentLedger(dir))?.records.filter((record) => record.kind === 'delta-spec') ?? []
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  if (deltas.length === 0) {
    deps.io.err(`ERROR: delta-spec-unrecorded：任务 '${change}' 还没有登记 delta spec`)
    return 1
  }
  const cli = await runOpenspec(['--version'], deps.cwd)
  if (cli.code !== 0) {
    deps.io.err('ERROR: openspec-cli-missing：PATH 上没有 openspec，装上后重试')
    return 3
  }

  const mode = opts.dryRun === true ? 'dry-run' : 'apply'
  // 回执里的 delta 摘要取盘上当前字节：`step.next` 用它判断「这份回执还对得上现在的 delta spec 吗」，
  // 台账里冻结的那一份回答不了这个问题。
  const deltaRefs = await Promise.all(deltas.map(async (record) => ({
    path: record.path,
    sha256: sha256Hex(await readMaybe(deps.cwd, record.path) ?? ''),
  })))
  const settled = await alreadyApplied(deps.cwd, dir, deltaRefs)
  const rehearsed = settled === null
    ? await rehearseSpecApply(deps.cwd, change, hooks)
    : { targets: settled, errors: [] as string[] }
  const targets = rehearsed.targets
  const errors = [...rehearsed.errors]

  let conflict = false
  if (errors.length === 0 && mode === 'apply') {
    for (const target of targets) {
      if (target.change === 'no-op') continue
      if (await readMaybe(deps.cwd, target.path) !== target.before) {
        conflict = true
        errors.push(`main-spec-changed：${target.path} 在彩排期间被改动，重跑 tenon spec apply ${change}`)
      }
    }
    if (!conflict) {
      for (const target of targets) {
        if (target.change === 'no-op') continue
        // 每条 `## ADDED Requirements` delta 引入的都是一个新 capability，它的
        // openspec/specs/<capability>/ 目录此刻还不存在。彩排在临时整拷里把父目录一起建了，所以
        // 它照样报 created；真写少了这一步就 ENOENT，于是「彩排过、真跑崩」成了每个首次 capability 的常态。
        const absolute = resolve(deps.cwd, target.path)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, target.after, 'utf8')
      }
      await writeAppliedSpec(dir, change, targets)
    }
  }

  const result = errors.length === 0 ? 'pass' : 'fail'
  const view = {
    change,
    mode,
    result,
    openspec_version: cli.stdout.trim(),
    deltas: deltaRefs,
    targets: targets.map(targetView),
  }
  let receiptPath: string | null = null
  try {
    await writeFile(
      join(dir, SPEC_APPLY_RECEIPT),
      `${JSON.stringify({ schema: 'tenon-spec-apply-v1', ...view, at: deps.clock() }, null, 2)}\n`,
      'utf8',
    )
    receiptPath = `openspec/changes/${change}/${SPEC_APPLY_RECEIPT}`
  } catch (e) {
    deps.io.err(`WARN: 回执写入失败: ${errMsg(e)}`)
  }

  if (opts.json === true) {
    deps.io.out(JSON.stringify({ ...view, receipt_path: receiptPath, errors }))
  } else {
    deps.io.out(`[SPEC] ${change} ${mode} ${result}`)
    for (const target of targets) deps.io.out(`  ${target.change} ${target.path}`)
    for (const error of errors) deps.io.err(`  ERROR: ${error}`)
  }
  if (conflict) return 4
  return errors.length === 0 ? 0 : 2
}
