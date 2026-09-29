import type { MutableRefObject } from 'react'
import { parseDashboardLocation } from '../shell/dashboardLocation'
import type { View } from '../shell/views'

/**
 * Session-history primitives behind useProjectSelection: the Dashboard position marker it writes on
 * its own entries, the host Navigation API index, and the traversal arithmetic between them.
 */

export interface DashboardNavigationTarget {
  readonly view: View
  readonly root: string | null
  readonly change: string | null
}

export interface HistorySnapshot {
  readonly url: string
  readonly state: unknown
}

/** Where the hook believes the session history currently is. */
export interface HistoryCursor {
  readonly position: MutableRefObject<number>
  readonly positionKnown: MutableRefObject<boolean>
  readonly navigationIndex: MutableRefObject<number | null>
}

const HISTORY_POSITION_KEY = '__tenonDashboardPosition'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function historyPosition(state: unknown): number | null {
  if (!isRecord(state)) return null
  const value = state[HISTORY_POSITION_KEY]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** Chromium's Navigation API exposes the physical session-history index even for pre-mount entries. */
export function navigationEntryIndex(): number | null {
  const navigation: unknown = Reflect.get(window, 'navigation')
  if (!isRecord(navigation)) return null
  const currentEntry: unknown = Reflect.get(navigation, 'currentEntry')
  if (!isRecord(currentEntry)) return null
  const index = currentEntry.index
  return typeof index === 'number' && Number.isSafeInteger(index) ? index : null
}

function isNavigationEventTarget(value: unknown): value is EventTarget {
  return isRecord(value)
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
    && typeof value.dispatchEvent === 'function'
}

interface AbortSignalEventTarget extends EventTarget {
  readonly aborted: boolean
}

export function isAbortSignalEventTarget(value: unknown): value is AbortSignalEventTarget {
  return isNavigationEventTarget(value) && typeof Reflect.get(value, 'aborted') === 'boolean'
}

export function navigationEventTarget(): EventTarget | null {
  const navigation: unknown = Reflect.get(window, 'navigation')
  return isNavigationEventTarget(navigation) ? navigation : null
}

export function historyStateAt(position: number): Record<string, unknown> {
  const current = typeof window.history.state === 'object'
    && window.history.state !== null
    && !Array.isArray(window.history.state)
    ? window.history.state as Record<string, unknown>
    : {}
  return { ...current, [HISTORY_POSITION_KEY]: position }
}

function historyStateWithoutPosition(state: unknown): unknown {
  if (!isRecord(state)) return state
  const clean = { ...state }
  delete clean[HISTORY_POSITION_KEY]
  return clean
}

export function currentHistorySnapshot(): HistorySnapshot {
  return {
    url: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    state: window.history.state,
  }
}

export function traverseHistory(delta: number): void {
  if (delta === -1) window.history.back()
  else if (delta === 1) window.history.forward()
  else window.history.go(delta)
}

/** Pushes a Dashboard-marked entry for `url` and moves the cursor onto it. */
export function pushMarkedEntry(cursor: HistoryCursor, url: string): void {
  const nextPosition = cursor.position.current + 1
  const previousNavigationIndex = cursor.navigationIndex.current
  window.history.pushState(historyStateAt(nextPosition), '', url)
  cursor.position.current = nextPosition
  cursor.positionKnown.current = true
  cursor.navigationIndex.current = navigationEntryIndex()
    ?? (previousNavigationIndex === null ? null : previousNavigationIndex + 1)
}

/** Pushes an unmarked copy of `snapshot`; the cursor no longer knows its position. */
export function pushUnmarkedEntry(cursor: HistoryCursor, snapshot: HistorySnapshot): void {
  window.history.pushState(historyStateWithoutPosition(snapshot.state), '', snapshot.url)
  cursor.positionKnown.current = false
  cursor.navigationIndex.current = null
}

/**
 * Traversal delta of a popstate. Prefer our marker for Dashboard-owned entries. Pre-mount/unmarked
 * entries need the host's physical Navigation API index: unlike a guessed Back delta it also
 * identifies Forward. 0 means the direction is unknown.
 */
export function popTraversal(input: {
  readonly previousPosition: number
  readonly previousPositionKnown: boolean
  readonly eventPosition: number | null
  readonly previousNavigationIndex: number | null
  readonly eventNavigationIndex: number | null
}): number {
  const indexedTraversal = input.previousNavigationIndex !== null && input.eventNavigationIndex !== null
    ? input.eventNavigationIndex - input.previousNavigationIndex
    : null
  const markedTraversal = input.previousPositionKnown && input.eventPosition !== null
    ? input.eventPosition - input.previousPosition
    : null
  return markedTraversal !== null && markedTraversal !== 0
    ? markedTraversal
    : (indexedTraversal ?? 0)
}

/** The Dashboard location the browser now shows; a URL without a view keeps `fallbackView`. */
export function linkedNavigationTarget(fallbackView: View): DashboardNavigationTarget {
  const linked = parseDashboardLocation(window.location.search)
  return { view: linked.view ?? fallbackView, root: linked.root ?? null, change: linked.change ?? null }
}
