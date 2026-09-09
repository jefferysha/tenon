import { useEffect, useRef, useState, type FormEvent } from 'react'
import { searchRelatedSessions } from '../api/memoryClient'
import {
  RELATED_SESSION_PLATFORMS,
  type RelatedSessionPlatform,
  type RelatedSessionSearchResponse,
} from '../api/memoryTypes'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useT } from '../i18n'

export interface RelatedSessionsSectionProps {
  root: string
  name: string
}

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; response: RelatedSessionSearchResponse }
  | { kind: 'empty'; response: RelatedSessionSearchResponse }
  | { kind: 'error' }
type QueryError = 'too-short' | 'too-long' | 'too-many-tokens' | null
const queryErrorLabels: Readonly<Record<Exclude<QueryError, null>, string>> = {
  'too-short': 'detail.related_sessions.query_error_too_short',
  'too-long': 'detail.related_sessions.query_error_too_long',
  'too-many-tokens': 'detail.related_sessions.query_error_too_many_tokens',
}

const sectionClass = 'border-b border-border py-3 last:border-b-0'
const platformLabels: Readonly<Record<RelatedSessionPlatform, string>> = {
  all: 'detail.related_sessions.platform_all',
  claude: 'detail.related_sessions.platform_claude',
  codex: 'detail.related_sessions.platform_codex',
  opencode: 'detail.related_sessions.platform_opencode',
  pi: 'detail.related_sessions.platform_pi',
}
const budgetWarningCodes = new Set([
  'candidate-limit-reached',
  'candidate-discovery-truncated',
  'file-read-truncated',
  'total-read-budget-exhausted',
])
const sourceWarningCodes = new Set([
  'bounded-read-unavailable',
  'directory-read-unavailable',
  'file-read-unavailable',
  'opencode-reader-unavailable',
  'project-scope-unavailable',
])

