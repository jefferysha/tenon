# PRD · 工作流页两栏定稿（第三版）实现

## 背景
用户在四轮方案评审后选定「两栏定稿 · 第三版」（artifact 87d9f480）。三列骨架改为两栏：左栏合并工作流 / 轨道 / 流程，右栏为阶段详情。

## 目标（对应定稿）
- 左栏 300px：工作流名 + ▾（切换工作流）与 ⋯（新建工作流 / 导出 YAML / 删除工作流或恢复内建 / 删除当前轨道）；副行「内建 · 5 轨道」；轨道下划线页签 + 末尾「+」；编号圆点纵向流程：阶段块（名称 + 门禁盾形图标）、连线、右侧虚线回流弧、末尾「添加阶段」；圆点为拖柄可排序。
- 右栏：面包屑 `工作流 › 轨道`，可编辑标题 + `n / N` + 删除；段头一行（标题 + 等宽计数 + 靠右动作）；顺序 输入 → 技能 → 输出 → 门禁。
- 输入表三列等分：文件 · 产出阶段 · 产出技能；输出表两列等分：文件 · 产出技能；表头常显；空态一行。
- 技能：@xyflow/react 画布（点阵底、左右端口、贝塞尔边、缩放控件），节点 = 技能（图标 + 名称 + description），边 = depends_on；点节点看详情。「编辑」打开编辑器：技能库 + 可编辑画布（拖入建节点、拉线建依赖、删边 / 删点）+ 详情；保存写回 skills[].depends_on。
- 门禁三选带图标（无 / 评审盾 / 自动闪电），hover 解释保留。

## 非目标
- 不改 kernel IO 推导规则；不改工作台页。

## 验收
- [ ] 页面为两栏（`workflow-nav` + `stage-editor-pane`），无中栏、无折叠按钮。
- [ ] `wb-wf-switch` 打开工作流列表并可切换；`wb-wf-menu` 含新建 / 导出 / 删除或恢复 / 删除轨道。
- [ ] 轨道页签 `wb-track-<id>`，`wb-track-new`；无 tracks 时不渲染页签行。
- [ ] 流程 `wb-step-<id>` 只含名称与门禁图标；`wb-back-edge-<from>-<to>` 存在；拖拽排序仍走 `onReorder`。
- [ ] 输入表 `io-inputs` 有表头三列，行 `slot-<kind>-<id>` 含阶段与技能；输出表 `io-outputs` 两列。
- [ ] 技能画布 `skill-flow` 节点 `flow-node-<id>` 数与技能数一致，边数 = depends_on 数；编辑器保存后 `setSkills` 得到含 depends_on 的技能数组。
- [ ] `wb-lane-name-<id>` / `wb-lane-name-input-<id>` / `wb-dirty` / `wb-save` 等既有 testid 保留，App 测试不改。
- [ ] typecheck / test:web / check:design-scale / check:comments / build:web 通过。
