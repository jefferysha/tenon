/**
 * `next` 里与测试体系有关的动作。输入是 kernel 的策略判定（`TestEvidenceReport.policy`，
 * `tenon check` / transition / 工作台读的同一份），这里只把它的阻塞项归档成「下一步该做什么」：
 *
 *   discover → seed → map → register-files → run-tests → report
 *
 * 前四类是登记（目录 → 计划 → 场景与套件映射 → 测试文件），依赖前一类，所以一次只下发最靠前的一类；
 * `run-tests` 是按策略在当前代码上运行；`test-report` 把追溯矩阵写进验证报告；其余已经运行过却不满足
 * 策略的阻塞（用例失败、覆盖率不足、基准退化……）没有专门动作，交给 `fix` / 回退边。
 * 旧步骤测试（内联套件，id 以 `step:` 开头）仍走 `run-test`，不在这里。
 *
 * 顺序本身（排在文档之后、评审者之前）在 statusStepNext.ts 的 `stepNextActions`。
 */
import {
  INLINE_SUITE_PREFIX, renderTestBlocker, shellQuote,
  type TestBlocker, type TestPolicyReport,
} from '@tenon/kernel'
import type { StepAction } from './statusStepAction.js'
import type { StepBlocker, StepExit } from './stepExitReport.js'

export interface TestFlowItem {
  readonly code: string
  /** 涉及的对象：套件 id、种类、文件路径、场景 covers…… */
  readonly subject: string | null
  readonly message: string
  /** 可直接执行的修复命令。 */
  readonly fix: string | null
}

export interface TestFlowWaiver {
  readonly subject: string | null
  /** 与 exits[].blockers 里那条测试阻塞逐字相同，用来把它从「出口未就绪」里放行给 request-review。 */
  readonly message: string
}

export interface StepTestFlow {
  readonly discover: readonly TestFlowItem[]
  readonly seed: readonly TestFlowItem[]
  readonly map: readonly TestFlowItem[]
  readonly files: readonly TestFlowItem[]
  /** 没有新鲜运行（未运行 / 过期 / 记录被改动）：要 `tenon test run <c> --stage`。 */
  readonly run: readonly TestFlowItem[]
  /** 已经运行过却不满足策略：要改代码 / 环境，不是重跑。 */
  readonly failed: readonly TestFlowItem[]
  /** 等待评审批准的豁免（review request 列给用户，acknowledge 一并批准）。 */
  readonly waivers: readonly TestFlowWaiver[]
  /** 验证报告还没带上最新运行的追溯矩阵：要 `tenon test report <c> --write <path>`。 */
  readonly report: { readonly command: string; readonly path: string } | null
}

const SEED_CODES: ReadonlySet<string> = new Set(['test-plan-missing', 'test-plan-tampered'])
const MAP_CODES: ReadonlySet<string> = new Set(['test-kind-missing', 'scenario-uncovered'])
const FILE_CODES: ReadonlySet<string> = new Set(['test-file-unregistered', 'test-file-orphan'])
const RUN_CODES: ReadonlySet<string> = new Set(['test-not-run', 'test-stale', 'record-chain-broken'])
/** 已运行的阻塞里，就地能解开（不必改代码 / 退回实现）的那几类。 */
const IN_PLACE_CODES: ReadonlySet<string> = new Set(['baseline-missing'])

function toItem(blocker: TestBlocker): TestFlowItem {
  return { code: blocker.code, subject: blocker.subject ?? null, message: blocker.message, fix: blocker.fix ?? null }
}

/** 策略判定的阻塞项归档；未声明策略（report 缺席）= 没有测试体系动作。 */
export function classifyTestPolicy(report: TestPolicyReport | undefined): Omit<StepTestFlow, 'report'> {
  const discover: TestFlowItem[] = []
  const seed: TestFlowItem[] = []
  const map: TestFlowItem[] = []
  const files: TestFlowItem[] = []
  const run: TestFlowItem[] = []
  const failed: TestFlowItem[] = []
  const waivers: TestFlowWaiver[] = []
  for (const blocker of report?.blockers ?? []) {
    if (!blocker.blocking || blocker.subject?.startsWith(INLINE_SUITE_PREFIX) === true) continue
    if (blocker.code === 'waiver-unapproved') {
      waivers.push({ subject: blocker.subject ?? null, message: renderTestBlocker(blocker) })
    } else if (blocker.code === 'test-catalog-missing') {
      // 没有 subject = 目录本身缺失 / 无效；带 subject = 计划登记的套件已不在目录里。
      (blocker.subject === undefined ? discover : map).push(toItem(blocker))
    } else if (SEED_CODES.has(blocker.code)) {
      seed.push(toItem(blocker))
    } else if (MAP_CODES.has(blocker.code)) {
      map.push(toItem(blocker))
    } else if (FILE_CODES.has(blocker.code)) {
      files.push(toItem(blocker))
    } else if (RUN_CODES.has(blocker.code)) {
      run.push(toItem(blocker))
    } else {
      failed.push(toItem(blocker))
    }
  }
  return { discover, seed, map, files, run, failed, waivers }
}

