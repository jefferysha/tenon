# 任务

## 立项

- [x] 写 proposal / design / tasks：记录两层划分与两套轨道的现状证据、范围、非目标与可验证结果。

## 调研

- [x] 与用户确认待验证问题：轻量轨道名称与步骤、升级方式、`.pipeline/tracks.yaml` 处理、不走 OpenSpec 的任务目录、已结束任务在工作台的显示、执行模型、写死规则逐条去留、AFK 开关与离开条件展示。 (explore)
- [x] 核实受影响的消费点：执行模型与规则表的全部读点、轨道级文档治理的读取方、技能矩阵、AFK 与 Dashboard 新建入口，以及在途任务按快照运行的兼容路径。 (explore)
- [x] 写设计文档与 ADR，统一「工作流 / 轨道 / 任务结果」术语并更新 `CONTEXT.md`。 (explore)

## 规格

- [x] 写 delta spec：新增 `workflow-tracks`，修改 `workflow-definition`、`effective-workflow-plan`、`declarative-document-governance`、`simple-task-routing`、`normal-chat-routing`。 (spec)
- [x] 写实施计划：旧引擎隔离 → 轨道解析与分支键 → default 规则写进 YAML 与通用离开条件 → 轻量轨道 → 改动风险分类与 `tenon assess` → 路由表生成 → 任务归档与已结束列表 → CLI / server / automation / Dashboard → 删除清单 → 技能与文档；每段写明验收命令。 (spec)
- [x] 登记测试计划：kernel 单测、hook 路由夹具、default 行为集成测试、轻量轨道集成测试、评估与探针一致性、归档与已结束列表、快照基准、Dashboard 单测与 e2e、CI 检查。 (spec)

## 实现

- [x] 旧 phase-manifest 引擎收进 `workflow/legacy-phase-manifest/`，按快照执行模型选择适配器；新计划一律 step-graph。 (build)
- [x] 轨道解析 `resolveTrack`：分支键 `spec` / `route` / `automation`、平铺工作流单轨道；删除路由登记表、`tracks.yaml` 读取与技能矩阵叠加。 (build)
- [x] `default.yaml` 写入全部离开条件与动作（按设计 §1b），新增三个通用离开条件；新增轻量轨道，删除对话、自由分支；删除 `standard` / `simple`；重新生成 `default-workflow.generated.ts`。 (build)
- [x] `classifyChange` 与 `tenon assess`；改动风险探针改用同一分类。 (build)
- [x] 路由表从工作流分支生成（`router.v6`），评估分派、并列与自定义候选、兜底；迁移 `tools/test-hooks.sh` 夹具。 (build)
- [x] `tenon task finish` / `terminate` 与归档模块；删除「隐藏」；服务端已结束任务列表。 (build)
- [x] CLI 配套：`check` / `status` / 结论字段写入闸读取边级 guard、`advance` 前进边规则、报错统一、旧入口报错与替代提示；AFK triage 按后端分支取计划。 (build)
- [x] Dashboard：轨道设置可改规范与关键词、门禁段只读离开条件、工作台分类「已结束」与任务结果；删除无人调用的接口、状态与文案。 (build)
- [x] 同步 `skills/tenon/SKILL.md`、`docs/usage/`、`docs/CONTRACT.md` 与发布说明。 (build)

## 验证

- [x] 全量单测、类型检查、hook 与 adapter 测试、Dashboard e2e 通过；快照基准 p95 < 1.5 s。 (verify)
- [x] 本地跑齐 `check:*`（含 `check:openspec`、`check:default-workflow-freshness`、`check:repository-hygiene`）。 (verify)

## 交付

- [ ] 提交交付物并开 PR，`gh pr checks` 全绿。 (ship)

## 完结

- [ ] 归档变更。 (archive)
