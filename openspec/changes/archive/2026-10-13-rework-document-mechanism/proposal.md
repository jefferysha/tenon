# 提案

## Why

现行文档机制在工作流里预先写死每一步的输入、输出文档，并规定「哪个技能必须交哪份文档」，与技能的实际行为脱节：

- **契约与技能不符**：default 的 `document_contract` 规定调研步的 `adr` 由 brainstorming 产出，但 brainstorming 只写设计文档，ADR 是 domain-modeling 的职责，且两份模板几乎重复。上一任务只能为满足契约补写一份重复的 ADR（见 `docs/adr/consolidate-workflow-tracks.md` 开头说明）。技能多是第三方的，按各自 SKILL.md 写文档，Tenon 无法也不应替它们规定产出。
- **读取义务过重**：读取表 `reads` 手写且逐步累积，实现步要读 8 类文档，与直接上游实际产出了什么无关，token 开销大。
- **绑死 OpenSpec**：文档 kind 目录、`openspec-v1` 账本、只允许 `openspec/` 或 `docs/` 路径、OpenSpec 骨架都写在机制里；Spec Kit 这类自定义规范无从表达。
- **重复与失真**：同一张契约在 `default.yaml` 的产品、前端、后端分支抄了三遍，还有步骤级 `inputs` / `outputs` / `artifacts` 字段通道与 `file-exists` 守卫两套重叠的门禁；Dashboard 工作流页把契约当作手写输入输出表来编辑，工作台只显示契约点名的槽位，契约之外的真实产出看不到。

上一任务 consolidate-workflow-tracks 已把本项拆为独立任务（`docs/superpowers/specs/consolidate-workflow-tracks-design.md` §7、归档提案的「非目标」）。用户已定下原则：产出就是技能自己的要求，Tenon 只记录实际产出与来源技能；只把直接上游的产出交给下一步且必须读完；门禁只保留按路径的「必须产出」；文档约束与 OpenSpec 解耦；Dashboard 显示真实产出；在途任务照旧走完。

## What Changes

- **运行时观察步骤产出**：进入步骤时记下工作区检查点，离开步骤时与之比较，得到本步新增、修改、删除的文件；来源技能按 hook 已记录的技能加载时间与文件修改时间尽力标注，对不上记「未知」。观察发生在转换时，而不在技能加载的 PostToolUse 里，避开 2026-09-15 删除的 hook 自动登记方案的时机错误。
- **渐进式披露交接**：下一步的输入只取直接上游那次步骤访问产出的文档；`read-documents` 只列这些文件，`tenon document read` 照旧写精确摘要的读取回执，没读完不能离开这一步（终止任务除外）。
- **门禁只保留按路径的「必须产出」**：新增按路径（支持 `{change}` 占位与通配）声明的必须产出守卫，本任务内该步骤产出过匹配文件才放行；替代 `file-exists` + 文档字段（`design_doc`、`plan`、`verification_report`）的组合。
- **删除预定义输入输出**：`default.yaml` 与 `design-system.yaml` 删除 `document_contract` 与步骤级 `inputs` / `outputs` / `artifacts`；新解析拒绝这些键并给出替代写法。错误的 adr←brainstorming 契约随之消失。新任务不再铺文档骨架、不再登记文档、不再登记文档字段；技能写什么就是什么。
- **与 OpenSpec 解耦**：产出观察、交接、读取回执、必须产出对所有轨道与工作流一样生效（含轻量轨道、`spec: none`、自定义平铺工作流）；`spec: openspec` 只管 OpenSpec 自己的生命周期（规格校验与应用、归档）。用 Spec Kit 风格的自定义工作流做测试夹具证明可用。
- **CLI**：`tenon status --json` 的 `step.documents` 给出本步输入（含已读状态）、本步产出预览与必须产出；新任务的 `next` 只发 `read-documents` 这一类文档动作；`document scaffold` / `document record` 只服务旧快照任务，`artifact register` 只对冻结步骤声明了 artifact 的旧任务有效；测试报告动作的报告路径改从验证步的必须产出取，不改测试体系语义。
- **Dashboard**：工作台每一步的输入、输出改为显示真实产出（路径、新增 / 修改 / 删除、来源技能或「未知」、是否已读）；工作流页删除输入输出表与文档契约编辑，门禁段列出必须产出。
- **在途任务**：冻结快照里带旧文档契约的任务继续按旧账本与旧 `next` 动作走完；旧代码只服务旧快照。
- **同步**：`skills/tenon/SKILL.md` 文档相关动作行、`CONTEXT.md` 术语、`docs/usage/`（中英）、`docs/CONTRACT.md`、发布说明。

