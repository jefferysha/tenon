# 技术设计：测试设置简化

## 背景

现状（2026-10-12，main `f474225f`）。测试设置都能在文件里改，问题是改起来太繁琐：

- **每步策略**：写在工作流 YAML 的 `test_policy` 里，12 个键：`plan`、`kinds`、`run`、`run_if_registered`、`scope`、`files`、`scenarios`、`integrity`、`coverage`、`flaky`、`benchmark`、`browsers`。
  - 解析在 `kernel/src/workflow/parse-test-policy.ts`，编译在 `compile-test-policy.ts`，求值在 `kernel/src/test-system/policy.ts` 与 `evaluate-v2.ts`。
  - default 的四个轨道共 11 处 `test_policy`，每处写法都不一样。
- **种类**：17 个（`vocabulary.ts` 的 `TEST_KINDS`），用户要分清 `regression` / `integration` / `smoke` / `contract`，以及 `e2e` / `playwright` / `browser` / `a11y` / `visual`。
- **逐个登记**：
  - `files: registered` 要求本任务改过的每个测试文件都 `tenon test register --file`。
  - 计划在规格步生成，实现步新增的测试文件全靠手工登记。上一任务登记了 210 个。
- **误收文件**。`register --auto` 有三个问题，结果是把 13 个不是测试的文件登记进 `unit`，造成永久的 `registered-test-not-executed` 阻断：
  - 它从全仓文件里找孤儿（`listRepoFiles` 用 `git ls-files`），不只看本任务改动的文件；
  - 测试文件名规则 `\.(test|spec)\.[A-Za-z0-9]+$` 会认 `.spec.report`；
  - 它把 glob 放宽成 `<首级目录>/**/<文件名模式>`。
- **丢注释**：`tenon test catalog add|set|rm`、`na`、`--auto` 都经 `serializeTestCatalog` 整份重写目录，注释全部丢失。
- **场景映射**：
  - 产品轨道的规格步要求每个规格场景都映射到用例；
  - 其余轨道不要求，追溯矩阵也照样逐条列出、满屏「未覆盖」。
- **信任**：
  - 信任存在检出目录里的 `.tenon/users/<slug>/local/test-seal.json`，键是整个目录可执行内容的一个摘要。
  - 新 worktree 要重新信任，改一条命令也要整份重新信任。
- **代码规模**：
  - 验证步 `code-size` 的 `lines_added ≤ 2000` 写在 default 的三个轨道和 `templates/test-directions/code-size.yaml` 里。
  - 豁免理由是登记时写的文字，代码再变，里面的数字也不刷新。
- **绝对路径**：
  - 入库的运行记录（`.tenon/users/<slug>/tests/<change>/*.json`）里，用例失败的 `stack` / `message` 带本机仓库的绝对路径（上一任务 12 份记录都有）。
  - 日志在 `local/artifacts/`，不入库。
- **指纹**：`test-results/`、`playwright-report/`、`coverage/` 下没在目录里声明的文件都计入候选指纹（`workspace/fingerprint.ts`），e2e 被测服务写一次日志就让冻结版本失效。

用户原话：「这些是否能配置，我觉得也需要能够在文件中定制化，而不是写死的，有的普通任务也不需要这么多测试吧」「怎么可能只能 2000 上限」。用户已授权按推荐执行、不再提问，以下决策均为「按推荐确定」。外部做法的调研见 researcher 报告 `openspec/changes/simplify-test-settings/.pipeline-agent-reports/311853a6-….md`。

## 决策

### 1. 每步一个测试档位

工作流步骤新增键 `test`，取值四选一：

| 值 | 名称 | 含义 |
|---|---|---|
| `none` | 不要求 | 本步没有测试要求（等于不写） |
| `plan` | 写计划 | 本步要有测试计划，且项目有档位要求的测试类（缺了要补套件，或声明不适用） |
| `changed` | 跑改动 | 跑本任务改动碰到的套件，只跑改动范围 |
| `full` | 全量 | 必需类的套件全量跑；其他类里被改动碰到的套件也全量跑 |

