import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { I18nProvider, useT } from './i18n'
import type { Lang } from './i18n/translations'
import { selectInbox } from './inbox/inbox'
import { workflowRulesFromSnapshot } from './model/workflowModel'
import { Onboarding } from './shell/Onboarding'
import { useSnapshot } from './state/useSnapshot'
import { parseDashboardLocation } from './shell/dashboardLocation'
import { ErrorBoundary } from './AppErrorBoundary'
import { useProjectSelection } from './state/useProjectSelection'
import { isProjectNavigable } from './state/projectSelectionModel'
import { formatApiError } from './api/transport'
import { UnsavedDraftDialog } from './shared/UnsavedDraftDialog'
import type { DashboardNavigationTarget } from './state/useProjectSelection'
import { useFlash } from './shared/useFlash'
import { useDashboardTheme } from './shell/useDashboardTheme'
import { SnapshotInlineError } from './progress/SnapshotInlineError'
import { BUTTON_GHOST } from './shared/uiRecipes'
import { TopBar, type TopBarProject } from './shell/TopBar'
import { UserDialog } from './shell/UserDialog'
import { useCurrentUser } from './state/useCurrentUser'
import { isView, type View } from './shell/views'

export { ErrorBoundary } from './AppErrorBoundary'

const WorkspaceView = lazy(async () => ({
  default: (await import('./workspace/WorkspaceView')).WorkspaceView,
}))
const WorkflowView = lazy(async () => ({
  default: (await import('./workflow/WorkflowView')).WorkflowView,
}))
const ProjectsView = lazy(async () => ({
  default: (await import('./projects/ProjectsView')).ProjectsView,
}))
const LibraryView = lazy(async () => ({
  default: (await import('./library/LibraryView')).LibraryView,
}))

