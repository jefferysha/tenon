# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 工作流步骤 SHALL 用一个测试档位声明测试要求

工作流步骤 SHALL 接受键 `test`，取值只能是 `none`（不要求）、`plan`（写计划）、`changed`（跑改动）、`full`（全量）之一。

- 同一步同时写 `test` 与 `test_policy` 时，编译 MUST 失败并点名该步：`tenon init` 以非零退出码失败；工作流写接口返回 400，已发布的定义不变。
- 编译后的步骤 SHALL 只记录档位名；档位的具体含义在求值时读取项目测试目录。
- 没有写 `test` 的工作流，编译结果 MUST 与修改前逐字节相同，已有任务的工作流指纹不变。
- `test: none` 与不写 `test` 等价：本步没有测试要求。

#### Scenario: 档位写进步骤

- **WHEN** 工作流某步写了 `test: changed`
- **THEN** 编译成功，冻结计划里该步的测试档位是 `changed`
- **AND** 序列化后再解析得到同样的档位

#### Scenario: 档位与旧策略互斥

- **WHEN** 同一步既写 `test: full`，又写 `test_policy`
- **THEN** 编译失败，报错点名该步，并说明两者只能写一个
- **AND** 用这份工作流 `tenon init` 以非零退出码失败；经工作流写接口保存时返回 400，已发布的定义不变

#### Scenario: 未知档位被拒

- **WHEN** 某步写了 `test: quick`
- **THEN** 编译失败，并列出四个可选值

#### Scenario: 不写档位的旧工作流指纹不变

- **WHEN** 一份只用 `test_policy` 的工作流在新版本下重新编译
- **THEN** 冻结计划与工作流指纹和修改前相同

### Requirement: 档位定义 SHALL 写在项目测试目录并有内建缺省

`.tenon/tests/catalog.yaml` SHALL 接受可选顶层键 `levels`，其下只能有 `plan`、`changed`、`full` 三档。

- 每档只接受 `required`、`touched`、`scenarios`、`coverage`、`flaky`、`require_baseline` 六个键。
- `plan` 档只接受 `required` 与 `scenarios`。
- 未写的档或键 SHALL 取内建缺省：
  - `plan`：`required: [unit]`；
  - `changed`：`required: [unit]`、`touched: [static]`；
  - `full`：`required: [unit]`、`touched: [integration, e2e, static, benchmark]`；
  - 三档都是 `scenarios: off`、不设覆盖率与不稳定用例门槛、`require_baseline: false`。
- 未知档名、未知键、未知测试类、覆盖率超出 0–100 时，目录校验 MUST 失败并给出行号；目录无效时，测试相关出口一律阻断。
- 档位定义 SHALL 计入目录摘要：改了档位定义，已有运行随之过期。

#### Scenario: 不写档位定义用缺省

- **WHEN** 目录没有 `levels`，某步是 `test: full`
- **THEN** 该步要求单测类存在并全量运行，被改动碰到的集成、端到端、静态检查、基准类套件也全量运行
- **AND** 不检查覆盖率门槛

#### Scenario: 只改目录就能改档位含义

- **WHEN** 目录写了 `levels.full.coverage: { lines: 80 }`，套件声明了覆盖率报告
- **THEN** 下一次 `tenon status` 在 `test: full` 的步骤上按 80% 检查行覆盖率，工作流文件不用改

#### Scenario: 档位定义写错被拒

- **WHEN** `levels.changed` 里写了 `scope: full`
- **THEN** `tenon test catalog validate` 以非零退出码失败，报出该键所在行

### Requirement: 档位 SHALL 按测试类匹配套件

测试类 SHALL 是 `unit`、`integration`、`e2e`、`static`、`benchmark` 五类，外加只在点名时运行的 `custom`。

