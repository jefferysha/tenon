import type { WbRouterPreview } from '../api/client'

type Tr = (key: string, vars?: Record<string, string | number>) => string

export function TrackRoutePreview({
  prompt,
  preview,
  busy,
  error,
  fieldClass,
  onPrompt,
  onPreview,
  t,
}: {
  prompt: string
  preview: WbRouterPreview | null
  busy: boolean
  error: string
  fieldClass: string
  onPrompt: (prompt: string) => void
  onPreview: () => void
  t: Tr
}): JSX.Element {
  return (
    <section className="mt-3 rounded-sm border border-border bg-card/70 p-2" data-testid="wb-track-route-impact">
      <div className="mb-2">
        <b className="text-caption text-text">{t('workbench.track_route_preview_title')}</b>
        <p className="mt-0.5 text-micro text-text-3">{t('workbench.track_route_preview_note')}</p>
      </div>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t('workbench.track_route_prompt')}</span>
          <input
            name="track-route-prompt"
            autoComplete="off"
            className={`${fieldClass} w-full`}
            data-testid="wb-track-route-prompt"
            value={prompt}
            placeholder={t('workbench.track_route_prompt_placeholder')}
            onChange={(event) => onPrompt(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="rounded-sm border border-border px-3 py-1.5 text-caption font-bold text-text-2 disabled:opacity-50"
          data-testid="wb-track-route-preview"
          disabled={busy || prompt.trim() === ''}
          onClick={onPreview}
        >
          {busy ? t('workbench.track_route_previewing') : t('workbench.track_route_preview')}
        </button>
      </div>
      {error !== '' && <p className="mt-2 text-caption text-red" role="alert">{error}</p>}
      {preview && (
        <div className="mt-2 text-micro text-text-2" data-testid="wb-track-route-result">
          <p className="font-semibold text-text">
            {preview.suppressed_reason
              ? t('workbench.track_route_suppressed', { reason: preview.suppressed_reason })
              : preview.winner
                ? t('workbench.track_route_winner', { label: preview.winner.track.label, score: preview.winner.score })
                : t('workbench.track_route_no_winner')}
          </p>
          <ul className="mt-1 grid list-none gap-1 p-0 sm:grid-cols-2">
            {preview.candidates.map((candidate) => (
              <li key={candidate.track.id} className="flex justify-between gap-2 rounded-xs bg-fill px-2 py-1">
                <span>{candidate.track.label}</span>
                <code>{t('workbench.track_route_score', { score: candidate.score, priority: candidate.priority })}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
