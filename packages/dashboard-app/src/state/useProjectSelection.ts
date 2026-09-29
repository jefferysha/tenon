import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dashboardSearch, parseDashboardLocation } from '../shell/dashboardLocation'
import type { View } from '../shell/views'
import type { Snapshot } from '../types'
import {
  currentHistorySnapshot, historyPosition, historyStateAt, isAbortSignalEventTarget, linkedNavigationTarget,
  navigationEntryIndex, navigationEventTarget, popTraversal, pushMarkedEntry, pushUnmarkedEntry, traverseHistory,
  type DashboardNavigationTarget, type HistoryCursor, type HistorySnapshot,
} from './dashboardHistory'
import { resolveProjectSelection, selectedProjectRoot } from './projectSelectionModel'

export type { DashboardNavigationTarget } from './dashboardHistory'

export interface ProjectSelectionController {
  readonly currentRoot: string
  readonly selectProject: (root: string, view: View) => void
  readonly applyLocation: (target: DashboardNavigationTarget) => void
  /** Replays the blocked Back/Forward traversal after its inverse has restored the current entry. */
  readonly confirmPopNavigation: () => void
  /** Cancels any blocked traversal and runs the optional action after its inverse restore settles. */
  readonly cancelPopNavigation: (afterRestore?: () => void) => void
  /** True when same-document traversals can be cancelled at their Navigation API start event. */
  readonly supportsNavigationInterception: boolean
}

