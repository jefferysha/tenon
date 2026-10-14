import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { StatusPill } from '../shell/ThreeColumns'
import { fetchTestRecord } from '../api/testSystemClient'
import { formatApiError } from '../api/transport'
import type { RecordDetail, StaleBinding, SuiteRun, SuiteVerdict, TestPolicyView } from '../api/testSystemTypes'
import { Hint } from '../workflow/Hint'
import { KindLabel } from '../tests/KindLabel'
import { blockerLabel } from '../tests/testLabels'
import { ResultMark } from '../tests/TestState'
import { useRemote } from '../tests/useRemote'
import { RunArtifactsSection } from './suiteRun/RunArtifactsSection'
import { RunCasesSection } from './suiteRun/RunCasesSection'
import { RunHistorySection } from './suiteRun/RunHistorySection'
import { RunImageViewer } from './suiteRun/RunImageViewer'
import { RunLogSection } from './suiteRun/RunLogSection'
import { RunBenchmarkSection, RunCoverageSection } from './suiteRun/RunMetricsSections'
import { RunSummarySection } from './suiteRun/RunSummarySection'
import type { RunContext } from './suiteRun/runContext'

/** 要打开的一次套件运行：记录所属用户、运行 id 与套件 id。 */
export interface SuiteRunTarget {
  readonly user: string
  readonly runId: string
  readonly suite: string
}

export interface SuiteRunDrawerProps {
  root: string
  change: string
  target: SuiteRunTarget | null
  /** 该套件在所选阶段的判定（过期原因、基准对比）；缺省 = 只看记录本身。 */
  verdict?: SuiteVerdict
  /** 所选阶段的策略（覆盖率门槛）。 */
  policy?: TestPolicyView | null
  /** 阶段 id → 任务冻结工作流里的阶段名（历史表的阶段列）。 */
  stageLabelOf?: (stage: string) => string
  onClose: () => void
}

const STALE_ORDER: readonly StaleBinding[] = ['candidate', 'workflow', 'catalog', 'plan', 'policy']

function StaleMarks({ bindings }: { bindings: readonly StaleBinding[] }): JSX.Element {
  const { t } = useT()
  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-3 overflow-hidden whitespace-nowrap" data-testid="run-stale">
      <StatusPill tone="pending">{t('tests.state.stale')}</StatusPill>
      {STALE_ORDER.filter((binding) => bindings.includes(binding)).map((binding) => (
        <Hint key={binding} label={t(`tests.run.stale.${binding}_hint`)}>
          <button
            type="button"
            className="whitespace-nowrap rounded-xs text-body text-amber-d outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
            data-testid={`run-stale-${binding}`}
          >
            {t(`tests.run.stale.${binding}`)}
          </button>
        </Hint>
      ))}
    </div>
  )
}

