# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 新任务 SHALL 建在自己的 git worktree 里

在 git 仓库的主检出里执行 `tenon init <change>` 时，CLI SHALL 先建 worktree：路径 `<主检出>/.worktrees/<change>`，分支
`tenon/<change>`，从当前 HEAD 分出；再在该 worktree 里初始化任务，任务状态、文档、实现与之后的提交都只在该 worktree 里。
工作流与 track 注册表 SHALL 按主检出解析（项目自定义工作流所在的 `.pipeline/` 被 git 忽略，不在新 worktree 里），解析结果冻结进
worktree 里的任务；测试目录自动发现、项目登记与本机排除 SHALL 作用于该 worktree，主检出的工作区不因建任务而变化。
Dashboard 与 triage 的建任务路径不建 worktree，仍原地建立（Dashboard 没有跨 worktree 的视图）。
状态字段 SHALL 记录：`base_branch` 为分出它的分支（不是 `tenon/<change>`），`start_sha` 为分出时的 HEAD，`isolation` 为
`worktree`。`.worktrees/` 未被 git 忽略时，CLI SHALL 把它写进 `.git/info/exclude`，不改任何受版本控制的文件。以下情况 SHALL 原地
初始化并输出原因：当前目录不是 git 仓库、仓库还没有提交、HEAD 处于分离状态、当前目录本身已是一个 linked worktree、调用方显式传入
`--in-place`（tenon skill 只在用户明确要求时传）。环境变量 `TENON_INIT_IN_PLACE=1` 同样原地初始化，但它是测试工装的约定，
SHALL NOT 输出原因（测试里每次建任务都会触发它）。目标路径或分支已存在时 SHALL 失败退出，且不留下半建的 worktree、分支或任务状态。

#### Scenario: 在主检出里建任务

- **WHEN** 在 `main` 分支的主检出里执行 `tenon init demo --workflow default --track backend --preset full`
- **THEN** `git worktree list` 出现 `.worktrees/demo`，分支为 `tenon/demo`
- **AND** `.worktrees/demo/openspec/changes/demo/` 存在，主检出里不存在 `openspec/changes/demo/`
- **AND** 任务的 `base_branch` 为 `main`、`isolation` 为 `worktree`、`start_sha` 等于建任务时 `main` 的 HEAD
- **AND** 主检出的 `git status --short` 不因建任务出现任何变化

#### Scenario: 已在 linked worktree 里

- **WHEN** 在一个已存在的 linked worktree 里执行 `tenon init demo2 …`
- **THEN** 任务原地建在这个 worktree 里，输出说明原因，不再嵌套新建 worktree

#### Scenario: 测试工装要求原地

- **WHEN** 环境变量 `TENON_INIT_IN_PLACE=1` 时在主检出里执行 `tenon init demo …`
- **THEN** 任务原地建立，不建 `.worktrees/demo`，输出里没有原地原因
- **AND** 同样的命令改为显式传 `--in-place` 时，输出说明原地原因

#### Scenario: 同名分支已存在

- **WHEN** 分支 `tenon/demo` 已存在时执行 `tenon init demo …`
- **THEN** 命令以非零退出码结束，`.worktrees/demo` 与任务状态都没有被创建

#### Scenario: 两个任务并行互不污染

- **WHEN** 任务 A、B 各在自己的 worktree 推进，A 在其 worktree 里修改并登记了测试文件
- **THEN** B 的改动文件、受保护配置审批与改动风险里都不出现 A 的文件

### Requirement: 新 worktree SHALL 按测试目录声明完成准备并继承本用户的信任

测试目录（`.tenon/tests/catalog.yaml`）SHALL 支持可选的顶层 `setup` 命令，并纳入测试目录的信任摘要。建好 worktree 后，CLI SHALL
把主检出里当前用户已信任的命令摘要写进新 worktree 的本机封存（只复制信任条目，不复制审批与写入记录）；测试目录在新 worktree 里
受信任时 SHALL 在该 worktree 里执行 `setup` 并输出结果。目录未受信任或没有 `setup` 时 SHALL 跳过并提示；`setup` 失败时 SHALL 保留
已建好的任务、输出警告与在 worktree 里手动重跑的命令，`tenon init` 的退出码不因此失败。没有 `setup` 的测试目录，其信任摘要 SHALL
与引入该字段之前逐字相同。主检出里未提交的测试目录改动不会进入新 worktree；此时新 worktree 的目录摘要与已信任的不同，SHALL 按
未受信任处理并提示。

#### Scenario: 未提交的目录改动

- **WHEN** 主检出的 `.tenon/tests/catalog.yaml` 有未提交改动并已在主检出信任，执行 `tenon init demo …`
- **THEN** 新 worktree 里的目录是 HEAD 版本，`setup` 不执行，输出提示需要信任

#### Scenario: 信任过的目录自动准备

- **WHEN** 用户已在主检出信任过测试目录，目录声明 `setup: npm ci`，执行 `tenon init demo …`
- **THEN** `.worktrees/demo` 里执行了 `npm ci`，`tenon test run` 在该 worktree 里不再要求重新信任同一份目录

#### Scenario: 目录改动后要重新信任

- **WHEN** 在 `.worktrees/demo` 里修改了测试目录中的命令
- **THEN** 该 worktree 里执行测试时要求用户重新信任，主检出的信任记录不受影响

#### Scenario: 准备命令失败

- **WHEN** `setup` 以非零退出码结束
- **THEN** 任务仍然建好，输出包含警告与在 `.worktrees/demo` 里重跑的命令

### Requirement: 会话 SHALL 切进任务所在的 worktree 继续推进

