# 视觉系统与组件设计

## Token

Primitive 层定义色阶、灰阶、字号、行高、间距、圆角、阴影和动效时长；semantic 层映射 canvas/surface/text/border/accent/status/focus；component 层定义 button/select/card/stage/drawer 的尺寸与状态。组件只能引用 semantic/component token，主题切换只改 semantic 层。

建议基础节奏：4px spacing scale；正文 14–16px、标题使用有限层级；表面采用一层主背景 + 一层抬升表面，避免每块内容都套卡片和阴影。状态色同时配合文字/图标，确保色盲可辨。

## 组件规格

- **Button**：主按钮每上下文一个；secondary/ghost 用于次级动作；危险操作使用 danger + 明确确认；loading 保留宽度并禁用重复提交。
- **Select**：显式 label，支持 placeholder、选中、禁用、错误、键盘上下/回车/Escape；菜单不被容器裁切，移动端触控高度至少 40px。
- **Card**：状态条/徽标只出现一次；动作区固定在卡片尾部；hover 不改变布局，focus-visible 有外轮廓。
- **Stage canvas/list**：首屏使用可折叠阶段行，当前阶段和阻断原因高对比；DAG/完整轨道放详情，可缩放但不强迫主路径横滚。
- **Drawer/Dialog**：明确标题和关闭按钮，ESC 关闭、焦点回收；危险确认显示影响范围与结果；移动端从底部或全屏呈现。
- **Feedback**：空态单一 CTA；错误可重试；异步写操作显示 pending/success/failure，并触发 snapshot/SSE 刷新。

## 响应式

375px：单列、当前阶段、主动作固定可见；768px：两列或抽屉；1440px：任务列 + 辅助列。任何断点不得依赖 min-width 造成水平滚动。prefers-reduced-motion 下只保留必要状态变化。
