import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { WbLoopRow } from '../api/client'
import { useT } from '../i18n'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export const LOOP_RUNNERS = ['claude-code', 'codex'] as const

/**
 * v10b 迁移：三张工作台卡（LoopCard/AutomationCard/SecretsCard）共用的卡壳/表单原子类词汇
 * ——旧 .card/.wb-editor-head/.wb-input/.wb-note/.wb-ed-sec/.wb-status/.lp-policy 家族的对位。
 * AutomationCard 已 import LpSlider，同源消费本表；不入 components/ui（那里不许动）。
 */
export const WB_TW = {
  /** 旧 .card + .wb-loop 卡壳——按旧 `.wb8-pane > .card` 剥皮语义收平（Phase 4 视觉验收 #3）：
   *  三卡（Loop/AFK/凭证）只在 sheet pane 内渲染，pane 自带外卡壳与内边距，卡根不再套第二层
   *  border/bg-card/shadow/圆角/外边距（卡内卡）；区块分隔由 WB_TW.sec 的 border-t 承担。 */
  card: '',
  /** 旧 .wb-editor-head + .lp-head 卡头行（row-gap 4px 是 lp-head 覆写）。 */
  head: 'flex flex-wrap items-center gap-x-2 gap-y-1',
  headB: 'text-body text-text',
  /** 旧 .lp-head-sub 卡头副题（basis-full 独占一行）。 */
  headSub: 'mt-px basis-full text-caption font-normal text-text-3',
  /** 旧 .wb-input（hover/focus/disabled 三态；focus 环走 --ring-blue token）。 */
  input:
    'h-[34px] w-full rounded-sm border border-border bg-card px-3 text-body text-text transition-[border-color,box-shadow] duration-[120ms] hover:border-border-2 focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--ring-blue)] focus:outline-none disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3',
  /** 旧 .wb-note。 */
  note: 'text-caption leading-[1.55] text-text-3',
  /** 旧 .wb-flabel（margin 由调用点自补——旧表在不同容器里分别清零/覆写过）。 */
  flabel: 'block text-caption font-semibold text-text-3',
  /** 旧 .wb-ed-sec；相邻分区的顶界/间距用 [data-sec] + & 变体对位旧 `+` 组合子语义。 */
  sec: 'pt-3.5 pb-1 [[data-sec]+&]:mt-3 [[data-sec]+&]:border-t [[data-sec]+&]:border-border',
  /** 旧 .wb-ed-sec-h 与其内 .hint。 */
  secH: 'mb-2.5 flex items-center gap-1.5 text-body font-bold',
  hint: 'text-caption font-normal text-text-3',
  /** 旧 .wb-status--dirty / --ok 状态 pill。 */
  statusDirty:
    'inline-flex items-center gap-1.5 rounded-full border border-dashed border-border-2 bg-fill px-2.5 py-1 text-micro font-bold text-text-2',
  statusOk: 'inline-flex items-center gap-1.5 rounded-full bg-green-t px-2.5 py-1 text-micro font-bold text-green-d',
  /** 旧 .wb-save-errors + .lp-errors（li 单列）。 */
  saveErrors: 'mt-3 mb-3.5 list-none rounded-sm border border-red-b bg-red-t px-3 py-2.5',
  saveErrorsLi: 'font-mono text-caption leading-[1.6] text-red-d',
  /** 旧 .lp-policy 弹性参数行（SecretsCard 的 .sc-row 同族）。 */
  policyRow: 'mt-2.5 flex flex-wrap items-center gap-3 border-t border-dashed border-border pt-3',
  /** 旧 .view__note / .view__note--error（错误态另配 data-tone="error"）。 */
  loading: 'p-5 text-body text-text-3',
  loadError: 'p-5 text-body text-red',
  /** shadcn Button 的项目微调：solid 配 <Button size="sm">、ghost 配 <Button variant="ghost" size="sm">。 */
  btnSolid: 'px-4 text-caption font-bold',
  btnGhost: 'border border-border px-4 text-caption font-semibold text-text-2 hover:border-text-3 hover:bg-transparent hover:text-text',
  /** shadcn Switch 的项目微调：开=accent 蓝（旧 .switch[aria-checked=true] 口径，非 shadcn 默认绿）。 */
  switch: 'data-[state=checked]:bg-(--accent)',
} as const

/**
 * 工作台各页签共用的「▸ 高级设置」折叠区（IA 精简：每个页签只把高频核心直接展开，次要/
 * 只读诊断/解释性内容一键收进本折叠，默认收起）。shadcn Collapsible（radix，闭合即卸载内容——
 * 恒不撑视觉高度）；触发钮文案随开合切 advanced_show/advanced_hide，▸ 图标随开态旋转 90°。
 * 测试锚点走 testid（各页签唯一：lp-adv/afk-adv/sc-adv/skh-adv/wb-stage-adv）——折叠区内的
 * 既有 testid 全保留，用例需先点 testid 展开再断言（内容闭合态不在 DOM）。
 */
