# 自定义 agent（任务级：评审与执行）

## Goal

用户可以自定义 agent：写清角色说明、要用的技能和工具，在任务的工作流任何步骤中作为执行者完成工作，或作为评审者在离开步骤前检查；
agent 按串行或并行执行，只在轮到自己时加载技能；Tenon 记录每个 agent 的结论与问题，并用评审结论决定能否离开步骤，
替代现在手填的评审字段。

## Background (confirmed)

- 现有「评审尝试」只有车道名（`review_lanes: [standards, spec, e2e]`），车道没有角色、技能、顺序、必需/参考之分；
  聚合结论固定为「全部车道通过」（`kernel/src/state/review-attempt-budget.ts:248-256`）。详见 `research/current-review.md`。
- 没有守卫读取评审尝试；`verify-pass` 读取 agent 手填的 `agent_review_result` / `codex_review_result`
  （`flow/default-event-policy.ts:86-99`）。
- 评审者名单、并行方式写死在 `skills/tenon-verify/SKILL.md:143-238` 的文字说明里；仓库自带 agent 定义 `agents/tenon-reviewer.md`。
- 可复用：技能 `kind: review` + `review_lane` + `depends_on` 波次（`workflow/types.ts:60-68`），
  `internal-skill-gate` 可在车道激活前拦住评审技能（`cli/src/internalSkillGate.ts:104-150`），
  编排 v2 的 `role` + `mode: serial|parallel`（`kernel/src/orchestration/v2-types.ts:100-130`）。
- 宿主原生子 agent 能力（`research/harness-agents.md`）：
  - Claude Code 支持会话级 `--agents`、`.claude/agents/`、`~/.claude/agents/`；子 agent 可并行，技能按 `skills:` 预加载，不会渐进解锁。
  - Codex 自定义 agent 为 TOML（`.codex/agents/`），可并行；Gemini、Cursor、Copilot、Devin、OpenCode 为 Markdown + YAML，
    字段名各不相同；Amp 需 TypeScript 插件。
  - Cline、Zed、Pi、Aider 不支持自定义 agent，只能在主会话中按提示词执行（无隔离、无并行）。

## Key Decisions

- 2026-09-15 用户确认：任何步骤都能挂评审者，在离开该步骤前执行；评审者（agent 检查）与评审门（人工确认）相互独立，可以叠加。
- 2026-09-15 用户确认：代码规模这类确定性检查做成测试方向由 Tenon 执行（见 `09-15-test-evidence`），评审者读取结果下结论。
- 2026-09-15 用户要求：支持自定义 agent，用于工作流每一个环节的评审或执行。
- 2026-09-15 用户澄清：agent 与 AGENTS.md 不是一回事。AGENTS.md / CLAUDE.md 是指令文件，属于项目级和用户级
  （见 `09-15-instruction-templates`）；agent 是任务级，在任务的工作流步骤中使用。
- 2026-09-15 用户确认：agent 定义放在独立的 agent 库，每个 agent 一个 Markdown 文件，工作流步骤按名称引用；
  任务开始时锁定所用 agent 的内容。agent 库由插件维护：内置 agent 随插件发布，安装或更新插件时自动安装到全局 Tenon 目录。
- 内置 agent 只读、可复制：插件更新会刷新内置 agent，用户修改请在副本上进行，避免被覆盖。
- 删除 `agent_review_result` / `codex_review_result` 字段及其手填流程，不保留兼容层（遵循用户「重构即删除旧能力」的既定偏好）。

## Requirements

- R1 agent 定义：名称、描述、角色说明（Markdown 正文）、技能列表、可用工具、模型（宿主支持时）、适用宿主。
- R2 agent 是任务级：在工作流步骤中被选用，随任务运行生效；不写入宿主的 agent 目录（`.claude/agents/` 等），不影响任务之外的宿主会话。
- R2a agent 库位于全局 Tenon 目录，每个 agent 一个 Markdown 文件；内置 agent 在安装 / 更新插件时自动写入，用户自定义 agent 与之并列存放、
  互不覆盖；工作流按名称引用，任务开始时与工作流一起锁定内容，之后修改 agent 不影响进行中的任务。
