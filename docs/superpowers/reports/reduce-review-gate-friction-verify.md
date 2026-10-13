# 验证报告

## 验证范围

任务 `reduce-review-gate-friction`（default 工作流 · backend 轨），候选为任务 worktree `.worktrees/reduce-review-gate-friction` 上未提交的全部改动（基于 origin/main 33425ab0）。覆盖三件事与它们的验收标准（proposal「可验证结果」）：

1. 受轮次约束的评审步上，轮次内回退边免评审回执；`next` 直接给 `transition`；每次成功转换后删除本任务的评审标记。
2. 评审 / 交互待处理期间，gate 放行每段都只读的组合命令，收紧会写文件或执行程序的形态；评审期放行恰好 `tenon transition <change> <event>`。
3. 拦截提示按标记种类区分，评审提示不再提 AskUserQuestion 解封。

另含规则 / 契约 / 用户文档同步与 dist 重打包。

## 执行命令

实现步收尾时（同一份代码，未再改动）：

- `tenon test run reduce-review-gate-friction --stage`（run `20261013T133709Z-b836f0`，step=build，8 个套件）
- `npm run test:hooks`（含本任务新增的只读组合矩阵、制表符与 `$IFS` 回归用例）
- `npm run check:identity`、`npm run check:docs`、`npm run build:packages`（tsc -b）
- `tenon test code-size --json`
- 修复前后对照：`bash scratchpad/ro-check.sh <lib>` 与 `ro-check-ifs.sh <lib>` 分别对修复前（df0b573c）与修复后的 `hooks/lib/read-only-command.sh` 运行

验证步的测试与评审者结果见下方「结果」中的验证步一节（由 `tenon test run --stage` 与评审者登记产生）。

## 结果

实现步证据：

| 检查 | 结果 |
| --- | --- |
| unit（vitest 全量） | 11458 通过 / 0 失败 / 18 跳过 |
| dashboard-app-unit | 1955 通过 / 0 失败 |
| tools-node | 228 通过 / 0 失败 |
| docs-site-unit | 2 通过 / 0 失败 |
| oracle-unit | 19 通过 / 0 失败 |
| typecheck-packages / typecheck-web / typecheck-e2e | 退出码 0 |
| hooks（`npm run test:hooks`） | 2426 通过 / 0 失败 |
| check:identity、check:docs | 通过 |
| code-size | files_changed 29，lines_added 918（上限 2000） |

验收标准逐条：

| 验收标准 | 证据 | 结论 |
| --- | --- | --- |
| 验证失败且轮次未用完时 `next` 是 `transition verify-fail` | `statusStep.test.ts`、`statusStepRoundsNext.test.ts`、`test-flow.integration.test.ts`、`review-residual.integration.test.ts` | 满足 |
| 直接 `tenon transition <c> verify-fail` 成功、不产生评审标记 | kernel `transition-application.test.ts`、`review.integration.test.ts`、server `transition-rounds.test.ts` | 满足 |
| 升级前遗留的回退边评审请求转换后标记被删 | `transition-effects.integration.test.ts`；kernel「删本任务标记、不碰别的任务」用例 | 满足 |
| 轮次用完后 `verify-fail` 照旧被拒 | kernel「用完后回退边被拒」、`review-residual.integration.test.ts` | 满足 |
| 前进边无回执仍拒、`roundsOf` 缺席回退仍要回执、放弃边不受影响 | kernel 与 `transition-rounds-gate.test.ts` 用例、server `transition-concurrency.test.ts` | 满足 |
| 评审待处理时 `git status --short \| grep -v x`、`cd sub && ls` 放行 | `tools/test-hooks.sh` 只读组合矩阵（评审与交互各一遍，含用户原样命令） | 满足 |
| `rg x . > out`、`ls; touch y`、`cat a \| sh`、`echo $(id)` 类拦截；收紧形态拦截 | 同上矩阵的 refuse 用例；制表符与 `$IFS` 回归用例 | 满足 |
| 评审标记提示不含 AskUserQuestion 解封说法、列出的放行语真能解封 | `test-hooks.sh` 按 kind 断言与 `GATE_REVIEW_UNLOCK_TEXT` 一致性检查 | 满足 |