- 目录里套件的 `kind` SHALL 既接受类名，也接受旧种类名。旧种类名按下面的对应关系归类，运行器与报告格式的组合校验仍按旧种类名的规则：
  - `unit`、`coverage` → `unit`；
  - `integration`、`regression`、`contract`、`smoke` → `integration`；
  - `e2e`、`playwright`、`browser`、`a11y`、`visual` → `e2e`；
  - `typecheck`、`lint`、`code-size`、`design-system` → `static`；
  - `benchmark` → `benchmark`；
  - `custom` → `custom`。
- 档位里的测试类 SHALL 匹配属于该类的任何套件。
- 旧 `test_policy` 里的种类 MUST 仍按种类名逐字匹配，在途任务的要求不会因为归类而变宽。

#### Scenario: 旧种类名的套件满足档位

- **WHEN** 档位要求 `static` 类，目录里只有 `kind: typecheck` 的套件
- **THEN** 该套件按静态检查类参与本档位

#### Scenario: 旧策略不受归类影响

- **WHEN** 冻结计划里的旧策略要求 `run_if_registered: [typecheck]`，目录里还有 `kind: lint` 的套件
- **THEN** 只有 `typecheck` 套件按旧策略参与，`lint` 套件不参与

### Requirement: 阶段运行集 SHALL 由档位、目录与本任务改动决定

步骤的运行集 SHALL 由测试档位、档位定义、测试目录和本任务改动的文件共同决定。「被改动碰到」指本任务改动的某个文件匹配该套件的 `files` 或 `covers` glob。

- `changed`：
  - `required` 与 `touched` 类里被改动碰到的套件按改动范围运行（`scope: changed`）。
  - 没有被碰到的套件不运行；改动没碰到任何套件时，零运行即满足本档位。
- `full`：
  - `required` 类的全部套件全量运行；
  - `touched` 类里被改动碰到的套件全量运行。
- `plan`：不运行套件，只要求测试计划存在、`required` 类在目录里有套件。
- 所有档位：
  - `required` 类在目录里没有套件、也没有已批准的项目级不适用声明或本任务豁免时，SHALL 出 `test-kind-missing` 阻断；
  - 测试计划里显式加跑的套件（`tenon test register --suite`）照计划登记的范围加入运行集，`full` 档一律全量；
  - 读不到本任务的改动列表时，MUST 出 `files-diff-unavailable` 阻断，不猜运行集。
- `changed` 与 `full` 档：`required` 或 `touched` 类里没写 `covers` 的套件，只有改到它 `files` 匹配的文件才算被碰到，只改源码碰不到它。
  - 这类套件因此不在运行集里，而本任务又改动了源码文件（控制目录之外、扩展名是源码扩展名、不是测试文件）时，求值 SHALL 给出不阻断的提示 `suites-without-covers`。
  - 提示点名这些套件，并说明给它们写上 `covers` 后，源码改动才会碰到它们。
  - `tenon test status` 与 `tenon test run <c> --stage` SHALL 打印这条提示。
- `tenon test run <c> --stage` 实际运行的套件与范围 MUST 与 `tenon status` / `tenon check` 求值用的运行集一致。

#### Scenario: 跑改动只跑被碰到的套件

- **WHEN** 目录有 `unit`（覆盖 `src/**`）与 `docs-unit`（覆盖 `docs/**`）两个单测类套件，本任务只改了 `src/a.ts`，该步 `test: changed`
- **THEN** 运行集只有 `unit`，范围是 changed

#### Scenario: 改动没碰到任何套件

- **WHEN** 本任务只改了 `README.md`，该步 `test: changed`
- **THEN** 运行集为空，本步测试要求已满足，`tenon test run <c> --stage` 如实说明没有要运行的套件并以 0 退出
- **AND** 不出 `suites-without-covers` 提示（`README.md` 不是源码文件）

#### Scenario: 没写 covers 的套件给出提示

- **WHEN** 目录只有 `unit` 套件（`files: ["test/**/*.test.js"]`，没写 `covers`），本任务只改了 `src/a.js`，该步 `test: changed`
- **THEN** 运行集为空，本步测试要求已满足，不出阻断
- **AND** `tenon test status <c> --step <该步>` 给出不阻断的提示 `suites-without-covers`，点名 `unit`（`--json` 输出的 `policy.notices` 里同样有它）
- **AND** `tenon test run <c> --stage` 以 0 退出，并打印同样点名 `unit` 的提示

