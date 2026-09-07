import type { ReactNode } from 'react'
import type { WbHookEvent, WbSkillEntry } from '../api/client'
import type { HooksConfigState } from './HookTimeline'
import type { GateHookInfo } from './StepperRail'

export interface BoardLane {
  id: string
  /** 展示名（label 优先 → default 走 i18n phases.* → 兜底 id）。投影层已算好。 */
  name: string
  gate: 'review' | 'confirm' | null
  /**
   * 技能全名 id 序（去重后，含命名空间前缀，禁短名化）。
   * `[]` = 本阶段确实没有技能（自定义 workflow 的真实空态 → 渲染「（空）」）。
   * `undefined` = 技能不由本数据源描述 → **整段不渲染**（诚实占位，同 hooksCount 纪律）。
   * 后者专为 default：它的 workflow 定义里 skills 恒为空数组，但真实的强制技能存在
   * manifest 的 `phase.track` 矩阵（GET /api/config）里——渲染「（空）」等于谎报「无技能」。
   * 该矩阵由 P1 的 renderSkillZone 接入（宿主投喂，画布本身不认识 /api/config）。
   */
  skills?: string[]
  /**
   * 本列每个技能的 depends_on（P2 补丁 v2 ①）：键 = 技能 id，值 = 它依赖的技能 id 序。
   * **只含同列内的依赖**——跨 step 引用是 kernel 的校验期错误（kernel/src/workflow/types.ts
   * :SkillRef 注释明写），投影层已过滤，本组件不再二次判断（同 P0 的零业务判断分工）。
   *
   * 缺键 / 空数组 = 该技能无依赖；`undefined`（整个字段不给）= 数据面不描述依赖 → 不渲染
   * 任何依赖 chip（诚实占位，同 hooksCount / skills 的既定纪律：没有数据就不画，不谎报「无依赖」）。
   *
   * 为什么是 `Record` 而不是把 `skills` 改成对象数组：`skills: string[]` 是 P0/P1 的既有契约，
   * 既有 fixture 全按它写；加一个可选旁路字段是纯增量，改数组元素类型则要推翻所有既有用例。
   */
  skillDeps?: Record<string, string[]>
  /** 产出字段名序。 */
  outputs: string[]
  /**
   * 该列是否已开 nonempty-output guard（P4）：即 step.guards 里是否存在 { type:'nonempty-output' }
   * （判定照 StepEditor.tsx:64 的 hasNonempty，投影层已算好——本组件不认识 GuardConfig 的形状，
   * 同 P0 的零业务判断分工）。
   *
   * `undefined` = 数据面不描述 guard → **不渲染该开关**（诚实占位，同 hooksCount / skills /
   * skillDeps 的既定纪律：没有数据就不画，不谎报「这一列的 guard 是关着的」）。
   * 注：tasks-at-least 那类其余 guard 不由本字段表达，也不该被本开关碰——宿主在增删
   * nonempty-output 时把它们原样保留（StepEditor.tsx:71-78 的既定语义）。
   */
  nonemptyGuard?: boolean
  /** 该阶段启用 hook 数；undefined = 数据面未就绪 → 隐藏该段（诚实占位，不谎报数字）。 */
  hooksCount?: number
  /** 锁 hook 数（gate/interactive-skill-gate 恒 2）；hooksCount 未就绪时一并隐藏。 */
  hooksLocked?: number
  /** 与下一列之间的转换事件名；无 forward 边 = null → 不画连接件（诚实：边不存在就不画）。 */
  linkEvent: string | null
  /** 该阶段真实 change 计数。 */
  count: number
  /** 该阶段是否有 automation==='running' 的 change。 */
  running: boolean
}

/**
 * 阶段字段的就地编辑补丁（P1）：**只含被改字段**，未触碰字段由宿主原样保留
 * （同 StepEditor「除本卡触碰的面之外一律展开透传」的既有纪律）。
 *
 * · `gate` 的类型保留 'confirm' 是为了能表达读回来的 default 值，但本组件**永不发出它**
 *   ——门是二态 `null ↔ 'review'`（见文件头 P1 口径 ①）。
 * · `outputs` 是**字段名序 string[]**，不是 kernel 的 WbFieldRef[]：画布只认名字，
 *   新产出的缺省类型（StepEditor.tsx:108 既定的 `type: 'string'`——FieldRef 三型里最通用的
 *   一档）由宿主在转回 WbFieldRef 时补。本组件不认识 FieldRef 三型，同 P0 的零业务判断分工。
 */
