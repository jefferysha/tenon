# 验证报告

## 验证范围

`consolidate-workflow-tracks` 的全部实现：内建工作流收敛为 `default`（轻量 / 产品 / 前端 / 后端）与 `design-system`；default 按 YAML 执行与三个通用离开条件；轨道分支键 `spec` / `route` / `automation` 与删除轨道登记表；`tenon assess` 与改动风险分类；`router.v6` 路由表；`tenon task finish` / `terminate` 与归档、已结束任务列表；CLI 配套（离开条件可见、`advance` 只走前进边、`--domain`）；AFK 设置来自分支；Dashboard（已结束分类与只读详情、轨道设置、只读离开条件、删除无人调用的接口）；技能、用法文档、契约与发布说明。

实现步收尾时加入的三处改动一并在范围内：`tenon test sync --prune`（清理没有套件认领的测试文件登记）；`tools/vitest.isolate-runtime-home.mjs` 清掉宿主带来的插件与运行时身份变量（`PLUGIN_ROOT` 等）；测试目录 `catalog.yaml` 只新增 e2e 套件认领 `e2e/dashboard/support/*.mjs` 一行。

验证第 1 轮打回（backend-quality 8 条 medium、code-size 1 条 medium）后，实现步第 2 轮的修复也在范围内：delete / terminate / finish 统一锁序（先项目归档锁、再任务锁）并在锁内重新评估；移动后的审计 / 提交失败降级为警告；回滚失败时保留原始原因；入口先清残留的 `task_result`；CLI 执行模型唯一判定点 `execution-cli-seam.ts` 与架构规则 `tools/execution-model-seam.mjs`；读不到计划时结论字段写入闸拒写；归档目录精确匹配 `archiveDirIsTask`（守卫与 AFK 队列共用）；每条可进 AFK 的分支必须声明 loop 的全部 phase；共享 git 测试夹具 `test-git-fixture.ts`；以及 6 条 low 修复与仓库卫生检查对一份历史测试运行记录的精确豁免。

验证第 2 轮打回（backend-quality 1 条 medium；验证步重建 dist 使冻结版本失效）后，实现步第 3 轮的修复也在范围内：
- delete 成功响应带 `warnings`，Dashboard 在终止 / 删除后用 error 气泡显示警告（`workspace.done_with_warnings`）。
- 路由里畸形百分号编码的任务名返回 400 `invalid-name`。
- 归档移动中的裸文件系统错误统一归为 `move-failed` 再回滚；`moveByOpenspec` 先读 `archive/` 再改名，改名后读失败按「认不出归档目录」处理。
- 旧引擎事件表改用 `Object.hasOwn`；`sameGuard` 改为结构比较。
- `task-lifecycle.ts` 文件头注明清残留 `task_result` 的例外。
- 新增「升级前创建的 standard 任务按冻结快照走到完结」集成用例（`lite-track.integration.test.ts`，夹具 `initLegacyStandardChange`）。
- dist 在实现步 `build-complete` 之前重建，并通过产物新鲜度检查。

验证第 3 轮打回（验证步跑 e2e 使冻结版本失效）后，实现步第 4 轮只修测试配置，不改业务代码：
- 测试目录 `catalog.yaml` 的两个 e2e 套件把 `test-results/dashboard-e2e-server`（e2e 被测服务的状态与日志目录）声明为套件输出。
- 新增 `packages/cli/src/e2e-test-outputs.test.ts`：目录漏声明，或服务状态目录改名，它都会变红。
- 写文件的回归（e2e、bundle、verify-skills、clean-install）全部改在 `build-complete` 之前跑。

对照基准：设计文档 `docs/superpowers/specs/consolidate-workflow-tracks-design.md`、delta spec `openspec/changes/consolidate-workflow-tracks/specs/`、实施计划 `docs/superpowers/plans/consolidate-workflow-tracks.md` 的 Task 1–15 与 Review Focus。

## 执行命令

经 Tenon 记录：

- 实现步第 4 轮：`tenon test run consolidate-workflow-tracks --stage`（运行 `20261011T145857Z-c01f27`：`unit`、`dashboard-app-unit`、`tools-node`、`docs-site-unit`、`oracle-unit`、三个 `typecheck-*`）。
- 验证步第 4 轮：`tenon test run consolidate-workflow-tracks --stage`（运行 `20261011T152245Z-2f2e8c`：上述单测加 `hooks`、`adapters`、`migration-cas`、`oracle`、`bench-status`、`bench-snapshot`、`bench-snapshot-large`）；步骤测试 `tenon test run consolidate-workflow-tracks code-size`（运行 `20261011T153748Z-f19f19`）。

