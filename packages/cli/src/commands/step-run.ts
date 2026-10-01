/**
 * `tenon step run <change> [--json]` —— 把 `step.next` 里确定性的动作一次做完，并明说做了什么、停在哪儿。
 *
 * 会做的（顺序就是 `next` 给的顺序，每一项都是既有命令函数）：
 *   scaffold-document  → tenon document scaffold
 *   record-document    → tenon document record（文件已写好且骨架占位符已替换才做）
 *   read-documents     → tenon document read <change> all（读取回执）
 *   test-plan-seed     → tenon test plan <change> --seed
 * 不会做的（要宿主或作者）：加载技能、派发 agent、写文档内容、改代码、跑测试、评审与转换——遇到就停，
 * 把停下的原因和最新的 `step.next` 一并给出，所以紧接着不必再 `tenon status`。
 *
 * 幂等：没有可做的事就什么都不改（退出码 0）。批量动作失败（登记被拒、技能回执缺失…）退出 2，
 * 已经做完的部分保留，原因写在输出里。最多循环 8 轮——每轮重新读 `step.next`，推进不了就停。
 */
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { CliDeps } from '../deps.js'
import { cmdDocumentRead, cmdDocumentScaffold } from './document.js'
import { pickProducer, recordOneDocument } from './document-batch.js'
import { cmdTestPlan } from './test-plan.js'
import type { StepAction } from './statusStepAction.js'
import type { StepBlock } from './statusStep.js'
import { capturing, firstError, loadStepBlock } from './step-view.js'

const MAX_ROUNDS = 8

export interface StepRunDone {
  readonly action: string
  readonly command: string
  readonly ok: boolean
  readonly detail: string
}

export interface StepRunStop {
  /** author = 要作者写内容；host = 要宿主加载技能 / 派发 agent；work = 要做实际工作（测试、评审、转换…）；error = 命令失败。 */
  readonly kind: 'author' | 'host' | 'work' | 'error'
  readonly action: string
  readonly reason: string
}

/** 这些动作是确定性的，可以批量做；其余一律停。 */
const BATCHABLE: ReadonlySet<string> = new Set(['scaffold-document', 'record-document', 'read-documents', 'test-plan-seed'])
const HOST_ACTIONS: ReadonlySet<string> = new Set(['load-tenon', 'load-skill', 'run-agent'])

function describeAction(action: StepAction): string {
  const detail = ['event', 'skill', 'agent', 'test', 'kind', 'field']
    .map((key) => action[key]).find((value) => typeof value === 'string')
  return detail === undefined ? action.action : `${action.action} ${String(detail)}`
}

function stopFor(action: StepAction): StepRunStop {
  const what = describeAction(action)
  if (HOST_ACTIONS.has(action.action)) return { kind: 'host', action: action.action, reason: `${what} 要宿主来做（加载技能 / 派发 agent）` }
  return { kind: 'work', action: action.action, reason: `${what} 要实际工作，不是批量命令能代做的` }
}

interface Outcome { readonly done: StepRunDone; readonly stop?: StepRunStop }

