# 验证报告

## 验证范围

任务 rework-document-mechanism（文档机制重做），候选为分支 `tenon/rework-document-mechanism` 在基点 origin/main `f474225f` 上的全部未提交改动（约 292 个文件，生产代码 `packages/*/src` 216 个文件，+5147 / −4460 行）。

逐条对照的需求来源：提案 `openspec/changes/rework-document-mechanism/proposal.md` 的「可验证结果」、delta spec `specs/step-output-lineage/spec.md` 的 6 条 Requirement、设计 `docs/superpowers/specs/rework-document-mechanism-design.md` §2–§14、实现计划 Task 1–9 与 Review Focus 五条。

| 可验证结果 | 证据 |
| --- | --- |
| `default.yaml` 不再为每一步列输入输出文档、没有 `document_contract` | `packages/kernel/src/workflow/default-yaml-rules.test.ts`；`check:default-workflow-freshness` 重新生成前后一致 |
| 新任务每次离开步骤记下新增 / 修改 / 删除与来源技能（或「未知」） | `step-checkpoint.test.ts`、`step-outputs.test.ts`、`observed-documents.integration.test.ts`（新后端任务走完）；`tools/test-bundle.sh` 的账本断言（`proposal.md` 新增、来源 `openspec-propose`） |
| 下一步 `read-documents` 只列直接上游的文档，没读完不能离开（终止除外） | `step-outputs-model.test.ts`（`handoffInputs`）、`transition-application` 观察模式用例、`observed-documents.integration.test.ts`（规格步只列调研产出、读前 `spec-complete` 被拒） |
| adr←brainstorming 契约删除；`spec: none` 与 Spec Kit 风格工作流同样生效 | `observed-documents.integration.test.ts` 的轻量任务与 Spec Kit 用例；`validate.test.ts` 拒绝 `document_contract` |
| Dashboard 工作台显示真实产出，工作流页没有输入输出表 | `packages/server/src/stepIo.test.ts`；dashboard `stageIo` / `StageIoPanel` / `StageEditorPane` 单测；e2e `workspace-io.spec.ts`、`workspace-ended.spec.ts`、`workflow.spec.ts` |
| 旧快照任务照旧走完；新轻量与后端任务各走完一遍 | `observed-documents.integration.test.ts` 旧快照用例；改用 `initLegacyContractDefault` 的契约模式集成测试；本任务自身就运行在旧快照（契约模式）上 |

## 执行命令

实现步（候选未变，结果仍有效）：

- `tenon test run rework-document-mechanism --stage`（run `20261013T002548Z-d10d9e`）：dashboard-app-unit、tools-node、docs-site-unit、oracle-unit、typecheck-packages / web / e2e 全部通过；unit 3 个用例超时（见「失败与阻塞」）。
- `tenon test run rework-document-mechanism --suite unit`（run `20261013T004645Z-947158`）：11441 通过 / 0 失败 / 18 跳过。
- `tenon test run rework-document-mechanism --suite bundle`（run `20261013T003855Z-6c5281`）：87 通过 / 0 失败（含迁到新机制后的账本断言）。
- 主线回归（Task 9，build-complete 之前）：`npm run build`；`check:default-workflow-freshness`、`check:dashboard-dist-freshness`、`check:adapter-capabilities-freshness`；`npm run test:e2e -- --project=chromium`（146 通过）、`--project=webkit`（144 通过，2 跳过）；`npm run oracle`（双跑 0 处不一致）；`npm run test:hooks`（2222 通过）；`bash tools/verify-skills.sh`；`check:docs`、`check:document-templates`、`check:repository-hygiene`、`check:architecture`。
- 实现前就绪审查（Sonnet，按验证步评审口径）：无 medium 及以上发现。

验证步（候选 `workspace:sha256:c1c6042a…`，与实现步相同）：

- `tenon test run rework-document-mechanism --stage`（run `20261013T010113Z-cd98fc`，9 个套件）。
- `tenon test run rework-document-mechanism code-size`（run `20261013T005816Z-c1caef`）。
- 评审者（`tenon agent prompt` → 子代理 → `tenon agent record`）：spec-consistency、backend-quality、security、code-size（必需），architecture（参考）。

