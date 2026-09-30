import { Plus, X } from 'lucide-react'
import { useT } from '../i18n'
import type { WbStepTest, WbStepTestPolicy } from '../api/governanceTypes'
import { Switch } from '@/components/ui/switch'
import { BUTTON_ICON } from '../shared/uiRecipes'
import { Hint } from './Hint'
import { Choice, FieldRow, KindPicker, NumberField } from './TestPolicyControls'
import { TestPolicyLegacy } from './TestPolicyLegacy'
import {
  FORM_COVERAGE_METRICS, newPolicy, parseLimit, parsePercent, withCoverage, withFlakyMax, withKinds,
  withRequireBaseline, withScenarios, withScope,
} from './testPolicyEdits'

const HEAD_ACTION = 'inline-flex items-center gap-1.5 whitespace-nowrap text-body text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)'
const SCOPES = ['full', 'changed'] as const
const SCENARIOS = ['off', 'required', 'passing'] as const

/**
 * 工作流页门禁段里的测试策略：本阶段的测试策略（结构化表单）+ 旧步骤测试（只读行）。
 * 子块头一行（标题 · 计数 · 动作）；每个字段的说明都在 Tooltip。表单只改它管的键，
 * 其余键（plan / files / run_if_registered / browsers …）原样带回，保存不丢。
 */
export function TestPolicyForm({ stepId, policy, legacyTests, editable, onChange }: {
  stepId: string
  policy: WbStepTestPolicy | undefined
  legacyTests: readonly WbStepTest[]
  editable: boolean
  onChange: (next: WbStepTestPolicy | undefined) => void
}): JSX.Element {
  const { t } = useT()
  const count = policy === undefined ? undefined : new Set([...(policy.kinds ?? []), ...(policy.run ?? [])]).size
  const fieldId = (name: string): string => `wb-policy-${stepId}-${name}`
  const edit = (change: (current: WbStepTestPolicy) => WbStepTestPolicy): void => {
    if (policy !== undefined) onChange(change(policy))
  }
  const disabled = !editable
  return (
    <div className="mt-2 grid gap-2.5 border-t border-border pt-4" data-testid="stage-tests">
      <div className="flex items-center justify-between gap-3 whitespace-nowrap">
        <h3 className="text-body font-medium text-text">
          {t('tests.word.test')}
          {count !== undefined && <span className="ml-2 text-caption font-normal tabular-nums text-text-3" data-testid="wb-policy-count">{count}</span>}
        </h3>
        {editable && policy === undefined && (
          <button type="button" className={HEAD_ACTION} aria-label={t('tests.policy.add_label')} data-testid="wb-policy-add" onClick={() => onChange(newPolicy())}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t('tests.policy.add')}
          </button>
        )}
        {editable && policy !== undefined && (
          <Hint label={t('tests.policy.remove_label')}>
            <button type="button" className={`${BUTTON_ICON} size-8 enabled:hover:text-red-d`} aria-label={t('tests.policy.remove_label')} data-testid="wb-policy-remove" onClick={() => onChange(undefined)}>
              <X className="size-4" aria-hidden="true" />
            </button>
          </Hint>
        )}
      </div>
      {policy !== undefined && (
        <div role="group" aria-label={t('tests.word.test')} data-testid="wb-policy">
          <FieldRow label={t('tests.policy.field.kinds')} hint={t('tests.policy.hint.kinds')} testId="wb-policy-kinds-row">
            <KindPicker label={t('tests.policy.field.kinds')} value={policy.kinds ?? []} disabled={disabled} onChange={(next) => edit((current) => withKinds(current, 'kinds', next))} testId="wb-policy-kinds" />
          </FieldRow>
          <FieldRow label={t('tests.policy.field.run')} hint={t('tests.policy.hint.run')} testId="wb-policy-run-row">
            <KindPicker label={t('tests.policy.field.run')} value={policy.run ?? []} disabled={disabled} onChange={(next) => edit((current) => withKinds(current, 'run', next))} testId="wb-policy-run" />
          </FieldRow>
          <FieldRow label={t('tests.policy.field.scope')} hint={t('tests.policy.hint.scope')} testId="wb-policy-scope-row">
            <Choice
              label={t('tests.policy.field.scope')}
              options={SCOPES.map((id) => ({ id, label: t(`tests.policy.scope.${id}`) }))}
              value={policy.scope ?? 'full'}
              disabled={disabled}
              onChange={(next) => edit((current) => withScope(current, next))}
              testId="wb-policy-scope"
            />
          </FieldRow>
          <FieldRow label={t('tests.policy.field.coverage')} hint={t('tests.policy.hint.coverage')} testId="wb-policy-coverage-row">
            {FORM_COVERAGE_METRICS.map((metric) => (
              <NumberField
                key={metric}
                id={fieldId(`coverage-${metric}`)}
                label={t(`tests.policy.coverage.${metric}`)}
                suffix="%"
                value={policy.coverage?.[metric]}
                parse={parsePercent}
                disabled={disabled}
                onCommit={(value) => edit((current) => withCoverage(current, metric, value))}
                testId={`wb-policy-coverage-${metric}`}
              />
            ))}
          </FieldRow>
          <FieldRow label={t('tests.policy.field.flaky')} hint={t('tests.policy.hint.flaky')} testId="wb-policy-flaky-row" controlId={fieldId('flaky')}>
            <NumberField
              id={fieldId('flaky')}
              label=""
              value={policy.flaky?.max}
              parse={parseLimit}
              disabled={disabled}
              onCommit={(value) => edit((current) => withFlakyMax(current, value))}
              testId="wb-policy-flaky"
            />
          </FieldRow>
          <FieldRow label={t('tests.policy.field.baseline')} hint={t('tests.policy.hint.baseline')} testId="wb-policy-baseline-row">
            <Switch
              checked={policy.benchmark?.require_baseline === true}
              disabled={disabled}
              aria-label={t('tests.policy.field.baseline')}
              data-testid="wb-policy-baseline"
              onCheckedChange={(on) => edit((current) => withRequireBaseline(current, on))}
            />
          </FieldRow>
          <FieldRow label={t('tests.policy.field.scenarios')} hint={t('tests.policy.hint.scenarios')} testId="wb-policy-scenarios-row">
            <Choice
              label={t('tests.policy.field.scenarios')}
              options={SCENARIOS.map((id) => ({ id, label: t(`tests.policy.scenarios.${id}`) }))}
              value={policy.scenarios ?? 'off'}
              disabled={disabled}
              onChange={(next) => edit((current) => withScenarios(current, next))}
              testId="wb-policy-scenarios"
            />
          </FieldRow>
        </div>
      )}
      <TestPolicyLegacy tests={legacyTests} />
      {policy === undefined && legacyTests.length === 0 && !editable && <span className="text-text-3" data-testid="wb-policy-none">—</span>}
    </div>
  )
}
