import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { I18nProvider, useT } from './i18n'
import type { Lang } from './i18n/translations'
import { selectInbox } from './inbox/inbox'
import { workflowRulesFromSnapshot } from './model/workflowModel'
import { schedulerHealth, selectProgress } from './model/progressModel'
import { Nav, PRIMARY_VIEWS, type View } from './shell/Nav'
import { Onboarding } from './shell/Onboarding'
import { ProjectsView } from './shell/ProjectsView'
import { useSnapshot } from './state/useSnapshot'
import { parseDashboardLocation } from './shell/dashboardLocation'
import { ErrorBoundary } from './AppErrorBoundary'
import { useProjectSelection } from './state/useProjectSelection'
import { isProjectWritable } from './state/projectSelectionModel'
import { isProjectNavigable } from './state/projectSelectionModel'
import { formatApiError } from './api/transport'
import { UnsavedDraftDialog } from './shared/UnsavedDraftDialog'
import { DialogInteractionBoundary } from './shared/Dialog'
import type { DashboardNavigationTarget } from './state/useProjectSelection'
import { useFlash } from './shared/useFlash'
import { useDashboardTheme } from './shell/useDashboardTheme'
import { SnapshotInlineError } from './progress/SnapshotInlineError'
import { PageBreadcrumbs } from './shell/PageBreadcrumbs'
import { ProjectRequiredState } from './shell/ProjectRequiredState'
import { BUTTON_GHOST } from './shared/uiRecipes'

export { ErrorBoundary } from './AppErrorBoundary'

const ProgressView = lazy(async () => ({
  default: (await import('./progress/ProgressView')).ProgressView,
}))
const AfkView = lazy(async () => ({ default: (await import('./afk/AfkView')).AfkView }))
const WorkbenchView = lazy(async () => ({
  default: (await import('./workbench/WorkbenchView')).WorkbenchView,
}))
const MachineView = lazy(async () => ({
  default: (await import('./machine/MachineView')).MachineView,
}))
const SolutionView = lazy(async () => ({
  default: (await import('./solution/SolutionView')).SolutionView,
}))
const HostTargetPlanView = lazy(async () => ({
  default: (await import('./hostPlan/HostTargetPlanView')).HostTargetPlanView,
}))

// 视图记忆。旧值（inbox/board/settings/loops/workflows）随历次 IA 收敛退役——initialView
// 以 KNOWN_VIEWS 白名单校验，不认识的一律兜底回 progress（收件箱退役，默认落地=进度，v9-flowdeck 口径）。
const VIEW_KEY = 'tenon-dashboard-view'
// 可路由的日常视图 = PRIMARY_VIEWS（三项：项目/进度/工作台）；低频视图仍保留深链
// 首枚入口，内容区直接承担自动发现与项目选择，视图记忆据此恢复。
const KNOWN_VIEWS: View[] = [...PRIMARY_VIEWS]