/** 最新且新鲜（已判出通过 / 失败）的目录套件运行 id，去重。 */
export function freshRunIds(report: TestPolicyReport | undefined): readonly string[] {
  const ids = (report?.suites ?? [])
    .filter((suite) => suite.origin === 'catalog' && (suite.state === 'passed' || suite.state === 'failed'))
    .flatMap((suite) => suite.run_id === undefined ? [] : [suite.run_id])
  return [...new Set(ids)]
}

/**
 * 验证报告是否已带上这些运行的追溯矩阵：`tenon test report --write` 写进去的矩阵引用每个套件的最新运行 id，
 * 报告里找不到其中任何一个就是还没写（或写的是更早的运行）。判定收在这一个函数里。
 */
export function reportCarriesRuns(reportText: string, runIds: readonly string[]): boolean {
  return runIds.every((id) => reportText.includes(id))
}

/** 登记类动作：一次只下发最靠前的一类（后一类依赖前一类）。 */
export function testPlanningActions(change: string, flow: StepTestFlow): readonly StepAction[] {
  if (flow.discover.length > 0) {
    return [{
      action: 'test-discover',
      command: flow.discover[0]?.fix ?? 'tenon test discover --write',
      blockers: flow.discover,
    }]
  }
  if (flow.seed.length > 0) {
    return [{ action: 'test-plan-seed', command: `tenon test plan ${change} --seed`, blockers: flow.seed }]
  }
  if (flow.map.length > 0) {
    return [{ action: 'test-plan-map', show: `tenon test plan ${change} --json`, items: flow.map }]
  }
  if (flow.files.length > 0) return [{ action: 'test-register-files', files: flow.files }]
  return []
}

export function runTestsAction(change: string, flow: StepTestFlow): readonly StepAction[] {
  if (flow.run.length === 0) return []
  return [{ action: 'run-tests', command: `tenon test run ${change} --stage`, suites: flow.run }]
}

export function testReportAction(flow: StepTestFlow): readonly StepAction[] {
  return flow.report === null
    ? []
    : [{ action: 'test-report', command: flow.report.command, path: flow.report.path }]
}

/** 失败要靠改代码解决（而不是就地补一步）：评审门上这是走回退边的理由。 */
export function testsNeedRollback(flow: StepTestFlow | undefined): boolean {
  return flow !== undefined && flow.failed.some((item) => !IN_PLACE_CODES.has(item.code))
}

/** 已经运行却不满足策略的阻塞：交给 `fix`（带修复命令），不再往下发评审者。 */
export function failedTestsAction(flow: StepTestFlow): readonly StepAction[] {
  if (flow.failed.length === 0) return []
  const blockers: readonly StepBlocker[] = flow.failed.map((item) => ({
    source: 'test',
    code: item.code,
    message: item.fix === null ? item.message : `${item.message}；执行 ${item.fix}`,
  }))
  return [{ action: 'fix', blockers }]
}

/**
 * 评审门上，只剩「豁免待批准」挡着的前进边算就绪：这次评审的确认正是批准它们（review request 列出、
 * acknowledge 同一次批准）。评审已经批准（approved）或不是评审门时不放行——豁免没有别的批准途径。
 */
export function releaseWaiverBlockers(
  exits: readonly StepExit[],
  flow: StepTestFlow | undefined,
  gate: string | null,
  reviewStatus: string,
): readonly StepExit[] {
  if (flow === undefined || flow.waivers.length === 0 || gate !== 'review' || reviewStatus === 'approved') return exits
  const waiting = new Set(flow.waivers.map((waiver) => waiver.message))
  return exits.map((exit) => {
    if (exit.direction === 'back') return exit
    const blockers = exit.blockers.filter((blocker) => !(blocker.source === 'test' && waiting.has(blocker.message)))
    return blockers.length === exit.blockers.length ? exit : { ...exit, blockers, ready: blockers.length === 0 }
  })
}

/** 指向验证报告的写入命令。 */
export function testReportCommand(change: string, path: string): string {
  return `tenon test report ${change} --write ${shellQuote(path)}`
}
