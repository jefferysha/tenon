# 验证报告

## 验证范围

- **任务**：`simplify-test-settings`，default 工作流，backend 轨道。
- **轮次**：经 `requirements-changed` 回规格步之后的验证第 2 轮，也是本轮次上限内的最后一轮。从立项算起，这是第 5 次验证。
- **基线**：`origin/main` `33425ab0`。`build-complete` 之前（2026-10-14）再次 fetch，仍是这个提交，不需要 rebase。
- **对照文档**：
  - delta spec：`test-settings`、`step-test-waiver`、`workspace-verification-integrity`；
  - 设计文档 `docs/superpowers/specs/simplify-test-settings-design.md` §1–§14；
  - 实施计划 Task 1–15。
  - 本轮实现步没有改动已登记的规格文档。
- **改动面**（全任务）：
  - kernel 测试系统与工作流；
  - CLI 测试命令与 `next`；
  - server DTO；
  - Dashboard 测试设置与测试页；
  - hook：受保护路径、信任与状态目录的命令识别；
  - default 工作流与生成物；
  - 技能动作行、用法文档、`docs/CONTRACT.md`、发布说明。
- **不在范围内**：文档机制归并行任务（已合入 main），包括 document-contract、effective-io、`inputs` / `outputs` / `document_contract` 键与 required-output。

## 验证第 4 轮的发现与本轮修复

验证第 4 轮结论：
- **不通过**：backend-quality 报 1 条 medium。
- **通过**：spec-consistency、security、code-size，只有 low。

用户确认 `verify-fail` 后回到实现步，修复如下，都是先写失败测试。

- **backend medium：受保护目录改动的摘要看不见档位定义的变化**
  - 修复：新增 `kernel/test-system/levels-diff.ts`。`describeLevelChanges` 按生效值（`resolveLevel`）逐档逐键比较 `levels`，标出放宽或收紧。`protected-summary.ts` 的目录摘要另外列出项目级不适用声明的增、删、理由变化，理由原文不进摘要。
  - 就绪审查又发现一个问题：门槛行可能把套件命令变化挤出 8 行上限。现在门槛段（档位与不适用声明）和命令段（套件与服务）各自截断到 8 行，门槛段在前。
  - 测试：
    - `levels-diff.test.ts`；
    - `protected-summary.test.ts`，含「档位改动很多时套件命令变化不被挤掉」；
    - `review-waivers.test.ts`：`review request` 的输出含「档位 full：必需类去掉 unit（放宽）」。
  - 文档：`docs/CONTRACT.md` §14、中英文发布说明各补一句。
- **security low ×3，顺手修**：
  - **解释器内联代码**：`hooks/lib/trust-command.sh` 新增整条命令判定 `pipeline_command_inline_takes_trust`。同时满足下面两条就拒：
    1. 解释器带内联开关；只认解释器之后、第一个非开关记号之前的开关。
    2. 出现信任或状态目录字样。
  - **独立词 `tenon`**：只把独立的词 `tenon` 当作 tenon 调用，`tenon-local`、`.tenon` 不算。这条来自就绪审查的 low。
  - **新写或改过的脚本**：形态 8 的脚本扫描新增 `TEST_TRUST`、`test trust` 两个字样，拒绝时打印信任文案。不扫 `RUNTIME_HOME` / `HOME=`，因为测试隔离脚本合法地设置它们，原因写在注释里。
  - **`protected-writes.sh` 缺失**：`hooks/gate.sh` 对含信任或状态目录字样的输入失败关闭，其余照旧放行。
  - **属主校验**：`trust-store.ts` 校验信任目录与密钥的属主必须是当前用户。
  - 测试：`tools/test-hooks.sh` 新增拒绝、放行、缺库、性能夹具，共 2385 条；`trust-store.test.ts` 新增属主用例。
