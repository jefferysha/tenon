# Research: Dashboard visual component map

- Query: 审视 Dashboard 的色彩 token、布局入口、共用组件与 Progress/Workbench 画布，为视觉系统重构定位可复用地基、散落样式和验证路径。
- Scope: internal
- Date: 2026-09-05

## Findings

### 1. 样式与主题地基

- `packages/dashboard-app/src/index.css:20-43` 是运行时 token 真相源，覆盖底色、surface、border、文字层级、accent/green/red/purple/amber 状态色、按钮、scrim、三档阴影、圆角与字体；`:root`、系统暗色媒体查询和显式 `data-theme` 在 `:root[data-theme="light"]/:root[data-theme="dark"]` 重复维护同一组值（`index.css:45-103`）。
- Tailwind/shadcn 语义映射集中在 `index.css:110-189`，其中 `--color-accent` 被刻意映射为 `var(--fill)`（交互 hover），产品蓝只能通过 `bg-(--accent)`/`text-(--accent)` 或 `accent-*` 派生 token 使用（`index.css:124-129,168-173`）。重构时需要先决定是否保留这个与直觉不同的 accent 命名，避免同时出现两套蓝色语义。
- 可访问性基础已有 `:focus-visible` 全局 2px outline 和 `prefers-reduced-motion` 归零规则（`index.css:196-221`）。组件级动画也要求显式 `motion-reduce`，现有契约在 `designSystem.test.tsx:40-51` 检查。
- 产品 UX 设计要求控制台底板/蓝色当前上下文/绿色放行/琥珀等待/红色阻断，并以路线条和“主任务 8/12 + inspector 4/12”承载层级（`docs/ux/2026-07-19-full-product-journey-and-orchestration-design.md` 第 2、3 节）。当前 token 已基本覆盖这些语义，但字体仍是系统 sans/mono（`index.css:42-43`），没有落地文档中提议的 Barlow Condensed / IBM Plex 字体；需在重构中明确“引入字体”还是保守保留系统回退。
- 发现命名漂移：token 只有 `--amb-d/--amb-t/--amb-b` 和 `--color-*` 的 `amb-*`（`index.css:29,142-144`），但多个页面写了 `bg-amber-t`、`border-amber-b`、`text-amber-d`，例如 `MachineView.tsx:331`、`HostPlanPreview.tsx:97`、`VerificationEvidenceComposer.tsx:289-299`。`dist` CSS 中可检索到 `amb-*` 而没有 `amber-*`，这些页面的琥珀背景/边框/文字可能没有生成规则；这是 P0 级视觉一致性与状态可读性风险，应统一命名并加 token/回归检查。

### 2. 共用 UI 组件与实际采用率

- vendored shadcn primitives 位于 `src/components/ui`：Button（`button.tsx:7-64`）、Card（`card.tsx:5-91`）、Select（`select.tsx:9-190`）、Input（`input.tsx:7-22`）、Dialog（`dialog.tsx:10-158`）、Tabs、Badge、Switch、Popover、Dropdown 等。Button 具备 default/destructive/outline/secondary/ghost/link 六种变体和 xs–lg/icon 尺寸，统一 focus ring、disabled 与 reduced motion（`button.tsx:7-31`）。
- 实际共用程度很低：按源码统计，Dashboard 约 280 个 `<button>` 分布在 105 个 TSX 文件，`Button` 只在约 14 个文件中导入；约 33 个原生 `<select>` 分布在 17 个文件，而 `Select` primitive 主要只在 `RelatedSessionsSection`、`SkillChain` 等少数场景；Input 也仅少量使用。视觉重构若只改 primitive，绝大多数页面不会同步，需先定义迁移边界或建立页面层的 class recipe。
- Card 默认 `rounded-xl border bg-card py-6 shadow-sm` 且 Header/Content 自带 `px-6`（`card.tsx:5-79`）。大量业务卡片绕过 Card，直接用 `rounded-lg/xl/2xl/[22px] border bg-card/bg-fill p-*`，形成多个圆角、内距和阴影层级；建议先确定“对象卡/分组容器/状态行”三种明确层级，再将 primitive 默认值与业务 recipe 对齐。
- Select primitive trigger 是 `w-fit`、`rounded-md`、`h-8/9`（`select.tsx:27-49`），而页面原生 select 通常自行设 `rounded-xl h-10 min-w-*`（例如 `ProgressToolbar.tsx:112-125`）或复用工作台 `h-[34px] rounded-[9px]`（`loopCardModel.tsx:25-27`）。这会造成选择框高度、箭头、focus ring、暗色背景不同；改造应提供一个适合 Dashboard filter/editor 的 `Select` 尺寸/宽度 recipe，并迁移高频入口。
- `components/ui/dialog.tsx` 是 Radix Dialog 样式（overlay `bg-black/50`、content `rounded-lg p-6 max-w-lg`，`dialog.tsx:34-79`）；`shared/Dialog.tsx` 是另一套自定义 portal/focus trap/workspace 骨架，default `w-[min(420px,92%)] rounded-lg`，workspace `rounded-[24px] max-h-[94vh]`（`shared/Dialog.tsx:240-306`）。Progress 抽屉又是独立 fixed aside，而不是 Dialog（`ProgressDrawer.tsx:41-62`）。需在视觉改造中明确何时使用 confirm dialog、workspace modal、drawer/sheet，并统一 overlay/surface/close button 规格。
- 现有设计契约仅断言 primitive 有 reduced-motion 和不使用 `transition-all`（`designSystem.test.tsx:26-51`），没有检查 token 命名完整性、组件采用率、跨页面圆角/高度、focus 对比度或状态颜色覆盖。

