import { useT } from '../i18n'
import type { WbStepDef } from '../workbench/workbenchDefinition'

export interface DerivedIoPanelProps {
  step: WbStepDef
  steps: readonly WbStepDef[]
  /** 阶段展示名（default 走 i18n phases.*）。 */
  labelOf: (stepId: string) => string
}

/**
 * 阶段的输入 / 产出——**只读推导**，界面上没有手填入口：
 *   · 输入 = 本阶段声明读取的字段；来源 = 上游最近一个把该字段列为产出的阶段；
 *   · 产出 = 本阶段声明登记的字段；登记者 = 本阶段技能（artifacts.producerPolicy=effective-phase-skills），
 *     requiredWhen 给出「哪些轨道非必需」；消费者 = 下游把该字段列为输入的阶段。
 */
export function DerivedIoPanel({ step, steps, labelOf }: DerivedIoPanelProps): JSX.Element {
  const { t } = useT()
  const index = steps.findIndex((candidate) => candidate.id === step.id)
  const upstream = index >= 0 ? steps.slice(0, index) : []
  const downstream = index >= 0 ? steps.slice(index + 1) : []
  const producers = step.skills.map((skill) => skill.id)
  const artifactByField = new Map((step.artifacts ?? []).map((artifact) => [artifact.field, artifact]))

  function producedBy(field: string): string | null {
    for (let i = upstream.length - 1; i >= 0; i -= 1) {
      const candidate = upstream[i]
      if (candidate?.outputs.some((output) => output.field === field)) return candidate.id
    }
    return null
  }
  function consumedBy(field: string): string[] {
    return downstream.filter((candidate) => candidate.inputs.some((input) => input.field === field)).map((candidate) => candidate.id)
  }

  return (
    <div className="grid gap-3" data-testid="derived-io">
      <p className="text-caption text-text-3">{t('workflow.io_hint')}</p>
      <div className="grid grid-cols-2 gap-2.5 max-[900px]:grid-cols-1">
        <section className="grid content-start gap-2.5 rounded-md border border-border bg-card px-3.5 py-3" data-testid="derived-io-inputs">
          <h3 className="text-caption text-text-3">{t('workflow.io_inputs')}</h3>
          {step.inputs.length === 0 ? (
            <p className="text-body text-text-3">{t('workflow.io_none_in')}</p>
          ) : (
            <ul className="grid gap-2.5">
              {step.inputs.map((input) => {
                const source = producedBy(input.field)
                return (
                  <li key={input.field} className="grid gap-0.5" data-testid={`derived-input-${input.field}`}>
                    <span className="font-mono text-body font-semibold text-text">{input.field}</span>
                    <span className="text-caption text-text-2">
                      {input.type} · {source === null ? t('workflow.io_from_unknown') : t('workflow.io_from', { stage: labelOf(source) })}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section className="grid content-start gap-2.5 rounded-md border border-border bg-card px-3.5 py-3" data-testid="derived-io-outputs">
          <h3 className="text-caption text-text-3">{t('workflow.io_outputs')}</h3>
          {step.outputs.length === 0 ? (
            <p className="text-body text-text-3">{t('workflow.io_none_out')}</p>
          ) : (
            <ul className="grid gap-2.5">
              {step.outputs.map((output) => {
                const artifact = artifactByField.get(output.field)
                const consumers = consumedBy(output.field)
                const notes = [
                  output.type,
                  artifact?.requiredWhen?.kind === 'track-not-in'
                    ? t('workflow.io_required_unless', { tracks: artifact.requiredWhen.values.join('、') })
                    : null,
                  consumers.length > 0 ? t('workflow.io_consumed_by', { stages: consumers.map(labelOf).join('、') }) : null,
                ].filter((part): part is string => part !== null)
                return (
                  <li key={output.field} className="grid gap-0.5" data-testid={`derived-output-${output.field}`}>
                    <span className="font-mono text-body font-semibold text-text">{output.field}</span>
                    <span className="text-caption text-text-2">{notes.join(' · ')}</span>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="border-t border-border pt-2 text-caption text-text-3">
            {producers.length > 0 ? t('workflow.io_producers', { skills: producers.join('、') }) : t('workflow.io_producers_none')}
          </p>
        </section>
      </div>
    </div>
  )
}