主线另行运行的整体回归（计划 Task 15），全部在 `build-complete` 之前：

- 实现步第 3 轮：
  - 先运行 `npm run build`（CLI / server bundle 与 Dashboard dist），再跑全部 19 项 `check:*`：openspec、default-workflow-freshness、repository-hygiene、docs、architecture、comments、dependencies、dependency-tree、identity、agents、design-scale、document-templates、instruction-templates、adapter-capabilities-freshness、dashboard-dist-freshness、release-workflows、legacy-bridge、npx-package、clean-checkout。
  - 这些检查在把待交付改动临时暂存后的树上运行（freshness 检查要求产物进索引，仓库卫生检查只扫已跟踪与已暂存的文件），跑完撤回暂存。
- 实现步第 4 轮：
  - 在同样的暂存树上重跑受本轮改动影响的 7 项（repository-hygiene、comments、architecture、三项 freshness、clean-checkout）。
  - 实现步阶段测试通过后运行 `npm run test:e2e -- --project=chromium`、`npm run test:e2e -- --project=webkit`、`bash tools/test-bundle.sh`、`bash tools/verify-skills.sh`、`npm run test:clean-install`。
  - 之后实现步的测试运行仍然有效（`next` 直接给出写结论字段，没有要求重跑），证明这些回归不再改动候选版本。
- `bash tools/test-adapters.sh`、`npm run test:hooks`、`npm run oracle` 由 Tenon 阶段套件覆盖（`adapters`、`hooks`、`oracle`）。
- 验证步第 4 轮只运行 `next` 点名的测试、步骤测试、报告与评审者。

用 Tenon 测试运行时 vitest 进程的完整环境重放 `terminal-activity-hook` 与 `workflow-skill-orchestration` 两个集成测试文件，验证隔离脚本的修复（修复前 4 个用例失败、去掉 `PLUGIN_ROOT` 后 12 个通过、修复后在完整环境下 12 个通过）。

## 结果

| 套件 | 结果 |
|---|---|
| unit（验证步第 4 轮，经 Tenon） | 11057 通过 / 0 失败 / 18 跳过 |
| dashboard-app-unit（验证步第 4 轮，经 Tenon） | 1936 通过 / 0 失败 |
| tools-node / docs-site-unit / oracle-unit（验证步第 4 轮，经 Tenon） | 228 / 2 / 19 通过，0 失败 |
| hooks / adapters / migration-cas（验证步第 4 轮，经 Tenon） | 2222 / 397 / 13 通过，0 失败 |
| oracle（验证步第 4 轮，经 Tenon） | 16 通过 / 0 失败 |
| 基准（验证步第 4 轮，经 Tenon） | `bench-snapshot` 冷重建中位数 116 ms；`bench-snapshot-large` 写入后重建中位数 222 ms（门限指标 p95 < 1500 ms）；`bench-status` 中位数 149 ms |
| typecheck-packages / typecheck-web / typecheck-e2e（实现步第 4 轮，经 Tenon） | 退出码 0 |
| bundle（含 N-1 v0.3.1 互读，实现步第 4 轮） | 87 通过 / 0 失败 |
| Dashboard e2e（chromium，实现步第 4 轮） | 138 通过 |
| Dashboard e2e（webkit，CI 的独立 job，实现步第 4 轮） | 136 通过 / 2 跳过 |
| `bash tools/verify-skills.sh`（实现步第 4 轮） | 通过 |
| clean-install 验收（`npm run test:clean-install`，实现步第 4 轮） | `ok: true` |
| `check:*`（实现步第 3 轮 19 项，第 4 轮重跑受影响的 7 项） | 全部通过 |
| 代码规模 `code-size`（验证步第 4 轮） | 失败（metric-threshold）：636 个文件，新增 31948 行、删除 33634 行（净减 1686 行），超出 `lines_added ≤ 2000`；豁免已在计划里，代码变了要重新经评审批准 |

实现步第 4 轮出口检查：通过。验证步出口只剩两项待评审批准：测试目录 `catalog.yaml` 的改动、`code-size` 豁免。

下方追溯矩阵里规格场景与实现任务都显示「未覆盖」：表示没有把场景逐条映射到具体用例（本任务的测试策略不要求映射，不挡出口），不表示没有测试。每个计划任务的测试见实施计划各 Task 的 Test 与 Step 4，全部在上面的套件里运行。

## 失败与阻塞

实现步阶段测试曾两类失败，均已修复并重跑通过：

