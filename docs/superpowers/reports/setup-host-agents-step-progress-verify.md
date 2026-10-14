# 验证报告

## 验证范围

任务 `setup-host-agents-step-progress`（default 工作流，backend 轨道）的全部实现，对照
`openspec/changes/setup-host-agents-step-progress/specs/` 下五个能力的 delta spec：

- `host-native-subagents`：`tenon agent install|uninstall` 写用户级宿主 agent 文件（目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，
  所有权按目录分组）、`tenon setup` / `tenon update` 后自动安装、`tenon agent prompt` 的一致性判定与退回原因（提示里给出所检查的目录）、
  `tenon agent record --subagent none`、旧版本留在项目里的 `tenon-<name>` 文件清理（CLI 与 Dashboard 服务端）。
- `effective-workflow-plan`：`tenon workflow progress` 与 PostToolUse hook `step-progress` 的终端步骤清单。
- `change-start-point`：`start_sha` 记录（伴随文件承载，N-1 可读）与起点候选取最新、读取时的提交时间校验、三个起点字段拒写。
- `task-worktree-isolation`：`tenon init` 建 `.worktrees/<change>`、原地条件（`TENON_INIT_IN_PLACE=1` 不输出原因）、冲突与回滚、
  信任继承与测试目录 `setup`、主检出发现 worktree 任务、worktree 任务的构建版本绑工作区指纹、完整指纹跳过未跟踪的 `.claude/worktrees/`、
  完结后的 `cleanup` 提示。
- `workflow-skill-enforcement`：退回边不要求归属 agent 的技能。

验证分三部分：自动化测试（本步要求的测试套件，外加 bundle 与 N-1 兼容门）、验证评审者（规格一致性、后端质量、安全、代码规模），
真机验收（tasks.md 验证节第 3、4 项）。

## 执行命令

本轮（验证第 4 次访问、轮次 2/2，候选 `workspace:sha256:805e51a8…`）全部在 `env -u CLAUDE_CONFIG_DIR -u CODEX_HOME` 下执行，Tenon 留有记录：

- `tenon test run setup-host-agents-step-progress --stage`（记录 `20261012T004218Z-0c3cad`）：unit、tools-node、hooks、adapters、migration-cas、oracle。
- `tenon test run setup-host-agents-step-progress --suite bundle`（记录 `20261012T010051Z-e059bc`）：含 N-1 双向读写与完整指纹逐位一致检查。
- `tenon test run setup-host-agents-step-progress code-size`。
- 四个必需评审者：spec-consistency（run `98cca140…`）、backend-quality（`3a63470d…`）、security（`bfb402f1…`）、code-size（`99a22678…`）。
- 交付前预检：用「即将提交的文件集」（已跟踪 + 未跟踪未忽略，排除另外两个在途任务目录）跑仓库卫生检查，0 处问题。
- 真机验收：本机 Claude Code 2.1.296 无头会话（`claude -p … --include-hook-events`，会话 `9ddf5388…`），在临时仓 `rm-demo2` 里建任务 `rm-check`。
  本机 tenon 为源码开发安装，CLI 包 sha256 `16af849b…12238` 与仓库 `packages/cli/dist/tenon.mjs` 一致；
  子代理由 `tenon setup --claude --from-source … --skip-build` 安装到 `$CLAUDE_CONFIG_DIR/agents`（输出首行给出该目标目录）。

## 结果

| 证据 | 结果 |
| --- | --- |
| unit（vitest 全量） | 11068 通过 / 0 失败 / 18 跳过 |
| tools-node | 214 通过 / 0 失败 |
| hooks | 2317 通过 / 0 失败 |
| adapters | 397 通过 / 0 失败 |
| migration-cas | 13 通过 / 0 失败 |
| oracle 双跑 | 105 通过 / 0 失败 |
| bundle（含 N-1 兼容门） | 87 通过 / 0 失败 |
| code-size | 未通过（`lines_added` 16721 > 2000），登记豁免 `test:code-size`，待 verify-pass 评审门由用户批准 |
| spec-consistency | 通过（4 条 low）；五个 delta spec 的全部 Requirement 与 Scenario 逐条有实现与测试证据；曾经的两条 medium 已在规格第五轮对齐 |
| backend-quality | 通过（5 条 low），11 个能力逐项核对 |
| security | 通过（2 条 low），8 个信任边界逐项核对，含卫生检查豁免不可被利用 |
| code-size 评审者 | 通过（2 条 low）；曾经的 medium（`init.test.ts` 该拆没拆）在 Task 17 拆分后关闭 |

