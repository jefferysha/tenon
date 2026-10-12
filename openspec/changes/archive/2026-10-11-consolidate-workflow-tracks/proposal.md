# 提案

## Why

现在「流程轻重」和「领域」被拆在两层，用户分不清该选哪个，规则也不在用户看得到的地方：

- 轻重靠换工作流：内建 `default`、`standard`、`simple`、`design-system` 四个；领域靠换轨道，但 `default` 的 5 个轨道骨架完全相同，「对话」「自由」名字轻、流程一样重。
- 「轨道」在代码里是两套：路由用的轨道登记表（`packages/kernel/src/tracks/builtins.ts` + 项目 `.pipeline/tracks.yaml`）与工作流 YAML 的分支；路由器写死正则，读不到新增工作流，看到「修复 / 新增」就直接进 standard，不评估改动范围。
- `default` 的执行规则写死在代码里（转换表、事件策略、阶段出口表、manifest），YAML 里看不到；`templates/manifest.yaml` 还有一张与 `default.yaml` 完全重复的技能矩阵。
- 不走 OpenSpec 的任务目录让 CI 的 `check:openspec` 失败；「已归档」开关其实是「只对你隐藏」，与「完结」重名；走完 default 的任务在工作台里看不到。

用户 2026-10-10 在调研步逐项确认了收敛方案（见 `docs/superpowers/specs/consolidate-workflow-tracks-design.md` 与 `docs/adr/consolidate-workflow-tracks.md`）。

## What Changes

- **一个默认工作流**：内建只留 `default`（轨道：轻量、产品、前端、后端）与 `design-system`；删除 `standard`、`simple` 工作流与「对话」「自由」轨道。平铺工作流视为单轨道。
- **default 按 YAML 执行**：退役写死的阶段规则，全部写进 `default.yaml`；搬的同时按用户逐条确认精简规则（删除 `build_mode` / `isolation` / `direct_override`、`branch_status`、statefile、立项字面路径检查、coverage 矩阵、重复的 `verify_result` 检查；任务勾选、AFK 排队、依赖已结束做成通用离开条件）；报错统一为一次列出全部问题、退出码 2。在途任务按快照继续用旧引擎走完，旧引擎下个版本删除。
- **一套轨道**：分支新增 `spec: openspec | none`、`route`（关键词、排除词、优先级、兜底）、`automation`（能否进 AFK、规格完成后自动入队）；删除路由登记表、`.pipeline/tracks.yaml` 读取与 manifest 技能矩阵叠加。
- **路由与评估**：路由读工作流分支生成数据、保存即生效；路由只定领域，开发请求先用新命令 `tenon assess --files` 按轻量阈值评估，再由用户确认轨道；并列或命中自定义工作流时让用户选。
- **轻量轨道**：承接 standard 的步骤、探针与评审，只在本地提交；超限升级为同领域的重型轨道任务并 `depends_on`。
- **结束与归档**：所有任务结束都归档进 `openspec/changes/archive/`，由 `tenon task finish` / `tenon task terminate` 完成（OpenSpec 轨道由 Tenon 调用 `openspec archive`）；删除「隐藏」；工作台分类为 全部 · 需要你 · 进行中 · 已结束，已结束任务标出结果（完结 / 已升级 / 已终止）。
- **Dashboard**：轨道设置可改规范与关键词；门禁段只读列出离开条件；删除无人调用的新建任务、路由预览接口与技能矩阵编辑状态。
- **同步**：`skills/tenon/SKILL.md` 选通道规则、AFK 自动修复取计划的分支、`CONTEXT.md` 术语、用法文档与 `docs/CONTRACT.md`。

非目标：文档机制重做（每步不预先定义输入输出、运行时登记产出、渐进式披露、Spec Kit 支持）与测试设置简化，分别另立任务；评审门、验证轮次上限、测试证据语义不变；任务状态目录仍在 `openspec/changes/` 下。

可验证结果：

- 内建工作流只剩 `default` 与 `design-system`；新建的 default 任务按 YAML 执行，产品 / 前端 / 后端每一步的转换、离开条件与动作和 §1b 的确认结果一致。
- 轻量轨道任务端到端：≤ 25 次 tenon 调用、2 次用户回复；完结归档并提交、升级归档不提交；结果树通过 `check:openspec`。
- 新保存一个带关键词分支的工作流后，不改技能文本，下一条命中它的消息出现在候选里；`tenon assess` 与改动风险探针对同一组文件结论一致。
- 在途的旧模型任务（含 standard / simple / 对话 / 自由）能走完；`tenon task terminate` 归档并只提交任务目录；工作台「已结束」列出归档任务，快照基准 p95 < 1.5 s。

## Capabilities

### New Capabilities

- `workflow-tracks`：一个工作流内用轨道表达轻重与领域；轨道级规范、路由与自动化设置；default 按 YAML 执行；评估与升级；任务结束与归档；工作台「已结束」。

### Modified Capabilities

- `workflow-definition`：轨道分支新增键；平铺工作流单轨道；default 不再要求固定 7 步。
- `effective-workflow-plan`：执行模型与能力来自轨道分支，新计划一律按 YAML 执行。
- `declarative-document-governance`：文档治理按轨道的规范选择生效。
- `simple-task-routing`：`simple` 退役，由轻量轨道承接。
- `normal-chat-routing`：删除「自由」中立入口与「对话」轨道身份；路由数据来自工作流分支。

（delta spec 见 `specs/` 下六个目录。）

## Impact

- 代码：`packages/kernel/src/workflow/`、`flow/`（旧引擎收进 `workflow/legacy-phase-manifest/`）、`tracks/`（删除登记表）、`state/`；`packages/cli/src/commands/`（init、status/finish、advance、check、task、新增 assess）；`hooks/router.sh`、`hooks/router-gen.mjs`；`packages/server/src/`（工作流读写、快照与已结束列表、删除无人调用接口）；`packages/automation/src/`（AFK 资格、triage）；`packages/dashboard-app/src/`（工作流页、工作台）；`templates/workflows/`、`templates/manifest.yaml`、`default-workflow.generated.ts`；`skills/tenon/SKILL.md`；`docs/usage/`、`docs/CONTRACT.md`、`CONTEXT.md`。
- 契约：工作流 YAML 分支键扩展；CLI 删除 `task archive / unarchive`，新增 `task finish / terminate` 与 `assess`；`next.finish-change.command` 改为 `tenon task finish`；路由缓存升为 `router.v6`；default 离开条件失败的退出码由 1 改为 2。
- 兼容：在途任务按快照运行；旧入口（`--workflow standard|simple`、`--track chat|free`、`.pipeline/tracks.yaml`、`task archive`）报错并给出替代。
- 测试：kernel 工作流与路由单测、`tools/test-hooks.sh` 路由夹具、轻量轨道集成测试（迁移 standard 集成测试）、default 行为集成测试、`tenon assess` 与探针一致性、归档与已结束列表、快照基准、Dashboard 单测与 e2e、旧版逐字对比 oracle 用例改写或退役。