- 13 条非测试文件被登记进 `unit`（`register --auto` 把认领 glob 放宽到仓库里一个第一方工具目录下的全部 `*.test.mjs` 与 `openspec/**/*.spec.report`），登记只增不减，形成 `registered-test-not-executed` 永久阻断。修复：目录恢复为 git 版本（含被序列化器清掉的注释）后，新增 `tenon test sync --prune` 删除没有套件认领的登记。
- 5 个调用路由钩子的集成用例只在经 `tenon test run` 跑时失败（路由输出为空）。根因：经稳定启动器运行时测试进程继承 `PLUGIN_ROOT`（指向已装发布版），钩子取插件根时它优先于用例设置的 `CLAUDE_PLUGIN_ROOT`，用已装版本的模板与 CLI 处理被测源码，路由表生成失败后按设计静默退出。修复：隔离脚本一并清掉宿主插件与运行时身份变量。

验证第 1 轮的评审结论：spec-consistency 通过（7 条 low）、security 通过、backend-quality 不通过（8 条 medium：terminate 不持任务锁、移动后审计失败抛未捕获异常、回滚失败覆盖原因、崩溃后残留 `task_result`、接缝外多处判断执行模型、依赖按后缀匹配归档目录、读不到计划时结论字段放行、AFK loop 静默丢弃缺 phase 的分支）、code-size 不通过（1 条 medium：两个集成测试复制粘贴 git 夹具）。经 `verify-fail` 回到实现步逐条修复（见「验证范围」），实现步第 2 轮阶段测试与出口检查通过后重新进入验证。

验证第 2 轮的结论：
- spec-consistency、security、code-size 通过（分别 7、2、3 条 low）。
- backend-quality 确认第 1 轮 8 条 medium 中 7 条已修，仍报 1 条 medium：delete 成功响应丢 `warnings`，Dashboard 删除时审计写失败是静默的。另有 5 条 low。
- 同一轮里主线在验证步执行了 `npm run build`。实现步结束时入库的 dist 与源码不同步，重建改写了它们，与 `build-complete` 冻结的版本不一致，`verify-pass` 报 `verify-build-revision-untrusted reason=revision-stale`，只能回到实现步重新冻结。

第 2 轮已用完轮次上限 2，用户把上限调到 3，经 `verify-fail` 回到实现步做第 3 轮（见「验证范围」）。dist 改在实现步重建，验证步不再运行任何改写入库文件的命令。

验证第 3 轮：
- 测试全部通过（单测 11054 / 0 失败），评审者没有派出。
- 主线在验证步运行了 Dashboard e2e。e2e 被测服务把状态与日志写进 `test-results/dashboard-e2e-server/`，测试目录没有声明这个目录，Tenon 的候选指纹就把这些文件算进了候选。
- `build-complete` 冻结的版本因此失效，`verify-pass` 又报 `revision-stale`。日志里有随机端口与一次性登录码，无法恢复。
- 用户把上限调到 4，经 `verify-fail` 回到实现步做第 4 轮：声明该目录、补防回归测试，并把所有写文件的回归移到 `build-complete` 之前（见「验证范围」「执行命令」）。

验证第 4 轮的评审结论（四个必需评审者都在同一份候选上登记；第一次返回覆盖不足的，主线在同一次运行里要求补齐，报告开头写明了这一点）：
- spec-consistency 通过，10 条 low。所有 Requirement 与 Scenario 都有实现与测试证据，「在途 standard 任务走完」的缺口已补。low 主要是规格没写的实现细节，例如 `--prune`、`--domain`、已结束列表上限 1000、警告降级、`assess` 退出码、400 `invalid-name`、新任务仍播种旧决定字段。
- backend-quality 通过，5 条 low。第 2 轮的 1 条 medium 与 4 条 low 已修，1 条按设计接受；AFK 认领在任务锁内复核轨道与运行身份，去掉轨道登记表的外层锁后没有遗留窗口。
- security 通过，3 条 low。16 类入口与出口逐项核对。
- code-size 通过，8 条 low。
- architecture（参考评审者，阻断级别 high）通过，2 条 medium、8 条 low，都不挡出口。依赖方向干净（kernel 不依赖 cli / server / automation），分支只有一份解析，路由纯函数与 IO 分层正确，任务生命周期是 CLI 与 server 共用的可注入应用层。两条 medium 都经主线核实属实，列入剩余风险：
  - 本任务把出口报告共用的类型移进了将来要删除的旧引擎目录。
  - 路由的内建工作流名单与模板名单各有一份。

目前没有未解决的失败。

## 剩余风险

