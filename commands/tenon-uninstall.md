---
name: "Pipeline: Uninstall"
description: 安全卸载 pipeline——消费 .pipeline-owned.json 所有权 hash 清单、只删自己装的、用户改过的保留
category: Workflow
tags: [workflow, pipeline, uninstall, cleanup]
---

# /pipeline-uninstall — 安全卸载

把当前项目里 pipeline 装入的资产安全移除：**只删所有权清单（`.pipeline-owned.json`）里登记、且
未被用户改动的文件**，**绝不盲扫** `.codex/` `.claude/` `.opencode/` 等用户运行时数据目录。
对标 Tenon contract `tenon uninstall`（命名对齐：`.template-hashes.json` ↔ `.pipeline-owned.json`、
`TENON:START/END` ↔ `PIPELINE:<TAG>:START/END`，如 `PIPELINE:CODEX:START`）。

实现真相源（已落地 · BACKLOG #24）：所有权 hash 追踪纯逻辑在
`packages/kernel/src/state/ownership.ts`；卸载命令在 `packages/cli/src/commands/uninstall.ts`
（`cmdUninstall(deps, opts, fs?)`）；真实 e2e 证据在 `packages/cli/src/sync-uninstall.integration.test.ts`。

**输入**（`tenon uninstall` CLI，经单文件 bundle `packages/cli/dist/tenon.mjs`）：
- `tenon uninstall`（无 `--yes` → fail-closed 拒绝：脚本/非交互环境必须显式确认）
- `tenon uninstall --dry-run`（仅预览删除计划，不动任何文件）
- `tenon uninstall --yes`（或 `-y`，确认卸载；脚本/CI 必需）

## 不可阉割语义（#24 验收面；顺序铁律，删一条视为 critical 阉割）

0. **homedir 守卫**：`cwd == $HOME` 且无旁路 → HARD STOP exit 1（会牵连 `~` 的运行时数据）；
   `TENON_ALLOW_HOMEDIR=1` 严格旁路。守卫先于任何写盘/删除。
1. **前置 1（未安装幂等）**：无 `.pipeline-owned.json` → 静默成功 exit 0。lite 无 `.pipeline/`
   工作流树，**所有权清单是唯一的安装 marker**。
2. **前置 2（损坏硬失败）**：清单存在但为空对象 `{}` / 无有效键 / 损坏 → exit 1（拒绝盲删，
   与前置 1 的 exit 0 明确区分）。
3. **prune 去毒**：`known = 清单自身`（清单由有纪律的写记录构建、本身即权威所有权列表），退化为
   根 `AGENTS.md` 仅含成对合法的 `PIPELINE:<TAG>:START`+`PIPELINE:<TAG>:END` 受管块才剥离 + `.pipeline/*` 恒留；
   persist 仅在 `pruned>0` 且非 dry-run 时落盘。
4. **所有权 hash 升格删除决策（对老仓的改进承诺）**：
   - **不透明文件**（`.md`/`.sh`/`.py`/…）：磁盘内容 hash **== 清单记录 hash → 删**（是我装的、没被动过）；
     **!= → 保留**（用户改过，绝不误删）。无基线 hash → 保守判「改过」保留。
   - **结构化配置**（`hooks.json`/`settings.json`）：走 scrubber **逐条剥离本插件注入的 hook 条目、
     保留用户自有 hook 与其它顶层键**（命令末位 token 精确/后缀匹配，绝不 substring，防误删用户 hook）；
     剥到 root 无键才转整删。
   - **磁盘缺失**：清单内但已不在盘 → 跳过、只计数（`user_deleted` 尊重删除、不重建）。
5. **降级可见（GOAL B8）**：卸载计划显式分五栏——删除 / 修改（scrub 写回）/ 保留（user-modified）/
   **stub 跳过**（下方诚实 stub）/ missing。用户一眼看清哪些面此刻真的在生效、哪些被保守跳过。
6. **dry-run 短路**：`--dry-run` 在 render 之后 return exit 0，绝不执行、不改盘。
7. **confirm fail-closed**：非 dry-run 必须 `--yes`，否则 exit 1（等价老仓非 TTY 分支：无确认拒绝删除）。
8. **execute 五步严格保序**：写回 scrub mods（最先，保用户数据）→ unlink present 删除（per-file
   best-effort）→ `rm -rf .pipeline/`（存在才）→ cleanup 空受管子目录（双守卫，绝不越界/删平台根）→
   final_pass 删空平台根（段数降序）。收尾删 `.pipeline-owned.json` + `.pipeline-version`（卸载后不留残清单）。

## 诚实 stub（未伪造，降级可见）

以下 scrubber 面在 lite **未实现**，卸载时对应文件**保守保留不删**并在计划里标注 `stub`：
- `.opencode/package.json`（opencode 平台依赖剥离）、`.pi/settings.json`（pi 扩展/技能条目剥离）、
  `.codex/config.toml`（codex 配置行剥离）、tap 采集清理。
理由：lite 随包只装于 CC/codex，不投递 opencode/pi；codex-config 注入面与 tap 采集面属未收编里程碑
（A5/A7），移植它们需各平台真实注入 fixture 才能真测——无真 fixture 的「真剥离」是伪测试，故诚实标 stub。
**真剥离面**（CC/codex 的 `settings.json`/`hooks.json` nested/flat scrubber）已全量实现并有真 fs e2e。

## 接线备注（主会话收编）

命令已实现但尚未注册进 `packages/cli/src/program.ts`（受管共享文件）。收编步：在 program.ts 加
`.command('uninstall')` + `--yes/-y` + `--dry-run`，action 调 `cmdUninstall(deps, { yes, dryRun })`；
并把 `uninstall.ts` 的相对桥 import 改回 `@tenon/kernel`（待 barrel 导出 ownership）。

完成后向用户报告：删除 / 修改 / 保留（user-modified）/ stub 跳过 / missing 五类计数，及 `.pipeline/`（如有）与清单已收尾。