### 验证步（第 1 轮 / 上限 2）

测试（Tenon 执行，结果见下方「测试体系」的套件表）：

| 运行 | 内容 | 结果 |
| --- | --- | --- |
| `20261013T134916Z-a4f8dc` | 验证阶段 9 个套件 | 8 个通过；hooks 2423/2426，3 个失败均为 `auto-update` 后台 `nohup` 调度用例（`tools/test-hooks.sh:4205-4214`，用例自带 2 秒等待窗口，满载时超时），与本次改动无关 |
| `20261013T140054Z-350bfd` | 单独重跑 hooks | 2426/2426 通过 |
| `20261013T140240Z-da3c42` | 步骤测试 code-size | 通过：files_changed 29，lines_added 918（上限 2000），largest_added_lines 227 |

评审者（候选 `workspace:sha256:1e46659e…`）：

| 评审者 | 阻断级 | 结论 | 发现 |
| --- | --- | --- | --- |
| spec-consistency | medium | pass | 2 条 low：只读判定比规格列举更严（规格是「全部满足才算只读」，不相悖）；评审提示多一句「轮次内回退可直接 transition」 |
| backend-quality | medium | pass | 5 条 low；约 55 条对抗用例在 bash 3.2 下未找到「判只读却能写 / 执行」的路径 |
| code-size | medium | pass | 1 条 low：`tools/test-hooks.sh` 持续增长，可按主题拆分 |
| architecture（参考） | high | pass | 1 条 medium：「轮次内回退免回执」规则在内核 `backEdgeRounds` 与 CLI `next` 各写一遍，建议抽共用纯谓词；3 条 low（注释与边界说明） |

追溯矩阵中的规格场景显示「未覆盖」：本工作流的场景映射策略为关闭（`scenarios: off`），本任务没有逐条 `tenon test register --case` 登记；场景与用例的对应以上方「验收标准逐条」表为准，不挡出口。

后续可做（不阻断，未在本任务内改动，避免候选变化后评审结论失效）：

- 内核导出「回退边免回执」共用谓词，CLI `next` 复用（architecture medium）。
- 评审期放行的 `tenon transition` 绑定到标记所属任务（backend-quality low）。
- 只读名单再收紧：`rg -z`、`git … --ext-diff / --textconv`（backend-quality low）。
- `review-marker` 告警的 CLI / server 渲染补用例并共用文案；TTL 注释引用同一常量（backend-quality low）。

## 失败与阻塞

实现步的收敛审查发现两条 high，均已修复并有红绿证据：

- `find .<TAB>-delete` 等制表符分隔的写入形态被判只读：段内制表符统一为空格后再匹配。修复前 3 条判只读（rc=0），修复后判非只读（rc=1）。
- `find .$IFS-delete` 经 `$IFS` 运行时拆词绕过：引号外与双引号内的 `$名字` / 特殊参数一律判非只读。修复前判只读，修复后判非只读；`"a$"`、`'$p'` 仍放行。

过程中一次 hook 套件失败是测试写法问题（断言描述里的命令替换改写了 `$?`），已修正。当前无未解决的失败。

## 剩余风险

- 评审标记下 gate 只校验 `tenon transition` 的形态，是否缺回执由 CLI 判定（设计 D12）；CLI 侧「前进边仍拒」有测试覆盖。
- 只读判定变得更保守：`ls $HOME`、`ls | head` 以外的无参数非名单命令、带本机回环地址加端口的只读命令（评审期）会被拦；属于「宁可误拦」。
- 免回执的回退不再记录「评审确认 → 转换」交互效果（设计如此）。
- Linux / bash 5 上未单独运行 hook 套件（本机 bash 3.2）；CI 的 Linux job 会覆盖。
- 主检出上另一任务的未提交改动触及 hooks 与 CLI，合入 main 时可能冲突。

## 测试

