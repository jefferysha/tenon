# PRD · 两栏定稿实测修复

## 问题（用户截图 21 / 22）
1. 技能画布看不出串行 / 并行，也没有箭头：default 产品轨道的技能没有 `depends_on`，三者同属第一波（并行），画出来只是竖着一列。
2. 输出表比输入表少一列「产出阶段」，两表不对齐；「产出技能」措辞应为「来源」。
3. 技能详情：Markdown 排版在窄栏里过大过散（h1 28px）；文件列表只有 SKILL.md（tenon-* 技能目录本来只有这一个文件，需说明）。
4. 编辑器：串并行同样看不出、没有脉冲动画；删除技能后重开编辑器持续重渲染（刷屏）。

## 目标
- 画布加虚拟「起点 / 终点」小圆点：起点 → 第一波每个技能，无后继的技能 → 终点；边带箭头并做脉冲（animated dashes）；每一波上方标「第 n 步 · 并行 k」（k>1 时）。这样一波多技能 = 起点扇出，多波 = 链式箭头。
- IoTable 两表都是三列：文件 · 来源阶段 · 来源技能；输出的来源阶段 = 本阶段。
- Markdown 新增 `compact` 密度（h1 20 / h2 16 / h3 14 / 正文 13-20），SkillDetail 使用；frontmatter 表保持。
- SkillFlow 的布局 effect 依赖改为技能内容签名（ids + depends_on）而不是数组引用；registry 走 ref；onChange 只在图与签名不同时触发。补测试：重开编辑器不再触发 onChange。

## 验收
- [ ] `skill-flow` 有 `flow-start` / `flow-end` 节点；`data-edges` 仍只数 depends_on 边；边带 markerEnd 箭头与 animated。
- [ ] `io-outputs` 表头含「来源阶段」，行 `slot-stage-<id>` = 本阶段名；表头文案 来源阶段 / 来源技能。
- [ ] `Markdown density="compact"` 存在并被 SkillDetail 使用。
- [ ] SkillComposer 测试：打开 → 删除 → 保存 → 用新 skills 重开，`onChange` 不再被调用；全部 web 用例通过。