- N-1（v0.3.1）读取升级后新建的任务受限：新 default 任务的 `status` 步骤投影降级为一行警告；`lite` 任务与平铺工作流任务被拒读。已写进发布说明回滚条目（回滚前先结束这些任务），`tools/lib/n-minus-one-compat.sh` 按此精确断言。
- 平铺工作流没有地方声明 `automation`，其任务不可进入 AFK（规格只在分支上声明 `automation`）。
- 已结束任务详情的文档状态已按归档位置求值；就绪度（`workflowExecution.readiness`）仍按登记路径求值，详情页不展示它。
- WebKit e2e 只在 macOS 本机跑过；CI 的 Linux WebKit 行为要以 PR 检查为准。
- Tenon 测试登记机制的三个问题未在本任务修复，记入后续「测试设置简化」任务：`register --auto` 会放宽套件 glob；`tenon test catalog set` 写回时丢注释；git 未改动的旧归档文件被判为「本任务改动」。
- 验证步的代码规模测试上限为新增 ≤ 2000 行，本任务超出；按约定以 `tenon test waive` 申请豁免，随评审请求交用户批准。
- `bench-snapshot-large` 的冷启动全量快照（30 个项目 × 30 个进行中任务 × 60 个归档任务）中位数 2698 ms；该场景不设门限，也没有同画像基线可比，归档扫描对冷启动的影响未量化。
- 规格场景未映射到用例（见上），追溯矩阵不能单独证明每条场景都被测到。
- Dashboard 把终止 / 删除的警告拼进 error 气泡；多条警告拼接后可能很长，气泡里的显示效果没有在真实浏览器里人工看过（单测与 e2e 只验文本）。
- `moveByOpenspec` 在 openspec 成功之后判断活跃目录还在不在的 `lstat` 若抛 ENOENT 以外的错误，仍按原目录回滚，`task_result` 残留在带序号的目录上，下次 finish / terminate 会覆盖；需要 `openspec/changes/` 失去执行权限才会出现。
- 生命周期路由已对畸形百分号编码返回 400，但 `serverGetActivityRoutes.ts`（含本任务新增的 `archived=1` 读取分支）与 `serverPostExecutionRoutes.ts` 的同类写法仍会抛 `URIError`（backend-quality low）。
- 工作流保存的 catch 把写盘前的路径信任类错误也归为 500，原先属于 4xx（backend-quality low）。
- 终止 / 删除的 `warnings` 原样带内核告警，其中有本机暂存目录的绝对路径，只在持 token 的本机 Dashboard 可见（security low）。
- `router.sh` 把缓存里解码出的模式原样交给 `grep -E`；伪造缓存需要本机写权限并算出匹配的摘要（security low）。
- CI 只在 Dashboard e2e 失败时把 `test-results/` 整体作为制品上传（`ci.yml:104-114`，本任务之前就有），其中含 e2e 被测服务的一次性登录链接（2 分钟有效，服务随 job 结束）。
- 新任务的状态初始化仍写入 `build_mode`、`isolation`、`direct_override`、`branch_status` 等旧字段，default 已不检查它们（spec-consistency low）。
- 按 profile 的技能授权收窄为只认 `_all`，用户自定义 manifest 里按 profile 的拒绝项会被忽略，由分支的 `automation` 决定（backend-quality 残余风险），升级说明应点名。
- 升级前遗留的 `chat` / `free` 在途任务若记着的轨道不在冻结快照里，无法冻结 AFK 坐标，因此进不了 AFK（失败关闭，不会越权）。
- 架构 medium：`infrastructure/guard-file-context.ts:21` 与 `workflow/step-exit-report.ts:26` 依赖 `legacy-phase-manifest/phase-exit-context.ts` 里新旧引擎共用的类型（本任务把它从 `workflow/` 移进了旧引擎目录）。删除旧引擎前要先把这些类型移回中性模块。旧引擎的删除面也大于该目录，涉及 `effective-plan-build.ts`、`implicit-completion.ts`、`flow/default-event-policy.ts` 与 CLI 的 `check.ts`、`statusStep.ts`，应在删除旧引擎的任务里列出跨包清单。
- 架构 medium：`routing/router-table.ts:17` 的内建工作流名单与 `workflow/identifier.ts:16` 的 `TEMPLATE_WORKFLOW_NAMES` 各定义一份（当前都是 `default`、`design-system`）；新增内建工作流时两处要同改，否则路由会把它当作自定义工作流，先让用户选择。
- `governed-lifecycle-policy.ts` 合并 guard / action 时仍用 `JSON.stringify` 比较；编译已把 guard 归一成固定键序，实际不触发。
- 新增的旧 standard 任务用例只覆盖 code-review 评审者：这次 3 文件修复不碰鉴权、依赖、契约路径，security 按挂载规则不派发。
- 归档目录名 `<日期>-foo-2` 无法区分 `foo` 的第二份归档与名为 `foo-2` 的任务，按同一依赖放行；只在活跃目录里没有该依赖时才会走到。
- Tenon 测试信任按检出（checkout）保存：新 worktree 首次运行要用户重新信任一次，记入后续「测试设置简化」任务。

