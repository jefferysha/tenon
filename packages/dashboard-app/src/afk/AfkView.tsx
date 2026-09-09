import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import type { Snapshot } from '../types'
import type { View } from '../shell/views'
import type { WorkflowRules } from '../model/workflowModel'
import { progressCountsForRows, schedulerHealth } from '../model/progressModel'
import { fetchAutomationSettings, postAfkEnqueue, postAfkRetry, postAutomationSettings, type WbAutomationSettings } from '../api/client'
import { formatApiError, formatServerProse } from '../api/transport'
import { shellQuote } from '../shared/shellQuote'
import { shortTime } from '../model/time'
import { matchesQuery, useGlobalSearch } from '../shell/GlobalSearch'
import { DetailEmpty, ThreeColumns } from '../shell/ThreeColumns'
import { useLoops } from '../workbench/LoopCard'
import { fieldStr, rootBasename, stepLabel } from '../workspace/taskRows'
import { AutomationRail } from './AutomationRail'
import { AutomationSettingsPane } from './AutomationSettingsPane'
import { RunDetailPane } from './RunDetailPane'
import { RunListPane } from './RunListPane'
import {
  automationRowsOf,
  rowInLoop,
  rowInScope,
  runFilterMatch,
  takeoverCommand,
  type AutomationRow,
  type AutomationScope,
  type RunFilter,
} from './automationModel'

/**
 * 自动化 = 模板三列页的 AFK 版本：左列范围（全部运行 / 各循环）/ 中列运行列表 / 右列运行详情或节奏设置。
 * 数据口径全部复用 model/progressModel（视图层不摸 automation 原始字段）：
 *   · automationRowsOf → executionProvenance==='automation' 且 running/queued/failed 的行；
 *   · schedulerHealth → 左列「全部运行」副行与设置页状态 pill；
 *   · 并发上限走 fetchAutomationSettings / postAutomationSettings（写回完整配置）。
 * 写入口只有 enqueue（新建运行）与 retry（失败重试，先预览再确认），都是 Dialog；资格与 CAS 判断留在后端。
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
  /** 命令拷贝反馈 toast。 */
  onToast?: (msg: string) => void
  /** 成功写操作后刷新 canonical snapshot。 */
  onRefresh?: () => Promise<void> | void
}

type Panel = 'runs' | 'settings'
const RAIL_KEY = 'tenon-dashboard-rail:automation'

