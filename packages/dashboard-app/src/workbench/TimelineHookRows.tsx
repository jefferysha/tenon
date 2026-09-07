import { useEffect, useRef, useState } from 'react'
import { ArrowRight, LockKeyhole, LogIn, Wrench } from 'lucide-react'
import type { WbSkillEntry } from '../api/client'
import { useT } from '../i18n'
import type { HooksConfigState } from './HookTimeline'

export const EVENT_META = {
  SessionStart: { titleKey: 'workbench.timeline_event_session_title', hintKey: 'workbench.timeline_event_session_hint', icon: LogIn },
  UserPromptSubmit: { titleKey: 'workbench.timeline_event_prompt_title', hintKey: 'workbench.timeline_event_prompt_hint', icon: ArrowRight },
  PreToolUse: { titleKey: 'workbench.timeline_event_pretool_title', hintKey: 'workbench.timeline_event_pretool_hint', icon: Wrench },
  PostToolUse: { titleKey: 'workbench.timeline_event_posttool_title', hintKey: 'workbench.timeline_event_posttool_hint', icon: Wrench },
} as const

export const EVENT_ORDER = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const

export function sourceLabel(source: WbSkillEntry['source'], t: (key: string) => string): string {
  if (source === 'builtin') return t('workbench.timeline_source_builtin')
  if (source === 'local-plugin') return t('workbench.timeline_source_local')
  if (source === 'external-marketplace') return t('workbench.timeline_source_marketplace')
  return t('workbench.timeline_source_user')
}

export function statusTone(installed: boolean | undefined): string {
  if (installed === true) return 'text-green-d'
  if (installed === false) return 'text-amber-d'
  return 'text-text-3'
}