export function WbAdvanced({ testid, children }: { testid: string; children: ReactNode }): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3.5 border-t border-border pt-2.5">
      <CollapsibleTrigger
        data-testid={testid}
        className="flex w-full cursor-pointer items-center gap-1 rounded-sm text-caption font-semibold text-text-3 transition-colors hover:text-text-2"
      >
        <ChevronRight aria-hidden="true" className={cn('size-3.5 flex-none transition-transform duration-150', open && 'rotate-90')} />
        {open ? t('workbench.advanced_hide') : t('workbench.advanced_show')}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** 旧 .loop-reject 错误反馈块（语义=错误，由 data-tone="error" 承载，调用点自补 margin）。 */
export const ERR_BLOCK_TW = 'rounded-sm bg-red-t px-3 py-2 text-micro font-semibold text-red'
/** 旧 .wb-chip（mono 值 chip）。 */
export const CHIP_TW = 'inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-fill px-2 font-mono text-caption text-text-2'
/** 旧 .badge 底座（--run/--pending/lp-draft-badge 的差异色由调用点条件类补）。 */
export const BADGE_TW = 'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-micro font-bold'

// ── 草稿形状：/api/loops/update 可 patch 字段的编辑面（kernel loops/update.ts 全集，
//    autonomy_level 除外——见头注释）──
export interface LoopDraft {
  status: string
  goal: string
  design_doc: string
  /** row.change_prefix null ↔ 草稿空串；保存时空串写回 null（kernel checkedValue 允许）。 */
  change_prefix: string
  risk: string
  runner: string
  cadence: string
  max_runs_per_day: number
  max_in_flight: number
  max_tokens_per_day: number | null
  on_exceed: string
  human_gates: string[]
  kill_criteria: string[]
  allowlist: string[]
  denylist: string[]
}

export function loopDraftValueEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right
}

export function draftOf(row: WbLoopRow): LoopDraft {
  return {
    status: row.status,
    goal: row.goal,
    design_doc: row.design_doc,
    change_prefix: row.change_prefix ?? '',
    risk: row.risk,
    runner: row.runner,
    cadence: row.cadence,
    max_runs_per_day: row.budget_decl.max_runs_per_day,
    max_in_flight: row.budget_decl.max_in_flight,
    max_tokens_per_day: row.budget_decl.max_tokens_per_day ?? null,
    on_exceed: row.budget_decl.on_exceed,
    human_gates: [...row.human_gates],
    kill_criteria: [...row.kill_criteria],
    allowlist: [...row.allowlist],
    denylist: [...row.denylist],
  }
}

/** 接受新的 server 基线，同时保留本地已触碰字段。字段显式列出，避免草稿契约被无检查断言掩盖。 */
export function rebaseLoopDraft(
  current: LoopDraft,
  next: LoopDraft,
  touched: ReadonlyMap<keyof LoopDraft, unknown>,
): LoopDraft {
  const keep = <K extends keyof LoopDraft>(key: K): LoopDraft[K] => (
    touched.has(key) ? current[key] : next[key]
  )
  return {
    status: keep('status'),
    goal: keep('goal'),
    design_doc: keep('design_doc'),
    change_prefix: keep('change_prefix'),
    risk: keep('risk'),
    runner: keep('runner'),
    cadence: keep('cadence'),
    max_runs_per_day: keep('max_runs_per_day'),
    max_in_flight: keep('max_in_flight'),
    max_tokens_per_day: keep('max_tokens_per_day'),
    on_exceed: keep('on_exceed'),
    human_gates: keep('human_gates'),
    kill_criteria: keep('kill_criteria'),
    allowlist: keep('allowlist'),
    denylist: keep('denylist'),
  }
}

/** 草稿 vs 基线 → 精确 patch（只带被改字段——验收②「不夹带未改字段」）。 */
export function computePatch(draft: LoopDraft, base: LoopDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const k of ['status', 'goal', 'design_doc', 'risk', 'runner', 'cadence', 'on_exceed'] as const) {
    if (draft[k] !== base[k]) patch[k] = draft[k]
  }
  if (draft.change_prefix !== base.change_prefix) {
    patch.change_prefix = draft.change_prefix === '' ? null : draft.change_prefix
  }
  for (const k of ['max_runs_per_day', 'max_in_flight'] as const) {
    if (draft[k] !== base[k]) patch[k] = draft[k]
  }
  // token 上限：null=未声明预算——滑杆一经拖动即为数字；「拖回未设置」不存在（demo 同款），
  // 所以 null→null 恒不进 patch，数字变化才进。
  if (draft.max_tokens_per_day !== base.max_tokens_per_day && draft.max_tokens_per_day !== null) {
    patch.max_tokens_per_day = draft.max_tokens_per_day
  }
  for (const k of ['human_gates', 'kill_criteria', 'allowlist', 'denylist'] as const) {
    if (JSON.stringify(draft[k]) !== JSON.stringify(base[k])) patch[k] = draft[k]
  }
  return patch
}