非目标：

- 测试体系（test-system 代码、`.tenon/tests/catalog.yaml`、YAML 的 `test_policy` / `tests` 键、测试相关动作行、code-size、测试信任）由并行任务 simplify-test-settings 负责，本任务不改其语义。
- 评审门、验证轮次上限、测试证据语义不变；任务状态目录仍在 `openspec/changes/` 下。
- 非 git 项目不做产出观察（必须产出退化为文件存在检查）。
- 不删除旧快照仍在用的旧账本与旧引擎代码。

可验证结果：

- `default.yaml` 不再为每一步预先列输入、输出文档，也没有 `document_contract`。
- 新任务每次离开步骤，Tenon 都记下本步实际新增、修改、删除的文件和来源技能（或「未知」）。
- 下一步的 `read-documents` 只列直接上游产出的文档，没读完时离开这一步的转换被拒（终止任务除外）。
- adr←brainstorming 契约已删除；文档机制在 `spec: none` 与 Spec Kit 风格工作流上同样生效。
- Dashboard 工作台显示真实产出，工作流页没有手写输入输出表。
- 测试覆盖：旧快照任务照旧走完；新任务轻量轨道与后端轨道各走完一遍。

## Capabilities

### New Capabilities

- `step-output-lineage`：运行时观察步骤产出与来源技能、直接上游交接、读取回执、按路径的必须产出守卫。

### Modified Capabilities

- `declarative-document-governance`：文档契约只服务冻结了它的旧任务；新工作流定义声明契约时报错。
- `document-evidence-contract`：OpenSpec 文档账本、骨架与登记只对旧快照任务生效；新任务只铺 `tasks.md`。
- `workflow-definition`：校验拒绝 `document_contract`、非空 `inputs` / `outputs` / `artifacts` 与 `nonempty-output`，新增 `required-output` 守卫，`gate: auto` 不再由 outputs 推导。
- `document-evidence-timeline`：服务端给出每步真实输入输出（`stepIo`），Dashboard 显示真实产出而非契约槽位，工作流页不再有输入输出表。
- `workflow-tracks`：工作流页门禁段列出必须产出，不显示也不编辑输入输出表。
- `effective-workflow-plan`：计划的 OpenSpec 生命周期取自分支 `spec`，文档模式（契约 / 观察）取自冻结策略；无快照的 `legacy-full` 任务挂冻结的 `openspec-v1` 表。
- `context-bundle-handoff`：观察模式的上下文包取当前访问的交接输入。

另：前端轨道的「立项前 DESIGN.md 必须就绪」来自旧契约的 require 槽，随契约退出新任务（DESIGN.md 有效性仍由前端交付步的 `design-system` 必需测试把关），这是用户可见的行为变化，写进发布说明。

## Impact

- 代码：`packages/kernel/src/workflow/`（parse、compile、validate、document-contract*、effective-io、guard-handlers、governed-lifecycle-policy、step-exit-report、transition-application）、`packages/kernel/src/workspace/`（新增检查点与比较）、`packages/kernel/src/state/`（产出账本与读取回执）；`packages/cli/src/commands/`（document、artifact、statusStep*、step-run、transition、check、init）；`packages/server/src/`（编排 io、快照文档）；`packages/dashboard-app/src/`（工作台 stageIo / StageIoPanel，工作流页 StageEditorPane / IoTable / documentContractEdits）；`templates/workflows/default.yaml`、`design-system.yaml`、`default-workflow.generated.ts`；`skills/tenon/SKILL.md`；文档。
- 契约：工作流 YAML 删除四个键（旧键报错并给出替代）；新增守卫类型；`status --json` 的 `step.documents` 新增输入、产出、必须产出视图；新任务不再下发 `scaffold-document` / `record-document` / `register-field`。
- 兼容：旧快照任务行为不变；保存过带旧键的项目工作流需按报错改写。
- 风险：同一检出里的并行任务会互相污染观察（推荐 worktree）；rebase 带入的上游改动需要过滤；来源标注是尽力而为。