<!-- tenon:tests:start digest=sha256:db6f9d75868a1f3527e35047dfad71ceff8689029dc33c3cda874064cf538cab -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 验证 | 代码规模 `code-size` | code-size | 通过 | 0 | 0.4s | jefferySha | 2026-10-13T14:02:40.915Z | `workspace:sha256:1e46…` |
### 命令
- `code-size`：`tenon test code-size --json`（cwd `.`）
<!-- tenon:tests:end -->

<!-- tenon:test-report:begin -->
## 测试体系

### 追溯矩阵
| 场景 / 任务 | 用例 | 最近结果 | 状态 |
| --- | --- | --- | --- |
| document-evidence-contract · Explicit confirmation unlocks only the requested transition `spec:document-evidence-contract/Explicit confirmation unlocks only the requested transition` | — | — | 未覆盖 |
| document-evidence-contract · A different event cannot reuse an approval `spec:document-evidence-contract/A different event cannot reuse an approval` | — | — | 未覆盖 |
| document-evidence-contract · 轮次内回退不需要回执 `spec:document-evidence-contract/轮次内回退不需要回执` | — | — | 未覆盖 |
| document-evidence-contract · Unrelated prompt does not unlock a review marker `spec:document-evidence-contract/Unrelated prompt does not unlock a review marker` | — | — | 未覆盖 |
| interaction-and-skill-provenance · Repository inspection continues while a decision is pending `spec:interaction-and-skill-provenance/Repository inspection continues while a decision is pending` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 只读组合命令在待处理期间放行 `spec:interaction-and-skill-provenance/只读组合命令在待处理期间放行` | — | — | 未覆盖 |
| interaction-and-skill-provenance · A write disguised in a shell chain is blocked `spec:interaction-and-skill-provenance/A write disguised in a shell chain is blocked` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 名单内命令的写入形态被拦 `spec:interaction-and-skill-provenance/名单内命令的写入形态被拦` | — | — | 未覆盖 |
| interaction-and-skill-provenance · Canonical transition still requires its receipt `spec:interaction-and-skill-provenance/Canonical transition still requires its receipt` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 待处理的前进评审期间直接回退 `spec:interaction-and-skill-provenance/待处理的前进评审期间直接回退` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 升级前遗留的回退边评审请求 `spec:interaction-and-skill-provenance/升级前遗留的回退边评审请求` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 不碰其他任务的标记 `spec:interaction-and-skill-provenance/不碰其他任务的标记` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 评审标记拦下写操作 `spec:interaction-and-skill-provenance/评审标记拦下写操作` | — | — | 未覆盖 |
| interaction-and-skill-provenance · 交互标记拦下写操作 `spec:interaction-and-skill-provenance/交互标记拦下写操作` | — | — | 未覆盖 |
| plugin-runtime · Build 只完成聚焦测试但未做全量收敛审查 `spec:plugin-runtime/Build 只完成聚焦测试但未做全量收敛审查` | — | — | 未覆盖 |
| plugin-runtime · Verify 某一轨提前发现 High `spec:plugin-runtime/Verify 某一轨提前发现 High` | — | — | 未覆盖 |
| plugin-runtime · Verify-fail 修复后重试 `spec:plugin-runtime/Verify-fail 修复后重试` | — | — | 未覆盖 |
| plugin-runtime · 收敛审查仍有 Medium `spec:plugin-runtime/收敛审查仍有 Medium` | — | — | 未覆盖 |
| plugin-runtime · Verify 命令会重写 tracked 生成物 `spec:plugin-runtime/Verify 命令会重写 tracked 生成物` | — | — | 未覆盖 |
| verify-round-limit · 第一轮验证不通过直接回到实现 `spec:verify-round-limit/第一轮验证不通过直接回到实现` | — | — | 未覆盖 |
| verify-round-limit · 前进边仍要确认 `spec:verify-round-limit/前进边仍要确认` | — | — | 未覆盖 |
| verify-round-limit · 宿主没有接线轮次读取 `spec:verify-round-limit/宿主没有接线轮次读取` | — | — | 未覆盖 |
| verify-round-limit · 第二轮仍不通过 `spec:verify-round-limit/第二轮仍不通过` | — | — | 未覆盖 |
| verify-round-limit · 上限用完时回退被拒 `spec:verify-round-limit/上限用完时回退被拒` | — | — | 未覆盖 |
| verify-round-limit · 调高上限后可以回退 `spec:verify-round-limit/调高上限后可以回退` | — | — | 未覆盖 |
| verify-round-limit · 还有未登记豁免的失败测试 `spec:verify-round-limit/还有未登记豁免的失败测试` | — | — | 未覆盖 |
| verify-round-limit · 接受剩余阻断后前进 `spec:verify-round-limit/接受剩余阻断后前进` | — | — | 未覆盖 |
| verify-round-limit · 委托确认不能接受剩余阻断 `spec:verify-round-limit/委托确认不能接受剩余阻断` | — | — | 未覆盖 |
| verify-round-limit · 代码变了接受失效 `spec:verify-round-limit/代码变了接受失效` | — | — | 未覆盖 |
| verify-round-limit · 上限未用完不放行 `spec:verify-round-limit/上限未用完不放行` | — | — | 未覆盖 |
| 复述目标并写出可验证的验收标准（proposal.md 的「可验证结果」）。 `task:1.1` | — | — | 可选 |
| 清点所有宣称「回退边需人工确认」的代码、规则、文档与生成物。 (explore) `task:2.1` | — | — | 可选 |
| 确认 Dashboard 服务回退边路径与各工作流评审步回退边的就绪要求。 (explore) `task:2.2` | — | — | 可选 |
| 写 delta spec 与实现计划，并把测试计划登记好。 (spec) `task:3.1` | — | — | 可选 |
| Task 1：内核轮次内回退免回执，转换后清本任务评审标记（含两宿主告警渲染与测试）。 (build) `task:4.1` | — | — | 未覆盖 |
| Task 2：`next` 对轮次内唯一回退边直接给 `transition`（含 CLI 单测 / 集成测试）。 (build) `task:4.2` | — | — | 未覆盖 |
| Task 3：gate 只读组合判定库、评审期放行 `tenon transition`、按种类提示（含 hook 测试）。 (build) `task:4.3` | — | — | 未覆盖 |
| Task 4：规则、契约与用户文档同步（含生成物）。 (build) `task:4.4` | — | — | 未覆盖 |
| Task 5：合并后重打包 dist、全量测试。 (build) `task:4.5` | — | — | 未覆盖 |
| 全量测试、hook 套件与评审者全部通过。 (verify) `task:5.1` | — | — | 可选 |
| 提交并开 PR。 (ship) `task:6.1` | — | — | 可选 |
| 归档本任务。 (archive) `task:7.1` | — | — | 可选 |

