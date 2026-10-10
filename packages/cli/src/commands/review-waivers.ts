/**
 * 评审确认里的「待批准」项：测试计划豁免、目录里项目级「不适用」声明（catalog.yaml 的 not_applicable），以及本任务 diff 里的
 * 受保护测试配置改动（测试目录、基线、已知失败清单、项目工作流；kernel protected-files.ts）。
 *
 *   · `tenon review request`：在 Change 锁内把几类未批准的项冻结成清单（边车），并逐条列给用户；
 *   · `tenon review acknowledge`（人工确认，非 `--delegated`）：在提交 approved receipt 的同一把锁内，
 *     只批准清单里仍原样存在的项（kernel `approveFrozenWaivers`，与 Dashboard 的确认共用）：
 *     豁免写 `approved_by`，受保护改动把「路径 + 内容摘要」写进本机封存文件，随后留一行审计。
 *
 * 豁免是「策略要求但本任务不适用」的例外，受保护改动是「什么算通过」的定义被改；批准它们就是接受一次偏差，
 * 所以委托确认（`--delegated`）、AFK 都不批准。有待批准项时，委托确认整个被拒（receipt 保持待确认）：让它先把
 * receipt 用掉，只会留下一个谁也批准不了的项（request 已经被消费，人工确认也没有可确认的了）。用户回复
 * 「确认继续」走人工确认，批准这些项并放行。
 */
import {
  boundReviewWaiverSelection, clearReviewWaiverSelection, describeProtectedChange, fileAtChangeStart, changeStartOfFields,
  pendingReviewWaivers, protectedApprovalDigests, protectedChangeLine, protectedOrigin, readTestSeal,
  residualAcceptedRaw, residualLines, stepTestFailuresOf, userSlug, writeReviewWaiverSelection,
  type FrozenProtectedChange, type FrozenResidual, type PendingWaiver, type PipelineState, type StepTestFailures,
  type WaiverApprovalOutcome, type WaiverSkipReason,
} from '@tenon/kernel'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { protectedChangesFor, testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { recordTestAudit } from '../testAudit.js'
import { effectiveWorkflowForState } from './effective-workflow.js'
import { recordHistory } from './fields.js'

export interface PendingReviewItems {
  readonly waivers: readonly PendingWaiver[]
  readonly protected: readonly FrozenProtectedChange[]
  /** 验证轮次用完后待用户接受的剩余阻断（必需评审者在当前候选上不通过）。 */
  readonly residual: readonly FrozenResidual[]
  /** 读取受保护改动失败的原因（不是 git 仓等）；请求不因此失败，转换时门禁会以 files-diff-unavailable 挡住。 */
  readonly protectedError?: string
}

/** 本任务 diff 里还没有匹配摘要批准的受保护改动（带来源）。 */
export async function pendingProtectedChanges(
  deps: CliDeps,
  change: string,
  slug: string,
): Promise<readonly FrozenProtectedChange[]> {
  const changes = await protectedChangesFor(deps, change)()
  const { seal } = await readTestSeal(deps.cwd, slug)
  return changes.flatMap((item) => {
    const origin = protectedOrigin(seal, change, item)
    return origin === 'approved' ? [] : [{ path: item.path, kind: item.kind, status: item.status, digest: item.digest, origin }]
  })
}

/**
 * 当前步骤各测试新鲜失败的豁免事实（kernel `stepTestFailuresOf`）：步骤测试豁免的批准绑定被批准的那份代码，
 * 评审请求据此把「批准绑定的已不是现在这份代码」的 `test:` 豁免再次列给用户并冻结现在的候选。
 * 工作流或证据读不出来时返回空（不额外列出；转换时门禁仍以「豁免待批准」挡住）。
 */
export async function currentStepTestFailures(deps: CliDeps, dir: string, change: string): Promise<StepTestFailures> {
  try {
    const state = await deps.store.read(dir)
    const plan = effectiveWorkflowForState(deps, state)
    const stepId = state.fields.phase
    if (plan === null || typeof stepId !== 'string') return new Map()
    const report = await testEvidenceReaderFor(deps)({
      repoRoot: deps.cwd, changeDir: dir, changeName: change, plan, stepId, context: testEvidenceContextFor(deps, change),
    })
    return stepTestFailuresOf(report.items)
  } catch {
    return new Map()
  }
}

/** 冻结清单（调用方持有 Change 锁）。没有待批准项（计划缺失、不可信也算）时清掉旧清单。 */
export async function freezePendingWaivers(
  deps: CliDeps,
  dir: string,
  change: string,
  actorId: string,
  request: { readonly phase: string; readonly event: string; readonly requestedAt: string },
  residual: readonly FrozenResidual[] = [],
): Promise<PendingReviewItems> {
  const waivers = await pendingReviewWaivers({ repoRoot: deps.cwd, dir, change, failures: await currentStepTestFailures(deps, dir, change) })
  let frozen: readonly FrozenProtectedChange[] = []
  let protectedError: string | undefined
  try {
    frozen = await pendingProtectedChanges(deps, change, userSlug(actorId))
  } catch (error) {
    protectedError = error instanceof Error ? error.message.slice(0, 200) : '读取失败'
  }
  if (waivers.length === 0 && frozen.length === 0 && residual.length === 0) await clearReviewWaiverSelection(dir)
  else {
    await writeReviewWaiverSelection(dir, {
      ...request, waivers,
      ...(frozen.length === 0 ? {} : { protected: frozen }),
      ...(residual.length === 0 ? {} : { residual }),
    })
  }
  return { waivers, protected: frozen, residual, ...(protectedError === undefined ? {} : { protectedError }) }
}

async function currentText(deps: CliDeps, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(deps.cwd, ...path.split('/')), 'utf8')
  } catch {
    return undefined
  }
}

