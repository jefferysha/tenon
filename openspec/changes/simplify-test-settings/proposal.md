# 提案

## Why

上一任务 `consolidate-workflow-tracks` 跑测试时暴露出测试设置太繁琐。测试设置并不是写死的，问题是太繁琐：

- 套件在 `.tenon/tests/catalog.yaml`，每步策略在工作流 YAML 的 `test_policy`，2000 行上限也在 YAML。
- `test_policy` 有十几个字段（`plan`、`kinds`、`run`、`run_if_registered`、`scope`、`files`、`scenarios`、`integrity`、`coverage`、`flaky`、`benchmark`、`browsers`），测试种类有 17 个（`kernel/src/test-system/vocabulary.ts`）。普通任务也要按这套规则测。
- 用户原话：「这些是否能配置，我觉得也需要能够在文件中定制化，而不是写死的，有的普通任务也不需要这么多测试吧」。

上一任务实际踩到的问题：

- **逐个登记**：`files: registered` 要求逐个登记改动过的测试文件，上一任务登记了 210 个。
- **误判改动**：归档目录里 git 没改过的 `.spec.report` 与证据快照被当成「本任务改动」的测试文件，误收 13 个，形成永久的 `registered-test-not-executed` 阻断。原因有两处：
  - `register --auto` 从全仓文件里找孤儿，`.spec.report` 也匹配测试文件名规则（`claim-orphans.ts`、`vocabulary.ts` 的 `looksLikeTestFile`）。
  - 改动文件判定不排除 `openspec/` 等控制目录（`workspace/changed-files.ts`）。
- **放宽 glob**：`tenon test register --auto` 把套件 glob 放宽成 `<首级目录>/**/<文件名模式>`，例如 `openspec/**/*.spec.report`。
- **丢注释**：`tenon test catalog set|add|rm` 与 `--auto` 经 `serializeTestCatalog` 整份重写目录，注释全部丢失（`catalog.ts:197-200` 自述「注释不保留」）。
- **场景映射**：69 个规格场景要手工映射到用例，追溯矩阵满屏「未覆盖」。
- **重复信任**：测试信任存在检出目录里的 `.tenon/users/<slug>/local/test-seal.json`，新 worktree 每次都要用户重新 `tenon test trust`。
- **上限不合理**：验证步 `code-size` 的 `lines_added ≤ 2000` 上限没有意义（用户原话：「怎么可能只能 2000 上限」）。豁免文字里的数字也不随代码刷新。
- **绝对路径**：测试运行记录（入库）的失败信息与日志里带本机绝对路径（安全评审 low）。
- **指纹被测试输出污染**：候选指纹会把 `test-results/`、`playwright-report/`、`coverage/` 下没声明的文件算进候选，跑一次 e2e 就让冻结版本失效。上一任务只补了一个具体目录（`test-results/dashboard-e2e-server`）。

## What Changes

- **每步一个测试选择**：工作流每步的测试设置收成一个键 `test: none | plan | changed | full`（不要求 / 写计划 / 跑改动 / 全量），取代十几个字段的 `test_policy`。
  - 每档具体跑什么，以及覆盖率、基准基线、不稳定用例这类阈值，写在项目测试目录 `.tenon/tests/catalog.yaml` 的档位定义里。
  - 没写档位定义时用内建缺省，项目不写也能用。
  - 档位定义与每步选择都只改文件就能定制。
  - default 各轨道按「轻量任务默认少测」重新选档。
  - 套件按 `files` 或 `covers` 判断是否被改动碰到。没写 `covers` 的套件只改源码碰不到；这时给出不阻断的提示 `suites-without-covers`，点名这些套件，避免零运行却没人知道。
- **测试种类合并**：17 个种类合并为 5 类：单测、集成、端到端、静态检查、基准，另有只在点名时运行的自定义。旧种类名作为别名照常读取。
- **测试文件自动认领**：改动过的测试文件在求值时按套件 glob 自动认领，不写进计划，不再逐个 `tenon test register --file`。`test-register-files` 只在出现孤儿测试文件时下发，一条 `--auto` 认领全部。
  - 改动判定只认 git 真实改动过的文件，排除 `openspec/`、`.tenon/`、`.pipeline/` 这类控制目录。
  - 测试文件名规则要求源码扩展名，`.spec.report` 这类证据文件不再算测试文件。
  - `--auto` 只认领本任务改动的孤儿文件，并且只追加该文件的精确路径，不再放宽 glob。
- **目录写回保留注释**：`tenon test catalog add|set|rm` 与 `--auto` 只改动被修改的条目所在的行，其余内容（注释、空行、排版）原样保留。
- **场景映射默认不要求**：default 各轨道都不再要求把规格场景映射到用例。追溯矩阵只在策略要求时逐条列出场景；不要求时只给一行统计，不再满屏「未覆盖」。
- **代码规模不设缺省上限**：删掉 default 里 `code-size` 的 2000 行上限，探针照常统计供评审者阅读，默认不挡出口。项目需要上限时在 YAML 里按需写回 `pass.metrics`。豁免展示时同时给出最新一次运行的实际数值。
- **测试信任按「用户 + 仓库 + 命令摘要」共享**：信任存进用户级状态目录，同一仓库（git common dir，经 worktree 列表反查）的所有 worktree 共用，每条命令单独记摘要，只新增或改动的命令才需要重新信任。
  - 信任仍然只能由用户本人在自己的终端确认；agent 不能运行 `tenon test trust`，也不能设置 `TENON_TEST_TRUST`。
  - 旧的按检出存放的信任只在不是 git 仓库的项目里继续有效。
  - git 仓库里不再认检出里的旧封存，以前信任过的命令要用户本人重新确认一次。检出里的封存和密钥可能随压缩包带来，不能给仓库自己授信。
