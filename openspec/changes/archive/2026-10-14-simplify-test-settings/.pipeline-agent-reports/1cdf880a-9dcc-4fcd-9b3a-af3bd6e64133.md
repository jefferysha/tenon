# security 评审报告（simplify-test-settings，候选 workspace:sha256:db935b2d…）

结论：未发现 critical、high 或 medium。有 3 条 low 和若干残余风险。第 2 轮的两条 medium 修复完整。

没有运行测试，也没有写任何文件。基线是 HEAD（f474225f）。

## 一、入口与出口清单（逐条结论）

**1. 测试信任**

- `trust-store.ts`（出口：写 `<stateRoot>/test-trust/<slug>.json` 和 `.key`）
  - slug 经 `SLUG` 正则校验，不可能含路径分隔或 `..`。
  - 目录必须是普通目录、非符号链接、组/其他不可写；密钥必须是 0600 的非空普通文件。
  - 写入用目录锁加 `writeUserLocalFile` 的原子写。
  - 读取失败一律读成空（失败关闭）；I/O 错误在写入路径抛错，不会覆盖已有信任。
  - 文件有 8MB 上限，密钥有 4KB 上限，条目最多 2000 条。
  - HMAC 用 `timingSafeEqual` 比较，长度不等时先挡掉。
  - 结论：通过。
- `repo-identity.ts` 和 `git-exec.ts`（出口：git 子进程）
  - `execFile` 不经 shell，参数是固定数组。
  - 环境清掉所有 `GIT_*`（不分大小写），带 10 秒超时和 4MB 输出上限。
  - 身份判定有三态。`not-repo` 只看文件系统，从 realpath 逐级向上查 `.git`；除 ENOENT 之外的任何错误都按"有 .git"处理。
  - 有 `.git` 但读不出身份一律是 `unresolved`。
  - 主检出要求 gitDir 等于 common 且根等于 worktree list 第一项。链接 worktree 要求管理目录恰为 `<common>/worktrees/<id>`、`gitdir` 回指一致，并出现在非 prunable 列表里。
  - `gitdir` 文件只读普通小文件，不会被带进管道或大文件。
  - 路径含换行时行数对不上，按失败处理。
  - 伪造 `.git` 指针借用别的仓库身份不成立。
  - 结论：通过。
- `test-trust.ts`（入口：`tenon test trust`；出口：写信任）
  - `ensureTrusted` 的判定顺序与规格一致：环境变量，其次 `user` 用户级存储，其次 `checkout` 旧封存，否则拒绝。
  - `user` 作用域在 `untrustedEntries` 里只查用户级存储，不看检出里的封存，所以压缩包或 git 里自带的封存加密钥不能授信。
  - 第 2 轮 medium 的修复经核实完整：`user` 分支直接 return，不会落到 `readTestSeal`。`legacyTrustIgnored` 只读，用于提示，抛错被吞掉。
  - `unresolved` 不查存储也不看封存，`trust` 命令拒绝写入。
  - `user` 且没有 stateRoot 时拒绝写入，不回退到写检出。
  - 非交互必须带 `--yes`，交互时要逐条回答 y。
  - 结论：通过。
- `statusStepTrust.ts`：属于展示和状态逻辑，本次未发现新增写出，结论通过。
- `hooks/gate.sh` 和 `protected-writes.sh`
  - `test-trust` 加入预过滤词、`pipeline_mentions_protected`、补丁文件扫描、脚本文件扫描，以及命令段 relevant 与 cwd 判定。
  - `pipeline_test_record_path` 对任意含 `/test-trust/` 段的目标路径返回受保护，在 `.`/`..` 段猜测逻辑之前判定。
  - `trust` 与 `TRUST` 两个词本来就在预过滤里，agent 的 Bash 里写 `tenon test trust` 或 `TENON_TEST_TRUST` 仍会被拒。
  - 它依旧是启发式识别，不是对同 UID 恶意者的防御，见残余风险。
  - 结论：通过。

**2. 候选指纹**（`test-evidence-files.ts`、`fingerprint.ts`）

- 排除条件是"只有 `test-results/`、`playwright-report/`、`coverage/` 之下 + git 未跟踪 + 普通文件 + 证据扩展名"，四条同时满足。
- 扩展名取小写，所以 `.JS` 不会被当成证据。
- 扩展名清单是惰性文本和媒体；json、html、htm、zip、gz、har 不在其中，svg 也不在。
- 符号链接、目录、无扩展名文件都不被排除。
- git 查不出来时 scope 失效，所有文件都计入，即"未知不放宽"。
- 路径规范（NFC 加 ASCII 折叠）只会让更多文件被当作"已跟踪"，也就是计入更多。
- pathspec 用 `:(literal,icase)`，名字里的通配符不生效。
- `holdsOnlyExcluded` 用 `lstat`，不跟随符号链接。
- 结论：通过。

