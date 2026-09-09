/**
 * 阶段泳道的**数据契约**（原 orchestrationBoardModel.ts）。
 *
 * 历史背景：这两个类型原是 OrchestrationBoard 画布的 props 模型，同文件还带着该画布的
 * 全套 tailwind 样式常量与拖拽工具。OrchestrationBoard 及其子组件（LaneHeader/SkillZone/
 * OutputZone/Popovers/HookBody）从未被任何非测试代码挂载过，已随本轮删除；此处只保留
 * 仍被活树（ExecutionTimelineComposer / TimelineStageStrip / SkillOrchestrationDialog /
 * useWorkbenchBoard / workbenchDefinition）消费的两个类型。
 */

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