#### Scenario: 全量跑必需类、碰到才跑其他类

- **WHEN** 该步 `test: full`，目录有 `unit` 与 `hooks`（集成类，覆盖 `hooks/**`）两个套件，本任务没有改 `hooks/`
- **THEN** 运行集只有 `unit`，范围是 full
- **AND** 本任务改了 `hooks/gate.sh` 时，运行集是 `unit` 与 `hooks`，都全量

#### Scenario: 缺必需类

- **WHEN** 目录里没有任何单测类套件，该步 `test: changed`
- **THEN** 出 `test-kind-missing`，修复命令给出补套件或声明项目级不适用的办法

### Requirement: 改动过的测试文件 SHALL 按套件 glob 自动认领

本任务改动过的测试文件，只要被某个套件的 `files` glob 匹配，就 SHALL 视为该套件的测试，不需要逐个登记。

- 认领在求值时计算，MUST NOT 写进 `test-plan.yaml`。新增测试文件不改变计划摘要，已有运行不会因此过期。
- 被认领文件所属的套件按本档位要跑时进入运行集；套件跑完后，认领的文件 SHALL 在报告里至少有一个执行过（非跳过）的用例，否则出 `registered-test-not-executed`。
- 一个文件被多个套件认领时，在至少一个跑过的认领套件里执行过即可。
- 旧策略的 `files: registered` SHALL 同样按认领处理，不再出 `test-file-unregistered`。认领文件所属套件的种类在旧策略的 `run` 或 `run_if_registered` 里时，该套件进入运行集。
- 改动里像测试、却没有任何套件认领的文件仍是孤儿，出 `test-file-orphan` 阻断。

#### Scenario: 新增测试文件不用登记

- **WHEN** 本任务新增 `test/sub.test.js`，`unit` 套件的 glob 认领它，该步 `test: changed`
- **THEN** `tenon status` 不出任何登记类阻断，`next` 不下发 `test-register-files`
- **AND** `tenon test run <c> --stage` 只跑这个文件，报告里有它的用例后出口无测试阻断
- **AND** `test-plan.yaml` 没有因此变化

#### Scenario: 认领了却没执行

- **WHEN** `unit` 套件的 glob 认领了改动过的 `test/b.test.js`，但套件命令实际没有收录它，报告里没有它的用例
- **THEN** 出 `registered-test-not-executed`，点名该文件

#### Scenario: 旧策略的逐个登记不再要求

- **WHEN** 冻结计划里的旧策略写着 `files: registered`，本任务新增了一个被 `unit` 认领的测试文件
- **THEN** 不出 `test-file-unregistered`，`unit` 套件进入运行集

### Requirement: 测试改动判定 SHALL 排除控制目录并要求源码扩展名

判定「本任务改动过的测试文件」与孤儿时，改动列表 SHALL 先去掉 `openspec/`、`.tenon/`、`.pipeline/` 下的路径。

- 测试文件名规则（`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.go`、`*.bench.*`、`e2e/` 下的文件）SHALL 只在扩展名是源码扩展名时成立：js、jsx、ts、tsx、mjs、cjs、mts、cts、py、go、rs、java、kt、rb、php、cs、swift、scala、vue、svelte。
- git 没有改动的文件 MUST NOT 算作本任务改动。

#### Scenario: 归档里的证据文件不算测试

- **WHEN** `openspec/changes/archive/x/.pipeline-run/review-attempt-reports/a.spec.report` 在仓库里、本任务没有改它
- **THEN** 它不是本任务改动的文件，也不是孤儿，不进任何套件、不进计划

#### Scenario: 控制目录里的改动不算测试改动

- **WHEN** 本任务改动了 `openspec/changes/<c>/notes.spec.md` 与 `.tenon/tests/x.test.json`
- **THEN** 两者都不算测试文件改动，不出孤儿阻断