## 结果

验证步测试（run `20261013T010113Z-cd98fc`，全部通过）：

| 套件 | 结果 |
| --- | --- |
| unit | 11441 通过 / 0 失败 / 18 跳过 |
| dashboard-app-unit | 1955 通过 / 0 失败 |
| tools-node | 228 通过 / 0 失败 |
| docs-site-unit | 2 通过 / 0 失败 |
| hooks | 2222 通过 / 0 失败 |
| adapters | 397 通过 / 0 失败 |
| migration-cas | 13 通过 / 0 失败 |
| oracle-unit | 19 通过 / 0 失败 |
| oracle | 16 通过 / 0 失败 |

代码规模（`code-size`）：不通过，唯一超限指标是 `lines_added` 23379（上限 2000）；`files_changed` 314、`lines_deleted` 13686、`largest_added_lines` 6117（`packages/cli/dist/tenon.mjs`，生成产物）。新增行的构成（主线按路径分类统计）：dist 生成物约 1.05 万行，测试与旧快照夹具约 9 千行，中英文文档与规格约 5.5 千行，生产源码约 3.5 千行（删除约 1.8 千行）。已登记测试豁免 `--test code-size`，待用户在 verify-pass 评审确认时批准。

评审者（同一候选）：

| 评审者 | 必需 | 阻断级 | 结论 | 发现 |
| --- | --- | --- | --- | --- |
| spec-consistency | 是 | medium | pass | 1 low |
| backend-quality | 是 | medium | pass | 5 low |
| security | 是 | medium | pass | 2 low |
| code-size | 是 | medium | pass | 3 low |
| architecture | 否 | high | pass | 2 medium、3 low |

追溯矩阵（下方「测试体系」，由 `tenon test report` 生成）里各场景显示「未覆盖」：本任务的测试计划按套件与测试文件登记（17 个套件、124 个测试文件），没有逐条登记「场景 → 用例」映射，本步的 `next` 也没有要求映射；场景的实际覆盖见上方「验证范围」的对照表与对应测试文件，它们都在本步通过的 unit / dashboard-app-unit 套件里。

code-size 评审者提示的「`packages/automation/src/triage/workflow-run-create-repository.ts` 可能是夹带」已由主线核对：该文件只把 `documentContract` 的判定由 `governed` 改为 `mode === 'contract'`，即设计 §9 的分流点，属于本任务范围。

## 失败与阻塞

- 实现步第一次 `--stage` 运行中 unit 套件 3 个用例超时（30 s）：`advance.integration.test.ts` 的「guard 不过时真不推进」「--dry-run 真不改盘」，`transition-effects.integration.test.ts` 的「pm track 豁免双 review」。原因是同机另一个 worktree（simplify-test-settings）的测试同时在跑，负载约 8–13；三个用例都用旧快照（契约模式）任务，不经过本任务新增的检查点路径。单独运行这两个文件 41 个用例全部通过（单个 2.5–4 s），负载回落后整套重跑 11441 通过、0 失败。
- `tools/test-bundle.sh` 改过且点名 `.tenon-runtime-home`，hook 不允许 agent 直接运行；用户信任测试目录后改由 `tenon test run --suite bundle` 运行并通过。

## 剩余风险

architecture（参考评审者）的两条 medium，低于它的阻断级 high，留作后续重构，不在本任务内改（改动会使候选失效、全部评审与测试重跑）：

- `state/step-output-ledger.ts` 从 `workspace/step-checkpoint.ts` 引入检查点类型与常量（state 依赖 git 基础设施模块）；后续把 `StepCheckpoint`、路径上限与 `isCommitId` 下沉到无 I/O 的 model 模块。
- `documents/step-outputs.ts` 的 `matchingFileExists`（观察不可用时的有界目录遍历）放在应用层；后续移到 `workspace/`。
- 同源的 low：`readStepOutputs` 的纯聚合可抽到 model；`documents.mode` 的判断散在约 15 处，可统一成一个谓词。

