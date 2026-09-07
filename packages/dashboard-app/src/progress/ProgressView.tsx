import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Check } from 'lucide-react'
import { useT } from '../i18n'
import type { PlannedTransition } from '../model/events'
import { fetchSessionLinks, postAfkCommand, postTransition, type SessionLink } from '../api/client'
import { formatApiError, throwApiError } from '../api/transport'
import { gateEvidence, type EvidenceChip } from '../model/evidence'
import {
  WorkflowCanvas,
  type CanvasDotTone,
} from './WorkflowCanvas'
import { missingGateArtifacts, selectProgress } from '../model/progressModel'
import './progress.css'
import { CreateChangeDialog } from './CreateChangeDialog'
import { useProgressDrawer } from './useProgressDrawer'
import { buildCanvasGroups } from './progressCanvasModel'
import { ProgressToolbar } from './ProgressToolbar'
import { ProgressDrawer } from './ProgressDrawer'
import { ProgressActions } from './ProgressActions'
import type { ProgressViewProps } from './progressViewTypes'
import { CanonicalStateVersionNotice } from './CanonicalStateVersionNotice'
import { SnapshotInlineError } from './SnapshotInlineError'
import { OrchestrationV2Panel } from './OrchestrationV2Panel'
import {
  BADGE_TONE_CLS,
  deckMatch,
  fieldStr,
  patchLanded,
  patchMovedFromBase,
  rowKeyOf,
  rowSemantics,
  stepLabel,
  toFlatRow,
  type DeckTab,
  type FlatRow,
  type RowBadge,
  type RowPatch,
} from './progressViewModel'
gsap.registerPlugin(useGSAP)

/**
 * 单项目画布操作面：App 保证 currentRoot 非空，跨项目钻取归 ProjectsView；change 只挂在
 * 相位卡并通过右侧抽屉操作。数据、乐观更新、会话链接和抽屉行为沿用既有模型。
 *   · 吸顶工具条即页头：状态页签（全部/等你动手/运行中/等待中 + 计数，墨线 GSAP）——页签筛选
 *     作用于画布（未命中的 change 小卡淡出，不移除）。旧「调度」芯片已下线（#6：升级为独立 AFK
 *     视图，schedulerHealth/并发上限的展示归那处；本视图不再消费）。
 *   · 页签语义：等待中 = queued + agent；cancelled 仍归「等你动手」。计数=分类总数不随筛选变。
 *   · workflow 筛选收敛为单一下拉；筛选作用于画布分组，工作流数量增长时不挤占主工具栏。
 *   · 画布 WorkflowCanvas（v6 单项目 workflow 大卡）：一 workflow 一组，有在制的相位=站台卡、空相位=
 *     过路小站，连线纯 CSS；change 小卡完整 mono 名（禁 ellipsis）+ lucide sched 图标（沙箱
 *     机器人 Bot / 终端 Terminal）+ AFK/沙箱极轻 accent tint 区分；小卡点击=openDrawer。归档不
 *     失联：带归档的相位小站点开 = 站台线下方只读列出该相位归档 change。
 *
 * 判定徽章语义（rowSemantics 同源，抽屉徽章消费）：gate=结构化 Check 图标 +「可以放行」绿 /「等你判断」红；
 * failed=「失败 ×N · 等你决定」红（cause=cancelled → 琥珀「已取消」）；running=蓝「{phase}
 * 运行中」；排队/等产出=中性。状态一律 data-*（data-state/data-pulse/data-sbx），测试断言
 * data/aria/testid 不断言视觉类名。
 *
 * GSAP（全包 gsap.matchMedia，reduce 分支直达终态）：工具条浮现 → 画布节点弹入（scale+
 * stagger）；墨线滑动、拍板 pulseRow、抽屉开合沿现状逻辑，选择器走 data-anim/data-testid。
 * 呼吸环/脉冲/流动虚线走纯 CSS（progress.css，reduced 停帧），组件内零 JS 循环。
 */

