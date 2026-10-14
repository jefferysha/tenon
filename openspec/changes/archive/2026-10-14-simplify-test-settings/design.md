# 设计

完整设计、追问记录与模块接缝见 `docs/superpowers/specs/simplify-test-settings-design.md`，决策摘要见 `docs/adr/simplify-test-settings.md`。下面只列结论与它对应的设计文档小节。

## 决策

- **档位**（§1）：工作流步骤写 `test: none | plan | changed | full`。
  - 冻结 IR 只记档位名，求值时读测试目录。
  - 旧 `test_policy` 兼容读取，与 `test` 同步互斥。
- **档位定义**（§2）：`.tenon/tests/catalog.yaml` 的 `levels`，每档 `required`、`touched`、`scenarios`、`coverage`、`flaky`、`require_baseline`，内建缺省如下：
  - `plan`：必需 unit；
  - `changed`：必需 unit，碰到才跑 static；
  - `full`：必需 unit，碰到才跑 integration / e2e / static / benchmark。
- **碰到**（§2）：改动文件匹配套件 `files` 或 `covers` 才算碰到。
  - `changed` / `full` 档里，`required` 或 `touched` 类有套件没写 `covers`、因此没进运行集，而本任务改了源码文件时，出不阻断的提示 `suites-without-covers`，点名这些套件。
  - `--stage` 打印同样的提示（验证第 3 轮后端评审 medium：自动识别的套件没有 `covers`，只改源码时零运行且没有任何提示）。
- **测试类**（§3）：unit、integration、e2e、static、benchmark 加 custom。
  - 旧种类名为别名；档位按类匹配，旧策略按种类逐字匹配。
- **default 选档**（§4）：
  - 轻量：实现 changed / 验证 full；
  - 产品：规格 none / 验证 changed；
  - 前端、后端：规格 plan / 实现 changed / 验证 full。
- **认领**（§5）：
  - 改动过的测试文件按套件 `files` glob 在求值时认领，不写计划，旧 `files: registered` 也一样。
  - 改动口径排除 `openspec/`、`.tenon/`、`.pipeline/`；测试文件名要求源码扩展名。
  - `--auto` 只处理改动里的孤儿，只追加精确路径。
- **保留注释**（§6）：`updateCatalog` 改为按顶层键、套件条目、条目内键三层，只替换变化节点的行。
- **场景映射**（§7）：缺省不要求；不要求时追溯矩阵只列已映射的行，加一行统计。
- **代码规模**（§8）：
  - default 与方向模板删掉 2000 行上限，探针照常统计；
  - 豁免展示附带最新实测值。
- **信任**（§9）：
  - 存于 `<stateRoot>/test-trust/<user>.json`，HMAC 封印；
  - 键为用户 + git common dir 真实路径（经 `git worktree list` 反查）+ 单条命令摘要；
  - 只有检出目录及上级都没有 `.git` 时才认检出旧封存，`tenon test trust` 也写在那里。
  - git 仓库里不认检出旧封存，不论它是否被跟踪。检出里的封存与密钥可能随压缩包带来。以前信任过的命令要重新确认一次（验证第 2 轮安全评审 medium）。
  - 有 `.git` 却读不出身份（git 出错、伪造指针）一律未信任；
  - hook 拒绝 agent 写 `*/test-trust/*`。
- **相对路径**（§10）：新运行记录在算摘要前，把仓库根与主目录前缀改写为相对路径与 `~`；旧记录不回写。
- **指纹**（§11）：测试输出目录下未跟踪、证据扩展名的文件不计入候选；git 不可用时一律计入。
  - 证据扩展名只含日志、文本报告、图片、录像与覆盖率数据。
  - json、html、htm、zip、gz、har 这类能被代码或浏览器直接加载、解包的格式照旧计入，由目录声明放行（验证第 1 轮安全评审 medium）。

## 风险

- 并行任务 `rework-document-mechanism` 同改 `default.yaml`、`skills/tenon/SKILL.md`、`statusStep*`、用法文档：
  - 只改测试相关的键与行；
  - 生成物用脚本重新生成；
  - 实现步收尾前 rebase 到最新 `origin/main`。
- `full` 只跑被碰到的集成 / 端到端套件，依赖套件 `covers` 写得准确。
- 信任在同一路径换成另一个仓库后会被继承（与拉取新提交同属一个信任级别）。
- 指纹规则变化让工作区里有未声明测试输出的在途任务，升级后一次性 `revision-stale`。
- N-1 版本读不了 `test` 与 `levels`，回滚前要先结束用新键建的任务。
- 本仓库目录如有改动，属受保护的测试配置，需随评审交用户批准。

## 待验证问题

无。立项时列出的问题已在调研步按推荐确定，见设计文档「追问记录」。
