/**
 * afk 域 —— AFK Sandcastle 指挥面数据端 + 写回（BACKLOG #29d / GOAL A5，afk-workbench Task 4 起加写）。
 *
 * 聚合各 change 的 automation_* 字段（kernel StateStore 已随 snapshot 读进 change.fields）→
 *   ① AFK 泳道数据：queued / running / merged / failed / conflict / paused；
 *   ② 调度器 doctor 灯：健康摘要（ok / busy / attention）；
 *   ③ 调度器流水 log：从 automation_queued_at / automation_last_error 派生的活动流；
 *   ④ cancelAfkRun（afk-workbench Task 4）：POST /api/afk/:name/cancel 的写回逻辑——落取消标记
 *     文件 + docker kill 容器，见该函数头注释；
 *   ⑤ retryAfkRun（afk-workbench Task 5）：POST /api/afk/:name/retry 的写回逻辑——CAS
 *     automation→queued + 清零 automation_attempts，见该函数头注释；
 *   ⑥ readAfkRunLog（afk-workbench Task 6）：GET /api/afk/:name/log 的读取逻辑——原样读出
 *     宿主侧持久化的 .sandcastle-run.log 原始文本，见该函数头注释。
 *
 * server 通过 automation 包公共出口消费跨上下文常量，不复制运行时协议。
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AUTOMATION_STATES, CANCEL_MARKER_FILE, type AutomationState } from '@tenon/automation'
import { stateStorageExistsSync, type StateStore } from '@tenon/kernel'
import type { ListSnapshot } from './snapshotListTypes.js'

/** AFK 泳道（对位 automation AUTOMATION_STATES 的活跃子集；off 不入板，scheduled 归 running，见 laneOf）。 */
export const AFK_LANES = ['queued', 'running', 'merged', 'failed', 'conflict', 'paused'] as const
export type AfkLane = (typeof AFK_LANES)[number]

export interface AfkCard {
  name: string
  root: string
  path: string
  phase: string
  /** 原始 automation 字段值（含 scheduled 等未折叠态）。 */
  automation: string
  lane: AfkLane
  attempts: number
  queued_at: string
  last_error: string
  sandbox: string
  worktree: string
  preserved_path: string
  /** F-b：结构化失败成因（automation_cause 原样透传，开放集）。空串 = 写入端未落/老数据 →
   *  前端回落 last_error regex 诊断（契约：读取端不校验值域，两端可独立演进）。 */
  cause: string
}

/** 调度器 doctor 灯：ok（无活跃）/ busy（有排队或在跑）/ attention（有 failed/conflict 待人工）。 */
export interface SchedulerHealth {
  status: 'ok' | 'busy' | 'attention'
  queued: number
  running: number
  merged: number
  failed: number
  conflict: number
  paused: number
  /** 非 off 的 change 总数（进入过自动化路径的）。 */
  total: number
  message: string
}

export interface AfkSnapshot {
  generated_at: string
  scheduler: SchedulerHealth
  lanes: Record<AfkLane, AfkCard[]>
  cards: AfkCard[]
}

export interface AfkLogEntry {
  ts: string
  name: string
  root: string
  automation: string
  kind: 'queued' | 'error' | 'state'
  detail: string
}

export interface AfkLog {
  generated_at: string
  entries: AfkLogEntry[]
}

function isAutomationState(value: string): value is AutomationState {
  return (AUTOMATION_STATES as readonly string[]).includes(value)
}

function str(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(',')
  return v ?? ''
}

/** automation 态 → 泳道。off / 空 / 未知 → null（不入板）；scheduled（已认领在飞）→ running。 */
export function laneOf(automation: string): AfkLane | null {
  if (!isAutomationState(automation)) return null
  switch (automation) {
    case 'queued':
      return 'queued'
    case 'scheduled':
    case 'running':
      return 'running'
    case 'merged':
      return 'merged'
    case 'failed':
      return 'failed'
    case 'conflict':
      return 'conflict'
    case 'paused':
      return 'paused'
    default:
      return null
  }
}

