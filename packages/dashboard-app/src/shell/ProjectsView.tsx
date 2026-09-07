import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { SearchX } from 'lucide-react'
import { unregisterProject } from '../api/governanceClient'
import { useT } from '../i18n'
import type { WorkflowRules } from '../model/workflowModel'
import { PageHeader } from '../shared/PageHeader'
import type { Snapshot } from '../types'
import { ProjectsFocusToolbar } from './ProjectsFocusToolbar'
import { selectFocusedProjects, type ProjectFocus, type ProjectFocusCounts } from './projectsFocusModel'
import { buildProjectRows, buildRepositoryGroups, compareProjectRows, orderRepositoryGroups, summarizeRepositoryGroup, type ProjectRow, type RepositoryGroup } from './projectsModel'
import { ProjectsRepositoryGroup } from './ProjectsRepositoryGroup'
import { ProjectsUnreachableSection } from './ProjectsUnreachableSection'
import { BUTTON_GHOST, EMPTY_STATE } from '../shared/uiRecipes'

gsap.registerPlugin(useGSAP)

/**
 * ProjectsView —— v10 重设计（2026-07-14）：项目总览从「一模一样的空卡阵」改成「按需关注排序的
 * 紧凑列表」。用户否决卡阵（15 张空卡无信息层级）；新版一行一项目，把「需你动手」的项目顶到最上
 * 并高亮，其余安静排在下面，读不到的收进底部可折叠区。
 *
 * 每行：状态点 + mono 项目名（title 全路径、不截断）+ 一条自解释迷你相位轨（主信息=「当前 {相位名}」
 * 文字，frontier 落点相位；空项目=「未开始」；裸点轨降为宽屏辅助）+ 右侧健康摘要
 * （流程中 N·动手 N·运行 N；动手>0 用 red-d、运行>0 用 green-d 强调）。整行可点 = onOpenProject。
 *
 * 分区口径：
 *   · 「需要你动手」= gate+failed 计数>0（need>0）——置顶、accent 点 + 整行极轻 tint（禁 side-stripe）；
 *   · 「其余」= 可达但 need==0——安静，无 tint；
 *   · 「读不到」= ok=false——底部可折叠区（默认折叠，展开只读列名不可点）。
 *   排序：两个可达分区内均按 need desc → running desc → wip desc → 名称 asc。
 *
 * 迷你相位轨：相位序取该项目主 workflow（非归档 change 里出现最多的 workflow 名，命中 rulesByKey
 * 则用其 steps，否则 DEFAULT_RULES；剔除末端 archive 步）；frontier = 有落点的最靠后相位下标，
 * frontier 前的空相位=done，落点相位=current，frontier 后=todo。空项目（0 change）→ 全 todo。
 * 自解释（#3b）：轨旁主渲染「当前 {frontier 相位名}」文字（projects.mini_at），空项目→「未开始」，
 * 让人不用猜裸点含义；裸点轨保留但降为宽屏辅助（aria-hidden 纯装饰，仍带 data-phase/state 供测试）。
 *
 * 配色一律走 token（accent/green-d/red-d family + border/fill/text 各档），状态承载走 data-* 与 aria，
 * 不断言视觉类名；GSAP 入场沿项目现有 matchMedia 双分支姿势（reduce 直达终态），选择器走 data-anim。
 */
export interface ProjectsViewProps {
  snapshot: Snapshot | null
  rulesByKey: ReadonlyMap<string, WorkflowRules>
  /** 点行钻进单项目进度页（App 侧 = setCurrentRoot(root) + setView('progress')）。 */
  onOpenProject: (root: string) => void
  unregisterRoot?: (root: string) => Promise<void>
  onRegistryChanged?: () => void
}

