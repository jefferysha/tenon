# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 宿主子代理文件 SHALL 只由终端安装命令写入用户级目录

`tenon agent install [--host claude|codex]` SHALL 把 agent 库官方层与自定义层中适用于该宿主的全部 agent（按定义的 `hosts`
过滤）渲染为宿主子代理文件，写入宿主的用户级子代理目录：Claude Code 为 `<Claude 配置目录>/agents/tenon-<name>.md`，Codex 为
`<Codex 配置目录>/agents/tenon-<name>.toml`。Claude 配置目录 SHALL 取环境变量 `CLAUDE_CONFIG_DIR`（值为绝对路径时），否则为
`~/.claude`；Codex 配置目录 SHALL 取 `CODEX_HOME`（值为绝对路径时），否则为 `~/.codex`。取值 SHALL 来自执行该命令的进程环境；
安装、卸载与派发判定 SHALL 使用同一解析。本规格其余处写的 `~/.claude/agents/`、`~/.codex/agents/` 指未设这两个变量时的目录。
`tenon setup --<host>` 与 `tenon update --<host>` 成功后 SHALL 执行同一安装，
`tenon update` 在已是最新版本时同样执行。安装 SHALL 幂等：内容相同的文件不改写。项目层（`<项目>/.tenon/agents`）agent
SHALL NOT 被写入任何宿主目录。

#### Scenario: 宿主配置目录由环境变量指定

- **WHEN** 用户在 `CLAUDE_CONFIG_DIR=/opt/cc` 的环境里执行 `tenon agent install --host claude`
- **THEN** `/opt/cc/agents/tenon-researcher.md` 存在且内容等于渲染结果
- **AND** `~/.claude/agents/` 中不新增、不改写任何 `tenon-*` 文件

#### Scenario: Codex 配置目录由 CODEX_HOME 指定

- **WHEN** 用户在 `CODEX_HOME=/opt/codex-home` 的环境里执行 `tenon agent install --host codex`
- **THEN** `/opt/codex-home/agents/tenon-researcher.toml` 存在且内容等于渲染结果

#### Scenario: 环境变量不是绝对路径时不采用

- **WHEN** `CLAUDE_CONFIG_DIR` 为空或为相对路径 `cc-config`，用户执行 `tenon agent install --host claude`
- **THEN** 文件写入 `~/.claude/agents/`

#### Scenario: 终端安装官方与自定义 agent

- **WHEN** 用户在终端执行 `tenon agent install --host claude`，库中有官方 agent `researcher` 与自定义 agent `my-reviewer`
- **THEN** `~/.claude/agents/tenon-researcher.md` 与 `~/.claude/agents/tenon-my-reviewer.md` 存在且内容等于各自定义的渲染结果
- **AND** 命令输出逐个文件的结果，并提示开新会话后生效

#### Scenario: 重复安装不改写

- **WHEN** 用户连续两次执行 `tenon agent install --host claude`，期间库未变化
- **THEN** 第二次的结果全部为 unchanged，文件修改时间不变

#### Scenario: 已是最新版本的 update 仍安装

- **WHEN** 已安装最新版本的用户执行 `tenon update --claude`，且 `~/.claude/agents/` 中缺少 `tenon-builder.md`
- **THEN** 命令结束后 `~/.claude/agents/tenon-builder.md` 存在

#### Scenario: 项目层同名 agent 不影响用户级安装

- **WHEN** 当前项目 `.tenon/agents` 里有与官方 agent `researcher` 同名的覆盖定义，用户在该项目目录执行 `tenon agent install --host claude`
- **THEN** `~/.claude/agents/tenon-researcher.md` 按官方定义写入或保持，不因项目层覆盖而被跳过或删除

#### Scenario: 项目层 agent 不写入宿主目录

- **WHEN** 项目 `.tenon/agents` 中定义了 agent `team-lint`，用户在该项目目录执行 `tenon agent install --host claude`
- **THEN** 用户级与项目级宿主目录中都不出现 `tenon-team-lint.md`

### Requirement: 用户级安装 SHALL 只改动 Tenon 写入且未被修改的文件

