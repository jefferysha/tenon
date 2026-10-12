/**
 * `tenon loop run <loop-id|pattern>` —— H14 loop 定向发起（★硬需求收口起点）。
 *
 * `--dry-run` 只读预览：零状态写 / 零 docker / 零 git / 零 ledger 写。real-run 每次 fresh 扫描
 * ready FIFO、现读 durable loop ledger，以「最新显式 binding → 最长前缀」解析自然归属，再只把命中
 * selector 的 TargetedRunCandidate 交给共享 `runAfkRound`。Docker/worktree/skill snapshot/verifier/
 * settlement/commit 全复用 AFK 生产链，不在命令里另造第二套执行器。
 *
 * selector：① 精确 loop-id（id 完全相等）；② glob（含 `*` → 通配匹配 id）。多命中全部纳入；
 * 零命中 → stderr + exit 1。real-run 只筛自然归属，不替 change 强塞归属。
 *
 * 预览字段与来源（同源复用，绝不各写一份漂移）：
 *   · admission 判定 ← loop-admission-view.ts::admissionProbe（= loops status/budget 同一 admissionDecision）。
 *   · level        ← --level 显式值，否则 loop.autonomy_level（缺省 L1）。
 *   · runner       ← LoopEntry.runner（自由字符串）。
 *   · settlement   ← automation settleSuccess(level)：L3→merge-back / L1|L2→paused。
 *   · reserved 预占 ← kernel reservedTokensFor(loop)（budget.tokens_per_run 优先，否则 risk 预设）。
 *   · image        ← 非 loop 级字段（LoopEntry 无 image）：afk run 时由 --image/.pipeline/automation.json/
 *                    默认 sandcastle:local 决定，故预览里 image=null + note 说明。
 *   · skill_bundle  ← H10 §6/§8任务7 唯一 wiring 判定 evaluateSkillBundleWiring（loop-admission-
 *                    view.ts）：bundle id / unwired-invalid-ready 三态 / 阻断 reason。只读静态
 *                    解析 + locator.locate() 只读探测——不建 CAS、不写 ledger、不暂停 loop、零状态
 *                    写（设计定稿 §6：dry-run 不物化快照或写 registry）。
 */
import { homedir } from 'node:os'
import {
  createLoopLedgerStore,
  type LedgerReadResult,
  type LoopEntry,
} from '@tenon/kernel'
import {
  createAutomation,
  type AutomationLevel,
  type LoopExecutionGuardResult,
} from '@tenon/automation'
import type { CliDeps } from '../deps.js'
import { createProductionSkillContentLocator } from '../skillBundleAssembly.js'
import {
  admissionProbe, evaluateSkillBundleWiring, ledgerProjections,
  type LedgerProjector, type SkillBundleWiringDeps,
} from './loop-admission-view.js'
import {
  enforceProductionLoopWiring,
  runAfkRound,
  type AfkRoundExecutionResult,
  type RunAfkRoundOptions,
} from './afk-executor.js'
import { selectTargetedRunCandidates, type TargetedRunCandidate } from './loop-run-selection.js'
import type { LoopsFs } from './loops.js'
import {
  buildPreview,
  COMMIT_NOTE,
  isAutomationLevel,
  parseLoopRunArgs,
  renderExecutionGroup,
  renderPreview,
  resultOk,
  selectLoops,
  type ExecutionGroup,
  type LoopRunPreviewJson,
} from './loop-run-view.js'

export type { LoopRunPreviewJson } from './loop-run-view.js'

export interface LoopRunRuntime {
  /** H11 active starter 的 scan 前 fresh wiring + governance pause backstop。 */
  enforceLoopWiring?: (
    deps: CliDeps,
    loopIds: readonly string[],
  ) => Promise<LoopExecutionGuardResult>
  /** 每次 real-run 都现扫 ready FIFO；测试在这个系统边界注入，避免触碰 Docker。 */
  scanReady(deps: CliDeps): Promise<readonly string[]>
  /** selector 前现读 durable loop ledger，坏行由调用方 fail-closed。 */
  readLedger(repoRoot: string): Promise<LedgerReadResult>
  /** 共享 AFK 真执行器；负责 admission→Docker→verify→settlement→commit。 */
  runAfkRound(
    deps: CliDeps,
    input: RunAfkRoundOptions & { readonly targets: readonly TargetedRunCandidate[] },
  ): Promise<AfkRoundExecutionResult>
}

const DEFAULT_LOOP_RUN_RUNTIME: LoopRunRuntime = {
  scanReady: (deps) => createAutomation({
    repoRoot: deps.cwd,
    store: deps.store,
    clock: deps.clock,
    config: { level: 'L1' },
  }).scanReady(),
  readLedger: (repoRoot) => createLoopLedgerStore().read(repoRoot),
  runAfkRound,
}


