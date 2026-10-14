import { Info } from 'lucide-react'
import { TEST_LEVELS } from '@tenon/kernel/workflow/test-level'
import { useT } from '../i18n'
import type { WbStepTest, WbStepTestPolicy, WbTestLevel } from '../api/governanceTypes'
import { LEVELS_FILE, kindLabel, scopeLabel } from '../tests/testLabels'
import { Hint } from './Hint'
import { legacyPolicyKinds } from './legacyPolicy'
import { Choice } from './TestPolicyControls'
import { TestPolicyLegacy } from './TestPolicyLegacy'

/**
 * 工作流页门禁段里的测试设置：一个档位单选（不要求 / 写计划 / 跑改动 / 全量）+ 旧步骤测试（只读行）。
 * 选档位写 `test` 并删掉旧 `test_policy`（二者互斥）；旧策略在被替换之前只读显示摘要，此时没有档位被选中。
 * 子块头一行（标题 · 说明图标）；档位的具体含义在项目测试目录的 levels，图标的 Tooltip 给出文件路径。
 */
export function TestPolicyForm({ stepId, level, legacyPolicy, legacyTests, editable, onChange }: {
  stepId: string
  level: WbTestLevel | undefined
  legacyPolicy: WbStepTestPolicy | undefined
  legacyTests: readonly WbStepTest[]
  editable: boolean
  onChange: (next: WbTestLevel) => void
}): JSX.Element {
  const { t } = useT()
  const selected: WbTestLevel | null = legacyPolicy === undefined ? level ?? 'none' : null
  const kinds = legacyPolicy === undefined ? [] : legacyPolicyKinds(legacyPolicy)
  const summary = legacyPolicy === undefined
    ? ''
    : [...kinds.map((kind) => kindLabel(kind, t)), ...(legacyPolicy.scope === undefined ? [] : [scopeLabel(legacyPolicy.scope, t)])].join(' · ')
  return (
    <div className="mt-2 grid gap-2.5 border-t border-border pt-4" data-testid="stage-tests" data-step={stepId}>
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <h3 className="text-body font-medium text-text">{t('tests.word.test')}</h3>
        <Hint label={LEVELS_FILE}>
          <button
            type="button"
            className="grid size-6 flex-none place-items-center rounded-sm text-text-3 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
            aria-label={`${t('tests.policy.definition')}: ${LEVELS_FILE}`}
            data-testid="wb-test-level-hint"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </Hint>
      </div>
      <Choice
        label={t('tests.word.level')}
        options={TEST_LEVELS.map((id) => ({ id, label: t(`tests.level.${id}`) }))}
        value={selected}
        disabled={!editable}
        onChange={onChange}
        testId="wb-test-level"
      />
      {legacyPolicy !== undefined && (
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-body text-text-2" data-testid="wb-policy-legacy">
          <span className="flex-none text-caption text-text-3">{t('tests.policy.legacy.policy')}</span>
          <span className="min-w-0 truncate" title={summary === '' ? undefined : summary}>{summary === '' ? '—' : summary}</span>
        </div>
      )}
      <TestPolicyLegacy tests={legacyTests} />
    </div>
  )
}