安装与卸载 SHALL 以用户级所有权清单 `<configRoot>/agents/host-owned.json` 记录 Tenon 写入的每个文件的路径与内容摘要。
写入 SHALL 只发生在三种情况：文件不存在；内容已与渲染结果相同（补记所有权）；清单记着且当前内容与记录摘要一致。
同名但不在清单中的文件、被用户修改过的文件 SHALL 保持不变并在结果中列出。库中已不存在的 agent，其文件在清单记着且未被修改时
SHALL 被删除。目标文件本身为符号链接时 SHALL 拒绝写入且不改动链接目标；父目录（如 `~/.claude`）为符号链接时照常写入。`tenon agent uninstall [--host]` SHALL 删除清单记着且未被修改的
文件，被修改的文件 SHALL 保留并列出。所有权 SHALL 按目标子代理目录分别记录：在一个目录上执行安装或卸载 SHALL NOT 删除、改写或
认领另一个目录中的文件。

#### Scenario: 不同配置目录互不影响

- **WHEN** 用户先在未设 `CLAUDE_CONFIG_DIR` 的环境里执行 `tenon agent install --host claude`，再在 `CLAUDE_CONFIG_DIR=/opt/cc`
  的环境里依次执行 `tenon agent install --host claude` 与 `tenon agent uninstall --host claude`
- **THEN** `~/.claude/agents/` 中由 Tenon 写入的 `tenon-*` 文件全部保留且内容不变，`/opt/cc/agents/` 中由 Tenon 写入的文件被删除

#### Scenario: 用户自有同名文件不覆盖

- **WHEN** `~/.claude/agents/tenon-researcher.md` 是用户自己写的文件且不在所有权清单中，用户执行 `tenon agent install --host claude`
- **THEN** 该文件内容不变，结果中该项标为 foreign

#### Scenario: 库中删除的 agent 被清掉

- **WHEN** 自定义 agent `my-reviewer` 已从库中删除，其用户级文件在清单中且未被修改，用户执行 `tenon agent install --host claude`
- **THEN** `~/.claude/agents/tenon-my-reviewer.md` 被删除，清单中对应条目被移除

#### Scenario: 用户目录经符号链接管理

- **WHEN** `~/.claude` 是指向 dotfiles 仓库目录的符号链接，用户执行 `tenon agent install --host claude`
- **THEN** 宿主子代理文件照常写入链接指向的目录

#### Scenario: 卸载保留被修改的文件

- **WHEN** 用户修改过 `~/.claude/agents/tenon-builder.md` 后执行 `tenon agent uninstall --host claude`
- **THEN** 其余由 Tenon 写入且未修改的 `tenon-*` 文件被删除，`tenon-builder.md` 保留并在结果中列为 modified

### Requirement: 会话内的 Tenon 命令 SHALL NOT 写宿主子代理文件

`tenon init`、`tenon agent prompt` 以及其他在任务流程中执行的命令 SHALL NOT 创建或改写任何宿主子代理文件（用户级与项目级）。
`tenon agent add`、`new`、`copy`、`rm` SHALL NOT 写宿主子代理文件，并 SHALL 在输出中提示执行 `tenon agent install` 后开新会话生效。

#### Scenario: 会话中建任务不产生宿主文件

- **WHEN** 在 Claude Code 会话中执行 `tenon init demo --workflow default --track backend --preset full`
- **THEN** 用户级子代理目录与项目 `.claude/agents/` 中不新增、不改写任何 `tenon-*` 文件

#### Scenario: 新建自定义 agent 只提示安装

- **WHEN** 用户执行 `tenon agent new my-reviewer` 成功
- **THEN** 宿主目录中不出现 `tenon-my-reviewer.md`，输出包含执行 `tenon agent install` 并开新会话的提示

### Requirement: 派发 SHALL 只在已装文件与冻结定义一致时使用专属子代理

`tenon agent prompt <change> <agent> --host <host>` SHALL 按任务冻结的 agent 定义渲染期望内容，并与按执行该命令的进程环境
解析出的用户级子代理目录（解析规则同安装）中的文件比较。
当且仅当用户级文件存在且逐字一致、并且项目中（在 linked worktree 里执行时，当前根与按 git common dir 找到的主检出都算）不存在内容
不同的同名项目级宿主文件时，SHALL 返回 `subagent_type: tenon-<agent>`
与 `native: true`。否则 SHALL 返回宿主的通用子代理类型（Claude `general-purpose`、Codex `default`）、`native: false` 与
`reason`，取值为：`not-installed`（用户级文件不存在）、`definition-mismatch`（内容不一致）、`shadowed`（被内容不同的项目级
同名文件遮住）、`project-agent`（agent 来自项目层）。返回通用子代理时 SHALL 附带所检查的用户级子代理目录，以及执行
`tenon agent install --host <host>` 并开新会话的提示。运行台账的 `subagent` SHALL 记录同样的 `type`、`native` 与 `reason`。