function emptyLanes(): Record<AfkLane, AfkCard[]> {
  return { queued: [], running: [], merged: [], failed: [], conflict: [], paused: [] }
}

/** 从一个 change 投影（automation=off/未知 → null，不入板）。 */
function cardOf(root: string, c: ListSnapshot['projects'][number]['changes'][number]): AfkCard | null {
  const automation = str(c.fields.automation)
  const lane = laneOf(automation)
  if (!lane) return null
  const attemptsRaw = Number(str(c.fields.automation_attempts) || '0')
  return {
    name: c.name,
    root,
    path: c.path,
    phase: c.phase,
    automation,
    lane,
    attempts: Number.isFinite(attemptsRaw) ? attemptsRaw : 0,
    queued_at: str(c.fields.automation_queued_at),
    last_error: str(c.fields.automation_last_error),
    sandbox: str(c.fields.automation_sandbox),
    worktree: str(c.fields.automation_worktree),
    preserved_path: str(c.fields.automation_preserved_path),
    // F-b：宽索引访问而非 c.fields.automation_cause——server 不把编译耦合到 kernel FieldName
    // 是否已收录该键（写入端并行落 FIELD_ORDER，两端独立可发布）；缺字段 → str(undefined) = ''，
    // 即「未落/老数据」的契约信号，前端据此回落 regex（同模块头零依赖原则的字段面延伸）。
    cause: str((c.fields as Record<string, string | string[] | undefined>).automation_cause),
  }
}

/** 聚合快照 → AFK 泳道 + 调度器灯。off 的 change 被排除（不入 cards/lanes/total）。 */
export function buildAfkSnapshot(snapshot: ListSnapshot, clock: () => string): AfkSnapshot {
  const lanes = emptyLanes()
  const cards: AfkCard[] = []
  for (const proj of snapshot.projects) {
    for (const c of proj.changes) {
      const card = cardOf(proj.root, c)
      if (!card) continue
      cards.push(card)
      lanes[card.lane].push(card)
    }
  }
  // 稳定排序：泳道内按名，flat cards 亦按名（可预测输出，测试可断言）。
  const byName = (a: AfkCard, b: AfkCard): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const lane of AFK_LANES) lanes[lane].sort(byName)
  cards.sort(byName)

  const queued = lanes.queued.length
  const running = lanes.running.length
  const merged = lanes.merged.length
  const failed = lanes.failed.length
  const conflict = lanes.conflict.length
  const paused = lanes.paused.length
  const total = cards.length

  const attention = failed + conflict > 0
  const status: SchedulerHealth['status'] = attention ? 'attention' : queued + running > 0 ? 'busy' : 'ok'
  const message = attention
    ? `调度器需人工介入：${failed} failed / ${conflict} conflict（现场已保留）`
    : queued + running > 0
      ? `调度器运行中：${running} 在跑 / ${queued} 排队`
      : total > 0
        ? `无活跃任务：${merged} 已合并 / ${paused} 暂停`
        : 'AFK 空闲（无自动化任务）'

  return {
    generated_at: clock(),
    scheduler: { status, queued, running, merged, failed, conflict, paused, total, message },
    lanes,
    cards,
  }
}

/**
 * 调度器流水 —— 从 automation_* 派生的活动流（老仓 afkObserver/kanbanDisplay 的旁路上板对位面）。
 * 每个非 off 的 change 贡献：queued_at → 'queued' 流水；last_error → 'error' 流水；当前态 → 'state' 流水。
 * 按时间戳降序（缺时间戳者排后，回落 generated_at）。
 */
