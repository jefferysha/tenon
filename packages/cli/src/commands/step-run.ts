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
import { msg } from '../i18n/messages.js'
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
  const detail = ['event', 'kind', 'skill', 'agent', 'test', 'field']
    .map((key) => action[key]).find((value) => typeof value === 'string')
  return detail === undefined ? action.action : `${action.action} ${String(detail)}`
}

function stopFor(deps: CliDeps, action: StepAction): StepRunStop {
  const what = describeAction(action)
  if (HOST_ACTIONS.has(action.action)) return { kind: 'host', action: action.action, reason: msg(deps, 'step.stop.host', { what }) }
  return { kind: 'work', action: action.action, reason: msg(deps, 'step.stop.work', { what }) }
}

/** `done` 缺席 = 没有可做的事（例如骨架文件已经在），不进「已做」清单也不算推进。 */
interface Outcome { readonly done?: StepRunDone; readonly stop?: StepRunStop }

async function perform(deps: CliDeps, change: string, step: StepBlock, action: StepAction): Promise<Outcome> {
  const kind = String(action.kind)
  const path = typeof action.path === 'string' ? action.path : null
  const captured = capturing(deps)
  const finish = (command: string, code: number, success: string): Outcome => code === 0
    ? { done: { action: action.action, command, ok: true, detail: success } }
    : {
        done: { action: action.action, command, ok: false, detail: firstError(captured, msg(deps, 'step.detail.exitCode', { code })) },
        stop: { kind: 'error', action: action.action, reason: firstError(captured, msg(deps, 'step.stop.exitCode', { command, code })) },
      }
  switch (action.action) {
    case 'scaffold-document': {
      const command = `tenon document scaffold ${change} ${kind}`
      if (path === null) {
        return {
          done: { action: action.action, command, ok: false, detail: msg(deps, 'step.detail.pathUndecided') },
          stop: { kind: 'author', action: action.action, reason: msg(deps, 'step.stop.pathUndecided', { kind, change }) },
        }
      }
      if (existsSync(resolve(deps.cwd, path))) return {}
      return finish(command, await cmdDocumentScaffold(captured.deps, change, kind), captured.out.at(-1) ?? path)
    }
    case 'record-document': {
      const producers = Array.isArray(action.producers) ? action.producers.map(String) : []
      const command = `tenon document record ${change} ${kind} ${path ?? '<path>'} --producer ${pickProducer(producers, step.skills) ?? '<skill>'}`
      if (path !== null && !existsSync(resolve(deps.cwd, path))) {
        return {
          done: { action: action.action, command, ok: false, detail: msg(deps, 'step.detail.fileNotWritten') },
          stop: { kind: 'author', action: action.action, reason: msg(deps, 'step.stop.fileNotWritten', { path, change }) },
        }
      }
      const result = await recordOneDocument(deps, change, action, step.skills)
      if (result.outcome === 'recorded') return { done: { action: action.action, command, ok: true, detail: result.detail } }
      // 作者还没写完不是「做了又失败」：什么都没改，只说停在哪；真被拒才进「已做」清单。
      if (result.outcome === 'skipped') {
        return { stop: { kind: 'author', action: action.action, reason: msg(deps, 'step.stop.documentSkipped', { subject: path ?? kind, detail: result.detail, change }) } }
      }
      return {
        done: { action: action.action, command, ok: false, detail: result.detail },
        stop: { kind: 'error', action: action.action, reason: result.detail },
      }
    }
    case 'read-documents':
      return finish(`tenon document read ${change} all`, await cmdDocumentRead(captured.deps, change, 'all'), msg(deps, 'step.detail.readReceipt'))
    default:
      return finish(`tenon test plan ${change} --seed`, await cmdTestPlan(captured.deps, change, { seed: true }), msg(deps, 'step.detail.planSeeded'))
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
      stopped = first.action === 'stop' ? null : stopFor(deps, first)
      break
    }
    let progressed = false
    // 同一波里先铺完所有骨架，再登记：next 是一份文档一对 scaffold / record 地交替下发的，
    // 照原样走会在第一份文档的占位符上停下，后面的骨架就没铺。
    const wave = [...step.next.filter((action) => action.action === 'scaffold-document'),
      ...step.next.filter((action) => action.action !== 'scaffold-document')]
    for (const action of wave) {
      if (!BATCHABLE.has(action.action)) {
        stopped = stopFor(deps, action)
        break
      }
      const outcome = await perform(deps, change, step, action)
      if (outcome.done !== undefined) did.push(outcome.done)
      if (outcome.stop !== undefined) {
        stopped = outcome.stop
        break
      }
      if (outcome.done?.ok === true) progressed = true
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
    deps.io.out(msg(deps, 'step.run.header', { change, step: step.id, label: step.label }))
    deps.io.out(did.length === 0
      ? msg(deps, 'step.run.nothing')
      : msg(deps, 'step.run.done', { ok: did.filter((item) => item.ok).length, total: did.length }))
    for (const item of did) deps.io.out(`  [${item.ok ? 'OK' : 'FAIL'}] ${item.command} · ${item.detail}`)
    if (stopped !== null) deps.io.out(msg(deps, 'step.run.stopped', { reason: stopped.reason }))
    deps.io.out(msg(deps, 'step.run.next'))
    for (const line of nextLines(step)) deps.io.out(`  ${line}`)
  }
  return stopped?.kind === 'error' ? 2 : 0
}