/** 分区头：小标题 + 细分隔线（need 分区标题走 accent 色）。 */
function SectionHead({ label, tone }: { label: string; tone: 'need' | 'quiet' }): JSX.Element {
  return (
    <div data-anim="pv-item" className="mb-3 flex items-center gap-3">
      <span
        className={`text-[13px] font-bold ${tone === 'need' ? 'text-(--accent)' : 'text-text-3'}`}
      >
        {label}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}

export function ProjectsView({
  snapshot,
  rulesByKey,
  onOpenProject,
  unregisterRoot = unregisterProject,
  onRegistryChanged,
}: ProjectsViewProps): JSX.Element {
  const { t } = useT()
  const rootRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [unreachableOpen, setUnreachableOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState<ProjectFocus>('all')
  const [expandedByGroup, setExpandedByGroup] = useState<Record<string, boolean>>({})
  const [removedUnreachable, setRemovedUnreachable] = useState<ReadonlySet<string>>(new Set())
  const [cleanupFailures, setCleanupFailures] = useState<string[]>([])
  const [cleanupBusy, setCleanupBusy] = useState(false)

  const rows = useMemo(() => buildProjectRows(snapshot, rulesByKey, t), [snapshot, rulesByKey, t])
  const repositoryGroups = useMemo(() => buildRepositoryGroups(rows), [rows])
  useEffect(() => {
    const unreadableRoots = new Set(rows.filter((row) => !row.ok).map((row) => row.root))
    setRemovedUnreachable((current) => {
      const retained = new Set([...current].filter((root) => unreadableRoots.has(root)))
      return retained.size === current.size ? current : retained
    })
    setCleanupFailures((current) => {
      const retained = current.filter((root) => unreadableRoots.has(root))
      return retained.length === current.length ? current : retained
    })
  }, [rows])
  const duplicateBasenames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.basename, (counts.get(row.basename) ?? 0) + 1)
    return new Set([...counts].filter(([, count]) => count > 1).map(([basename]) => basename))
  }, [rows])
  const visibleRoots = useMemo(() => {
    const labels = new Map(rows.map((row) => [row.root, row.root]))
    const groups = new Map<string, ProjectRow[]>()
    for (const row of rows) {
      const group = groups.get(row.basename) ?? []
      group.push(row)
      groups.set(row.basename, group)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const segments = group.map((row) => row.root.replace(/\\/g, '/').split('/').filter(Boolean))
      const maxDepth = Math.max(...segments.map((parts) => parts.length))
      for (let depth = 2; depth <= maxDepth; depth += 1) {
        const suffixes = segments.map((parts) => parts.slice(-depth).join('/'))
        if (new Set(suffixes).size !== group.length) continue
        group.forEach((row, index) => labels.set(row.root, `…/${suffixes[index]}`))
        break
      }
    }
    return labels
  }, [rows])
  const rowId = (row: ProjectRow) =>
    duplicateBasenames.has(row.basename)
      ? `project-row-${row.basename}-${encodeURIComponent(row.root)}`
      : `project-row-${row.basename}`
  const orderedRows = useMemo(() => {
    const reachable = rows.filter((row) => row.ok).sort(compareProjectRows)
    const unreachable = rows.filter((row) => !row.ok)
    return [...reachable, ...unreachable]
  }, [rows])
  const searchedRows = useMemo(
    () => selectFocusedProjects(orderedRows, query, 'all')
      .filter((row) => !removedUnreachable.has(row.root)),
    [orderedRows, query, removedUnreachable],
  )
  const { needGroups, restGroups, unreachable } = useMemo(() => {
    const searchedRoots = new Set(searchedRows.filter((row) => row.ok).map((row) => row.root))
    const groups = orderRepositoryGroups(repositoryGroups.flatMap((group) => {
      const workspaces = group.workspaces.filter((workspace) => {
        if (!searchedRoots.has(workspace.root)) return false
        if (focus === 'attention') return workspace.need > 0
        if (focus === 'running') return workspace.running > 0
        return true
      })
      if (workspaces.length === 0) return []
      return [summarizeRepositoryGroup(group, workspaces)]
    }))
    const need = groups.filter((group) => group.need > 0)
    const rest = groups.filter((group) => group.need === 0)
    const unreach = focus === 'all' || focus === 'unreachable'
      ? searchedRows.filter((row) => !row.ok)
      : []
    return { needGroups: need, restGroups: rest, unreachable: unreach }
  }, [focus, repositoryGroups, searchedRows])
  const focusCounts = useMemo((): ProjectFocusCounts => {
    const reachable = rows.filter((row) => row.ok)
    const unreadable = rows.length - reachable.length
    return {
      all: rows.length,
      attention: reachable.filter((row) => row.need > 0).length,
      running: reachable.filter((row) => row.running > 0).length,
      unreachable: unreadable,
    }
  }, [rows])
  const shownProjects = needGroups.reduce((total, group) => total + group.workspaceCount, 0)
    + restGroups.reduce((total, group) => total + group.workspaceCount, 0)
    + unreachable.length
  const cleanupFailureCount = useMemo(() => {
    const visibleUnreachable = new Set(unreachable.map((row) => row.root))
    return cleanupFailures.filter((root) => visibleUnreachable.has(root)).length
  }, [cleanupFailures, unreachable])
  const refreshRegistry = (): void => {
    onRegistryChanged?.()
  }

  function groupExpanded(group: RepositoryGroup): boolean {
    if (query.trim().length > 0 || focus !== 'all') return true
    return expandedByGroup[group.id]
      ?? (group.workspaceCount === 1 || group.need > 0 || group.running > 0)
  }

  function renderGroup(group: RepositoryGroup): JSX.Element {
    return (
      <ProjectsRepositoryGroup
        key={group.id}
        group={group}
        expanded={groupExpanded(group)}
        visibleRoots={visibleRoots}
        rowId={rowId}
        onExpanded={(expanded) => setExpandedByGroup((current) => ({ ...current, [group.id]: expanded }))}
        onOpen={onOpenProject}
        t={t}
      />
    )
  }

  async function unregisterUnreachable(): Promise<void> {
    if (cleanupBusy || unreachable.length === 0) return
    if (!window.confirm(t('projects.cleanup_confirm', { n: unreachable.length }))) return
    setCleanupBusy(true)
    const removed: string[] = []
    const failed: string[] = []
    for (const row of unreachable) {
      try {
        await unregisterRoot(row.root)
        removed.push(row.root)
      } catch {
        failed.push(row.root)
      }
    }
    if (removed.length > 0) {
      setRemovedUnreachable((current) => new Set([...current, ...removed]))
      onRegistryChanged?.()
    }
    setCleanupFailures(failed)
    if (failed.length > 0) setUnreachableOpen(true)
    setCleanupBusy(false)
  }

  function clearConditions(): void {
    setQuery('')
    setFocus('all')
    searchRef.current?.focus()
  }

  // 入场动画依赖键 = 行/分区成员指纹（增删项目才重放 stagger；展开读不到区不整列重播）。
  const animKey = useMemo(
    () => rows.map((r) => `${r.ok ? '1' : '0'}${r.root}`).sort().join('|'),
    [rows],
  )
  useGSAP(
    () => {
      const el = rootRef.current
      if (!el || typeof window.matchMedia !== 'function') return
      const mm = gsap.matchMedia()
      mm.add(
        { reduce: '(prefers-reduced-motion: reduce)', motion: '(prefers-reduced-motion: no-preference)' },
        (ctx) => {
          const reduce = Boolean((ctx.conditions as { reduce?: boolean } | undefined)?.reduce)
          const items = el.querySelectorAll<HTMLElement>('[data-anim="pv-item"]')
          if (items.length === 0) return
          if (reduce) {
            gsap.set(items, { autoAlpha: 1, y: 0 })
            return
          }
          gsap.fromTo(
            items,
            { autoAlpha: 0, y: 6 },
            { autoAlpha: 1, y: 0, duration: 0.28, ease: 'power2.out', stagger: 0.03, clearProps: 'all' },
          )
        },
      )
    },
    { scope: rootRef, dependencies: [animKey], revertOnUpdate: true },
  )

  return (
    <section ref={rootRef} data-testid="projects-view" data-page-frame="standard" aria-label={t('projects.title')} className="mx-auto w-full max-w-[1088px] pt-7 pb-5">
      <PageHeader
        title={t('projects.title')}
        description={<span data-testid="projects-summary">{t('projects.count_summary', {
          n: repositoryGroups.length,
          workspaces: rows.filter((row) => row.ok).length,
          need: repositoryGroups.filter((group) => group.need > 0).length,
        })}</span>}
      />

      {snapshot === null ? (
        <p className="text-[14px] text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
          <div
            className={`flex min-h-48 flex-col items-center justify-center ${EMPTY_STATE} shadow-sm`}
            data-testid="projects-source-empty"
          >
            <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card text-text-3">
              <SearchX aria-hidden="true" className="h-5 w-5" />
            </span>
            <h2 className="text-[16px] font-bold text-text">{t('projects.empty_source_title')}</h2>
            <p className="mt-1.5 max-w-md text-[13px] leading-5 text-text-3">{t('projects.empty_source_desc')}</p>
            <button
              type="button"
              onClick={refreshRegistry}
              className={`${BUTTON_GHOST} mt-5`}
              data-testid="projects-source-empty-retry"
            >
              {t('common.snapshot_retry')}
            </button>
          </div>
        ) : (
        <>
          <ProjectsFocusToolbar
            t={t}
            query={query}
            focus={focus}
            counts={focusCounts}
            shown={shownProjects}
            total={focusCounts.all}
            searchRef={searchRef}
            onQuery={setQuery}
            onFocus={setFocus}
            onClear={clearConditions}
          />
          <div className="flex flex-col gap-7">
          {needGroups.length > 0 && (
            <div data-testid="section-need">
              <SectionHead label={t('projects.section_need')} tone="need" />
              <div className="flex flex-col gap-2.5">
                {needGroups.map(renderGroup)}
              </div>
            </div>
          )}

          {restGroups.length > 0 && (
            <div data-testid="section-rest">
              {(query.trim().length > 0 || focus !== 'all') && <SectionHead label={t('projects.section_rest')} tone="quiet" />}
              <div className="flex flex-col gap-2.5">
                {restGroups.map(renderGroup)}
              </div>
            </div>
          )}

          {shownProjects === 0 && (
            <div
              className={`flex min-h-48 flex-col items-center justify-center ${EMPTY_STATE}`}
              data-testid="projects-filter-empty"
            >
              <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card text-text-3">
                <SearchX aria-hidden="true" className="h-5 w-5" />
              </span>
              <h2 className="text-[16px] font-bold text-text">{t('projects.no_results_title')}</h2>
              <p className="mt-1.5 max-w-md text-[13px] leading-5 text-text-3">{t('projects.no_results_desc')}</p>
              <button
                type="button"
                onClick={clearConditions}
                className={`${BUTTON_GHOST} mt-5`}
              >
                {t('projects.clear_filters')}
              </button>
            </div>
          )}

          {unreachable.length > 0 && (
            <ProjectsUnreachableSection
              rows={unreachable}
              expanded={unreachableOpen}
              forcedOpen={query.trim().length > 0 || focus === 'unreachable'}
              visibleRoots={visibleRoots}
              rowId={rowId}
              t={t}
              onExpanded={setUnreachableOpen}
              cleanupBusy={cleanupBusy}
              cleanupFailureCount={cleanupFailureCount}
              onBatchUnregister={() => { void unregisterUnreachable() }}
            />
          )}
        </div>
        </>
      )}
    </section>
  )
}