- `test` 与旧 `test_policy` 在同一步里互斥，同时写时编译报错。
- 旧 `test_policy` 继续解析、编译、求值，冻结快照照旧，但文档不再介绍它。
- 冻结的 IR 只记档位名（`StepIR.test`）。档位的具体含义在求值时读项目测试目录，所以改档位定义不需要改工作流，也不会改工作流指纹。
- 没写 `test` 的旧 IR 字节不变，旧任务的工作流指纹不变。

### 2. 档位定义在项目测试目录里

`.tenon/tests/catalog.yaml` 新增可选顶层键 `levels`，没写或少写的部分用内建缺省：

```yaml
levels:
  plan:    { required: [unit] }
  changed: { required: [unit], touched: [static] }
  full:    { required: [unit], touched: [integration, e2e, static, benchmark] }
```

每档可写的键只有六个：

- `required`：必需的测试类。目录里必须有这类套件，否则要补套件或声明不适用。`changed` 档只在被改动碰到时跑；`full` 档全量跑。
- `touched`：只在被改动碰到时才跑的测试类。
- `scenarios`：`off | required | passing`，缺省 `off`。
- `coverage`：覆盖率门槛，`lines` / `branches` / `functions` / `statements` / `changed_lines` 取 0–100。
- `flaky`：`{ max, fail_on_new }`。
- `require_baseline`：基准缺基线时是否挡出口，缺省 `false`。

其他约定：

- 「被改动碰到」= 本任务改动的某个文件匹配该套件的 `files` 或 `covers` glob，与现有计划初稿用的 `touches` 同一口径。
- 没写 `covers` 的套件只有改到它的测试文件才算被碰到，只改源码碰不到。`tenon test discover` 自动识别出的套件都没有 `covers`，所以 `changed` 档在只改源码时会零运行。
  - 零运行本身符合「跑改动」的含义，不改成阻断。
  - 但要让人知道：`changed` / `full` 档里，`required` 或 `touched` 类有套件没写 `covers`、因此没进运行集，而本任务改了源码文件（控制目录之外、源码扩展名、不是测试文件）时，求值出不阻断的提示 `suites-without-covers`，点名这些套件，并说明写上 `covers` 后源码改动才会碰到它们。`--stage` 打印同样的提示。
  - 这是验证第 3 轮后端评审的 medium。
- 阈值类配置（覆盖率、不稳定用例、基准基线）只写在档位定义里，工作流 YAML 不再写阈值。
- 档位定义计入目录摘要（`catalog_digest`）。改了档位定义，已有运行随之过期；目录照旧是受保护的测试配置，任务改动它要经评审批准。
- `plan` 档只看 `required` 与 `scenarios`，其余键在 `plan` 档写了也报错。
- 内建缺省体现「普通任务少测」：
  - `full` 不再像旧 `run_if_registered` 那样把目录里全部集成、端到端套件都跑一遍，只跑被改动碰到的；
  - 缺省不设覆盖率门槛。

### 3. 测试种类合并为五类

| 类 | 含义 | 归入的旧种类 |
|---|---|---|
| `unit` | 单测 | unit、coverage |
| `integration` | 集成与回归 | integration、regression、contract、smoke |
| `e2e` | 端到端与浏览器 | e2e、playwright、browser、a11y、visual |
| `static` | 静态检查 | typecheck、lint、code-size、design-system |
| `benchmark` | 基准 | benchmark |
| `custom` | 自定义，只在点名时运行 | custom |

- 新增种类名 `static`。目录里套件的 `kind` 可以写类名，也可以写旧种类名：旧名是别名，运行器 / 报告格式组合校验仍按原规则。
- 档位定义、Dashboard、CLI 帮助、文档只用类名。
- 按类匹配只用于档位：例如 `required: [unit]` 被 `kind: coverage` 的套件满足。
- 旧 `test_policy` 仍按种类逐字匹配，在途任务的要求不会因为合并而变宽。
- `discover` 写出的种类、已有目录与运行记录都不改，避免运行器、报告格式、浏览器项目等按种类判断的旧逻辑跟着变动。

### 4. default 各轨道选档

| 轨道 | 规格 | 实现 | 验证 |
|---|---|---|---|
| 轻量 lite | — | `changed` | `full` |
| 产品 pm | `none` | — | `changed` |
| 前端 frontend | `plan` | `changed` | `full` |
| 后端 backend | `plan` | `changed` | `full` |

