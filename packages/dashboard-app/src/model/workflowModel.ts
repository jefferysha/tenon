/**
 * workflowModel —— G17 根治的核心抽象（spec §2.1）：把「一个 change 此刻遵循哪套阶段规则」
 * 收敛成统一的 WorkflowRules，views（看板/收件箱/events）从此只消费本模块，不再直接
 * import types.ts 的四个 default 常量。
 *
 * 混合模型（拍板决定 D7）：
 *   · 'default' → 内置常量投影（DEFAULT_RULES，零网络）——常量本体留在 types.ts 不动，
 *     board/transition-mirror.test.ts 对 kernel 单源的守卫零改动；
 *   · 自定义名 → 既有 GET /api/workflows/:name?root= 拉取 WorkflowDef 后映射，
 *     按 (root,name) 模块级缓存 + in-flight 去重；拉取失败进 errors（views 优雅降级：
 *     卡片仍可见但只读，G17 的底线是「任何情况下卡不消失」）。
 */
import { useEffect, useMemo, useState } from 'react'
import { fetchWorkflow } from '../api/client'
import type { WbGuardConfig } from '../api/governanceTypes'
import type { Snapshot } from '../types'
import { isProjectNavigable } from '../state/projectSelectionModel'
import { EVENT_BY_EDGE, PHASES, REVIEW_PHASES, TRANSITIONS } from '../types'

// ── kernel WorkflowDef/StepDef 的 JSON 形状（跨 HTTP 边界手抄，不 import kernel 类型只为了
//    编译期形状——原单一真相源 workflow/StepDetailPanel.tsx 随 T18 退役，声明迁入本模块；
//    workbench/WorkbenchView.tsx 的 Wb* 系列是同形状的视图层手抄，两处各自消费）──
export interface FieldRef { field: string; type: 'string' | 'file_path' | 'boolean' }
export interface SkillRef { id: string; depends_on?: string[] }
export type GuardConfig = WbGuardConfig
export interface StepTransition { event: string; to: string }
export interface StepDef {
  id: string; label: string; gate: 'review' | 'auto' | null
  skills: SkillRef[]; inputs: FieldRef[]; outputs: FieldRef[]
  guards: GuardConfig[]; transitions: StepTransition[]
}

export interface WorkflowRules {
  /**
   * Compiled execution capability projected by the server. Consumers branch on this closed
   * capability instead of reconstructing built-in workflow identity from a name or graph shape.
   * Older in-memory test fixtures may omit it and are treated as step-graph/custom semantics.
   */
  executionModel?: 'phase-manifest' | 'step-graph'
  steps: readonly string[]
  /** from step id → 出边列表（event 名 + 目标 step）。 */
  transitions: Record<string, readonly { event: string; to: string }[]>
  gateByStep: Record<string, 'review' | 'auto' | null>
  /**
   * step id → 展示名（StepDef.label；未声明时规范化为 step id）。服务端 snapshot 中该表
   * 必须与 steps 精确同键，避免边界解码后再把不完整对象断言成完整 Record；本地 default
   * 规则仍可省略该表并走 phases.* i18n。
   * 与 gateByStep 同为「每 step 属性表」，故直接挂 WorkflowRules 而非另立扩展接口——ProgressRules
   * = WorkflowRules & StepOutputRules 已含本接口全部字段，箭头带（消费 ProgressRules）随之自然
   * 可见，无需改动 progressModel 的组合面。可选：既有 default/其它 WorkflowRules 构造者不受牵动。
   */
  labelByStep?: Record<string, string>
}

/**
 * WorkflowRules 的可选产出扩展面（T6 在 progressModel 定契约，T7 落到这里成为单一定义源，
 * progressModel 原地 re-export 不破既有 import 面）——「自定义 workflow 的 nonempty-output
 * 每 step 产出声明。按 Track 求值后的必需输出属于 Change.workflowExecution，不属于这份
 * 不可变 plan 结构；否则同一冻结 plan 会被不同 Track 的合法结果撕裂。
 */
export interface StepOutputRules {
  /** step id → 该步声明的 outputs 字段名列表。 */
  outputsByStep?: Record<string, readonly string[]>
}

function buildDefaultRules(): WorkflowRules {
  const transitions: Record<string, { event: string; to: string }[]> = {}
  const gateByStep: Record<string, 'review' | 'auto' | null> = {}
  for (const from of PHASES) {
    transitions[from] = TRANSITIONS[from]
      .filter((to) => to !== from) // archive→archive 自环不是可操作出边
      .flatMap((to) => {
        const event = EVENT_BY_EDGE[`${from}->${to}`]
        return event === undefined ? [] : [{ event, to }]
      })
    gateByStep[from] = (REVIEW_PHASES as readonly string[]).includes(from) ? 'review' : null
  }
  return { executionModel: 'phase-manifest', steps: PHASES, transitions, gateByStep }
}

