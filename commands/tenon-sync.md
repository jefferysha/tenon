---
name: "Pipeline: Sync"
description: in-project 资产同步 + 升级 channel 派生 + 落后检测——版本协调决策层，默认只报告不改盘
category: Workflow
tags: [workflow, pipeline, versioning, migration, upgrade]
---

# /pipeline-sync — 版本化资产同步

把跟随插件版本演进的 **in-project 资产**（`.pipeline-version` 戳、所有权清单、迁移）同步到当前 CLI 版本，
带冲突协商 + 降级守卫 + `--migrate` opt-in 硬闸。对标 Tenon contract `tenon update` / `tenon upgrade`。

实现真相源（已落地 · BACKLOG #24）：版本协调纯逻辑在 `packages/kernel/src/state/ownership.ts`；
同步命令在 `packages/cli/src/commands/sync.ts`（`cmdSync(deps, opts, fs?)`）；真实 e2e 证据在
`packages/cli/src/sync-uninstall.integration.test.ts`。决策报告以**单行 JSON** 落 stdout（供编排消费）。

**输入**（`tenon sync` CLI，经单文件 bundle `packages/cli/dist/tenon.mjs`）：
- `tenon sync`（默认，**只报告不改盘**）
- `tenon sync --migrate`（opt-in 执行路径迁移；breaking 升级必须显式带）
- `tenon sync --allow-downgrade`（CLI 版本低于项目时强制降级）
- `tenon sync banner`（项目版本戳 vs CLI 版落后 nudge，零网络）
- `tenon sync upgrade-channel`（从 `installed_plugins.json` 派生 latest/beta/rc）

## 不可阉割语义（#24 验收面；删一条视为 critical 阉割）

1. **`--migrate` opt-in 默认只报告**：sync 决策层算出该做什么（`report_only=true`），真正的迁移文件
   操作只在显式 `--migrate` 时跑。
2. **downgrade 守卫默认拒**：CLI < 项目版本且无 `--allow-downgrade` → `proceed=false`、**不写任何东西**、
   直接 return；`--allow-downgrade` 才放行（`downgrade_action=downgrade`）。拒绝时明示两条出路（stderr）。
3. **顺序铁律**（`cmdSync` 主流程）：downgrade-guard（拒即整体 return）→ `needs_codex_upgrade`（读裸未剪
   清单，**必须先于 prune**，否则 legacy marker 被当孤儿剪掉、探测永远 false）→ prune（codex marker
   进 known、persist 仅 `--migrate`）→ config-section 注入门 → `--migrate` 硬闸。
4. **config-section 注入门**：仅 `cli>project ∧ project≠unknown` 才 `inject_config_sections=true`
   （downgrade / 同版 / unknown 一律抑制，绝不往老/未知项目塞它不认识的新配置段）。
5. **`--migrate` 硬闸不可降级为提示**：`pending>0 ∧ !migrate ∧ cli>project ∧ ≠unknown` 进 breaking 判定；
   `breaking ∧ recommend_migrate` 双真 → `decision=required`、**exit 1**（打印 MIGRATION REQUIRED）；
   否则 `decision=tip`、exit 0。
6. **unknown 一等态**：缺 `.pipeline-version` → `project=unknown`；任何真实版 `> unknown`，不误触发降级闸、
   不注入 config、不进硬闸窗口。
7. **channel 派生不可省**：`upgrade-channel` 从 `installed_plugins.json` 按当前插件版本后缀派生
   latest/beta/rc（`-beta` 先于 `-rc` 判），让 beta/rc 用户不被甩回 latest。**绝不读真实
   `~/.claude/.../installed_plugins.json`**——文本由调用方注入（测试传 fixture）。
8. **横幅纯本地**：`banner` 只比对项目 `.pipeline-version` vs CLI 版，**零网络请求**；
   cli>project → `update` 方向，cli<project → `upgrade` 方向，同版/unknown → 静默无输出。

## 报告 JSON 关键字段（`stage=sync`）

`proceed` / `downgrade_action` / `project_version` / `cli_version` / `pending_count` /
`codex_upgrade_needed` / `codex_block`（AGENTS.md 的 Codex 受管块：`absent` / `current` / `stale` /
`invalid` / `refreshed`；`stale` 只在 `--migrate` 时就地刷新 START…END，块外内容不动）/
`pruned`（被剪键）/ `pruned_persisted` / `inject_config_sections` /
`migrate_flag` / `migrate_gate`（`{decision, exitCode, messages}`）/ `report_only`。
按 `migrate_gate.decision` 行动：`required`（exit 1）停手、提示重跑 `--migrate`；`tip` 软提示；`ok` 可安全同步。

## 诚实 stub（未伪造）

**迁移注册表 + 执行器未在 lite 移植**（老仓 `migrations.py` 版本→迁移表 + `migrate-exec.py` 备份先行/
hash 闸/根守护三闸执行器——独立子系统、属未收编里程碑）。故 `pending`/`metadata` 由注入的
`SyncMigrationProvider` 提供，缺省 STUB = 空 pending + 无 breaking：**决策层全量可跑并真测**，但
「真跑迁移落盘」面标为 stub、不伪造。sync 的版本比较 / 降级守卫 / prune / config 门 / 硬闸决策 /
banner / channel **全部已实现并有真 fs e2e**。

## 接线备注（主会话收编）

命令已实现但尚未注册进 `packages/cli/src/program.ts`（受管共享文件）。收编步：在 program.ts 加
`.command('sync [sub]')` + `--migrate` / `--allow-downgrade`，action 调
`cmdSync(deps, { sub, cliVersion: <plugin 版本>, migrate, allowDowngrade, installedJson })`——
其中 `cliVersion` 从 `.claude-plugin/plugin.json` 版本注入、`installedJson` 由 main.ts 读文件后传入；
并把 `sync.ts` 的相对桥 import 改回 `@tenon/kernel`（待 barrel 导出 ownership）。