**3. 运行记录路径改写**（`run-paths.ts`）

- 纯字符串前缀替换，不读文件，只改值不改键，返回新对象。
- 根路径用 `escapeRegExp` 转义。正则由两个字符类和转义后的备选项拼成，没有嵌套量词，没有回溯风险。
- 相对路径、空串和文件系统根不当前缀。
- 只在非原型对象上递归，不会触碰类实例。
- 结论：通过。

**4. 不可信文本展示**

- `step-test-waivers.ts`（`foldDisplayText`、`displaySafeText`、`waiverReasonText`）
  - 先折叠空白（`\s+` 覆盖 U+2028/2029 和 NBSP），再去掉 C0、DEL、C1、U+202A–202E、U+2066–2069。
  - `displaySafeText` 再把反引号换成全角、尖括号换成全角。
  - `waiverReasonText` 截到 200 字。
  - 零宽字符、LRM/ALM、标签字符不过滤，已在已知 low 名单。
  - 结论：通过。
- `review-waivers.ts`
  - 第 2 轮 medium（评审请求原样打印豁免理由）已修：豁免的键和理由走 `displaySafeText`，不截短，用户能看到全文。
  - 受保护改动的路径和摘要走 `foldDisplayText`，保留命令原文，见下文 L1。
  - `protectedError` 先 `foldDisplayText`，再截到 200 字。
  - `skippedWaiverLines` 里的 key 和 path 没有清理，属已知的既有 low。
  - 结论：修复完整。
- `waiver-metrics.ts`：指标名走 `waiverReasonText`，再截到 64 字；数值走 `Number` 格式化，非有限值被过滤。通过。
- `evaluate-inline.ts`：豁免理由走 `waiverReasonText`，并明确标注"登记者自述、未经核实"；实测值在前、不可信理由在后收尾。通过。
- `agent-prompt.ts`：`waiverReasonText` 加 `formatWaiverMetrics`，行结构固定。`agent-context.ts` 和 `agent-tests-ready.ts` 只有注释变更。通过。
- `report-md.ts`
  - `cell()` 保留反斜杠加后一个字符，并只转义裸 `|`，避免出现 `\\|` 把竖线变成列分隔。
  - 豁免理由、标题、套件 label、ref、测试 id、指标名和阻断 message 走 `escapedInline`、`escapedWaiverText` 或 `inCodeSpan`；`fix` 命令保留原文，但反引号换成全角。
  - 仍直接拼接而未转义的字段见 L3。
  - 结论：新增部分通过。

**5. 目录写回与 `--auto`**

- `catalog-patch.ts`
  - 纯文本行编辑，不执行任何东西。
  - 写回前校验：原文与 before 必须一致（防止读后被改）；写回后整份重新解析，必须与 after 的 `canonicalJson` 完全相等，否则抛错、不写盘。
  - 对象列表按身份键对应条目，对不上时退回整节点替换。
  - 结论：通过。
- `claim-orphans.ts`
  - 候选来自本任务改动列表，先 `withoutControlPaths`，再 `looksLikeTestFile`。
  - 追加的是相对套件 cwd 的精确路径；含 `* ? [ ] { } !` 或反斜杠的一律进 unresolved，不写通配符。
  - 追加后必须 `matchesAnyGlob` 真能认领该文件，否则同样进 unresolved。
  - 已有 glob 一字不动。
  - 结论：通过。
- `test-register-auto.ts`
  - 候选只取 `lstat` 为普通文件的路径，符号链接不算。
  - 写目录经 `updateCatalog`，在锁内以当前目录为准重新认领。
  - 有 unresolved 时目录一个字节都不写，并给出补套件的命令。
  - 读不到 diff 时不认领任何文件。
  - 路径只来自 git 改动列表，没有直接用用户输入拼路径。
  - 结论：通过。

**6. server 写接口**

- 本次 server 非测试文件的改动只有 `workflowOrchestration.ts`（`suiteMatchesKind`，纯读展示）、`testEvidenceSnapshot.ts`、`testPolicyDto.ts`、`testSystemDtoTypes.ts`、`testSystemReads.ts`，没有新增路由和写接口。
- 互斥校验在 kernel 的 `compile-test-policy.ts:111`：`test` 与 `test_policy` 只能写一个。`decodeWorkflowDef` 和 `compile` 被 server 的 workflow 写入链路复用，所以 Dashboard 写工作流时走同一条校验链。
- `parse.ts` 对重复的 `test_policy` 也会报错。
- 我没有逐个核对每条写路由的调用链，这一点标为不确定；没有看到绕过校验的新入口。
- 结论：未发现越权或绕过。

