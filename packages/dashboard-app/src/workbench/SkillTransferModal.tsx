import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { fetchSkillsRegistry, type WbSkillEntry } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'

export interface SkillTransferModalProps {
  selected: string[]
  onSave: (skills: string[]) => Promise<void> | void
  onCancel: () => void
}

const DND_MIME = 'application/x-pipeline-skill'

// ── W3 tailwind 迁移：原 styles.ts .transfer* 规则的等值原子类串（颜色全走 token；
//    未安装态由 data-uninstalled 属性驱动，已选态类由调用点条件叠加）。──
/** 原 .transfer__item（+ --uninstalled 修饰符）。 */
const ITEM_CLS =
  'block w-full cursor-pointer truncate rounded-sm border border-transparent bg-fill px-2 py-1.5 text-left font-mono text-caption text-text-2 transition-colors hover:border-accent-b hover:bg-accent-t hover:text-accent-d data-uninstalled:opacity-62'
/** 原 .transfer__item--chosen：右栏条目，hover 转红示意「点击移出」。 */
const CHOSEN_CLS = 'bg-accent-t text-accent-d hover:border-red-b hover:bg-red-t hover:text-red-d'
/** 原 .transfer__col。 */
const COL_CLS =
  'flex h-[220px] min-w-0 flex-1 flex-col gap-1 overflow-y-auto rounded-sm border border-border bg-card p-2'
/** 原 .wb-chip-badge（与 SkillChain 同款未安装小徽章；纯提示 span，无点击）。 */
const CHIP_BADGE_CLS =
  'ml-1 flex-none whitespace-nowrap rounded-full border-0 bg-[color-mix(in_oklch,var(--red)_52%,var(--green))] px-1.5 py-px text-micro font-bold text-card'

