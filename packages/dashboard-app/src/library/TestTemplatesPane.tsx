import { kindForDirection } from '@tenon/kernel/test-system/vocabulary'
import { useT } from '../i18n'
import { useBuiltinLabels } from '../i18n/builtinLabels'
import type { TestTemplate } from '../api/testTemplatesClient'
import { formatApiError } from '../api/transport'
import { CommandLine } from '../shared/CommandLine'
import { shellQuote } from '../shared/shellQuote'
import { BUTTON_GHOST } from '../shared/uiRecipes'
import { KindLabel } from '../tests/KindLabel'
import { DefRow, TestSection } from '../tests/TestSection'
import { TABLE_HEAD, TABLE_ROW, gridRow } from '../tests/testStyles'
import { CustomMark, DetailTitle, LIST_ROW, LIST_ROW_NAME, ListSkeleton } from './libraryChrome'
import type { TestTemplateLibrary } from './useTestTemplates'

const INPUT_COLUMNS = 'grid-cols-[8rem_minmax(0,1fr)]'
const OUTPUT_COLUMNS = 'grid-cols-[minmax(0,1.6fr)_7rem_5rem]'
const METRIC_COLUMNS = 'grid-cols-[minmax(0,1.4fr)_5rem_5rem_6rem_minmax(0,1fr)]'

export function addCommand(id: string): string {
  return `tenon test catalog add --from ${shellQuote(id)}`
}