- 产品轨道的规格步不再要求场景映射；验证步只在改动碰到套件时跑。
- 前端 / 后端验证步原来的 `coverage: { lines: 80 }` 不再写在工作流里。需要的项目在 `levels.full.coverage` 里写回。本仓库的套件都没有声明覆盖率报告，所以行为不变。
- 轻量验证步不再跑目录里全部的集成、端到端套件，只跑被改动碰到的。

### 5. 改动过的测试文件自动认领

- **认领规则**：本任务改动的文件里，被某个套件 `files` glob 匹配的测试文件自动归入该套件，不再要求登记。
  - 档位要跑该套件时，它进入运行集；`changed` 档只跑这些文件。
  - 套件跑完，这些文件必须在报告里有执行过的用例，沿用 `registered-test-not-executed`。认领的文件和手工登记的文件同等对待：认领了却没执行，说明目录 glob 与运行器实际收录的范围不一致，是真问题。
- **不写计划**：认领在求值时现算，不写进 `test-plan.yaml`。计划摘要不会随新增测试文件变化，已有运行也就不会因此过期。
- **计划只记例外**：计划里只剩显式选择，包括 `register --suite` 加跑的套件、`--file --kind` 登记的不执行资源、用例映射与豁免。
- **旧策略也认领**：旧策略的 `files: registered` 同样按认领处理，不再出 `test-file-unregistered`。认领文件所属的套件只要种类在旧策略的 `run` 或 `run_if_registered` 里，就进入运行集。
- **孤儿**：改动里像测试、但没有套件认领的文件仍是阻断（`test-file-orphan`），否则这些测试永远不会跑。
- **改动口径**（只用于测试判定）：
  - 起点与现有 `changedFilesForState` 相同。
  - 排除控制目录 `openspec/`、`.tenon/`、`.pipeline/`。
  - 测试文件名规则要求源码扩展名：js、jsx、ts、tsx、mjs、cjs、mts、cts、py、go、rs、java、kt、rb、php、cs、swift、scala、vue、svelte。`.spec.report`、证据快照不再算测试文件。
- **`--auto`**：只处理本任务改动里的孤儿，按 `claim-orphans` 的套件选择规则把**该文件的精确路径**追加进套件 `files`，不再放宽 glob。目录写回保留注释（见 §6）。

### 6. 测试目录写回保留注释

- 新增 `patchCatalogText(text, before, after)`：利用 `yaml-subset.ts` 每个节点带的行号，只替换实际变化的节点所在的行，其余字节原样保留。
- 粒度分三层：
  1. 顶层键（`profile`、`profiles_env`、`levels`、`services`、`not_applicable`）；
  2. `suites` 的条目；
  3. 套件条目里的键。
- 规则：
  - **新增**：套件追加在 `suites` 末尾；键追加在条目末尾；列表项（如 `files`）追加在该列表末尾。
  - **删除**：只删除该节点的行。紧挨在节点前面的注释行属于下一个节点，保留。
  - **修改**：只替换该键的行区间。被改键内部的行内注释会随之丢失，这是唯一不保留的情形。
- 校验：写回后照旧整份重新解析，并与预期对象逐键比较，不一致就失败，不写盘。
- 适用范围：`updateCatalog` 统一走这条路径，所有写目录的命令都受益。`discover --write` 是新建目录，照旧整份写出。

### 7. 场景映射默认不要求

- default 各轨道都不再要求把规格场景映射到用例：档位缺省 `scenarios: off`，产品轨道规格步改为 `none`。
- 不要求时，追溯矩阵只列出已映射的行，再加一行「另有 N 条场景 / 任务未映射（本步不要求映射）」，不再逐条写「未覆盖」。
- 要求时（档位写了 `scenarios: required | passing`），行为与现在相同。
- `test-plan-map` 只在缺必需测试类、或档位要求场景映射时下发。

### 8. 代码规模不设缺省上限