function initialView(): View {
  try {
    const linked = parseDashboardLocation(window.location.search).view
    if (linked !== undefined) return linked
  } catch {
    /* ignore */
  }
  try {
    const stored = localStorage.getItem(VIEW_KEY)
    if (stored !== null && (KNOWN_VIEWS as string[]).includes(stored)) return stored as View
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
      // Overview 是品牌级只读入口，不是运营工作区；保留上一次运营视图记忆，
      // 使无 view 深链的下次启动仍回到用户的工作上下文。
      if (PRIMARY_VIEWS.some((primary) => primary === v)) localStorage.setItem(VIEW_KEY, v)
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
  const currentProjectName = currentProject?.repository?.label
    ?? (currentRoot.split('/').filter(Boolean).pop() || undefined)
  const hasNavigableProject = snapshot?.projects.some(isProjectNavigable) ?? false

  // 跨项目 snapshot 已携带每个 change 冻结绑定的 workflow 摘要。项目总览与单项目视图消费同一
  // 聚合事实，无选择时不需要、也不允许发起任何 per-root workflow 请求。
  const rulesByKey = useMemo(() => workflowRulesFromSnapshot(snapshot), [snapshot])

  // 待拍板计数（Nav「进度」项红徽标）：口径沿 selectInbox 不变——收件箱视图退役后，
  // 选择器保留为「现在就能拍板」的唯一判定源（F1 的进度行高亮同源消费）。
  const decisionCount = useMemo(
    () => selectInbox(snapshot, currentRoot, rulesByKey).length,
    [snapshot, currentRoot, rulesByKey],
  )

  // AFK 待处置计数（Nav「AFK」项红徽标）：口径=schedulerHealth(当前项目).failed——失败/冲突折叠
  // 后的「等你处置」数（与 AfkView 汇总灯同源，走 model 现成 selectProgress/schedulerHealth，不在
  // 视图层摸 automation 原始字段）。0 不显徽标（Nav 内 afkCount>0 才渲染）。
  const afkCount = useMemo(
    () => schedulerHealth(selectProgress(snapshot, currentRoot, rulesByKey).counts).failed,
    [snapshot, currentRoot, rulesByKey],
  )

  // 工作台是 per-root 配置面，只能消费显式选择且仍可达的项目，绝不回落首个可达项目。
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

  // Progress 可在仅含 future-version issue 时只读打开；AFK/Workbench 含写入口，仍要求
  // project.ok=true。普通 corruption 与兼容 issue 并存时 selection model 会让 root 失效。
  useEffect(() => {
    if (!['progress', 'afk', 'workbench'].includes(view) || !snapshot) return
    if (view === 'workbench' && workbenchDirty && retainedWorkbenchRoot !== '') {
      if (workbenchAuthorityLost) setView('projects')
      return
    }
    if (snapshot.project_count === 0) return
    // A missing root is a valid, shareable navigation state. Keep the requested page mounted so
    // the user sees an actionable project gate instead of being bounced back to Projects.
    if (currentRoot === '' && !hasNavigableProject) {
      // There is no readable project to show on a project-scoped page; the Projects view is the
      // truthful recovery surface in this exceptional case.
      setView('projects')
      return
    }
    if (currentRoot !== '' && view !== 'progress' && !currentProjectWritable) setView('projects')
  }, [
    view,
    snapshot,
    currentRoot,
    currentProjectWritable,
    hasNavigableProject,
    retainedWorkbenchRoot,
    workbenchAuthorityLost,
    workbenchDirty,
    setView,
  ])

  // （收件箱退役收尾）原 onTransition 快捷转换回调随 InboxView 唯一消费方删除；进度面的
  // 动作接线（继续/打回/重试/终止）由 ProgressView 侧按需重建（postTransition 仍在 api/client）。

  // v10b 外壳拍板（2026-07-14）：顶部导航退役，改左右布局——左=Nav 竖向图标 rail（sticky 全高，
  // 宽度由 Nav 自持），右=内容列（原 main+footer 纵排，body 自然滚动）。offline 横幅置顶于内容列、
  // flash toast 仍 fixed 悬浮，机制不变。右栏 sticky 依赖的 --nav-offset 已随无顶栏调至 20px（index.css）。
  return (
    <div className="flex min-h-screen bg-bg font-sans text-[14px] leading-[1.45] text-text-2">
      <a
        href="#main-content"
        onClick={() => document.getElementById('main-content')?.focus()}
        className="fixed top-3 left-3 z-[100] -translate-y-[200%] rounded-lg bg-ink px-4 py-2 font-bold whitespace-nowrap text-ink-fg shadow-lg transition-transform motion-reduce:transition-none focus:translate-y-0 focus:outline-none focus:ring-3 focus:ring-(--ring-blue)"
      >
        {t('common.skip_to_main')}
      </a>
      <Nav
        view={view}
        onView={setView}
        lang={lang}
        onLang={(l: Lang) => setLang(l)}
        theme={theme}
        onTheme={setTheme}
        connected={connected}
        decisionCount={decisionCount}
        afkCount={afkCount}
      />

      <div className="flex min-w-0 flex-1 flex-col mobile:pt-14">
      {!connected && (
        <div
          className="flex items-center gap-2.5 border-b border-red-b bg-red-t px-5 py-2 text-[12.5px] font-semibold text-red-d"
          role="status"
          aria-live="polite"
          data-testid="offline-banner"
        >
          <span className="flex-1">{t('common.offline')}</span>
          <button
            type="button"
            className="cursor-pointer rounded-[7px] border border-red-b px-[11px] py-1 text-xs font-bold text-red-d transition-colors hover:bg-red-t"
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
          className={`pointer-events-none fixed bottom-[26px] left-1/2 z-60 flex max-w-[70vw] -translate-x-1/2 items-center gap-[7px] rounded-full px-3.5 py-2 text-[12.5px] font-semibold shadow-md mobile:bottom-[calc(84px+env(safe-area-inset-bottom))] mobile:max-w-[calc(100vw-32px)] ${
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

      {/* 修点5：内容左对齐紧挨 rail——去掉 mx-auto/max-w 造成的居中大空隙，全宽 + 合理 padding。 */}
      <main
        id="main-content"
        tabIndex={-1}
        className="w-full flex-1 px-6 pb-6 pt-3 mobile:px-4 mobile:pb-[calc(88px+env(safe-area-inset-bottom))] mobile:pt-2"
        data-testid="app-main"
      >
        <PageBreadcrumbs
          view={view}
          projectName={currentProjectName}
          changeName={view === 'progress' ? selectedChange : null}
          onView={setView}
        />
        <Suspense
          fallback={(
            <p className="p-5 text-[13px] text-text-3" role="status" aria-live="polite" data-testid="route-loading">
              {t('common.loading')}
            </p>
          )}
        >
        {snapshot !== null && staleSnapshotError && view !== 'progress' && view !== 'hostPlan' && (
          <SnapshotInlineError error={staleSnapshotError} loading={loading} onRefresh={refresh} />
        )}
        {/* G18 教学空状态（T17 起纯教学态：tenon init 自动登记，无注册表单）：
            零项目 → 全视图 onboarding；有项目零 change → 进度替换为新建引导
            （工作台不替换——它是配置面，零 change 也有事可做）。 */}
        {snapshot === null && !loading && snapshotError && view !== 'hostPlan' ? (
          <section
            className="mx-auto mt-8 w-full max-w-[680px] rounded-2xl border border-red-b bg-red-t p-6 text-red-d shadow-sm mobile:mt-4 mobile:p-5"
            role="alert"
            aria-live="assertive"
            data-testid="snapshot-error"
          >
            <h1 className="text-lg font-bold text-text">{t('common.snapshot_error_title')}</h1>
            <p className="mt-2 break-words text-[13px] leading-6">{snapshotError}</p>
            <p className="mt-1 text-[13px] leading-6 text-text-2">{t('common.snapshot_error_hint')}</p>
            <button
              type="button"
              className={`${BUTTON_GHOST} mt-4 border-red-b bg-card text-red-d hover:border-red-b hover:bg-red-t hover:text-red-d`}
              onClick={refresh}
            >
              {t('common.snapshot_retry')}
            </button>
          </section>
        ) : view === 'overview' ? (
          <SolutionView />
        ) : snapshot
          && snapshot.project_count === 0
          && view !== 'machine'
          && view !== 'hostPlan'
          && !(view === 'workbench' && workbenchDirty && retainedWorkbenchRoot !== '') ? (
          <Onboarding kind="no-project" />
        ) : snapshot
          && currentProject
          && currentProject.changes.length === 0
          && (currentProject.compatibilityIssues?.length ?? 0) === 0
          && view === 'progress' ? (
          <Onboarding
            key={currentRoot}
            kind="no-change"
            root={currentRoot}
            onCreated={refresh}
            onToast={(m) => showFlash('toast', m)}
          />
        ) : snapshot
          && ['progress', 'afk', 'workbench'].includes(view)
          && currentRoot === ''
          && hasNavigableProject ? (
          <ProjectRequiredState view={view} onOpenProjects={() => setView('projects')} />
        ) : (
          <>
        {view === 'projects' && (
          // v10c「项目」总览页：所有项目概览卡，点卡 = 选中该项目 + 切到单项目进度页。
          <ProjectsView
            snapshot={snapshot}
            rulesByKey={rulesByKey}
            onRegistryChanged={refresh}
            onOpenProject={(root) => {
              selectProject(root, 'progress')
              setView('progress')
            }}
          />
        )}
        {view === 'progress' && (
          // 契约：ProgressView 只吃真实单项目 root（currentRoot 非空）。currentRoot 为 ''（仅出现在
          // 首帧 snapshot 未到时）不给它渲染聚合——诚实加载态；真正的失效/旧聚合偏好已被上方 useEffect
          // 落到「项目」总览页。
          currentRoot !== '' ? (
            <ProgressView
              key={currentRoot}
              snapshot={snapshot}
              loading={loading}
              error={staleSnapshotError}
              currentRoot={currentRoot}
              rulesByKey={rulesByKey}
              onToast={(m) => showFlash('toast', m)}
              onRefresh={refresh}
              selectedChange={selectedChange}
              onSelectedChange={setSelectedChange}
              readOnly={!currentProjectWritable}
            />
          ) : (
            <ProjectRequiredState view="progress" onOpenProjects={() => setView('projects')} />
          )
        )}
        {view === 'afk' && (
          // AfkView 含写入口，必须在同一渲染帧确认 project.ok=true 后才能挂载；effect 仅负责
          // 将失效 URL/导航清理回项目页，不能作为安全边界。
          currentRoot !== '' && currentProjectWritable ? (
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
          ) : (
            <ProjectRequiredState view="afk" onOpenProjects={() => setView('projects')} />
          )
        )}
        {view === 'workbench' && (
          retainedWorkbenchRoot !== '' ? (
            // v6 计划 T11：流程带真实计数/running 脉冲吃同一份已加载的 snapshot（App 是唯一
            // useSnapshot() 调用点，不在 WorkbenchView 内独立开第二条 SSE 订阅——见
            // WorkbenchViewProps.snapshot 头注释）。
            <>
              {workbenchAuthorityLost && (
                <p className="p-5 text-[13px] text-red-d" role="alert">{t('workbench.no_reachable_root')}</p>
              )}
              <div
                data-testid="workbench-retained-host"
                ref={retainedWorkbenchHostRef}
              >
                <DialogInteractionBoundary disabled={workbenchAuthorityLost}>
                  <WorkbenchView
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
            // 项目非零但全部不可达（ok=false）：诚实空态，不挂载 WorkbenchView
            //（零项目已被上方 Onboarding 分支接走，这里只剩「有项目但读不到」的角落）。
            <p className="p-5 text-[13px] text-red-d" role="alert" data-testid="wb-no-root">{t('workbench.no_reachable_root')}</p>
          ) : (
            <p className="p-5 text-[13px] text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
          )
        )}
        {view === 'machine' && (
          <MachineView
            snapshot={snapshot}
            currentRoot={currentRoot}
            onOpenProject={(root) => {
              selectProject(root, 'progress')
              setView('progress')
            }}
          />
        )}
        {view === 'hostPlan' && <HostTargetPlanView root={currentRoot} />}
          </>
        )}
        </Suspense>
      </main>

      </div>
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