- **code-size low**：`dashboard-app/workspace/testsTabModel.ts` 里 `legacyRows` 与 `levelRows` 的重复构造抽成 `rowBasis`，行为不变，workspace 测试 346 条前后都全过。
- **回归暴露的 e2e 竞态**：`e2e/dashboard/workspace-ended.spec.ts` 的「菜单里没有终止」一例在 webkit 上偶发失败。
  - 根因：已结束任务的详情先渲染只有标题与 ⋯ 的占位，读到详情后整列换成 `TaskDetailPane`，⋯ 菜单随之重新挂载并关闭。用例在占位上点开菜单，约 100 ms 后菜单被换掉。
  - 这个竞态在 `origin/main` 上同样存在：用未改动的 main 导出单跑 30 次，失败 12 次。不是本任务引入的。
  - 修复：用例在点菜单前等占位消失，只改测试，不改产品代码。修复后单跑 20 次全过，修复前同一检出 20 次失败 8 次。

## 执行命令

- **重新生成**：依次运行 `npm run generate:default-workflow`、`npm run sync:skill-provenance`、`npm run build`，生成物已暂存。
- **全量回归 r9**：在 `build-complete` 之前、在含全部修复的代码上执行，依次运行：
  1. freshness 四项：dashboard dist、default workflow、adapter capabilities，以及 bundles 与暂存区逐字节一致；
  2. `TENON_E2E=1 npm test`、`npm run test:web`、`npm run test:hooks`；
  3. `bash tools/test-adapters.sh`、`bash tools/test-bundle.sh`、`bash tools/verify-skills.sh`；
  4. `npm run test:migration-cas`、`npm run oracle`；
  5. `npm run test:e2e -- --project=chromium`、`--project=webkit`；
  6. `npm run test:clean-install`、`npm run test:update-rollback`：工具根放在 `~/.cache` 下，用 Node 22.12.0；
  7. 全部 `check:*`：comments、architecture、identity、repository-hygiene、npx-package、legacy-bridge、docs、document-templates、design-scale、agents、instruction-templates、openspec、release-workflows、dependency-tree、dependencies、clean-checkout；
  8. 跑完后工作区无新增改动。
- **e2e 竞态修复之后**：在最终代码上重跑以下各项：
  - chromium e2e、webkit e2e、`npx tsc -p e2e/dashboard`；
  - freshness 三项与上面列出的全部 `check:*`（npx-package 除外，它只打包、不含 e2e）；
  - 实现步的 Tenon 阶段运行。
- **Tenon 记录的运行**：
  - 实现步：`tenon test run simplify-test-settings --stage`，运行 `20261013T185121Z-2cc8eb`，8 个套件，出口检查通过。
  - 验证步：本步的 `--stage` 与 `code-size` 运行见文末「测试」「测试体系」两节，由 `tenon test report` 生成。

## 结果

| 项目 | 结果 |
|---|---|
| 4 项 freshness | 通过 |
| `npm test`（`TENON_E2E=1`） | 786 个文件，12024 通过 / 18 跳过 / 0 失败 |
| `npm run test:web` | 1998 通过 |
| `npm run test:hooks` | 2385 通过 / 0 失败 |
| adapters / bundle | 397 / 87 通过 |
| verify-skills、migration-cas、oracle | 通过 |
| e2e chromium / webkit（最终代码） | 147 / 145 通过，0 失败 |
| `test:clean-install`、`test:update-rollback` | 通过（`ok: true`；update-rollback 10 步） |
| 全部 `check:*` | 退出码 0；竞态修复之后重跑也都是 0 |

实现步 Tenon 运行 `20261013T185121Z-2cc8eb`：

| 套件 | 结果 |
|---|---|
| unit | 12024 通过 / 18 跳过 / 0 失败 |
| dashboard-app-unit | 1998 通过 |
| tools-node | 228 通过 |
| docs-site-unit | 2 通过 |
| oracle-unit | 19 通过 |
| typecheck-packages / typecheck-web / typecheck-e2e | 退出码 0 |

就绪审查（Sonnet，按 `review_bar` 口径）做了两轮：
- 第一轮报 1 条 medium、2 条 low，都已修好；
- 第二轮复核修复，没有 medium 及以上。

## 失败与阻塞

- **webkit e2e `workspace-ended` 一例**：r9 里失败，按上面的根因修好；最终代码上 webkit 145 条全部通过。
- **实现步运行里 dashboard-app-unit 的退出码与报告不一致一次**
  - 现象：1998 条全过，但 vitest 捕获到 `AgentComposer.test.tsx` 里 Radix focus-scope 的计时器在 jsdom 拆除后触发的未处理错误，退出码为 1。
  - 本任务没有改 `AgentComposer`。
  - 按 `next` 单独重跑该套件，1998 条通过、退出码 0；之后整份阶段运行也通过。