- 从 default 三个轨道的 `code-size` 与 `templates/test-directions/code-size.yaml` 里删掉 `pass.metrics`。
- 探针照常统计 `files_changed` / `lines_added` / `lines_deleted` / `largest_added_lines`，供代码规模评审者阅读。没有门槛时退出码 0 即通过，不挡出口，也就不需要豁免。
- 要上限的项目在工作流 YAML 的该测试下写回 `pass.metrics`（按需启用）。
- 豁免展示改为附带实测值：
  - 评审请求、报告、评审者提示里列出 `test:<id>` 豁免时，另起一行写「最新运行：lines_added=2810（上限 2000）」，取自当前候选上最新的失败记录。
  - 原理由照旧标注为「登记者自述、未经核实」。

### 9. 测试信任按「用户 + 仓库 + 命令」共享

- **存储**：`<stateRoot>/test-trust/<user-slug>.json`。`stateRoot` 经 `resolveProductPaths`（`TENON_RUNTIME_HOME` / `TENON_RUNTIME_ROOTS`）得到，测试一律注入临时根，不碰真实目录。
  - 文件整份用 HMAC-SHA256 封印，密钥 `<stateRoot>/test-trust/<user-slug>.key`，0600。
  - 读取永不抛错，坏文件读成空。
  - 最多 2000 条，满了按时间淘汰最旧的。
- **键**：`(用户, 仓库身份, 命令摘要)`。
  - **仓库身份**：`git rev-parse --git-common-dir` 的真实路径，同一仓库的所有 worktree 共享（git 官方文档：链接 worktree 的 `$GIT_COMMON_DIR` 指回主 worktree 的 `.git`）。
  - **防伪造**：当前检出的根目录必须出现在 `git worktree list --porcelain` 里，否则不算这个仓库。这防止压缩包里伪造的 `.git` 文件指向别处已信任的仓库，借用它的信任。
  - **命令摘要**：每条可执行命令单独一个，包括套件的 `command`、`cwd`、`select.files` / `select.grep`、排序后的 `env`、它用到的服务，以及步骤内联测试的 `command` 与 `cwd`。只有新增或改动的命令要重新信任。
- **执行前校验**：只校验本次要执行的命令，未信任的逐条列出。`statusStepTrust` 的 `trust.commands` 也只列未信任的。
- **旧封存只在不是 git 仓库时有效**：
  - 检出目录里旧 `test-seal.json` 的 `trusted[]`（整份摘要）只在「不是 git 仓库」时生效。当前目录的可执行摘要等于其中某条时，全部视为已信任，`tenon test trust` 也写在这里。
  - 「不是 git 仓库」只指检出目录及其所有上级目录都没有 `.git`。
- **git 仓库里不认检出旧封存**，不论它是否被 git 跟踪：
  - 检出里的任何文件，包括封存与它的 HMAC 密钥，都可能随仓库提交或压缩包一起带来。
    - 验证第 1 轮先挡住了被跟踪的封存（`git clone` 带来的）。
    - 验证第 2 轮安全评审指出，带着真 `.git` 的压缩包可以附带未被跟踪的封存与密钥，判定「是否本机写下」挡不住（medium）。
    - 任何只看检出内容的检查都能被这样伪造。所以 git 仓库里干脆不认，信任只来自用户级存储。
  - 代价：以前在检出里信任过的命令，用户要在自己的终端里重新 `tenon test trust` 一次。写进发布说明。
  - 这也删掉了「旧封存是否被跟踪」的判定模块，代码更少。
- **有 `.git` 却读不出仓库身份时**，一律未信任，`tenon test trust` 也报错退出、不写任何东西。读不出身份的情形包括：git 出错、超时、不可用，或 `.git` 是不在 worktree 列表里的伪造指针。
- **只能由用户本人确认，与现在相同**：
  - 只有用户在自己的终端运行 `tenon test trust` 才写入；
  - hook 拒绝 agent 运行它、拒绝设置 `TENON_TEST_TRUST`；
  - hook 新增拒绝 agent 写任何 `*/test-trust/*` 路径。
- **键里的仓库身份为什么取路径、不取内容摘要**：信任的含义是「我认可这个仓库按这条命令跑测试」。命令背后的脚本内容（如 `package.json` 的 `test`）随提交变化，现在就不重新确认。同一路径换成另一个仓库后继承信任，与拉取新提交是同一信任级别，列入剩余风险。

### 10. 运行记录相对路径

