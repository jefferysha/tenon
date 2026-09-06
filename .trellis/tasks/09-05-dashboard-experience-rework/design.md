# Dashboard 体验重构设计

## 体验原则

- 首屏回答位置、状态、下一步；细节放入详情抽屉或二级页面。
- 一个上下文只保留一个主动作；危险或写操作明确显示目标、影响范围和结果。
- 视觉层级服务于任务优先级：主表面承载任务，辅助表面承载解释，装饰性色块不与信息竞争。
- 状态颜色表达语义而非装饰，文本和图标同时提供状态含义。
- 桌面允许密度，移动优先保证当前动作、焦点顺序和可返回性。

## 页面骨架

- Projects：可操作项目列表 + “需要我处理”筛选；workspace/repository 作为二级信息。
- Progress：需处理/运行中/等待中任务队列；详情显示阻断原因、证据和下一动作。
- Workbench：Workflow 选择、阶段列表、阶段编辑；策略和诊断折叠。
- Settings/Diagnostics：承载 AFK、Machine、Host Plan、凭证、Traffic、Loop 等低频能力。

## 视觉系统方向

采用三层 token：primitive → semantic → component。语义层至少包含 canvas/background、surface、surface-raised、border、text-primary/secondary/muted、accent、success、warning、danger、focus。组件层为 button、select、card、stage-canvas、drawer 定义尺寸、间距、圆角、边框和状态。

布局使用 4px 基础间距、窄内容列与可伸展任务列；不再使用依赖固定宽度阶段轨道的首屏画布。颜色对比和焦点环以 WCAG AA 为最低目标，动效只用于状态变化和层级过渡，并尊重 reduced-motion。

## 交互状态

所有可操作组件至少定义默认、hover、focus-visible、pressed/selected、disabled、loading、error；异步写操作需要进行中状态、成功后数据刷新、失败可重试。空态必须说明原因并给唯一主 CTA；无搜索结果清除失效选择。抽屉/对话框支持 ESC、显式关闭、焦点陷阱和 aria-controls/labelledby。

## 验证

以 375/768/1440 三个视口进行真实浏览器回归，覆盖导航、筛选、选择框、保存、打开详情、关闭抽屉、复制/重试等主路径；同时运行 typecheck、web tests、生产同源资源/API 检查和 git diff --check。
