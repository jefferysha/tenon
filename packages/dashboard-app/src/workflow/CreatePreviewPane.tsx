import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { handleRadioKey } from '../shared/radioKeyboard'
import { LIST_SELECTED_ARIA } from '../shared/uiRecipes'
import type { CreatePreview } from '../workbench/useWorkflowCreate'
import { cn } from '@/lib/utils'

const HEADER = 'flex min-h-10 flex-none items-center gap-2 px-3 whitespace-nowrap'
const COUNT = 'text-caption tabular-nums text-text-3'

/**
 * 新建工作流右栏：起点的轨道（一行一条，点行看该轨道的阶段）在上，阶段列表在下。
 * 没有轨道（空白 / 单条 pipeline）时只有阶段列表。所选轨道由本组件持有，换起点时随父级 key 重置。
 */
export function CreatePreviewPane({ preview }: { preview: CreatePreview }): JSX.Element {
  const { t } = useT()
  const [picked, setPicked] = useState<string | null>(null)
  const tracks = preview.status === 'ready' ? preview.tracks : []
  const track = tracks.find((candidate) => candidate.id === picked) ?? tracks[0]
  const stages = preview.status === 'ready' ? (track?.stages ?? preview.stages) : []
  return (
    <section className="flex min-h-0 flex-col rounded-md bg-fill/45" aria-label={t('workflow.create_preview')} data-testid="wb-workflow-preview">
      {tracks.length > 0 && (
        <>
          <header className={HEADER}>
            <span className="text-caption font-semibold text-text-2">{t('workflow.tracks_title')}</span>
            <span className={COUNT} data-testid="wb-workflow-preview-track-count">{tracks.length}</span>
          </header>
          <div className="max-h-40 flex-none overflow-y-auto px-1.5 pb-1" role="radiogroup" aria-label={t('workflow.tracks_title')} data-testid="wb-workflow-preview-tracks">
            {tracks.map((candidate, index) => {
              const current = candidate.id === track?.id
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  aria-current={current}
                  tabIndex={current ? 0 : -1}
                  className={cn('flex min-h-8 w-full min-w-0 items-center gap-3 rounded-sm px-1.5 text-left text-body whitespace-nowrap text-text outline-none transition-colors duration-(--dur-fast) hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent)', LIST_SELECTED_ARIA, current && 'font-semibold')}
                  title={candidate.label}
                  data-testid={`wb-workflow-preview-track-${candidate.id}`}
                  onClick={() => setPicked(candidate.id)}
                  onKeyDown={(event) => handleRadioKey(event, index, tracks.length, (next) => setPicked(tracks[next]?.id ?? null))}
                >
                  <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                  <span className={cn(COUNT, 'flex-none')}>{candidate.stages.length}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
      <header className={HEADER}>
        <span className="text-caption font-semibold text-text-2">{t('workflow.create_preview')}</span>
        {preview.status === 'ready' && <span className={COUNT} data-testid="wb-workflow-preview-count">{stages.length}</span>}
      </header>
      {preview.status === 'loading' && (
        <LoaderCircle className="mx-auto mt-8 size-5 animate-spin text-text-3 motion-reduce:animate-none" aria-label={t('common.loading')} data-testid="wb-workflow-preview-loading" />
      )}
      {preview.status === 'error' && (
        <p className="truncate px-3 text-caption text-red-d" role="alert" title={preview.text} data-testid="wb-workflow-preview-error">{preview.text}</p>
      )}
      {preview.status === 'ready' && (
        <ol className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" data-testid="wb-workflow-preview-stages">
          {stages.map((stage, index) => (
            <li key={`${index}:${stage}`} className="flex min-h-9 min-w-0 items-center gap-3 px-1.5 whitespace-nowrap">
              <span className="w-5 flex-none text-right text-caption tabular-nums text-text-3">{index + 1}</span>
              <span className="truncate text-body text-text" title={stage}>{stage}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