### 套件
| 套件 | 种类 | 结果 | 用例 | 覆盖率 | 运行 |
| --- | --- | --- | --- | --- | --- |
| 适配器 conformance `adapters` | integration | 通过 | 397/397 | — | `20261013T134916Z-a4f8dc` |
| 单测 · dashboard-app `dashboard-app-unit` | unit | 通过 | 1955/1955 | — | `20261013T134916Z-a4f8dc` |
| 单测 · docs-site 脚本 `docs-site-unit` | unit | 通过 | 2/2 | — | `20261013T134916Z-a4f8dc` |
| hook 脚本 `hooks` | integration | 通过 | 2426/2426 | — | `20261013T140054Z-350bfd` |
| 主规格迁移原子 CAS `migration-cas` | integration | 通过 | 13/13 | — | `20261013T134916Z-a4f8dc` |
| golden oracle 双跑 `oracle` | regression | 通过 | 16/16 | — | `20261013T134916Z-a4f8dc` |
| golden oracle harness 契约 `oracle-unit` | unit | 通过 | 19/19 | — | `20261013T134916Z-a4f8dc` |
| 单测 · tools 脚本 `tools-node` | unit | 通过 | 228/228 | — | `20261013T134916Z-a4f8dc` |
| 单测 · packages `unit` | unit | 通过 | 11458/11476 (18 skip) | — | `20261013T134916Z-a4f8dc` |

### 仍挡出口的项
- 无
<!-- tenon:test-report:end -->
