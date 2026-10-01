/**
 * `tenon document record <change> --all [--producer <skill>]` —— 一次登记当前步骤所有「文件已经写好」的文档。
 *
 * 对象与 `tenon status --json` 的 `step.next` 里 `record-document` 的来源一致：本步产出的文档（缺失或已过期），
 * 本步可改的、已登记又变了的文档，以及已调用技能还欠的文档。每份文档仍走 `document record` 本身的全部校验
 * （骨架占位符、producer 的技能回执、owner、归档闸），这里只是逐份调用，不放宽任何一条。
 *
 * 幂等：已是最新的不动；文件还没写、骨架没填完的列出来并跳过，不算失败；路径要作者拍板的（delta-spec 缺
 * capability）也只是跳过。真的登记失败（技能没加载、登记被拒）才退出 2，其余文档照常处理。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { aliasesForSkill } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { cmdDocumentRecord } from './document.js'
import { placeholderRefusal } from './documentPlaceholderGate.js'
import { documentWriteActions, skillDocumentActions } from './statusStepDocumentActions.js'
import type { StepAction } from './statusStepAction.js'
import type { StepSkillView } from './statusStepParts.js'
import { capturing, firstError, loadStepBlock } from './step-view.js'

export interface RecordedDocument {
  readonly kind: string
  readonly path: string | null
  readonly producer: string | null
  readonly outcome: 'recorded' | 'skipped' | 'failed'
  readonly detail: string
}

/** 多个合法 producer 时优先取本步已调用的那个技能；都没调用就取第一个（登记会因缺回执而说清楚）。 */
export function pickProducer(producers: readonly string[], skills: readonly StepSkillView[]): string | undefined {
  const invoked = skills.filter((skill) => skill.status === 'invoked' || skill.status === 'done')
  const found = producers.find((producer) => invoked.some((skill) =>
    aliasesForSkill(skill.id).some((alias) => aliasesForSkill(producer).includes(alias))))
  return found ?? producers[0]
}

/** 记录动作里值得批量登记的文档（同一 kind 只留一条，保持 next 的顺序）。 */
export function recordableDocuments(
  documents: Parameters<typeof documentWriteActions>[0],
  skills: readonly StepSkillView[],
): readonly StepAction[] {
  const seen = new Set<string>()
  return [...documentWriteActions(documents), ...skillDocumentActions(skills, documents)]
    .filter((action) => action.action === 'record-document')
    .filter((action) => !seen.has(String(action.kind)) && seen.add(String(action.kind)))
}

export async function recordOneDocument(
  deps: CliDeps,
  change: string,
  action: StepAction,
  skills: readonly StepSkillView[],
  producerOverride?: string,
): Promise<RecordedDocument> {
  const kind = String(action.kind)
  const path = typeof action.path === 'string' ? action.path : null
  const producers = Array.isArray(action.producers) ? action.producers.map(String) : []
  const producer = producerOverride ?? pickProducer(producers, skills) ?? null
  const skipped = (detail: string): RecordedDocument => ({ kind, path, producer, outcome: 'skipped', detail })
  if (path === null) return skipped(msg(deps, 'document.record.pathUndecided'))
  if (!existsSync(resolve(deps.cwd, path))) return skipped(msg(deps, 'document.record.fileNotWritten', { change, kind }))
  const refusal = await placeholderRefusal(deps.cwd, kind, path)
  if (refusal !== null) {
    const [header = '', first = ''] = refusal.split('\n')
    const count = /仍含 (\d+) 处/u.exec(header)?.[1]
    return skipped(count === undefined
      ? msg(deps, 'document.record.placeholdersSome', { first: first.trim() })
      : msg(deps, 'document.record.placeholders', { count, first: first.trim() }))
  }
  if (producer === null) return { kind, path, producer, outcome: 'failed', detail: msg(deps, 'document.record.noProducer') }
  const captured = capturing(deps)
  const code = await cmdDocumentRecord(captured.deps, change, kind, path, producer)
  return code === 0
    ? { kind, path, producer, outcome: 'recorded', detail: msg(deps, 'document.record.recorded', { producer }) }
    : { kind, path, producer, outcome: 'failed', detail: firstError(captured, msg(deps, 'document.record.exitCode', { code })) }
}

export async function cmdDocumentRecordAll(
  deps: CliDeps,
  change: string,
  opts: { readonly producer?: string } = {},
): Promise<number> {
  const step = await loadStepBlock(deps, change)
  if ('error' in step) {
    deps.io.err(`ERROR: ${step.error}`)
    return 1
  }
  const actions = recordableDocuments(step.documents, step.skills)
  if (actions.length === 0) {
    deps.io.out(msg(deps, 'document.record.allNone', { change, step: step.id }))
    return 0
  }
  const results: RecordedDocument[] = []
  for (const action of actions) results.push(await recordOneDocument(deps, change, action, step.skills, opts.producer))
  deps.io.out(msg(deps, 'document.record.allSummary', {
    change, step: step.id, recorded: results.filter((item) => item.outcome === 'recorded').length, total: results.length,
  }))
  for (const item of results) {
    const mark = item.outcome === 'recorded' ? 'OK  ' : item.outcome === 'skipped' ? 'SKIP' : 'FAIL'
    deps.io.out(`  [${mark}] ${item.kind}${item.path === null ? '' : ` ${item.path}`} · ${item.detail}`)
  }
  return results.some((item) => item.outcome === 'failed') ? 2 : 0
}

export interface RecordCommandOptions {
  readonly producer?: string
  readonly all?: boolean
  readonly backfill?: boolean
}

/** `tenon document record` 的参数分派：逐份登记（kind / path / --producer 必填）或 --all 批量。 */
export async function cmdDocumentRecordCommand(
  deps: CliDeps,
  change: string,
  kind: string | undefined,
  path: string | undefined,
  opts: RecordCommandOptions,
): Promise<number> {
  if (opts.all === true) {
    if (kind !== undefined || path !== undefined || opts.backfill === true) {
      deps.io.err(`ERROR: ${msg(deps, 'document.record.allConflict')}`)
      return 1
    }
    return cmdDocumentRecordAll(deps, change, opts.producer === undefined ? {} : { producer: opts.producer })
  }
  if (kind === undefined || path === undefined || opts.producer === undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'document.record.usage')}`)
    return 1
  }
  return cmdDocumentRecord(deps, change, kind, path, opts.producer, opts.backfill === true)
}