export const DEFAULT_RULES: WorkflowRules = buildDefaultRules()

export function workflowRulesFromSnapshot(
  snapshot: Snapshot | null,
): ReadonlyMap<string, WorkflowRules> {
  const rules = new Map<string, WorkflowRules>()
  for (const project of snapshot?.projects ?? []) {
    if (!isProjectNavigable(project)) continue
    for (const change of project.changes) {
      rules.set(snapshotRulesKey(project.root, change.workflowPlanFingerprint), change.workflowRules)
    }
  }
  return rules
}

export function rulesFromDef(def: { name: string; steps: StepDef[] }): WorkflowRules & StepOutputRules {
  const transitions: Record<string, { event: string; to: string }[]> = {}
  const gateByStep: Record<string, 'review' | 'auto' | null> = {}
  const outputsByStep: Record<string, readonly string[]> = {}
  const labelByStep: Record<string, string> = {}
  for (const s of def.steps) {
    transitions[s.id] = s.transitions.map((t) => ({ event: t.event, to: t.to }))
    gateByStep[s.id] = s.gate
    outputsByStep[s.id] = s.outputs.map((o) => o.field)
    labelByStep[s.id] = s.label || s.id
  }
  return {
    executionModel: 'step-graph',
    steps: def.steps.map((s) => s.id),
    transitions,
    gateByStep,
    outputsByStep,
    labelByStep,
  }
}

// ── (root,name) 模块级缓存 + in-flight 去重 ──
const cache = new Map<string, WorkflowRules>()
const inflight = new Map<string, Promise<WorkflowRules>>()

/**
 * (root,wf) → 组合键。Task 8（G19③）把原模块私有的 cacheKey 升格导出改名 rulesKey：
 * inbox.ts 的 selectInbox 第三参、InboxView 的行内 rules 查找都改按这把键索引（同名自定义
 * workflow 跨项目不再共享一个 key）；也是 useWorkflowRulesMulti 返回的 rules/errors Map 的
 * 键格式，供 Task 11（看板聚合）逐字复用。
 * 实现体（下面的 return 行）原样未动——它用的分隔符不是看起来的空格，是一个 NUL 字符（避免
 * 与真实 root 路径里可能出现的空格冲突；文件系统路径不可能含 NUL，NUL 因此是比空格更安全的
 * 分隔符）。消费方一律通过本函数取键，不要自己拼接字符串——分隔符具体是什么字符不对外承诺。
 */
export function rulesKey(root: string, name: string): string {
  return `${root}\u0000${name}`
}

export function isBuiltinWorkflowName(name: string): boolean {
  return name === 'default'
}

/** Frozen Change snapshots are keyed by immutable plan identity, never by mutable workflow name. */
export function snapshotRulesKey(root: string, workflowPlanFingerprint: string): string {
  return `${root}\u0000plan:${workflowPlanFingerprint}`
}

async function fetchRules(root: string, name: string): Promise<WorkflowRules> {
  const key = rulesKey(root, name)
  const hit = cache.get(key)
  if (hit) return hit
  const pending = inflight.get(key)
  if (pending) return pending
  const p = (async () => {
    const def = await fetchWorkflow(name, root)
    const rules = rulesFromDef(def)
    cache.set(key, rules)
    return rules
  })()
  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
  }
}

/** 编辑器保存成功后的失效路径：无参=全清（测试隔离用）；带参=精确失效。 */
export function invalidateWorkflowRules(root?: string, name?: string): void {
  if (root === undefined) {
    cache.clear()
    inflight.clear()
    return
  }
  if (name === undefined) {
    for (const key of [...cache.keys()]) if (key.startsWith(`${root}\u0000`)) cache.delete(key)
    return
  }
  cache.delete(rulesKey(root, name))
}

export interface UseWorkflowRulesResult {
  rules: Map<string, WorkflowRules>
  errors: Map<string, string>
  loading: boolean
}

/**
 * 给定 snapshot 中出现的 workflow 名集合，返回逐名的 rules。'default' 恒命中 DEFAULT_RULES；
 * 自定义名首次触发 fetch，后续命中缓存。names 参与依赖比较用其拼接串（调用方每次 render
 * 传新数组也不会抖动重拉）。
 */