真机验收（全部通过，逐轮输出见会话记录）：

| 项 | 结果 |
| --- | --- |
| 建任务后终端打印步骤清单 | `tenon init rm-check …` 后 PostToolUse 输出 `Tenon · rm-check` 与 `立项 ● → 调研 ○ → …` |
| 新任务落在 `.worktrees/rm-check`，`EnterWorktree` 后 activate | `EnterWorktree path=…/.worktrees/rm-check` 后 `tenon session activate rm-check` 成功，清单照常打印 |
| 会话里派发 `tenon-researcher` | `tenon agent prompt` 返回 `subagent_type: tenon-researcher`、`reason: null`；Agent 派发成功返回报告，无 not found |
| 流转后清单前进 | `open-complete` 后 `立项 ✓ → 调研 ●`；`explore-complete` 后 `调研 ✓ → 规格 ●` |
| 评审门「确认继续」生效 | UserPromptSubmit 写入 `<tenon-review-confirmed>`（事件 `explore-complete`），hook 以 worktree 为项目根，随后流转成功 |
| 失败的流转不打印 | `tenon transition rm-check bad-event` 退出码 1，宿主触发 `PostToolUseFailure`，无清单输出 |
| 主检出 `tenon list` | 列出 `rm-check` 与 worktree 路径；主检出 `git status --short` 为空 |

## 失败与阻塞

- 验证第 1 次访问：构建版本 `revision-stale`。完整工作区指纹计入了未跟踪的 `.claude/worktrees/`（同仓库其它会话与子代理的检出），
  退回规格第三轮补需求，Task 15 修复（完整指纹跳过未跟踪的 `.claude/worktrees/`，`tenon status` 从分钟级降到数秒）。