#### Scenario: 已安装且一致

- **WHEN** 用户级 `tenon-researcher.md` 与任务冻结的 `researcher` 定义渲染结果逐字一致，项目中没有同名文件
- **THEN** `tenon agent prompt <c> researcher --host claude --json` 返回 `subagent_type: tenon-researcher`、`native: true`

#### Scenario: 未安装

- **WHEN** 用户级 `tenon-researcher.md` 不存在
- **THEN** 返回 `subagent_type: general-purpose`、`native: false`、`reason: not-installed` 与安装提示
- **AND** 台账中该次运行的 `subagent` 记录相同的值

#### Scenario: 会话的配置目录与安装位置不同

- **WHEN** 会话环境里 `CLAUDE_CONFIG_DIR=/opt/cc`，`tenon-researcher.md` 只装在 `~/.claude/agents/`
- **THEN** `tenon agent prompt <c> researcher --host claude --json` 返回 `subagent_type: general-purpose`、`native: false`、
  `reason: not-installed`，提示中给出所检查的目录 `/opt/cc/agents`

#### Scenario: 冻结版本与已装版本不同

- **WHEN** 任务冻结了 `builder` 1.0.0，而用户级文件是按 1.1.0 渲染的
- **THEN** 返回通用子代理，`reason: definition-mismatch`

#### Scenario: 被项目级旧文件遮住

- **WHEN** 用户级 `tenon-builder.md` 与冻结定义一致，但项目 `.claude/agents/tenon-builder.md` 内容不同
- **THEN** 返回通用子代理，`reason: shadowed`

#### Scenario: 项目层 agent

- **WHEN** 任务冻结的 agent 来自项目层 `.tenon/agents`
- **THEN** 返回通用子代理，`reason: project-agent`

### Requirement: 没有派发的运行 SHALL 如实登记

`tenon agent record <change> <run_id> --subagent none` SHALL 把该次运行的 `subagent` 记为 `type: none`、`native: false`、
`reason: not-dispatched`。不带 `--subagent` 时仍按 `tenon agent prompt` 给出的类型记录。

#### Scenario: 开始后未派发

- **WHEN** 一次 `builder` 运行已由 `tenon agent prompt` 开始，但没有派发子代理，报告结果为 `failed`，执行
  `tenon agent record <c> <run_id> --subagent none`
- **THEN** 台账中该运行的 `subagent` 为 `{ type: none, native: false, reason: not-dispatched }`

### Requirement: 旧版本写入的项目级宿主子代理文件 SHALL 被清理

`tenon init` 以及任务归档、删除（CLI 与 Dashboard 服务端）SHALL 清理项目主检出中的 `.claude/agents/tenon-*.md` 与
`.codex/agents/tenon-*.toml`（命令在 linked worktree 里执行时，按 git common dir 找到主检出）：在项目级所有权清单 `.pipeline-owned.json` 中记着且内容与记录摘要一致，或内容与当前库对应 agent
的渲染结果一致的文件 SHALL 被删除并移除清单条目；其余文件 SHALL 保留并输出警告。清理 SHALL NOT 依据在途任务是否引用该 agent。
清理失败 SHALL NOT 让所在命令失败。

#### Scenario: 建任务时清掉旧文件

- **WHEN** 项目 `.claude/agents/tenon-researcher.md` 由旧版本 Tenon 写入、记在 `.pipeline-owned.json` 且未被修改，用户执行 `tenon init`
- **THEN** 该文件被删除，`.pipeline-owned.json` 中对应条目被移除

#### Scenario: 清单条目丢失但内容一致

- **WHEN** 项目 `.claude/agents/tenon-builder.md` 不在清单中，但内容与当前库 `builder` 的渲染结果一致，任务被归档
- **THEN** 该文件被删除

#### Scenario: 用户改过的旧文件保留

- **WHEN** 项目 `.claude/agents/tenon-security.md` 在清单中但内容已被用户修改
- **THEN** 清理后文件仍在，命令输出警告且退出码不受影响