验证步评审者的 low 发现：`workingFileSha` 把 `ELOOP` 当作删除；中间段为符号链接目录时摘要可读到项目外文件（账本被篡改才触发）；`cat-file --batch` 整份读入内存（64 MiB 后降级 truncated）；`upsertVisit` 裁剪最坏 O(n²)；退化遍历只限条目数不限耗时；三份集成测试支撑文件可能有可抽取的重复夹具。

实现前就绪审查与其它已知项，均为 low，主线判定不阻断：

- 账本损坏时放弃边（终止任务）同样失败关闭；删掉 `.pipeline-step-outputs.json` 可恢复（设计 §5 的豁免只针对未读输入）。
- 账本逼近 4 MiB 时按「丢最旧的已离开访问」驱逐，极端情况下可能丢掉直接上游访问，交接输入随之为空。
- 转换在写离开记录后、提交前失败再重试时，沿用首次算出的产出（检查点已清空，无法重算）。
- 观察不可用时必须产出退化为存在检查，`exact` 路径不校验符号链接是否指出项目（只泄露一个存在性比特，且需工作流作者可控）。
- `tenon init` 写首个检查点失败（磁盘级 I/O 错误）会留下半建任务。
- 来源标注按修改时间尽力而为，同秒、`git checkout` / rebase 重写文件时可能不准；原生 task-planner 调用可能被当作技能加载。
- N-1（v0.3.1）CLI 读新机制任务时打印「step 投影不可用」（不认识 `required-output`），`get` / `status` 仍退出 0。
- 观察模式上下文包预览的真实 trusted reader 只在 Linux 可走到，本机只验证了接线与账本映射。
- 已结束任务：任务目录内的文档归档后不出现在下一步输入，`required` 为空。
- `WbStepDef` 仍带空的 `inputs` / `outputs` / `artifacts` 字段；`track-reference-validation` 仍遍历 `step.artifacts`（存储校验已拒绝，路径不可达）。
- 代码规模超过验证步上限（`lines_added` 23379 > 2000），已登记测试豁免，须用户在 verify-pass 评审确认时批准；评审者的低效能抽查（Sonnet，effort low）只覆盖了部分文件，未覆盖部分由实现前就绪审查与全量测试兜底。

## 测试

<!-- tenon:tests:start digest=sha256:39d3c52be1f18528873744e7ad707b18dcd510821e0d2f6312e5c1af7f5e0feb -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 验证 | 代码规模 `code-size` | code-size | 失败 | 0 | 0.4s | jefferySha | 2026-10-13T00:58:17.990Z | `workspace:sha256:c1c6…` |
### 失败
- `code-size`：metric-threshold — `.tenon/users/710227704-at-qq.com/tests/rework-document-mechanism/20261013T005816Z-c1caef.json`
### 命令
- `code-size`：`tenon test code-size --json`（cwd `.`）
<!-- tenon:tests:end -->

<!-- tenon:test-report:begin -->
## 测试体系