export function HookRows({
  event,
  stageId,
  config,
  readonly,
}: {
  event: (typeof EVENT_ORDER)[number]
  stageId: string
  config: HooksConfigState
  readonly: boolean
}): JSX.Element {
  const { t } = useT()
  const hooks = config.hooks?.filter((hook) => hook.event === event) ?? []
  if (config.hooks === null) {
    if (config.loadError && event === 'UserPromptSubmit') {
      return <p className="text-xs leading-5 text-red-d" role="alert">{config.loadError}</p>
    }
    return (
      <span className="text-xs text-text-3" role="status" aria-live="polite">
        {config.loadError ? '—' : t('workbench.hk_config_loading')}
      </span>
    )
  }
  if (hooks.length === 0) return <span className="text-xs text-text-3" role="status" aria-live="polite">{t('workbench.timeline_hook_empty')}</span>
  return (
    <div className="flex min-w-0 flex-1 flex-col divide-y divide-border max-[720px]:w-full">
      {hooks.map((hook) => {
        const key = `${hook.id}.${stageId}`
        const enabled = !(key in config.matrix)
        const locked = !hook.configurable
        const nameKey = `workbench.hk_name_${hook.id}`
        const descriptionKey = `workbench.hk_desc_${hook.id}`
        const translatedName = t(nameKey)
        const translatedDescription = t(descriptionKey)
        const fallback = hook.id === 'guard-write-scope'
          ? { name: t('workbench.timeline_hook_guard_scope_name'), description: t('workbench.timeline_hook_guard_scope_desc') }
          : hook.id === 'collect-evidence'
            ? { name: t('workbench.timeline_hook_collect_evidence_name'), description: t('workbench.timeline_hook_collect_evidence_desc') }
            : hook.id === 'load-context'
              ? { name: t('workbench.timeline_hook_load_context_name'), description: t('workbench.timeline_hook_load_context_desc') }
              : { name: hook.id, description: t('workbench.timeline_hook_fallback_desc') }
        const name = translatedName === nameKey ? fallback.name : translatedName
        const description = translatedDescription === descriptionKey ? fallback.description : translatedDescription
        return (
          <div
            key={hook.id}
            className="flex min-h-14 items-center gap-3 py-2"
            data-testid={`wb-timeline-hook-${hook.id}`}
            title={t('workbench.timeline_hook_technical_details', {
              id: hook.id,
              event: hook.event,
              matcher: hook.matcher || '*',
              script: hook.script,
            })}
          >
            {locked || readonly ? <LockKeyhole className="h-4 w-4 flex-none text-text-3" aria-hidden="true" /> : (
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${name} (${hook.id}) · ${t(EVENT_META[event].titleKey)}`}
                data-testid={`wb-lane-hk-sw-${stageId}-${hook.id}`}
                disabled={config.busyKeys.has(key)}
                className="relative h-[22px] w-9 flex-none rounded-full bg-fill-2 transition-colors duration-150 aria-checked:bg-(--accent) disabled:opacity-50 motion-reduce:transition-none after:absolute after:top-[3px] after:left-[3px] after:h-4 after:w-4 after:rounded-full after:bg-card after:shadow-sm after:transition-transform after:duration-150 after:content-[''] aria-checked:after:translate-x-[14px] motion-reduce:after:transition-none"
                onClick={() => config.toggle(hook.id, stageId, !enabled)}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="break-words text-[13px] font-semibold text-text">{name}</span><span className="rounded-full bg-fill-2 px-2 py-0.5 text-[10px] font-semibold text-text-3">{t('workbench.timeline_hook_builtin')}</span></div>
              <p className="mt-0.5 text-[11px] leading-4 text-text-3">{description}</p>
            </div>
            <span className={`text-xs font-semibold ${enabled ? 'text-accent-d' : 'text-text-3'}`}>{t(enabled ? 'workbench.timeline_hook_enabled' : 'workbench.timeline_hook_disabled')}</span>
          </div>
        )
      })}
      {event === 'UserPromptSubmit' && <PromptRoutingBypassEditor config={config} />}
    </div>
  )
}

function PromptRoutingBypassEditor({ config }: { config: HooksConfigState }): JSX.Element {
  const { t, lang } = useT()
  const [draft, setDraft] = useState(config.promptSkipKeyword ?? '')
  const [enabled, setEnabled] = useState(config.promptSkipKeyword !== null && config.promptSkipKeyword !== '')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const lastEnabledKeyword = useRef('no-tenon')
  useEffect(() => setValidationError(null), [lang])

  const effectiveKeyword = enabled ? draft : ''
  const dirty = config.promptSkipKeyword !== null && effectiveKeyword !== config.promptSkipKeyword
  useEffect(() => {
    config.onPromptSkipDirtyChange?.(dirty)
  }, [config.onPromptSkipDirtyChange, dirty])
  useEffect(() => () => {
    config.onPromptSkipDirtyChange?.(false)
  }, [config.onPromptSkipDirtyChange])

  useEffect(() => {
    if (config.promptSkipKeyword === null) return
    setDraft(config.promptSkipKeyword)
    setEnabled(config.promptSkipKeyword !== '')
    if (config.promptSkipKeyword !== '') lastEnabledKeyword.current = config.promptSkipKeyword
  }, [config.promptSkipKeyword])

  const valid = !enabled || /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(draft)

  async function save(): Promise<void> {
    setSaved(false)
    if (!valid) {
      setValidationError(t('workbench.hk_bypass_invalid'))
      return
    }
    setValidationError(null)
    if (await config.savePromptSkipKeyword(enabled ? draft : '')) setSaved(true)
  }

  return (
    <form
      className="mt-2 rounded-xl border border-border bg-fill/60 p-3"
      data-testid="wb-prompt-routing-bypass"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="flex items-start gap-3 max-[720px]:flex-col max-[720px]:gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('workbench.hk_bypass_enable')}
          disabled={config.promptSkipBusy}
          className="relative mt-0.5 h-[22px] w-9 flex-none rounded-full bg-fill-2 transition-colors duration-150 aria-checked:bg-(--accent) disabled:opacity-50 motion-reduce:transition-none after:absolute after:top-[3px] after:left-[3px] after:h-4 after:w-4 after:rounded-full after:bg-card after:shadow-sm after:transition-transform after:duration-150 after:content-[''] aria-checked:after:translate-x-[14px] motion-reduce:after:transition-none"
          onClick={() => {
            setSaved(false)
            setValidationError(null)
            if (enabled) {
              if (draft !== '') lastEnabledKeyword.current = draft
              setEnabled(false)
              setDraft('')
            } else {
              setEnabled(true)
              setDraft(lastEnabledKeyword.current)
            }
          }}
        />
        <div className="min-w-0 flex-1 max-[720px]:w-full">
          <label htmlFor="wb-prompt-skip-keyword" className="block text-[12px] font-semibold text-text">
            {t('workbench.hk_bypass_label')}
          </label>
          <p className="mt-0.5 text-[11px] leading-4 text-text-3">{t('workbench.hk_bypass_hint')}</p>
        </div>
      </div>
      <div className="mt-2 flex gap-2 max-[720px]:flex-col">
        <input
          id="wb-prompt-skip-keyword"
          value={draft}
          disabled={!enabled || config.promptSkipBusy}
          maxLength={33}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            setSaved(false)
            setValidationError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            void save()
          }}
          className="min-w-0 flex-1 rounded-lg border border-border-2 bg-card px-2.5 py-1.5 font-mono text-xs text-text outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={config.promptSkipBusy}
          className="rounded-lg bg-btn-bg px-3 py-1.5 text-xs font-semibold text-btn-fg transition-colors hover:bg-btn-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {config.promptSkipBusy
            ? t('workbench.hk_bypass_saving')
            : config.promptSkipError
              ? t('workbench.hk_bypass_retry')
              : t('workbench.hk_bypass_save')}
        </button>
      </div>
      {(validationError || config.promptSkipError) && (
        <p className="mt-2 text-[11px] leading-4 text-red" role="alert">
          {validationError ?? config.promptSkipError}
        </p>
      )}
      {(saved || (config.promptSkipKeyword === '' && !enabled)) && (
        <p className="mt-2 text-[11px] leading-4 text-green-d" role="status">
          {!enabled
            ? t('workbench.hk_bypass_disabled')
            : t('workbench.hk_bypass_saved', { keyword: draft })}
        </p>
      )}
    </form>
  )
}

export function TimelineHookNodes({
  events,
  stageId,
  config,
  readonly,
}: {
  events: readonly (typeof EVENT_ORDER)[number][]
  stageId: string
  config: HooksConfigState
  readonly: boolean
}): JSX.Element {
  const { t } = useT()
  return <>
    {events.map((event) => {
      const meta = EVENT_META[event]
      const Icon = meta.icon
      return (
        <div key={event} className="relative mb-2 rounded-xl border border-border bg-card px-4 py-2.5" data-testid={`wb-timeline-node-${event}`}>
          <span className="absolute top-3 -left-[47px] z-10 grid h-8 w-8 place-items-center rounded-full border border-border-2 bg-card text-text-3">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 items-start gap-4 mobile:flex-col">
            <div className="w-32 flex-none pt-1">
              <h3 className="text-sm font-semibold text-text">{t(meta.titleKey)}</h3>
              <p className="mt-0.5 font-mono text-[10px] text-text-3">{t(meta.hintKey)}</p>
            </div>
            <HookRows event={event} stageId={stageId} config={config} readonly={readonly} />
          </div>
        </div>
      )
    })}
  </>
}

export function PreviewRow({ label, value, ready }: { label: string; value: string; ready: boolean }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-card px-3 py-2.5">
      <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${ready ? 'bg-green' : 'bg-amb'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1"><strong className="block font-semibold text-text">{label}</strong><span className="mt-0.5 block leading-4 text-text-3">{value}</span></span>
    </div>
  )
}