- **运行记录相对路径**：运行记录与日志里的仓库绝对路径改写成相对路径，主目录改写成 `~`。
- **测试输出目录的通用规则**：`test-results/`、`playwright-report/`、`coverage/` 下同时满足以下两条的文件不计入候选指纹，不必逐个声明：
  - git 没有跟踪它；
  - 扩展名属于证据格式（日志、文本报告、截图、录像、覆盖率数据等）。

  以下文件照旧计入，不能借这些目录名藏源码或会被加载的内容：
  - 已跟踪的文件；
  - 源码扩展名的文件；
  - 代码或浏览器能直接加载、解包的格式（json、html、zip、har 等）。测试确实写出这类产物时由目录声明为输出。
- **同步**：Dashboard 的测试设置改成单选，项目测试页显示档位定义，任务测试页去掉逐个登记与满屏「未覆盖」。同步 `skills/tenon/SKILL.md` 的测试动作行，以及用法文档、`docs/CONTRACT.md`、发布说明。

非目标：

- 文档机制（document-contract、effective-io、YAML 的 `inputs` / `outputs` / `document_contract` 键、`document` / `artifact` 命令、文档相关动作行）由并行任务 `rework-document-mechanism` 负责，本任务不碰。
- 测试证据的完整性语义（记录链、封印、受保护文件评审）不变。
- 评审门、验证轮次上限、步骤测试豁免机制不变。
- `diff-risk` 改动风险阈值仍在工作流 YAML 里。

可验证结果：

- 一个 lite 任务从立项走到完结，测试相关的手工操作只剩运行测试本身：
  - 不逐个登记测试文件，不手工映射场景；
  - 同一仓库的第二个 worktree 不需要重新信任。
- default 的 轻量 / 产品 / 前端 / 后端 各步测试设置都能只改文件定制：
  - 改工作流 YAML 的 `test:` 档位，或改测试目录的档位定义，下一次 `tenon status` 的要求随之改变。
- 回归测试锁住以下问题：
  - git 未改动的归档文件不算改动；
  - `--auto` 不放宽 glob；
  - `catalog set` 保留注释；
  - 运行记录里没有绝对路径；
  - 未声明但被忽略的测试输出不使候选失效，源码扩展名的文件仍使候选失效。
- 在途任务（冻结快照里还是旧 `test_policy`、测试计划里还有逐个登记的 `files`）照旧能走完。

## Capabilities

### New Capabilities

- `test-settings`：每步测试档位、测试目录里的档位定义与阈值、五类测试种类、测试文件自动认领与改动判定、场景映射按需要求、目录写回保留注释、测试信任共享、运行记录相对路径、测试输出目录的指纹规则。

### Modified Capabilities

- `step-test-waiver`：default 的 `code-size` 不再设上限、默认不挡出口；豁免展示附带最新运行的实际数值。
- `workspace-verification-integrity`：被 git 忽略、扩展名不是源码的测试输出不计入候选指纹。

## Impact

- **代码**：
  - `packages/kernel/src/test-system/`：词表、目录编解码与写回、计划与认领、策略求值、追溯、信任存储、运行记录。
  - `packages/kernel/src/workflow/`：`test` 键的解析、编译、序列化，以及对旧 `test_policy` 的兼容。
  - `packages/kernel/src/workspace/`：改动文件判定、指纹。
  - `packages/cli/src/commands/test*.ts`，以及 `statusStep*` 里测试相关的 `next` 生成。
  - `packages/server/src/` 的测试快照与工作流 DTO。
  - `packages/dashboard-app/src/` 的测试设置与测试页签。
  - `templates/workflows/default.yaml` 的 `test_policy` / `tests` 键、`templates/test-directions/code-size.yaml`。
  - `default-workflow.generated.ts`、`packages/*/dist`。
  - `.tenon/tests/catalog.yaml`。
- **契约**：
  - 工作流步骤新增 `test` 键，`test_policy` 降为兼容读取。
  - 测试目录新增档位定义节，种类改为五类外加别名。
  - `next` 的 `test-register-files` 只在出现孤儿测试文件时下发，`test-plan-map` 只在缺必需测试类或要求场景映射时下发。
  - 信任存储位置变化。
  - 运行记录里的文本路径改为相对路径。
- **兼容**：
  - 冻结快照里的旧 `test_policy` 照旧编译、求值；旧测试计划里逐个登记的 `files` 继续有效。
  - 旧种类名可读。
  - 旧的按检出存放的信任只在非 git 项目里继续有效；git 仓库里要重新 `tenon test trust` 一次，写进发布说明。
  - N-1 版本读不了新 `test` 键，写进发布说明。
- **测试**：
  - kernel 单测：档位编译与求值、种类别名、改动判定、认领、保留注释写回、信任存储、相对路径、指纹规则。
  - CLI 集成测试：lite 任务全程、跨 worktree 信任、在途旧计划走完。
  - server DTO 测试、Dashboard 单测与 e2e、hook 测试（信任仍受保护）。
