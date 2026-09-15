# 单一数据驱动的 tenon 技能

## Goal

Tenon 自有 skill 只剩一个 `tenon`：它读取任务的冻结工作流计划，对当前步骤照做——加载声明的开源 skill、运行声明的 agent 与测试、
产出并登记声明的文档、请求评审、推进阶段。每一步做什么全部来自工作流数据，default 与自定义工作流被同样对待。

## Background (confirmed)

- Tenon 自有 11 个 skill：`tenon`（504 行，总编排）、7 个阶段 skill `tenon-open`…`tenon-archive`（192–467 行）、`simple-task`（54）、
  `learn-record`（199，写 `~/.claude/skills/learned` 与个人知识库）、`tenon-researcher`（14）。
- 阶段 skill 中 Tenon 命令相关只有 11–35 行（init、session、document scaffold/record/read、review request、transition、handoff、
  review-attempt、build_sha），其余是「这个轨道这一步先调哪个开源 skill、怎么交互」的流程说明，与工作流 YAML 声明的步骤技能和开源 skill
  自身内容重复。
- 这些 skill 被写死在多处：`templates/workflows/default.yaml` 五个轨道共 35 处步骤技能引用；文档产出者契约把 tenon-explore / spec /
  build / verify / ship / archive 列为允许的产出者（`packages/kernel/src/workflow/document-contract.ts`）；内置 simple 工作流使用
  `simple-task`（`packages/kernel/src/workflow/builtin-workflows.ts:17`）；`packages/cli/src/commands/doctor-skills.ts:157-160` 检查阶段 skill。
- 仓库还有 4 个 Tenon agent 定义：`agents/tenon-builder.md`、`tenon-design-reviewer.md`、`tenon-researcher.md`、`tenon-reviewer.md`。
- 证据：Dashboard 自建的 `feature-flow` 工作流没有使用任何阶段 skill，直接用开源 skill 加通用编排，真实任务跑到归档（C1）。

## Key Decisions

- 2026-09-15 用户确认：只保留一个由工作流数据驱动的 `tenon` skill；删除 7 个阶段 skill、`simple-task`、`learn-record`、
  `tenon-researcher`；`openspec-propose`、`openspec-apply-change` 换回上游版本；轨道差异写进工作流数据；完成后重新做真实任务验收。

## Requirements

- R1 `tenon` skill 按冻结计划执行当前步骤：
  - 路由：纯对话与任务区分、选择工作流与轨道、断点恢复；
  - 步骤执行：加载声明的开源 skill（按依赖顺序）、运行声明的执行者 agent、产出并登记声明的文档与字段、通过 Tenon 执行声明的测试、
    运行声明的评审者 agent、按门禁请求人工评审或自动放行、推进阶段；
  - 人工参与与自动执行（HITL / AFK）两种模式都支持；
  - Tenon 专属操作（scaffold、record、handoff、review-attempt、build_sha 冻结）由它统一完成，不散落在各阶段说明中。
- R2 删除阶段 skill、`simple-task`、`learn-record`、`tenon-researcher`，并清理所有引用：default 工作流步骤技能、内置 simple 工作流、
  文档产出者契约（产出者改为实际产出文档的开源 skill）、doctor 检查、技能门、文档与测试。
- R3 default 工作流用数据表达原先写在阶段 skill 里的轨道差异：每步的开源 skill、输出、测试（`09-15-test-evidence`）、执行者与评审者 agent
  （`09-15-review-agents`，如 verify 的并行评审）、DESIGN.md 的产出与检查时机（`09-15-design-resources`）、产品轨道的原型流程。
- R4 `openspec-propose`、`openspec-apply-change` 使用上游版本；Tenon 定制的行为（登记、应用规格回执）由 `tenon` skill 负责。
- R5 `agents/` 下的 4 个 Tenon agent 并入插件维护的 agent 库作为内置 agent（与 `09-15-review-agents` 一致）。
- R6 default 与自定义工作流由同一个 `tenon` skill 执行，没有只对 default 生效的特殊说明。

## Acceptance Criteria

- [ ] 插件中 Tenon 自有 skill 只有 `tenon`；仓库与发布包中不再存在阶段 skill、`simple-task`、`learn-record`、`tenon-researcher`，
      代码、工作流、契约、doctor 中没有残留引用。
- [ ] 在 Claude Code 与 Codex 中各跑真实任务到归档：default 的 frontend、backend、pm、free 轨道各一个，以及一个 Dashboard 自建工作流；
      每步加载的 skill、产出文档、测试、agent、评审与工作流声明一致。
- [ ] 修改工作流 YAML 中某一步的技能或输出后，新任务的执行随之改变，不需要改任何 skill 文本。
- [ ] 原有门禁（文档证据、技能顺序、评审、构建版本冻结）在新方式下行为不回退，现有测试与真实任务验收通过。

## Out of Scope

- 保留旧阶段 skill 的兼容层。
