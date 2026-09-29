import { useT } from '../i18n'
import type { WbWorkflowDef } from '../api/governanceTypes'
import type { CatalogService, CatalogSuite, KnownFailuresView } from '../api/testSystemTypes'
import { DetailColumn } from '../shell/ThreeColumns'
import { CommandLine } from '../shared/CommandLine'
import { KindIcon } from '../tests/KindIcon'
import { DefRow } from '../tests/TestSection'
import { formatPercent } from '../tests/testFormat'
import { Hinted } from './projectBits'
import { SuiteBaselines } from './SuiteBaselines'
import { SuiteKnownFailures } from './SuiteKnownFailures'
import { THRESHOLD_METRICS, suiteThresholds } from './suiteThresholds'

function serviceHint(service: CatalogService): string {
  return `${service.ready.kind} ${service.ready.value} · ${service.ready.timeoutS}s`
}

/** 右列：套件详情。定义行只写有值的；说明进 Tooltip；基线与已知失败各是一张表，没有内容就不出现。 */
export function SuiteDetail({ root, suite, services, knownFailures, workflow }: {
  root: string
  suite: CatalogSuite
  services: readonly CatalogService[]
  knownFailures: KnownFailuresView
  workflow: WbWorkflowDef | null
}): JSX.Element {
  const { t } = useT()
  const thresholds = suiteThresholds(workflow, suite.kind)
  const own = suite.services.map((id) => services.find((service) => service.id === id) ?? { id })
  return (
    <DetailColumn
      testId="proj-suite-detail"
      panelId="proj-suite-panel"
      header={(
        <div className="mb-5 flex min-w-0 items-center gap-2">
          <KindIcon kind={suite.kind} className="size-5 flex-none text-text-3" />
          <h1 className="min-w-0 flex-1 truncate whitespace-nowrap text-page font-bold tracking-[-.01em] text-text" title={suite.id} data-testid="proj-suite-title">
            {suite.label ?? suite.id}
          </h1>
        </div>
      )}
    >
      <div className="grid gap-8">
        <div role="table" aria-label={suite.id}>
          <div className="py-1"><CommandLine command={suite.command} testId="proj-suite-command" truncate /></div>
          <DefRow label={t('tests.project.detail.cwd')} testId="proj-suite-cwd"><span title={suite.cwd}>{suite.cwd}</span></DefRow>
          <DefRow label={t('tests.project.detail.timeout')} testId="proj-suite-timeout">{suite.timeoutS}s</DefRow>
          <DefRow label={t('tests.project.detail.report')} testId="proj-suite-report">
            <span title={suite.report.path}>{suite.report.path === undefined ? suite.report.format : `${suite.report.format} · ${suite.report.path}`}</span>
          </DefRow>
          {suite.coverage !== undefined && (
            <DefRow label={t('tests.word.coverage')} testId="proj-suite-coverage"><span title={suite.coverage.path}>{`${suite.coverage.format} · ${suite.coverage.path}`}</span></DefRow>
          )}
          {own.length > 0 && (
            <DefRow label={t('tests.project.detail.services')} testId="proj-suite-services" mono={false}>
              <span className="flex flex-nowrap items-center gap-3">
                {own.map((service) => ('ready' in service
                  ? (
                    <Hinted key={service.id} hint={serviceHint(service)} asChild>
                      <button type="button" className="rounded-xs font-mono text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid={`proj-service-${service.id}`}>{service.id}</button>
                    </Hinted>
                  )
                  : <span key={service.id} className="font-mono text-body text-text-2" data-testid={`proj-service-${service.id}`}>{service.id}</span>))}
              </span>
            </DefRow>
          )}
          {suite.browsers.length > 0 && <DefRow label={t('tests.project.detail.browsers')} testId="proj-suite-browsers">{suite.browsers.join(' · ')}</DefRow>}
          {suite.retries > 0 && <DefRow label={t('tests.project.detail.retries')} testId="proj-suite-retries">{suite.retries}</DefRow>}
          {suite.tags.length > 0 && <DefRow label={t('tests.project.detail.tags')} testId="proj-suite-tags">{suite.tags.join(' · ')}</DefRow>}
          <DefRow label={t('tests.project.detail.thresholds')} testId="proj-suite-thresholds">
            {thresholds === null
              ? '—'
              : (
                <Hinted
                  hint={thresholds.sources.map((source) => `${source.stage}: ${THRESHOLD_METRICS.flatMap((metric) => (source.values[metric] === undefined ? [] : [`${t(`tests.project.threshold.${metric}`)} ${formatPercent(source.values[metric] ?? 0)}`])).join(' · ')}`).join(' | ')}
                  asChild
                >
                  <button type="button" className="max-w-full truncate rounded-xs font-mono text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-(--accent)" data-testid="proj-suite-thresholds-value">
                    {THRESHOLD_METRICS.flatMap((metric) => (thresholds.highest[metric] === undefined ? [] : [`${t(`tests.project.threshold.${metric}`)} ${formatPercent(thresholds.highest[metric] ?? 0)}`])).join(' · ')}
                  </button>
                </Hinted>
              )}
          </DefRow>
        </div>
        <SuiteBaselines root={root} suite={suite} />
        <SuiteKnownFailures suite={suite.id} view={knownFailures} />
      </div>
    </DetailColumn>
  )
}
