import { useEffect, useRef, useState } from 'react'
import { postLoopLevel, postLoopUpdate } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { handleRadioKey } from '../shared/radioKeyboard'
import { LpSlider, type LoopsState } from './LoopCard'
import { cn } from '@/lib/utils'
import { ChartNoAxesColumn, CircleAlert, Pencil } from 'lucide-react'
import { GovernancePromoteDialog } from './GovernancePromoteDialog'
import { GovernanceRailHead } from './GovernanceRailHead'
import { GovernanceGraduation } from './GovernanceGraduation'
import { GovernanceRailStatus } from './GovernanceRailStatus'
import {
  BAND_KEY, BAND_TW, BAR_TW, BUDGET_COMMIT_MS, BUDGET_WARN_RATIO, GCARD_TW,
  GH_B_TW, GH_TW, GNOTE_ERR_TW, GNOTE_HINT_TW, GNOTE_TW, LAMP_TW, LEVELS,
  LEVEL_MIN_SCORE, LEVEL_SHORT_KEY, MINIBADGE_TW, MIN_L2_RUNS_FOR_L3, RAIL_TW,
  READY_STRONG, READY_THRESHOLD, RECO_TOKENS_K, TAG_DERIVED_TW, TAG_RW_TW,
  TOKENS_K_MAX, TOKENS_K_MIN, TOKENS_K_STEP, clamp, finiteOrNull, fmtK, promotionDecisionKey, tokensKOf,
  type GovernanceLevel,
} from './governanceModel'
export { BUDGET_WARN_RATIO, MIN_L2_RUNS_FOR_L3, READY_STRONG, READY_THRESHOLD } from './governanceModel'
export interface GovernanceRailProps {
  root: string
  /** 从 './LoopCard' import 的既有 useLoops 返回类型——宿主已持有，本组件不重复拉快照。 */
  loops: LoopsState
}