async function perform(deps: CliDeps, change: string, step: StepBlock, action: StepAction): Promise<Outcome> {
  const kind = String(action.kind)
  const path = typeof action.path === 'string' ? action.path : null
  const captured = capturing(deps)
  const finish = (command: string, code: number, success: string): Outcome => code === 0
    ? { done: { action: action.action, command, ok: true, detail: success } }
    : {
        done: { action: action.action, command, ok: false, detail: firstError(captured, `退出码 ${code}`) },
        stop: { kind: 'error', action: action.action, reason: firstError(captured, `${command} 退出码 ${code}`) },
      }
  switch (action.action) {
    case 'scaffold-document': {
      const command = `tenon document scaffold ${change} ${kind}`
      if (path === null) {
        return {
          done: { action: action.action, command, ok: false, detail: '路径要作者定名' },
          stop: { kind: 'author', action: action.action, reason: `${kind} 的路径要作者定名（delta-spec：tenon document scaffold ${change} delta-spec --capability <名>）` },
        }
      }
      return finish(command, await cmdDocumentScaffold(captured.deps, change, kind), captured.out.at(-1) ?? path)
    }
    case 'record-document': {
      const producers = Array.isArray(action.producers) ? action.producers.map(String) : []
      const command = `tenon document record ${change} ${kind} ${path ?? '<path>'} --producer ${pickProducer(producers, step.skills) ?? '<skill>'}`
      if (path !== null && !existsSync(resolve(deps.cwd, path))) {
        return {
          done: { action: action.action, command, ok: false, detail: '文件还没写' },
          stop: { kind: 'author', action: action.action, reason: `${path} 还没写：骨架里的占位符要全部替换成真内容，然后再跑一次 tenon step run ${change}` },
        }
      }
      const result = await recordOneDocument(deps, change, action, step.skills)
      if (result.outcome === 'recorded') return { done: { action: action.action, command, ok: true, detail: result.detail } }
      const author = result.outcome === 'skipped'
      return {
        done: { action: action.action, command, ok: false, detail: result.detail },
        stop: { kind: author ? 'author' : 'error', action: action.action, reason: author ? `${result.detail}；写完再跑一次 tenon step run ${change}` : result.detail },
      }
    }
    case 'read-documents':
      return finish(`tenon document read ${change} all`, await cmdDocumentRead(captured.deps, change, 'all'), '读取回执已登记')
    default:
      return finish(`tenon test plan ${change} --seed`, await cmdTestPlan(captured.deps, change, { seed: true }), '测试计划初稿已生成并登记本任务的测试文件')
  }
}

/** 一行一个动作的 next 摘要。 */
function nextLines(step: StepBlock): readonly string[] {
  return step.next.map((action) => `- ${describeAction(action)}`)
}

export async function cmdStepRun(deps: CliDeps, change: string, opts: { readonly json?: boolean } = {}): Promise<number> {
  let step = await loadStepBlock(deps, change)
  if ('error' in step) {
    deps.io.err(`ERROR: ${step.error}`)
    return 1
  }
  const did: StepRunDone[] = []
  let stopped: StepRunStop | null = null
  for (let round = 0; round < MAX_ROUNDS && stopped === null; round++) {
    const first = step.next[0]
    if (first === undefined) break
    if (!BATCHABLE.has(first.action)) {
      stopped = first.action === 'stop' ? null : stopFor(first)
      break
    }
    let progressed = false
    for (const action of step.next) {
      if (!BATCHABLE.has(action.action)) {
        stopped = stopFor(action)
        break
      }
      const outcome = await perform(deps, change, step, action)
      did.push(outcome.done)
      if (outcome.stop !== undefined) {
        stopped = outcome.stop
        break
      }
      progressed = true
    }
    if (!progressed && stopped === null) break
    const reread = await loadStepBlock(deps, change)
    if ('error' in reread) {
      deps.io.err(`ERROR: ${reread.error}`)
      return 1
    }
    step = reread
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify({ change, step_id: step.id, did, stopped, step }))
  } else {
    deps.io.out(`[STEP] ${change} · ${step.id}（${step.label}）`)
    deps.io.out(did.length === 0 ? '没有可批量做的事，什么都没改。' : `已做 ${did.filter((item) => item.ok).length}/${did.length} 项：`)
    for (const item of did) deps.io.out(`  [${item.ok ? 'OK' : 'FAIL'}] ${item.command} · ${item.detail}`)
    if (stopped !== null) deps.io.out(`停下：${stopped.reason}`)
    deps.io.out('下一步（step.next）：')
    for (const line of nextLines(step)) deps.io.out(`  ${line}`)
  }
  return stopped?.kind === 'error' ? 2 : 0
}