- 验证第 2 次访问：真机验收发现本机 Claude 设了 `CLAUDE_CONFIG_DIR`，宿主只读 `$CLAUDE_CONFIG_DIR/agents`，而安装写死 `~/.claude/agents`，
  派发报 `Agent type 'tenon-researcher' not found`。退回规格第四轮，Task 16 修复（目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`）。
- 验证第 3 次访问：评审者 3 条 medium（规格措辞两条、`init.test.ts` 该拆没拆一条）。退回规格第五轮对齐措辞，Task 17 拆分测试。
- 验证第 3 次访问之后的交付前预检：调研步 researcher 报告（台账绑内容摘要、不能改写）正文引用了一个外部参考项目名，提交后 CI 的
  `check:repository-hygiene` 会失败。退回实现，为这一份报告加窄豁免（只放行一个文件名、只放行第一个参考身份，在途与归档两个路径），补 node 测试。
- 本轮没有失败与阻塞；唯一待办是 `test:code-size` 豁免需用户在 verify-pass 评审门批准。

## 剩余风险

- 设了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 的用户要在带同样变量的环境里安装子代理；环境不一致时 `prompt` 退回通用子代理并给出所检查的目录。
- `start_sha` 伴随文件不在摘要里：读取时校验提交时间不晚于 `created_at` + 60 秒，改写或删除只会让改动范围变宽；伪造早于 `created_at` 的提交时间仍能绕过（同用户同机器的信任模型内，已写进 CONTRACT）。
- 测试目录 `setup` 的信任只绑命令文本，不绑命令执行时读取的仓库文件（与测试套件同一模型）。
- 完整指纹不再计入未跟踪的 `.claude/worktrees/`：有该目录的机器上，0.3.0 的测试记录升级后、当前版本的评审结论回滚到 v0.3.1 后会被判过期重跑（不判损坏）。
  `.claude/settings.local.json` 仍计入完整指纹，用户回答权限提示时 Claude Code 改写它会让原地任务的构建版本过期（本任务未处理）。
- 评审者的 low 级提示保留未改：hook 任务名正则只认小写（含大写或下划线的任务名不打印清单）、`init` 同名检查的 TOCTOU 窗口、
  两个既有测试夹具未列入 CLI tsconfig exclude（只在被忽略的本地 dist 里）、恶意仓库借 `.git` 文件重定向影响旧文件清理范围（受文件名与清单哈希限制）等。
- 真机验收用的是无头会话（`claude -p`）；交互式终端里 `systemMessage` 的显示已在验证第 2 次访问时由用户截图确认（`PostToolUse:Bash says: Tenon · rm-check …`）。

## 测试

<!-- tenon:tests:start digest=sha256:5e23b321ebd6015e4c58351b8e5fa615334849404c22ff1371e9c96e80190d0c -->
| 阶段 | 测试 | 方向 | 状态 | 退出码 | 耗时 | 执行人 | 时间 | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 验证 | 代码规模 `code-size` | code-size | 失败 | 0 | 0.4s | jefferySha | 2026-10-12T00:42:17.160Z | `workspace:sha256:805e…` |
### 失败
- `code-size`：metric-threshold — `.tenon/users/710227704-at-qq.com/tests/setup-host-agents-step-progress/20261012T004216Z-33455d.json`
### 命令
- `code-size`：`tenon test code-size --json`（cwd `.`）
<!-- tenon:tests:end -->

<!-- tenon:test-report:begin -->
## 测试体系

### 追溯矩阵
| 场景 / 任务 | 用例 | 最近结果 | 状态 |
| --- | --- | --- | --- |
| change-start-point · 上游拉进来的提交不算本任务的 `spec:change-start-point/上游拉进来的提交不算本任务的` | — | — | 未覆盖 |
| change-start-point · 建任务前已有的本地提交不算 `spec:change-start-point/建任务前已有的本地提交不算` | — | — | 未覆盖 |
| change-start-point · 本任务自己的本地提交仍算 `spec:change-start-point/本任务自己的本地提交仍算` | — | — | 未覆盖 |
| change-start-point · 原地任务推送到 base 上游后的已知限制 `spec:change-start-point/原地任务推送到 base 上游后的已知限制` | — | — | 未覆盖 |
| change-start-point · 旧任务没有 start_sha `spec:change-start-point/旧任务没有 start_sha` | — | — | 未覆盖 |
| change-start-point · 既无记录也无上游 `spec:change-start-point/既无记录也无上游` | — | — | 未覆盖 |
| change-start-point · CLI 与 Dashboard 看到同一份改动 `spec:change-start-point/CLI 与 Dashboard 看到同一份改动` | — | — | 未覆盖 |
| change-start-point · 改写起点被拒 `spec:change-start-point/改写起点被拒` | — | — | 未覆盖 |
| effective-workflow-plan · 流转后打印清单 `spec:effective-workflow-plan/流转后打印清单` | — | — | 未覆盖 |
| effective-workflow-plan · 自定义短工作流 `spec:effective-workflow-plan/自定义短工作流` | — | — | 未覆盖 |
| effective-workflow-plan · 归档后全部完成 `spec:effective-workflow-plan/归档后全部完成` | — | — | 未覆盖 |
| effective-workflow-plan · 无关命令不打印 `spec:effective-workflow-plan/无关命令不打印` | — | — | 未覆盖 |
| effective-workflow-plan · 失败的流转不打印 `spec:effective-workflow-plan/失败的流转不打印` | — | — | 未覆盖 |
| host-native-subagents · 宿主配置目录由环境变量指定 `spec:host-native-subagents/宿主配置目录由环境变量指定` | — | — | 未覆盖 |
| host-native-subagents · Codex 配置目录由 CODEX_HOME 指定 `spec:host-native-subagents/Codex 配置目录由 CODEX_HOME 指定` | — | — | 未覆盖 |
| host-native-subagents · 环境变量不是绝对路径时不采用 `spec:host-native-subagents/环境变量不是绝对路径时不采用` | — | — | 未覆盖 |
| host-native-subagents · 终端安装官方与自定义 agent `spec:host-native-subagents/终端安装官方与自定义 agent` | — | — | 未覆盖 |
| host-native-subagents · 重复安装不改写 `spec:host-native-subagents/重复安装不改写` | — | — | 未覆盖 |
| host-native-subagents · 已是最新版本的 update 仍安装 `spec:host-native-subagents/已是最新版本的 update 仍安装` | — | — | 未覆盖 |
| host-native-subagents · 项目层同名 agent 不影响用户级安装 `spec:host-native-subagents/项目层同名 agent 不影响用户级安装` | — | — | 未覆盖 |
| host-native-subagents · 项目层 agent 不写入宿主目录 `spec:host-native-subagents/项目层 agent 不写入宿主目录` | — | — | 未覆盖 |
| host-native-subagents · 不同配置目录互不影响 `spec:host-native-subagents/不同配置目录互不影响` | — | — | 未覆盖 |
| host-native-subagents · 用户自有同名文件不覆盖 `spec:host-native-subagents/用户自有同名文件不覆盖` | — | — | 未覆盖 |
| host-native-subagents · 库中删除的 agent 被清掉 `spec:host-native-subagents/库中删除的 agent 被清掉` | — | — | 未覆盖 |
| host-native-subagents · 用户目录经符号链接管理 `spec:host-native-subagents/用户目录经符号链接管理` | — | — | 未覆盖 |
| host-native-subagents · 卸载保留被修改的文件 `spec:host-native-subagents/卸载保留被修改的文件` | — | — | 未覆盖 |
| host-native-subagents · 会话中建任务不产生宿主文件 `spec:host-native-subagents/会话中建任务不产生宿主文件` | — | — | 未覆盖 |
| host-native-subagents · 新建自定义 agent 只提示安装 `spec:host-native-subagents/新建自定义 agent 只提示安装` | — | — | 未覆盖 |
| host-native-subagents · 已安装且一致 `spec:host-native-subagents/已安装且一致` | — | — | 未覆盖 |
| host-native-subagents · 未安装 `spec:host-native-subagents/未安装` | — | — | 未覆盖 |
| host-native-subagents · 会话的配置目录与安装位置不同 `spec:host-native-subagents/会话的配置目录与安装位置不同` | — | — | 未覆盖 |
| host-native-subagents · 冻结版本与已装版本不同 `spec:host-native-subagents/冻结版本与已装版本不同` | — | — | 未覆盖 |
| host-native-subagents · 被项目级旧文件遮住 `spec:host-native-subagents/被项目级旧文件遮住` | — | — | 未覆盖 |
| host-native-subagents · 项目层 agent `spec:host-native-subagents/项目层 agent` | — | — | 未覆盖 |
| host-native-subagents · 开始后未派发 `spec:host-native-subagents/开始后未派发` | — | — | 未覆盖 |
| host-native-subagents · 建任务时清掉旧文件 `spec:host-native-subagents/建任务时清掉旧文件` | — | — | 未覆盖 |
| host-native-subagents · 清单条目丢失但内容一致 `spec:host-native-subagents/清单条目丢失但内容一致` | — | — | 未覆盖 |
| host-native-subagents · 用户改过的旧文件保留 `spec:host-native-subagents/用户改过的旧文件保留` | — | — | 未覆盖 |
| task-worktree-isolation · 在主检出里建任务 `spec:task-worktree-isolation/在主检出里建任务` | — | — | 未覆盖 |
| task-worktree-isolation · 已在 linked worktree 里 `spec:task-worktree-isolation/已在 linked worktree 里` | — | — | 未覆盖 |
| task-worktree-isolation · 测试工装要求原地 `spec:task-worktree-isolation/测试工装要求原地` | — | — | 未覆盖 |
| task-worktree-isolation · 同名分支已存在 `spec:task-worktree-isolation/同名分支已存在` | — | — | 未覆盖 |
| task-worktree-isolation · 两个任务并行互不污染 `spec:task-worktree-isolation/两个任务并行互不污染` | — | — | 未覆盖 |
| task-worktree-isolation · 未提交的目录改动 `spec:task-worktree-isolation/未提交的目录改动` | — | — | 未覆盖 |
| task-worktree-isolation · 信任过的目录自动准备 `spec:task-worktree-isolation/信任过的目录自动准备` | — | — | 未覆盖 |
| task-worktree-isolation · 目录改动后要重新信任 `spec:task-worktree-isolation/目录改动后要重新信任` | — | — | 未覆盖 |
| task-worktree-isolation · 准备命令失败 `spec:task-worktree-isolation/准备命令失败` | — | — | 未覆盖 |
| task-worktree-isolation · Claude Code 同一会话继续 `spec:task-worktree-isolation/Claude Code 同一会话继续` | — | — | 未覆盖 |
| task-worktree-isolation · 列出 worktree 任务 `spec:task-worktree-isolation/列出 worktree 任务` | — | — | 未覆盖 |
| task-worktree-isolation · 在主检出说继续 `spec:task-worktree-isolation/在主检出说继续` | — | — | 未覆盖 |
| task-worktree-isolation · 主检出的新请求不受 worktree 任务影响 `spec:task-worktree-isolation/主检出的新请求不受 worktree 任务影响` | — | — | 未覆盖 |
| task-worktree-isolation · 主检出建任务后打印清单 `spec:task-worktree-isolation/主检出建任务后打印清单` | — | — | 未覆盖 |
| task-worktree-isolation · 未提交的实现可以验证 `spec:task-worktree-isolation/未提交的实现可以验证` | — | — | 未覆盖 |
| task-worktree-isolation · 换检出验证被拒 `spec:task-worktree-isolation/换检出验证被拒` | — | — | 未覆盖 |
| task-worktree-isolation · 另一个会话在 `.claude/worktrees/` 下工作 `spec:task-worktree-isolation/另一个会话在 `.claude/worktrees/` 下工作` | — | — | 未覆盖 |
| task-worktree-isolation · 被 git 跟踪的文件照算 `spec:task-worktree-isolation/被 git 跟踪的文件照算` | — | — | 未覆盖 |
| task-worktree-isolation · 完结提示 `spec:task-worktree-isolation/完结提示` | — | — | 未覆盖 |
| workflow-skill-enforcement · Hook 负例不能由可选 Skill 绕过 `spec:workflow-skill-enforcement/Hook 负例不能由可选 Skill 绕过` | — | — | 未覆盖 |
| workflow-skill-enforcement · CLI 与 HTTP transition 同时失败关闭 `spec:workflow-skill-enforcement/CLI 与 HTTP transition 同时失败关闭` | — | — | 未覆盖 |
| workflow-skill-enforcement · 退回边不要求执行者的 Skill `spec:workflow-skill-enforcement/退回边不要求执行者的 Skill` | — | — | 未覆盖 |
| 写 proposal / design / tasks：记录会话中途生成子代理导致 not found 的证据、Todo 工具缺失的证据、与另一款终端一次性安装式开发工具的对比、范围与非目标。 `task:1.1` | — | — | 可选 |
| 核实 Claude Code 子代理加载时机、用户级与项目级的优先级、hook `systemMessage` 的显示行为；Codex 对应能力。 (explore) `task:2.1` | — | — | 可选 |
| 对照 `tenon setup` / `tenon update` / `tenon sync` / `tenon uninstall` 的职责，选定子代理文件的写入命令与位置，写进设计。 (explore) `task:2.2` | — | — | 可选 |
| 定旧项目级文件、所有权清单与本机排除的迁移清理方案，写进设计。 (explore) `task:2.3` | — | — | 可选 |
| 写 `host-native-subagents` 的 delta spec（终端安装写用户级、会话内不写、一致性判定与原因、项目层退回、旧文件清理）。 (spec) `task:3.1` | — | — | 可选 |
| 写 `effective-workflow-plan` 的 delta spec（`tenon workflow progress` 与 `step-progress` hook 打印步骤清单，不依赖宿主 Todo 工具）。 (spec) `task:3.2` | — | — | 可选 |
| 写实施计划与测试计划：改动顺序、验收命令、受影响的单测与集成测试。 (spec) `task:3.3` | — | — | 可选 |
| 第二轮：写 `change-start-point`、`task-worktree-isolation` 的 delta spec 与 `workflow-skill-enforcement` 的修改；`host-native-subagents` 补未派发运行的登记。 (spec) `task:3.4` | — | — | 可选 |
| 第二轮：更新 proposal / design / 技术设计 / ADR 与实施计划，覆盖任务起点、新任务 worktree、worktree 构建版本、退回边技能门。 (spec) `task:3.5` | — | — | 可选 |
| 第三轮：`task-worktree-isolation` 补「宿主为子代理与会话建的检出不计入工作区指纹」；同步 proposal / design / 技术设计 / ADR / 实施计划，并修正其中已过时的兼容性与 hook `if` 过滤表述。 (spec) `task:3.6` | — | — | 可选 |
| 第四轮：`host-native-subagents` 改为用户级子代理目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`、所有权按目录分组、退回提示给出所检查的目录；同步 proposal / design / 技术设计 / ADR / 实施计划。 (spec) `task:3.7` | — | — | 可选 |
| 第五轮：`task-worktree-isolation` 写明 `TENON_INIT_IN_PLACE=1` 原地建立不输出原因（`--in-place` 照常输出）；`change-start-point` 补上 `start_sha` 入选候选的提交时间条件（不晚于 `created_at` + 60 秒）；同步 proposal / design / 技术设计 / ADR / 实施计划。 (spec) `task:3.8` | — | — | 可选 |
| kernel：用户级宿主文件写入与用户级所有权清单（`<configRoot>/agents/host-owned.json`），过期文件删除，符号链接拒绝。 (build) `task:4.1` | — | — | 未覆盖 |
| cli：新增 `tenon agent install [--host]` 与 `tenon agent uninstall [--host]`；`tenon setup` / `tenon update`（含已是最新版）成功后调用安装；`agent add/new/copy/rm` 改为只提示。 (build) `task:4.2` | — | — | 未覆盖 |
| cli：删除 `tenon init` 与 `tenon agent prompt` 中的生成调用；prompt 改为比较用户级文件与冻结定义，返回通用子代理时记录原因并提示。 (build) `task:4.3` | — | — | 未覆盖 |
| cli + server：回收逻辑改为旧项目级文件清理，在 `tenon init` 与归档/删除任务时执行。 (build) `task:4.4` | — | — | 未覆盖 |
| cli：新增 `tenon workflow progress <change>`。 (build) `task:4.5` | — | — | 未覆盖 |
| hook：新增 `hooks/step-progress.sh` 并注册到 `hooks/hooks.json`；实测 Codex 是否接受 `if` 字段。 (build) `task:4.6` | — | — | 未覆盖 |
| 修改 `skills/tenon/SKILL.md` 第 5 步与 `run-agent` 行；更新 `docs/usage/agents.md` 中英文版。 (build) `task:4.7` | — | — | 未覆盖 |
| 更新与新增 kernel / cli / server 单测与集成测试、hook 测试。 (build) `task:4.8` | — | — | 未覆盖 |
| kernel：`start_sha` 字段（CLI init、Dashboard 建任务、triage 物化都写入）与起点候选取最新的解析，全部使用方经同一入口；三个决定起点的字段经 CLI 不可改写。 (build) `task:4.9` | — | — | 未覆盖 |
| kernel + cli：`tenon init` 建任务 worktree（判定、创建、失败回滚、本机排除、`base_branch` / `isolation` / `start_sha`），继承信任条目，执行测试目录 `setup`；目录 schema 增加 `setup` 并配置本仓。 (build) `task:4.10` | — | — | 未覆盖 |
| cli + hook + skill：`tenon list`、按名读取的报错与 `hooks/router.sh` 找到 worktree 任务；skill「进入」与恢复改为切进 worktree；`finish-change` 附带 `cleanup`。 (build) `task:4.11` | — | — | 未覆盖 |
| cli + kernel：`isolation=worktree` 的构建版本改绑工作区指纹；更新 `docs/CONTRACT.md`。 (build) `task:4.12` | — | — | 未覆盖 |
| kernel + cli：退回边不要求归属 agent 的技能；`tenon agent record --subagent none` 登记 `not-dispatched`。 (build) `task:4.13` | — | — | 未覆盖 |
| 更新使用文档与 CLI 参考中英文版（新任务 worktree、准备命令、Codex 开新会话、清理命令、新命令与新选项）；`CONTEXT.md` 增加术语。 (build) `task:4.14` | — | — | 未覆盖 |
| 测试环境统一导出 `TENON_INIT_IN_PLACE=1`（vitest 全局 setup 与 shell 测试），确认既有测试与 N-1 兼容检查无回归。 (build) `task:4.15` | — | — | 未覆盖 |
| 把本任务用到与新增的测试文件与套件登记进测试计划（`tenon test register`，照 `next`）。 (build) `task:4.16` | — | — | 未覆盖 |
| kernel：完整工作区指纹跳过未被 git 跟踪的 `.claude/worktrees/`（被跟踪的照算）；更新 `host-local.ts` 说明、`docs/CONTRACT.md` 与测试，确认 N-1 指纹一致性检查仍过。 (build) `task:4.17` | — | — | 未覆盖 |
| kernel + cli：用户级子代理目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`（`hostAgentsDir`，只认绝对路径），安装、卸载、`setup` / `update` 与 `agent prompt` 判定共用；所有权清单按目录分组；`prompt` 退回时给出所检查的目录；更新测试（只用临时目录与注入的环境变量）、帮助文本与 `docs/usage/agents.md` 中英文版。 (build) `task:4.18` | — | — | 未覆盖 |
| cli 测试：把 `init.test.ts` 里「新任务建在 worktree 里」一组用例搬到 `init-worktree.test.ts`、其中「信任继承与 setup」一组搬到 `init-worktree-setup.test.ts`，两者共用的夹具抽到 `init-worktree-test-support.ts`（并加入 `packages/cli/tsconfig.json` 的 `exclude`，不进 CLI dist）；用例原样搬、不改断言，新文件登记进测试计划。 (build) `task:4.19` | — | — | 未覆盖 |
| 工具：仓库卫生检查为本任务调研步的 researcher 报告（`.pipeline-agent-reports/10167049-5af1-4624-bd94-53b2548a9153.md`，在途与归档两个路径）加一条窄豁免，只放行第一个参考身份；报告带登记摘要不能改写，做法与已有调研记录的豁免一致，并补 node 测试。 (build) `task:4.20` | — | — | 未覆盖 |
| cli、kernel、server 单测与集成测试、hook 测试（`npm run test:hooks`）、bundle 与 N-1 兼容检查、类型检查、lint 全过。 (verify) `task:5.1` | — | — | 可选 |
| 本地跑齐 `package.json` 的 `check:*`（至少 `check:repository-hygiene`、`check:openspec`、`check:docs`、`check:architecture`）。 (verify) `task:5.2` | — | — | 可选 |
| 真机验收：在带着本机 `CLAUDE_CONFIG_DIR` 的环境里 `tenon agent install` 后开新会话，会话里新建任务并派发 `tenon-researcher` 成功；`tenon transition` 后终端出现步骤清单，失败的 `tenon transition` 不出现清单。 (verify) `task:5.3` | — | — | 可选 |
| 真机验收：主检出会话里新建任务落在 `.worktrees/<change>`，`EnterWorktree` 切入后 activate 与评审确认生效（确认 hook 的 `cwd`）；主检出 `tenon list` 能看到它。 (verify) `task:5.4` | — | — | 可选 |
| 提交交付物。 (ship) `task:6.1` | — | — | 可选 |
| 归档变更。 (archive) `task:7.1` | — | — | 可选 |

### 套件
| 套件 | 种类 | 结果 | 用例 | 覆盖率 | 运行 |
| --- | --- | --- | --- | --- | --- |
| 适配器 conformance `adapters` | integration | 通过 | 397/397 | — | `20261012T004218Z-0c3cad` |
| hook 脚本 `hooks` | integration | 通过 | 2317/2317 | — | `20261012T004218Z-0c3cad` |
| 主规格迁移原子 CAS `migration-cas` | integration | 通过 | 13/13 | — | `20261012T004218Z-0c3cad` |
| golden oracle 双跑 `oracle` | regression | 通过 | 105/105 | — | `20261012T004218Z-0c3cad` |
| 单测 · tools 脚本 `tools-node` | unit | 通过 | 214/214 | — | `20261012T004218Z-0c3cad` |
| 单测 · packages `unit` | unit | 通过 | 11068/11086 (18 skip) | — | `20261012T004218Z-0c3cad` |

### 仍挡出口的项
- [waiver-unapproved] 测试 代码规模（code-size） 失败（metric-threshold），豁免尚未经评审批准 → `tenon review request setup-host-agents-step-progress --event verify-pass`
<!-- tenon:test-report:end -->