export function GovernanceRail({ root, loops }: GovernanceRailProps): JSX.Element {
  const { t, lang } = useT()
  const row = loops.selected
  const [levelBusy, setLevelBusy] = useState(false)
  const [levelError, setLevelError] = useState<string | null>(null)
  /** 待确认的升档目标（null = 无弹窗）——只有升档会落到这里，降档直发。 */
  const [confirmLevel, setConfirmLevel] = useState<GovernanceLevel | null>(null)
  /** token 上限草稿（k 单位）；null = 未拖动，跟随 server 真值。 */
  const [tokK, setTokK] = useState<number | null>(null)
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const levelGeneration = useRef(0)
  const budgetGeneration = useRef(0)
  const identity = useRef({ root, rowId: row?.id ?? null })
  identity.current = { root, rowId: row?.id ?? null }
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }
  useEffect(() => {
    ++levelGeneration.current
    ++budgetGeneration.current
    setLevelBusy(false)
    setConfirmLevel(null)
  }, [root, row?.id])
  useEffect(() => {
    setLevelError(null)
    setBudgetError(null)
  }, [lang])
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const authoritativeMaxTokens = row?.budget_decl?.max_tokens_per_day ?? null
  // 轮询对象换代不撤确认；只有确认文案与裁决前提中的事实变化才撤。
  const promotionFacts = promotionDecisionKey(root, row)

  useEffect(() => {
    setTokK(null)
    setLevelError(null)
    setBudgetError(null)
  }, [row])

  useEffect(() => {
    setConfirmLevel(null)
  }, [promotionFacts])

  // 卸载、换行或权威预算变化时取消旧 timer，禁止其 POST 旧草稿覆盖新快照。
  useEffect(
    () => () => {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current)
      commitTimer.current = null
    },
    [root, row?.id, authoritativeMaxTokens],
  )

  /**
   * 级别按钮的入口：**风险不对称**分流（见文件头）——升档先出确认 Dialog，降档直发。
   * 注意这里**不做任何门控判定**：够不够格是 server 的活（诚实门③），本函数只区分「升 vs 降」。
   */
  function requestLevel(target: GovernanceLevel): void {
    if (!row || levelBusy || target === row.autonomy_level) return
    if (LEVELS.indexOf(target) > LEVELS.indexOf(row.autonomy_level)) {
      setConfirmLevel(target)
    } else {
      void applyLevel(target)
    }
  }

  async function applyLevel(target: GovernanceLevel): Promise<void> {
    if (!row || levelBusy || target === row.autonomy_level) return
    const targetRoot = root
    const targetId = row.id
    const generation = ++levelGeneration.current
    setLevelBusy(true)
    setLevelError(null)
    try {
      await postLoopLevel({ root: targetRoot, id: targetId, target })
      if (generation !== levelGeneration.current || identity.current.root !== targetRoot || identity.current.rowId !== targetId) return
      loops.reload()
    } catch (err) {
      if (generation === levelGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        const current = localeIdentity.current
        setLevelError(current.t('workbench.lp_level_fail', {
          msg: formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' }),
        }))
      }
    } finally {
      if (generation === levelGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        setLevelBusy(false)
      }
    }
  }

  async function commitTokens(k: number): Promise<void> {
    if (!row) return
    const targetRoot = root
    const targetId = row.id
    const generation = ++budgetGeneration.current
    const next = k * 1000
    // 与 server 真值相同 → 不发（LoopCard computePatch「不夹带未改字段」的同一条纪律）。
    if (next === (row.budget_decl?.max_tokens_per_day ?? null)) return
    setBudgetError(null)
    try {
      await postLoopUpdate({ root: targetRoot, id: targetId, patch: { max_tokens_per_day: next } })
      if (generation !== budgetGeneration.current || identity.current.root !== targetRoot || identity.current.rowId !== targetId) return
      loops.reload()
    } catch (err) {
      // 写回失败必须现形：否则用户以为阈值改了、其实没落盘（静默吞错 = 谎报已保存）。
      if (generation === budgetGeneration.current && identity.current.root === targetRoot && identity.current.rowId === targetId) {
        const current = localeIdentity.current
        setBudgetError(current.t('workbench.gov_budget_fail', {
          msg: formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' }),
        }))
      }
    }
  }

  function onTokens(v: number): void {
    setTokK(v) // 即时回显
    if (commitTimer.current !== null) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null
      void commitTokens(v)
    }, BUDGET_COMMIT_MS) // 停手落盘
  }

  if (loops.loadError || loops.rows === null || !row) {
    return <GovernanceRailStatus loops={loops} t={t} />
  }

  const curIdx = LEVELS.indexOf(row.autonomy_level)
  const score = finiteOrNull(row.readiness?.score)
  const band = typeof row.readiness?.band === 'string' && row.readiness.band !== '' ? row.readiness.band : null
  const breaker = typeof row.budget?.breaker === 'string' ? row.budget.breaker : null
  // 已知档位 → 人话；server 给了没见过的档位 → 原样透传（不装作认识）；没数据 → '—'。
  // 档位 chip 与升档确认 Dialog 共用同一条本地化路径——同一事实在两处必须是同一句话。
  const bandText = band === null ? '—' : BAND_KEY[band] ? t(BAND_KEY[band]) : band

  // 单向预判（诚实门③）：只在「就绪分已知 && 低于下一档门槛」时提示会被拒；条件满足时**不说任何话**
  //   ——drift/连败/runs 三路输入前端没有，说「可以升」就是谎报。
  const nextLv = curIdx >= 0 && curIdx < LEVELS.length - 1 ? LEVELS[curIdx + 1] ?? null : null
  const nextNeed = nextLv === null ? 0 : LEVEL_MIN_SCORE[nextLv]
  const predictBlocked = nextLv !== null && score !== null && score < nextNeed

  const rowUnset = row.budget_decl?.max_tokens_per_day === null || row.budget_decl?.max_tokens_per_day === undefined
  const effTokK = tokK ?? tokensKOf(row)
  const tokDisplay = tokK === null && rowUnset ? t('workbench.lp_tokens_unset') : `${effTokK}k`
  const ledger = row.ledger
  // 账本存在时，它才是结算真相源：actual + estimated 都已消耗预算；legacy budget.spentToday
  // 只作旧 server 的兼容回退，不能继续遮住估扣或被新快照覆盖成较小的数字。
  const authoritativeSpent = ledger
    ? finiteOrNull(ledger.settled_tokens_actual) !== null && finiteOrNull(ledger.settled_tokens_estimated) !== null
      ? ledger.settled_tokens_actual + ledger.settled_tokens_estimated
      : null
    : row.budget?.spentToday
  const ledgerHealth = ledger?.health ?? 'missing'
  const ledgerEnforced = ledger?.admission_enforced === true && ledger?.inflight_enforced === true
  const graduation = row.graduation ?? null

  return (
    <aside className={RAIL_TW} data-testid="wb-gov-rail">
      <GovernanceRailHead />

      {/* ── ① 自治级 L1/L2/L3 —— 🟢 POST /api/loops/level（逐级晋升门，裁决权在 server）── */}
      <section className={GCARD_TW} data-testid="wb-gov-level">
        <div className={GH_TW}>
          <b className={GH_B_TW}>{t('workbench.gov_level_title')}</b>
          <span className={cn(MINIBADGE_TW, TAG_RW_TW, 'inline-flex items-center gap-1')}><Pencil className="size-3" aria-hidden="true" />{t('workbench.gov_tag_rw')}</span>
        </div>
        <div className="flex gap-[7px]" role="radiogroup" aria-label={t('workbench.lp_level')}>
          {LEVELS.map((lv, index) => {
            const on = row.autonomy_level === lv
            return (
              <button
                key={lv}
                type="button"
                className={cn(
                  'flex-1 cursor-pointer rounded-[10px] border px-1.5 py-2 text-center transition-[border-color,background-color] duration-[120ms] disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-(--accent) bg-accent-t shadow-[0_0_0_3px_var(--ring-blue)]' : 'border-border-2 bg-fill hover:border-text-3',
                )}
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                data-testid={`wb-gov-lv-${lv}`}
                // 恒不因「预判会被拒」而 disable——那是 server 的判决权（诚实门③）。只在写回在途时禁双发。
                disabled={levelBusy}
                onClick={() => requestLevel(lv)}
                onKeyDown={(event) => handleRadioKey(event, index, LEVELS.length, (next) => {
                  const candidate = LEVELS[next]
                  if (candidate) requestLevel(candidate)
                })}
              >
                <b className={cn('block font-mono text-base font-extrabold', on ? 'text-accent-d' : 'text-text-2')}>{lv}</b>
                <small className="mt-0.5 block text-[11.5px] whitespace-nowrap text-text-3">{t(LEVEL_SHORT_KEY[lv])}</small>
              </button>
            )
          })}
        </div>
        <p className={GNOTE_TW} data-testid="wb-gov-grad-note">
          {t('workbench.gov_grad_note', { t1: READY_THRESHOLD, t2: READY_STRONG, runs: MIN_L2_RUNS_FOR_L3 })}
        </p>
        {graduation !== null && <GovernanceGraduation graduation={graduation} lang={lang} t={t} />}
        {graduation === null && predictBlocked && nextLv !== null && score !== null && (
          <p className={GNOTE_HINT_TW} data-tone="hint" data-testid="wb-gov-level-hint">
            {t('workbench.gov_level_hint', { score, need: nextNeed, target: nextLv })}
          </p>
        )}
        {levelError !== null && (
          <p className={GNOTE_ERR_TW} data-tone="error" data-testid="wb-gov-level-error" role="alert">
            <CircleAlert className="mr-1 inline size-3.5" aria-hidden="true" />{levelError}
          </p>
        )}
      </section>

      {/* ── ② 就绪分 —— 📊 只读派生（零可写控件；demo 的 .drivers checkbox 是假控件，见诚实门①）── */}
      <section className={GCARD_TW} data-testid="wb-gov-readiness">
        <div className={GH_TW}>
          <b className={GH_B_TW}>{t('workbench.gov_readiness_title')}</b>
          <span className={cn(MINIBADGE_TW, TAG_DERIVED_TW, 'inline-flex items-center gap-1')}><ChartNoAxesColumn className="size-3" aria-hidden="true" />{t('workbench.gov_tag_derived')}</span>
        </div>
        <div className="flex items-baseline gap-2.5">
          <b className="font-mono text-[32px] leading-none font-extrabold text-text" data-testid="wb-gov-readiness-score">
            {score === null ? '—' : score}
          </b>
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[13px] font-extrabold whitespace-nowrap',
              band !== null && BAND_TW[band] ? BAND_TW[band] : 'bg-fill-2 text-text-3',
            )}
            data-band={band ?? 'unknown'}
            data-testid="wb-gov-readiness-band"
          >
            {bandText}
          </span>
        </div>
        <div className="mt-2.5 h-2.5 overflow-hidden rounded-md bg-fill-2" aria-hidden="true">
          <div
            className={cn('h-full rounded-md transition-[width] duration-200 ease-out motion-reduce:transition-none', band !== null && BAR_TW[band] ? BAR_TW[band] : 'bg-border-2')}
            style={{ width: `${clamp(score ?? 0, 0, 100)}%` }}
          />
        </div>
        <p className={GNOTE_TW}>{t('workbench.gov_readiness_note', { t1: READY_THRESHOLD, t2: READY_STRONG })}</p>
      </section>

      {/* ── ③ 熔断 · token 预算 —— 阈值 🟢 可写；熔断态 📊 只读派生（无 arm/reset，见诚实门②）── */}
      <section className={GCARD_TW} data-testid="wb-gov-budget">
        <div className={GH_TW}>
          <b className={GH_B_TW}>{t('workbench.gov_budget_title')}</b>
          <span className={cn(MINIBADGE_TW, TAG_RW_TW, 'inline-flex items-center gap-1')}><Pencil className="size-3" aria-hidden="true" />{t('workbench.gov_tag_budget_rw')}</span>
        </div>
        {/* LpSlider 是 LoopCard 的既有导出（原生 input[type=range] + 推荐 ▽ 刻度）——同一控件同一网格。 */}
        <LpSlider
          id="wb-gov-budget-slider"
          label={t('workbench.lp_sld_tokens')}
          value={effTokK}
          min={TOKENS_K_MIN}
          max={TOKENS_K_MAX}
          step={TOKENS_K_STEP}
          display={tokDisplay}
          recoLabel={t('workbench.lp_reco', { v: `${RECO_TOKENS_K}k` })}
          recoFrac={(RECO_TOKENS_K - TOKENS_K_MIN) / (TOKENS_K_MAX - TOKENS_K_MIN)}
          onValue={onTokens}
        />
        {budgetError !== null && (
          <p className={GNOTE_ERR_TW} data-tone="error" data-testid="wb-gov-budget-error" role="alert">
            <CircleAlert className="mr-1 inline size-3.5" aria-hidden="true" />{budgetError}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2.5 rounded-[10px] bg-fill px-3 py-2.5" data-testid="wb-gov-breaker" data-breaker={breaker ?? 'unknown'}>
          <span
            className={cn('size-[11px] flex-none rounded-full', breaker !== null && LAMP_TW[breaker] ? LAMP_TW[breaker] : 'bg-border-2')}
            aria-hidden="true"
          />
          <span className="text-[13px] text-text-2">
            {t('workbench.gov_breaker_label')}{' '}
            {/* 态名是 server 枚举标识符（ok/warn/tripped），mono 原样呈现不翻译——同 runner id 的既有口径 */}
            <b className="font-mono tracking-[0.04em] uppercase" data-testid="wb-gov-breaker-state">
              {breaker ?? '—'}
            </b>
          </span>
          <span className={cn(MINIBADGE_TW, TAG_DERIVED_TW, 'ml-auto inline-flex items-center gap-1')}><ChartNoAxesColumn className="size-3" aria-hidden="true" />{t('workbench.gov_tag_derived_short')}</span>
        </div>
        <p className={cn(GNOTE_TW, 'mt-2')} data-testid="wb-gov-spent">
          {t('workbench.gov_spent', { spent: fmtK(authoritativeSpent), warn: Math.round(BUDGET_WARN_RATIO * 100) })}
        </p>
      </section>

      {/* ── ④ durable ledger + starter wiring —— 生产运行真相，不从预算摘要或 loops.yaml 猜。── */}
      <section className={GCARD_TW} data-health={ledgerHealth} data-testid="wb-gov-ledger">
        <div className={GH_TW}>
          <b className={GH_B_TW}>{t('workbench.gov_facts_title')}</b>
          <span className={cn(MINIBADGE_TW, TAG_DERIVED_TW)}>{t('workbench.gov_facts_tag')}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[12px] leading-[1.45] text-text-2">
          <div className="rounded-[9px] bg-fill px-2.5 py-2">
            <span className="block text-[11px] font-semibold text-text-3">{t('workbench.gov_ledger_health')}</span>
            <b className="mt-0.5 block text-[13px] text-text">
              {ledgerHealth === 'ok'
                ? t('workbench.gov_ledger_health_ok')
                : ledgerHealth === 'degraded'
                  ? t('workbench.gov_ledger_health_degraded')
                  : t('workbench.gov_ledger_health_missing')}
            </b>
          </div>
          <div className="rounded-[9px] bg-fill px-2.5 py-2" data-testid="wb-gov-ledger-inflight">
            <span className="block text-[11px] font-semibold text-text-3">{t('workbench.gov_ledger_inflight')}</span>
            <b className="mt-0.5 block font-mono text-[13px] text-text">
              {ledger ? `${ledger.activated_in_flight} / ${ledger.in_flight}` : '—'}
            </b>
          </div>
        </div>

        <div className="mt-2 space-y-1.5 rounded-[10px] border border-border bg-fill/45 px-3 py-2.5 text-[12px] leading-[1.5] text-text-2">
          <p data-testid="wb-gov-ledger-usage">
            {t('workbench.gov_ledger_usage', {
              actual: fmtK(ledger?.settled_tokens_actual),
              estimated: fmtK(ledger?.settled_tokens_estimated),
            })}
          </p>
          <p data-testid="wb-gov-ledger-reserved">
            {t('workbench.gov_ledger_reserved', { tokens: fmtK(ledger?.reserved_tokens) })}
          </p>
          <p data-testid="wb-gov-ledger-last">
            {t('workbench.gov_ledger_last', { result: ledger?.last_result ?? '—' })}
          </p>
          <p className={ledgerEnforced ? 'text-green-d' : 'text-amber-d'} data-testid="wb-gov-ledger-enforcement">
            {ledgerEnforced ? t('workbench.gov_ledger_enforced') : t('workbench.gov_ledger_unconfirmed')}
          </p>
          {ledger?.health === 'degraded' && (
            <p className="font-semibold text-red-d">
              {t('workbench.gov_ledger_bad', { n: ledger.rejected_records })}
            </p>
          )}
        </div>

        <div className="mt-3 border-t border-border pt-3" data-testid="wb-gov-wiring">
          <p className="mb-2 text-[11px] font-extrabold tracking-[0.08em] text-text-3 uppercase">
            {t('workbench.gov_wiring_title')}
          </p>
          <div className="flex flex-wrap gap-1.5 font-mono text-[11.5px]">
            <span className="rounded-md bg-fill-2 px-2 py-1 text-text-2">
              {t('workbench.gov_wiring_template', {
                template: row.template_id ? `${row.template_id}${row.template_version ? `@v${row.template_version}` : ''}` : '—',
              })}
            </span>
            <span className="rounded-md bg-fill-2 px-2 py-1 text-text-2">
              {t('workbench.gov_wiring_workflow', { workflow: row.workflow_id ?? '—' })}
            </span>
            <span className={cn('rounded-md px-2 py-1', row.skill_bundle_id ? 'bg-green-t text-green-d' : 'bg-amber-t text-amber-d')}>
              {t('workbench.gov_wiring_bundle', {
                bundle: row.skill_bundle_id ?? t('workbench.gov_wiring_unwired'),
              })}
            </span>
          </div>
        </div>
      </section>

      {/* ── 升档确认（风险不对称，见文件头）——文案全复用 LoopsPanel/LoopCard 既有 loops.promote_* 键：
          同一决策同一话术，零新增键。降档不经过这里（直发）。 ── */}
      {confirmLevel !== null && (
        <GovernancePromoteDialog
          target={confirmLevel}
          row={row}
          bandText={bandText}
          onClose={() => setConfirmLevel(null)}
          onConfirm={(target) => {
            setConfirmLevel(null)
            void applyLevel(target)
          }}
        />
      )}
    </aside>
  )
}