### 3. App shell 与页面布局入口

- App 外壳是 `Nav` + 内容列：`App.tsx:307-370` 使用 `min-h-screen bg-bg`，左侧 Nav 固定 rail，内容 main 全宽 `px-6 pb-6 pt-3`，移动端 `mobile:px-4` 并为底部导航预留空间。当前页面自身仍普遍限制 `max-w-[1088px]`（Projects `ProjectsView.tsx:249-258`、Workbench `WorkbenchView.tsx:482-518`、Machine `MachineView.tsx:292`），Host Plan 为 `max-w-[1120px]`，Solution/Overview 为 `max-w-[1240px]`，导致页面横向节奏不统一。
- `PageHeader` 是唯一共享页头，但只提供 border-bottom、title/description/status/actions 排列（`shared/PageHeader.tsx:1-66`）。Progress 另在 `ProgressToolbar` 传 `mb-4`，Workbench 在自身传 `mb-5`，各页的页头与工具条间距仍由调用方决定；视觉系统可保留组件边界，同时定义 page frame、header spacing 与 action priority 的 token。
- Nav 使用 88px rail、移动 ≤720px 转底部导航（`shell/Nav.tsx:86-92`），rail item 固定 72px、多个状态 badge 和 settings 浮层（`Nav.tsx:68-72,125-181`）。当前工作树里 Nav 正在被另一改动压缩到 Projects/Progress/Workbench 三个日常入口并把低频项放进 settings；这属于未提交并行变更，视觉任务必须基于最新合并结果重新校验移动底栏、settings 浮层和 badge 布局。

### 4. Progress 画布/抽屉

- `WorkflowCanvas` 把每个 workflow 渲染为大卡：`min-h-[420px] rounded-[22px] border bg-card p-5`（`WorkflowCanvas.tsx:157-164`），内部阶段轨道和 change 卡按 `n * 232px` 最小宽度生成横向滚动区（`WorkflowCanvas.tsx:180-193`），change 卡 `min-h-[102px] rounded-xl border bg-card p-3 shadow-xs`（`WorkflowCanvas.tsx:253-286`）。这解释了桌面/窄屏上画布纵向空白和横向 pan 成本；当前工作树另有未提交的 mobile 单列改动（WorkflowCanvas diff 与 `progress.css:515-536`），会与视觉重构的画布策略冲突，需先整合。
- 画布状态色由 `STATE_META` chip 和 `DOT_TONE_CLS` 控制，running/failed/queued/gate/agent 已映射到 token（`WorkflowCanvas.tsx:13-18,69-79`），但状态点还有 `shadow-[...]` 任意值和阶段线 `bg-(--accent)`；应把“状态语义色”和“装饰强调色”分离，避免色块过多。
- `progress.css` 同时承载动画、命令摘要、pipeline stages、画布覆写、sheet tabs 等 512 行规则（`progress.css:57-420,429-512`）。Progress 组件 Tailwind 与 CSS 选择器双写（例如 canvas 根类与 `[data-testid^=...]` 覆写），优先级较难推断。建议建立 `data-ui`/语义类 recipe，减少依赖 testid 选择器；保留 `data-*` 仅作为状态和测试锚点。
- `ProgressDrawer` 是固定 560px、`max-w-[94vw]` 的右侧 sheet，scrim 独立 fixed 层，Tab 列表在内容后通过 `order:-1` 显示（`ProgressDrawer.tsx:41-75`、`progress.css:429-471`）。移动端缺少 full-screen/safe-area 专用规则；视觉验收应覆盖 375/768/1440、键盘 focus、scroll lock、scrim click 和 surface 切换。