function DrawerBody({ root, change, current, record, run, verdict, policy, stageLabelOf, onSelectRun }: {
  root: string
  change: string
  current: SuiteRunTarget
  record: RecordDetail
  run: SuiteRun
  verdict: SuiteVerdict | undefined
  policy: TestPolicyView | null | undefined
  stageLabelOf: ((stage: string) => string) | undefined
  onSelectRun: (next: SuiteRunTarget) => void
}): JSX.Element {
  const { t, lang } = useT()
  const [zoom, setZoom] = useState<string | null>(null)
  useEffect(() => { setZoom(null) }, [current.runId, current.suite])
  const ctx: RunContext = useMemo(
    () => ({ root, change, user: current.user, runId: current.runId, artifactsDir: record.artifactsDir }),
    [root, change, current.user, current.runId, record.artifactsDir],
  )
  const images = run.artifacts.filter((artifact) => artifact.present && artifact.media === 'image').map((artifact) => artifact.path)
  const sameRun = verdict?.runId === current.runId
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6" data-testid="run-body">
      {!record.trusted && (
        <Hint label={t('tests.run.untrusted_hint')}>
          <button type="button" className="justify-self-start rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="run-untrusted">
            <StatusPill tone="blocked">{blockerLabel('record-chain-broken', lang)}</StatusPill>
          </button>
        </Hint>
      )}
      {sameRun && verdict?.state === 'stale' && (verdict.staleBecause?.length ?? 0) > 0 && <StaleMarks bindings={verdict.staleBecause ?? []} />}
      <RunSummarySection run={run} record={record} ctx={ctx} />
      <RunCasesSection run={run} ctx={ctx} onZoom={setZoom} />
      <RunArtifactsSection run={run} ctx={ctx} onZoom={setZoom} />
      <RunCoverageSection coverage={run.coverage} thresholds={policy?.coverage} />
      <RunBenchmarkSection metrics={run.metrics} verdicts={sameRun ? verdict?.benchmark : undefined} />
      <RunLogSection run={run} ctx={ctx} />
      <RunHistorySection
        root={root}
        change={change}
        suite={current.suite}
        current={current.runId}
        {...(stageLabelOf === undefined ? {} : { stageLabelOf })}
        onSelect={(next) => onSelectRun({ user: next.user, runId: next.runId, suite: current.suite })}
      />
      <RunImageViewer images={images} current={zoom} ctx={ctx} onChange={setZoom} onClose={() => setZoom(null)} />
    </div>
  )
}

/** 套件运行详情抽屉：命令与退出码、失败用例、产物、覆盖率、基准、日志、历史。只读，不执行也不登记。 */
export function SuiteRunDrawer({ root, change, target, verdict, policy, stageLabelOf, onClose }: SuiteRunDrawerProps): JSX.Element | null {
  const { t } = useT()
  const [selected, setSelected] = useState<SuiteRunTarget | null>(target)
  useEffect(() => { setSelected(target) }, [target?.user, target?.runId, target?.suite])
  const current = selected ?? target
  const { state, reload } = useRemote(
    (signal) => fetchTestRecord(root, change, current?.user ?? '', current?.runId ?? '', signal),
    [root, change, current?.user, current?.runId],
    current !== null,
  )
  if (current === null) return null
  const name = verdict?.label ?? current.suite
  const record = state.status === 'ready' ? state.data : null
  const run = record?.suites.find((item) => item.suite === current.suite)
  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      testId="suite-run-drawer"
      ariaLabel={name}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <KindLabel kind={run?.kind ?? verdict?.kind ?? 'custom'} iconOnly />
          <span className="truncate whitespace-nowrap text-title font-semibold text-text" title={current.suite}>{name}</span>
          {run !== undefined && <ResultMark result={run.result} testId="run-result" />}
        </span>
      )}
    >
      {state.status === 'loading' && (
        <div className="grid gap-3" role="status" aria-label={t('common.loading')} data-testid="run-loading">
          {[0, 1, 2].map((index) => <div key={index} className="h-10 animate-pulse rounded-md bg-fill motion-reduce:animate-none" />)}
        </div>
      )}
      {state.status === 'error' && (
        <div className="flex min-w-0 items-center gap-3" data-testid="run-error">
          <p className="min-w-0 flex-1 truncate whitespace-nowrap text-body text-red-d" role="alert">{formatApiError(state.error, t)}</p>
          <button type="button" className={BUTTON_GHOST} data-testid="run-retry" onClick={reload}>{t('projects.retry')}</button>
        </div>
      )}
      {record !== null && run === undefined && (
        <p className="truncate whitespace-nowrap text-body text-red-d" role="alert" data-testid="run-suite-missing">{t('common.invalid_response')}</p>
      )}
      {record !== null && run !== undefined && (
        <DrawerBody root={root} change={change} current={current} record={record} run={run} verdict={verdict} policy={policy} stageLabelOf={stageLabelOf} onSelectRun={setSelected} />
      )}
    </Drawer>
  )
}