### 追溯矩阵
| 场景 / 任务 | 用例 | 最近结果 | 状态 |
| --- | --- | --- | --- |
| context-bundle-handoff · A recorded source has drifted `spec:context-bundle-handoff/A recorded source has drifted` | — | — | 未覆盖 |
| context-bundle-handoff · Policy determines input order and reasons `spec:context-bundle-handoff/Policy determines input order and reasons` | — | — | 未覆盖 |
| context-bundle-handoff · An observed Change bundles its handoff inputs `spec:context-bundle-handoff/An observed Change bundles its handoff inputs` | — | — | 未覆盖 |
| declarative-document-governance · Legacy required stays compatible `spec:declarative-document-governance/Legacy required stays compatible` | — | — | 未覆盖 |
| declarative-document-governance · A new definition declaring a contract is rejected `spec:declarative-document-governance/A new definition declaring a contract is rejected` | — | — | 未覆盖 |
| declarative-document-governance · Default heavy branches stay governed `spec:declarative-document-governance/Default heavy branches stay governed` | — | — | 未覆盖 |
| declarative-document-governance · A lite branch in a governed Workflow has no ledger `spec:declarative-document-governance/A lite branch in a governed Workflow has no ledger` | — | — | 未覆盖 |
| declarative-document-governance · Short Workflow selects compact governance `spec:declarative-document-governance/Short Workflow selects compact governance` | — | — | 未覆盖 |
| declarative-document-governance · Short Workflow omits governance `spec:declarative-document-governance/Short Workflow omits governance` | — | — | 未覆盖 |
| declarative-document-governance · An in-flight contract Change keeps its contract `spec:declarative-document-governance/An in-flight contract Change keeps its contract` | — | — | 未覆盖 |
| declarative-document-governance · Producer does not match the owner step `spec:declarative-document-governance/Producer does not match the owner step` | — | — | 未覆盖 |
| declarative-document-governance · Document changes after implement read `spec:declarative-document-governance/Document changes after implement read` | — | — | 未覆盖 |
| document-evidence-contract · Default change initializes the ledger `spec:document-evidence-contract/Default change initializes the ledger` | — | — | 未覆盖 |
| document-evidence-contract · New default change has no ledger `spec:document-evidence-contract/New default change has no ledger` | — | — | 未覆盖 |
| document-evidence-contract · In-flight contract change keeps its ledger `spec:document-evidence-contract/In-flight contract change keeps its ledger` | — | — | 未覆盖 |
| document-evidence-contract · Legacy custom change remains compatible `spec:document-evidence-contract/Legacy custom change remains compatible` | — | — | 未覆盖 |
| document-evidence-contract · Spec cannot advance without delta spec and plan evidence `spec:document-evidence-contract/Spec cannot advance without delta spec and plan evidence` | — | — | 未覆盖 |
| document-evidence-contract · Server transition cannot bypass document checks `spec:document-evidence-contract/Server transition cannot bypass document checks` | — | — | 未覆盖 |
| document-evidence-contract · An observed change is not asked for kind records `spec:document-evidence-contract/An observed change is not asked for kind records` | — | — | 未覆盖 |
| document-evidence-timeline · A current document has a matching read receipt `spec:document-evidence-timeline/A current document has a matching read receipt` | — | — | 未覆盖 |
| document-evidence-timeline · A historical receipt does not match the current proof `spec:document-evidence-timeline/A historical receipt does not match the current proof` | — | — | 未覆盖 |
| document-evidence-timeline · An observed step shows what it produced `spec:document-evidence-timeline/An observed step shows what it produced` | — | — | 未覆盖 |
| document-evidence-timeline · An older server omits optional provenance `spec:document-evidence-timeline/An older server omits optional provenance` | — | — | 未覆盖 |
| document-evidence-timeline · A malformed provenance object arrives `spec:document-evidence-timeline/A malformed provenance object arrives` | — | — | 未覆盖 |
| document-evidence-timeline · The workflow page has no IO tables `spec:document-evidence-timeline/The workflow page has no IO tables` | — | — | 未覆盖 |
| effective-workflow-plan · Lite branch in a governed Workflow is ungoverned `spec:effective-workflow-plan/Lite branch in a governed Workflow is ungoverned` | — | — | 未覆盖 |
| effective-workflow-plan · A frozen contract plan keeps contract mode `spec:effective-workflow-plan/A frozen contract plan keeps contract mode` | — | — | 未覆盖 |
| effective-workflow-plan · Step Skills come only from YAML `spec:effective-workflow-plan/Step Skills come only from YAML` | — | — | 未覆盖 |
| step-output-lineage · 离开调研步时记下写出的文档 `spec:step-output-lineage/离开调研步时记下写出的文档` | — | — | 未覆盖 |
| step-output-lineage · rebase 带进来的上游改动不算本步产出 `spec:step-output-lineage/rebase 带进来的上游改动不算本步产出` | — | — | 未覆盖 |
| step-output-lineage · 非 git 项目照常转换 `spec:step-output-lineage/非 git 项目照常转换` | — | — | 未覆盖 |
| step-output-lineage · 升级前创建、没有检查点的任务从下一步开始观察 `spec:step-output-lineage/升级前创建、没有检查点的任务从下一步开始观察` | — | — | 未覆盖 |
| step-output-lineage · 两个技能先后写出的文件各自标注 `spec:step-output-lineage/两个技能先后写出的文件各自标注` | — | — | 未覆盖 |
| step-output-lineage · 先于任何技能加载写出的文件来源未知 `spec:step-output-lineage/先于任何技能加载写出的文件来源未知` | — | — | 未覆盖 |
| step-output-lineage · 规格步只读调研步的产出 `spec:step-output-lineage/规格步只读调研步的产出` | — | — | 未覆盖 |
| step-output-lineage · 代码文件不是交接输入 `spec:step-output-lineage/代码文件不是交接输入` | — | — | 未覆盖 |
| step-output-lineage · 没读完不能离开 `spec:step-output-lineage/没读完不能离开` | — | — | 未覆盖 |
| step-output-lineage · 读过后再修改不需要重读 `spec:step-output-lineage/读过后再修改不需要重读` | — | — | 未覆盖 |
| step-output-lineage · 缺设计文档不能离开调研步 `spec:step-output-lineage/缺设计文档不能离开调研步` | — | — | 未覆盖 |
| step-output-lineage · 已有的旧文件不算本任务的产出 `spec:step-output-lineage/已有的旧文件不算本任务的产出` | — | — | 未覆盖 |
| step-output-lineage · 重回规格步不要求重写 `spec:step-output-lineage/重回规格步不要求重写` | — | — | 未覆盖 |
| step-output-lineage · Spec Kit 风格的工作流 `spec:step-output-lineage/Spec Kit 风格的工作流` | — | — | 未覆盖 |
| step-output-lineage · 新任务的规格步动作 `spec:step-output-lineage/新任务的规格步动作` | — | — | 未覆盖 |
| step-output-lineage · 观察模式下旧命令被拒 `spec:step-output-lineage/观察模式下旧命令被拒` | — | — | 未覆盖 |
| step-output-lineage · 交付步仍下发规格应用 `spec:step-output-lineage/交付步仍下发规格应用` | — | — | 未覆盖 |
| workflow-definition · legacy definition `spec:workflow-definition/legacy definition` | — | — | 未覆盖 |
| workflow-definition · round-trip `spec:workflow-definition/round-trip` | — | — | 未覆盖 |
| workflow-definition · 分支新键 round-trip `spec:workflow-definition/分支新键 round-trip` | — | — | 未覆盖 |
| workflow-definition · default 含非七步分支 `spec:workflow-definition/default 含非七步分支` | — | — | 未覆盖 |
| workflow-definition · 旧的输入输出键被拒 `spec:workflow-definition/旧的输入输出键被拒` | — | — | 未覆盖 |
| workflow-definition · required-output round-trip `spec:workflow-definition/required-output round-trip` | — | — | 未覆盖 |
| workflow-tracks · 在页面上让新工作流参与路由 `spec:workflow-tracks/在页面上让新工作流参与路由` | — | — | 未覆盖 |
| workflow-tracks · 离开条件只读展示 `spec:workflow-tracks/离开条件只读展示` | — | — | 未覆盖 |
| workflow-tracks · 必须产出列在门禁段 `spec:workflow-tracks/必须产出列在门禁段` | — | — | 未覆盖 |
| 读背景资料（consolidate 设计文档 §7、归档提案「非目标」、ADR 开头说明），四路只读调研现状。 `task:1.1` | — | — | 可选 |
| 写提案、初始设计与任务清单。 `task:1.2` | — | — | 可选 |
| 写设计文档：产出观察（检查点、比较、rebase 过滤、排除规则）、来源标注、直接上游交接、读取回执、必须产出守卫、新旧分流、CLI 与 Dashboard 形态。 `task:2.1` | — | — | 可选 |
| 交互技能里的问题按推荐作答并写进设计文档；记录 ADR 与 CONTEXT.md 术语。 `task:2.2` | — | — | 可选 |
| 按调研结论更新提案、设计与任务。 `task:2.3` | — | — | 可选 |
| 写 delta spec（新 capability 与受影响的现有 capability）。 `task:3.1` | — | — | 可选 |
| 写实现计划。 `task:3.2` | — | — | 可选 |
| 登记本任务的测试计划。 `task:3.3` | — | — | 可选 |
| 计划 Task 1：kernel 检查点采集与比较（`workspace/step-checkpoint.ts`）。 `task:4.1` | — | — | 未覆盖 |
| 计划 Task 2：kernel 产出账本、领域规则与深模块（`state/step-output-ledger.ts`、`documents/step-outputs-model.ts`、`documents/step-outputs.ts`）。 `task:4.2` | — | — | 未覆盖 |
| 计划 Task 3：工作流定义——`required-output` 守卫，校验拒绝 `document_contract` / 非空 `inputs` / `outputs` / `artifacts` / `nonempty-output`，`gate: auto` 不再由 outputs 推导。 `task:4.3` | — | — | 未覆盖 |
| 计划 Task 4：kernel 计划分流（`mode`）、转换接入、`default.yaml` / `design-system.yaml` 改写与重新生成、旧快照兼容、删除 DESIGN.md 立项前置。 `task:4.4` | — | — | 未覆盖 |
| 计划 Task 5：CLI 投影、命令与 next 动作。 `task:4.5` | — | — | 未覆盖 |
| 计划 Task 6：CLI 测试迁移、端到端测试（新后端、新轻量、旧快照、Spec Kit、rebase）、oracle 与 hook 工具。 `task:4.6` | — | — | 未覆盖 |
| 计划 Task 7：server `stepIo` 与 Dashboard 显示真实产出、工作流页删除输入输出表。 `task:4.7` | — | — | 未覆盖 |
| 计划 Task 8：`skills/tenon/SKILL.md`、`docs/usage/`（中英）、`docs/CONTRACT.md`、发布说明。 `task:4.8` | — | — | 未覆盖 |
| 计划 Task 9：rebase 到最新 origin/main，重新生成生成物，跑完会写文件的回归与实现步测试。 `task:4.9` | — | — | 未覆盖 |
| 按 `next` 跑测试与评审者，写验证报告。 `task:5.1` | — | — | 可选 |
| 本地跑齐 `check:*`，开 PR，CI 全绿。 `task:6.1` | — | — | 可选 |
| 归档任务。 `task:7.1` | — | — | 可选 |

