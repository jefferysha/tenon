# 工作流页重设计：track 独占阶段、技能详情、GSAP 拖拽

## Goal

每条 track 从零定义自己的阶段（不再有「通用分支」预设）；任何地方点技能都能看到完整详情（SKILL.md 与目录内全部文件，Markdown 渲染）；工作流页与技能浮层重做视觉层次并体现"流"；阶段可拖拽排序；全部拖拽用 DragOverlay + GSAP Flip，消除卡顿。

## Background

- 上一任务保留了顶层 `steps` 作为兜底分支，default.yaml 里每条 track 又复制了七个阶段，用户判定这是"预设步骤"。
- 技能只在浮层里能预览 SKILL.md 一份文件；右列只读芯片点不开；用户要看整个技能目录。
- 页面被评为"普通、没有层次、看不出工作流"；阶段不能拖动；浮层左挤右空、眼睛被裁、箭头含义不明、拖拽卡顿无动画。

## Requirements

- R1 YAML：`steps` 与 `tracks` 二选一。有 `tracks` 时不得声明顶层 `steps`，每条 track 完整写自己的阶段；change 的 track 不在工作流里 → init / 创建拒绝，运行时解析报错，不兜底。无 `tracks` 的工作流仍是单条 `steps`。
- R2 default.yaml：chat / pm / frontend / backend / free 五条分支，各自阶段独立声明（chat = 只有驱动技能的基础流，排第一，兼作无轨道语境的代表分支）；`required_when` 不再需要。指纹仍覆盖整份定义。
- R3 技能详情：`GET /api/skills/:name/files`（目录树）与 `GET /api/skills/:name/file?path=`（单文件文本，≤256KB，拒绝越界与二进制）。前端统一「技能详情」抽屉：来源 + 文件树 + 选中文件 Markdown / 纯文本渲染；右列芯片、浮层技能名、画布节点点击都打开它。浮层不再需要眼睛图标。
- R4 工作流页视觉：流程图式流水线（主干连接线、节点序号、门禁图标、回流边、选中态抬升）；阶段拖拽排序（dnd-kit sortable + Flip 过渡），去掉上下箭头按钮；右列信息分层（标题区 / 技能 / 输入输出 / 门禁），空态不留大片空白。
- R5 浮层三栏：技能库（窄，来源用图标 + 悬停文字）/ 波次画布（主体；列间显式「→ 串行」连接与「+ 新一步」落区，列内「∥ 并行」标记，节点可拖排）/ 技能详情（点任一技能显示）。
- R6 动效与性能：拖拽只由 `DragOverlay` 承载，源元素半透明占位；列表项 memo，不随指针重渲染；落位 / 排序 / 新增 / 移除用 GSAP Flip 与 timeline；`prefers-reduced-motion` 下关闭位移动画。
- R7 名称、措辞规则不变（label ?? id，无解释性句子）。

## Acceptance Criteria

- [x] AC1 default.yaml 无顶层 `steps`；`tenon init --track backend` 快照阶段技能与改前一致；`--track simple --workflow default` 被拒绝并指出没有该轨道分支。
- [x] AC2 自定义工作流同时写 `steps` 与 `tracks` → 校验报错；只写 `tracks.mobile` → init 成功。
- [x] AC3 点击任意技能打开详情抽屉：文件树含 SKILL.md 与其它文件，点文件切换内容，Markdown 标准渲染；files/file 接口 200 / 404 / 400 有测试。
- [x] AC4 工作流页阶段可拖拽重排并落盘 YAML；浮层拖入 / 拖出 / 换列 / 换序均有位移动画；拖拽期间 React Profiler 下技能库列表不重渲染。
- [x] AC5 门禁全部通过：typecheck:web、test:web、kernel/server/cli vitest、default-workflow-freshness、default-skill-matrix、design-scale、comments、构建；浏览器核对 1440 与 1200 宽。