export interface LanePatch {
  label?: string
  gate?: 'review' | 'confirm' | null
  outputs?: string[]
}

export interface OrchestrationBoardProps {
  lanes: BoardLane[]
  /** true = default workflow：满屏 🔒 只读态（禁拖手柄、锁徽章、产出标固定）。 */
  readonly: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  /** 看板容器 aria-label，如「release-train 阶段」。 */
  label: string
  /** 不传 = 禁用态（default 只读）。照 StepperRail 既有 disabled={!onAddStage} 语义。 */
  onAddStage?: () => void
  /** 门徽章 popover 的静态解释内容（gate/interactive-skill-gate 强制常开，决议 #2）。 */
  gateHooks?: readonly GateHookInfo[]
  /**
   * 阶段字段就地改（P1）。**不传 = 只读**（default）；`readonly === true` 时同样不出真控件
   * ——两者任一成立即锁死，宿主传错一个也不会漏出假可写面。
   * patch 只含被改字段，未触碰字段由宿主保留。
   */
  onLaneEdit?: (laneId: string, patch: LanePatch) => void
  /**
   * 删阶段（P1）。不传 = 不渲染删除入口；`readonly === true` 时同样不渲染。
   * 本组件只负责「入口 + 确认弹窗 + 回调」——删除引发的**转换边重连由宿主实现**（见文件头 ③）。
   */
  onRemoveStage?: (laneId: string) => void
  /**
   * 技能区的替代内容（P1）。提供时**渲染它取代默认技能区**；与 `BoardLane.skills === undefined`
   * 配套使用——default 的强制技能存在 manifest 的 `phase.track` 矩阵里，不是 workflow def 的
   * skills。数据面归宿主：这样画布本身不必认识 /api/config（同 P0 的零业务判断分工）。
   */
  renderSkillZone?: (laneId: string) => ReactNode
  /**
   * 技能卡拖动落位（P2）：列内排序 or 跨列搬。**不传 = 不给拖手柄**；`readonly === true` 时同样
   * 不给（default 的强制技能无排序语义，见文件头 P2 口径 ①）。
   *
   * 本组件只报「谁、从哪、到哪、落在谁前后」：数组次序怎么改、跨列搬要清哪些失效依赖、
   * 目标列已有同名技能时怎么 no-op，全在宿主的 moveSkillInDef 里（同 P1 删阶段的边重连分工）。
   * 唯一在本组件落地的是**跨列同名的当场拦截 + 提示**——那不是业务规则，是「别让用户以为搬成功了」。
   */
  onSkillMove?: (move: {
    skillId: string
    fromStage: string
    toStage: string
    /** 落在这个技能之前/之后；null = 落到该列末尾。 */
    refSkillId: string | null
    after: boolean
  }) => void
  /**
   * 设/清 depends_on（P2 补丁 v2 ②）。**不传 = 不给依赖入口**；`readonly === true` 时同样不给。
   * `prevDep` 定位「动的是哪一条」——多依赖时缺了它就只能整条覆写 = 静默丢数据（文件头口径 ③）：
   *   · dep !== null && prevDep === null → 新增一条依赖
   *   · dep !== null && prevDep !== null → 把 prevDep 那条改成 dep
   *   · dep === null && prevDep !== null → 清掉 prevDep 那条
   */
  onSkillDep?: (stageId: string, skillId: string, dep: string | null, prevDep: string | null) => void
  /**
   * 加技能到某列（P4）：从 registry 候选池选一个。**不传 = 不给「+ 技能」入口**；
   * `readonly === true` 时同样不给（default 的强制技能加删走 P1 的 mandatory 面，见文件头 P4 口径 ③）。
   *
   * 只发「哪一列、加哪个 id」：追进 step.skills 的 WbSkillRef 怎么造（缺省无 depends_on）、
   * 目标列已有同名时怎么 no-op，全在宿主（同 onSkillMove 的既定分工）。候选池已排除本列已有，
   * 故正常路径下不会重复加。
   */
  onSkillAdd?: (stageId: string, skillId: string) => void
  /** 打开该阶段的完整 Skill 编排器；依赖、串并行与拖拽都在同一处完成。 */
  onOpenSkillEditor?: (stageId: string) => void
  /**
   * 删技能（P4）。**不传 = 不给删除入口**；`readonly === true` 时同样不给。
   * **依赖级联清理归宿主**（清掉别的技能里指向被删技能的 depends_on，照 SkillChain.tsx:301-317）
   * ——同 P1 删阶段的边重连分工，本组件碰都不碰（见文件头 P4）。
   */
  onSkillRemove?: (stageId: string, skillId: string) => void
  /**
   * 技能候选池（P4，宿主投喂 GET /api/skills/registry 的结果——本组件不认识 fetch，同文件头 P1）。
   *
   * `null`（在拉/拉失败）与 `undefined`（宿主不描述这个数据面）**同等对待**：都 = 此刻没有候选池
   * → 「+ 技能」**禁用 + 说明**，不谎报可加（契约 §2 诚实门，见文件头 P4 口径 ①）。
   * 另用作「未装」徽章的查询面：未就绪 → 全部「不可判」→ 一个徽章都不显示（保守，见口径 ④）。
   */
  skillRegistry?: WbSkillEntry[] | null
  /**
   * 产出非空 guard 开关（P4，每列一个）。**不传 = 不给该开关**；`readonly === true` 时同样不给；
   * `BoardLane.nonemptyGuard === undefined`（数据面不描述）时亦不给。
   * 增删 { type:'nonempty-output' }（并保留其余 guard）是宿主的活——照 StepEditor.tsx:71-78。
   */
  onLaneGuard?: (stageId: string, nonempty: boolean) => void
  /**
   * 阶段列拖动重排（P2）。**不传 = 不给列拖手柄**；`readonly === true` 时同样不给
   * （default 的阶段结构由运行时 review_phases / transition-table 硬编码，无写端点）。
   * 转换边的线性重连是宿主的活（reorderStagesInDef），本组件碰都不碰——同 P1 删阶段口径 ③。
   */
  onStageReorder?: (fromId: string, toId: string, after: boolean) => void
  /**
   * Hook 数据面（P3，per-root，**与 workflow 无关**——hooks.json 是运行时配置，不属于 def 草稿，
   * 故 default 只读态下本区照常可切，与 readonly / canEdit 全线无关，见 HookTimeline.tsx:26-29）。
   *
   * **不传 = Hook 区保持 P0 的一行折叠摘要、不可展开**（诚实占位：没有 hook 元数据就没有卡可画，
   * 展开一个空壳等于谎报「本阶段没有 hook」——同 BoardLane.skills/hooksCount 的既定纪律）。
   * 类型直接复用 HookTimeline 导出的 HooksConfigState（宿主的 useHooksConfig 返回值原样透传），
   * 不另造一套：阶段卡 hooksCount、sheet 里的时序线、本区三处吃的必须是同一份矩阵。
   *
   * 注：这个 prop **不破坏「本组件不认识 fetch」**（文件头 P1）——它是宿主持有的状态对象，
   * 写回走它自带的 toggle 闭包（HookTimeline 的 useHooksConfig 里 POST + 乐观更新 + 回滚）。
   * 本组件只转发「哪个 hook、哪个阶段、开还是关」，零端点知识。
   */
  hooks?: HooksConfigState
  /** 看板级工具条的额外内容（P1 用于放 track 选择器）。不传则不渲染工具条。 */
  toolbarSlot?: ReactNode
}