export function AfkView({ snapshot, currentRoot, rulesByKey, onView, onOpenChange, onToast, onRefresh }: AfkViewProps): JSX.Element {
  const { lang, t } = useT()
  const { query, setQuery } = useGlobalSearch()
  const loops = useLoops(currentRoot)

  const rows = useMemo(() => automationRowsOf(snapshot, currentRoot, rulesByKey), [snapshot, currentRoot, rulesByKey])
  const health = useMemo(() => schedulerHealth(progressCountsForRows(rows.map(({ row }) => row))), [rows])
  const enqueueCandidates = useMemo(() => {
    const project = snapshot?.projects.find((item) => item.root === currentRoot && item.ok)
    return (project?.changes ?? []).filter((change) => {
      const automation = fieldStr(change, 'automation')
      return change.archived !== 'true' && (automation === '' || automation === 'off')
    })
  }, [snapshot, currentRoot])

  const [panel, setPanel] = useState<Panel>('runs')
  const [scope, setScope] = useState<AutomationScope>('all')
  const [filter, setFilter] = useState<RunFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [enqueueOpen, setEnqueueOpen] = useState(false)
  const [retryPreviewName, setRetryPreviewName] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown | null>(null)
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])

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

  // 自动运行设置取真实后端配置；并发修改写回完整配置，避免覆盖重试、默认入队与镜像字段。
  const [automationSettings, setAutomationSettings] = useState<WbAutomationSettings | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<unknown | null>(null)

  // 换 root：清掉所有与上一项目相关的选择与在途状态。
  useEffect(() => {
    ++actionGeneration.current
    ++settingsGeneration.current
    setActionBusy(null)
    setActionError(null)
    setSettingsBusy(false)
    setSettingsError(null)
    setPanel('runs')
    setScope('all')
    setFilter('all')
    setSearch('')
    setSelectedName(null)
    setRetryPreviewName(null)
    setEnqueueOpen(false)
  }, [currentRoot])

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

  const loopRows = loops.rows ?? []
  const scopedRows = useMemo(() => rows.filter((row) => rowInScope(row, scope, loopRows)), [rows, scope, loopRows])
  const visibleRows = useMemo(
    () => scopedRows.filter((row) => runFilterMatch(row, filter)
      && matchesQuery(query, row.row.change.name, row.workflow, row.row.change.track, row.row.change.phase)
      && matchesQuery(search, row.row.change.name, row.workflow, row.row.change.track, row.row.change.phase)),
    [scopedRows, filter, query, search],
  )
  // 选中项必须在可见列表里：筛掉后右列跟着清空，不残留上一条的处置动作。
  const selected: AutomationRow | null = visibleRows.find(({ row }) => row.change.name === selectedName) ?? visibleRows[0] ?? null
  const selectedChange = selected?.row.change ?? null
  const selectedFailure = selected === null || selected.row.state !== 'failed'
    ? ''
    : formatServerProse(
        fieldStr(selected.row.change, 'automation_error') || fieldStr(selected.row.change, 'automation_reason'),
        t,
        {
          exposeServerDetail: lang === 'zh',
          fallback: t('afk.failure_default', { phase: stepLabel(selected.row.change.phase, selected.rules, t) }),
        },
      )
  const takeoverCmd = selected !== null && selected.row.state === 'failed' ? takeoverCommand(selected.row.change, shellQuote) : null

  function displayTime(value: string): string {
    return shortTime(value, lang)
  }
  function openPipeline(name: string): void {
    if (onOpenChange) onOpenChange(name)
    else onView('progress')
  }

  const projectName = rootBasename(currentRoot)
  const scopeLoop = scope === 'all' ? null : loopRows.find((loop) => loop.id === scope.loopId) ?? null
  const eyebrow = scopeLoop === null
    ? t('automation.eyebrow', { project: projectName.toUpperCase() })
    : t('automation.eyebrow_loop', { project: projectName.toUpperCase(), loop: scopeLoop.name })
  const operations = snapshot?.capabilities.operations === true

  const detail = panel === 'settings'
    ? (
      <AutomationSettingsPane
        root={currentRoot}
        projectName={projectName}
        health={health}
        settings={automationSettings}
        settingsBusy={settingsBusy}
        onMaxParallel={(next) => void updateMaxParallel(next)}
        operations={operations}
        onToast={onToast}
        onOpenChange={onOpenChange}
      />
    )
    : selected !== null && selectedChange !== null
      ? (
        <RunDetailPane
          key={`${currentRoot} ${selectedChange.name}`}
          row={selected}
          root={currentRoot}
          failureText={selectedFailure}
          takeoverCmd={takeoverCmd}
          onCopy={copyCmd}
          onRetryPreview={() => setRetryPreviewName(selectedChange.name)}
          onOpenPipeline={() => openPipeline(selectedChange.name)}
          displayTime={displayTime}
          settings={automationSettings}
          settingsBusy={settingsBusy}
          onMaxParallel={(next) => void updateMaxParallel(next)}
        />
      )
      : <DetailEmpty title={t('automation.no_selection')} desc={t('automation.no_selection_desc')} testId="afk-detail-empty" />

  return (
    <div data-testid="afk-view">
      {actionError !== null && (
        <p className="border-b border-red-b bg-red-t px-6 py-2 text-caption text-red-d" role="alert">
          {t('afk.action_error', { msg: formatApiError(actionError, t, { exposeServerDetail: lang === 'zh' }) })}
        </p>
      )}
      {settingsError !== null && (
        <p className="border-b border-red-b bg-red-t px-6 py-2 text-caption text-red-d" role="alert" data-testid="afk-settings-error">
          {t('afk.action_error', { msg: formatApiError(settingsError, t, { exposeServerDetail: lang === 'zh' }) })}
        </p>
      )}
      <ThreeColumns
        testId="afk-columns"
        railCollapsed={railCollapsed}
        rail={(
          <AutomationRail
            health={health}
            total={rows.length}
            loops={loops.rows}
            loopsError={loops.loadError}
            countOfLoop={(loop) => rows.filter((row) => rowInLoop(row, loop)).length}
            scope={scope}
            panel={panel}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((value) => !value)}
            onScope={(next) => { setScope(next); setPanel('runs') }}
            onNewRun={() => setEnqueueOpen(true)}
            newRunDisabled={enqueueCandidates.length === 0}
            onSettings={() => setPanel('settings')}
          />
        )}
        list={(
          <RunListPane
            eyebrow={eyebrow}
            rows={scopedRows}
            visibleRows={visibleRows}
            filter={filter}
            onFilter={setFilter}
            search={search}
            onSearch={setSearch}
            selectedName={panel === 'runs' ? selected?.row.change.name ?? null : null}
            onSelect={(row) => { setSelectedName(row.row.change.name); setPanel('runs') }}
            emptyKind={scopedRows.length === 0 ? 'no-run' : 'filtered'}
            onClearFilters={() => { setFilter('all'); setSearch(''); setQuery('') }}
          />
        )}
        detail={detail}
      />

      {enqueueOpen && (
        <Dialog
          title={t('afk.tool_dialog_label')}
          onClose={() => setEnqueueOpen(false)}
          testid="afk-tool-sheet"
          closeLabel={t('afk.tool_close')}
          closeTestid="afk-tool-close"
          panelClassName="w-full max-w-[760px]"
          variant="workspace"
        >
          <div className="mb-4 border-b border-border pb-3">
            <p className="text-micro font-semibold tracking-[.08em] text-text-3">{t('afk.tool_kicker')}</p>
            <h2 className="mt-1 text-title font-bold text-text">{t('afk.tool_start')}</h2>
          </div>
          <section>
            <p className="text-base leading-6 text-text-3">{t('afk.tool_start_desc')}</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {enqueueCandidates.map((change) => {
                const key = `enqueue:${change.name}`
                return (
                  <button
                    key={change.name}
                    type="button"
                    className="flex min-h-14 items-center justify-between gap-3 rounded-md border border-border bg-bg px-4 py-3 text-left hover:border-(--accent) hover:bg-accent-t disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`afk-enqueue-${change.name}`}
                    disabled={actionBusy !== null}
                    onClick={() => void runAction(key, change.name, () => postAfkEnqueue(change.name, currentRoot), 'afk.enqueue_ok').then((ok) => { if (ok) setEnqueueOpen(false) })}
                  >
                    <span>
                      <strong className="block font-mono text-base text-text">{change.name}</strong>
                      <span className="mt-1 block text-caption text-text-3">{t('afk.tool_current_phase', { phase: stepLabel(change.phase, undefined, t) })}</span>
                    </span>
                    <span className="text-caption font-semibold text-(--accent)">{actionBusy === key ? t('afk.tool_starting') : t('afk.tool_start_action')}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </Dialog>
      )}

      {retryPreviewName !== null && (
        <Dialog
          title={t('afk.retry_dialog_label')}
          onClose={() => setRetryPreviewName(null)}
          testid="afk-retry-sheet"
          panelClassName="w-[min(1040px,92vw)]"
          actions={<>
            <button type="button" className="min-h-11 rounded-md border border-border-2 bg-card px-4 text-base font-semibold text-text-2" onClick={() => setRetryPreviewName(null)}>{t('afk.retry_cancel')}</button>
            <button
              type="button"
              data-testid={`afk-retry-confirm-${retryPreviewName}`}
              disabled={actionBusy !== null}
              className="min-h-11 rounded-md bg-(--accent) px-5 text-base font-semibold text-btn-fg disabled:opacity-50"
              onClick={() => {
                const name = retryPreviewName
                void runAction(`retry:${name}`, name, () => postAfkRetry(name, currentRoot), 'afk.retry_ok')
                  .then((ok) => { if (ok) setRetryPreviewName(null) })
              }}
            >{actionBusy === `retry:${retryPreviewName}` ? t('afk.retry_submitting') : t('afk.retry_confirm')}</button>
          </>}
        >
          <div className="min-w-0">
            <p className="text-micro font-semibold tracking-[.08em] text-text-3 uppercase">{t('afk.retry_kicker')}</p>
            <h2 className="mt-1 text-title font-bold text-text">{t('afk.retry_title', { name: retryPreviewName })}</h2>
            <p className="mt-1 text-caption leading-5 text-text-3">{t('afk.retry_body')}</p>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-caption max-[760px]:grid-cols-1">
            <div className="rounded-md bg-fill px-3 py-2"><dt className="text-text-3">{t('afk.retry_start_label')}</dt><dd className="mt-1 font-semibold text-text">{t('afk.retry_start_value')}</dd></div>
            <div className="rounded-md bg-fill px-3 py-2"><dt className="text-text-3">{t('afk.retry_merge_label')}</dt><dd className="mt-1 font-semibold text-text">{t('afk.retry_merge_value')}</dd></div>
            <div className="rounded-md bg-fill px-3 py-2"><dt className="text-text-3">{t('afk.retry_failure_label')}</dt><dd className="mt-1 font-semibold text-text">{t('afk.retry_failure_value')}</dd></div>
          </dl>
        </Dialog>
      )}
    </div>
  )
}
