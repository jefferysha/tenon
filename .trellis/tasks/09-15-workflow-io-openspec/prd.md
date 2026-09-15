# 工作流输入输出与 OpenSpec 接入

## Goal

创建工作流时决定是否接入 OpenSpec；接入后每个阶段该产出哪些 OpenSpec 文档、由哪个技能产出，在编辑时就能看到和修改，
执行时由门禁真实检查；工作台的输入输出一眼看出缺什么、为什么。

## Background (confirmed, see `research/io-and-runtime-artifacts.md`, `research/reference-patterns.md`)

- 技能本身不声明产出；「哪一步要哪些文档、允许哪些技能产出」写在工作流里：
  default 或 `openspec_contract: required` 使用按标准阶段 id（open/explore/spec/build/verify/ship/archive）写死的表
  （`kernel/src/workflow/document-contract.ts:32-123,139-143`）；自定义工作流靠顶层 `document_contract.slots/reads`
  （`parse-document-contract.ts:85-124`）。
- 自定义工作流如果阶段 id 不是标准 id，写死的表对不上，文档门禁不生效；在 UI 新建的阶段输入输出为空
  （`workbench/useStageDraftEditor.ts:79`）；C1 自定义工作流只登记了字段 `plan`，没有文档。
- 怎么写出一份 OpenSpec 文档由三部分决定：文档类型的路径与骨架（`templates/documents/registry.v1.yaml`，
  `tenon document scaffold` 生成）、产出技能的写作规则（如 `openspec-propose`）、阶段技能告诉 agent 何时 scaffold 与 record。
- 运行时产物块只对 `tenon orchestration run` 有内容，宿主驱动的任务永远为空（`server/src/serverArtifactRoutes.ts:72-83`）。
- 用户已认可的展示方案：输出可声明、删除运行时产物、输出计数与缺失/过期原因、门禁条件计数、无 IO 阶段隐藏。

## Requirements

- R1 新建工作流时选择「接入 OpenSpec」。接入后每个阶段可以从 OpenSpec 文档类型中选择要产出的文档，
  产出技能只能从本阶段技能中选择；保存为 YAML `document_contract`。
- R2 选择某文档类型后，如果本阶段没有能产出它的技能，自动建议加入对应技能（如 `openspec-propose`），可移除。
- R3 输入不单独编辑：勾选上游阶段已声明的输出作为本阶段必读（写入 `reads`）。
- R4 不接入 OpenSpec 的工作流不产生文档门禁，只保留字段输出与自动门。
- R5 工作流页输出表增加「+ 输出」；本轨道技能产不出的文档不显示。
- R6 工作台删除「运行时产物」块。
- R7 工作台输出页签标题显示计数（如「输出 2/3」）；每行状态一个词（已登记 / 缺失 / 过期 / 未读）；缺失行显示应产出的技能，
  过期行悬停显示原因。
- R8 门禁行显示条件计数（如「评审 · 3/3」）；阶段没有任何输入输出时整块不显示。
- R9 `tenon handoff --bundle` 支持自定义 `document_contract`（目前只认标准阶段 id）。
- R10 文档要求可以按轨道声明：目前 default 的文档表不区分轨道（五个轨道文档要求相同）；需要支持只对某个轨道要求的文档，
  首个使用者是前端轨道必需的项目全局 `DESIGN.md`（2026-09-15 用户要求，见 `09-15-design-resources` R8），并新增对应文档类型。

## Acceptance Criteria

- [ ] 在 Dashboard 新建工作流、打开「接入 OpenSpec」，给两个自定义阶段分别声明 proposal/tasks 与 delta-spec，保存后 YAML 含
      对应 `document_contract`，重新打开编辑器显示一致。
- [ ] 用该工作流在 Claude Code 与 Codex 各跑一个真实任务：缺文档时转移被拦截并提示文档与产出技能；登记后放行；
      工作台输出计数与状态正确。
- [ ] 关闭 OpenSpec 的工作流不出现文档门禁。
- [ ] 工作台不再显示运行时产物块；过期行悬停显示原因。
- [ ] `tenon handoff --bundle` 对自定义契约工作流输出正确的必读文档。

## Out of Scope

- 让技能自己声明产出（技能清单格式变更）。
- 编排运行时（`tenon orchestration run`）的产物展示重做。

## Key Decisions

- 2026-09-15 按推荐确定（用户授权后续按推荐执行）：接入 OpenSpec 时允许只选部分文档；工作流检查提示链路缺口（例如声明了 delta-spec
  却没有任何步骤产出 applied-spec）作为警告，不阻止保存。