`tenon init` 的文本与 JSON 输出 SHALL 给出 worktree 的绝对路径。tenon skill SHALL 要求：Claude Code 用 `EnterWorktree` 的 `path`
把当前会话切进该路径后再执行 `tenon session activate`；没有对应能力的宿主（Codex）告诉用户在该路径开新会话继续。worktree 里的
hook、评审标记、会话绑定与当前用户的活跃任务指针 SHALL 以该 worktree 为项目根。

#### Scenario: Claude Code 同一会话继续

- **WHEN** Claude Code 会话在主检出里建了任务 `demo`
- **THEN** 会话经 `EnterWorktree` 切进 `.worktrees/demo`，之后 `tenon session activate demo --host-session <id>` 与评审确认都在该
  worktree 里生效

### Requirement: 主检出 SHALL 能找到建在 worktree 里的任务

在主检出执行 `tenon list` 时，SHALL 同时列出 `git worktree list` 中位于 `.worktrees/` 下、含未归档任务的 worktree，并标出所在路径
（JSON 输出带 `worktree` 字段）。用户在主检出点名恢复的任务只存在于某个 worktree 时，路由 SHALL 在 dispatch 中给出该路径，
tenon skill 按上一条要求切进去。worktree 里的任务 SHALL NOT 计入主检出「新建还是选择」的路由判定；主检出没有自己的活跃任务、用户
却泛泛地说「继续」时，路由 SHALL 把 worktree 任务连同路径列为候选，要求用户点名。`tenon status <change>` 等按名读取任务的命令找不到
任务、但它存在于某个 worktree 时，报错 SHALL 给出该路径；`tenon workflow progress <change>` SHALL 能读到该 worktree 里的任务，使
`step-progress` hook 在主检出执行 `tenon init` 或 `cd <worktree> && tenon transition …` 后照常打印清单。

#### Scenario: 列出 worktree 任务

- **WHEN** 主检出里没有在途任务，`.worktrees/demo` 里有任务 `demo`
- **THEN** 在主检出执行 `tenon list --json` 的结果包含 `demo`，其 `worktree` 为 `.worktrees/demo` 的绝对路径

#### Scenario: 在主检出说继续

- **WHEN** 用户在主检出的会话里说「继续 demo」
- **THEN** dispatch 带出 `.worktrees/demo` 的路径，会话切进去后恢复任务

#### Scenario: 主检出的新请求不受 worktree 任务影响

- **WHEN** 主检出没有活跃任务，`.worktrees/demo` 里有任务，用户提出一个新需求
- **THEN** 路由按新任务处理，不要求用户在 `demo` 与新任务之间选择

#### Scenario: 主检出建任务后打印清单

- **WHEN** 在主检出执行 `tenon init demo …` 成功
- **THEN** `step-progress` hook 输出 `Tenon · demo` 与该任务的步骤清单

### Requirement: worktree 任务的构建版本 SHALL 绑定该 worktree 的工作区指纹

`isolation=worktree` 时，构建版本 SHALL 与 `in-place` 一样取工作区内容指纹（`workspace` 类），身份里 SHALL 带该 worktree；
验证 SHALL 在同一个 worktree 里重算并比对，在别的检出里验证 SHALL 以 worktree 不符拒绝。`isolation=branch` 的语义不变。

#### Scenario: 未提交的实现可以验证

- **WHEN** worktree 任务在实现步结束时实现尚未提交，执行 `build-complete`
- **THEN** `build_sha` 是 `build:v1:workspace:` 开头的令牌，验证步在同一 worktree 里核对通过

#### Scenario: 换检出验证被拒

- **WHEN** 同一任务的验证在主检出里执行
- **THEN** 构建版本判定为不可信，原因为 worktree 不符

### Requirement: 宿主为子代理与会话建的检出 SHALL NOT 计入工作区指纹

完整工作区指纹（构建版本的 `workspace` 令牌与评审者的候选都绑它）SHALL 与可移植指纹一样，不计入未被 git 跟踪的
`.claude/worktrees/`（Claude Code 为子代理与会话建的本项目检出，里面的文件都是源码在别处的副本）；该目录下被 git 跟踪（已提交或已暂存）
的文件照算。同一仓库里另有会话或子代理在 `.claude/worktrees/` 下工作时，主检出里任务的构建版本与评审结论 SHALL NOT 因此失效。
`.claude/settings.local.json`、`CLAUDE.local.md` 在完整指纹里的处理不变。

#### Scenario: 另一个会话在 `.claude/worktrees/` 下工作

- **GIVEN** 主检出里的原地任务已执行 `build-complete`
- **WHEN** 同一仓库另一个 Claude Code 会话或子代理在 `.claude/worktrees/<name>/` 下新增或修改未被 git 跟踪的文件
- **THEN** 该任务的构建版本复核仍然可信，评审者的候选不变

#### Scenario: 被 git 跟踪的文件照算

- **WHEN** `.claude/worktrees/` 下有被 git 跟踪的文件，且该文件内容变化
- **THEN** 完整工作区指纹随之变化

### Requirement: 归档后 SHALL 提示清理 worktree

worktree 任务的 `next` 中 `finish-change` 动作 SHALL 附带 `cleanup` 字段，内容为清理该 worktree 与分支的命令；tenon skill 在完结后
SHALL 把它转告用户。Tenon SHALL NOT 自动删除 worktree 或分支。

#### Scenario: 完结提示

- **WHEN** worktree 任务走到完结步，`tenon status demo --json` 的 `next` 给出 `finish-change`
- **THEN** 该动作的 `cleanup` 包含对 `.worktrees/demo` 的 `git worktree remove` 命令
- **AND** 执行完 `finish-change` 后 `.worktrees/demo` 仍然存在
