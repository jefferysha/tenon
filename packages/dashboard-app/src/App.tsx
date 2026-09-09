import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { I18nProvider, useT } from './i18n'
import type { Lang } from './i18n/translations'
import { selectInbox } from './inbox/inbox'
import { workflowRulesFromSnapshot } from './model/workflowModel'
import { schedulerHealth, selectProgress } from './model/progressModel'
import { Onboarding } from './shell/Onboarding'
import { useSnapshot } from './state/useSnapshot'
import { parseDashboardLocation } from './shell/dashboardLocation'
import { ErrorBoundary } from './AppErrorBoundary'
import { useProjectSelection } from './state/useProjectSelection'
import { isProjectNavigable, isProjectWritable } from './state/projectSelectionModel'
import { formatApiError } from './api/transport'
import { UnsavedDraftDialog } from './shared/UnsavedDraftDialog'
import { DialogInteractionBoundary } from './shared/Dialog'
import type { DashboardNavigationTarget } from './state/useProjectSelection'
import { useFlash } from './shared/useFlash'
import { useDashboardTheme } from './shell/useDashboardTheme'
import { SnapshotInlineError } from './progress/SnapshotInlineError'
import { BUTTON_GHOST } from './shared/uiRecipes'
import { GlobalSearchProvider } from './shell/GlobalSearch'
import { ProjectGate } from './shell/ProjectGate'
import { TopBar, type TopBarProject } from './shell/TopBar'
import { isView, type View } from './shell/views'

export { ErrorBoundary } from './AppErrorBoundary'

const WorkspaceView = lazy(async () => ({
  default: (await import('./workspace/WorkspaceView')).WorkspaceView,
}))
const AfkView = lazy(async () => ({ default: (await import('./afk/AfkView')).AfkView }))
const WorkflowView = lazy(async () => ({
  default: (await import('./workflow/WorkflowView')).WorkflowView,
}))
const MachineView = lazy(async () => ({
  default: (await import('./machine/MachineView')).MachineView,
}))

// 视图记忆。旧值（overview/projects/hostPlan/inbox/board/…）随 IA 收敛退役——initialView 以 isView
// 白名单校验，不认识的一律兜底回 progress（工作台，默认落地页）。
const VIEW_KEY = 'tenon-dashboard-view'

function initialView(): View {
  try {
    const linked = parseDashboardLocation(window.location.search).view
    if (linked !== undefined) return linked
  } catch {
    /* ignore */
  }
  try {
    const stored = localStorage.getItem(VIEW_KEY)
    if (isView(stored)) return stored
  } catch {
    /* ignore */
  }
  return 'progress'
}

interface PendingNavigation {
  readonly kind: 'view' | 'pop'
  readonly target: DashboardNavigationTarget
}

