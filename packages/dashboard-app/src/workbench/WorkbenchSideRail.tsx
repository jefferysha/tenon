import { useCallback, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useT } from '../i18n'
import { Dialog } from '../shared/Dialog'
import { UnsavedDraftDialog, useDiscardGuard } from '../shared/UnsavedDraftDialog'
import { AutomationCard } from './AutomationCard'
import { GovernanceRail } from './GovernanceRail'
import { LoopCard, WB_TW, type LoopsState } from './LoopCard'
import { SecretsCard } from './SecretsCard'
import { SkillHealthPanel } from './SkillHealthPanel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * WorkbenchSideRail（P4 任务 B）——编排画布右栏的**组装件**。
 *
 * ── 为什么存在：合并的是 IA，不是能力 ──
 * 「五页签合并进一张编排画布」若字面执行会**丢真能力**：LoopCard 的 goal/kill_criteria/
 * allowlist/risk/runner/human_gates/草稿审阅全是 🟢 可写，而 P3 的治理轨只接了级别/就绪/
 * 熔断三件；AFK 执行/凭证/技能健康则是 per-root 机器配置（与编排正交，但同样是真能力）。
 * 本组件给这两拨能力在右栏安排去处，页签才能**安全退役**——P4 后每一项 🟢 仍可达：
 *   · Loop 全量表单 → 「完整治理设置」Dialog（挂 LoopCard 原件，平铺页签 → 按需展开）
 *   · AFK/凭证/技能健康 → 「机器配置」折叠区（默认折叠——机器级配置不是日常路径）
 *
 * ── 本文件的纪律：只组装，不重写 ──
 * GovernanceRail / LoopCard / AutomationCard / SecretsCard / SkillHealthPanel 五件**一行都不改**
 * （各自既有测试：LoopCard 38 条、AutomationCard 25 条、SecretsCard 9 条、SkillHealthPanel 5 条），
 * 本文件只 import 它们的既有导出 + 提供卡壳/折叠/Dialog 三样容器。
 *
 * ── 三处容易做错的地方，逐条钉死 ──
 * ① **LoopCard 走 Dialog 而非内联**：右栏宽 280px，1141 行的完整表单塞不进去（内联 = 挤成
 *    一柱麻花）。Dialog 宽 min(420px,92%) 且无高度上限，故本文件给内容套
 *    `max-h-[62vh] overflow-y-auto` 滚动壳——否则长表单会撑出视口、底部的保存钮永远够不着。
 * ② **折叠区闭合即卸载**（`{machineOpen && …}`）：三张机器卡各自 mount 时都会 fetch
 *    （/api/automation、/api/secrets/keys、/api/skills/registry）。原生 `<details>` 闭合态仍把
 *    children 留在 DOM = 每次进工作台白烧 3 个请求，给用户根本没打开的面板拉数。故照
 *    WbAdvanced（shadcn Collapsible「闭合即卸载」）的既有口径：闭合不挂载。
 * ③ **`<details>` 受控 + summary 上 preventDefault**：契约要原生 details（无障碍/键盘白拿），
 *    但原生开合是浏览器自己翻 `open`，与「闭合即卸载」所需的 React state 会打架（两个真相源）。
 *    故 summary 的 click 里 preventDefault 掐掉原生 activation behavior，`open` 单一由 state 驱动。
 *    副作用是好的：state 在 click handler 内同步更新 → 测试里 fireEvent/userEvent 点一下即生效，
 *    不依赖 `toggle` 事件那条**异步排队**的路（那条路会让 setState 落在 act() 外，招 act 警告）。
 *
 * ── i18n ──
 * 新键走 `workbench.rail_*` 前缀（4 个：rail_loop_full / rail_loop_note / rail_machine_title /
 * rail_machine_note）；关闭钮复用既有 `workbench.lp_rel_dialog_close`（同一个词、同一个动作、
 * 同一种控件——不为「作用域好看」再造一个「关闭」）。三张机器卡与 LoopCard 各自渲染自己的
 * 卡头（afk_title/sc_title/skh_title/lp_title），故本文件**不重复**给它们贴标题。
 *
 * ── 样式 ──
 * tailwind v4 原子类 + token 语义类（无 dark:／无裸 shadow／无 side-stripe 彩色左右边框）；
 * 状态走 data-*／aria + `data-[…]:` 变体；名称零截断（无 truncate/ellipsis）；base ≥14px、
 * 卡名 14.5px、note 沿 GovernanceRail GNOTE 的既有 12px 解释性副文口径。
 */