// 视图记忆。旧值（overview/hostPlan/inbox/board/…）随 IA 收敛退役——initialView 以 isView
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
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null)
  // 零项目教学态的「新建项目」跳到项目页并直接打开对话框。
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const pendingNavigationRef = useRef<PendingNavigation | null>(null)
  const viewRef = useRef(view)
  // 带未保存草稿的视图（任何编辑器通过 onDirtyChange 上报）；离开该视图才需要确认。
  const dirtyViewRef = useRef<View | null>(null)
  const currentRootRef = useRef('')
  viewRef.current = view

  const leavesDirtyView = useCallback((target: View): boolean => {
    const dirty = dirtyViewRef.current
    return dirty !== null && viewRef.current === dirty && target !== dirty
  }, [])

  const commitView = useCallback((v: View) => {
    setViewState(v)
    if (v !== 'progress' && v !== 'workbench') setSelectedChange(null)
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
    // 切项目不会卸载草稿，只有离开带草稿的视图才需要守卫。
    if (!leavesDirtyView(target.view)) return true
    const discard = window.confirm(`${t('common.unsaved_navigation_title')}\n\n${t('common.unsaved_navigation_body')}`)
    if (!discard) return false
    clearPendingNavigation()
    dirtyViewRef.current = null
    return true
  }, [clearPendingNavigation, leavesDirtyView, t])

  const onPopAttempt = useCallback((target: DashboardNavigationTarget): boolean => {
    if (leavesDirtyView(target.view)) {
      capturePendingNavigation({ kind: 'pop', target })
      return false
    }
    return true
  }, [capturePendingNavigation, leavesDirtyView])
  const { snapshot, loading, error, connected, refresh, reconnect } = useSnapshot()
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
    preserveUnavailableRoot: false,
  })
  currentRootRef.current = currentRoot
  const runtimeContext = useMemo(() => {
    if ((view !== 'progress' && view !== 'workbench') || currentRoot === '' || selectedChange === null || snapshot === null) return null
    const project = snapshot.projects.find((candidate) => candidate.root === currentRoot)
    const change = project?.changes.find((candidate) => candidate.name === selectedChange)
    if (change === undefined) return null
    return { root: currentRoot, change: selectedChange, attempts: change.artifactAttempts ?? [] }
  }, [currentRoot, selectedChange, snapshot, view])

  const setView = useCallback((nextView: View): void => {
    if (leavesDirtyView(nextView)) {
      if (!supportsNavigationInterception && pendingNavigationRef.current === null) {
        const discard = window.confirm(`${t('common.unsaved_navigation_title')}\n\n${t('common.unsaved_navigation_body')}`)
        if (!discard) return
        dirtyViewRef.current = null
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
  }, [capturePendingNavigation, commitView, leavesDirtyView, selectedChange, supportsNavigationInterception, t])

  const closePendingNavigation = useCallback(() => {
    cancelPopNavigation(clearPendingNavigation)
  }, [cancelPopNavigation, clearPendingNavigation])

  const discardAndNavigate = useCallback(() => {
    if (!pendingNavigation) return
    const pending = pendingNavigation
    if (pending.kind === 'pop') {
      clearPendingNavigation()
      dirtyViewRef.current = null
      confirmPopNavigation()
      return
    }
    cancelPopNavigation(() => {
      clearPendingNavigation()
      dirtyViewRef.current = null
      commitView(pending.target.view)
    })
  }, [cancelPopNavigation, clearPendingNavigation, commitView, confirmPopNavigation, pendingNavigation])

  /** 编辑器上报草稿状态：dirty 时记住所在视图；清空时只清自己那一份。 */
  const onDirtyChange = useCallback((source: View, dirty: boolean): void => {
    if (dirty) dirtyViewRef.current = source
    else if (dirtyViewRef.current === source) dirtyViewRef.current = null
  }, [])
  const onWorkbenchDirtyChange = useCallback((dirty: boolean): void => onDirtyChange('workbench', dirty), [onDirtyChange])

  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent): void => {
      if (dirtyViewRef.current === null) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protectDraft)
    return () => window.removeEventListener('beforeunload', protectDraft)
  }, [])
  // 跨项目 snapshot 已携带每个 change 冻结绑定的 workflow 摘要；所有视图消费同一聚合事实。
  const rulesByKey = useMemo(() => workflowRulesFromSnapshot(snapshot), [snapshot])

  // 顶部条「工作台」标签的待决定计数：口径沿 selectInbox（「现在就能拍板」的唯一判定源）。
  const decisionCount = useMemo(
    () => selectInbox(snapshot, currentRoot, rulesByKey).length,
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

  const selectRoot = useCallback((root: string): void => {
    selectProject(root, viewRef.current)
  }, [selectProject])
  const currentUser = useCurrentUser(currentRoot)
  const [userDialogOpen, setUserDialogOpen] = useState(false)
  const me = currentUser.state?.kind === 'set' ? currentUser.state.user : null

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
        lang={lang}
        onLang={(l: Lang) => setLang(l)}
        theme={theme}
        onTheme={setTheme}
        decisionCount={decisionCount}
        user={currentUser.state}
        onUser={() => setUserDialogOpen(true)}
      />
      {userDialogOpen && (
        <UserDialog
          initial={me}
          onClose={() => setUserDialogOpen(false)}
          onSaved={() => { setUserDialogOpen(false); currentUser.refresh() }}
        />
      )}

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
        ) : snapshot && snapshot.project_count === 0 && view === 'progress' ? (
          // 零项目教学态只替换工作台；工作流与库不依赖项目，项目页本身就是新建项目的入口。
          <div className="px-6">
            <Onboarding
              kind="no-project"
              onNewProject={() => { setNewProjectOpen(true); setView('projects') }}
            />
          </div>
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
            onRefresh={refresh}
            staleError={snapshot !== null ? staleSnapshotError : null}
            loading={loading}
            me={me}
            onUserMissing={() => setUserDialogOpen(true)}
          />
        )}
        {view === 'workbench' && (
          // 工作流是全局的（用户级存储），不依赖所选项目；每个 change 自己选工作流与轨道。
          <WorkflowView
            root=""
            runtimeContext={runtimeContext ?? undefined}
            onDirtyChange={onWorkbenchDirtyChange}
            onToast={(m) => showFlash('toast', m)}
          />
        )}
        {view === 'projects' && (
          <ProjectsView
            projects={projects}
            currentRoot={currentRoot}
            onSelectProject={selectRoot}
            onToast={(m) => showFlash('toast', m)}
            newProjectOpen={newProjectOpen}
            onNewProjectOpenChange={setNewProjectOpen}
          />
        )}
        {view === 'library' && <LibraryView onToast={(m) => showFlash('toast', m)} />}
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
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
    </I18nProvider>
  )
}