#### Scenario: 非源码扩展名不算测试文件

- **WHEN** 本任务新增了 `fixtures/data.spec.json`
- **THEN** 它不算测试文件，不出孤儿阻断

### Requirement: `tenon test register --auto` SHALL 只追加本任务孤儿的精确路径

`tenon test register <c> --auto` SHALL 只处理本任务改动里的孤儿测试文件，并按现有的套件选择规则，把**该文件的精确路径**追加到所选套件的 `files`。

- `--auto` MUST NOT 把 glob 放宽成目录通配。
- `--auto` MUST NOT 处理本任务没有改动的文件。
- 没有合适套件时，SHALL 报错并给出补套件的命令，不写目录。

#### Scenario: 不放宽 glob

- **WHEN** 本任务新增孤儿 `tools/x.test.mjs`，`unit` 套件的 glob 是 `packages/*/src/**/*.test.ts`
- **THEN** `--auto` 之后 `unit.files` 只多出 `tools/x.test.mjs` 这一项，原有 glob 不变
- **AND** 目录里没有出现 `tools/**/*.test.mjs` 这样的通配

#### Scenario: 不碰未改动的文件

- **WHEN** 仓库里有本任务没改动、也没有套件认领的 `old/y.test.js`
- **THEN** `--auto` 不认领它，目录与计划都不出现它

### Requirement: 测试目录写回 SHALL 保留未改动的内容

所有写测试目录的命令 SHALL 只改动实际变化的节点所在的行，其余字节（注释、空行、排版）原样保留。这些命令包括 `tenon test catalog add|set|rm|not-applicable` 与 `tenon test register --auto`。

- 节点分三层：顶层键、`suites` 条目、条目里的键。
- 新增节点追加在所属列表或映射的末尾。
- 删除节点只去掉它自己的行；它前面的注释行保留。
- 写回后的目录 MUST 重新解析，并与预期内容一致；不一致时不写盘、报错。
- 新建目录（`tenon test discover --write` 或 `tenon init` 在没有目录时）照旧整份写出；`tenon init` 遇到已有目录时不改写它。

#### Scenario: 改一条命令保留注释

- **WHEN** 目录开头有注释，套件之间有分节注释，执行 `tenon test catalog set unit --command "npm test"`
- **THEN** 只有 `unit` 套件的 `command:` 行变了，其余每一行（含全部注释）与原文件逐字相同

#### Scenario: 新增套件保留注释

- **WHEN** 执行 `tenon test catalog add e2e2 --kind e2e …`
- **THEN** 新套件出现在 `suites` 末尾，原文件的注释与其他行逐字保留

#### Scenario: 删除套件只删自己的行

- **WHEN** 执行 `tenon test catalog rm bench`，`bench` 前面有一行分节注释、后面还有其他套件
- **THEN** 只删除 `bench` 条目自己的行，分节注释与其他套件保留

### Requirement: 场景映射 SHALL 只在档位要求时出现

档位定义的 `scenarios` 缺省为 `off`。

- 为 `off` 时，规格场景与任务条目 MUST NOT 产生 `scenario-uncovered` 阻断，`next` 不为它们下发 `test-plan-map`。
- 为 `off` 时，验证报告的追溯矩阵 SHALL 只列出已映射的行，另加一行「另有 N 条场景 / 任务未映射（本步不要求映射）」，不逐条写「未覆盖」。
- 为 `required` 或 `passing` 时，行为与修改前相同。

#### Scenario: 不要求映射时报告收起

- **WHEN** 规格里有 69 个场景都未映射，档位 `scenarios: off`
- **THEN** 出口没有场景阻断
- **AND** 报告的追溯矩阵只有一行统计，没有逐条「未覆盖」

#### Scenario: 要求映射时照旧

- **WHEN** 档位写了 `scenarios: required`，有场景未映射
- **THEN** 出 `scenario-uncovered`，`next` 下发 `test-plan-map`