/** 右栏纵向节奏：与宿主 wb-side-col 的 gap-4 同拍。 */
const RAIL_TW = 'flex w-full min-w-0 flex-col gap-4'
/** GovernanceRail GCARD_TW 的对位（rail 家族卡壳：card 底 + border + 14px 圆角 + 卡片级 shadow-sm）。 */
const GCARD_TW = 'rounded-md border border-border bg-card shadow-sm'
/** demo .gcard 内边距（机器卡壳：卡自身是「无皮」件——旧 `.wb8-pane > .card` 剥皮语义，由容器补皮与内边距）。 */
const CARD_PAD_TW = 'px-4 py-4'
/** 卡名 14.5px（GovernanceRail GH_B_TW 同口径）。 */
const HEAD_B_TW = 'text-base font-[750] text-text'
/** 解释性副文（GovernanceRail GNOTE_TW 同口径的 12px）。 */
const NOTE_TW = 'text-caption leading-[1.55] text-text-3'
/**
 * 「完整治理设置」入口钮：整宽、14px（base 下限）。shadcn Button 默认 h-9，这里按 rail 的
 * 触达面加到 h-10——它是右栏唯一的「展开全量表单」入口，不该比卡内小钮还难点。
 */
const ENTRY_BTN_TW =
  'h-10 w-full justify-center rounded-sm border border-border bg-card px-4 text-base font-bold text-text shadow-sm hover:border-text-3 hover:bg-fill'
/** summary：整行可点；原生 ▸ 标记隐掉（列表标记与 lucide ChevronRight 会双份显示）。 */
const SUMMARY_TW =
  'flex cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-fill [&::-webkit-details-marker]:hidden'

export interface WorkbenchSideRailProps {
  root: string
  /** 从 './LoopCard' import 的既有 useLoops 返回类型——宿主已持有同一份 rows（「数据住共同祖先」）。 */
  loops: LoopsState
  /** 凭证保存/删除成功 → 宿主 +1 rdNonce（AFK 就绪三灯重拉；显式动作触发，不轮询，G22 纪律）。 */
  onSecretsChanged?: () => void
  /** 宿主持有的就绪灯重拉信号 → AutomationCard.refreshToken。 */
  rdNonce?: number
  /** 摘要卡等既有右栏内容（宿主传入，避免本组件反向依赖 WorkbenchView）。 */
  children?: ReactNode
  /** Reports only unsaved form drafts; immediate server mutations never enter this channel. */
  onDirtyChange?: (source: 'loop' | 'automation' | 'secrets', dirty: boolean) => void
  /** Keeps enclosing overlays mounted until an in-flight child mutation settles. */
  onBusyChange?: (source: 'loop' | 'automation' | 'secrets', busy: boolean) => void
}

