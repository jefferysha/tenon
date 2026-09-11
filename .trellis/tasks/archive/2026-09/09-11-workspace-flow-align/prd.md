# PRD · 工作台对齐工作流页 + 技能画布 GSAP 脉冲

## 问题（截图 28 / 29）
1. 技能画布的脉冲不明显（React Flow 的 CSS 虚线滚动）。要 GSAP 驱动、从起点到终点依次传递的脉冲。
2. 工作台右栏还是旧样式：技能是状态标签堆，输入 / 输出平铺太长；左栏项目卡重复显示个数。
3. 筛选行标签「工作流」换行；任务卡状态标签被裁切。任何地方不得换行。

## 目标
- `PulseEdge`：BaseEdge + 沿路径运动的小圆点（GSAP `offset-distance`），边带段序，脉冲按 起点 → 波 → 汇合 → … → 终点 传递后重来；reduced-motion 不动。
- 工作台右栏：技能 = `SkillFlow` 只读 + 节点运行状态（未开始 / 运行中 / 已完成）；输入 / 输出 = `SheetTabs` 切换，一次只显示一张；点文件行右侧抽屉。
- 左栏项目卡只显示路径；不显示任务数。
- 筛选行：标签与芯片不换行，溢出横向滚动；任务卡标题截断、状态标签不裁切；详情标题单行截断。

## 验收
- [ ] `flow-pulse-<edgeId>` 元素存在；边不再使用 `animated`。
- [ ] 工作台详情：`stage-skills` 内有 `skill-flow`，节点 `data-status`；`task-io-tab-inputs / outputs` 切换，`stage-inputs` / `stage-outputs` 只出现当前一张。
- [ ] 项目卡不含「个任务」。
- [ ] web 全部用例、design-scale、comments、build 通过。