## 测试

<!-- tenon:tests:start digest=sha256:88cf648b11dc7e55a9c4eac83f74042faae86ed69c0d919c1b7bbdb69f6355d3 -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 验证 | 代码规模 `code-size` | code-size | 失败 | 0 | 0.5s | jefferySha | 2026-10-11T15:37:49.851Z | `workspace:sha256:f6a4…` |
### 失败
- `code-size`：metric-threshold — `.tenon/users/710227704-at-qq.com/tests/consolidate-workflow-tracks/20261011T153748Z-f19f19.json`
### 命令
- `code-size`：`tenon test code-size --json`（cwd `.`）
<!-- tenon:tests:end -->

<!-- tenon:test-report:begin -->
## 测试体系

### 追溯矩阵
| 场景 / 任务 | 用例 | 最近结果 | 状态 |
| --- | --- | --- | --- |
| declarative-document-governance · Legacy required stays compatible `spec:declarative-document-governance/Legacy required stays compatible` | — | — | 未覆盖 |
| declarative-document-governance · Default heavy branches stay governed `spec:declarative-document-governance/Default heavy branches stay governed` | — | — | 未覆盖 |
| declarative-document-governance · A lite branch in a governed Workflow has no ledger `spec:declarative-document-governance/A lite branch in a governed Workflow has no ledger` | — | — | 未覆盖 |
| declarative-document-governance · Short Workflow selects compact governance `spec:declarative-document-governance/Short Workflow selects compact governance` | — | — | 未覆盖 |
| declarative-document-governance · Short Workflow omits governance `spec:declarative-document-governance/Short Workflow omits governance` | — | — | 未覆盖 |
| effective-workflow-plan · Default uses the shared compiler `spec:effective-workflow-plan/Default uses the shared compiler` | — | — | 未覆盖 |
| effective-workflow-plan · Custom Workflow uses the same transition application `spec:effective-workflow-plan/Custom Workflow uses the same transition application` | — | — | 未覆盖 |
| effective-workflow-plan · Consumer reconstructs a capability from the name `spec:effective-workflow-plan/Consumer reconstructs a capability from the name` | — | — | 未覆盖 |
| effective-workflow-plan · A frozen legacy plan keeps its execution model `spec:effective-workflow-plan/A frozen legacy plan keeps its execution model` | — | — | 未覆盖 |
| effective-workflow-plan · Three-step Workflow renders three primary Todo stages `spec:effective-workflow-plan/Three-step Workflow renders three primary Todo stages` | — | — | 未覆盖 |
| effective-workflow-plan · Default retains seven primary Todo stages `spec:effective-workflow-plan/Default retains seven primary Todo stages` | — | — | 未覆盖 |
| effective-workflow-plan · Default lite track renders its own steps `spec:effective-workflow-plan/Default lite track renders its own steps` | — | — | 未覆盖 |
| effective-workflow-plan · Lite branch in a governed Workflow is ungoverned `spec:effective-workflow-plan/Lite branch in a governed Workflow is ungoverned` | — | — | 未覆盖 |
| effective-workflow-plan · Step Skills come only from YAML `spec:effective-workflow-plan/Step Skills come only from YAML` | — | — | 未覆盖 |
| normal-chat-routing · custom Track is routed `spec:normal-chat-routing/custom Track is routed` | — | — | 未覆盖 |
| normal-chat-routing · user chooses between default and custom paths `spec:normal-chat-routing/user chooses between default and custom paths` | — | — | 未覆盖 |
| normal-chat-routing · built-in Track routes directly `spec:normal-chat-routing/built-in Track routes directly` | — | — | 未覆盖 |
| normal-chat-routing · an ordinary fix is assessed first `spec:normal-chat-routing/an ordinary fix is assessed first` | — | — | 未覆盖 |
| normal-chat-routing · 普通开发请求触发 default workflow `spec:normal-chat-routing/普通开发请求触发 default workflow` | — | — | 未覆盖 |
| normal-chat-routing · 仓库规则被手工改坏 `spec:normal-chat-routing/仓库规则被手工改坏` | — | — | 未覆盖 |
| normal-chat-routing · 静态 adapter 安装规则 `spec:normal-chat-routing/静态 adapter 安装规则` | — | — | 未覆盖 |
| normal-chat-routing · A branch without route is visible but never auto-selected `spec:normal-chat-routing/A branch without route is visible but never auto-selected` | — | — | 未覆盖 |
| normal-chat-routing · Naming a Workflow selects it directly `spec:normal-chat-routing/Naming a Workflow selects it directly` | — | — | 未覆盖 |
| normal-chat-routing · An old cache is regenerated `spec:normal-chat-routing/An old cache is regenerated` | — | — | 未覆盖 |
| normal-chat-routing · A Workflow file changes `spec:normal-chat-routing/A Workflow file changes` | — | — | 未覆盖 |
| normal-chat-routing · An explanation remains ordinary chat `spec:normal-chat-routing/An explanation remains ordinary chat` | — | — | 未覆盖 |
| simple-task-routing · A bounded text correction uses the lightweight workflow `spec:simple-task-routing/A bounded text correction uses the lightweight workflow` | — | — | 未覆盖 |
| simple-task-routing · A normal developer request still triggers governance `spec:simple-task-routing/A normal developer request still triggers governance` | — | — | 未覆盖 |
| simple-task-routing · The retired simple workflow points to its replacement `spec:simple-task-routing/The retired simple workflow points to its replacement` | — | — | 未覆盖 |
| workflow-definition · legacy definition `spec:workflow-definition/legacy definition` | — | — | 未覆盖 |
| workflow-definition · round-trip `spec:workflow-definition/round-trip` | — | — | 未覆盖 |
| workflow-definition · 分支新键 round-trip `spec:workflow-definition/分支新键 round-trip` | — | — | 未覆盖 |
| workflow-definition · default 含非七步分支 `spec:workflow-definition/default 含非七步分支` | — | — | 未覆盖 |
| workflow-tracks · 按工作流与轨道解析分支 `spec:workflow-tracks/按工作流与轨道解析分支` | — | — | 未覆盖 |
| workflow-tracks · 平铺工作流不需要指定轨道 `spec:workflow-tracks/平铺工作流不需要指定轨道` | — | — | 未覆盖 |
| workflow-tracks · 轨道不存在时列出可选轨道 `spec:workflow-tracks/轨道不存在时列出可选轨道` | — | — | 未覆盖 |
| workflow-tracks · 旧轨道文件被忽略并提示迁移 `spec:workflow-tracks/旧轨道文件被忽略并提示迁移` | — | — | 未覆盖 |
| workflow-tracks · 旧工作流名给出替代命令 `spec:workflow-tracks/旧工作流名给出替代命令` | — | — | 未覆盖 |
| workflow-tracks · 工作流列表 `spec:workflow-tracks/工作流列表` | — | — | 未覆盖 |
| workflow-tracks · 实现前评审未通过时离开实现步 `spec:workflow-tracks/实现前评审未通过时离开实现步` | — | — | 未覆盖 |
| workflow-tracks · AFK 排队中的任务不能被手动推进 `spec:workflow-tracks/AFK 排队中的任务不能被手动推进` | — | — | 未覆盖 |
| workflow-tracks · 依赖任务未结束 `spec:workflow-tracks/依赖任务未结束` | — | — | 未覆盖 |
| workflow-tracks · advance 只走唯一的前进边 `spec:workflow-tracks/advance 只走唯一的前进边` | — | — | 未覆盖 |
| workflow-tracks · 已删除的检查不再阻断 `spec:workflow-tracks/已删除的检查不再阻断` | — | — | 未覆盖 |
| workflow-tracks · 升级后在途的 default 任务继续推进 `spec:workflow-tracks/升级后在途的 default 任务继续推进` | — | — | 未覆盖 |
| workflow-tracks · 在途的 standard 任务走完 `spec:workflow-tracks/在途的 standard 任务走完` | — | — | 未覆盖 |
| workflow-tracks · 轻量任务完整走完 `spec:workflow-tracks/轻量任务完整走完` | — | — | 未覆盖 |
| workflow-tracks · 探针超限后升级 `spec:workflow-tracks/探针超限后升级` | — | — | 未覆盖 |
| workflow-tracks · 评估与探针结论一致 `spec:workflow-tracks/评估与探针结论一致` | — | — | 未覆盖 |
| workflow-tracks · 点名轨道不评估 `spec:workflow-tracks/点名轨道不评估` | — | — | 未覆盖 |
| workflow-tracks · 重型信号直接进重型轨道 `spec:workflow-tracks/重型信号直接进重型轨道` | — | — | 未覆盖 |
| workflow-tracks · 新保存的工作流参与路由 `spec:workflow-tracks/新保存的工作流参与路由` | — | — | 未覆盖 |
| workflow-tracks · 兜底分支 `spec:workflow-tracks/兜底分支` | — | — | 未覆盖 |
| workflow-tracks · 终止一个未完成的任务 `spec:workflow-tracks/终止一个未完成的任务` | — | — | 未覆盖 |
| workflow-tracks · 不走 OpenSpec 的任务结束后通过 OpenSpec 校验 `spec:workflow-tracks/不走 OpenSpec 的任务结束后通过 OpenSpec 校验` | — | — | 未覆盖 |
| workflow-tracks · 已结束列表的性能 `spec:workflow-tracks/已结束列表的性能` | — | — | 未覆盖 |
| workflow-tracks · 已终止任务出现在已结束中 `spec:workflow-tracks/已终止任务出现在已结束中` | — | — | 未覆盖 |
| workflow-tracks · 在页面上让新工作流参与路由 `spec:workflow-tracks/在页面上让新工作流参与路由` | — | — | 未覆盖 |
| workflow-tracks · 离开条件只读展示 `spec:workflow-tracks/离开条件只读展示` | — | — | 未覆盖 |
| workflow-tracks · 自动修复任务的计划与轨道一致 `spec:workflow-tracks/自动修复任务的计划与轨道一致` | — | — | 未覆盖 |
| 写 proposal / design / tasks：记录两层划分与两套轨道的现状证据、范围、非目标与可验证结果。 `task:1.1` | — | — | 可选 |
| 与用户确认待验证问题：轻量轨道名称与步骤、升级方式、`.pipeline/tracks.yaml` 处理、不走 OpenSpec 的任务目录、已结束任务在工作台的显示、执行模型、写死规则逐条去留、AFK 开关与离开条件展示。 (explore) `task:2.1` | — | — | 可选 |
| 核实受影响的消费点：执行模型与规则表的全部读点、轨道级文档治理的读取方、技能矩阵、AFK 与 Dashboard 新建入口，以及在途任务按快照运行的兼容路径。 (explore) `task:2.2` | — | — | 可选 |
| 写设计文档与 ADR，统一「工作流 / 轨道 / 任务结果」术语并更新 `CONTEXT.md`。 (explore) `task:2.3` | — | — | 可选 |
| 写 delta spec：新增 `workflow-tracks`，修改 `workflow-definition`、`effective-workflow-plan`、`declarative-document-governance`、`simple-task-routing`、`normal-chat-routing`。 (spec) `task:3.1` | — | — | 可选 |
| 写实施计划：旧引擎隔离 → 轨道解析与分支键 → default 规则写进 YAML 与通用离开条件 → 轻量轨道 → 改动风险分类与 `tenon assess` → 路由表生成 → 任务归档与已结束列表 → CLI / server / automation / Dashboard → 删除清单 → 技能与文档；每段写明验收命令。 (spec) `task:3.2` | — | — | 可选 |
| 登记测试计划：kernel 单测、hook 路由夹具、default 行为集成测试、轻量轨道集成测试、评估与探针一致性、归档与已结束列表、快照基准、Dashboard 单测与 e2e、CI 检查。 (spec) `task:3.3` | — | — | 可选 |
| 旧 phase-manifest 引擎收进 `workflow/legacy-phase-manifest/`，按快照执行模型选择适配器；新计划一律 step-graph。 (build) `task:4.1` | — | — | 未覆盖 |
| 轨道解析 `resolveTrack`：分支键 `spec` / `route` / `automation`、平铺工作流单轨道；删除路由登记表、`tracks.yaml` 读取与技能矩阵叠加。 (build) `task:4.2` | — | — | 未覆盖 |
| `default.yaml` 写入全部离开条件与动作（按设计 §1b），新增三个通用离开条件；新增轻量轨道，删除对话、自由分支；删除 `standard` / `simple`；重新生成 `default-workflow.generated.ts`。 (build) `task:4.3` | — | — | 未覆盖 |
| `classifyChange` 与 `tenon assess`；改动风险探针改用同一分类。 (build) `task:4.4` | — | — | 未覆盖 |
| 路由表从工作流分支生成（`router.v6`），评估分派、并列与自定义候选、兜底；迁移 `tools/test-hooks.sh` 夹具。 (build) `task:4.5` | — | — | 未覆盖 |
| `tenon task finish` / `terminate` 与归档模块；删除「隐藏」；服务端已结束任务列表。 (build) `task:4.6` | — | — | 未覆盖 |
| CLI 配套：`check` / `status` / 结论字段写入闸读取边级 guard、`advance` 前进边规则、报错统一、旧入口报错与替代提示；AFK triage 按后端分支取计划。 (build) `task:4.7` | — | — | 未覆盖 |
| Dashboard：轨道设置可改规范与关键词、门禁段只读离开条件、工作台分类「已结束」与任务结果；删除无人调用的接口、状态与文案。 (build) `task:4.8` | — | — | 未覆盖 |
| 同步 `skills/tenon/SKILL.md`、`docs/usage/`、`docs/CONTRACT.md` 与发布说明。 (build) `task:4.9` | — | — | 未覆盖 |
| 全量单测、类型检查、hook 与 adapter 测试、Dashboard e2e 通过；快照基准 p95 < 1.5 s。 (verify) `task:5.1` | — | — | 可选 |
| 本地跑齐 `check:*`（含 `check:openspec`、`check:default-workflow-freshness`、`check:repository-hygiene`）。 (verify) `task:5.2` | — | — | 可选 |
| 提交交付物并开 PR，`gh pr checks` 全绿。 (ship) `task:6.1` | — | — | 可选 |
| 归档变更。 (archive) `task:7.1` | — | — | 可选 |

