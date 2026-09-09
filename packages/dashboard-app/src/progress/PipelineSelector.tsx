import type { DefinitionCatalogPipeline } from '../api/definitionCatalogTypes'
import { useT } from '../i18n'

interface PipelineSelectorProps {
  pipelines: DefinitionCatalogPipeline[]
  selectedPipeline: string
  onChange: (value: string) => void
  label: string
  stageSummary: (count: number) => string
}
export function PipelineSelector({ pipelines, selectedPipeline, onChange, label, stageSummary }: PipelineSelectorProps): JSX.Element | null {
  const { t } = useT()
  if (pipelines.length === 0) return null
  const selected = pipelines.find((pipeline) => pipeline.id === selectedPipeline)
  return (
    <div className="block text-micro font-bold uppercase tracking-wider text-text-3" data-testid="change-pipeline-label">
      <label>
        {label}
        <select className="w-full rounded-md border border-border bg-bg px-3 py-2 mt-1.5 font-mono text-caption text-text outline-none focus:border-(--accent) focus:ring-2 focus:ring-accent-t" data-testid="change-pipeline" value={selectedPipeline} onChange={(event) => onChange(event.target.value)}>
          {pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.id}</option>)}
        </select>
      </label>
      <span className="mt-1.5 block normal-case tracking-normal text-text-3">{stageSummary(selected?.stages.length ?? 0)}</span>
      {selected && (
        <ol className="mt-2 grid gap-1.5 normal-case tracking-normal" data-testid="change-pipeline-stages" aria-label={t('change_create.pipeline_order')}>
          {selected.stages.map((stage) => {
            const dependencies = Object.entries(stage.skill_dependencies).filter(([, refs]) => refs.length > 0)
            return (
              <li key={stage.id} className="rounded-sm border border-border bg-card px-2 py-1.5 text-micro text-text-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-text-3">{stage.order + 1}.</span>
                  <span className="font-semibold text-text">{stage.label}</span>
                  <span className="rounded-xs border border-border px-1 py-0.5 font-mono text-micro text-text-3">
                    {t(stage.mode === 'parallel' ? 'change_create.pipeline_parallel' : 'change_create.pipeline_serial')}
                  </span>
                </div>
                <div className="mt-0.5 break-words font-mono text-micro text-text-3">
                  {stage.skill_ids.length > 0 ? stage.skill_ids.join(' → ') : t('change_create.pipeline_no_skills')}
                </div>
                {dependencies.length > 0 && (
                  <div className="mt-0.5 text-micro text-text-3">
                    {t('change_create.pipeline_dependencies', { value: dependencies.map(([skill, refs]) => `${skill} ← ${refs.join(', ')}`).join('; ') })}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