/**
 * 时序线固定四时机（P3）：列序 = 会话生命周期序；**空组也画节点**——时序线是解释模型，
 * 不随数据缺列（逐字对齐 HookTimeline.tsx:32-33 的同名常量）。
 *
 * 为什么是重声明而不是 import：HookTimeline 没 export 它，而本轮契约的「严禁」清单里就有
 * HookTimeline.tsx——加个 export 也是改它。LOCKED_IDS 那边已 export 故直接 import（真相源唯一）。
 * 两处必须同序，改一处请连同另一处改。
 */
export const EVENT_ORDER: readonly WbHookEvent[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']

/** 拖动中的载荷。kind 把「拖列」与「拖技能卡」分流——两者的落点判定与目标完全不同。 */
export type DragPayload = { kind: 'lane'; stage: string } | { kind: 'skill'; stage: string; skill: string }

/**
 * 当前落点提示。`into` = 落到该列技能区的末尾（空列/末尾空白处），对应 refSkillId=null。
 * 同一时刻只有一个落点（拖拽本来就只有一个光标），故用单值而非集合。
 */
export type DropHint =
  | { kind: 'lane'; stage: string; after: boolean }
  | { kind: 'skill'; stage: string; skill: string; after: boolean }
  | { kind: 'into'; stage: string }

/**
 * 全名拆分：`superpowers:tdd` → 前缀 `superpowers:` + 本体 `tdd`。
 * 定稿核心 ①：前缀不砍、不省略，只在渲染时弱化配色——所以本函数返回的两段拼回去必须
 * 逐字等于入参（技能卡名字节点的 textContent 全等断言依赖这一点）。
 */
export function splitName(id: string): { ns: string; base: string } {
  const ix = id.lastIndexOf(':')
  return ix >= 0 ? { ns: id.slice(0, ix + 1), base: id.slice(ix + 1) } : { ns: '', base: id }
}

/**
 * 产出字段名校验（P1）：与 StepEditor.tsx:43 **同一条规则**（往上追是 kernel validate.ts 的
 * IDENT_RE / server 路由层 name 校验同一条线；G16：serialize 原样写出、parse 用 (\S+) 读回，
 * 字符集越界 =「保存成功、下次打不开」，客户端先挡一道）。
 * 刻意照抄常量而不是跨组件 import 一个私有 const，也刻意不另立标准：画布与编辑卡改的是同一个
 * outputs 面，两处规则一旦分叉就会出现「画布加得进、编辑卡打不开」这种自相矛盾的行为。
 */
export const FIELD_RE = /^[a-zA-Z0-9_-]+$/

// ── 徽章原子类合集（demo .minibadge/.tag 等值搬运；字号 ≥11.5px 是契约 §0.2 下限）──
export const BADGE_BASE = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] font-extrabold whitespace-nowrap'
export const BADGE_LOCK = 'border-border-2 bg-fill text-text-3'
// 区头右侧小徽章：11.5px（demo .minibadge）——比泳道头徽章再小半档，但仍在契约下限上。
export const MINI_BASE = 'inline-flex items-center rounded-full border px-2 py-0.5 text-[11.5px] font-extrabold whitespace-nowrap'
export const MINI_RW = 'border-accent-b bg-accent-t text-accent-d'
export const MINI_RO = 'border-border-2 bg-fill-2 text-text-3'
export const ZONE_TITLE = 'text-[13px] font-[750] whitespace-nowrap text-text-2'