// ── T7（loop 卡审阅面重构）：字段生产者徽章——静态前端硬编码规则,不做「谁实际写了这个值」
//    的运行时追踪(agent 生成协议本轮不落地,见计划范围外登记)。逐字段对齐
//    docs/ux/2026-07-11-config-experience-analysis.md §2.1「应然生产者」列:两值并列时
//    （如「系统推导 + 人确认」）取首个产出实质内容的一方——人确认/人可调是几乎每个字段
//    收尾都有的动作,不单独成类,否则三色徽章会退化成「全员人拍板」。
//    allowlist 不在此表:它是全表唯一「应然生产者=暂不呈现为需决策字段」的例外（零消费、
//    「执行面另落」）,不装成三色徽章之一,渲染时走独立 reserved disclaimer。──
type ProvKind = 'agent' | 'sys' | 'human'

const FIELD_PROV: Record<Exclude<keyof LoopDraft, 'allowlist'>, ProvKind> = {
  status: 'human', // 「人拍板——已是正确交互模型(tap 不是打字)」
  goal: 'agent', // 「agent 生成」
  design_doc: 'agent', // 「agent 生成」
  change_prefix: 'sys', // 「系统推导 + 人确认」——从 id 派生默认建议值
  risk: 'agent', // 「agent 生成」
  runner: 'sys', // 「系统推导 + 人确认」——从既有 runner 真值/历史默认预填；徽章仅显示中性「系统推导」，
  //                当前不与就绪三灯凭证探测联动（P2-F2：readiness 反向建议「只给凭证已配的 runner 推荐标记」
  //                是更大工程，登记为 backlog，见 docs/ux/…-config-experience-analysis.md §2.1 远期项，本轮不接线）
  cadence: 'agent', // 「agent 生成建议 + 人确认」
  max_runs_per_day: 'sys', // 「系统给安全默认 + 人拍板上限」
  max_in_flight: 'sys', // 「系统预填推荐值 + 人可调」
  max_tokens_per_day: 'sys', // 「系统推导 + 人确认」
  on_exceed: 'sys', // 「系统给死默认，不作为决策项呈现」
  human_gates: 'agent', // 「agent 生成候选 + 人勾选」
  kill_criteria: 'sys', // 「系统给候选清单 + 人勾选」
  denylist: 'sys', // 「系统推导候选 + 人勾选/追加」——另加「真硬消费」disclaimer，见 render 处
}

const PROV_LABEL_KEY: Record<ProvKind, string> = {
  agent: 'workbench.lp_prov_agent',
  sys: 'workbench.lp_prov_sys',
  human: 'workbench.lp_prov_human',
}

/** 徽章三色直接指派既有 token（agent=accent 三件套、sys=fill-2 中性、human=ink 深底铭牌）。 */
const PROV_BASE_TW = 'inline-flex h-[18px] flex-none items-center whitespace-nowrap rounded-sm px-2 text-micro font-bold'
const PROV_KIND_TW: Record<ProvKind, string> = {
  agent: 'border border-accent-b bg-accent-t text-accent-d',
  sys: 'bg-fill-2 text-text-2',
  human: 'bg-ink text-ink-fg',
}
/** allowlist 专用「运行时硬约束」徽章：H5 已在 L3 写入与合并两道边界真实消费。 */
export const PROV_ENFORCED_TW = cn(PROV_BASE_TW, 'border border-green-b bg-green-t text-green-d')

/** 字段生产者徽章（T7）——纯展示，无点击语义；field 取 LoopDraft 键名做 data-testid 锚点。 */
export function ProvBadge({ field }: { field: keyof typeof FIELD_PROV }): JSX.Element {
  const { t } = useT()
  const kind = FIELD_PROV[field]
  return (
    <span className={cn(PROV_BASE_TW, PROV_KIND_TW[kind])} data-kind={kind} data-testid={`lp-prov-${field}`}>
      {t(PROV_LABEL_KEY[kind])}
    </span>
  )
}

// ── useLoops：/api/loops/snapshot 的读取与选中态托管（WorkbenchView 调用）──