export function buildAfkLog(snapshot: ListSnapshot, clock: () => string): AfkLog {
  const now = clock()
  const entries: AfkLogEntry[] = []
  for (const proj of snapshot.projects) {
    for (const c of proj.changes) {
      const card = cardOf(proj.root, c)
      if (!card) continue
      const anchor = card.queued_at || now
      if (card.queued_at) {
        entries.push({ ts: card.queued_at, name: card.name, root: card.root, automation: card.automation, kind: 'queued', detail: '已挂队（automation=queued）' })
      }
      if (card.last_error) {
        entries.push({ ts: anchor, name: card.name, root: card.root, automation: card.automation, kind: 'error', detail: card.last_error })
      }
      entries.push({ ts: anchor, name: card.name, root: card.root, automation: card.automation, kind: 'state', detail: `当前态 automation=${card.automation}` })
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return { generated_at: now, entries }
}

/**
 * afk-workbench Task 4：POST /api/afk/:name/cancel 的写回逻辑。
 * 前置：changeDir 须真存在（有 canonical current 或 legacy YAML，同 transition.ts 的存在性前置校验——kernel
 * StateStore.get/read 对不存在的 changeDir 是真 throw ENOENT，不判在此拦，会在 handlePost
 * 顶层兜底 catch 里变成走味的 500，而非本端点该给的 400）；automation 字段须为 'running'
 * （否则视为找不到运行中的 job）；automation_worktree/automation_sandbox 须非空（Task 1
 * 已确保二者在 running 态下非空，此处仍防御性校验）。
 * 顺序：先落取消标记文件（worktree 根），再 docker kill 容器——与 automation 侧
 * `runChangeInSandbox` 结算时"先探测标记、再判定是否 CancelledRunError"的读取顺序对应，
 * 保证标记先于 kill 造成的非零退出到场，不会被误判成瞬态失败走 classify 的 retry 分支。
 * docker kill 失败（容器已退出/已不存在等）不视为本端点的错误——标记已落即达成取消意图，
 * 真正的结算判定权在 automation 侧的 hasCancelMarker 探测，不在这次 kill 的 exec 退出码。
 */
export async function cancelAfkRun(store: StateStore, changeDir: string): Promise<{ ok: boolean; error?: string }> {
  if (!stateStorageExistsSync(changeDir)) {
    return { ok: false, error: '找不到该 change（无 canonical/legacy 状态），找不到运行中的 job' }
  }
  const automation = str(await store.get(changeDir, 'automation'))
  if (automation !== 'running') {
    return { ok: false, error: `automation 状态是 '${automation || '(空)'}'，不是 running，找不到运行中的 job` }
  }
  const worktree = str(await store.get(changeDir, 'automation_worktree'))
  const sandbox = str(await store.get(changeDir, 'automation_sandbox'))
  if (!worktree || !sandbox) {
    return { ok: false, error: '缺 automation_worktree/automation_sandbox，无法定位容器' }
  }
  // 真机验收 P1（2026-07-11）：worktree 目录可能不存在——历史上 automation_worktree 曾被
  // scheduler sanitize 的 slice(0,200) 截断（深路径项目截成 "…/sandcastle-pipeline-af" 残路径，
  // 写回已改走 sanitizePath 不再截断，但旧数据仍在盘上），或 worktree 已被并发 teardown 清理。
  // 裸抛 ENOENT 会流进 handlePost 顶层兜底 catch 变 500，且 err.message 携带的原始全路径直接
  // 泄漏进响应体。这里就地拦成本端点语义内的 400（ok:false），文案只带 errno code、不带路径。
  try {
    await writeFile(join(worktree, CANCEL_MARKER_FILE), '1', 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'unknown'
    return {
      ok: false,
      error: `无法在 automation_worktree 目录落取消标记（${code}）：worktree 目录可能已被清理，或字段值曾被旧版截断损坏——若任务实际已不在跑，可直接重试/放弃该任务`,
    }
  }
  await new Promise<void>((resolve) => {
    execFile('docker', ['kill', sandbox], () => resolve()) // kill 失败（容器已退出）不视为错误
  })
  return { ok: true }
}

/** 可重试的合法源态——对位 automation `LEGAL_AUTOMATION_TRANSITIONS` 里已允许转回 queued 的三个终态。 */
const RETRYABLE_FROM = ['failed', 'conflict', 'paused'] as const

/**
 * afk-workbench Task 5：POST /api/afk/:name/retry 的写回逻辑。
 * 前置：changeDir 须真存在（同 cancelAfkRun 的存在性前置校验——kernel StateStore.get 对不存在
 * 的 changeDir 是真 throw ENOENT，不判在此拦，会在 handlePost 顶层兜底 catch 里变成走味的 500，
 * 而非本端点该给的 400）；automation 字段须是 failed/conflict/paused 之一（这三个是 automation
 * `LEGAL_AUTOMATION_TRANSITIONS` 里已允许转回 queued 的合法源态——本函数不改状态机，只是补一个
 * 触发它的入口；running/scheduled 等其余态一律拒绝，运行中的任务应先 cancel，而非直接重试）。
 * 写回走 CAS（同 packages/automation/src/queue/claim.ts::claim 的 queued→scheduled 同一原语，
 * 方向相反：X→queued）：CAS 落空说明状态在读-判-写之间被并发改动过（例如另一请求已把它 cancel
 * 或调度器已重新认领），如实回 400，不误判成"状态不可重试"（判断已在上一步做过，此处只是并发
 * 兜底）。CAS 成功后清零 automation_attempts——重试即重开失败预算，同老仓人工重跑语义
 * （incrAttempts 的预算判定见 queue/claim.ts）。
 */
export async function retryAfkRun(store: StateStore, changeDir: string): Promise<{ ok: boolean; error?: string }> {
  if (!stateStorageExistsSync(changeDir)) {
    return { ok: false, error: '找不到该 change（无 canonical/legacy 状态），找不到可重试的任务' }
  }
  const current = str(await store.get(changeDir, 'automation'))
  if (!RETRYABLE_FROM.includes(current as (typeof RETRYABLE_FROM)[number])) {
    return { ok: false, error: `automation 状态是 '${current || '(空)'}'，不可重试（仅 failed/conflict/paused 可重试，running 请先 cancel）` }
  }
  const ok = await store.cas(changeDir, 'automation', current, 'queued')
  if (!ok) return { ok: false, error: 'CAS 失败，状态在此期间被并发修改' }
  await store.set(changeDir, 'automation_attempts', '0')
  return { ok: true }
}

/** 可放弃的合法源态——决议 #4 只圈 failed/conflict 两个「等人裁决」终态：paused 是拍板门语义
 *  （放行/打回归 transition），running/queued 是活跃态（先 cancel），都不该被「放弃」短路。 */
const DISMISSABLE_FROM = ['failed', 'conflict'] as const

/**
 * v5-T11（计划 2026-07-11-v5-interaction-rebuild 决议 #4）：POST /api/afk/:name/dismiss 的
 * 写回逻辑——「放弃」：failed/conflict → off，退出自动化路径。
 * 前置：changeDir 须真存在（同 cancelAfkRun/retryAfkRun 的存在性前置校验，kernel StateStore.get
 * 对不存在的 changeDir 是真 throw ENOENT，此处不拦会在 handlePost 顶层兜底 catch 里变成走味的
 * 500）；automation 须是 failed/conflict 之一。
 * 写回走 CAS（语义对齐 retryAfkRun：同一读-判-写并发兜底，CAS 落空=状态在此期间被并发改动，
 * 如实回 400）。与 retry 的关键差别：**现场保留**——automation_attempts/automation_last_error/
 * automation_worktree/automation_preserved_path 一个不清，事后尸检线索全在（demo v5 口径
 * 「放弃则归档现场，worktree 保留」；detail.fail_note 文案同源）。
 */
export async function dismissAfkRun(store: StateStore, changeDir: string): Promise<{ ok: boolean; error?: string }> {
  if (!stateStorageExistsSync(changeDir)) {
    return { ok: false, error: '找不到该 change（无 canonical/legacy 状态），找不到可放弃的任务' }
  }
  const current = str(await store.get(changeDir, 'automation'))
  if (!DISMISSABLE_FROM.includes(current as (typeof DISMISSABLE_FROM)[number])) {
    return { ok: false, error: `automation 状态是 '${current || '(空)'}'，不可放弃（仅 failed/conflict 可放弃；running 请先 cancel，paused 走放行/打回）` }
  }
  const ok = await store.cas(changeDir, 'automation', current, 'off')
  if (!ok) return { ok: false, error: 'CAS 失败，状态在此期间被并发修改' }
  return { ok: true }
}

/**
 * afk-workbench 缺口修复（2026-07-09，本轮真机验证发现）：AfkWorkbench.tsx 此前只有
 * 查看快照/取消/重试三个入口，没有"挂队"——`tenon afk enqueue <name>` 是唯一能把一个
 * change 摆进 AFK 队列的路径，dashboard 侧没有对应端点/按钮，用户点不到。
 *
 * 镜像 `@tenon/automation` sdk.ts::enqueue 消费的判定逻辑（server 对 automation 包
 * 坚持零运行时依赖，同本文件 CANCEL_MARKER_FILE 的字面量对位先例，不 import）：
 *   · effective registry 的 automationEligible=false 永不入队；能力位由 HTTP 路由跨信任边界显式传入。
 *   · automationEligible=true：SDK 默认构造 `defaultOptIn=true` 且 CLI 走的正是这条默认路径（未暴露
 *     per-change opt-in 覆盖的 UI/CLI 入口），故这里同样按"默认已 opt-in"处理，不额外建一套
 *     配置面——与 CLI 默认行为等价，不是引入新语义。
 *   · automation 已经处于非 off 态（已挂队/在跑/终态）→ 拒绝重复 enqueue。SDK 侧对
 *     automation==='queued' 是幂等返回 true（视为"已经如愿"），但这里改成显式报错而非静默
 *     成功——按钮场景下用户点两下应该被告知"已经在队了"，不是假装又成功了一次。
 * 写回同 automation 包 queue/claim.ts::markQueued 逐字对齐：automation=queued +
 * automation_queued_at=now。
 */
export async function enqueueAfkRun(
  store: StateStore,
  changeDir: string,
  clock: () => string,
  eligibility: { automationEligible: boolean; trackLabel: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!stateStorageExistsSync(changeDir)) {
    return { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' }
  }
  if (!eligibility.automationEligible) {
    return { ok: false, error: `${eligibility.trackLabel} track 不支持 AFK 自动化挂队` }
  }
  const current = str(await store.get(changeDir, 'automation'))
  if (current && current !== 'off') {
    return { ok: false, error: `automation 状态已是 '${current}'，无需重复挂队` }
  }
  await store.setMany(changeDir, { automation: 'queued', automation_queued_at: clock() })
  return { ok: true }
}

/**
 * afk-workbench Task 6：GET /api/afk/:name/log 的读取逻辑。
 * 日志落盘位置见 Task 2（2026-07-08 勘误修正后的真实落点）：宿主仓库侧、随 change 本身持久的
 * `join(changeDir, '.sandcastle-run.log')`——**不在** automation_worktree 指向的临时 worktree
 * 内（worktree 成功跑完/普通失败后会在结算时被 teardown 删除，只有 conflict/aborted 保留现场
 * 的少数情况 worktree 才还活着）。定位这个文件只需要 root+name（即 changeDir），不需要读
 * automation_worktree 字段——该字段仍是 Task 3/4（取消标记 + docker kill 目标）要用的东西，
 * 只是跟"日志在哪"解耦了。故本函数签名只收 changeDir，不收 store：与 cancelAfkRun/retryAfkRun
 * 需要 store 读/写 automation 字段的写回场景不同，本端点是纯读文件，没有状态机前置校验。
 * 找不到文件（该 change 尚未跑过 automation，或是 Task 2 部署前创建的旧 change）→ 回 null，
 * 不视为错误（不 throw）——changeDir 本身是否存在的 ENOENT 前置校验由 server.ts 路由层做
 * （同 cancelAfkRun/retryAfkRun 的 canonical/legacy 存在性前置校验模式一致），本函数只管
 * "有没有这份日志"，不关心 change 本身合不合法。
 */
export async function readAfkRunLog(changeDir: string): Promise<string | null> {
  try {
    return await readFile(join(changeDir, '.sandcastle-run.log'), 'utf8')
  } catch {
    return null
  }
}
