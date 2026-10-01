import { useT } from '../../i18n'
import { CommandLine } from '../../shared/CommandLine'
import { StatusPill } from '../../shell/ThreeColumns'
import { Tip } from '../../tests/Tip'
import { DefRow, TestSection } from '../../tests/TestSection'
import { formatDuration } from '../../tests/testFormat'
import { reasonLabel, scopeLabel } from '../../tests/testLabels'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../../tests/testStyles'
import type { RecordDetail, RunService, SuiteRun } from '../../api/testSystemTypes'
import { runHref, type RunContext } from './runContext'

function totalsLine(run: SuiteRun, t: (key: string) => string): string {
  const totals = run.totals
  const parts = [
    `${t('tests.case.pass')} ${totals.pass}`,
    `${t('tests.case.fail')} ${totals.fail}`,
    ...(totals.skip > 0 ? [`${t('tests.case.skip')} ${totals.skip}`] : []),
    ...(totals.flaky > 0 ? [`${t('tests.case.flaky')} ${totals.flaky}`] : []),
    ...(totals.knownFail > 0 ? [`${t('tests.case.known-fail')} ${totals.knownFail}`] : []),
  ]
  return parts.join(' · ')
}

const SERVICE_COLUMNS = 'grid-cols-[minmax(0,1.2fr)_6rem_6rem_minmax(0,1fr)]'

function ServiceRows({ services, ctx }: { services: readonly RunService[]; ctx: RunContext }): JSX.Element {
  const { t } = useT()
  return (
    <div role="table" aria-label={t('tests.run.field.services')} data-testid="run-services">
      <div className={`${gridRow(SERVICE_COLUMNS)} ${TABLE_HEAD}`} role="row">
        <span role="columnheader">{t('tests.run.field.services')}</span>
        <span role="columnheader">{t('tests.run.service.ready')}</span>
        <span role="columnheader">{t('tests.run.service.exit')}</span>
        <span role="columnheader">{t('tests.run.service.log')}</span>
      </div>
      {services.map((service) => {
        const danger = service.leaked > 0 || service.exit === 'crashed' || service.exit === 'not-ready' || service.exit === 'leaked'
        return (
          <div key={service.id} className={`${gridRow(SERVICE_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid={`run-service-${service.id}`}>
            <span className="truncate font-mono text-text" role="cell" title={service.id}>{service.id}</span>
            <span className="tabular-nums text-text-2" role="cell">{service.readyMs === null ? '—' : formatDuration(service.readyMs)}</span>
            <span role="cell">
              <StatusPill tone={danger ? 'blocked' : 'done'} testId={`run-service-exit-${service.id}`}>
                {t(`tests.run.service.exit_${service.exit.replace(/-/gu, '_')}`)}
              </StatusPill>
              {service.leaked > 0 && <span className="ml-2 text-caption tabular-nums text-red-d" title={t('tests.run.service.leaked')} data-testid={`run-service-leaked-${service.id}`}>{service.leaked}</span>}
            </span>
            <span className="truncate" role="cell">
              {service.logPresent && service.log !== null
                ? <a className="text-(--accent) underline" href={runHref(ctx, service.log)} download data-testid={`run-service-log-${service.id}`}>{t('tests.run.service.log')}</a>
                : <span className="text-text-3">—</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 运行：命令、目录、退出码、耗时、范围、用例合计、原因、机器与服务就绪。 */
export function RunSummarySection({ run, record, ctx }: { run: SuiteRun; record: RecordDetail; ctx: RunContext }): JSX.Element {
  const { t, lang } = useT()
  return (
    <TestSection title={t('tests.run.section.run')} testId="run-summary">
      <div className="py-1" data-testid="run-command-row"><CommandLine command={run.command} testId="run-command" truncate /></div>
      <div role="table" aria-label={t('tests.run.section.run')}>
        <DefRow label={t('tests.run.field.cwd')} testId="run-cwd"><span title={run.cwd}>{run.cwd}</span></DefRow>
        <DefRow label={t('tests.run.field.exit')} testId="run-exit" mono={false} danger={run.exitCode !== 0}>
          {run.exitCode === null ? '—' : run.exitCode}{run.signal === null ? '' : ` · ${run.signal}`}
        </DefRow>
        <DefRow label={t('tests.word.duration')} testId="run-duration" mono={false}>{formatDuration(run.durationMs)}</DefRow>
        <DefRow label={t('tests.run.field.scope')} testId="run-scope" mono={false}><span title={run.scope}>{scopeLabel(run.scope, t)}</span></DefRow>
        <DefRow label={t('tests.run.field.totals')} testId="run-totals" mono={false}><span title={totalsLine(run, t)}>{totalsLine(run, t)}</span></DefRow>
        {run.reasons.map((reason, index) => (
          <DefRow key={`${reason.code}-${index}`} label={t('tests.run.field.reasons')} testId={`run-reason-${index}`} mono={false} danger>
            <Tip
              tip={<><span className="block font-mono">{reason.code}</span>{reason.detail !== undefined && <span className="block">{reason.detail}</span>}</>}
              testId={`run-reason-label-${index}`}
            >
              {reasonLabel(reason.code, lang)}
            </Tip>
          </DefRow>
        ))}
        <DefRow label={t('tests.run.field.machine')} testId="run-machine">
          <Tip tip={<span className="font-mono">{record.machineProfile}</span>}>{record.machineLabel === '' ? record.machineProfile : record.machineLabel}</Tip>
        </DefRow>
      </div>
      {record.services.length > 0 && <ServiceRows services={record.services} ctx={ctx} />}
    </TestSection>
  )
}