### 套件
| 套件 | 种类 | 结果 | 用例 | 覆盖率 | 运行 |
| --- | --- | --- | --- | --- | --- |
| 适配器 conformance `adapters` | integration | 通过 | 397/397 | — | `20261011T152245Z-2f2e8c` |
| 基准 · dashboard 列表快照冷重建（2 项目 × 6 任务） `bench-snapshot` | benchmark | 通过 | 0/0 | — | `20261011T152245Z-2f2e8c` |
| 基准 · dashboard 快照规模（30 项目 × 30 任务） `bench-snapshot-large` | benchmark | 通过 | 0/0 | — | `20261011T152245Z-2f2e8c` |
| 基准 · tenon status 耗时 `bench-status` | benchmark | 通过 | 0/0 | — | `20261011T152245Z-2f2e8c` |
| 单测 · dashboard-app `dashboard-app-unit` | unit | 通过 | 1936/1936 | — | `20261011T152245Z-2f2e8c` |
| 单测 · docs-site 脚本 `docs-site-unit` | unit | 通过 | 2/2 | — | `20261011T152245Z-2f2e8c` |
| hook 脚本 `hooks` | integration | 通过 | 2222/2222 | — | `20261011T152245Z-2f2e8c` |
| 主规格迁移原子 CAS `migration-cas` | integration | 通过 | 13/13 | — | `20261011T152245Z-2f2e8c` |
| golden oracle 双跑 `oracle` | regression | 通过 | 16/16 | — | `20261011T152245Z-2f2e8c` |
| golden oracle harness 契约 `oracle-unit` | unit | 通过 | 19/19 | — | `20261011T152245Z-2f2e8c` |
| 单测 · tools 脚本 `tools-node` | unit | 通过 | 228/228 | — | `20261011T152245Z-2f2e8c` |
| 单测 · packages `unit` | unit | 通过 | 11057/11075 (18 skip) | — | `20261011T152245Z-2f2e8c` |