export function useProjectSelection(input: {
  readonly snapshot: Snapshot | null
  readonly view: View
  readonly selectedChange: string | null
  readonly onPopView: (view: View) => void
  readonly onSelectedChange: (change: string | null) => void
  /** Return false after capturing the target to keep the last committed URL/UI in place. */
  readonly onPopAttempt?: (target: DashboardNavigationTarget) => boolean
  /** A first ordinary-view request owns the dialog and cancels later traversals before commit. */
  readonly shouldCancelPopBeforeCommit?: () => boolean
  /** Synchronously confirms an already-committed popstate whose direction cannot be recovered. */
  readonly onUninterceptablePopAttempt?: (target: DashboardNavigationTarget) => boolean
  /** Keeps an unavailable root selected while a retained dirty editor is awaiting recovery/discard. */
  readonly preserveUnavailableRoot?: boolean
}): ProjectSelectionController {
  const restoringBlockedPopRef = useRef(false)
  const restoringTraversalRef = useRef(-1)
  const confirmAfterRestoreRef = useRef(false)
  const afterRestoreRef = useRef<(() => void) | null>(null)
  const settlementSequenceRef = useRef(0)
  const allowNextPopRef = useRef(false)
  const historyPositionRef = useRef(historyPosition(window.history.state) ?? 0)
  const historyPositionKnownRef = useRef(historyPosition(window.history.state) !== null)
  const navigationIndexRef = useRef(navigationEntryIndex())
  const cursor: HistoryCursor = { position: historyPositionRef, positionKnown: historyPositionKnownRef, navigationIndex: navigationIndexRef }
  const blockedTraversalRef = useRef(-1)
  const blockedTraversalPendingRef = useRef(false)
  const blockedTraversalReplayableRef = useRef(true)
  const blockedTargetRef = useRef<{
    readonly target: DashboardNavigationTarget
    readonly history: HistorySnapshot
  } | null>(null)
  const committedHistoryRef = useRef<HistorySnapshot>(currentHistorySnapshot())
  const uncancelledTraversalSequenceRef = useRef(0)
  const activeUncancelledTraversalRef = useRef<number | null>(null)
  const uncancelledTraversalCleanupRef = useRef<(() => void) | null>(null)
  const navigationTarget = navigationEventTarget()
  const supportsNavigationInterception = navigationTarget !== null
  const rememberCommittedHistory = useCallback((): void => {
    committedHistoryRef.current = currentHistorySnapshot()
  }, [])
  const clearBlockedTraversal = useCallback((): void => {
    blockedTraversalPendingRef.current = false
    blockedTraversalReplayableRef.current = true
    blockedTargetRef.current = null
  }, [])
  const recoverCommittedHistory = useCallback((): void => {
    pushUnmarkedEntry(cursor, committedHistoryRef.current)
    rememberCommittedHistory()
  }, [rememberCommittedHistory])
  const clearUncancelledTraversal = useCallback((sequence: number): void => {
    if (activeUncancelledTraversalRef.current !== sequence) return
    uncancelledTraversalCleanupRef.current?.()
    uncancelledTraversalCleanupRef.current = null
    activeUncancelledTraversalRef.current = null
  }, [])
  const abortUncancelledTraversal = useCallback((sequence: number): void => {
    if (activeUncancelledTraversalRef.current !== sequence) return
    clearUncancelledTraversal(sequence)
    const settlementSequence = settlementSequenceRef.current
    // A superseding Navigation API event is dispatched in the same task after aborting the old
    // traversal. Let that event establish its own cancel/barrier state before settling the winner.
    queueMicrotask(() => {
      if (settlementSequenceRef.current !== settlementSequence) return
      if (activeUncancelledTraversalRef.current !== null) return
      const afterRestore = afterRestoreRef.current
      afterRestoreRef.current = null
      afterRestore?.()
    })
  }, [clearUncancelledTraversal])
  const beginUncancelledTraversal = useCallback((event: Event): void => {
    const sequence = uncancelledTraversalSequenceRef.current + 1
    uncancelledTraversalSequenceRef.current = sequence
    uncancelledTraversalCleanupRef.current?.()
    activeUncancelledTraversalRef.current = sequence
    const signal: unknown = Reflect.get(event, 'signal')
    if (isAbortSignalEventTarget(signal)) {
      const onAbort = (): void => abortUncancelledTraversal(sequence)
      signal.addEventListener('abort', onAbort, { once: true })
      uncancelledTraversalCleanupRef.current = () => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
    } else {
      uncancelledTraversalCleanupRef.current = null
    }
  }, [abortUncancelledTraversal])
  useEffect(() => {
    if (historyPosition(window.history.state) === null) {
      window.history.replaceState(historyStateAt(historyPositionRef.current), '')
    }
    historyPositionKnownRef.current = true
    rememberCommittedHistory()
  }, [rememberCommittedHistory])
  const [preferredRoot, setPreferredRoot] = useState<string | null>(() => {
    try {
      return parseDashboardLocation(window.location.search).root ?? null
    } catch {
      return null
    }
  })
  const currentRoot = useMemo(
    () => selectedProjectRoot(resolveProjectSelection(input.snapshot?.projects ?? [], preferredRoot)),
    [input.snapshot, preferredRoot],
  )
  const selectProject = useCallback((root: string, view: View) => {
    try {
      const search = dashboardSearch(window.location.search, { view, root, change: null })
      const next = `${window.location.pathname}${search}${window.location.hash}`
      const now = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (next !== now) {
        pushMarkedEntry(cursor, next)
        rememberCommittedHistory()
      }
    } catch {
      // 内存选择仍然生效；仅宿主禁用 history 时失去可后退 URL。
    }
    setPreferredRoot(root)
    input.onSelectedChange(null)
  }, [input.onSelectedChange, rememberCommittedHistory])

  useEffect(() => {
    if (restoringBlockedPopRef.current) return
    try {
      const root = input.snapshot
        ? (currentRoot || (input.preserveUnavailableRoot ? (preferredRoot ?? '') : ''))
        : (preferredRoot ?? '')
      // 聚合工作台（root 为空）也写 change：刷新或分享后仍停在同一任务。
      // 各视图自有的键（工作台 status / step，工作流页 wf / track / step）由 dashboardSearch 在离开时带走。
      const search = dashboardSearch(window.location.search, {
        view: input.view,
        root,
        change: input.view === 'workspace' ? input.selectedChange : null,
      })
      const next = `${window.location.pathname}${search}${window.location.hash}`
      const now = `${window.location.pathname}${window.location.search}${window.location.hash}`
      // 应用内换视图产生一条历史：浏览器返回回到上一个视图，连同当时选中的任务（旧条目保留 change）。
      // 后退 / 前进本身已把 URL 的 view 与状态对齐，走 replace，不会再压一条。
      const linkedView = parseDashboardLocation(window.location.search).view
      if (next !== now && linkedView !== undefined && linkedView !== input.view) {
        pushMarkedEntry(cursor, next)
      } else if (next !== now) {
        window.history.replaceState(window.history.state, '', next)
      }
      rememberCommittedHistory()
    } catch {
      // 禁用 history 的宿主只失去可复制 URL，不影响内存中的显式选择。
    }
  }, [
    currentRoot,
    input.preserveUnavailableRoot,
    input.selectedChange,
    input.snapshot,
    input.view,
    preferredRoot,
    rememberCommittedHistory,
  ])

  useEffect(() => {
    if (!input.snapshot) return
    if (preferredRoot !== null && currentRoot === '' && !input.preserveUnavailableRoot) {
      if (preferredRoot !== null) setPreferredRoot(null)
      if (input.selectedChange !== null) input.onSelectedChange(null)
    }
  }, [
    currentRoot,
    input.onSelectedChange,
    input.preserveUnavailableRoot,
    input.selectedChange,
    input.snapshot,
    input.view,
    preferredRoot,
  ])

  const applyLocation = useCallback((target: DashboardNavigationTarget): void => {
    rememberCommittedHistory()
    input.onPopView(target.view)
    setPreferredRoot(target.root)
    input.onSelectedChange(target.change)
  }, [input.onPopView, input.onSelectedChange, rememberCommittedHistory])

  const commitBlockedTargetFallback = useCallback((): boolean => {
    const blocked = blockedTargetRef.current
    if (blocked === null) return false
    pushUnmarkedEntry(cursor, blocked.history)
    clearBlockedTraversal()
    applyLocation(blocked.target)
    return true
  }, [applyLocation, clearBlockedTraversal])

  const confirmPopNavigation = useCallback((): void => {
    settlementSequenceRef.current += 1
    afterRestoreRef.current = null
    if (!blockedTraversalPendingRef.current) return
    if (restoringBlockedPopRef.current) {
      confirmAfterRestoreRef.current = true
      return
    }
    if (
      (!blockedTraversalReplayableRef.current || !historyPositionKnownRef.current)
      && commitBlockedTargetFallback()
    ) return
    allowNextPopRef.current = true
    traverseHistory(blockedTraversalRef.current)
  }, [commitBlockedTargetFallback])

  const cancelPopNavigation = useCallback((afterRestore?: () => void): void => {
    settlementSequenceRef.current += 1
    confirmAfterRestoreRef.current = false
    if (afterRestore === undefined) {
      clearBlockedTraversal()
      afterRestoreRef.current = null
      return
    }
    if (activeUncancelledTraversalRef.current !== null) {
      clearBlockedTraversal()
      afterRestoreRef.current = afterRestore
      return
    }
    if (restoringBlockedPopRef.current) {
      clearBlockedTraversal()
      afterRestoreRef.current = afterRestore
      return
    }
    clearBlockedTraversal()
    afterRestore()
  }, [clearBlockedTraversal])

  useEffect(() => {
    if (navigationTarget === null) return
    const onNavigate = (event: Event): void => {
      if (
        Reflect.get(event, 'navigationType') !== 'traverse'
        || input.shouldCancelPopBeforeCommit?.() !== true
      ) return
      if (Reflect.get(event, 'canIntercept') !== true || !event.cancelable) {
        beginUncancelledTraversal(event)
        return
      }
      // The ordinary view already owns the confirmation transaction. Cancelling here is the only
      // race-free point: History.popstate is asynchronous and has no ordering guarantee relative
      // to animation frames or timers.
      event.preventDefault()
      if (!event.defaultPrevented) beginUncancelledTraversal(event)
    }
    navigationTarget.addEventListener('navigate', onNavigate)
    return () => navigationTarget.removeEventListener('navigate', onNavigate)
  }, [beginUncancelledTraversal, input.shouldCancelPopBeforeCommit, navigationTarget])

  useEffect(() => () => {
    settlementSequenceRef.current += 1
    uncancelledTraversalCleanupRef.current?.()
    uncancelledTraversalCleanupRef.current = null
    activeUncancelledTraversalRef.current = null
    afterRestoreRef.current = null
  }, [])

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const uncancelledSequence = activeUncancelledTraversalRef.current
      if (uncancelledSequence !== null) clearUncancelledTraversal(uncancelledSequence)
      const previousPosition = historyPositionRef.current
      const previousPositionKnown = historyPositionKnownRef.current
      const eventPosition = historyPosition(event.state)
      const previousNavigationIndex = navigationIndexRef.current
      const eventNavigationIndex = navigationEntryIndex()
      if (restoringBlockedPopRef.current) {
        historyPositionRef.current = eventPosition ?? previousPosition - restoringTraversalRef.current
        historyPositionKnownRef.current = eventPosition !== null
        navigationIndexRef.current = eventNavigationIndex
          ?? (previousNavigationIndex === null ? null : previousNavigationIndex - restoringTraversalRef.current)
        restoringBlockedPopRef.current = false
        if (confirmAfterRestoreRef.current) {
          confirmAfterRestoreRef.current = false
          if (
            (!blockedTraversalReplayableRef.current || !historyPositionKnownRef.current)
            && commitBlockedTargetFallback()
          ) return
          allowNextPopRef.current = true
          traverseHistory(blockedTraversalRef.current)
          return
        }
        const afterRestore = afterRestoreRef.current
        afterRestoreRef.current = null
        afterRestore?.()
        return
      }
      const traversal = popTraversal({
        previousPosition, previousPositionKnown, eventPosition, previousNavigationIndex, eventNavigationIndex,
      })
      const directionUnknown = traversal === 0
      const targetPosition = eventPosition ?? previousPosition + traversal
      historyPositionRef.current = targetPosition
      historyPositionKnownRef.current = eventPosition !== null
      navigationIndexRef.current = eventNavigationIndex
        ?? (previousNavigationIndex === null ? null : previousNavigationIndex + traversal)
      const target = linkedNavigationTarget(input.view)
      if (allowNextPopRef.current) {
        allowNextPopRef.current = false
        clearBlockedTraversal()
        applyLocation(target)
        return
      }
      if (directionUnknown) {
        // Without either our marker or a Navigation API index, popstate arrives after commit and
        // its direction is unknowable. Guessing an inverse can corrupt Forward into Back (or vice
        // versa). Ask synchronously; on cancellation, push an unmarked recovery entry for the retained
        // UI instead of traversing in an invented direction or silently discarding its draft.
        if (input.onUninterceptablePopAttempt?.(target) === false) {
          try {
            recoverCommittedHistory()
            if (blockedTraversalPendingRef.current) {
              blockedTraversalReplayableRef.current = false
            }
          } catch {
            historyPositionRef.current = previousPosition
            historyPositionKnownRef.current = previousPositionKnown
          }
          return
        }
        clearBlockedTraversal()
        afterRestoreRef.current = null
        applyLocation(target)
        return
      }
      if (input.onPopAttempt?.(target) === false) {
        // popstate fires after the browser has selected the target. Undo the exact traversal
        // direction (Back or Forward), then replay that same delta only if the user confirms.
        const blockedTraversal = traversal === 0 ? -1 : traversal
        if (!blockedTraversalPendingRef.current) {
          blockedTraversalRef.current = blockedTraversal
          blockedTraversalPendingRef.current = true
          blockedTraversalReplayableRef.current = true
          blockedTargetRef.current = {
            target,
            history: currentHistorySnapshot(),
          }
        }
        restoringTraversalRef.current = blockedTraversal
        restoringBlockedPopRef.current = true
        traverseHistory(-blockedTraversal)
        return
      }
      applyLocation(target)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [
    applyLocation,
    clearUncancelledTraversal,
    clearBlockedTraversal,
    commitBlockedTargetFallback,
    input.onPopAttempt,
    input.onUninterceptablePopAttempt,
    input.view,
    recoverCommittedHistory,
  ])

  return {
    currentRoot,
    selectProject,
    applyLocation,
    confirmPopNavigation,
    cancelPopNavigation,
    supportsNavigationInterception,
  }
}