/** 逐条列给用户看的行：文件、状态、摘要、来源，以及目录 / 已知失败清单的语义摘要。 */
export async function reviewItemLines(deps: CliDeps, state: PipelineState, items: PendingReviewItems): Promise<readonly string[]> {
  const lines: string[] = []
  if (items.waivers.length > 0) {
    const bound = items.waivers.some((waiver) => waiver.candidate !== undefined)
    lines.push(
      `[REVIEW] 待批准的豁免 ${items.waivers.length} 项（用户的确认同时批准这些豁免；\`not-applicable:<种类>\` 是 catalog.yaml 里项目级的「不适用」声明，批准一次对全项目生效。${bound ? '`test:<步骤测试 id>` 的批准只对现在这份代码上的失败有效，代码再变、同一测试再次失败要重新确认。' : ''}请连同理由一并展示给用户）：`,
      ...items.waivers.map((waiver) => `  ${waiver.key} — ${waiver.reason}`),
    )
  }
  if (items.protected.length > 0) {
    lines.push(`[REVIEW] 待确认的测试配置改动 ${items.protected.length} 项（用户的确认同时批准这些内容；请连同下列摘要一并展示给用户，确认之后文件再变就要重新确认）：`)
    const start = changeStartOfFields(state.fields)
    for (const item of items.protected) {
      lines.push(`  ${protectedChangeLine(item)}${item.origin === 'outside-command' ? ' [台账外改动：Tenon 命令写出之后又被改过]' : ''}`)
      let before: string | undefined
      try {
        before = await fileAtChangeStart(deps.cwd, start, item.path)
      } catch {
        before = undefined
      }
      const after = item.status === 'deleted' ? undefined : await currentText(deps, item.path)
      for (const line of describeProtectedChange(item.kind, before, after)) lines.push(`    · ${line}`)
    }
  }
  lines.push(...residualLines(items.residual))
  if (items.protectedError !== undefined) {
    lines.push(`[REVIEW] 无法读取本任务对测试配置的改动（${items.protectedError}）；转换时门禁会以 files-diff-unavailable 挡住，直到能读出为止`)
  }
  return lines
}

const SKIP_WORDS: Readonly<Record<WaiverSkipReason, string>> = {
  missing: '已不在计划里',
  'reason-changed': '请求之后理由被改过',
  'already-approved': '已经批准过',
}