// ── P1 编辑控件原子类 ──
// 门开关：StepEditor.tsx:51-52 的 SWITCH **等值搬运**（同一 app 同一控件词汇——那边是模块私有
// const，跨组件 import 私有实现不合适，故照抄；改这里请连同 StepEditor 一起改）。
export const SWITCH =
  "relative h-5 w-[34px] flex-none cursor-pointer rounded-full border border-border-2 bg-fill-2 transition-colors after:absolute after:top-0.5 after:left-0.5 after:h-3.5 after:w-3.5 after:rounded-full after:bg-card after:shadow-md after:transition-transform after:content-[''] aria-checked:border-(--accent) aria-checked:bg-(--accent) aria-checked:after:translate-x-3.5 disabled:cursor-not-allowed disabled:opacity-55"
// 就地编辑输入框共用的边框/焦点环（StepEditor INPUT 同款焦点词汇；**刻意不设宽度类**——
// 宽度由原生 size 按内容算，见文件头硬约束 ①）。
export const INPUT_BASE =
  'flex-none rounded-lg border border-border bg-card text-text transition-[border-color,box-shadow] hover:border-border-2 focus:border-(--accent) focus:ring-[3px] focus:ring-(--ring-blue) focus:outline-none'
// 产出 chip 上的 ×（StepEditor.tsx:186 的移除钮同款）
export const OUT_X =
  '-mr-[3px] inline-grid h-4 w-4 flex-none cursor-pointer place-items-center rounded-[5px] p-0 text-[13px] leading-none text-text-3 transition-colors hover:bg-red-t hover:text-red-d'
