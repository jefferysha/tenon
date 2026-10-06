# 修已知错误与工程债

## 需求（均已在 2026-09-29 核实）

- F1 Codex 受管块过时：`templates/generated/codex-agents-block.md` 仍写「分派当前 phase Skill」，phase 技能已删除。改为与单一 `tenon` 技能一致的文案；同步检查 `scaffold/index.ts:37`、`manifest.yaml:74`、`codex-skill-receipt.sh:59` 等残留说法；已安装用户在 `tenon sync` 时刷新受管块。
- F2 文档说 1.x Release 与标签已删除，实际 16 个仍在：README.md、README.en.md、docs/usage/installation.md（中英）、release-notes 的相关句子改为「计划在 v0.x 真实宿主验收后删除」，直到 v02-acceptance-release 真删后再改回。
- F3 Playwright / e2e 目录产物打不开：`collect.ts` 把目录记成 `outputs/<dir>`，`serverGetTestRoutes.ts:201` 只允许普通文件 → 403。记录目录内文件索引，下载路由支持目录内文件（仍防逃逸），截图识别目录内图片。补目录产物的端到端测试。
- F4 门禁三档：工作流页门禁有「无 / 评审 / 自动」，用户规则只有评审与自动。查清 `gate: null` 与 `gate: auto` 在内核的差别；若等价，页面只留两档，`null` 显示为自动；若不等价，按内核真实语义命名并报告。
- F5 验证阶段同时出现 `verification-report` 与 `verification_report`（文档契约 kind 与字段名），同一概念两个名字。统一显示一个名字（以文档 kind 为准，字段在 Tooltip）。
- F6 时钟依赖的不稳定测试：`kernel/src/mem/relatedSearch.ts` 发现时限用真实 `Date.now()`，`server/src/relatedSessionMemory.test.ts` 在负载下失败。注入时钟，测试用假时钟。
- F7 架构门禁不检查前端 `.ts`：`tools/check-architecture.mjs:315` 对 dashboard-app 非 `.tsx` 直接返回。纳入 `.ts` 并拆分超限文件（useWorkflowEditor.ts 718、useProjectSelection.ts 502、api/taskPlanClient.ts 961、snapshotDecoder.ts 748、governanceSchema.ts 647、workbenchDefinition.ts 441）。
- F8 hosts 过滤从不生效：`skills/tenon/SKILL.md:87` 调 `tenon agent prompt` 不传 `--host`。补上并测试。
- F9 gate hook 误拦：`hooks/gate.sh:41-53` 用整段输入做 case 匹配，写一份仅提到 `.tenon/users/.../tests/` 的文档也被拒。改为只解析 tool_input.file_path（Codex apply_patch 解析补丁头路径）。保留 bash 3.2 线性解析约束。
- F10 CI 死步骤：`ci.yml:92` 装 Chromium、`ci.yml:168` 设 `TENON_REQUIRE_REAL_BROWSER` 但无人读取。保留安装并由 v02-dogfood-e2e 接上真实 e2e；本任务先删除无人读取的变量。
- F11 `automation/src/sdk/sdk.ts:76` 过时报错文案「尚未接线」。
- F12 CONTRACT.md 与 cli-reference 缺 `tenon user` / `tenon owner`。

## 验收
每条有对应测试或门禁证明；全部门禁链通过。

## 追加（2026-09-29 集成时发现）
- F13 全量 `npm test` 在 16 核默认并发下，真实文件系统的端到端测试会超 15s/30s 时限（单独跑都过）。给根 vitest 配置设合理的 maxWorkers 上限或把这类集成测试的超时统一上调，并保证 CI 与本地一致。