### 5. Workbench 画布/编辑器

- Workbench page frame 为 `max-w-[1088px]`（`WorkbenchView.tsx:482-518`），首屏顺序是 PageHeader → WorkbenchHeader controls → WorkflowPolicyEditor → WorkflowPolicyRuntimeSummary → ExecutionTimelineComposer（`WorkbenchView.tsx:482-549`），配置、运行摘要、治理和编辑同时出现，页面高度很大；用户体验重构应保留高频决策区，把高级策略/诊断移入按需 inspector。
- `OrchestrationBoard` 使用横向 overflow、`grid-auto-columns:minmax(320px,max-content)`、gap-x-8（`OrchestrationBoard.tsx:161-168`），每个 stage lane 是 `rounded-[22px] border bg-card`，自定义任意 rgba 阴影并按 running/current 状态叠加绿/蓝边和 ring（`OrchestrationBoard.tsx:189-223`）。加阶段按钮另有 `min-h-[190px] rounded-2xl border-dashed`（`OrchestrationBoard.tsx:313-319`）；这套大列卡适合编辑，但需要明确移动端 scroll affordance、选中/只读/dragging 层级及 shadow token 化。
- `StepperRail` 仍是另一种阶段卡（`StepperRail.tsx:140-214`）：min-width 178px、rounded-[13px]、green running dot、gate red diamond；Workbench 同时存在 StepperRail、OrchestrationBoard、TimelineStageStrip 等阶段表达，需决定保留哪一个为唯一主脊，避免色块/连线重复。
- 工作台三卡（Loop/Automation/Secrets）通过 `WB_TW` class 字典共享输入、section、状态和按钮微调（`workbench/loopCardModel.tsx:10-54`），但该词典明确“不入 components/ui”，仍与 primitive Button/Card 并行。它是迁移为业务 recipe 的最佳切入点；需同步 `AutomationCard.tsx`、`SecretsCard.tsx`、`LoopCard.tsx` 的状态、空态和 advanced 折叠。
- `WorkbenchHeader` 仍有大量 raw button 与自定义 `BTN_*` classes，workflow selector、保存状态和 governance 操作挤在一行（`WorkbenchHeader.tsx:93-133`）。按钮层级、危险色和 disabled/dirty 状态应纳入统一按钮矩阵；当前 raw `<button>` 数量高，不能假定 primitive 改动会覆盖这些入口。

### 6. 散落间距/颜色/状态样式风险

- 常见圆角同时有 `rounded-md`、`rounded-lg`、`rounded-xl`、`rounded-2xl`、`rounded-[22px]`、`rounded-[24px]`；常见控件高度同时有 24/26/32/34/36/40/44/48px；间距既用 Tailwind scale 又用 `[3px]`、`[5px]`、`[11px]`、`[18px]` 等任意值。视觉改造应先建立 spacing/radius/control-size contract，再批量迁移高频组件。
- 状态颜色同时出现 `text-red`（强色）、`text-red-d`（深色语义）、`text-green-d`、`text-amb-d`、`text-amber-d`、`text-accent-d`，且部分页面把 success green 用于按钮/选择态，部分页面遵守“accent 只做动作、green 只做结果”（`index.css:32-34`）。需要提供状态语义表并用 lint/test 防止新类名漂移。
- 任意值阴影集中在 `OrchestrationBoard.tsx:191`、`WorkflowCanvas.tsx:14-16`、`LaneMandatorySkills.tsx` 等；应优先映射到 `--shadow-*`、`--ring-*` 或组件 elevation token，减少 dark mode 下不可控的对比差异。

## Reusable component map

