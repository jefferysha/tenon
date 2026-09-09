import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '../i18n'
import { CHIP_TW, WB_TW } from './loopCardModel'

export const CADS = ['5m', '15m', '30m', '1h', '2h', '6h', '1d'] as const
export const RECO_CAD_IDX = 4
export const RECO_RUNS = 24
export const RECO_INFLIGHT = 1
/** token 滑杆以 k 为单位（10k-500k，步进 10k）；推荐 100k。 */
export const RECO_TOKENS_K = 100

function cadenceMinutes(c: string): number {
  const m = c.match(/^(\d+)(m|h|d)$/)
  if (!m) return Number.NaN
  const n = Number(m[1])
  return m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 1440
}

/** 现值 → 离散档位下标：精确命中优先；解析得出分钟数取最近档；解析不了回落推荐档（显示仍是原值）。 */
export function cadenceIndex(c: string): number {
  const exact = (CADS as readonly string[]).indexOf(c)
  if (exact !== -1) return exact
  const mins = cadenceMinutes(c)
  if (Number.isNaN(mins)) return RECO_CAD_IDX
  let best = 0
  for (let i = 1; i < CADS.length; i++) {
    const candidate = CADS[i]
    const current = CADS[best]
    if (candidate !== undefined && current !== undefined
      && Math.abs(cadenceMinutes(candidate) - mins) < Math.abs(cadenceMinutes(current) - mins)) best = i
  }
  return best
}

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** 推荐三角刻度的水平位置（demo 同款 calc：thumb 半宽 8px 内缩）。 */
function recoLeft(frac: number): string {
  return `calc(8px + (100% - 16px) * ${frac.toFixed(4)})`
}

interface SliderProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  display: string
  recoLabel: string
  /** 推荐刻度位置：'edge' = 贴左缘（在跑上限的推荐 1 落在最小值）。 */
  recoFrac: number | 'edge'
  onValue: (v: number) => void
  /** T7：字段生产者徽章（可选——仅 Loop 卡的 4 个预算滑杆传入；AutomationCard 不传，不渲染，
   *  零视觉/行为差异，见该组件既有测试回归）。 */
  prov?: JSX.Element
  /** 原生 input[type=range] 的步进粒度（可选，缺省 1）——必须等于受控 value 的真实语义网格，
   *  否则键盘方向键单步会落在网格外的中间值，被上层有损取整吞掉、DOM 弹回原值（键盘死锁 bug，
   *  见 token 预算滑杆调用点）。 */
  step?: number
}

/**
 * 滑杆样式（旧 .lp-range）——保持原生 input[type=range]（测试契约 fireEvent.change/toHaveValue/
 * step 属性 + 原生键盘语义都钉在原生控件上，shadcn/radix Slider 换不动），轨道 fill-2/填充
 * 使用原生 range 的 accent-color；保留平台键盘与高对比度行为，不绘制渐变轨道。
 */
const RANGE_TW = [
  'mt-2 block h-5 w-full cursor-pointer accent-(--accent)',
  'focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-t',
].join(' ')

/**
 * 单条滑杆（原生 accent 轨道 + 推荐 ▽ 刻度）。
 * T21 起导出：「AFK 执行」卡（AutomationCard）复用同一滑杆组件与滑杆样式纪律。
 */
export function LpSlider({ id, label, value, min, max, display, recoLabel, recoFrac, onValue, prov, step }: SliderProps): JSX.Element {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <label className={WB_TW.flabel} htmlFor={id}>{label}</label>
        {prov}
        <span className="ml-auto font-mono text-caption font-bold text-(--accent)" data-testid={`${id}-val`}>{display}</span>
      </div>
      <input
        type="range"
        className={RANGE_TW}
        id={id}
        data-testid={id}
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        aria-label={label}
        onChange={(e) => onValue(Number(e.target.value))}
      />
      <div className="relative mt-0.5 h-4" aria-hidden="true">
        <span
          className={cn('absolute top-0 whitespace-nowrap text-micro text-text-3', recoFrac !== 'edge' && '-translate-x-1/2')}
          style={recoFrac === 'edge' ? { left: '2px' } : { left: recoLeft(recoFrac) }}
        >
          {recoLabel}
        </span>
      </div>
    </div>
  )
}