function readableChangeName(name: string): string {
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function shortSessionId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

function platformFromValue(value: string): RelatedSessionPlatform | null {
  return RELATED_SESSION_PLATFORMS.find((platform) => platform === value) ?? null
}

function partialReason(response: RelatedSessionSearchResponse): 'budget' | 'source' | 'generic' {
  if (
    response.warnings.length > 0
    && response.warnings.every((warning) => budgetWarningCodes.has(warning.code))
  ) return 'budget'
  if (response.warnings.some((warning) => sourceWarningCodes.has(warning.code))) return 'source'
  return 'generic'
}

function queryErrorFor(value: string): QueryError {
  const length = Array.from(value.trim()).length
  if (length < 2) return 'too-short'
  if (length > 128) return 'too-long'
  if (value.trim().split(/\s+/).filter(Boolean).length > 8) return 'too-many-tokens'
  return null
}

export function RelatedSessionsSection({ root, name }: RelatedSessionsSectionProps): JSX.Element {
  const { lang, t } = useT()
  const [query, setQuery] = useState(() => readableChangeName(name))
  const [platform, setPlatform] = useState<RelatedSessionPlatform>('all')
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const [queryError, setQueryError] = useState<QueryError>(null)
  const abortRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const scope = `${root}\u0000${name}`
  const renderedScopeRef = useRef(scope)
  renderedScopeRef.current = scope

  useEffect(() => {
    generationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setQuery(readableChangeName(name))
    setQueryError(null)
    setPlatform('all')
    setState({ kind: 'idle' })
    return () => {
      generationRef.current += 1
      abortRef.current?.abort()
    }
  }, [name, root])

  async function runSearch(invalidTarget?: HTMLInputElement): Promise<void> {
    const normalizedQuery = query.trim()
    const nextQueryError = queryErrorFor(normalizedQuery)
    setQueryError(nextQueryError)
    if (nextQueryError !== null) {
      invalidTarget?.focus()
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const generation = generationRef.current + 1
    generationRef.current = generation
    setState({ kind: 'loading' })
    try {
      const response = await searchRelatedSessions({
        root,
        name,
        query: normalizedQuery,
        platform,
      }, controller.signal)
      if (
        controller.signal.aborted
        || generation !== generationRef.current
        || renderedScopeRef.current !== scope
      ) return
      setState(response.matches.length === 0 ? { kind: 'empty', response } : { kind: 'results', response })
    } catch {
      if (controller.signal.aborted || generation !== generationRef.current) return
      setState({ kind: 'error' })
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const queryControl = event.currentTarget.querySelector<HTMLInputElement>('#related-session-query')
    void runSearch(queryControl ?? undefined)
  }

  const busy = state.kind === 'loading'
  return (
    <section className={sectionClass} aria-labelledby="related-sessions-heading" data-testid="related-sessions">
      <div>
        <h2 className="text-caption font-bold text-text" id="related-sessions-heading">
          {t('detail.related_sessions.heading')}
        </h2>
        <p className="mt-0.5 text-caption leading-5 text-text-3">{t('detail.related_sessions.hint')}</p>
      </div>
      <form className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]" noValidate onSubmit={submit}>
        <div className="grid gap-1.5">
          <Label htmlFor="related-session-query">{t('detail.related_sessions.query_label')}</Label>
          <Input
            aria-describedby={queryError === null ? undefined : 'related-session-query-error'}
            aria-invalid={queryError !== null}
            autoComplete="off"
            disabled={busy}
            id="related-session-query"
            name="related-session-query"
            onChange={(event) => {
              const nextQuery = event.target.value
              setQuery(nextQuery)
              if (queryError !== null) setQueryError(queryErrorFor(nextQuery))
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }}
            placeholder={t('detail.related_sessions.query_placeholder')}
            required
            value={query}
          />
          {queryError !== null && (
            <p className="text-caption leading-5 text-red-d" id="related-session-query-error" role="alert">
              {t(queryErrorLabels[queryError])}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="related-session-platform">{t('detail.related_sessions.platform_label')}</Label>
          <select
            autoComplete="off"
            className="h-10 rounded-md border border-border bg-card px-3.5 text-base text-text outline-none transition-[border-color,box-shadow,background-color] hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            id="related-session-platform"
            name="related-session-platform"
            onChange={(event) => {
              const next = platformFromValue(event.target.value)
              if (next !== null) setPlatform(next)
            }}
            value={platform}
          >
            {RELATED_SESSION_PLATFORMS.map((value) => (
              <option key={value} value={value}>{t(platformLabels[value])}</option>
            ))}
          </select>
        </div>
        <Button
          className="bg-btn-hover text-btn-fg hover:bg-btn-hover sm:mt-5 sm:self-start"
          disabled={busy}
          type="submit"
        >
          {busy ? t('detail.related_sessions.searching_short') : t('detail.related_sessions.search')}
        </Button>
      </form>

      {state.kind === 'idle' && (
        <p className="mt-3 rounded-md bg-fill px-3 py-2.5 text-caption text-text-3">
          {t('detail.related_sessions.idle')}
        </p>
      )}
      {state.kind === 'loading' && (
        <p className="mt-3 rounded-md bg-fill px-3 py-2.5 text-caption text-text-2" role="status">
          {t('detail.related_sessions.searching')}
        </p>
      )}
      {state.kind === 'empty' && (
        <>
          {state.response.partial && (
            <p className="mt-3 rounded-md border border-amber-b bg-amber-t px-3 py-2 text-caption text-amber-d" role="status">
              {t(
                partialReason(state.response) === 'budget'
                  ? 'detail.related_sessions.partial_budget'
                  : partialReason(state.response) === 'source'
                    ? 'detail.related_sessions.partial_source'
                    : 'detail.related_sessions.partial_generic',
                { n: state.response.warnings.length },
              )}
            </p>
          )}
          <div className="mt-3 rounded-md border border-border bg-fill/40 px-3 py-3 text-caption text-text-3">
            <p>
              {t(
                !state.response.partial
                  ? 'detail.related_sessions.empty'
                  : partialReason(state.response) === 'budget'
                    ? 'detail.related_sessions.empty_partial_budget'
                    : partialReason(state.response) === 'source'
                      ? 'detail.related_sessions.empty_partial_source'
                      : 'detail.related_sessions.empty_partial_generic',
              )}
            </p>
            <Button className="mt-2" onClick={() => { void runSearch() }} size="sm" type="button" variant="outline">
              {t('detail.related_sessions.retry')}
            </Button>
          </div>
        </>
      )}
      {state.kind === 'error' && (
        <div className="mt-3 rounded-md border border-red-b bg-red-t px-3 py-3 text-caption text-red-d" role="alert">
          <p>{t('detail.related_sessions.error')}</p>
          <Button className="mt-2" onClick={() => { void runSearch() }} size="sm" type="button" variant="outline">
            {t('detail.related_sessions.retry')}
          </Button>
        </div>
      )}
      {state.kind === 'results' && (
        <div className="mt-3">
          {state.response.partial && (
            <p className="mb-2 rounded-md border border-amber-b bg-amber-t px-3 py-2 text-caption text-amber-d" role="status">
              {t(
                partialReason(state.response) === 'budget'
                  ? 'detail.related_sessions.partial_budget'
                  : partialReason(state.response) === 'source'
                    ? 'detail.related_sessions.partial_source'
                    : 'detail.related_sessions.partial_generic',
                { n: state.response.warnings.length },
              )}
            </p>
          )}
          <ul
            aria-label={t('detail.related_sessions.results_label')}
            className="m-0 grid list-none gap-2 p-0"
          >
            {state.response.matches.map((match) => (
              <li className="rounded-md border border-border bg-card px-3 py-3" key={`${match.platform}:${match.session_id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <b className="text-body text-text">{match.title?.trim() || shortSessionId(match.session_id)}</b>
                  <span className="text-micro font-semibold text-text-3">
                    {t(platformLabels[match.platform])}
                  </span>
                </div>
                <p className="mt-1 text-caption leading-5 text-text-2 [overflow-wrap:anywhere]">{match.excerpt}</p>
                <p className="mt-2 text-micro text-text-3">
                  {t('detail.related_sessions.match_meta', {
                    n: match.hit_count,
                    score: match.score.toFixed(2),
                    time: match.updated_at
                      ? new Date(match.updated_at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
                      : t('detail.related_sessions.updated_unknown'),
                  })}
                  {match.descendants_merged > 0
                    ? ` · ${t('detail.related_sessions.descendants', { n: match.descendants_merged })}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