| Concern | Existing source | Reuse / migration recommendation |
| --- | --- | --- |
| Theme tokens | `src/index.css:20-189` | 保留单一 token 真相源；修正 amb/amber 命名，补充 surface/elevation/control-size 语义；检查系统暗色与显式主题等值。 |
| Page frame/header | `src/App.tsx:367-372`, `src/shared/PageHeader.tsx` | 定义统一 page frame 宽度、侧栏间距、页头 action 栈；各页面只传语义 props。 |
| Buttons | `src/components/ui/button.tsx`, raw `button` callers | 扩展 Button recipe（primary/secondary/quiet/danger/icon），然后迁移高频 CTA；raw buttons 需按页面分批，保留语义 testids。 |
| Inputs/selects | `src/components/ui/input.tsx`, `select.tsx`, native controls | 建立 32/36/40 三档控件和 field label/error recipe；优先 Progress filter、Workbench editor、AFK forms。 |
| Cards/surfaces | `src/components/ui/card.tsx`, `workbench/loopCardModel.tsx:15-54` | 把 Card 基础与业务 pane 分成 surface/card/section 三层，避免卡内卡和多套 p/radius。 |
| Dialog/sheet | `src/components/ui/dialog.tsx`, `src/shared/Dialog.tsx`, `src/progress/ProgressDrawer.tsx` | 统一 scrim、surface elevation、close affordance、mobile sheet；保留 shared/Dialog 的 focus trap 逻辑。 |
| Progress canvas | `progress/WorkflowCanvas.tsx`, `progress/progress.css`, `progress/ProgressDrawer.tsx` | 用语义 stage track/task list recipe；移动端优先可读任务列表，桌面保留主脊；抽屉只承载 detail。 |
| Workbench canvas | `workbench/OrchestrationBoard.tsx`, `StepperRail.tsx`, `TimelineStageStrip.tsx`, `workbench.css` | 明确唯一主画布，拆出 stage/lane/skill/drop-state tokens；drag/drop 状态继续由 data-* 承载。 |

## Suggested validation path

1. 先运行 token/contrast/design-system 单测，并增加 `amb-*`/`amber-*` 生成规则、颜色命名与组件 recipe 的静态断言；验证 light、explicit dark、system dark 三种主题。
2. 对 Progress、Workbench、Projects、AFK、Machine、Host Plan、Overview 在 375/768/1200/1440 宽度截图，检查无溢出、卡片层级、canvas pan affordance、drawer/sheet safe area。
3. 使用键盘验证 nav、tabs、select、dialog/drawer、drag/drop fallback 的 focus-visible、Esc、Tab trap、restore focus；开启 `prefers-reduced-motion` 后确认没有 opacity/transform 残留。
4. 交互回归覆盖：Progress filter/select→canvas→drawer surface；Workbench workflow menu→编辑→保存/dirty→dialog；Projects search/empty CTA；AFK operation cards；Machine/HostPlan 状态与琥珀通知。
5. 运行 `npm run typecheck:web`、`npm run test:web`、`git diff --check`；浏览器网络检查同源生产 server，避免把 Vite `/api` 404 当成产品视觉回归。当前工作树已有未提交的 Nav/Progress canvas/HostPlan 修改，实施前需先记录并隔离这些变更，防止视觉任务覆盖并行工作。

## Related specs

- `.trellis/spec/dashboard-app/frontend/index.md`
- `.trellis/spec/guides/index.md`
- `docs/ux/2026-07-19-full-product-journey-and-orchestration-design.md`
- `docs/ux/2026-07-11-config-experience-analysis.md`
- `docs/usage/zh-CN/dashboard-and-local-api.md`

## Caveats / Not Found

- 本次仅做源码静态研究，没有修改 `src/`、测试或 spec 文件，也没有启动浏览器。
- `src/index.css` 注释多次提及 `src/styles.ts` 的 `GLOBAL_CSS`，仓库当前未找到该文件；需确认注释是否过期，避免迁移时误以为存在第二个 token 真相源。
- 工作树包含其他未提交修改（尤其 `Nav.tsx`、`WorkflowCanvas.tsx`、`progress.css`、`HostTargetPlanView.tsx`），本报告按当前文件内容和 diff 识别潜在冲突，不判断这些修改的归属或是否应提交。
- 文档提出的 Barlow/IBM Plex 字体、Route Strip 和 8/12+4/12 inspector 是产品方向，目前代码没有对应统一组件；是否引入新字体或路由结构需在设计任务中拍板。