- 运行记录在算摘要之前，所有字符串字段（用例失败的 `message` / `stack` / `expected` / `actual`、原因说明等）里的下列前缀改写为相对路径：
  - 仓库根（逻辑路径与真实路径两种写法，含 `file://` 前缀，以及 macOS 上 `/private/var` ↔ `/var` 这类真实路径差异）。
  - 用户主目录，改写为 `~`。
- 本机日志在 `local/artifacts/`，不入库，保持原样，方便排查。

### 11. 测试输出目录的通用指纹规则

- 在 `test-results/`、`playwright-report/`、`coverage/` 目录之下（任意深度），同时满足下面两条的文件不计入候选指纹，不必在目录里逐个声明：
  1. git 没有跟踪它（未提交也未暂存）；
  2. 扩展名属于证据格式：log、txt、xml、md、csv、png、jpg、jpeg、gif、webp、webm、mp4、lcov、info。
- 以下文件照旧计入，不能借这些常见目录名藏源码或会被加载的内容：
  - 已跟踪的文件；
  - 源码 / 脚本扩展名的文件（js、ts、mjs、sh、py 等）；
  - 代码或浏览器能直接加载、解包的格式：json（被 `import` / `require` 读进代码）、html / htm（带脚本的页面）、zip / gz（任意内容的压缩包）、har（Playwright `routeFromHAR` 回放的网络录制）；
  - 没有扩展名的文件。
- 测试运行确实写出这类可加载产物时（报告 JSON、HTML 报告、trace 压缩包），由目录声明为输出，按声明排除。本仓库的 Playwright 输出都已经在声明的路径下：`test-results/dashboard-e2e`、`test-results/dashboard-e2e.json`、`playwright-report`。
- 名单最初含 json、html、htm、zip、gz、har。验证第 1 轮安全评审判为 medium：这些目录下未跟踪的 fixture、页面或压缩包改了也不让候选失效。名单因此收窄为只含日志、文本报告、图片、录像与覆盖率数据。
- 只为这些目录读取 git 跟踪状态，与现有 host-local 规则相同（`git ls-files -z -- <目录>`）；git 不可用时一律计入（失败关闭）。
- 已声明的输出照旧按声明排除。
- 调研依据：Turborepo 与 Nx 的缓存键缺省都按 gitignore 排除；按扩展名限定没有先例，是本设计为防藏源码加的一层，配反例测试。

### 12. 步骤编排与技能

- `next` 的测试动作随上面的规则变化：
  - `test-register-files` 只在出现孤儿测试文件时下发，一条 `tenon test register <c> --auto` 认领全部，不再逐个登记。
  - `test-plan-map` 只在缺必需测试类或档位要求场景映射时下发。
  - `run-tests` 的 `trust` 只列未信任的命令，并说明信任在同一仓库的所有 worktree 共享。
- `skills/tenon/SKILL.md` 只改 `run-test`、`test-discover`、`test-plan-seed`、`test-plan-map`、`test-register-files`、`run-tests`、`test-report` 这几行。

### 13. Dashboard

- **工作流页**：每步的测试设置换成一个四选一的单选，下方说明「档位的具体含义在 `.tenon/tests/catalog.yaml` 的 `levels`」。
  - 冻结或已保存的旧 `test_policy` 只读显示摘要，选了档位就替换掉它。
  - 删除旧表单的种类选择、范围、覆盖率、不稳定用例、基准基线、场景、完整性等控件。
- **项目测试页**：只读显示生效的档位定义（目录写了的与内建缺省，标出来源）与每个套件的类。
- **任务测试页**：
  - 测试文件列表标出「自动认领」，不再有「未登记」；
  - 追溯矩阵按 §7 收起；
  - 策略矩阵按类显示。
- server DTO：步骤带 `test`（档位）与求值后的有效要求；工作流写接口接受 `test`，拒绝同一步同时有 `test` 与 `test_policy`。

### 14. 兼容

- **冻结快照**里的旧 `test_policy`：照旧编译、求值（旧适配器），只在 `files: registered` 上改为认领（§5）。
- **旧测试计划**里登记的 `files`、套件、用例映射、豁免继续有效。
- **旧种类名**照旧可读；旧检出内的信任只在非 git 项目里生效，git 仓库里要重新确认一次（见 §9）。
- **N-1 版本**读不了新 `test` 键与目录的 `levels` 键：读工作流会失败、读目录会报未知键。发布说明写明：回滚前先结束用新键建的任务，并去掉目录里的 `levels`。
- **指纹**：§11 让工作区里有未声明测试输出的在途任务，在升级后第一次校验时出现一次 `revision-stale`。没有这类文件的任务不受影响。写进发布说明。