export function skippedWaiverLines(outcome: WaiverApprovalOutcome): readonly string[] {
  return [
    ...outcome.skipped.map((item) => `[REVIEW] 豁免 ${item.key} 未批准：${SKIP_WORDS[item.why]}；需要时重新 review request`),
    ...outcome.protectedSkipped.map((item) => `[REVIEW] 配置改动 ${item.path} 未批准：${item.why === 'content-changed' ? '请求之后内容又变了' : '读不出内容'}；需要时重新 review request`),
  ]
}

/**
 * 委托确认在提交 approved receipt 之前的检查（锁内）：计划里还有未批准的豁免、目录里还有未批准的「不适用」声明、
 * 或还有待确认的受保护配置改动就拒绝，抛错、不写任何东西。计划缺失或不可信时没有可批准的计划豁免，放行
 * （这些状态由测试门禁自己挡）；读不出受保护改动时同样放行（门禁会以 files-diff-unavailable 挡住）。
 */
export async function refuseDelegatedWhileWaiversPending(
  deps: CliDeps,
  dir: string,
  change: string,
  actorId: string,
  state: PipelineState,
): Promise<void> {
  await refuseWhileResidualPending(deps, dir, state, 'delegated')
  const pending = await pendingReviewWaivers({ repoRoot: deps.cwd, dir, change, failures: await currentStepTestFailures(deps, dir, change) })
  if (pending.length > 0) {
    throw new Error(
      `有 ${pending.length} 项测试豁免 / 不适用声明待人工批准（${pending.map((item) => item.key).join('、')}）：`
      + '委托确认不批准豁免（也不批准目录里的「不适用」声明）；请用户回复「确认继续」人工确认，或先撤掉它们',
    )
  }
  const items = await pendingProtectedChanges(deps, change, userSlug(actorId)).catch(() => [])
  if (items.length > 0) {
    throw new Error(
      `本任务改动了 ${items.length} 处测试配置待人工确认（${items.map((item) => item.path).join('、')}）：`
      + '委托确认不批准测试配置改动；请用户回复「确认继续」人工确认，或先还原这些改动',
    )
  }
}

/**
 * 这次评审请求冻结了待接受的剩余阻断时，委托确认与 AFK 都不接受：抛错、不写任何东西，receipt 保持待确认。
 * 接受一个仍然不通过的评审结论是用户本人的决定，只能由人工确认做出。
 */
export async function refuseWhileResidualPending(
  deps: CliDeps,
  dir: string,
  state: PipelineState,
  why: 'delegated' | 'afk',
): Promise<void> {
  const residual = (await boundReviewWaiverSelection(dir, state)).selection?.residual ?? []
  if (residual.length === 0) return
  throw new Error(msg(deps, why === 'delegated' ? 'review.residualDelegatedRefused' : 'review.residualAfkRefused', {
    count: residual.length, list: residual.map((item) => item.key).join(msg(deps, 'list.separator')),
  }))
}

/** receipt 已提交之后：清掉冻结清单（锁内、尽力而为——清单绑定请求时间，残留不会被下一次请求误用）。 */
export async function retireFrozenWaivers(dir: string): Promise<void> {
  await clearReviewWaiverSelection(dir).catch(() => undefined)
}

/** receipt 已提交之后：审计行（尽力而为）。 */
export async function auditWaiverApproval(
  deps: CliDeps,
  dir: string,
  outcome: WaiverApprovalOutcome,
  approver: string,
): Promise<void> {
  if (outcome.approved.length > 0) {
    await recordTestAudit(deps, dir, 'waiver-approve', {
      waivers: outcome.approved.join(','),
      by: approver,
      plan: outcome.digest ?? undefined,
    })
  }
  if (outcome.protectedApproved.length > 0) {
    await recordTestAudit(deps, dir, 'protected-approve', {
      files: outcome.protectedApproved.join(','),
      digests: await protectedApprovalDigests(deps.cwd, outcome.protectedApproved),
      by: approver,
    })
  }
  // 每个被接受的评审者一行：谁接受了、哪个评审者的哪次运行、绑定的代码候选、阻断级发现数。
  for (const item of outcome.residualAccepted ?? []) {
    await recordHistory(deps, dir, { ts: deps.clock(), kind: 'tool', raw: residualAcceptedRaw(item, approver) })
  }
}