- **code-size 步骤测试**
  - 本任务冻结的是旧运行时的 `lines_added ≤ 2000` 上限，删掉它正是本任务的目标。
  - 失败沿用 `test:code-size` 步骤测试豁免，随 `verify-pass` 评审请求交用户批准。

## 剩余风险

- **hook 的识别是尽力而为**。识别不到的写法：
  - `bash -c` 引号里的 `&&`；
  - 带参数的前缀词；
  - 内联开关前带「开关加单独一个值」的调用，例如 `node --require ./x.js -e …`；
  - 拼接或编码出来的字样；
  - 新写脚本里对状态目录的改写。

  这与既有的 `TENON_TEST_TRUST` 保护同一强度：同 UID 进程本可直接读写密钥，设计文档承认 hook 不是安全边界。另一方面，整条命令判定宁多拒，带 tenon 调用又读 `HOME` 的内联代码会被拒。
- **`protected-writes.sh` 缺失时失败关闭**：输入里出现 `trust` 等字样就拒。这属于安装缺陷，装好即恢复。
- **证据名单保留 `xml`**：未跟踪的文本类证据不进指纹，名单由规格定死。
- **非 git 目录仍认检出里的旧封存**；同一路径换成另一个仓库会继承信任，与拉取新提交同属一个信任级别。
- **升级后要重新信任一次**：git 仓库里以前写在检出里的信任不再被认，已写进发布说明。
- **实测值来自探针**：评审者提示里的实测值是探针自报，Tenon 只是从运行记录读出。
- **不可见字符**：`foldDisplayText` 不过滤零宽、LRM、ALM 与标签字符。
- **兼容**：N-1 版本读不了 `test` 与 `levels`；指纹规则变化可能让在途任务升级后出现一次 `revision-stale`。两者都已写进发布说明。
- **行数**：`hooks/lib/protected-writes.sh` 现在 639 行，比 main 的 632 行多 7 行；新增逻辑大多放在 `trust-command.sh`。

下面的「测试」与「测试体系」两节由 `tenon test report` 生成。生成它们的是已安装的旧运行时，还没有本任务的收起规则，所以场景逐条显示「未覆盖」。本任务冻结的策略不要求场景映射，这些行不构成阻断。

## 测试

<!-- tenon:tests:start digest=sha256:2f9e46c5dc46fe678ed3d4d6cd25c9f144afec674388385ad3b00c7f300d1b0b -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 验证 | 代码规模 `code-size` | code-size | 失败 | 0 | 0.4s | jefferySha | 2026-10-13T19:17:19.703Z | `workspace:sha256:3e5c…` |
### 失败
- `code-size`：metric-threshold — `.tenon/users/710227704-at-qq.com/tests/simplify-test-settings/20261013T191718Z-5e29a0.json`
### 命令
- `code-size`：`tenon test code-size --json`（cwd `.`）
<!-- tenon:tests:end -->

<!-- tenon:test-report:begin -->
## 测试体系

