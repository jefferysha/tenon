import type { KeyboardEvent } from 'react'
import { useT } from '../i18n'
import type { MandatoryState } from './mandatoryState'
import { HelpPopover } from './HelpPopover'
import { MOBILE_TAP } from './workbenchStyles'
import { TrackSettings } from './TrackSettings'
import { trackDisplayName } from './trackPresentation'

const NOTE_CLS = 'text-caption leading-[1.55] text-text-3'

export function TrackSelector({ state, onDirtyChange }: { state: MandatoryState; onDirtyChange?: (dirty: boolean) => void }): JSX.Element {
  const { lang, t } = useT()

  function onTrackKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = state.matrixTracks.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = last
    if (next === null || next < 0) return
    event.preventDefault()
    const candidate = state.matrixTracks[next]
    if (!candidate) return
    state.setTrack(candidate.id)
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons?.[next]?.focus()
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5 [&_[data-testid=wb-track-settings-toggle]]:min-h-10 [&_[data-testid=wb-track-settings-toggle]]:rounded-md [&_[data-testid=wb-track-settings-toggle]]:px-3.5 [&_[data-testid=wb-track-settings-toggle]]:outline-none [&_[data-testid=wb-track-settings-toggle]]:focus-visible:ring-2 [&_[data-testid=wb-track-settings-toggle]]:focus-visible:ring-(--accent) mobile:[&_[data-testid=wb-track-settings-toggle]]:min-h-11" data-testid="wb-track-control-row">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-caption font-bold text-text-3">
        {t('workbench.track_selector_label')}
        <HelpPopover compact label={t('workbench.track_selector_help_label')}>
          {t('workbench.track_selector_help')}
        </HelpPopover>
      </span>
      {state.table === null ? (
        <span className={NOTE_CLS} role="status" data-testid="wb-track-loading">{t('workbench.track_loading')}</span>
      ) : state.configError !== null ? (
        <>
          <span className="text-caption text-red" role="alert" data-testid="wb-track-load-error">
            {t('workbench.track_load_error')}
          </span>
          <button
            type="button"
            className={`min-h-8 rounded-md border border-red-b bg-card px-3 text-caption font-semibold text-red-d hover:bg-red-t ${MOBILE_TAP}`}
            data-testid="wb-track-retry"
            onClick={() => void state.reloadConfig()}
          >
            {t('workbench.track_retry')}
          </button>
        </>
      ) : state.matrixTracks.length === 0 ? (
        <span className={NOTE_CLS} role="status" data-testid="wb-track-empty">{t('workbench.track_empty')}</span>
      ) : (
        <div
          className="inline-flex min-w-0 flex-wrap gap-1 rounded-md bg-fill p-1 shadow-inner"
          role="radiogroup"
          aria-label={t('workbench.mand_track_group')}
          data-testid="wb-track-tabs"
        >
          {state.matrixTracks.map((candidate, index) => {
            const selected = candidate.id === state.track
            const profile = candidate.policyProfile.skills.profile
            const inherited = state.tracks.find((track) => track.id === profile)
            return (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                className={`min-h-10 cursor-pointer rounded-md border-0 bg-transparent px-3.5 py-2 text-caption font-bold text-text-3 outline-none transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-(--accent) motion-reduce:transition-none not-aria-checked:hover:text-text-2 aria-checked:bg-card aria-checked:text-accent-d aria-checked:shadow-sm ${MOBILE_TAP}`}
                aria-checked={selected}
                title={`${trackDisplayName(candidate, lang)}${profile !== candidate.id ? ` · ${t('workbench.track_selector_inherits', { track: inherited ? trackDisplayName(inherited, lang) : profile })}` : ''}`}
                tabIndex={selected ? 0 : -1}
                data-testid={`wb-track-${candidate.id}`}
                onClick={() => state.setTrack(candidate.id)}
                onKeyDown={(event) => onTrackKeyDown(event, index)}
              >
                {candidate.builtin && <span className="sr-only">{t('workbench.track_selector_system')} </span>}
                {trackDisplayName(candidate, lang)}
                {profile !== candidate.id && <span className="sr-only">, {t('workbench.track_selector_inherits', { track: trackDisplayName(inherited ?? candidate, lang) })}</span>}
              </button>
            )
          })}
        </div>
      )}
      {state.tracks.length > 0 ? <TrackSettings state={state} onDirtyChange={onDirtyChange} /> : null}
    </div>
  )
}