function AppShell(): JSX.Element {
  const { t, lang, setLang } = useT()
  const [view, setViewState] = useState<View>(initialView)
  const [selectedChange, setSelectedChange] = useState<string | null>(() => {
    try { return parseDashboardLocation(window.location.search).change ?? null } catch { return null }
  })
  const { theme, setTheme } = useDashboardTheme()
  const { flash, flashRef, showFlash } = useFlash(lang)
  const [workbenchDirty, setWorkbenchDirty] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null)
  const pendingNavigationRef = useRef<PendingNavigation | null>(null)
  const viewRef = useRef(view)
  const dirtyRef = useRef(workbenchDirty)
  const currentRootRef = useRef('')
  const retainedWorkbenchRootRef = useRef('')
  viewRef.current = view

  const commitView = useCallback((v: View) => {
    setViewState(v)
    if (v !== 'progress') setSelectedChange(null)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }, [])

  const capturePendingNavigation = useCallback((candidate: PendingNavigation): void => {
    if (pendingNavigationRef.current !== null) return
    pendingNavigationRef.current = candidate
    setPendingNavigation((current) => current ?? candidate)
  }, [])

  const clearPendingNavigation = useCallback((): void => {
    pendingNavigationRef.current = null
    setPendingNavigation(null)
  }, [])

  const onUninterceptablePopAttempt = useCallback((target: DashboardNavigationTarget): boolean => {
    if (pendingNavigationRef.current !== null) return false
    const leavesDirtyWorkbench = target.view !== 'workbench'
      || target.root !== currentRootRef.current
    if (viewRef.current !== 'workbench' || !dirtyRef.current || !leavesDirtyWorkbench) return true
    const discard = window.confirm(`${t('common.unsaved_navigation_title')}\n\n${t('common.unsaved_navigation_body')}`)
    if (!discard) return false
    clearPendingNavigation()
    dirtyRef.current = false
    setWorkbenchDirty(false)
    return true
  }, [clearPendingNavigation, t])

  const onPopAttempt = useCallback((target: DashboardNavigationTarget): boolean => {
    const leavesDirtyWorkbench = target.view !== 'workbench'
      || target.root !== currentRootRef.current
    if (viewRef.current === 'workbench' && dirtyRef.current && leavesDirtyWorkbench) {
      capturePendingNavigation({ kind: 'pop', target })
      return false
    }
    return true
  }, [capturePendingNavigation])
  const { snapshot, loading, error, connected, refresh, reconnect } = useSnapshot()
  const preserveUnavailableWorkbenchRoot = view === 'workbench'
    && workbenchDirty
    && retainedWorkbenchRootRef.current !== ''
    && !isProjectWritable(snapshot?.projects.find(
      (project) => project.root === retainedWorkbenchRootRef.current,
    ))
  const snapshotError = error === null ? null : formatApiError(error, t)
  const staleSnapshotError =
    error === null
      ? null
      : typeof error.status === 'number'
        ? t('common.snapshot_request_failed', { status: error.status })
        : t('common.snapshot_request_failed_unknown')
  const {
    currentRoot,
    selectProject,
    confirmPopNavigation,
    cancelPopNavigation,
    supportsNavigationInterception,
  } = useProjectSelection({
    snapshot,
    view,
    selectedChange,
    onPopView: commitView,
    onSelectedChange: setSelectedChange,
    onPopAttempt,
    shouldCancelPopBeforeCommit: () => pendingNavigationRef.current?.kind === 'view',
    onUninterceptablePopAttempt,
    preserveUnavailableRoot: preserveUnavailableWorkbenchRoot,
  })
  currentRootRef.current = currentRoot

  const setView = useCallback((nextView: View): void => {
    if (viewRef.current === 'workbench' && dirtyRef.current && nextView !== 'workbench') {
      if (!supportsNavigationInterception && pendingNavigationRef.current === null) {
        const discard = window.confirm(`${t('common.unsaved_navigation_title')}\n\n${t('common.unsaved_navigation_body')}`)
        if (!discard) return
        dirtyRef.current = false
        setWorkbenchDirty(false)
        commitView(nextView)
        return
      }
      capturePendingNavigation({
        kind: 'view',
        target: {
          view: nextView,
          root: currentRootRef.current || null,
          change: nextView === 'progress' ? selectedChange : null,
        },
      })
      return
    }
    commitView(nextView)
  }, [capturePendingNavigation, commitView, selectedChange, supportsNavigationInterception, t])

  const closePendingNavigation = useCallback(() => {
    cancelPopNavigation(clearPendingNavigation)
  }, [cancelPopNavigation, clearPendingNavigation])

  const discardAndNavigate = useCallback(() => {
    if (!pendingNavigation) return
    const pending = pendingNavigation
    if (pending.kind === 'pop') {
      clearPendingNavigation()
      dirtyRef.current = false
      setWorkbenchDirty(false)
      confirmPopNavigation()
      return
    }
    cancelPopNavigation(() => {
      clearPendingNavigation()
      dirtyRef.current = false
      setWorkbenchDirty(false)
      commitView(pending.target.view)
    })
  }, [cancelPopNavigation, clearPendingNavigation, commitView, confirmPopNavigation, pendingNavigation])

  const onWorkbenchDirtyChange = useCallback((dirty: boolean): void => {
    dirtyRef.current = dirty
    setWorkbenchDirty(dirty)
  }, [])

  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectDraft)
    return () => window.removeEventListener('beforeunload', protectDraft)
  }, [])
  const currentProject = snapshot?.projects.find((p) => p.root === currentRoot)
  const currentProjectWritable = isProjectWritable(currentProject)

  // 跨项目 snapshot 已携带每个 change 冻结绑定的 workflow 摘要；所有视图消费同一聚合事实。
  const rulesByKey = useMemo(() => workflowRulesFromSnapshot(snapshot), [snapshot])

  // 顶部条「工作台」标签的待决定计数：口径沿 selectInbox（「现在就能拍板」的唯一判定源）。
  const decisionCount = useMemo(
    () => selectInbox(snapshot, currentRoot, rulesByKey).length,
    [snapshot, currentRoot, rulesByKey],
  )

  // 顶部条「自动化」标签的待处置计数 = schedulerHealth(当前项目).failed。
  const afkCount = useMemo(
    () => schedulerHealth(selectProgress(snapshot, currentRoot, rulesByKey).counts).failed,
    [snapshot, currentRoot, rulesByKey],
  )

  // 顶部条 / 左列共用的项目投影：名称取仓库标签，否则 root 尾段；计数 = 未归档 change 数。
  const projects: TopBarProject[] = useMemo(
    () => (snapshot?.projects ?? []).map((project) => ({
      root: project.root,
      name: project.repository?.label ?? project.root.split('/').filter(Boolean).pop() ?? project.root,
      count: project.changes.filter((change) => change.archived !== 'true').length,
      ok: isProjectNavigable(project),
    })),
    [snapshot],
  )

  // 工作流页是 per-root 配置面，只能消费显式选择且仍可写的项目，绝不回落首个可达项目。
  const workbenchRoot = useMemo(() => {
    const okRoots = snapshot?.projects.filter(isProjectWritable).map((p) => p.root) ?? []
    if (currentRoot !== '' && okRoots.includes(currentRoot)) return currentRoot
    return ''
  }, [snapshot, currentRoot])
  if (workbenchRoot !== '') retainedWorkbenchRootRef.current = workbenchRoot
  const retainedWorkbenchRoot = workbenchRoot !== ''
    ? workbenchRoot
    : view === 'workbench' && workbenchDirty
      ? retainedWorkbenchRootRef.current
      : ''
  const retainedWorkbenchProject = snapshot?.projects.find((project) => project.root === retainedWorkbenchRoot)
  const workbenchAuthorityLost = retainedWorkbenchRoot !== '' && !isProjectWritable(retainedWorkbenchProject)
  const retainedWorkbenchHostRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = retainedWorkbenchHostRef.current
    if (!host) return
    if (workbenchAuthorityLost) host.setAttribute('inert', '')
    else host.removeAttribute('inert')
  }, [workbenchAuthorityLost])

  // 自动化 / 工作流含写入口，要求 project.ok=true；不可写时渲染分支直接给项目门（不静默跳页）。
  // 唯一的自动跳转：脏的工作流草稿宿主彻底失权时回到工作台（只读，恒可达），草稿由 UnsavedDraftDialog 守住。
  useEffect(() => {
    if (view !== 'workbench' || !snapshot) return
    if (workbenchDirty && retainedWorkbenchRoot !== '' && workbenchAuthorityLost) setView('progress')
  }, [view, snapshot, retainedWorkbenchRoot, workbenchAuthorityLost, workbenchDirty, setView])

  const selectRoot = useCallback((root: string): void => {
    selectProject(root, viewRef.current)
  }, [selectProject])

  return (
    <div className="flex min-h-screen flex-col bg-bg font-sans text-base leading-[1.45] text-text-2">
      <a
        href="#main-content"
        onClick={() => document.getElementById('main-content')?.focus()}
        className="fixed top-3 left-3 z-[100] -translate-y-[200%] rounded-md bg-ink px-4 py-2 font-bold whitespace-nowrap text-ink-fg shadow-lg transition-transform motion-reduce:transition-none focus:translate-y-0 focus:outline-none focus:ring-3 focus:ring-(--ring-blue)"
      >
        {t('common.skip_to_main')}
      </a>
      <TopBar
        view={view}
        onView={setView}
        projects={projects}
        currentRoot={currentRoot}
        onRoot={selectRoot}
        connected={connected}
        projectWritable={currentProjectWritable}
        lang={lang}
        onLang={(l: Lang) => setLang(l)}
        theme={theme}
        onTheme={setTheme}
        decisionCount={decisionCount}
        afkCount={afkCount}
      />

      {!connected && (
        <div
          className="flex items-center gap-2.5 border-b border-red-b bg-red-t px-5 py-2 text-caption font-semibold text-red-d"
          role="status"
          aria-live="polite"
          data-testid="offline-banner"
        >
          <span className="flex-1">{t('common.offline')}</span>
          <button
            type="button"
            className="cursor-pointer rounded-sm border border-red-b px-3 py-1 text-caption font-bold text-red-d transition-colors hover:bg-red-t"
            data-testid="offline-reconnect"
            onClick={reconnect}
          >
            {t('common.reconnect')}
          </button>
        </div>
      )}

      {flash && (
        <div
          ref={flashRef}
          className={`pointer-events-none fixed bottom-6 left-1/2 z-60 flex max-w-[70vw] -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-2 text-caption font-semibold shadow-md ${
            flash.kind === 'error' ? 'bg-red text-solid-fg' : 'bg-ink text-ink-fg'
          }`}
          role={flash.kind === 'error' ? 'alert' : 'status'}
          aria-live={flash.kind === 'error' ? 'assertive' : 'polite'}
          data-tone={flash.kind}
          data-testid={`flash-${flash.kind}`}
        >
          {flash.msg}
        </div>
      )}

      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-0 w-full flex-1 outline-none"
        data-testid="app-main"
      >
        <Suspense
          fallback={(
            <p className="p-5 text-body text-text-3" role="status" aria-live="polite" data-testid="route-loading">
              {t('common.loading')}
            </p>
          )}
        >
        {snapshot !== null && staleSnapshotError && view !== 'progress' && (
          <SnapshotInlineError error={staleSnapshotError} loading={loading} onRefresh={refresh} />
        )}
        {snapshot === null && !loading && snapshotError ? (
          <section
            className="mx-auto mt-8 w-full max-w-[680px] rounded-lg border border-red-b bg-red-t p-6 text-red-d shadow-sm max-[900px]:mt-4 max-[900px]:p-5"
            role="alert"
            aria-live="assertive"
            data-testid="snapshot-error"
          >
            <h1 className="text-title font-bold text-text">{t('common.snapshot_error_title')}</h1>
            <p className="mt-2 break-words text-body leading-6">{snapshotError}</p>
            <p className="mt-1 text-body leading-6 text-text-2">{t('common.snapshot_error_hint')}</p>
            <button
              type="button"
              className={`${BUTTON_GHOST} mt-4 border-red-b bg-card text-red-d hover:border-red-b hover:bg-red-t hover:text-red-d`}
              onClick={refresh}
            >
              {t('common.snapshot_retry')}
            </button>
          </section>
        ) : snapshot
          && snapshot.project_count === 0
          && view !== 'machine'
          && !(view === 'workbench' && workbenchDirty && retainedWorkbenchRoot !== '') ? (
          // 零项目教学态：tenon init 自动登记，无注册表单。
          <div className="px-6"><Onboarding kind="no-project" /></div>
        ) : (
          <>
        {view === 'progress' && (
          <WorkspaceView
            snapshot={snapshot}
            currentRoot={currentRoot}
            rulesByKey={rulesByKey}
            projects={projects}
            onSelectProject={selectRoot}
            selectedChange={selectedChange}
            onSelectedChange={setSelectedChange}
            onToast={(m) => showFlash('toast', m)}
            staleError={snapshot !== null ? staleSnapshotError : null}
            loading={loading}
            onRefresh={refresh}
          />
        )}
        {view === 'afk' && (
          // AfkView 含写入口，必须在同一渲染帧确认 project.ok=true 后才能挂载；effect 只负责
          // 把失效选择清回工作台，不能作为安全边界。
          currentRoot !== '' && currentProjectWritable ? (
            <div className="px-6 max-[900px]:px-4">
              <AfkView
                key={currentRoot}
                snapshot={snapshot}
                currentRoot={currentRoot}
                rulesByKey={rulesByKey}
                onView={setView}
                onOpenChange={(name) => {
                  setSelectedChange(name)
                  setView('progress')
                }}
                onToast={(m) => showFlash('toast', m)}
                onRefresh={refresh}
              />
            </div>
          ) : (
            <ProjectGate projects={snapshot?.projects ?? []} onSelectProject={(root) => selectProject(root, 'afk')} />
          )
        )}
        {view === 'workbench' && (
          retainedWorkbenchRoot !== '' ? (
            <>
              {workbenchAuthorityLost && (
                <p className="p-5 text-body text-red-d" role="alert">{t('workbench.no_reachable_root')}</p>
              )}
              <div
                data-testid="workbench-retained-host"
                ref={retainedWorkbenchHostRef}
              >
                <DialogInteractionBoundary disabled={workbenchAuthorityLost}>
                  <WorkflowView
                    key={retainedWorkbenchRoot}
                    root={retainedWorkbenchRoot}
                    onToggleError={(m) => showFlash('error', m)}
                    snapshot={snapshot}
                    onDirtyChange={onWorkbenchDirtyChange}
                  />
                </DialogInteractionBoundary>
              </div>
            </>
          ) : snapshot ? (
            snapshot.projects.some(isProjectWritable)
              ? <ProjectGate projects={snapshot.projects.filter(isProjectWritable)} onSelectProject={(root) => selectProject(root, 'workbench')} />
              : <p className="p-5 text-body text-red-d" role="alert" data-testid="wb-no-root">{t('workbench.no_reachable_root')}</p>
          ) : (
            <p className="p-5 text-body text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
          )
        )}
        {view === 'machine' && (
          <div className="px-6 max-[900px]:px-4">
            <MachineView
              snapshot={snapshot}
              currentRoot={currentRoot}
              onOpenProject={(root) => {
                selectProject(root, 'progress')
                setView('progress')
              }}
            />
          </div>
        )}
          </>
        )}
        </Suspense>
      </main>
      <UnsavedDraftDialog
        open={pendingNavigation !== null}
        testid="app-unsaved-navigation"
        onStay={closePendingNavigation}
        onDiscard={discardAndNavigate}
      />
    </div>
  )
}

export function App(): JSX.Element {
  return (
    <I18nProvider>
      <GlobalSearchProvider>
        <ErrorBoundary>
          <AppShell />
        </ErrorBoundary>
      </GlobalSearchProvider>
    </I18nProvider>
  )
}