// ── chips 行（human_gates / kill_criteria / allowlist / denylist 共用）──
/** 终止条件已知 id 的人话副标（demo lp-chip-d）；未知 id 无副标。 */
export const KILL_DESC_KEYS: Record<string, string> = {
  'no-change-3': 'workbench.lp_kd_no_change_3',
  'budget-burn-2d': 'workbench.lp_kd_budget_burn_2d',
}

interface ChipRowProps {
  label: string
  values: string[]
  addAria: string
  /** 值 → 人话副标 i18n key（仅终止条件行提供）。 */
  descKeys?: Record<string, string>
  /** T7：字段生产者徽章（可选，渲染在 label 右侧）。 */
  prov?: JSX.Element
  /** T7：消费等级如实说明（可选，渲染在 chips 下方一行——denylist 真硬消费 / allowlist 预留
   *  字段零消费，红线要求逐字段如实标注，不是通用装饰）。 */
  note?: JSX.Element
  onChange: (next: string[]) => void
}

/** 旧 .lp-saferow：150px 标签列 + 弹性内容列；相邻行虚线顶界经 [data-saferow] + & 对位旧 `+` 组合子。 */
const SAFEROW_TW =
  'grid grid-cols-[150px_minmax(0,1fr)] items-start gap-3 py-2.5 last:pb-0.5 mobile:grid-cols-1 mobile:gap-1.5 [[data-saferow]+&]:border-t [[data-saferow]+&]:border-dashed [[data-saferow]+&]:border-border'

export function LpChipRow({ label, values, addAria, descKeys, prov, note, onChange }: ChipRowProps): JSX.Element {
  const { t } = useT()
  // 「+ 添加」就地输入态（StepEditor commitAdd 同款：Enter 提交 / Esc 取消 / 失焦有值即提交）。
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function commit(cancel: boolean): void {
    const v = draft.trim()
    if (!cancel && v !== '' && !values.includes(v)) onChange([...values, v])
    setAdding(false)
    setDraft('')
  }

  return (
    <div className={SAFEROW_TW} data-saferow="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={cn(WB_TW.flabel, 'mt-1')}>{label}</span>
        {prov}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {values.map((v) => (
            <span key={v} className={CHIP_TW}>
              {v}
              {descKeys?.[v] && <span className="font-sans text-micro text-text-3">{t(descKeys[v] ?? '')}</span>}
              <button
                type="button"
                className="-mr-1 inline-grid size-4 cursor-pointer place-items-center rounded-xs border-0 bg-transparent p-0 text-body leading-none text-text-3 transition-colors duration-[120ms] hover:bg-red-t hover:text-red-d"
                aria-label={t('workbench.lp_chip_remove', { v })}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          {adding ? (
            <input
              className={cn(WB_TW.input, 'h-[26px] w-[180px] font-mono text-caption')}
              aria-label={addAria}
              value={draft}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- 用户刚点了「+ 添加」，焦点进输入框是这次点击的直接延续
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit(false)
                } else if (e.key === 'Escape') {
                  commit(true)
                }
              }}
              onBlur={() => commit(false)}
            />
          ) : (
            <button
              type="button"
              className="h-6 cursor-pointer rounded-sm border border-dashed border-border-2 bg-transparent px-2 text-caption font-semibold text-text-3 transition-colors duration-[120ms] hover:bg-fill hover:text-text-2"
              aria-label={addAria}
              onClick={() => setAdding(true)}
            >
              {t('workbench.lp_chip_add')}
            </button>
          )}
        </div>
        {note && <p className={cn(WB_TW.note, 'mt-1.5')}>{note}</p>}
      </div>
    </div>
  )
}

// ── 主卡 ──