### 基准
| 套件 | 指标 | 中位数 | 基线 | 变化 | 结论 |
| --- | --- | --- | --- | --- | --- |
| bench-snapshot | snapshot_ms | 116.351ms | 无同画像基线 | — | 无同画像基线 |
| bench-snapshot-large | snapshot_write_ms | 222.1665ms | 无同画像基线 | — | 无同画像基线 |
| bench-snapshot-large | snapshot_ms | 2697.713ms | 无同画像基线 | — | 无同画像基线 |
| bench-snapshot-large | change_detail_ms | 157.2965ms | 无同画像基线 | — | 无同画像基线 |
| bench-snapshot-large | snapshot_bytes | 937069bytes | 无同画像基线 | — | ok |
| bench-status | status_ms | 149.46ms | 无同画像基线 | — | 无同画像基线 |

### 仍挡出口的项
- [protected-file-unapproved] 测试目录 .tenon/tests/catalog.yaml（修改，sha256:8b61246a13a63730e99fe0c15763fcd812c62eac571a566ba809460795657295） 出现在本任务的改动里，需要你在评审里确认 → `tenon review request consolidate-workflow-tracks --event verify-pass`
- [waiver-unapproved] 测试 代码规模（code-size） 失败（metric-threshold），豁免尚未经评审批准 → `tenon review request consolidate-workflow-tracks --event verify-pass`
<!-- tenon:test-report:end -->