### 追溯矩阵
| 场景 / 任务 | 用例 | 最近结果 | 状态 |
| --- | --- | --- | --- |
| step-test-waiver · 代码变了数字随之刷新 `spec:step-test-waiver/代码变了数字随之刷新` | — | — | 未覆盖 |
| step-test-waiver · 没有失败记录 `spec:step-test-waiver/没有失败记录` | — | — | 未覆盖 |
| step-test-waiver · 评审请求里的理由不截短、也改写不了屏幕 `spec:step-test-waiver/评审请求里的理由不截短、也改写不了屏幕` | — | — | 未覆盖 |
| test-settings · 档位写进步骤 `spec:test-settings/档位写进步骤` | — | — | 未覆盖 |
| test-settings · 档位与旧策略互斥 `spec:test-settings/档位与旧策略互斥` | — | — | 未覆盖 |
| test-settings · 未知档位被拒 `spec:test-settings/未知档位被拒` | — | — | 未覆盖 |
| test-settings · 不写档位的旧工作流指纹不变 `spec:test-settings/不写档位的旧工作流指纹不变` | — | — | 未覆盖 |
| test-settings · 不写档位定义用缺省 `spec:test-settings/不写档位定义用缺省` | — | — | 未覆盖 |
| test-settings · 只改目录就能改档位含义 `spec:test-settings/只改目录就能改档位含义` | — | — | 未覆盖 |
| test-settings · 档位定义写错被拒 `spec:test-settings/档位定义写错被拒` | — | — | 未覆盖 |
| test-settings · 旧种类名的套件满足档位 `spec:test-settings/旧种类名的套件满足档位` | — | — | 未覆盖 |
| test-settings · 旧策略不受归类影响 `spec:test-settings/旧策略不受归类影响` | — | — | 未覆盖 |
| test-settings · 跑改动只跑被碰到的套件 `spec:test-settings/跑改动只跑被碰到的套件` | — | — | 未覆盖 |
| test-settings · 改动没碰到任何套件 `spec:test-settings/改动没碰到任何套件` | — | — | 未覆盖 |
| test-settings · 没写 covers 的套件给出提示 `spec:test-settings/没写 covers 的套件给出提示` | — | — | 未覆盖 |
| test-settings · 全量跑必需类、碰到才跑其他类 `spec:test-settings/全量跑必需类、碰到才跑其他类` | — | — | 未覆盖 |
| test-settings · 缺必需类 `spec:test-settings/缺必需类` | — | — | 未覆盖 |
| test-settings · 新增测试文件不用登记 `spec:test-settings/新增测试文件不用登记` | — | — | 未覆盖 |
| test-settings · 认领了却没执行 `spec:test-settings/认领了却没执行` | — | — | 未覆盖 |
| test-settings · 旧策略的逐个登记不再要求 `spec:test-settings/旧策略的逐个登记不再要求` | — | — | 未覆盖 |
| test-settings · 归档里的证据文件不算测试 `spec:test-settings/归档里的证据文件不算测试` | — | — | 未覆盖 |
| test-settings · 控制目录里的改动不算测试改动 `spec:test-settings/控制目录里的改动不算测试改动` | — | — | 未覆盖 |
| test-settings · 非源码扩展名不算测试文件 `spec:test-settings/非源码扩展名不算测试文件` | — | — | 未覆盖 |
| test-settings · 不放宽 glob `spec:test-settings/不放宽 glob` | — | — | 未覆盖 |
| test-settings · 不碰未改动的文件 `spec:test-settings/不碰未改动的文件` | — | — | 未覆盖 |
| test-settings · 改一条命令保留注释 `spec:test-settings/改一条命令保留注释` | — | — | 未覆盖 |
| test-settings · 新增套件保留注释 `spec:test-settings/新增套件保留注释` | — | — | 未覆盖 |
| test-settings · 删除套件只删自己的行 `spec:test-settings/删除套件只删自己的行` | — | — | 未覆盖 |
| test-settings · 不要求映射时报告收起 `spec:test-settings/不要求映射时报告收起` | — | — | 未覆盖 |
| test-settings · 要求映射时照旧 `spec:test-settings/要求映射时照旧` | — | — | 未覆盖 |
| test-settings · 轻量任务的测试档位 `spec:test-settings/轻量任务的测试档位` | — | — | 未覆盖 |
| test-settings · 大改动不被代码规模挡住 `spec:test-settings/大改动不被代码规模挡住` | — | — | 未覆盖 |
| test-settings · 按需启用上限 `spec:test-settings/按需启用上限` | — | — | 未覆盖 |
| test-settings · 新 worktree 不用重新信任 `spec:test-settings/新 worktree 不用重新信任` | — | — | 未覆盖 |
| test-settings · 只有改动的命令需要重新信任 `spec:test-settings/只有改动的命令需要重新信任` | — | — | 未覆盖 |
| test-settings · 伪造的 .git 指针借不到信任 `spec:test-settings/伪造的 .git 指针借不到信任` | — | — | 未覆盖 |
| test-settings · git 出错时不退回旧封存 `spec:test-settings/git 出错时不退回旧封存` | — | — | 未覆盖 |
| test-settings · 不是 git 仓库时旧信任仍然有效 `spec:test-settings/不是 git 仓库时旧信任仍然有效` | — | — | 未覆盖 |
| test-settings · git 仓库里不认检出里的旧封存 `spec:test-settings/git 仓库里不认检出里的旧封存` | — | — | 未覆盖 |
| test-settings · agent 不能写信任 `spec:test-settings/agent 不能写信任` | — | — | 未覆盖 |
| test-settings · 失败堆栈里的路径改成相对路径 `spec:test-settings/失败堆栈里的路径改成相对路径` | — | — | 未覆盖 |
| test-settings · 旧任务走完验证 `spec:test-settings/旧任务走完验证` | — | — | 未覆盖 |
| test-settings · 新增测试文件不出登记动作 `spec:test-settings/新增测试文件不出登记动作` | — | — | 未覆盖 |
| test-settings · 孤儿测试文件一条命令认领 `spec:test-settings/孤儿测试文件一条命令认领` | — | — | 未覆盖 |
| workspace-verification-integrity · e2e 被测服务的日志不让候选失效 `spec:workspace-verification-integrity/e2e 被测服务的日志不让候选失效` | — | — | 未覆盖 |
| workspace-verification-integrity · 测试输出目录里的源码仍计入 `spec:workspace-verification-integrity/测试输出目录里的源码仍计入` | — | — | 未覆盖 |
| workspace-verification-integrity · 可被加载的数据与页面仍计入 `spec:workspace-verification-integrity/可被加载的数据与页面仍计入` | — | — | 未覆盖 |
| workspace-verification-integrity · 没有扩展名的文件仍计入 `spec:workspace-verification-integrity/没有扩展名的文件仍计入` | — | — | 未覆盖 |
| workspace-verification-integrity · git 不可用时失败关闭 `spec:workspace-verification-integrity/git 不可用时失败关闭` | — | — | 未覆盖 |
| 写 proposal / design / tasks：记录测试设置的现状证据（字段、种类、登记、信任、指纹、探针）、范围、非目标与可验证结果。 `task:1.1` | — | — | 可选 |
| 按推荐定下待验证问题：每档缺省含义、轻量轨道选档、`plan` 档去留、计划里 `files` 节的去留、信任键粒度与封印密钥、旧 `test_policy` 的显示、种类别名的读取影响。 (explore) `task:2.1` | — | — | 可选 |
| 核实受影响的消费点：`test_policy` 的全部读点（kernel 求值、CLI next、agent 提示、server DTO、Dashboard），改动文件判定与认领的调用方，信任存储的读写点与 hook 受保护路径，指纹的输出目录规则。 (explore) `task:2.2` | — | — | 可选 |
| 写设计文档与 ADR，在 `CONTEXT.md` 统一「测试档位 / 档位定义 / 测试类 / 认领」术语。 (explore) `task:2.3` | — | — | 可选 |
| 写 delta spec：新增 `test-settings`，修改 `step-test-waiver`、`workspace-verification-integrity`。 (spec) `task:3.1` | — | — | 可选 |
| 写实施计划：档位与种类 → 改动判定与自动认领 → 保留注释写回 → 场景映射与追溯 → code-size → 信任存储 → 相对路径 → 指纹规则 → next 与技能 → server / Dashboard → 文档；每段写明验收命令。 (spec) `task:3.2` | — | — | 可选 |
| 登记测试计划：kernel 单测、CLI 集成测试（lite 全程、跨 worktree 信任、在途旧计划）、server 与 Dashboard 测试、hook 测试。 (spec) `task:3.3` | — | — | 可选 |
| kernel：`test` 档位的解析、编译、序列化与旧 `test_policy` 兼容；档位定义节与内建缺省；五类种类与别名。 (build) `task:4.1` | — | — | 未覆盖 |
| kernel / CLI：改动判定排除控制目录、测试文件名要求源码扩展名、按 glob 自动认领、`--auto` 只追加精确路径。 (build) `task:4.2` | — | — | 未覆盖 |
| kernel：目录写回只改被修改条目的行区间，保留注释。 (build) `task:4.3` | — | — | 未覆盖 |
| 场景映射默认不要求、追溯矩阵按需展开；default 里 `code-size` 去掉上限，豁免展示附带实际数值。 (build) `task:4.4` | — | — | 未覆盖 |
| 测试信任改为用户级存储、按「用户 + 仓库 + 命令摘要」共享，兼容旧检出信任。 (build) `task:4.5` | — | — | 未覆盖 |
| 运行记录与日志里的绝对路径改写为相对路径；测试输出目录的通用指纹规则。 (build) `task:4.6` | — | — | 未覆盖 |
| `next` 去掉 `test-register-files`，测试动作随新规则调整；同步 `skills/tenon/SKILL.md` 测试动作行。 (build) `task:4.7` | — | — | 未覆盖 |
| `templates/workflows/default.yaml` 各轨道改用 `test:` 档位并重新生成 `default-workflow.generated.ts`；更新本仓库 `.tenon/tests/catalog.yaml`。 (build) `task:4.8` | — | — | 未覆盖 |
| server DTO 与 Dashboard 测试设置单选、项目测试页显示档位定义、任务测试页调整。 (build) `task:4.9` | — | — | 未覆盖 |
| 同步 `docs/usage/`、`docs/CONTRACT.md` 与发布说明。 (build) `task:4.10` | — | — | 未覆盖 |
| 修复验证第 1 轮的 4 条 medium（先写失败测试）：证据扩展名移出 json/html/htm/zip/gz/har；报告里登记者自述文本与测试名统一转义；信任区分「不是 git 仓库」与「git 出错 / 伪造指针」；git 子进程环境清理抽成共享模块。同步文档后重新生成产物，跑全量回归。 (build) `task:4.11` | — | — | 未覆盖 |
| 修复验证第 2 轮的 2 条 medium（先写失败测试）： `task:4.12` | — | — | 未覆盖 |
| 验证第 3 轮之后： `task:4.13` | — | — | 未覆盖 |
| 验证第 4 轮之后： `task:4.14` | — | — | 未覆盖 |
| 全量单测、类型检查、hook 与 adapter 测试、Dashboard e2e 通过。 (verify) `task:5.1` | — | — | 可选 |
| 本地跑齐 `check:*`（含 `check:default-workflow-freshness`、`check:repository-hygiene`、`check:openspec`）。 (verify) `task:5.2` | — | — | 可选 |
| 提交交付物并开 PR，`gh pr checks` 全绿。 (ship) `task:6.1` | — | — | 可选 |
| 归档变更。 (archive) `task:7.1` | — | — | 可选 |