export function ProgressView({
  snapshot,
  loading,
  error,
  currentRoot,
  rulesByKey,
  onToast,
  onRefresh,
  selectedChange,
  onSelectedChange,
  readOnly = false,
}: ProgressViewProps): JSX.Element {
  const { t, lang } = useT()
  const rootRef = useRef<HTMLElement>(null)
  const localeIdentity = useRef({ t, lang })
  localeIdentity.current = { t, lang }
  const mounted = useRef(true)
  const rootIdentity = useRef(currentRoot)
  rootIdentity.current = currentRoot
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(new Set())
  const [patches, setPatches] = useState<ReadonlyMap<string, RowPatch>>(new Map())
  // 状态页签（默认全部）。
  const [deckTab, setDeckTab] = useState<DeckTab>('all')
  // 工作流筛选保持为单一 select，避免工作流增多后横向堆满筛选栏。
  const [wfFilter, setWfFilter] = useState<string>('all')
  const [createOpen, setCreateOpen] = useState(false)
  useEffect(() => {
    setCreateOpen(false)
  }, [currentRoot])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Bug4：新 snapshot 到达即按 change **逐条**清乐观 patch——只清「已落地（真值达目标）或已离开
  // 施加基线（server 已推进）」的那条，保留其余项目仍在途、尚未反映的 patch。
  useEffect(() => {
    setPatches((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      let changed = false
      for (const [key, patch] of prev) {
        const at = key.indexOf('@')
        const name = key.slice(0, at)
        const root = key.slice(at + 1)
        const change = snapshot?.projects.find((p) => p.root === root)?.changes.find((c) => c.name === name)
        if (!change || patchLanded(patch, change) || patchMovedFromBase(patch, change)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [snapshot])

  // 乐观投影：把在途动作的 patch 叠加到 snapshot 上，selectProgress 及所有下游（徽章/相位轨/
  // 画布/抽屉）自然消费同一份判定——不在视图层散落第二套状态判定（T6 同源谓词纪律）。
  const patchedSnapshot = useMemo(() => {
    if (!snapshot || patches.size === 0) return snapshot
    return {
      ...snapshot,
      projects: snapshot.projects.map((p) => ({
        ...p,
        changes: p.changes.map((c) => {
          const patch = patches.get(rowKeyOf(p.root, c.name))
          if (!patch) return c
          const phaseChanged = patch.phase !== undefined && patch.phase !== c.phase
          return {
            ...c,
            phase: patch.phase ?? c.phase,
            fields: { ...c.fields, ...patch.fields },
            reviewHandshake: phaseChanged && c.reviewHandshake !== undefined
              ? { status: 'not-requested' as const }
              : c.reviewHandshake,
          }
        }),
      })),
    }
  }, [snapshot, patches])

  const base = useMemo(() => selectProgress(patchedSnapshot, currentRoot, rulesByKey), [patchedSnapshot, currentRoot, rulesByKey])

  // change 投影打平（单项目语境：base.groups 是当前项目的各 workflow 组）——画布 change 小卡、
  // 页签计数、GSAP 入场键、抽屉行查找共用同一份 FlatRow。列表已退役，无需再按需操作/时间排序。
  const flatRows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = []
    for (const group of base.groups) {
      const rules = group.rules
      for (const row of group.rows) out.push(toFlatRow(row, rules, group.workflow))
    }
    return out
  }, [base])
  const frByKey = useMemo(() => new Map(flatRows.map((fr) => [fr.key, fr])), [flatRows])

  const {
    drawerRef,
    scrimRef,
    drawerKey,
    drawerRow,
    openDrawer,
    closeDrawer,
  } = useProgressDrawer({
    rootRef,
    currentRoot,
    rows: flatRows,
    selectedChange,
    onSelectedChange,
  })

  // 页签计数=各分类总数（不随当前筛选变）。
  const deckCounts = useMemo(
    () => ({
      all: flatRows.length,
      need: flatRows.filter((fr) => deckMatch(fr, 'need')).length,
      run: flatRows.filter((fr) => deckMatch(fr, 'run')).length,
      queue: flatRows.filter((fr) => deckMatch(fr, 'queue')).length,
    }),
    [flatRows],
  )

  // v10b §4.2：出现过的 workflow 名（有活跃行的组；组序沿 selectProgress——root 升序、default
  // 恒前，按名去重聚合）。选中的 workflow 若随快照消失，effectiveWf 静默回落「全部」。
  const wfNames = useMemo(() => {
    const names: string[] = []
    for (const g of base.groups) if (g.rows.length > 0 && !names.includes(g.workflow)) names.push(g.workflow)
    return names
  }, [base])
  const effectiveWf = wfFilter !== 'all' && wfNames.includes(wfFilter) ? wfFilter : 'all'
  const filterSummary = useMemo(() => {
    const scopedRows = effectiveWf === 'all'
      ? flatRows
      : flatRows.filter((row) => row.workflow === effectiveWf)
    const shown = scopedRows.filter((row) => deckMatch(row, deckTab)).length
    return { shown, context: scopedRows.length - shown }
  }, [deckTab, effectiveWf, flatRows])

  function setPatch(key: string, patch: RowPatch | null): void {
    setPatches((prev) => {
      const next = new Map(prev)
      if (patch) next.set(key, patch)
      else next.delete(key)
      return next
    })
  }

  function setBusy(key: string, busy: boolean): void {
    setBusyRows((prev) => {
      const next = new Set(prev)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /** Bug4：从当前（未 patch 的）snapshot 取某 change 的真值基线，供 patch 落地/让位判定。 */
  function baseOf(root: string, name: string): RowPatch['base'] {
    const change = snapshot?.projects.find((p) => p.root === root)?.changes.find((c) => c.name === name)
    const fields: Record<string, string> = {}
    if (change) for (const k of Object.keys(change.fields)) fields[k] = fieldStr(change, k)
    return { phase: change?.phase ?? '', fields }
  }

  /** 拍板成功的即时反馈：画布 change 小卡 settle + 抽屉徽章回落 pulse。reduced-motion /
   *  无 matchMedia → 不放（状态变化本身即反馈）。 */
  function pulseRow(name: string): void {
    if (typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const root = rootRef.current
    if (!root) return
    const cardEl = root.querySelector(`[data-testid="prg-cv-chg-${name}"]`)
    const bdg = root.querySelector('[data-testid="prg9-dw-badge"]')
    if (cardEl) gsap.fromTo(cardEl, { scale: 0.985 }, { scale: 1, duration: 0.2, ease: 'power3.out', clearProps: 'transform' })
    if (bdg) gsap.fromTo(bdg, { scale: 1.12 }, { scale: 1, duration: 0.2, ease: 'power3.out', clearProps: 'transform' })
  }

  /**
   * running 行终止（cancel-gate 纪律：仅 automation==='running' 可点）。cancel 无即时状态
   * 变化（标记文件落地后由 automation 结算），不 patch 只 toast+resync。重试/放弃已随
   * 「回终端」纪律退出 UI（真机验收 G）——fail/cxl 行给终端命令 chip（cmdChipOf），
   * 对应端点 postAfkRetry/postAfkDismiss 保留在 api 层、此处不再有消费方与乐观 patch 分支。
   */
  async function killAction(root: string, name: string): Promise<void> {
    const key = rowKeyOf(root, name)
    if (busyRows.has(key)) return
    setBusy(key, true)
    const labelKey = 'progress.act_kill'
    try {
      const res = await postAfkCommand(name, root, 'cancel')
      if (!res.ok) {
        await throwApiError(res, localeIdentity.current.t('progress.act_fail_http', { status: res.status }))
      }
      if (!mounted.current || rootIdentity.current !== root) return
      const current = localeIdentity.current
      onToast?.(current.t('progress.act_ok', { name, label: current.t(labelKey) }))
      pulseRow(name)
      await onRefresh?.()
    } catch (err) {
      if (!mounted.current || rootIdentity.current !== root) return
      const current = localeIdentity.current
      onToast?.(current.t('progress.act_fail', {
        label: current.t(labelKey),
        msg: formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' }),
      }))
    } finally {
      if (mounted.current && rootIdentity.current === root) setBusy(key, false)
    }
  }

  /** 放行/打回（gate 行）：走同一 transition 校验管线；乐观 patch = phase 直接落到目标步。 */
  async function transitionAction(root: string, name: string, planned: PlannedTransition): Promise<void> {
    const key = rowKeyOf(root, name)
    if (busyRows.has(key)) return
    setBusy(key, true)
    const labelKey = planned.backward ? 'progress.act_reject' : 'progress.act_pass'
    setPatch(key, { base: baseOf(root, name), phase: planned.to })
    try {
      await postTransition(name, root, planned.event)
      if (!mounted.current || rootIdentity.current !== root) return
      const current = localeIdentity.current
      onToast?.(current.t('progress.act_ok', { name, label: current.t(labelKey) }))
      pulseRow(name)
      await onRefresh?.()
    } catch (err) {
      if (!mounted.current || rootIdentity.current !== root) return
      setPatch(key, null)
      const current = localeIdentity.current
      onToast?.(current.t('progress.act_fail', {
        label: current.t(labelKey),
        msg: formatApiError(err, current.t, { exposeServerDetail: current.lang === 'zh' }),
      }))
    } finally {
      if (mounted.current && rootIdentity.current === root) setBusy(key, false)
    }
  }

  // v9-J：failed 行「回终端」chip 批量预取（产品决策=批量端点而非逐行发请求，也不是等用户点开
  // 抽屉才有数据——行内 chip 在需要时批量出现，一次查全部失败行）。依赖键=当前 failed 行
  // key+automation_worktree 值拼串（同 animKey 写法）：键不变（哪怕 SSE 帧刷新了其它无关字段）
  // 就不重打请求；失败行成员真正增减，或某行 automation_worktree 换了新沙箱现场（codex review
  // P2：自动重试重新分配 worktree 后，旧一批预取结果若命中 found:false 会一直卡在静态兜底命令，
  // 直到这里重拉才能看到新现场的真恢复命令）才重拉。已知残留（如实登记不追）：worktree 不变、
  // 用户手动在同一目录另起新终端会话这种更罕见场景不在本次修复范围，不为它引入轮询这种更重的
  // 机制。
  const failedRowsKey = flatRows
    .filter((fr) => fr.row.state === 'failed')
    .map((fr) => `${fr.key}:${fieldStr(fr.row.change, 'automation_worktree')}`)
    .sort()
    .join('|')
  const [sessionLinks, setSessionLinks] = useState<ReadonlyMap<string, SessionLink>>(new Map())
  useEffect(() => {
    if (failedRowsKey === '') {
      setSessionLinks(new Map())
      return
    }
    let cancelled = false
    const failedRows = flatRows.filter((fr) => fr.row.state === 'failed')
    // codex review 第四轮 P2：重新拉取前先清掉这批行在 sessionLinks 里的旧条目——否则 worktree
    // 换了新现场后，在新请求落地之前（网络异常挂起时可能无限久）会一直吐出上一批可能已经指向
    // 错误/过期 worktree 的 resumeCmd，用户按下去接管的其实是不相关的旧会话。清空期间 cmdChipOf
    // 落回静态兜底命令——诚实缺省优先于展示可能张冠李戴的假信息。成功回调仍是整表替换（沿用
    // new Map(Object.entries(result))），顺带清理「已不再 failed」的陈旧条目，无需额外处理。
    setSessionLinks((prev) => {
      const next = new Map(prev)
      for (const fr of failedRows) next.delete(fr.key)
      return next
    })
    fetchSessionLinks(failedRows.map((fr) => ({ root: fr.row.root, name: fr.row.change.name })))
      .then((result) => {
        if (!cancelled) setSessionLinks(new Map(Object.entries(result)))
      })
      .catch(() => {
        /* fail-open：接口失败静默不设表，chip 落回现状静态命令（cmdChipOf 的既有兜底分支） */
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 蓄意只随 failedRowsKey 重拉，见上注释
  }, [failedRowsKey])

  // ── GSAP 入场（spec §4.6）：工具条浮现 → 画布节点弹入（scale+stagger，全包 matchMedia，
  //    reduce 直达终态）。依赖键 = change 成员指纹（仅排序后的 name 集合）：增删 change 才重放
  //    入场；单条状态变化（SSE 帧常态）不整画布重播 stagger——否则任一帧都会盖掉 pulseRow 的
  //    单条强调（评审 P2-6）。循环动效（呼吸环/脉冲/流动虚线）与站台连接段全是纯 CSS
  //    （progress.css，reduced-motion 停帧），不在这里放 JS 循环；画布站点（小站/站台卡）
  //    统一挂 [data-anim="prg-node"]，弹入 stagger 直接吃新结构。──
  const animKey = flatRows.map((fr) => fr.row.change.name).sort().join('|')
  useGSAP(
    () => {
      const el = rootRef.current
      if (!el) return
      // 环境不支持 matchMedia（jsdom/极老内核）：静态呈现即终态，不放任何动画。
      if (typeof window.matchMedia !== 'function') return
      const mm = gsap.matchMedia()
      mm.add(
        { reduce: '(prefers-reduced-motion: reduce)', motion: '(prefers-reduced-motion: no-preference)' },
        (ctx) => {
          const reduce = Boolean((ctx.conditions as { reduce?: boolean } | undefined)?.reduce)
          const chrome = el.querySelectorAll<HTMLElement>('[data-anim="prg-chrome"]')
          const nodes = el.querySelectorAll<HTMLElement>('[data-anim="prg-node"]')
          if (reduce) {
            // 直达终态：工具条/画布节点全可见原位（CSS 循环由 media query 自停）。
            gsap.set(chrome, { autoAlpha: 1, y: 0 })
            gsap.set(nodes, { autoAlpha: 1, scale: 1 })
            return
          }
          if (chrome.length > 0) {
            gsap.fromTo(chrome, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.24, ease: 'power2.out', stagger: 0.05, clearProps: 'all' })
          }
          if (nodes.length > 0) {
            gsap.fromTo(
              nodes,
              { autoAlpha: 0, y: 6 },
              { autoAlpha: 1, y: 0, duration: 0.22, ease: 'power2.out', stagger: 0.035, delay: 0.04, clearProps: 'all' },
            )
          }
        },
      )
    },
    { scope: rootRef, dependencies: [animKey], revertOnUpdate: true },
  )

  // ── 状态页签墨线滑动。墨线不挂 revertOnUpdate——revert 会把墨线 inline left/width 打回缺省
  //    （left:0 width:0），每次切换都从最左飞入；gsap.to 天然从当前位置延续滑动，overwrite:'auto'
  //    收编快速连点。reduced 墨线直落位。deps 含 animKey：change 成员变化后页签宽度（计数位数）
  //    可能变，墨线要补一次落位。──
  useGSAP(
    () => {
      const el = rootRef.current
      if (!el || typeof window.matchMedia !== 'function') return
      const mm = gsap.matchMedia()
      mm.add(
        { reduce: '(prefers-reduced-motion: reduce)', motion: '(prefers-reduced-motion: no-preference)' },
        (ctx) => {
          const reduce = Boolean((ctx.conditions as { reduce?: boolean } | undefined)?.reduce)
          const ink = el.querySelector<HTMLElement>('[data-anim="prg-ink"]')
          const onTab = el.querySelector<HTMLElement>(`[data-testid="prg9t-tab-${deckTab}"]`)
          if (ink && onTab?.parentElement) {
            const tr = onTab.getBoundingClientRect()
            const pr = onTab.parentElement.getBoundingClientRect()
            const left = tr.left - pr.left + 6
            const width = Math.max(tr.width - 12, 0)
            if (reduce) gsap.set(ink, { left, width })
            else gsap.to(ink, { left, width, duration: 0.28, ease: 'expo.out', overwrite: 'auto' })
          }
        },
      )
    },
    { scope: rootRef, dependencies: [deckTab, animKey] },
  )

  // ── change 投影：徽章/状态点（抽屉徽章 + 画布小卡共用同源判定）──

  /** 当前相位展示名（自定义步用 labelByStep，default 走 phases.* i18n）——抽屉徽章 running 文案用。 */
  function phaseLabelOf(fr: FlatRow): string {
    return stepLabel(fr.row.change.phase, fr.rules, t)
  }

  /** 一枚人话判定徽章（gate/failed 复用 rowSemantics 同源判定；行内导语已退役，§4.5）。 */
  function judge(fr: FlatRow, evidence: EvidenceChip[], phaseLabel: string): RowBadge {
    const c = fr.row.change
    switch (fr.row.state) {
      case 'gate': {
        const sem = rowSemantics(c, 'gate', evidence, t)
        return { tone: sem.tone, text: sem.badgeText }
      }
      case 'failed': {
        if (fr.cancelled) return { tone: 'amb', text: t('progress.badge_cancelled') }
        const sem = rowSemantics(c, 'failed', [], t)
        return { tone: 'red', text: sem.badgeText }
      }
      case 'running':
        return { tone: 'blue', text: t('progress.badge_running', { phase: phaseLabel }) }
      case 'queued':
        return { tone: 'neutral', text: t('progress.state_queued') }
      case 'agent': {
        const missing = missingGateArtifacts(c, fr.rules)
        return {
          tone: 'neutral',
          text: missing.length > 0 ? t('progress.state_agent_missing', { fields: missing.join(' ') }) : t('progress.state_agent'),
        }
      }
    }
  }

  /** 状态点语义（画布小卡/站点共用同一判定，rowSemantics 同源，不另起第二套五态映射）。
   *  #4 颜色收敛：state 仍分档承载语义（testid/aria/data-state 消费），tone 只走信号最小集——
   *  失败 red、门/取消 amber、运行中 accent(blue)、其余（等产出/排队等）中性 gray。 */
  function dotOf(fr: FlatRow): { state: string; tone: CanvasDotTone } {
    switch (fr.row.state) {
      case 'gate': {
        const sem = rowSemantics(fr.row.change, 'gate', gateEvidence(fr.row.change, fr.rules), t)
        return { state: sem.tone === 'green' ? 'gateok' : 'gatejudge', tone: 'amb' }
      }
      case 'failed':
        return fr.cancelled ? { state: 'cancelled', tone: 'amb' } : { state: 'failed', tone: 'red' }
      case 'running':
        return { state: 'running', tone: 'blue' }
      case 'queued':
        return { state: 'queued', tone: 'gray' }
      case 'agent':
        return { state: 'agent', tone: 'gray' }
    }
  }

  /** testid 由调用点给：行内 prg9-badge-{name}、抽屉 prg9-dw-badge——同名双挂会撞 getByTestId。 */
  function badgeEl(fr: FlatRow, b: RowBadge, testid: string): JSX.Element {
    return (
      <span
        className={`inline-flex items-center gap-[5px] whitespace-nowrap rounded-md px-2 py-[1.5px] text-xs font-semibold ${BADGE_TONE_CLS[b.tone]}`}
        data-tone={b.tone}
        data-testid={testid}
        title={fr.row.state === 'agent' ? t('progress.state_agent_hint') : undefined}
      >
        {(b.tone === 'red' || b.tone === 'blue' || b.tone === 'amb') && (
          <span className="h-1.5 w-1.5 rounded-full bg-current" data-pulse={b.tone === 'blue' || undefined} aria-hidden="true" />
        )}
        {b.tone === 'green' && <Check className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
        {b.text}
      </span>
    )
  }

  function drawerActionsFor(row: FlatRow): JSX.Element {
    if (readOnly) return <></>
    return (
      <ProgressActions
        row={row}
        busy={busyRows.has(row.key)}
        sessionLink={sessionLinks.get(row.key)}
        t={t}
        lang={lang}
        onTransition={(root, name, transition) => {
          void transitionAction(root, name, transition)
        }}
        onKill={(root, name) => {
          void killAction(root, name)
        }}
        onToast={onToast}
      />
    )
  }

  const canvasGroups = useMemo(() => buildCanvasGroups({
    selection: base,
    rulesByKey,
    rowsByKey: frByKey,
    workflowFilter: effectiveWf,
    deckTab,
    selectedKey: drawerKey,
    t,
    dotOf,
    statusOf: (row) => judge(
      row,
      row.row.state === 'gate' ? gateEvidence(row.row.change, row.rules) : [],
      phaseLabelOf(row),
    ).text,
  }), [base, rulesByKey, frByKey, effectiveWf, deckTab, drawerKey, t])
  const compatibilityProject = snapshot?.projects.find((project) => project.root === currentRoot)
  const compatibilityIssues = compatibilityProject?.compatibilityIssues ?? []

  return (
    <section className="prg-command-deck relative mx-auto w-full max-w-[1120px] pt-6 pb-5" data-testid="progress-view" data-page-frame="standard" ref={rootRef}>
      <ProgressToolbar
        t={t}
        rowCount={flatRows.length}
        deckTab={deckTab}
        deckCounts={deckCounts}
        filterSummary={filterSummary}
        workflows={wfNames}
        workflow={effectiveWf}
        onDeckTab={setDeckTab}
        onWorkflow={setWfFilter}
      />

      <CanonicalStateVersionNotice
        issues={compatibilityIssues}
        truncated={compatibilityProject?.compatibilityIssuesTruncated}
        loading={loading}
        onRefresh={onRefresh}
      />

      {error && <SnapshotInlineError error={error} loading={loading} onRefresh={onRefresh} />}
      {loading && !snapshot && <p className="py-2 text-[13px] text-text-3" role="status" aria-live="polite">{t('common.loading')}</p>}

      <OrchestrationV2Panel root={currentRoot} change={selectedChange} readOnly={readOnly} onToast={onToast} />

      {snapshot && flatRows.length > 0 && (
        <WorkflowCanvas groups={canvasGroups} onOpen={openDrawer} />
      )}

      {snapshot && flatRows.length === 0 && compatibilityIssues.length === 0 && (
        <div className="rounded-xl border border-dashed border-border-2 p-5 text-[13px] text-text-3" role="status" aria-live="polite" data-testid="prg-empty">
          {t('progress.empty')}
        </div>
      )}

      {!readOnly && createOpen && (
        <CreateChangeDialog
          root={currentRoot}
          onClose={() => setCreateOpen(false)}
          onCreated={async (name) => {
            // 先锁定 URL/宿主选择，再刷新 snapshot；受控 effect 会在新 change 真正进入投影后开抽屉。
            onSelectedChange?.(name)
            await onRefresh?.()
          }}
          onToast={onToast}
        />
      )}

      {drawerRow && (
        <ProgressDrawer
          row={drawerRow}
          drawerRef={drawerRef}
          scrimRef={scrimRef}
          badge={badgeEl(
            drawerRow,
            judge(
              drawerRow,
              drawerRow.row.state === 'gate'
                ? gateEvidence(drawerRow.row.change, drawerRow.rules)
                : [],
              phaseLabelOf(drawerRow),
            ),
            'prg9-dw-badge',
          )}
          actions={drawerActionsFor(drawerRow)}
          onClose={closeDrawer}
          onToast={onToast}
        />

      )}
    </section>
  )
}