// 「+ 添加」产出（demo .outs .add 等值搬运）
export const OUT_ADD =
  'cursor-pointer rounded-lg border-[1.5px] border-dashed border-border-2 px-2.5 py-1 text-[12.5px] font-bold whitespace-nowrap text-text-3 transition-colors hover:border-accent-b hover:text-accent-d'
// 泳道头的低调删除入口（demo .ecard .rm 等值搬运）
export const LANE_RM =
  'inline-grid h-[22px] w-[22px] flex-none cursor-pointer place-items-center rounded-md p-0 text-[15px] leading-none text-text-3 transition-colors hover:bg-red-t hover:text-red-d'
// 确认弹窗动作条（WorkbenchView 的 BTN_GHOST/BTN_DANGER 同款词汇）
export const BTN_GHOST =
  'cursor-pointer rounded-md border border-border bg-transparent px-4 py-2 text-[12.5px] font-semibold text-text-2 transition-colors hover:border-text-3 hover:text-text'
export const BTN_DANGER =
  'cursor-pointer rounded-md border border-red-b bg-transparent px-4 py-2 text-[12.5px] font-bold text-red-d transition-colors hover:bg-red-t'

// ── P2 拖拽/依赖原子类（demo .grip/.g/.depchip/.depadd 等值搬运）──
/** 阶段列拖手柄（demo .lane-head .grip）。 */
export const GRIP_LANE =
  'flex-none cursor-grab rounded-[5px] p-0.5 text-[16px] leading-none text-text-3 select-none transition-colors hover:bg-fill hover:text-text-2 active:cursor-grabbing'
/** 技能卡拖手柄（demo .ecard .g）。 */
export const GRIP_SK =
  'flex-none cursor-grab rounded-[5px] text-[15px] leading-none text-text-3 select-none transition-colors hover:text-text-2 active:cursor-grabbing'
/** 依赖 chip（demo .depchip）。字号 12px 在契约 §0.2 徽章下限（11.5px）之上。 */
export const DEP_CHIP =
  'inline-flex flex-none cursor-pointer items-center gap-1 rounded-[7px] border border-purple-b bg-purple-t px-2 py-[3px] font-mono text-[12px] font-[650] whitespace-nowrap text-purple-d transition-colors hover:border-purple-d'
/**
 * 「⟼ 设依赖」虚线钮（demo .depadd）：hover 才显（opacity 0 → .9），避免无依赖的卡上常驻一个弱钮。
 * `focus-visible:opacity-100` 是**必须的补丁而非装饰**：opacity:0 的按钮仍可被 Tab 聚焦，
 * 只给 hover 会让键盘用户聚焦到一个看不见的控件上（demo 是鼠标演示，没管这条）。
 */
export const DEP_ADD =
  'flex-none cursor-pointer rounded-[7px] border border-dashed border-border-2 bg-transparent px-2.5 py-[3px] text-[12px] leading-[1.4] font-semibold whitespace-nowrap text-text-3 opacity-0 transition-opacity group-hover/sk:opacity-90 hover:border-purple-b hover:text-purple-d focus-visible:opacity-100'
/** 依赖 popover 里的候选项/清除项（demo .pop .item）。P4 的技能候选项复用它（同一套浮层词汇）。 */
export const DEP_OPT =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-left text-[12.5px] font-semibold text-text-2 transition-colors hover:bg-fill hover:text-text'

// ── P4 加/删技能 + guard 原子类（demo .addcard/.pop/.ecard .rm 等值搬运）──
/**
 * 「+ 技能」加卡钮（demo .addcard）：整列宽的虚线卡，坐在技能卡列表下方 = 「往这一列末尾加一张卡」
 * 的空间隐喻。禁用态（registry 未就绪）保留控件 + 说明，见文件头 P4 口径 ①——
 * 故 hover 变体必须 `enabled:` 打头，否则禁用的钮 hover 仍变紫，读作「可点」。
 */
export const SK_ADD =
  'w-full cursor-pointer rounded-[11px] border-[1.5px] border-dashed border-border-2 bg-transparent p-[9px] text-[13px] font-bold text-text-3 transition-colors enabled:hover:border-purple-b enabled:hover:text-purple-d disabled:cursor-not-allowed disabled:opacity-55'
/**
 * 技能候选 popover（demo .pop）。**w-max**：宽度按最长技能全名撑开，绝不截断（同依赖 popover）。
 * max-h + overflow-y-auto 是 demo 同款（registry 可能几十条，浮层不该顶到视口外）——**纵向**滚动
 * 不碰名字：横向宽度已由 w-max 保证放得下，名字一个字都不会被切（硬约束 ①）。
 */
