/**
 * scaffold —— Tenon contract parity 收尾内核（BACKLOG #33 / GOAL B16 / D 系列）。
 *
 * 老仓 docs/scaffold-contract/PARITY-MATRIX.md 的 8 partial + 1 missing 逐条盘点（Tenon contract 语义 + lite 落地）：
 *
 *  ── 本模块承接（3 partial + 1 missing）──────────────────────────────────────────────
 *  ① 🟡 spec-template-scaffold（CLI init）
 *     Tenon contract：init 按项目类型铺分层空 spec 文档（backend/frontend/guides）。
 *     老仓 gap：spec 骨架靠 openspec + CONTEXT.md + docs/superpowers/specs，无按类型预写的分层空文档集。
 *     lite 落地：doc-scaffold.ts —— SPEC_DOC_LAYOUTS 按 web/cli/lib 分层，buildSpecScaffold 渲染带
 *       marker 的空 stub（explore 阶段填充）。构造性补齐等价物（非 init 死文件，是可认领骨架）。
 *
 *  ② 🟡 template-strategy-and-spec-conflict（CLI init）
 *     Tenon contract：template strategy(skip/overwrite/append) + spec-dir 冲突 AskUserQuestion prompt。
 *     老仓状态：apply_strategy 三态已齐（ROUND-13）；仍缺缺省冲突的 AskUserQuestion 交互 prompt。
 *     lite 落地：三态 = doc-scaffold.ts planDocScaffold（纯决策，对标 apply_strategy）；冲突交互 =
 *       CLI scaffold.ts 用「信号/指引」替代 picker（TENON_SPEC_STRATEGY 信号 + 三选一指引 + exit 2，
 *       对齐 reinit-fast-path 的 TENON_REINIT 风格——shell/子-agent 语境不弹无可靠 TTY 的 picker）。
 *
 *  ③ 🟡 workflow-template-resolution（CLI init）
 *     Tenon contract：--workflow / --workflow-source 解析（多 workflow id）+ removeHash 更新契约。
 *     老仓 gap：workflow.md 单一权威文件 + preset 强度变体，无多 id 解析、无 removeHash 契约。
 *     lite 落地：workflow-resolution.ts —— parseWorkflowIds（多 id 解析）+ resolveWorkflow（native
 *       offline-first）+ applyWorkflowHashContract（removeHash 非对称契约：native 记 hash / 非 native 删条目，
 *       让升级不还原 native）。CLI 增 --workflow-source 取 .md + marker（WORKFLOW_SOURCE_MARKER）。
 *
 *  ④ 🔴 known-untracked-template-allowlist（versioning，唯一 missing）
 *     Tenon contract：旧项目 pristine untracked 模板（AGENTS.md）的 hash 白名单，classify 前并入 stored。
 *     老仓判定：**N/A**——pipeline 无「无 hash→hash-track」迁移期，无对应历史包袱。老仓自留占位入口
 *       （migrations.py 空 KNOWN_UNTRACKED_ALLOWLIST + 原样返回的 apply）。
 *     lite 落地：allowlist.ts 忠实沿用同款「N/A 但留占位入口」——空常量 + pass-through 应用 + 判定函数
 *       （空白名单下全无副作用）。它不接进 ownership(#24) 的 classify 主路径，也无调用方：白名单为空时
 *       接进去是纯恒等变换，故只导出入口。填表后的接法说明在 allowlist.ts 顶注。
 *
 *  ── 非本模块（其余 5 partial，主会话/他模块归属，此处仅诚实转述其处置，不重复实现）──────
 *  ⑤ 🟡 init-command-registration（CLI init）——架构差异 N/A：tenon init 面 = track×preset×template
 *       + SessionStart hook + 入口 tenon SKILL，非 17 平台单条 init CLI。归属：init 命令/adapters。
 *  ⑥ 🟡 hardcoded-traces-journal-rename（versioning）——N/A-with-entry：老仓 migrations.py 空占位
 *       HARDCODED_RENAMES + expand_hardcoded_renames（返 []）。sibling of ④，属**版本/迁移模块**
 *       （本仓无 migrations 子系统）——不在 scaffold 范围。
 *  ⑦ 🟡 package-validation-create（task lifecycle）——create --package 名校验接线 N/A（单仓无用例）；
 *       路径→package 路由已在 kernel state/session.ts 真补（routeContext）。归属：task/monorepo。
 *  ⑧ 🟡 init-context-deprecation-guard（task lifecycle）——N/A：pipeline 从未引入 init-context；占位说明
 *       已在 kernel state/session.ts 顶注。归属：session/task。
 *  ⑨ 🟡 update-spec-on-change（living spec）——archive 合并器已落地；遗留「开发中即时回灌 + 三触发 phase 步骤」
 *       属 living-spec 子系统（kernel state/spec.ts + verify/ship 步骤），不在 scaffold 范围。
 *
 * kernel 零第三方依赖（纯字符串/集合逻辑；hash 经同包 ownership.ts 间接用 node:crypto 内建）。
 * 消费方：CLI packages/cli/src/commands/scaffold.ts（经 '@tenon/kernel' 包名导入，
 *   命令注册在 program.ts）。
 */
export * from './doc-scaffold.js'
export * from './workflow-resolution.js'
export * from './allowlist.js'