## 二、发现清单

均为 low，不触发 medium 阻断。

**L1（low）**：`packages/cli/src/commands/review-waivers.ts:153` 和 `:161`。受保护改动的行（路径、摘要、目录语义摘要）只用 `foldDisplayText`，保留反引号和尖括号。
- 可利用路径：能控制仓库文件名或 catalog 命令的人，可以让评审请求输出里出现行内反引号或类标签文本，影响 agent 转述给用户的展示。
- 限制条件：单行折叠，换行和控制字符已被清掉，伪造不出多行代码块；规格要求"用户看到的命令必须与实际执行的一致"，所以这是有意取舍。
- 修法：可选加固。对路径部分用 `displaySafeText`，命令摘要保留原文。

**L2（low）**：`packages/cli/src/commands/review-waivers.ts:179-180`。`skippedWaiverLines` 把 `item.key` 和 `item.path` 直接拼进输出，没有清理。
- 这是已知的既有问题，不重复计入。
- 可利用路径：同 L1 的展示类问题，只是这里清理更少。
- 修法：对 key 和 path 做 `foldDisplayText`。

**L3（low）**：`packages/cli/src/test-system/report-md.ts:184-191` 和 `:213-214`。以下字段直接拼进 Markdown，没有转义：benchmarkRows 的 `suite.suite`、`metric.name` 和 `metric.details`，以及 flaky 与 failing 行里括号内的 `suite.suite`。
- 这是旧代码，本次未改动，只是新增的转义没有覆盖到这里。
- 可利用路径：套件 id 受 catalog 校验约束，风险较小；`metric.name` 和 `details` 来自测试命令的输出，是不可信文本。恶意输出可以在验证报告里注入链接或图片。
- 修法：对 `metric.name`、`details` 和 `suite.suite` 走 `escapedInline`。

## 三、残余风险

1. **非 git 目录的检出旧封存（规格明文保留）**：检出目录及其所有上级都没有 `.git` 时，仍然认检出里的旧封存。压缩包自带封存和密钥时，可以自行授信。这与规格一致，不属于实现偏差。只要 `.git` 存在，不论能否读出身份，都不会走这条路径。
2. **同 UID 的 agent**：HMAC 密钥与存储同在用户级目录，同一用户下的进程读到密钥就能重算封印。防线是 hook 对 `test-trust` 路径的写入拒绝，以及对 `tenon test trust` 和 `TENON_TEST_TRUST` 的拒绝。hook 是启发式识别，不是密码学隔离；agent 用 Bash 读密钥文件没有被专门拦截（`env.key` 的既有做法类似）。设计文档已承认这一点。
3. **同一路径换仓库继承信任**：身份是 common dir 的 realpath；同一路径下换了另一个仓库，会继承之前的信任。规格已记为剩余风险。
4. **证据名单保留 `xml`**（规格定死）、`foldDisplayText` 不过滤零宽/LRM/ALM/标签字符：均为已知 low。
5. **DoS**：没有发现新增的无上限循环、递归或读入。信任存储、`gitdir` 文件、git 输出、密钥都有大小上限，git 有超时。
6. **依赖与供应链**：本次改动没有新增依赖。`packages/cli/dist/tenon.mjs` 是构建产物，没有逐行审，需要靠构建一致性检查保证。
7. **并行任务 `rework-document-mechanism` 的 rebase 分叉**：不在本次评审范围。

```tenon-result
{"findings":[{"severity":"low","location":"packages/cli/src/commands/review-waivers.ts:153","message":"受保护改动行只做 foldDisplayText，保留反引号与尖括号（规格要求命令原文）；可构造行内伪标记影响 agent 转述，仅单行，建议路径部分改用 displaySafeText"},{"severity":"low","location":"packages/cli/src/commands/review-waivers.ts:179","message":"skippedWaiverLines 的 key/path 未清理控制与双向字符（既有问题），建议 foldDisplayText"},{"severity":"low","location":"packages/cli/src/test-system/report-md.ts:184","message":"benchmark 行的 suite、metric.name、details 与 flaky/failing 行的 suite id 未经 escapedInline，探针输出的指标名可向验证报告注入链接或图片（旧代码，本次转义未覆盖）"}]}
```
