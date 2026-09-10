# 工作流 track 分支、技能编排浮层、IO sheet 与门禁语义

## Goal

track 成为工作流 YAML 内的独立子分支（各自 pipeline），页面与文件都体现分支；技能编排改为浮层（本机技能库 + 拖拽画布）；输入 / 输出改为两个 sheet 并可溯源到产出技能；门禁只保留两种真实语义（评审 / 自动）并带 hover 解释；任何名称只显示一个（label 或 id）。

## Background

- 上一轮把「轨道技能矩阵」并进 YAML 的做法是给技能加 `when: track_in`，所有 track 共用一条流水线。用户要的是 track = 分支，每条 track 的阶段、技能、输入输出、门禁都可以不同，且全部从 YAML 动态读取。
- 现状 track 定义在 `.pipeline/tracks.yaml`（策略 + 默认工作流），与工作流 YAML 割裂；页面左列只有工作流卡，看不出分支。
- 现状门禁 `review | confirm | null`：`review` 有真实运行时（request → acknowledge → transition）；`confirm` 只在 `tenon advance` 自动推进时当停止标记，普通 transition 完全不检查，是摆设，且与评审概念重复。
- 现状阶段卡同时显示 label（调研）与 id（explore），同一概念出现两遍。

## Requirements

- R1 分支模型：工作流 YAML 顶层 `steps` 为通用分支；`tracks.<id>` 为该 track 的独立分支（可选 `label`，必有 `steps`）。change 的有效计划 = 其 track 命中的分支，未命中用通用分支。技能不再带 `when`。
- R2 default：`templates/workflows/default.yaml` 改为 pm / frontend / backend / free 四条分支 + 通用分支，内容由现有 `when` 集合逐一展开，行为与今天一致（每条分支满足 default 骨架校验）。
- R3 track 登记：分支 id 在 track registry 里有定义则用其策略；没有则用缺省策略（reviewSeed pending、matrix false、profile `_all`、coverage none、routing off）。`tenon init --track <id>` 接受「registry 没有、但所选工作流有该分支」的 track。
- R4 门禁：`gate: review`（人工评审：产物完成后 request → acknowledge 才能 transition）、`gate: auto`（自动：本阶段声明的全部输出齐全即放行，编译为 output-present 守卫）、`null`（只跑显式守卫）。`confirm` 从模型删除，YAML 里出现即报错并给出替代提示。
- R5 工作流页左列：工作流卡可展开，展开后列出该工作流的分支（通用分支一行 + 每条 track 一行）；选中分支后中列显示该分支的流水线；可新建 / 删除分支（新建 = 复制通用分支）。
- R6 名称：阶段、技能、track、工作流一律显示 `label ?? id`，前端不做翻译、不并列两种名字。
- R7 技能编排浮层：阶段右列「技能」区只读显示 DAG + 编辑按钮；浮层左侧为本机全部技能（搜索；每条标来源；点名称展开来源路径；眼睛按钮打开 SKILL.md Markdown 预览），右侧为波次画布；从左拖到右落到某列 = 并行、落到列间 = 新串行波次，有拖拽与落位动画；保存回写 `steps[].skills`。
- R8 输入 / 输出：右列改为两行入口（数量），点击各开一个 sheet；每个槽位显示来源（输入：来自哪个阶段的哪个技能；输出：由本阶段哪些技能产出）与它在 YAML 中的位置。
- R9 门禁 hover：每种门旁一个信息图标，hover / focus 显示一句运行时行为说明。
- R10 工作台：任务详情按 change 自己分支的 IO 显示；阶段筛选只在单一工作流 + 单一 track 时出现，选项为该分支的阶段。

## Acceptance Criteria

- [x] AC1 default.yaml 含 `tracks: {pm, frontend, backend, free}`；`tenon init --track backend` 后快照的阶段技能与改前一致（kernel/cli/server 现有测试通过）。
- [x] AC2 自定义工作流 YAML 写 `tracks.mobile.steps` 后，`tenon init x --track mobile --workflow <name>` 成功，其快照阶段 = mobile 分支。
- [x] AC3 `gate: auto` 的阶段在输出未齐时 transition 被拒（blocker 指向缺失输出），齐全后放行；`gate: confirm` 解析报错。
- [x] AC4 工作流页：展开 default 看到 5 个分支；切换分支中列流水线随之变化；阶段卡只显示一个名字。
- [x] AC5 技能浮层：搜索、来源、SKILL.md 预览、拖拽添加并行 / 串行、保存后 YAML 对应变化（GET yaml 可见）。
- [x] AC6 输入 / 输出 sheet 每个槽位能看到来源阶段 / 技能与 YAML 路径。
- [x] AC7 门禁三项各有 hover 说明；i18n 完整性与泄漏测试通过；design-scale / comments 门禁通过。

## Notes

- 上一任务加入的 `skillRuns` 投影随分支自动生效（有效计划已是分支后的 IR）；manifest 回退保留给老快照。
- `.pipeline/tracks.yaml` 继续承载 track 策略（评审种子、覆盖率、路由、AFK），不动其格式。
- 指纹口径：`workflowFingerprint` 覆盖整份定义（含全部分支），各 track 相同；冻结快照存完整定义，读取时按 change 的 track 重新选分支。这样 default 的历史指纹、definition-status 比较、AFK 授权绑定全部不变。