export const SK_POP =
  'absolute top-[calc(100%+6px)] left-0 z-[7] max-h-[340px] w-max min-w-[280px] overflow-y-auto rounded-[11px] border border-border bg-card p-1.5 text-left shadow-md'
/**
 * 「未装」徽章（demo .inst.no 的琥珀语义 = 红绿 color-mix 派生家族，同 HK_LOOP 的既有表达）。
 * 11.5px = 契约 §0.2 徽章下限。零截断：nowrap + flex-none。
 */
export const SK_UNINST =
  'inline-flex flex-none items-center rounded-full border border-amber-b bg-amber-t px-1.5 py-px text-[11.5px] font-bold whitespace-nowrap text-amber-d'
/** 技能卡上的移除 ×（demo .ecard .rm；与产出 chip 的 OUT_X 同款词汇，尺寸随卡放大一档）。 */
export const SK_RM =
  'inline-grid h-[22px] w-[22px] flex-none cursor-pointer place-items-center rounded-md p-0 text-[15px] leading-none text-text-3 transition-colors hover:bg-red-t hover:text-red-d'
/**
 * guard 开关的标签。**可折行的散文**（「产出非空方可推进」/ 英文更长）→ 设 max-w 免得撑爆列宽
 * （文件头 P3 口径 ④）。它是控件标签不是名字，折行不丢字，与「名字被截断」是两回事。
 */
export const GUARD_LABEL = 'max-w-[240px] text-[13px] font-semibold text-text'
/** guard 的一句话说明（StepEditor 的 NOTE 同款读数）。同为散文 → 同样设 max-w。 */
export const GUARD_NOTE = 'mt-2 max-w-[280px] text-[12px] leading-[1.55] text-text-3'
/** registry 未就绪的说明（禁用「+ 技能」旁）。同为散文 → 同样设 max-w。 */
export const SK_NOREG = 'mt-1.5 max-w-[280px] text-[12px] leading-[1.55] text-text-3'

// ── P3 Hook 卡原子类（demo .hookzone/.hkcard/.timing 等值搬运；**唯独 .g 拖手柄不搬**，见文件头 P3 口径 ①）──
/**
 * Hook 摘要行（demo .hookzone .sumrow）。可展开时是 <button>、否则是 <div>——同一套外观，
 * 故 hover 描边只在可展开时才给（`data-*` 承载见用处）：不可展开的行 hover 变色 = 暗示它可点。
 */
export const HK_SUMROW = 'flex w-full items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-2 text-left'
export const HK_SUMROW_BTN = 'cursor-pointer transition-colors hover:border-accent-b'
/** 折叠三角（demo .sumrow .caret）：展开时转 90°。状态走 data-open，不拼条件类名（硬约束 ②）。 */
export const HK_CARET =
  'inline-block flex-none text-[11.5px] leading-none text-text-3 transition-transform duration-200 data-[open]:rotate-90'
/**
 * 时机分组（demo .timing）：::before = 节点圆点、::after = 连到下一节点的竖轨。
 * 竖轨是 border 中性色的**时序连接线**，不是卡上的彩色 side-stripe（§0.4 禁的是后者）——
 * 它画在卡片区之外的左槽里，与 P0 的列间连接件是同一类物件。末组不画轨（demo .timing:last-of-type）。
 */
export const HK_GROUP =
  "relative pt-0.5 pb-1.5 pl-5 before:absolute before:top-[5px] before:left-0 before:z-[1] before:h-3 before:w-3 before:rounded-full before:border-[2.5px] before:border-(--accent) before:bg-card before:content-[''] after:absolute after:top-[17px] after:bottom-0 after:left-[5px] after:w-0.5 after:bg-border after:content-[''] last:after:hidden"
/** 时机人话名（demo .timing .tname）。零截断：nowrap 且不设 max-w。 */
export const HK_TNAME = 'flex-none text-[13px] font-[750] whitespace-nowrap text-text-2'
/** 「每轮」chip（demo .timing .tname .loop，琥珀家族）。11.5px = 契约 §0.2 徽章下限。 */
export const HK_LOOP =
  'inline-flex flex-none items-center rounded-full border border-amber-b bg-amber-t px-1.5 py-px text-[11.5px] font-bold whitespace-nowrap text-amber-d'