## 追问记录（grilling，按推荐作答）

用户授权不再提问，以下各轮问题都按推荐作答。

**第一轮（档位语义）**

- **Q1** `changed` 档的改动没碰到任何必需类套件（例如只改了文档）时，本步能不能零运行？
  → 能。「跑改动」只跑被改动碰到的套件，零运行即通过。必需类仍要求目录里存在（缺了要补或声明不适用）。
- **Q2** 「改动」算不算未跟踪的新文件？
  → 算。沿用现有口径：起点到工作区的新增 / 修改 / 重命名，加上未忽略的未跟踪文件。
- **Q3** 读不到改动列表（不是 git 仓库、git 失败）时怎么办？
  → 失败关闭：出 `files-diff-unavailable` 阻断，不猜运行集。
- **Q4** 计划里显式 `register --suite` 加跑的套件，在档位下怎么跑？
  → 照计划登记的范围跑，原因记为「必跑」。`full` 档一律全量。
- **Q5** 一个改动过的测试文件被多个套件的 glob 同时认领怎么办？
  → 每个认领它的套件，只要本档位要跑，就都进运行集。执行检查只要求它在至少一个跑过的套件里有执行过的用例。
- **Q6** 档位定义里写了未知的类或键怎么办？
  → 目录校验失败，按行号报错；整份目录无效，测试相关出口一律阻断。
- **Q7** 平铺工作流（如 design-system、用户自定义）能不能用 `test`？
  → 能，与轨道分支相同。

**第二轮（依赖第一轮）**

- **Q8** Dashboard 给一步选了档位，旧 `test_policy` 怎么处理？
  → 删除，同一步只留 `test`。旧策略在选档之前只读显示。
- **Q9** 旧封存里的整份信任要不要迁移到新存储？
  → 不迁移。非 git 项目只读兼容；git 仓库里不认，用户重新 `tenon test trust` 一次写进新存储（验证第 2 轮后改定，原因见 §9）。
- **Q10** 已经入库的旧运行记录要不要改写成相对路径？
  → 不改写。记录是哈希链，改写会破坏链，只对新记录生效。
- **Q11** 代码规模评审者在没有上限时依据什么？
  → 读实测值，按自己的定义判断规模是否合理。评审者定义里提到固定上限的文字一并改掉。
- **Q12** 本仓库的 `.tenon/tests/catalog.yaml` 要不要写 `levels`？
  → 不写，内建缺省就是本仓库要的口径。目录只在实现确实需要时才改，改了随评审交用户批准。
- **Q13** `full` 档的必需类在目录里有多个套件（本仓库 unit 类有 5 个）时怎么跑？
  → 全部全量跑，与旧策略为必需种类补齐全部同类套件的口径相同。
- **Q14** `plan` 档的必需类，是要求计划里列出该套件，还是目录里有就行？
  → 目录里有就行。计划由 `tenon step run` 自动生成，不需要手工补套件。

第三轮没有新的待决问题，追问结束。

## 模块与接缝（codebase-design）