export function SkillTransferModal({ selected, onSave, onCancel }: SkillTransferModalProps): JSX.Element {
  const { t, lang } = useT()
  const [all, setAll] = useState<WbSkillEntry[]>([])
  const [chosen, setChosen] = useState<string[]>(selected)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<unknown | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 语言切换只重渲染错误文案，不重拉 registry，也不打断当前选择与焦点。
    let cancelled = false
    fetchSkillsRegistry()
      .then((skills) => {
        if (!cancelled) setAll(skills)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const available = all.filter((e) => !chosen.includes(e.name) && e.name.toLowerCase().includes(query.toLowerCase()))
  // v6 T10：未安装 badge 查询面(chosen 栏条目可能不在 registry——如 manifest 自由 token,查无即不标)。
  const entryOf = new Map(all.map((e) => [e.name, e]))
  const uninstMark = (name: string): JSX.Element | null => {
    const entry = entryOf.get(name)
    if (!entry || entry.installed) return null
    return (
      <span className={CHIP_BADGE_CLS} aria-hidden="true" title={entry.installCmd ?? t('workbench.sk_uninstalled_hint_user')}>
        {t('workbench.sk_uninstalled')}
      </span>
    )
  }

  // 点击与拖拽共用同一对纯函数（Task 16，评审 P1-10 后半）：点击即移动是主交互，HTML5 拖拽
  // 保留作为增强，onDragStart/onDrop 落到同一对 move 函数上，不是两套平行逻辑。两者对同一
  // skill 重复调用都是幂等的——moveToChosen/moveToAvailable 现在对称地都以 includes 判断
  // 是否真的需要移动，已经在目标栏的重复调用直接 return（不产生多余 setState/render），
  // 故不需要额外去重判断谁先触发。（评审修复轮 Minor：moveToAvailable 此前少了这层
  // includes 短路，全靠 filter 对不在列表里的项天然 no-op 兜底效果上等价，但要走一次
  // setChosen([...]) 触发多余 re-render，此处补上与 moveToChosen 对称。）
  //
  // 评审修复轮（Important，焦点逃逸）：条目从一栏移到另一栏时，原 <button> 跨父节点重建
  // （available/chosen 是两个不同的 <div>，React 视为不同父节点下的元素，不会复用/仅
  // patch 同一 DOM 节点，旧节点直接被卸载）。若点击发生时它持有焦点，DOM 规范行为是卸载后
  // 焦点回退到 document.body——逃出 Dialog 的 Tab 困笼（困笼只在 keydown 时改判下一跳该
  // 给谁，接不住已经落到 body 的焦点；键盘用户连续移动多个条目，每次都会被弹出对话框外）。
  // 修法：真的发生移动时，把焦点归位到搜索框（searchRef 所指的 input，全程挂载、不随条目
  // 增减卸载，是栏内唯一稳定的焦点落点，且归位后用户可直接继续输入过滤或 Tab 回条目列表）。
  //
  // 时机选同步直调 `.focus()`，不用 requestAnimationFrame/setTimeout/useEffect：这里的
  // moveToChosen/moveToAvailable 是从 onClick handler 内同步调用的，此刻 React 尚未把
  // 本次 setState 提交到 DOM——被点击的旧 <button> 此时还在文档里，但 searchRef.current
  // 指向的搜索框不随本次更新增减，是稳定节点，此处同步 focus() 它，焦点先一步移开；随后
  // React 提交、移除旧 <button> 时它已不再持有焦点，不会触发"焦点节点被移除→回退 body"
  // 的浏览器行为，全程不经过可观测的"先掉到 body 再抢回来"中间态。改用
  // useEffect/rAF/setTimeout 要等 DOM 先提交完（旧节点先被移除、焦点先真的掉一次 body）
  // 才能补救，效果上殊途同归但多绕一圈，故选更直接的同步方案。
  function moveToChosen(skill: string): void {
    if (chosen.includes(skill)) return
    setChosen([...chosen, skill])
    searchRef.current?.focus()
  }
  function moveToAvailable(skill: string): void {
    if (!chosen.includes(skill)) return
    setChosen(chosen.filter((s) => s !== skill))
    searchRef.current?.focus()
  }
  function onDropToChosen(e: React.DragEvent): void {
    e.preventDefault()
    const skill = e.dataTransfer.getData(DND_MIME)
    if (skill) moveToChosen(skill)
  }
  function onDropToAvailable(e: React.DragEvent): void {
    e.preventDefault()
    const skill = e.dataTransfer.getData(DND_MIME)
    if (skill) moveToAvailable(skill)
  }

  return (
    // Task 4（评审 P0-5）：外层手写 `<div className="modal" role="dialog">` 换成共享 <Dialog>
    // （Esc/焦点管理/backdrop 点击关随之补齐）。当时只做壳迁移，内部条目交互与真实样式明确
    // 留给 Task 16。
    //
    // Task 16（评审 P1-10 后半）：`.modal`/`.split` 此前零 CSS 规则的裸渲染在此收口——`.split`
    // 更名 `.transfer`，styles.ts 补齐 `.transfer*` 全套真样式（双栏布局/条目 hover/选中态/
    // 搜索框，token 化、跟随深浅色主题）。交互补齐"点击即移动"：左栏条目点击 → moveToChosen，
    // 右栏条目点击 → moveToAvailable。条目元素从 <div> 换成 <button type="button">——对齐
    // 仓库既有"可点击列表项 = 原生 button"惯例（旧画布编辑器（T18 已退役） 的 stage-card、
    // 旧 AFK 工作台（T18 已退役） 的 afk-item 先例），顺带获得键盘 Enter/Space 可达性（此前纯 div 键盘
    // 完全不可达，仅能拖拽）。Save/Cancel 补 .btn/.btn--ghost（对齐其余全部 Dialog actions
    // 的既有用法，如 NewChangeDialog/旧看板视图 确认框），此前是零样式裸 <button>。
    <Dialog
      title={t('skill_transfer.title')}
      onClose={onCancel}
      actions={
        <>
          <Button type="button" size="sm" onClick={() => onSave(chosen)}>{t('skill_transfer.save')}</Button>
          <Button type="button" variant="outline" size="sm" className="bg-transparent" onClick={onCancel}>{t('skill_transfer.cancel')}</Button>
        </>
      }
    >
      {/* 搜索框仍是条目移动后的焦点归位锚（经 searchRef，见上方注释）——样式原子化不改这层契约。 */}
      <input
        ref={searchRef}
        className="mt-1 block w-full rounded-sm border border-border bg-fill px-2.5 py-2 text-caption text-text transition placeholder:text-text-3 focus-visible:border-(--accent) focus-visible:shadow-[0_0_0_3px_var(--ring-blue)] focus-visible:outline-none"
        placeholder={t('skill_transfer.search_placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="mt-2.5 flex gap-2.5">
        <div className={COL_CLS} data-testid="skill-available" onDragOver={(e) => e.preventDefault()} onDrop={onDropToAvailable}>
          {error !== null && <div className="m-0 px-0.5 py-1.5 text-micro font-semibold text-red" data-testid="skill-error" role="alert">{t('skill_transfer.load_error', { msg: formatApiError(error, t, { exposeServerDetail: lang === 'zh' }) })}</div>}
          {!error && available.map(({ name: s, installed }) => (
            <button
              key={s}
              type="button"
              className={ITEM_CLS}
              data-uninstalled={installed ? undefined : ''}
              title={s}
              aria-label={s}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DND_MIME, s)}
              onClick={() => moveToChosen(s)}
            >
              {s}
              {uninstMark(s)}
            </button>
          ))}
        </div>
        <div className={COL_CLS} data-testid="skill-chosen" onDragOver={(e) => e.preventDefault()} onDrop={onDropToChosen}>
          {chosen.map((s) => (
            <button
              key={s}
              type="button"
              className={cn(ITEM_CLS, CHOSEN_CLS)}
              title={s}
              aria-label={s}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DND_MIME, s)}
              onClick={() => moveToAvailable(s)}
            >
              {s}
              {uninstMark(s)}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