/**
 * Hook 卡（demo .ecard.hkcard）：**与技能卡同一套卡片语言**——同圆角 [11px]、同 border/bg-card、
 * 同内边距 px-2.5 py-2.5、同 shadow-sm、同 14.5px 卡名（契约 §2）。差别只在色相家族：
 * hook 走 accent（蓝）、技能走 purple。三档态承载在 data-state（同 HookTimeline 的既定属性名）。
 */
export const HK_CARD =
  'rounded-[11px] border border-border bg-card px-2.5 py-2.5 shadow-sm transition-[border-color,box-shadow,opacity] duration-150 data-[state=configurable]:hover:border-accent-b data-[state=locked]:bg-fill-2 data-[state=locked]:shadow-none data-[state=pending]:bg-fill-2 data-[state=pending]:opacity-65 data-[state=pending]:shadow-none'
/** 卡首标记圆（demo .hkcard .mk）：与技能卡的序号圆同尺寸（22px），但 hook 无序号故放态记号。 */
export const HK_MK = 'grid h-[22px] w-[22px] flex-none place-items-center rounded-full border text-[12px] leading-none'
export const HK_MK_RW = 'border-accent-b bg-accent-t text-accent-d'
export const HK_MK_RO = 'border-border-2 bg-fill text-text-3'
/**
 * Hook 人话名（demo .hkcard .nm）：与技能卡名同字号/字重。**刻意不 mono**——技能名是 id
 * （mono 有意义），hook 这里显示的是人话名（「注入工作流上下文」）。零截断：nowrap、无 max-w、
 * flex-none 且不设 min-w-0，宽度照常参与 max-content 把列撑开（硬约束 ①）。
 * 注：HookTimeline 那边给名字挂了 truncate，那正是本轮要消灭的写法，移植时刻意不带过来。
 */
export const HK_NAME = 'flex-none text-[14.5px] font-[650] whitespace-nowrap text-text'
/**
 * Hook 一句话描述。**可折行的散文** → 设 max-w 免得撑爆列宽（文件头 P3 口径 ④：
 * 10px 卡内距 + 30px 缩进 + 260px = 300px < 340px 列宽下限 → 描述永不参与撑列）。
 * 折行不丢字，与「名字被截断」不是一回事。pl 与 demo .ecard .r2 同为 30px（22px 圆 + 8px gap）。
 */
export const HK_DESC = 'mt-1.5 max-w-[260px] pl-[30px] text-[12.5px] leading-[1.5] text-text-3'
/** 落点的前/后判定：以元素中线为界（demo 同款）。纵向列表用 Y，横向（阶段列）用 X。 */
export function isAfterY(e: { clientY: number }, el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return e.clientY > r.top + r.height / 2
}
export function isAfterX(e: { clientX: number }, el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return e.clientX > r.left + r.width / 2
}

/**
 * dragstart 的 dataTransfer 装配。三处防御都不是摆设：
 *   · `dataTransfer` 缺失 —— jsdom 里 fireEvent.dragStart 不带 init 时它就是 undefined
 *     （既有先例 SkillTransferModal.test.tsx:18 手工造的假 DataTransfer 也只有 set/getData）；
 *   · `setData` 抛 —— Safari 在部分 dragstart 上会抛（demo 同款 try/catch）。payload 只是给外部
 *     放置区的礼节性数据，本组件的落位靠自己的 drag 状态，丢了不影响功能；
 *   · `setDragImage` 缺失 —— 同上 jsdom。有它时**必须**传整卡/整列做拖影：只有手柄 draggable，
 *     默认拖影就只剩那个 ⠿ 字形，名字整个不见（契约 §0.1 拖拽态零截断，见文件头口径 ④）。
 */
export function primeDrag(e: { dataTransfer: DataTransfer | null }, payload: string, image: HTMLElement): void {
  const dt = e.dataTransfer
  if (dt === null || dt === undefined) return
  dt.effectAllowed = 'move'
  try {
    dt.setData('text/plain', payload)
  } catch {
    // Safari/jsdom：payload 非功能依赖，静默略过即可。
  }
  if (typeof dt.setDragImage === 'function') dt.setDragImage(image, 24, 18)
}