/**
 * `wiringDeps` 缺省真装配（H10 §8任务7）：resolver=deps.resolver（G2 P5 同一 EffectiveSkillResolver，
 * 不另装一份）；isSkillProfileKnown=deps.isSkillProfileKnown（main.ts/harness 装配的
 * skillProfileChecker 判定，见 deps.ts 头注）；locator 用与 afk.ts cmdAfk('run') 同一套根枚举
 * （createProductionSkillContentLocator，见 skillBundleAssembly.ts）——dry-run 只读 locate()（stat/
 * realpath），不物化 CAS。
 */
function defaultSkillBundleWiringDeps(deps: CliDeps, runner: string): SkillBundleWiringDeps {
  return {
    isSkillProfileKnown: deps.isSkillProfileKnown,
    resolver: deps.resolver,
    locator: createProductionSkillContentLocator({
      pluginRoot: deps.doctor?.pluginRoot, home: homedir(), runner,
    }),
  }
}

export type SkillBundleWiringProvider =
  | SkillBundleWiringDeps
  | ((loop: LoopEntry) => SkillBundleWiringDeps)

/**
 * `tenon loop run <loop-id|pattern>` 分派体（cmdLoops 'run' 分派目标）。
 * fs 由 cmdLoops 注入（缺省 REAL_LOOPS_FS）；projectLedger 缺省真 ledger 投影，测试注入 fake（不碰真 IO）。
 * wiringDeps 缺省真装配（defaultSkillBundleWiringDeps，H10 §8任务7），测试注入 fake resolver/locator。
 */
