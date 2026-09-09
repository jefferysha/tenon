interface PipelineCatalogStatusProps {
  state: 'loading' | 'ready' | 'unavailable'
  pipelineCount: number
  t: (key: string) => string
}

export function PipelineCatalogStatus({ state, pipelineCount, t }: PipelineCatalogStatusProps): JSX.Element | null {
  if (state === 'loading') return <p className="text-micro text-text-3" role="status">{t('change_create.pipeline_loading')}</p>
  if (state === 'unavailable') return <p className="text-micro text-amber-d" role="status">{t('change_create.pipeline_unavailable')}</p>
  if (pipelineCount === 0) return <p className="text-micro text-red-d" role="alert">{t('change_create.pipeline_empty')}</p>
  return null
}
