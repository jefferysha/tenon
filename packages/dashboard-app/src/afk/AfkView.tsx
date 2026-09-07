import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  Plus,
  Play,
  Search,
  Terminal,
  Workflow,
} from 'lucide-react'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { PageHeader } from '../shared/PageHeader'
import { BUTTON_SOLID, PANEL, SELECT } from '../shared/uiRecipes'
import type { ChangeSnapshot, Snapshot } from '../types'
import type { View } from '../shell/Nav'
import { DEFAULT_RULES, type WorkflowRules } from '../model/workflowModel'
import {
  executionProvenance,
  progressCountsForRows,
  schedulerHealth,
  selectProgress,
  type ProgressRow,
  type ProgressState,
} from '../model/progressModel'
import { fetchAutomationSettings, postAfkEnqueue, postAfkRetry, postAutomationSettings, type WbAutomationSettings } from '../api/client'
import { shellQuote } from '../shared/shellQuote'
import { shortTime } from '../model/time'
import { OperationsPanel } from './OperationsPanel'
import { formatApiError, formatServerProse } from '../api/transport'
import { MiniTrack, phaseLabel } from './AfkMiniTrack'
import { TaskRunPanel } from './TaskRunPanel'

gsap.registerPlugin(useGSAP)

/**
 * AfkView —— 无人值守（AFK）指挥面（2026-07-15 外壳 IA 重构：原进度页那枚「调度 chip」升级成
 * 独立视图）。它既映射后端已算好的自动化状态，也提供真实的 enqueue/retry 写入口；失败任务若有
 * worktree，仍保留终端接管命令。状态变更只调用 server 既有端点，资格与 CAS 判断留在后端。
 *
 * 数据口径全部复用 model/progressModel（不在视图层摸 automation 原始字段，T6 纪律）：
 *   · selectProgress(snapshot, root, rulesByKey) → 各 workflow 组的行 + 五态判定；
 *   · inSandbox = 行处于 running/queued/failed（automation 三桶，schedulerHealth 同折叠口径——
 *     running 含 scheduled、failed 含 conflict）；按此三态分栏；
 *   · schedulerHealth(counts) → 汇总灯 + 计数；并发上限走 fetchAutomationSettings(root).max_parallel。
 *
 * 每行带一条迷你流水线轨（MiniTrack，参照 shell/ProjectsView 的三态节点+连线做法，但这里是
 * 「一条 change 在整条流水线里走到哪一步」）：相位序取该 change 所属 workflow 的 rules.steps
 * （命中 rulesByKey 用其 steps，否则 DEFAULT_RULES；剔末端 archive），change.phase 命中处 = current
 * 高亮、之前 = done、之后 = todo；失败态用语义红点出卡住的当前步。轨纯装饰（aria-hidden——相位
 * 语义由行内 afk.at_phase 文本承载），把「实现 · 沙箱」这种纯文字升级成「看得到在整条流水线哪一步」。
 *
 * 契约：颜色只走 token；状态经 data-* 与 aria；testid=afk-view / afk-sec-* / afk-row-* /
 * afk-track-* / afk-flow-* / afk-cmd-* / afk-empty / afk-limit。
 */
interface AfkViewProps {
  snapshot: Snapshot | null
  /** 当前单项目 root（App 保证 view='afk' 时为真实项目 root，非空）。 */
  currentRoot: string
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  /** 「看它的流水线」跳转（进度页恒同 currentRoot 语境）。 */
  onView: (v: View) => void
  /** 精确打开 Change 审计；缺省时保留旧的仅切换进度视图行为。 */
  onOpenChange?: (name: string) => void
  /** 命令 chip 拷贝反馈 toast。 */
  onToast?: (msg: string) => void
  /** 成功写操作后刷新 canonical snapshot。 */
  onRefresh?: () => Promise<void> | void
}