export async function cmdLoopRun(
  deps: CliDeps,
  args: string[],
  fs: LoopsFs,
  projectLedger: LedgerProjector = ledgerProjections,
  wiringDeps: SkillBundleWiringProvider = (loop) => defaultSkillBundleWiringDeps(deps, loop.runner),
  runtime: LoopRunRuntime = DEFAULT_LOOP_RUN_RUNTIME,
): Promise<number> {
  const p = parseLoopRunArgs(args)

  if (p.error !== undefined) {
    deps.io.err(`ERROR: ${p.error}`)
    return 1
  }

  // selector 必填（缺 → 用法错误）
  if (p.selector === null || p.selector === '') {
    deps.io.err('ERROR: loops run 需要 <loop-id|pattern>——用法: tenon loop run <loop-id|pattern> [--dry-run] [--level L1|L2|L3] [--commit] [--json]')
    return 1
  }

  // --level 校验（给了就必须合法；非法即停，不预览）
  let explicitLevel: AutomationLevel | undefined
  if (p.level !== undefined) {
    if (!isAutomationLevel(p.level)) {
      deps.io.err(`ERROR: --level 需 L1|L2|L3，收到 '${p.level}'`)
      return 1
    }
    explicitLevel = p.level
  }

  // 登记表（只读）：损坏 → 定位错误 exit 1；缺失 → exit 1。
  const { data: reg, errors } = fs.loadRegistry(deps.cwd)
  if (errors.length > 0) {
    for (const e of errors) deps.io.err(`ERROR: ${e}`)
    return 1
  }
  if (reg === null) {
    deps.io.err('ERROR: .pipeline/loops.yaml 未找到——无 loop 登记表可预览（先 tenon loops init 起草一个 loop）')
    return 1
  }

  // selector 匹配：零命中 → stderr + exit 1（不做 change→loop 反查——那是 afk 的职责）
  const matched = selectLoops(reg.loops, p.selector)
  if (matched.length === 0) {
    deps.io.err(`ERROR: 选择器「${p.selector}」未命中任何 loop（登记表共 ${reg.loops.length} 个）。精确 id 需完全相等；glob 用「*」通配。不做 change→loop 反查（那是 afk 的职责）。`)
    return 1
  }

  if (!p.dryRun) {
    // H11：只要 selector 命中 active starter，就必须在“当前是否有 ready change”之前 fresh 复验。
    // 这封住了 invalid active starter 在空队列时长期伪装 active，以及 scan/reservation/Docker 旁路。
    const activeStarterIds = matched
      .filter((loop) => loop.status === 'active' && loop.template_id !== undefined)
      .map((loop) => loop.id)
    if (activeStarterIds.length > 0) {
      let guard: LoopExecutionGuardResult
      try {
        guard = runtime.enforceLoopWiring === undefined
          ? await enforceProductionLoopWiring(deps, activeStarterIds)
          : await runtime.enforceLoopWiring(deps, activeStarterIds)
      } catch (error) {
        deps.io.err(
          `ERROR: loop execution wiring guard 失败：${error instanceof Error ? error.message : String(error)}`,
        )
        return 1
      }
      if (guard.blocked.length > 0) {
        for (const block of guard.blocked) {
          deps.io.err(
            `ERROR: loop「${block.loopId}」wiring ${block.status}（${block.dimension}）：${block.reason}；已治理暂停`,
          )
        }
        return 1
      }
    }

    let readyChanges: readonly string[]
    let ledger: LedgerReadResult
    try {
      readyChanges = await runtime.scanReady(deps)
      ledger = await runtime.readLedger(deps.cwd)
    } catch (error) {
      deps.io.err(`ERROR: loop real-run preflight 失败：${error instanceof Error ? error.message : String(error)}`)
      return 1
    }

    if (ledger.rejected.length > 0) {
      deps.io.err(`ERROR: loop ledger 含 ${ledger.rejected.length} 条坏行，拒绝在不完整归属事实上执行`)
      return 1
    }

    const selected = selectTargetedRunCandidates({
      selectedLoopIds: matched.map((entry) => entry.id),
      readyChanges,
      loops: reg.loops,
      ledgerRecords: ledger.records,
    })
    if (!selected.ok) {
      deps.io.err(`ERROR: change「${selected.error.change}」归属不可判定（${selected.error.reason}）：${selected.error.detail}`)
      return 1
    }
    if (selected.targets.length === 0) {
      if (p.json) {
        deps.io.out(JSON.stringify({
          dry_run: false,
          selector: p.selector,
          matched_loops: matched.map((entry) => entry.id),
          ready: readyChanges.length,
          selected: 0,
          commit: { requested: p.commit, enforced: true },
          groups: [],
          ok: true,
        }, null, 2))
      } else {
        deps.io.out(`[loops run] 选择器「${p.selector}」当前无 ready change`)
      }
      return 0
    }

    const loopById = new Map(reg.loops.map((entry) => [entry.id, entry]))
    const groups = new Map<AutomationLevel, TargetedRunCandidate[]>()
    for (const target of selected.targets) {
      const entry = loopById.get(target.expectedLoopId)
      if (entry === undefined) {
        deps.io.err(`ERROR: 已解析归属 loop「${target.expectedLoopId}」不在当前 registry`)
        return 1
      }
      const level = explicitLevel ?? entry.autonomy_level
      const group = groups.get(level) ?? []
      group.push(explicitLevel === undefined
        ? target
        : { ...target, expectedAutonomyLevel: null })
      groups.set(level, group)
    }

    const executionGroups: ExecutionGroup[] = []
    for (const [level, targets] of groups) {
      try {
        const result = await runtime.runAfkRound(deps, { level, targets })
        executionGroups.push({ level, targets, result })
      } catch (error) {
        executionGroups.push({
          level,
          targets,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const ok = executionGroups.every((group) => 'result' in group && resultOk(group.result))
    if (p.json) {
      deps.io.out(JSON.stringify({
        dry_run: false,
        selector: p.selector,
        matched_loops: matched.map((entry) => entry.id),
        ready: readyChanges.length,
        selected: selected.targets.length,
        commit: { requested: p.commit, enforced: true },
        groups: executionGroups,
        ok,
      }, null, 2))
    } else {
      for (const group of executionGroups) renderExecutionGroup(deps, group)
      deps.io.out(
        `[loops run] commit=enforced（--commit ${p.commit ? '已显式请求' : '未传也不弱化'}）；` +
        `选择 ${selected.targets.length} 个 ready change，结果=${ok ? 'ok' : 'failed'}`,
      )
    }
    return ok ? 0 : 1
  }

  // ledger 投影（与 loops status/budget 同源；测试注入 fake 投影，绝不碰真 IO）
  const now = new Date(deps.clock())
  const { byId, missing } = await projectLedger(deps.cwd, matched.map((l) => l.id), now)

  // H10 §6：skill bundle wiring 判定（evaluateSkillBundleWiring 是本函数唯一消费点，见其头注
  // 「H11 只消费该 evaluator，不复制判断逻辑」）——纯读、逐 loop 静态解析 + locator 只读探测。
  const previews = await Promise.all(matched.map(async (l) => {
    const proj = byId.get(l.id)
    if (proj === undefined) {
      throw new Error(`loop '${l.id}' 缺 ledger projection`)
    }
    const admission = admissionProbe(l, proj)
    const ledgerHealth: LoopRunPreviewJson['ledger_health'] = missing ? 'missing' : proj.health
    const wiring = await evaluateSkillBundleWiring(
      l,
      typeof wiringDeps === 'function' ? wiringDeps(l) : wiringDeps,
    )
    return buildPreview(l, admission, ledgerHealth, explicitLevel, wiring)
  }))

  if (p.json) {
    deps.io.out(JSON.stringify({
      dry_run: true,
      commit_ignored: p.commit,
      selector: p.selector,
      matched: previews.length,
      previews,
    }, null, 2))
    return 0
  }

  deps.io.out(`[loops run · dry-run] 选择器「${p.selector}」命中 ${previews.length} 个 loop（只读预览：不改盘 / 不 docker / 不 merge）`)
  if (p.commit) deps.io.out(`  注意：${COMMIT_NOTE}`)
  for (const pv of previews) renderPreview(deps, pv)
  return 0
}