### 套件
| 套件 | 种类 | 结果 | 用例 | 覆盖率 | 运行 |
| --- | --- | --- | --- | --- | --- |
| 适配器 conformance `adapters` | integration | 通过 | 397/397 | — | `20261013T010113Z-cd98fc` |
| 单测 · dashboard-app `dashboard-app-unit` | unit | 通过 | 1955/1955 | — | `20261013T010113Z-cd98fc` |
| 单测 · docs-site 脚本 `docs-site-unit` | unit | 通过 | 2/2 | — | `20261013T010113Z-cd98fc` |
| hook 脚本 `hooks` | integration | 通过 | 2222/2222 | — | `20261013T010113Z-cd98fc` |
| 主规格迁移原子 CAS `migration-cas` | integration | 通过 | 13/13 | — | `20261013T010113Z-cd98fc` |
| golden oracle 双跑 `oracle` | regression | 通过 | 16/16 | — | `20261013T010113Z-cd98fc` |
| golden oracle harness 契约 `oracle-unit` | unit | 通过 | 19/19 | — | `20261013T010113Z-cd98fc` |
| 单测 · tools 脚本 `tools-node` | unit | 通过 | 228/228 | — | `20261013T010113Z-cd98fc` |
| 单测 · packages `unit` | unit | 通过 | 11441/11459 (18 skip) | — | `20261013T010113Z-cd98fc` |

### 仍挡出口的项
- [waiver-unapproved] 测试 代码规模（code-size） 失败（metric-threshold），豁免尚未经评审批准 → `tenon review request rework-document-mechanism --event verify-pass`
<!-- tenon:test-report:end -->