### 套件
| 套件 | 种类 | 结果 | 用例 | 覆盖率 | 运行 |
| --- | --- | --- | --- | --- | --- |
| 适配器 conformance `adapters` | integration | 通过 | 397/397 | — | `20261013T190637Z-4388b9` |
| 单测 · dashboard-app `dashboard-app-unit` | unit | 通过 | 1998/1998 | — | `20261013T190637Z-4388b9` |
| 单测 · docs-site 脚本 `docs-site-unit` | unit | 通过 | 2/2 | — | `20261013T190637Z-4388b9` |
| hook 脚本 `hooks` | integration | 通过 | 2385/2385 | — | `20261013T190637Z-4388b9` |
| 主规格迁移原子 CAS `migration-cas` | integration | 通过 | 13/13 | — | `20261013T190637Z-4388b9` |
| golden oracle 双跑 `oracle` | regression | 通过 | 16/16 | — | `20261013T190637Z-4388b9` |
| golden oracle harness 契约 `oracle-unit` | unit | 通过 | 19/19 | — | `20261013T190637Z-4388b9` |
| 单测 · tools 脚本 `tools-node` | unit | 通过 | 228/228 | — | `20261013T190637Z-4388b9` |
| 单测 · packages `unit` | unit | 通过 | 12024/12042 (18 skip) | — | `20261013T190637Z-4388b9` |

### 仍挡出口的项
- [waiver-unapproved] 测试 代码规模（code-size） 失败（metric-threshold），豁免尚未经评审批准 → `tenon review request simplify-test-settings --event verify-pass`
<!-- tenon:test-report:end -->