| 模块 | 接口 | 接缝与适配器 | 取代 |
|---|---|---|---|
| M1 档位解析 | `resolveStepTests(step, catalog) → StepTestRequirement`：档位或旧策略 → 统一的要求（必需类 / 种类、跑哪些、范围、阈值、场景） | 一个接缝两个适配器：档位（读 `catalog.levels` 与缺省）、旧 `test_policy`（原样） | 散落在 policy.ts、agent 提示、server DTO 里各自读 `step.test_policy` 的地方 |
| M2 阶段运行集 | `stageRunSet({requirement, catalog, plan, changedFiles}) → { missing, items[{suite, scope, reason, claimed}] }` | 纯函数；evaluate-v2 与 CLI `run-set.ts` 共用 | 两处各自从 `plan.suites` 推运行集 |
| M3 测试文件认领 | `claimChangedTestFiles(changedFiles, catalog) → { claimed: Map<suite, files>, orphans }` | 纯函数；改动列表由宿主给 | `testFileRegistration` 的未登记判定；`--auto` 的全仓扫描 |
| M4 保留注释写回 | `patchCatalogText(text, before, after) → text` | 纯函数；`updateCatalog` 调用 | `serializeTestCatalog` 用于更新（新建目录仍用它） |
| M5 信任存储 | `TrustStore.isTrusted(identity, digests) / trust(identity, entries)`；`repoTrustIdentity(cwd) → identity \| undefined` | 一个接缝两个适配器：用户级存储（git 仓库）、检出封存（只用于非 git 项目） | seal.ts 的 `trusted[]` 只在非 git 项目里读 |
| M6 路径改写 | `relativizeRunStrings(run, roots) → run` | 纯函数；roots 由 CLI 给（仓库真实 / 逻辑路径、主目录） | 无 |
| M7 证据文件判定 | 指纹内部的判定，不对外暴露 | 内部接缝，只供 fingerprint 自己的测试使用；跟踪状态复用 host-local 的 git 查询方式 | 只认声明的输出 |

删除测试：
- **M1 要保留**：删掉它，档位与旧策略的两套判断会散回求值、agent 提示、server DTO、Dashboard 四处。它有档位与旧策略两个适配器，是真接缝。
- **M2 要保留**：删掉它，求值与 `tenon test run --stage` 会各算一份运行集，两边一旦不一致，就会出现「要求跑的」与「实际跑的」对不上。
- **M3 要保留**：删掉它，认领、孤儿与 `--auto` 的口径会分成三份。
- **M5 要保留**：它有用户级存储与检出封存两个适配器，是真接缝。
- **M4、M6 只有一个调用方**：留作纯函数，便于单测，不另设接缝。
- **M7 不单列模块**。

文件长度：触碰的 `evaluate-v2.ts`（383 行）、`fingerprint.ts`（412 行）、`changed-files.ts`（422 行）都未到 500 行上限。新逻辑放进新模块（`levels.ts`、`stage-run-set.ts`、`claim.ts`、`catalog-patch.ts`、`trust-store.ts`、`run-paths.ts`），不往大文件里堆。

## 安全

- 信任仍只由用户本人确认。信任存储与密钥都在用户级状态目录，被检仓库里的任何文件都不能提供或影响信任判定（调研：mise 曾因读取仓库自带的信任设置被绕过）。
- 仓库身份要经 `git worktree list` 反查，防伪造的 `.git` 指针。
- hook 增加对 `*/test-trust/*` 的写入拒绝，并补拒绝 / 放行夹具。
- 指纹规则只放过未跟踪、证据扩展名的文件；反例测试覆盖：
  - `coverage/x.js`；
  - 已跟踪的 `test-results/a.json`；
  - 未跟踪的 `coverage/x/fixture.json`、`playwright-report/index.html`、`test-results/trace.zip`、`test-results/net.har`；
  - 没有扩展名的文件。
- 信任只在确定不是 git 仓库时退回检出封存；git 仓库里不认检出里的封存（被跟踪的、随压缩包带来的都不认）；git 出错与伪造指针一律未信任。
- 验证报告、评审者提示里的登记者自述文本，以及测试名、阻断说明，一律经 Markdown 转义后写入，不能伪造链接、图片或 HTML。
- 评审请求的待批准清单是终端纯文本，会被 agent 读到再转述：豁免理由单行化、去掉控制字符与双向字符、反引号与尖括号换成全角，不截短；受保护配置改动的路径与摘要只去控制字符，保留命令原文。
- 运行记录改写路径只做前缀替换，不读取或执行任何内容。
- `--auto` 只写精确路径，不再扩大套件认领范围。
- 不新增 npm 依赖。

## 测试

- **kernel 单测**：
  - `test` 键的解析 / 编译 / 序列化，与 `test_policy` 互斥；
  - 档位定义的解码、缺省、错误键；
  - 类映射；
  - 阶段运行集（`changed` / `full`、碰到 / 未碰到、旧策略适配）；
  - 认领（控制目录、扩展名、精确路径）；
  - `patchCatalogText` 保留注释（顶层、条目、键、列表追加、删除）；
  - 信任存储（共享、逐条摘要、伪造 `.git` 指针被拒、非 git 项目的旧封存兼容、git 仓库里不认检出封存、坏文件）；
  - 路径改写；
  - 证据文件判定与指纹反例。
