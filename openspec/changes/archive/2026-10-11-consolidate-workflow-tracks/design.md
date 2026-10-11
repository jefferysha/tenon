# 设计

完整技术设计见 `docs/superpowers/specs/consolidate-workflow-tracks-design.md`（§1–§7、§1a 执行模型、§1b 规则去留、§6a 模块与接缝），决策摘要见 `docs/adr/consolidate-workflow-tracks.md`，术语见 `CONTEXT.md` 的「Workflows, tracks and task lifecycle」。本文只记录调研结论的要点。

## 调研结论

- **执行模型**：执行模型按工作流名选择（`effective-plan.ts:293-301`），名为 `default` 走 phase-manifest，规则写死在 `flow/transition-table.ts`、`flow/default-event-policy.ts`、`flow/guard.ts` 的 `EXIT_RULES` 与 `templates/manifest.yaml`；存储校验要求 default 每个分支恰好 7 步（`document-contract-validation.ts:179-215`），轻量分支直接放入会让整份 default 加载失败。决定：default 全部改为 step-graph，规则写进 `default.yaml` 并按 §1b 精简；旧引擎只服务快照里记着旧模型的任务，收进 `workflow/legacy-phase-manifest/`，下个版本删除。
- **YAML 词表差距**：现有 guard / action 能表达全部事件边与副作用；需新增三个通用离开条件（任务已勾选、未在 AFK 排队、依赖已结束）；`check` / `status` / 结论字段写入闸需改为同时读取边级 guard；`tenon advance` 改为「只有一条前进边就走它」。
- **轨道**：路由登记表承载的关键词、排除词、优先级、AFK 资格搬到分支键 `route` / `automation`；技能矩阵、coverage profile、reviewSeed 删除；平铺工作流视为单轨道，`design-system` 不再依赖 `--track free`。
- **OpenSpec**：本仓库锁定的 OpenSpec 1.6.0 对 `openspec/changes/` 下无 delta 的目录一律判失败，只排除 `archive/` 与 `.` 开头目录；所有任务结束都归档进 `archive/`，由 `tenon task finish` / `terminate` 完成，OpenSpec 轨道由 Tenon 调用 `openspec archive`。
- **路由与评估**：路由只定领域；开发请求先 `tenon assess --files` 用轻量轨道的探针阈值评估，再由用户确认；评估与实现后的探针共用 `classifyChange`。
- **AFK**：triage 写死 default + 后端但取计划时不传轨道（拿到第一条分支），修正为按后端分支取计划。

## 风险

- 旧引擎与新引擎并存一个版本：快照选择适配器的接缝必须唯一，不能在各读点重复分支。
- 离开条件失败的退出码由 1 改为 2、文案改为一次列出全部问题：依赖旧行为的调用方（oracle 逐字对比用例、脚本）需同步。
- 路由数据改由工作流生成：`tools/test-hooks.sh` 的大量夹具需迁移，路由仍须 fail-closed、bash 薄 shim 不引入解释器依赖。
- 已结束任务列表随归档增长：只读摘要并按目录身份缓存，基准守住 p95。
- 本任务在独立 worktree 执行，不运行 `tenon setup --from-source`（会改全机共用的运行时）。

## 待验证问题

无。调研步的待决问题已全部由用户确认（见设计文档）。