/** 沙箱谓词：行处于自动化三桶之一（同 ProgressView inSandbox / progressModel schedulerHealth 口径）。 */
function inSandbox(state: ProgressState): boolean {
  return state === 'running' || state === 'queued' || state === 'failed'
}

function fieldStr(c: ChangeSnapshot, key: string): string {
  const v = c.fields[key]
  return typeof v === 'string' ? v : ''
}

interface AfkRow {
  row: ProgressRow
  rules: WorkflowRules | undefined
}

type AfkTool = 'enqueue' | 'starter' | 'run'

export function AfkView({ snapshot, currentRoot, rulesByKey, onView, onOpenChange, onToast, onRefresh }: AfkViewProps): JSX.Element {
  const { lang, t } = useT()
  const rootRef = useRef<HTMLElement>(null)

  const sel = useMemo(() => selectProgress(snapshot, currentRoot, rulesByKey), [snapshot, currentRoot, rulesByKey])
  const rows = useMemo(() => {
    const out: AfkRow[] = []
    for (const g of sel.groups) {
      const rules = g.rules
      for (const r of g.rows) {
        if (executionProvenance(r.change) === 'automation' && inSandbox(r.state)) {
          out.push({ row: r, rules })
        }
      }
    }
    return out
  }, [sel, rulesByKey])

  const health = useMemo(
    () => schedulerHealth(progressCountsForRows(rows.map(({ row }) => row))),
    [rows],
  )
  const enqueueCandidates = useMemo(() => {
    const project = snapshot?.projects.find((item) => item.root === currentRoot && item.ok)
    return (project?.changes ?? []).filter((change) => {
      const automation = fieldStr(change, 'automation')
      return change.archived !== 'true' && (automation === '' || automation === 'off')
    })
  }, [snapshot, currentRoot])
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [retryPreviewName, setRetryPreviewName] = useState<string | null>(null)
  const [activeTool, setActiveTool] = useState<AfkTool | null>(null)
  const actionGeneration = useRef(0)
  const settingsGeneration = useRef(0)
  const rootIdentity = useRef(currentRoot)
  rootIdentity.current = currentRoot
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }

  useEffect(() => () => {
    ++actionGeneration.current
    ++settingsGeneration.current
  }, [])

  useEffect(() => {
    ++actionGeneration.current
    ++settingsGeneration.current
    setActionBusy(null)
    setActionError(null)
    setSettingsBusy(false)
    setSettingsError(null)
    setSelectedName(null)
    setRetryPreviewName(null)
    setActiveTool(null)
  }, [currentRoot])

  // 自动运行设置取真实后端配置；并发修改写回完整配置，避免覆盖重试、默认入队与镜像字段。
  const [automationSettings, setAutomationSettings] = useState<WbAutomationSettings | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<unknown | null>(null)
  useEffect(() => {
    setAutomationSettings(null)
    setSettingsBusy(false)
    setSettingsError(null)
    if (currentRoot === '') return
    const targetRoot = currentRoot
    const generation = ++settingsGeneration.current
    let cancelled = false
    fetchAutomationSettings(targetRoot)
      .then((s) => {
        if (!cancelled && generation === settingsGeneration.current && rootIdentity.current === targetRoot) {
          setAutomationSettings(s)
        }
      })
      .catch(() => {
        /* fail-open */
      })
    return () => {
      cancelled = true
      ++settingsGeneration.current
    }
  }, [currentRoot])

  async function updateMaxParallel(next: number): Promise<void> {
    if (automationSettings === null || settingsBusy || next === automationSettings.max_parallel) return
    const previous = automationSettings
    const updated = { ...previous, max_parallel: next }
    const targetRoot = currentRoot
    const generation = ++settingsGeneration.current
    setAutomationSettings(updated)
    setSettingsBusy(true)
    setSettingsError(null)
    try {
      await postAutomationSettings({ root: targetRoot, ...updated })
      if (generation !== settingsGeneration.current || rootIdentity.current !== targetRoot) return
      onToast?.(localeIdentity.current.t('afk.max_parallel_updated', { n: next }))
    } catch (error) {
      if (generation === settingsGeneration.current && rootIdentity.current === targetRoot) {
        setAutomationSettings(previous)
        setSettingsError(error)
      }
    } finally {
      if (generation === settingsGeneration.current && rootIdentity.current === targetRoot) {
        setSettingsBusy(false)
      }
    }
  }

  // 入场：卡片弹入 stagger（gsap.matchMedia 全包，reduce 直显终态）。
  useGSAP(
    () => {
      const root = rootRef.current
      if (!root || typeof window.matchMedia !== 'function') return
      const mm = gsap.matchMedia()
      mm.add({ motion: '(prefers-reduced-motion: no-preference)' }, () => {
        gsap.from(root.querySelectorAll('[data-anim="afk-card"]'), {
          autoAlpha: 0,
          y: 8,
          duration: 0.28,
          ease: 'power2.out',
          stagger: 0.04,
        })
      })
    },
    { scope: rootRef, dependencies: [rows.length], revertOnUpdate: true },
  )

  /** 失败行有 worktree 才提供终端接管。无 worktree 时不能给 `afk enqueue`：失败态必须走
   *  retry 端点，enqueue 会被后端状态机诚实拒绝。 */
  function cmdFor(change: ChangeSnapshot): { label: string; cmd: string } | null {
    const worktree = fieldStr(change, 'automation_worktree')
    if (worktree !== '') return { label: t('progress.cmd_takeover'), cmd: `cd ${shellQuote(worktree)}` }
    return null
  }
  function copyCmd(cmd: string): void {
    const write = navigator.clipboard?.writeText(cmd)
    if (!write) {
      setActionError(new Error('clipboard unavailable'))
      return
    }
    void write
      .then(() => onToast?.(localeIdentity.current.t('detail.copied', { value: cmd })))
      .catch((error: unknown) => {
        if (rootIdentity.current === currentRoot) setActionError(error)
      })
  }
  async function runAction(key: string, name: string, action: () => Promise<void>, successKey: string): Promise<boolean> {
    const targetRoot = currentRoot
    const generation = ++actionGeneration.current
    setActionBusy(key)
    setActionError(null)
    try {
      await action()
      if (generation !== actionGeneration.current || rootIdentity.current !== targetRoot) return false
      onToast?.(localeIdentity.current.t(successKey, { name }))
      await onRefresh?.()
      return true
    } catch (error) {
      if (generation === actionGeneration.current && rootIdentity.current === targetRoot) {
        setActionError(error)
      }
      return false
    } finally {
      if (generation === actionGeneration.current && rootIdentity.current === targetRoot) {
        setActionBusy(null)
      }
    }
  }

  const priorityRows = useMemo(
    () => [...rows].sort((a, b) => {
      const priority: Record<ProgressState, number> = { failed: 0, running: 1, queued: 2, gate: 3, agent: 4 }
      return priority[a.row.state] - priority[b.row.state] || a.row.change.name.localeCompare(b.row.change.name)
    }),
    [rows],
  )
  const visibleRows = query.trim() === ''
    ? priorityRows
    : priorityRows.filter(({ row }) => {
        const needle = query.trim().toLowerCase()
        return row.change.name.toLowerCase().includes(needle)
          || row.change.phase.toLowerCase().includes(needle)
          || fieldStr(row.change, 'workflow').toLowerCase().includes(needle)
      })
  const selected = visibleRows.find(({ row }) => row.change.name === selectedName) ?? visibleRows[0] ?? null
  const selectedChange = selected?.row.change ?? null
  const selectedRules = selected?.rules
  const selectedState = selected?.row.state ?? null
  const selectedFailure = selectedChange === null || selectedState !== 'failed'
    ? ''
    : formatServerProse(
        fieldStr(selectedChange, 'automation_error') || fieldStr(selectedChange, 'automation_reason'),
        t,
        {
          exposeServerDetail: lang === 'zh',
          fallback: t('afk.failure_default', {
            phase: phaseLabel(selectedChange.phase, selectedRules?.labelByStep, t, selectedRules?.executionModel),
          }),
        },
      )
  const selectedCmd = selectedChange && selectedState === 'failed' ? cmdFor(selectedChange) : null

  function stateLabel(state: ProgressState): string {
    if (state === 'failed') return t('afk.state_needs_attention')
    if (state === 'running') return t('afk.state_running')
    if (state === 'queued') return t('afk.state_queued')
    return t(state === 'gate' ? 'afk.state_awaiting_confirmation' : 'afk.state_waiting')
  }

  function fact(value: string, fallback = t('afk.fact_missing')): string {
    return value.trim() === '' ? fallback : value
  }

  function displayTime(value: string): string {
    if (lang === 'zh') return shortTime(value)
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
    return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6] ?? '00'}` : value
  }

  return (
    <section ref={rootRef} data-testid="afk-view" data-page-frame="standard" className="mx-auto min-w-0 w-full max-w-[1088px] pt-7 pb-5">
      <div data-anim="afk-card">
        <PageHeader
          title={t('afk.title')}
          description={t('afk.subtitle')}
          className="mb-5"
          actions={<div className="flex w-full flex-wrap items-center justify-end gap-3 max-[900px]:justify-start">
          <label className="relative w-full max-w-[350px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
            <span className="sr-only">{t('afk.search_label')}</span>
            <input name="afk-search" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('afk.search_placeholder')} className="h-11 w-full rounded-xl border border-border bg-card pr-3 pl-10 text-sm text-text outline-none transition-[border-color,box-shadow,background-color] focus:border-(--accent) focus:ring-2 focus:ring-(--ring-blue)" />
          </label>
          {rows.length > 0 && <button
            type="button"
            data-testid="afk-new-run"
            className={`${BUTTON_SOLID} min-h-11 flex-none`}
            disabled={enqueueCandidates.length === 0}
            title={enqueueCandidates.length > 0 ? undefined : t('afk.new_unavailable')}
            onClick={() => setActiveTool('enqueue')}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />{t('afk.new_run')}
          </button>}
          <button
            type="button"
            className="inline-flex min-h-11 flex-none items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 text-xs font-semibold text-text-2 hover:bg-fill"
            onClick={() => onView('progress')}
          >
            <Workflow className="h-4 w-4" aria-hidden="true" />{t('afk.view_pipeline')}
          </button>
          </div>}
        />
      </div>

      {actionError !== null && (
        <p className="mb-4 rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-xs text-red" role="alert">
          {t('afk.action_error', { msg: formatApiError(actionError, t, { exposeServerDetail: lang === 'zh' }) })}
        </p>
      )}
      {settingsError !== null && (
        <p className="mb-4 rounded-lg border border-red/30 bg-red/5 px-3 py-2 text-xs text-red" role="alert" data-testid="afk-settings-error">
          {t('afk.action_error', { msg: formatApiError(settingsError, t, { exposeServerDetail: lang === 'zh' }) })}
        </p>
      )}

      {rows.length === 0 ? (
        <p
          className="rounded-xl border border-dashed border-border bg-card px-5 py-10 text-center text-[13px] text-text-3"
          data-anim="afk-card"
          data-testid="afk-empty"
          role="status"
          aria-live="polite"
        >
          {t('afk.empty_runs')}
        </p>
      ) : (
        <div className={`grid min-h-[650px] min-w-0 grid-cols-[360px_minmax(0,1fr)] overflow-hidden max-[760px]:grid-cols-1 ${PANEL}`} data-anim="afk-card">
          <aside className="min-w-0 border-r border-border bg-card p-4 max-[760px]:border-r-0 max-[760px]:border-b" data-testid="afk-queue">
            <div className="flex items-center justify-between py-1">
              <h2 className="text-[17px] font-bold tracking-[-0.01em] text-text">{t('afk.queue_title')}</h2>
              {automationSettings !== null && (
                <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-3">
                  {t('afk.concurrency_label')}
                  <select
                    className={`${SELECT} h-8 px-2 font-mono text-xs font-semibold`}
                    data-testid="afk-limit-input"
                    value={automationSettings.max_parallel}
                    disabled={settingsBusy}
                    onChange={(event) => void updateMaxParallel(Number(event.target.value))}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="mt-3 grid grid-cols-3 rounded-xl bg-fill p-1 text-xs font-semibold" data-testid="afk-health" data-status={health.status}>
              <span className="rounded-lg bg-card px-2 py-2 text-center text-red shadow-sm">{t('afk.health_needs_attention', { n: health.failed })}</span>
              <span className="px-2 py-2 text-center text-text-2">{t('afk.health_running', { n: health.running })}</span>
              <span className="px-2 py-2 text-center text-text-2">{t('afk.health_queued', { n: health.queued })}</span>
            </div>
            {visibleRows.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-6 text-center" data-testid="afk-filter-empty" role="status" aria-live="polite">
                <p className="text-sm font-semibold text-text">{t('afk.empty_runs')}</p>
                <p className="mt-1 text-xs text-text-3">{t('projects.no_results_desc')}</p>
                <button type="button" className="mt-3 min-h-9 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-text-2 hover:bg-fill" onClick={() => setQuery('')}>
                  {t('projects.clear_filters')}
                </button>
              </div>
            ) : <ul className="mt-3 flex flex-col gap-1">
              {visibleRows.map(({ row, rules }) => {
                const change = row.change
                const active = change.name === selectedChange?.name
                return (
                  <li key={change.name} data-testid={`afk-sec-${row.state}`}>
                    <button
                      type="button"
                      className="group w-full rounded-xl border border-transparent px-3.5 py-3.5 text-left transition-[border-color,background-color,transform] hover:bg-fill active:scale-[.985] data-[selected=true]:border-accent-b data-[selected=true]:bg-accent-t motion-reduce:transform-none"
                      data-testid={`afk-row-${change.name}`}
                      data-state={row.state}
                      data-selected={active}
                      onClick={() => setSelectedName(change.name)}
                    >
                      <span className="flex items-center gap-2">
                        <strong className="min-w-0 flex-1 break-words font-mono text-[14px] font-bold text-text">{change.name}</strong>
                        <ChevronRight className="h-4 w-4 text-text-3 opacity-0 transition-opacity group-hover:opacity-100 group-data-[selected=true]:opacity-100" aria-hidden="true" />
                      </span>
                      <span className="mt-1.5 block break-words text-xs font-semibold text-text-2">{t('afk.project_label', { name: currentRoot.split('/').filter(Boolean).pop() ?? currentRoot })}</span>
                      <span className="mt-1 block text-xs text-text-3">{phaseLabel(change.phase, rules?.labelByStep, t, rules?.executionModel)} · {stateLabel(row.state)}</span>
                      <span><MiniTrack change={change} rules={rules} failed={row.state === 'failed'} t={t} /></span>
                    </button>
                  </li>
                )
              })}
            </ul>}
          </aside>

          {selectedChange && selectedState && (
            <main className="min-w-0 p-5 max-[760px]:p-4" data-testid="afk-detail">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono text-[18px] font-bold tracking-[-0.015em] text-text">{selectedChange.name}</h2>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${selectedState === 'failed' ? 'bg-red-t text-red-d' : selectedState === 'running' ? 'bg-green-t text-green-d' : 'bg-fill text-text-2'}`}>{stateLabel(selectedState)}</span>
                  </div>
                  <p className="mt-1.5 text-xs font-medium text-text-3">{t('afk.stage_label', { phase: phaseLabel(selectedChange.phase, selectedRules?.labelByStep, t, selectedRules?.executionModel) })}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]" data-testid="afk-run-facts">
                    <span className="rounded-lg bg-fill px-2.5 py-1.5 font-semibold text-text-2">{t('afk.fact_workflow', { value: fact(fieldStr(selectedChange, 'workflow'), 'default') })}</span>
                    {fieldStr(selectedChange, 'autonomy_level') !== '' && <span className="rounded-lg bg-fill px-2.5 py-1.5 font-semibold text-text-2">{t('afk.fact_autonomy', { value: fieldStr(selectedChange, 'autonomy_level') })}</span>}
                    {fieldStr(selectedChange, 'skill_bundle_id') !== '' && <span className="max-w-full truncate rounded-lg bg-fill px-2.5 py-1.5 font-semibold text-text-2">{t('afk.fact_skills', { value: fieldStr(selectedChange, 'skill_bundle_id') })}</span>}
                    {fieldStr(selectedChange, 'automation_container') !== '' && <span className="max-w-full truncate rounded-lg bg-fill px-2.5 py-1.5 font-semibold text-text-2">{t('afk.fact_container', { value: fieldStr(selectedChange, 'automation_container') })}</span>}
                  </div>
                </div>
                <div className="flex flex-none flex-col items-end gap-2">
                  <span className="text-xs text-text-3">{selectedChange.updated_at ? t('afk.updated_at', { time: displayTime(selectedChange.updated_at) }) : t('afk.updated_unknown')}</span>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-text-2 hover:bg-fill" data-testid={`afk-flow-${selectedChange.name}`} onClick={() => onOpenChange ? onOpenChange(selectedChange.name) : onView('progress')}><Workflow className="h-3.5 w-3.5" aria-hidden="true" />{t('afk.view_pipeline')}</button>
                    {selectedCmd && <button type="button" className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-text-2 hover:bg-fill" data-testid={`afk-cmd-${selectedChange.name}`} title={selectedCmd.cmd} aria-label={`${selectedCmd.label}: ${selectedCmd.cmd}`} onClick={() => copyCmd(selectedCmd.cmd)}><Terminal className="h-3.5 w-3.5" aria-hidden="true" />{t('afk.take_over')}</button>}
                  </div>
                </div>
              </div>

              <section className="mt-5" aria-label={t('afk.progress_label')}>
                <h3 className="text-sm font-semibold text-text">{t('afk.progress_title')}</h3>
                <div className="mt-4 min-w-0 pb-2" data-testid="afk-stage-scroll">
                  <div className="flex min-w-0 items-start max-[760px]:hidden" data-testid="afk-stage-track">
                    {(selectedRules?.steps ?? DEFAULT_RULES.steps).map((step, index, all) => {
                    const current = all.indexOf(selectedChange.phase)
                    const done = current >= 0 && index < current
                    const here = index === current
                    return (
                      <div key={step} className="flex min-w-0 flex-1 items-start">
                        <div className="min-w-[56px] flex-none text-center">
                          <span className={`mx-auto grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold ${done ? 'border-green bg-green text-btn-fg' : here && selectedState === 'failed' ? 'border-red bg-card text-red-d' : here ? 'border-(--accent) bg-(--accent) text-btn-fg' : 'border-border-2 bg-card text-text-3'}`}>
                            {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
                          </span>
                          <span className="mt-2 block text-xs font-semibold text-text">{phaseLabel(step, selectedRules?.labelByStep, t, selectedRules?.executionModel)}</span>
                          <span className={`mt-0.5 block text-[10px] ${here && selectedState === 'failed' ? 'text-red' : 'text-text-3'}`}>{done ? t('afk.stage_done') : here ? stateLabel(selectedState) : t('afk.stage_waiting')}</span>
                        </div>
                        {index < all.length - 1 && <span className={`mt-3.5 h-px min-w-2 flex-1 ${index < current ? 'bg-green' : 'bg-border-2'}`} aria-hidden="true" />}
                      </div>
                    )
                    })}
                  </div>
                  <div className="hidden rounded-xl border border-border bg-fill px-4 py-3 max-[760px]:block" data-testid="afk-current-stage">
                    <p className="text-[11px] font-semibold text-text-3">{t('afk.stage_label', { phase: phaseLabel(selectedChange.phase, selectedRules?.labelByStep, t, selectedRules?.executionModel) })}</p>
                    <p className={`mt-1 text-sm font-bold ${selectedState === 'failed' ? 'text-red-d' : 'text-text'}`}>{stateLabel(selectedState)}</p>
                  </div>
                </div>
              </section>

              <TaskRunPanel root={currentRoot} change={selectedChange.name} />

              {selectedState === 'failed' && (
                <section className="mt-5 rounded-xl border border-red-b bg-red-t/45 px-4 py-3">
                  <div className="flex gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-red" aria-hidden="true" />
                    <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-text">{t('afk.verify_failed_title', { reason: selectedFailure })}</h3><p className="mt-1 text-xs leading-5 text-text-3">{t('afk.verify_failed_hint')}</p></div>
                    <button type="button" className="min-h-9 flex-none rounded-lg bg-btn-bg px-3 text-xs font-semibold text-btn-fg shadow-sm transition-transform active:scale-[.97] motion-reduce:transform-none" data-testid={`afk-retry-preview-${selectedChange.name}`} onClick={() => setRetryPreviewName(selectedChange.name)}>{t('afk.retry_preview')}</button>
                  </div>
                </section>
              )}

              <section className="mt-4 rounded-xl border border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-text">{t('afk.activity_title')}</h3>
                <ul className="mt-3 divide-y divide-border text-xs">
                  <li className="flex gap-3 py-2"><Clock3 className="h-4 w-4 text-text-3" aria-hidden="true" /><span className="text-text-2">{selectedChange.updated_at ? displayTime(selectedChange.updated_at) : t('afk.time_unknown')}</span><strong className="text-text">{selectedState === 'failed' ? t('afk.activity_verify_failed') : stateLabel(selectedState)}</strong></li>
                </ul>
              </section>
            </main>
          )}

        </div>
      )}

      {snapshot?.capabilities.operations === true && (
        <nav
          className="sticky bottom-3 z-30 mx-auto mt-4 flex w-full max-w-[680px] flex-wrap items-center justify-center gap-1 rounded-2xl border border-border bg-card/90 p-1.5 shadow-[0_10px_34px_rgba(15,23,42,.12)] backdrop-blur-2xl"
          aria-label={t('afk.tool_nav_label')}
          data-testid="afk-tool-nav"
        >
          {([
            ['starter', t('afk.tool_schedule'), Plus, false, t('afk.tool_schedule_hint')],
            ['run', t('afk.tool_validate'), Play, false, t('afk.tool_validate_hint')],
          ] as const).map(([tool, label, Icon, disabled, title]) => (
            <button key={tool} type="button" title={title} aria-pressed={activeTool === tool} data-testid={`afk-tool-${tool}`} data-active={activeTool === tool} className="inline-flex min-h-10 min-w-[10.5rem] flex-1 items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold text-text-2 transition-[background-color,transform] hover:bg-fill active:scale-[.97] data-[active=true]:bg-accent-t data-[active=true]:text-accent-d disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transform-none" disabled={disabled} onClick={() => setActiveTool(tool)}><Icon className="h-4 w-4" aria-hidden="true" />{label}</button>
          ))}
        </nav>
      )}

      {activeTool !== null && (activeTool === 'enqueue' || snapshot?.capabilities.operations === true) && (
        <Dialog
          title={t('afk.tool_dialog_label')}
          onClose={() => setActiveTool(null)}
          testid="afk-tool-sheet"
          closeLabel={t('afk.tool_close')}
          closeTestid="afk-tool-close"
          panelClassName="w-full max-w-[760px]"
          variant="workspace"
        >
          <div className="mb-4 border-b border-border pb-3">
            <p className="text-[11px] font-semibold tracking-[.08em] text-text-3">{t('afk.tool_kicker')}</p>
            <h2 className="mt-1 text-lg font-bold text-text">{activeTool === 'enqueue' ? t('afk.tool_start') : activeTool === 'starter' ? t('afk.tool_schedule') : t('afk.tool_validate')}</h2>
          </div>
          {activeTool === 'enqueue' ? (
            <section>
              <p className="text-sm leading-6 text-text-3">{t('afk.tool_start_desc')}</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {enqueueCandidates.map((change) => {
                  const key = `enqueue:${change.name}`
                  return (
                    <button key={change.name} type="button" className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border bg-bg px-4 py-3 text-left hover:border-(--accent) hover:bg-accent-t" data-testid={`afk-enqueue-${change.name}`} disabled={actionBusy !== null} onClick={() => void runAction(key, change.name, () => postAfkEnqueue(change.name, currentRoot), 'afk.enqueue_ok').then((ok) => { if (ok) setActiveTool(null) })}>
                      <span><strong className="block font-mono text-sm text-text">{change.name}</strong><span className="mt-1 block text-xs text-text-3">{t('afk.tool_current_phase', { phase: phaseLabel(change.phase, undefined, t) })}</span></span>
                      <span className="text-xs font-semibold text-(--accent)">{actionBusy === key ? t('afk.tool_starting') : t('afk.tool_start_action')}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          ) : (
            <OperationsPanel root={currentRoot} onToast={onToast} onOpenChange={onOpenChange} activeTool={activeTool} compact />
          )}
        </Dialog>
      )}

      {retryPreviewName !== null && (
        <Dialog
          title={t('afk.retry_dialog_label')}
          onClose={() => setRetryPreviewName(null)}
          testid="afk-retry-sheet"
          panelClassName="w-[min(1040px,92vw)]"
          actions={<>
            <button type="button" className="min-h-11 rounded-xl border border-border-2 bg-card px-4 text-sm font-semibold text-text-2" onClick={() => setRetryPreviewName(null)}>{t('afk.retry_cancel')}</button>
            <button
              type="button"
              data-testid={`afk-retry-confirm-${retryPreviewName}`}
              disabled={actionBusy !== null}
              className="min-h-11 rounded-xl bg-(--accent) px-5 text-sm font-semibold text-btn-fg disabled:opacity-50"
              onClick={() => {
                const name = retryPreviewName
                void runAction(`retry:${name}`, name, () => postAfkRetry(name, currentRoot), 'afk.retry_ok')
                  .then((ok) => { if (ok) setRetryPreviewName(null) })
              }}
            >{actionBusy === `retry:${retryPreviewName}` ? t('afk.retry_submitting') : t('afk.retry_confirm')}</button>
          </>}
        >
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[.08em] text-text-3 uppercase">{t('afk.retry_kicker')}</p>
            <h2 className="mt-1 text-lg font-bold text-text">{t('afk.retry_title', { name: retryPreviewName })}</h2>
            <p className="mt-1 text-xs leading-5 text-text-3">{t('afk.retry_body')}</p>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-xs max-[760px]:grid-cols-1">
            <div className="rounded-xl bg-fill px-3 py-2"><dt className="text-text-3">{t('afk.retry_start_label')}</dt><dd className="mt-1 font-semibold text-text">{t('afk.retry_start_value')}</dd></div>
            <div className="rounded-xl bg-fill px-3 py-2"><dt className="text-text-3">{t('afk.retry_merge_label')}</dt><dd className="mt-1 font-semibold text-text">{t('afk.retry_merge_value')}</dd></div>
            <div className="rounded-xl bg-fill px-3 py-2"><dt className="text-text-3">{t('afk.retry_failure_label')}</dt><dd className="mt-1 font-semibold text-text">{t('afk.retry_failure_value')}</dd></div>
          </dl>
        </Dialog>
      )}
    </section>
  )
}