- R3 Dashboard 管理 agent：列表（区分内置 / 自定义）、新建、Markdown 编辑与预览、复制、删除（内置不可删改）；工作流步骤中选择 agent；
  被工作流引用的 agent 删除前提示引用位置。
- R4 步骤中使用 agent 有两种身份：
  - 执行者：完成该步骤的工作（可多个，串行或并行），产出按文档与测试登记规则归属到执行它的 agent；
  - 评审者：在步骤产出与必需测试就绪后、离开步骤前检查（串行或并行、必需或参考、阻断级别、可读取的测试方向结果）。
- R5 提供内置 agent 预设，可复制修改：架构、前端质量、后端质量、代码规模、安全、规格一致性、e2e；用户可以新增任意 agent。
- R6 渐进加载：agent 的技能在该 agent 开始前不可加载；开始后只解锁它自己的技能（由 Tenon 技能门强制，宿主本身不提供）。
- R7 agent 由宿主执行（Claude Code 子 agent、Codex 子任务或 `codex exec` 等），Dashboard 不调用模型；Tenon 负责排定顺序、
  记录结果、校验候选版本。
- R8 每次 agent 运行一条记录：agent、身份（执行者 / 评审者）、结论、问题清单（级别、位置、说明）、报告文件、候选版本、执行人。
  评审整体结论只由必需评审者决定；代码或产出变化后旧评审记录显示为过期，允许重跑。
- R9 离开步骤的守卫读取评审记录；步骤同时是评审门时，必需评审者通过后才能请求人工确认；手填评审字段删除。
- R10 Dashboard 工作流页在步骤里编辑执行者与评审者（选 agent、串并行、必需/参考、阻断级别），与技能画布同构，
  评审者与评审门分开呈现；工作台显示每个 agent 的状态、问题数，点开看报告。
- R11 `tenon-build`、`tenon-verify` 等技能按步骤声明的 agent 执行，不再写死评审轨道。

## Acceptance Criteria

- [ ] 官方安装插件后，全局 Tenon 目录下出现内置 agent；更新插件后内置 agent 被刷新，用户自定义 agent 保持不变。
- [ ] 在 Dashboard 新建、编辑（Markdown 编辑与预览）、复制、删除 agent，刷新后状态一致；内置 agent 不能删改；
      删除被引用的 agent 前提示引用位置；删除的 agent 不再出现在步骤可选列表中。
- [ ] 任务进行中修改其引用的 agent，该任务仍使用开始时锁定的内容，新任务使用新内容。
- [ ] 工作流 YAML 可在 build 步骤声明两个并行执行者 agent，在 build 与 verify 步骤声明评审者（两个并行 + 一个依赖前两者的串行），
      Dashboard 可编辑并保存回 YAML。
- [ ] 在 Claude Code 和 Codex 的真实任务中，执行者与评审者按声明顺序运行；任务之外的宿主会话看不到这些 agent；
      未轮到的 agent 技能调用被拦截并给出原因。
- [ ] 必需评审者报出阻断级别问题时离开步骤被拦截，提示哪个 agent、哪些问题；参考评审者的问题不拦截。
- [ ] 「代码规模」评审者读取 Tenon 执行的代码规模测试结果下结论。
- [ ] 同时设了评审门的步骤：必需评审者未全部通过前无法请求人工确认。
- [ ] 修复后旧评审记录显示为过期，重跑通过后可以离开步骤。
- [ ] 工作台显示每个 agent 的身份、结论、问题数、报告和执行人。
- [ ] 默认工作流迁移到新模型后，前端 / 后端 / pm / free 轨道的真实任务验收通过。

## Out of Scope

- Dashboard 发起或托管模型调用。
- 项目级 / 用户级的宿主全局 agent 目录管理。
- 跨团队的 agent 市场。

## Technical Direction (from research)

- 运行时交付：Tenon 把 agent 的角色说明、技能与工具约束渲染进步骤交接内容，由宿主以普通子 agent（Claude Code 的 Agent 工具、
  Codex 子任务 / `codex exec`）按该提示启动；不写入 `.claude/agents/`、`.codex/agents/` 等宿主 agent 目录，保证任务级、
  不影响任务之外的会话。不支持子 agent 的宿主（Cline、Zed、Pi、Aider）在主会话中按提示词串行执行。