- **CLI 集成测试**：
  - lite 任务全程：init → build `changed` → verify `full`，零登记、零场景映射；
  - 同一仓库的第二个 worktree 不重新信任；
  - 在途旧计划（冻结 `test_policy` + 逐个登记的 `files`）走完；
  - `catalog set` 保留注释，`--auto` 不放宽 glob；
  - 归档目录里 git 未改动的 `.spec.report` 不算改动；
  - 运行记录里没有绝对路径；
  - 未声明但未跟踪的测试日志不让候选失效。
- **其他**：
  - hook 测试：`test-trust` 写入拒绝。
  - server DTO 与工作流写接口测试；Dashboard 单测与 e2e：测试设置单选、项目测试页、任务测试页。
  - 默认工作流 codegen freshness。

```coverage
L1_api: filled -> §1 步骤 test 键、§2 目录 levels 键、§5 register --auto、§12 next 动作、§13 server DTO 与工作流写接口
L2_data: filled -> §2 档位定义、§3 测试类与别名、§9 信任存储格式、§10 运行记录、§14 兼容
L3_rules: filled -> §1 档位语义、§4 default 选档、§5 认领与改动口径、§7 场景映射、§8 代码规模
L4_state: filled -> §5 认领不写计划、§9 信任键与判定顺序、§14 冻结快照与在途任务
L5_errors: filled -> §2 档位定义校验失败关闭、§5 读不到改动列表阻断、§6 写回校验不一致不写盘、§9 坏封存读成空、§11 git 不可用一律计入
L6_security: filled -> 「安全」一节、§9 信任只由用户确认与 worktree 反查、§11 不能借目录名藏源码
L7_perf: filled -> §11 只为测试输出目录读 git 跟踪状态、§5 认领在求值时计算不写计划
L8_deps: filled -> 「安全」一节：不新增 npm 依赖
L10_terms: filled -> CONTEXT.md「Test settings」
```

## 备选方案

- **档位直接编译成旧 IR、阈值写死在代码里**：项目改不了档位含义，与「在文件中定制化」冲突，否决。
- **档位定义写在工作流 YAML 顶层**：阈值和项目的测试工具相关（有没有覆盖率报告、基准），不是流程属性。放测试目录还能让所有工作流共用，否决。
- **把认领的文件写进计划**：计划摘要会随新增测试文件变化，已有运行反复过期，否决。
- **种类改名并迁移已有目录**：要改 discover、运行器 / 格式规则、浏览器判定、运行记录，风险大、收益只在命名，否决，改为类名 + 别名。
- **信任跨仓库按命令字符串共享**：克隆来的仓库里的 `npm test` 会直接执行它自带的脚本，失去信任的意义，否决。
- **信任存进 git common dir（`.git/tenon/`）**：压缩包可以连同 `.git` 一起带来伪造的信任与密钥，否决。
- **指纹按 gitignore 排除整个测试输出目录**：可以借 `coverage/` 之类的目录名藏源码，否决，改为「未跟踪 + 证据扩展名」。
- **code-size 保留上限、只调高**：任何固定上限对大任务都不合理，否决，改为按需启用。

## 风险

- 并行任务 `rework-document-mechanism` 同改 `default.yaml`、`skills/tenon/SKILL.md`、`statusStep*`、用法文档：只改测试相关的键与行；生成物用脚本重新生成；实现步收尾前 rebase。
- 档位在求值时读目录，目录无效时按「没有档位定义」用缺省，并照旧出 `test-catalog-missing` 阻断，不放行。
- `full` 只跑被碰到的集成 / 端到端套件，依赖套件 `covers` 写得准确。本仓库目录的 `covers` 已覆盖主要源码目录，其他项目由档位定义 `required` 加类兜底。
- 信任的路径复用（删掉仓库后在同一路径克隆另一个仓库）会继承命令级信任。这与拉取新提交是同一信任级别，记为剩余风险。
- 指纹规则变化让少量在途任务升级后一次性 `revision-stale`（见 §14）。