function Definition({ template }: { template: TestTemplate }): JSX.Element {
  const { t } = useT()
  const def = template.definition
  const kind = kindForDirection(template.id)
  const inputs = def.inputs ?? []
  const outputs = def.outputs ?? []
  const metrics = def.pass?.metrics ?? []
  return (
    <div className="grid gap-8" data-testid="lib-tt-fields">
      <div role="table" aria-label={template.label}>
        <DefRow label={t('tests.library.field.kind')} testId="lib-tt-field-kind" mono={false}>
          <KindLabel kind={kind} />
        </DefRow>
        <DefRow label={t('tests.word.command')} testId="lib-tt-field-command"><span title={def.command}>{def.command}</span></DefRow>
        {def.cwd !== undefined && def.cwd !== '' && def.cwd !== '.' && <DefRow label={t('tests.library.field.cwd')} testId="lib-tt-field-cwd">{def.cwd}</DefRow>}
        {def.timeout_s !== undefined && <DefRow label={t('tests.library.field.timeout')} testId="lib-tt-field-timeout">{def.timeout_s}s</DefRow>}
        {def.scope !== undefined && <DefRow label={t('tests.library.field.scope')} testId="lib-tt-field-scope" mono={false}>{t(`tests.library.scope.${def.scope}`)}</DefRow>}
        {def.pass?.exit_code !== undefined && <DefRow label={t('tests.library.field.exit_code')} testId="lib-tt-field-exit">{def.pass.exit_code}</DefRow>}
        {def.metrics_path !== undefined && <DefRow label={t('tests.library.field.metrics_path')} testId="lib-tt-field-metrics-path"><span title={def.metrics_path}>{def.metrics_path}</span></DefRow>}
      </div>
      {inputs.length > 0 && (
        <TestSection title={t('tests.library.section.inputs')} count={inputs.length} testId="lib-tt-inputs">
          <div role="table" aria-label={t('tests.library.section.inputs')}>
            <div className={`${gridRow(INPUT_COLUMNS)} ${TABLE_HEAD}`} role="row">
              <span role="columnheader">{t('tests.library.input.kind')}</span>
              <span role="columnheader">{t('tests.library.input.value')}</span>
            </div>
            {inputs.map((input, index) => {
              const value = input.kind === 'document' ? input.ref : input.kind === 'file' ? input.path : input.name
              return (
                <div key={`${input.kind}-${value}-${index}`} className={`${gridRow(INPUT_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid="lib-tt-input">
                  <span role="cell">{t(`tests.library.input.${input.kind}`)}</span>
                  <span className="truncate font-mono text-text-2" role="cell" title={value}>{value}</span>
                </div>
              )
            })}
          </div>
        </TestSection>
      )}
      {outputs.length > 0 && (
        <TestSection title={t('tests.library.section.outputs')} count={outputs.length} testId="lib-tt-outputs">
          <div role="table" aria-label={t('tests.library.section.outputs')}>
            <div className={`${gridRow(OUTPUT_COLUMNS)} ${TABLE_HEAD}`} role="row">
              <span role="columnheader">{t('tests.library.output.path')}</span>
              <span role="columnheader">{t('tests.library.output.kind')}</span>
              <span role="columnheader">{t('tests.library.output.required')}</span>
            </div>
            {outputs.map((output) => (
              <div key={output.path} className={`${gridRow(OUTPUT_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid="lib-tt-output">
                <span className="truncate font-mono text-text" role="cell" title={output.path}>{output.path}</span>
                <span role="cell">{t(`tests.library.output.${output.kind ?? 'other'}`)}</span>
                <span className="text-text-2" role="cell">{t(output.required === false ? 'tests.library.output.optional' : 'tests.library.output.required')}</span>
              </div>
            ))}
          </div>
        </TestSection>
      )}
      {metrics.length > 0 && (
        <TestSection title={t('tests.library.section.metrics')} count={metrics.length} testId="lib-tt-metrics">
          <div role="table" aria-label={t('tests.library.section.metrics')}>
            <div className={`${gridRow(METRIC_COLUMNS)} ${TABLE_HEAD}`} role="row">
              <span role="columnheader">{t('tests.library.metric.name')}</span>
              <span role="columnheader">{t('tests.library.metric.max')}</span>
              <span role="columnheader">{t('tests.library.metric.min')}</span>
              <span role="columnheader">{t('tests.library.metric.regression')}</span>
              <span role="columnheader">{t('tests.library.metric.better')}</span>
            </div>
            {metrics.map((metric) => (
              <div key={metric.name} className={`${gridRow(METRIC_COLUMNS)} ${TABLE_ROW}`} role="row" data-testid="lib-tt-metric">
                <span className="truncate font-mono text-text" role="cell" title={metric.name}>{metric.name}</span>
                <span className="tabular-nums text-text-2" role="cell">{metric.max ?? '—'}</span>
                <span className="tabular-nums text-text-2" role="cell">{metric.min ?? '—'}</span>
                <span className="tabular-nums text-text-2" role="cell">{metric.max_regression_pct === undefined ? '—' : `${metric.max_regression_pct}%`}</span>
                <span className="truncate text-text-2" role="cell">{metric.better === undefined ? '—' : t(`tests.library.metric.${metric.better}`)}</span>
              </div>
            ))}
          </div>
        </TestSection>
      )}
    </div>
  )
}

/** 库页的测试模板：中列列表（只显示名称，标识在悬停提示里）/ 右列结构化只读字段 + 可复制的 catalog add 命令。 */
export function TestTemplatesPane({ slot, library }: { slot: 'list' | 'detail'; library: TestTemplateLibrary }): JSX.Element | null {
  const { t } = useT()
  const builtin = useBuiltinLabels()
  /** 内置方向没被改过的名字按界面语言显示；自定义模板的名字原样。 */
  const nameOf = (template: TestTemplate): string => (template.source === 'custom' ? template.label : builtin.direction(template.id, template.label))
  if (slot === 'list') {
    if (library.loading) return <ListSkeleton testId="lib-tt-loading" />
    if (library.error !== null) {
      return (
        <div className="flex min-w-0 items-center gap-3" data-testid="lib-tt-error">
          <p className="min-w-0 flex-1 truncate whitespace-nowrap text-body text-red-d" role="alert">{formatApiError(library.error, t)}</p>
          <button type="button" className={BUTTON_GHOST} data-testid="lib-tt-retry" onClick={library.reload}>{t('projects.retry')}</button>
        </div>
      )
    }
    return (
      <ul className="grid gap-1" data-testid="lib-test-templates">
        {library.templates.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              className={LIST_ROW}
              aria-current={library.selected?.id === template.id ? 'true' : undefined}
              title={template.id}
              data-testid={`lib-tt-${template.id}`}
              onClick={() => library.select(template.id)}
            >
              <span className={LIST_ROW_NAME}>{nameOf(template)}</span>
              {template.source === 'custom' ? <CustomMark quiet testId={`lib-tt-mark-${template.id}`} /> : <span />}
            </button>
          </li>
        ))}
      </ul>
    )
  }
  const selected = library.selected
  if (selected === null) return null
  return (
    <div className="grid gap-5" data-testid="lib-tt-detail">
      <DetailTitle testId="lib-tt" title={nameOf(selected)} hint={selected.id} custom={selected.source === 'custom'} actions={null} />
      <CommandLine command={addCommand(selected.id)} testId="lib-tt-add" truncate />
      <Definition template={selected} />
    </div>
  )
}