export function useWorkflowRules(root: string, names: readonly string[]): UseWorkflowRulesResult {
  const namesKey = [...new Set(names)].sort().join('\u0000')
  const [tick, setTick] = useState(0)
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    const wanted = namesKey ? namesKey.split('\u0000') : []
    const missing = wanted.filter((n) => n !== 'default' && !cache.has(rulesKey(root, n)))
    if (missing.length === 0) return
    let cancelled = false
    setPendingCount((c) => c + missing.length)
    for (const name of missing) {
      void fetchRules(root, name)
        .then(() => {
          if (cancelled) return
          setErrors((prev) => {
            if (!prev.has(name)) return prev
            const next = new Map(prev)
            next.delete(name)
            return next
          })
          setTick((n) => n + 1)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setErrors((prev) => new Map(prev).set(name, e instanceof Error ? e.message : String(e)))
        })
        .finally(() => {
          if (!cancelled) setPendingCount((c) => c - 1)
        })
    }
    return () => {
      cancelled = true
    }
  }, [root, namesKey])

  return useMemo(() => {
    void tick // 缓存写入后触发重算
    const rules = new Map<string, WorkflowRules>()
    for (const name of namesKey ? namesKey.split('\u0000') : []) {
      if (name === 'default') {
        rules.set('default', DEFAULT_RULES)
      } else {
        const hit = cache.get(rulesKey(root, name))
        if (hit) rules.set(name, hit)
      }
    }
    return { rules, errors, loading: pendingCount > 0 }
  }, [root, namesKey, tick, errors, pendingCount])
}

/** pairs → 稳定依赖串：root 排序 + 各自 names 去重排序后 JSON 序列化。选 JSON 而不是手拼分隔符
 *  ——root 是真实文件系统路径，理论上可以包含任意字符（包括空格），JSON 字符串转义本身就正确
 *  处理这些情况，不必再发明一套自定义分隔符约定。调用方每次 render 传新数组字面量也不会抖动
 *  重拉（内容相同 → 字符串相同），同 useWorkflowRules 的 namesKey 是同一个设计意图。 */
function encodePairsKey(pairs: readonly { root: string; names: readonly string[] }[]): string {
  const byRoot = new Map<string, Set<string>>()
  for (const { root, names } of pairs) {
    const set = byRoot.get(root) ?? new Set<string>()
    for (const n of names) set.add(n)
    byRoot.set(root, set)
  }
  const roots = [...byRoot.keys()].sort()
  return JSON.stringify(roots.map((root) => [root, [...(byRoot.get(root) ?? [])].sort()] as const))
}

function decodePairsKey(key: string): { root: string; name: string }[] {
  const parsed = JSON.parse(key) as [string, string[]][]
  const out: { root: string; name: string }[] = []
  for (const [root, names] of parsed) {
    for (const name of names) out.push({ root, name })
  }
  return out
}

/**
 * 多 (root, wf 名集合) 组合版本——G19③（Task 8）收件箱聚合语境（currentRoot===''）的消费入口，
 * 也是 Task 11 看板聚合的消费契约（签名逐字：pairs 里每项 {root, names}）。内部复用
 * fetchRules/模块级 cache/inflight（不重新实现拉取/缓存逻辑，是上面 useWorkflowRules 的同款
 * 设计推广到多 root）：'default' 恒零网络直接投影 DEFAULT_RULES（不同 root 的 'default' 条目
 * 指向同一个对象引用，可用 === 比较）；自定义名按 (root,name) 各自独立 fetch+缓存，同名 wf
 * 出现在不同 root 下不会互相覆盖或串缓存——这正是 rulesKey(root,wf) 要解决的问题。
 * 返回的 rules/errors 两个 Map 都按 rulesKey(root,wf) 索引（不是裸 wf 名）。
 */
export function useWorkflowRulesMulti(
  pairs: readonly { root: string; names: readonly string[] }[],
): UseWorkflowRulesResult {
  const pairsKey = encodePairsKey(pairs)
  const [tick, setTick] = useState(0)
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [pendingCount, setPendingCount] = useState(0)

  useEffect(() => {
    const wanted = decodePairsKey(pairsKey)
    const missing = wanted.filter(({ root, name }) => name !== 'default' && !cache.has(rulesKey(root, name)))
    if (missing.length === 0) return
    let cancelled = false
    setPendingCount((c) => c + missing.length)
    for (const { root, name } of missing) {
      const key = rulesKey(root, name)
      void fetchRules(root, name)
        .then(() => {
          if (cancelled) return
          setErrors((prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          })
          setTick((n) => n + 1)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setErrors((prev) => new Map(prev).set(key, e instanceof Error ? e.message : String(e)))
        })
        .finally(() => {
          if (!cancelled) setPendingCount((c) => c - 1)
        })
    }
    return () => {
      cancelled = true
    }
  }, [pairsKey])

  return useMemo(() => {
    void tick // 缓存写入后触发重算
    const rules = new Map<string, WorkflowRules>()
    for (const { root, name } of decodePairsKey(pairsKey)) {
      const key = rulesKey(root, name)
      if (name === 'default') {
        rules.set(key, DEFAULT_RULES)
      } else {
        const hit = cache.get(key)
        if (hit) rules.set(key, hit)
      }
    }
    return { rules, errors, loading: pendingCount > 0 }
  }, [pairsKey, tick, errors, pendingCount])
}