### Requirement: default 工作流 SHALL 按轨道选用档位且不设代码规模上限

内建 default 工作流各轨道的测试档位 SHALL 如下：

- 轻量：实现 `changed`，验证 `full`；
- 产品：规格 `none`，验证 `changed`；
- 前端、后端：规格 `plan`，实现 `changed`，验证 `full`。

其他要求：

- default 工作流里 MUST NOT 再有 `test_policy`。
- 产品、前端、后端验证步的 `code-size` 测试与 `templates/test-directions/code-size.yaml` MUST NOT 带 `pass.metrics` 门槛。探针照常统计并供代码规模评审者阅读，没有门槛时以退出码 0 通过。
- 项目要上限时，SHALL 能在工作流 YAML 的该测试下写回 `pass.metrics` 启用。

#### Scenario: 轻量任务的测试档位

- **WHEN** 用 `--track lite` 新建 default 任务
- **THEN** 冻结计划里实现步是 `changed`、验证步是 `full`，任何一步都没有 `test_policy`

#### Scenario: 大改动不被代码规模挡住

- **WHEN** 后端任务新增 5000 行代码，验证步运行 `code-size`
- **THEN** 该测试通过，记录里有 `lines_added=5000`，不需要豁免

#### Scenario: 按需启用上限

- **WHEN** 项目工作流给 `code-size` 写回 `pass.metrics: [{ name: lines_added, max: 3000 }]`，改动新增 5000 行
- **THEN** 该测试失败，原因 `metric-threshold`

### Requirement: 测试信任 SHALL 按用户、仓库与单条命令共享

测试命令的信任 SHALL 存在用户级运行时状态目录（`<stateRoot>/test-trust/`），键为「用户 + 仓库身份 + 单条命令摘要」。

- 仓库身份 SHALL 取 `git rev-parse --git-common-dir` 的真实路径；同一仓库的所有 worktree 共享信任。
- 当前检出的根目录 MUST 出现在 `git worktree list --porcelain` 里，才算这个仓库；否则视为未信任。
- 命令摘要 SHALL 按单条可执行命令计算：
  - 套件按 `command`、`cwd`、`select.files` / `select.grep`、排序后的 `env` 与它用到的服务计算；
  - 步骤内联测试按 `command` 与 `cwd` 计算。
- 执行前 SHALL 只校验本次要执行的命令。未信任时列出这些命令并以退出码 1 拒绝执行，不写运行记录。
- 信任文件 SHALL 用存在同目录的密钥做 HMAC 封印，权限 0600。读不出、损坏或封印不符时一律视为未信任。
- 项目不是 git 仓库时，SHALL 退回检出目录内的旧封存：旧 `test-seal.json` 记下的整份信任继续有效，当前可执行摘要等于其中一条时，全部视为已信任；这时 `tenon test trust` 也写检出里的旧封存。「不是 git 仓库」指检出目录及其所有上级目录都没有 `.git`。
- git 仓库里 MUST NOT 认检出目录里的旧封存，不论它是否被 git 跟踪。原因：检出里的文件（封存与密钥）可能随仓库或压缩包一起带来，仓库不能给自己授信。
  - 信任只来自用户级存储。
  - 以前在检出里信任过的命令，用户要在自己的终端里重新运行一次 `tenon test trust`。
- 有 `.git` 却读不出仓库身份时，MUST 视为未信任，也 MUST NOT 退回旧封存。这包括：
  - git 出错、超时或不可用；
  - `.git` 是伪造的指针。
- 信任 MUST 只能由用户运行 `tenon test trust` 写入：
  - hook 拒绝 agent 运行它；
  - hook 拒绝设置 `TENON_TEST_TRUST`；
  - hook 拒绝写 `*/test-trust/*` 路径。

#### Scenario: 新 worktree 不用重新信任

- **WHEN** 用户在主检出信任了目录命令，随后从同一仓库建了新 worktree 并在其中运行 `tenon test run`
- **THEN** 不要求重新信任，命令直接执行

#### Scenario: 只有改动的命令需要重新信任