export function WorkbenchSideRail({ root, loops, onSecretsChanged, rdNonce = 0, children, onDirtyChange, onBusyChange }: WorkbenchSideRailProps): JSX.Element {
  const { t } = useT()
  /** 「完整治理设置」Dialog 开合。 */
  const [loopOpen, setLoopOpen] = useState(false)
  /** 「机器配置」折叠区开合——**同时**是内容的挂载开关（见文件头②）。 */
  const [machineOpen, setMachineOpen] = useState(false)
  const [drafts, setDrafts] = useState({ loop: false, automation: false, secrets: false })
  const [mutations, setMutations] = useState({ loop: false, automation: false, secrets: false })
  const discardGuard = useDiscardGuard()
  const reportDirty = useCallback((source: 'loop' | 'automation' | 'secrets', dirty: boolean) => {
    setDrafts((current) => current[source] === dirty ? current : { ...current, [source]: dirty })
    onDirtyChange?.(source, dirty)
  }, [onDirtyChange])
  const reportLoopDirty = useCallback((dirty: boolean) => reportDirty('loop', dirty), [reportDirty])
  const reportAutomationDirty = useCallback((dirty: boolean) => reportDirty('automation', dirty), [reportDirty])
  const reportSecretsDirty = useCallback((dirty: boolean) => reportDirty('secrets', dirty), [reportDirty])
  const reportBusy = useCallback((source: 'loop' | 'automation' | 'secrets', busy: boolean) => {
    setMutations((current) => current[source] === busy ? current : { ...current, [source]: busy })
    onBusyChange?.(source, busy)
  }, [onBusyChange])
  const reportLoopBusy = useCallback((busy: boolean) => reportBusy('loop', busy), [reportBusy])
  const reportAutomationBusy = useCallback((busy: boolean) => reportBusy('automation', busy), [reportBusy])
  const reportSecretsBusy = useCallback((busy: boolean) => reportBusy('secrets', busy), [reportBusy])

  function closeLoop(): void {
    if (mutations.loop) return
    discardGuard.request(drafts.loop, () => setLoopOpen(false))
  }

  function toggleMachine(): void {
    if (!machineOpen) {
      setMachineOpen(true)
      return
    }
    if (mutations.automation || mutations.secrets) return
    discardGuard.request(drafts.automation || drafts.secrets, () => setMachineOpen(false))
  }

  return (
    <div className={RAIL_TW} data-testid="wb-side-rail">
      {/* ── ① 治理轨（P3 原件原样挂）：级别 🟢 / 就绪分 📊 / 熔断·预算（阈值 🟢、态 📊）── */}
      <GovernanceRail root={root} loops={loops} />

      {/* ── ② 完整治理设置入口 —— 「自动运行」页签退役后，Loop 全量表单的**唯一**去处。
             note 不是装饰：能力从「一眼可见的页签」挪到了「按钮后面」，得点名里面有什么，
             否则用户以为这些字段随页签一起没了（可达 ≠ 可发现）。 ── */}
      <div>
        <Button
          type="button"
          variant="ghost"
          className={ENTRY_BTN_TW}
          data-testid="wb-rail-loop-full"
          disabled={mutations.loop}
          onClick={() => setLoopOpen(true)}
        >
          {t('workbench.rail_loop_full')}
        </Button>
        <p className={cn(NOTE_TW, 'mt-1.5 px-0.5')}>{t('workbench.rail_loop_note')}</p>
      </div>

      {/* ── ③ 机器配置（默认折叠）—— per-root/机器级，与当前 workflow 正交。
             受控 details + preventDefault（见文件头③）；闭合不挂载（见文件头②）。 ── */}
      <details className={GCARD_TW} open={machineOpen} data-testid="wb-rail-machine" data-open={machineOpen}>
        <summary
          className={SUMMARY_TW}
          data-testid="wb-rail-machine-summary"
          data-open={machineOpen}
          aria-disabled={machineOpen && (mutations.automation || mutations.secrets)}
          onClick={(e) => {
            e.preventDefault() // 掐掉原生 activation：open 的唯一真相源是下面这个 state
            toggleMachine()
          }}
        >
          <ChevronRight
            aria-hidden="true"
            className="size-4 flex-none text-text-3 transition-transform duration-150 data-[open=true]:rotate-90 motion-reduce:transition-none"
            data-open={machineOpen}
          />
          <b className={HEAD_B_TW}>{t('workbench.rail_machine_title')}</b>
        </summary>
        {machineOpen && (
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3.5">
            {/* 区头说明：讲清楚「这里的东西不随 workflow 变」——否则用户会以为改的是当前 workflow 的配置。 */}
            <p className={NOTE_TW} data-testid="wb-rail-machine-note">
              {t('workbench.rail_machine_note')}
            </p>
            {/* 三件原件（各自渲染自己的卡头）；卡本身「无皮」，由这里补卡壳与内边距。 */}
            <div className={cn(GCARD_TW, CARD_PAD_TW)}>
              <AutomationCard root={root} refreshToken={rdNonce} onDirtyChange={reportAutomationDirty} onBusyChange={reportAutomationBusy} />
            </div>
            <div className={cn(GCARD_TW, CARD_PAD_TW)}>
              <SecretsCard onChanged={onSecretsChanged} onDirtyChange={reportSecretsDirty} onBusyChange={reportSecretsBusy} />
            </div>
            <div className={cn(GCARD_TW, CARD_PAD_TW)}>
              <SkillHealthPanel />
            </div>
          </div>
        )}
      </details>

      {/* ── ④ 宿主既有右栏内容（摘要卡 / 安全门说明 / 最近流转）── */}
      {children}

      {/* ── 「完整治理设置」Dialog：挂 LoopCard **原件**，goal/kill_criteria/allowlist/草稿审阅
             等全部能力原样保留。LoopCard 内层还有自己的 Dialog（升档确认/发布），但那些只在
             用户交互后的**后续 commit** 才挂载，不触碰 Dialog.tsx 记的「同一 commit 内父子
             Dialog 同时首次挂载」禁区。 ── */}
      {loopOpen && (
        <Dialog
          title={t('workbench.rail_loop_full')}
          onClose={closeLoop}
          testid="wb-rail-loop-dialog"
          actions={
            <Button
              variant="ghost"
              size="sm"
              className={WB_TW.btnGhost}
              data-testid="wb-rail-loop-close"
              disabled={mutations.loop}
              onClick={closeLoop}
            >
              {t('workbench.lp_rel_dialog_close')}
            </Button>
          }
        >
          {/* 滚动壳（见文件头①）：长表单不撑出视口，保存钮恒可达。 */}
          <div className="-mr-1.5 max-h-[62vh] overflow-y-auto pr-1.5">
            <LoopCard root={root} loops={loops} onDirtyChange={reportLoopDirty} onBusyChange={reportLoopBusy} />
          </div>
        </Dialog>
      )}
      <UnsavedDraftDialog
        open={discardGuard.confirmOpen}
        testid="wb-rail-unsaved-draft"
        onStay={discardGuard.stay}
        onDiscard={discardGuard.discard}
      />
    </div>
  )
}