- **WHEN** 已信任的目录里改了一个套件的 `command`
- **THEN** 只有这条命令被列为未信任，其余命令仍是已信任

#### Scenario: 伪造的 .git 指针借不到信任

- **WHEN** 一个检出目录的 `.git` 文件指向已信任仓库的 common dir，但该仓库的 `git worktree list` 里没有这个检出
- **THEN** 它的命令一律视为未信任，检出目录里即使带着记有当前摘要的旧封存也不认

#### Scenario: git 出错时不退回旧封存

- **WHEN** 检出目录有 `.git`，读取仓库身份时 git 出错或超时，检出目录里的旧封存记着当前摘要
- **THEN** 目录命令视为未信任

#### Scenario: 不是 git 仓库时旧信任仍然有效

- **WHEN** 检出目录及其所有上级都没有 `.git`，检出里的旧封存记着当前目录的整份可执行摘要
- **THEN** 目录命令视为已信任

#### Scenario: git 仓库里不认检出里的旧封存

- **WHEN** git 仓库的检出里有记着当前摘要的旧封存与密钥（被 git 跟踪的，或未被跟踪、随压缩包带来的），用户级存储里没有记录
- **THEN** 目录命令视为未信任，提示用户在自己的终端运行 `tenon test trust`

#### Scenario: agent 不能写信任

- **WHEN** agent 的工具调用要写 `<stateRoot>/test-trust/<user>.json`，或运行 `tenon test trust`
- **THEN** hook 拒绝

### Requirement: 测试运行记录 SHALL 不含本机绝对路径

新写入的测试运行记录 SHALL 在计算摘要之前，把所有字符串字段里的下列前缀改写掉：

- 仓库根，含逻辑路径、真实路径与 `file://` 前缀三种写法，改写为仓库相对路径；
- 用户主目录，改写为 `~`。

本机日志与已有记录不回写。

#### Scenario: 失败堆栈里的路径改成相对路径

- **WHEN** 一个用例失败，堆栈里有 `<仓库绝对路径>/packages/cli/src/a.test.ts:10:5` 与 `file://<仓库绝对路径>/node_modules/x.js`
- **THEN** 记录里分别是 `packages/cli/src/a.test.ts:10:5` 与 `node_modules/x.js`
- **AND** 记录的任何字符串里都不再出现仓库绝对路径或主目录路径

### Requirement: 在途任务 SHALL 按冻结的旧设置走完

冻结计划里仍是旧 `test_policy` 的任务 SHALL 照旧编译与求值，唯一的变化是 `files: registered` 改按认领处理。

- 旧测试计划里登记的套件、文件、用例映射与豁免 SHALL 继续有效。
- 旧种类名 SHALL 继续可读；旧检出信任只在不是 git 仓库的项目里继续有效（见「测试信任」一节）。

#### Scenario: 旧任务走完验证

- **WHEN** 一个冻结了旧 `test_policy`、计划里逐个登记过测试文件的任务继续运行测试并申请 `verify-pass`
- **THEN** 它的测试要求与修改前相同（不再要求登记新增的测试文件），能走完验证

### Requirement: 步骤编排 SHALL 不要求逐个登记测试文件

`tenon status` 的 `next` SHALL 按以下规则下发测试动作：

- `test-register-files` 只在出现孤儿测试文件时下发，内容是一条 `tenon test register <c> --auto`。
- `test-plan-map` 只在缺必需测试类、或档位要求场景映射时下发。
- `run-tests` 的 `trust` 只列出本次要执行、尚未信任的命令。

#### Scenario: 新增测试文件不出登记动作

- **WHEN** 实现步新增了 30 个被套件认领的测试文件
- **THEN** `next` 里没有 `test-register-files`，直接是 `run-tests`

#### Scenario: 孤儿测试文件一条命令认领

- **WHEN** 本任务新增两个没有套件认领的测试文件
- **THEN** `next` 下发一条 `test-register-files`，`fix` 是 `tenon test register <c> --auto`
