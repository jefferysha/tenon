# 智能体

智能体（agent）是工作流步骤声明的任务级执行者或评审者，和指令文件（`AGENTS.md`、`CLAUDE.md`）
不是一回事：它只在任务里、在点名它的那一步运行。智能体在终端登记；Dashboard 只展示并编辑正文。

## 智能体文件

每个智能体一个 Markdown 文件：闭集 frontmatter + 正文。

```markdown
---
name: sql-review
description: SQL 评审：注入、索引与迁移
role: reviewer
version: 0.1.0
skills: [security-review]
tools: [Read, Grep, Glob, Bash, Skill]
model: sonnet
---

# sql-review（评审者）
## 职责
## 只做与不做
## 方法
## 自检
## 报告
```

- `role` 是 `executor`（完成步骤的工作）或 `reviewer`（离开步骤前检查）。没有 `role` 的旧文件照常
  读取，按工具推断（带 `Write` / `Edit` 的算执行者），`tenon agent validate` 会提示补上这一行。
- `version` 是可选的 semver；`hosts`（可选）限定适用的宿主；`model` 只交给认得它的宿主。
- `attach_on`（可选，评审者用）按风险挂载：`attach_on: [auth, dependency, contract]` 表示只有任务的改动碰到这些路径类
  （`auth`、`dependency`、`contract`、`migration`，与 `standard` 通道风险探针同一套分类）之一，它才加入该步骤。没挂载的评审者不列出、
  不等待、不要求；`agent prompt` 对它退出 `2`。读不出改动时一律挂载（失败关闭）。官方 `security` 声明 `[auth, dependency, contract]`。
  不写这个字段就总是挂载；已冻结了旧副本的任务行为不变。
- `host`（可选，`codex` | `claude` | `any`）是评审者*该在哪个宿主上跑*。它只是建议，用来把评审者路由到另一家厂商；
  真正有约束力的是工作流步骤里的声明（见[跨厂商评审](#跨厂商评审)）。别和 `hosts`（智能体*能在哪些宿主上跑*）混淆。
- 智能体写的报告以 `tenon-result` 代码块结尾。评审者只列问题、不自报结论——结论由 Tenon 按问题级别
  与步骤的 `block_at` 算出；执行者报 `done` 或 `failed`。

## 来源

| 来源 | 位置 | 能否修改 |
| --- | --- | --- |
| 官方 | 随插件发布（`templates/agents/`，`templates/agents/manifest.json` 记录名称、版本、身份与摘要），同步到用户配置 | 只读，复制后再改 |
| 自定义 | 用户配置（`<config>/agents/custom/`） | 可以 |
| 项目 | 项目的 `.tenon/agents/`，随仓库提交、团队共享 | 可以 |

同名时项目级优先于自定义（自定义那条列为被覆盖）。任何一层都不能用官方的名字：这样的文件列为冲突，
不会生效。

官方智能体：执行者 `builder`、`researcher`；评审者 `architecture`、`backend-quality`、`code-review`、`code-size`、
`e2e`、`frontend-quality`、`security`、`spec-consistency`。`code-review` 是 `standard` 通道的评审者：对照宿主写在提示末尾的目标与
验收检查看 diff，不需要规格文档。

## 在终端生成与登记

```text
tenon agent list [--role executor|reviewer] [--source official|custom|project] [--json]
tenon agent show <name> [--json]
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--host codex|claude|any] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

- `new` 在交互终端里逐个问缺的项；必填参数给全时非交互也能用。没有 `--from` 时写一份五节的正文骨架；
  `--from builder` 以官方智能体的字段与正文为底。
- `validate`（`add` 同样）检查 frontmatter 与正文、每个技能在插件里存在、正文里不再有 `new` 写出的骨架占位符
  （`<第一步>`、`<第二步>`、`<写报告前必须满足的条件>` 和「做：」那一行），以及按宿主检查工具名：Claude Code 上未知工具名是失败；
  只给 Codex 用的 agent 只是警告，因为 Codex 不按名限制工具。`new` 自己照常登记骨架并提示补全，补全之前 `validate` 失败。
- 官方这一层在文字输出和 `--source official` 里叫「官方 / official」；`--json` 与 `GET /api/agents` 里机器可读的值是
  `source: "builtin"`（`--source builtin` 作为别名同样接受）。脚本请按 `builtin` 比较。
- `rm` 拒绝删除官方智能体和仍被工作流步骤引用的智能体，并列出这些步骤（exit 2）。
- `new`、`add`、`copy`、`rm` 只改库，不写任何宿主子代理文件，只打印提醒：执行 `tenon agent install` 并开新会话；见
  [宿主子代理与安装命令](#宿主子代理与安装命令)。
- 在 Claude Code 或 Codex 里，`tenon:agent-author` 技能按你的描述起草正文（职责、只做与不做、方法、
  自检、带 `tenon-result` 块的报告格式），校验草稿后用 `tenon agent add` 登记；它不写任何 Tenon 状态。

## 宿主子代理与安装命令

任务把自己的智能体当作宿主子代理来跑。专属的 `tenon-<name>` 子代理文件只在终端里写一次、写到用户级目录；会话里运行的
Tenon 命令一概不写它们。会话中途新增的子代理文件什么时候被宿主加载没有保证，只有会话启动前就存在的文件才可靠。

```text
tenon agent install [--host claude|codex]
tenon agent uninstall [--host claude|codex]
```

| 宿主 | 文件 | 字段 |
| --- | --- | --- |
| Claude Code | `<Claude 配置目录>/agents/tenon-<name>.md` | name、description、tools、model |
| Codex | `<Codex 配置目录>/agents/tenon-<name>.toml` | name、description、developer_instructions、model；工具既不能写也不能跑命令时加 `sandbox_mode = "read-only"` |

配置目录：Claude Code 取 `$CLAUDE_CONFIG_DIR`、Codex 取 `$CODEX_HOME`，值是绝对路径时才采用（首尾空白与末尾斜杠会去掉；相对路径或空值不采用）；
没设时分别是 `~/.claude`、`~/.codex`。宿主只读自己配置目录下的子代理，所以安装、卸载与 `tenon agent prompt` 的判定都按执行该命令的进程环境
用同一个方式解析出这个目录。

- **在宿主启动时的环境里安装。** 如果你的 Claude Code / Codex 是带着 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 启动的，安装也要在带同样变量的环境里执行，
  否则文件落到 `~/.claude/agents`，宿主看不到。`tenon agent install` 与 `uninstall` 输出的第一行 `目标目录：<dir>` 告诉你装到了哪里；
  在会话里可以用 `!` 前缀执行，例如 `! tenon agent install --host claude`，它用的就是会话的环境。
- 所有权按目标子代理目录分别记录：在一个配置目录上安装或卸载，不会删除、改写或认领另一个目录里 Tenon 写的文件
  （例如同一台机器上的 `~/.claude/agents` 与 `$CLAUDE_CONFIG_DIR/agents`）。
- `tenon agent install` 把适用于该宿主的全部官方与自定义智能体渲染成上面的文件（`hosts` 列表不含该宿主的智能体跳过）。
  项目层智能体（`.tenon/agents/`）从不安装，所以在哪个目录执行结果都一样。`--host` 缺省取进程环境判出的宿主，
  普通终端里是 `claude`。
- `tenon setup --claude|--codex` 与 `tenon update --claude|--codex` 成功后会执行同一套安装（`update` 发现已是最新版时也执行，
  安装是幂等的），并把写了哪些文件打印出来。安装失败只给 WARN：`setup` / `update` 的退出码不变，你可以自己再执行
  `tenon agent install --host <host>`。`--dry-run` 不安装；每天一次的自动更新（`--auto`）只在安装失败时出声。
- **装完要开新会话。** 宿主在会话启动时加载子代理文件；安装命令和 `tenon agent new|add|copy|rm` 都会提醒这一点。这四条库命令
  只改库、不写任何宿主文件，只打印「执行 `tenon agent install` 并开新会话」的提示（项目层智能体另说明它不安装宿主文件）。
- 文件只在安全时才写：它还不存在；内容已经和渲染结果完全一样（Tenon 补记它归自己）；或 Tenon 之前写过、此后没人改过。同名但归你的文件、
  或你改过的文件原样不动，列成 `WARN`；目标文件本身是符号链接则拒绝写（父目录是符号链接，例如 dotfiles 管理的 `~/.claude`，没有问题）。
  智能体已不在库里时，它的文件如果是 Tenon 写的且没被改过就删除；条目还在库里、只是加载不了（文件解析失败或读不出来）的不算「已删除」，
  它已装的文件既不改写也不删除；库里一个可用的智能体都没有（库读不出来）时，一个文件也不删，并给 `WARN` 说明。所有权按文件记内容摘要，存在 `<config>/agents/host-owned.json`，按写入的子代理目录分组；
  这个文件解析不了时，已有文件一律不改不删，只写还不存在的文件，并在输出里说明。
- `tenon agent uninstall [--host claude|codex]` 删除 Tenon 写入且没被改过的用户级文件；改过的保留，在结果里列为 `modified`。
  `tenon uninstall` 作用于项目的 `.pipeline-owned.json`，不碰这些用户级文件，想清掉它们请先执行
  `tenon agent uninstall --host <host>`。

### 派发：`tenon agent prompt` 返回什么

`tenon agent prompt <change> <agent> --host claude|codex --json` 不写任何宿主文件。它按任务冻结的定义为该宿主渲染期望内容，
与已安装的文件比较；只有用户级文件存在且逐字节一致、并且项目里没有内容不同的同名文件（`.claude/agents/tenon-<name>.md` 或
`.codex/agents/tenon-<name>.toml`）时，才返回 `subagent_type: tenon-<name>` 与 `native: true`——项目级文件的优先级高于用户级，
会把它遮住。在任务 worktree 里判定时，当前根与主检出两处都会检查，因为从主检出启动的会话会加载留在那里的文件。

专属子代理里，Claude Code 强制执行 `tools` 白名单；Codex 的自定义智能体没有按 agent 的工具白名单，Tenon 只在 agent 的工具里没有写文件或
执行命令的能力时设 `sandbox_mode = "read-only"`，其余限制只是 agent 正文里的指令。宿主不提供的工具（例如部分无头运行里的 `Grep`）会回答
`No such tool available`，agent 改用 shell 里的等价命令。宿主不认识的型号别名直接省略。

其余情况返回宿主的通用子代理（Claude Code 是 `general-purpose`，Codex 是 `default`），`native: false`，并带 `reason` 与 `hint`；
专属子代理、或检测不到宿主时这两项都是 `null`。

| `reason` | 含义 | 怎么办 |
| --- | --- | --- |
| `not-installed` | 这个智能体没有用户级文件 | `tenon agent install --host <host>`，再开新会话 |
| `definition-mismatch` | 文件存在但与任务冻结的定义不一致：文件安装之后库或智能体变了，或你改过文件 | 重新安装并开新会话（你改过的文件会被保留并列出，删掉它安装才会重写）。任务沿用它冻结的定义，所以冻结了旧版本的任务会留在通用子代理上，而不是悄悄换成新版本 |
| `shadowed` | 项目里有内容不同的同名 `tenon-<name>` 文件，优先级高于用户级文件 | 移除或修正项目里的那个文件（多半是旧版本留下的，见[旧版本留在项目里的文件](#旧版本留在项目里的文件)） |
| `project-agent` | 智能体来自项目层（`.tenon/agents/`），Tenon 不为它安装宿主文件 | 无需处理：项目层智能体一律走通用子代理 |

`hint` 是一行中文，不随 `TENON_LANG` 变化：`执行 tenon agent install --host <host> 后开新会话生效（目标目录 <dir>；设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行，例如会话里用 ! 前缀）`。
其中 `<dir>` 是 `prompt` 检查的用户级子代理目录，按会话环境里的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 解析；它与你安装的位置不同，就是 `not-installed` 的原因。
四个原因给出的是同一句；`shadowed` 与 `project-agent` 时安装并不会改变结果。

`tenon` 技能照返回的 `subagent_type` 派发，并把 `hint` 转告你。宿主仍报找不到该子代理（例如就在这个会话里刚装的），技能改用通用子代理跑同一份
提示词，并用 `tenon agent record <change> <run-id> --subagent <type>` 记下实际用的类型。完全没有派发子代理、工作在主线里跑完时，登记用
`--subagent none`，运行记录随之读作 `subagent: { host, type: "none", native: false, reason: "not-dispatched" }`。`not-dispatched` 是只在登记时出现的
原因，由登记者如实写下，`agent prompt` 永远不会返回它。

- 每条运行记录都带 `subagent: { host, type, native }`，没有用专属子代理时另有 `reason`。`--subagent <type>` 对通用类型保留 `prompt` 给出的
  `reason`，实际用的是专属 `tenon-<name>` 时则去掉。
- `reason` 存放在台账旁边的运行旁注 `.pipeline-agent-run-meta.jsonl` 里（字段 `subagent_reason`），读取记录时再合并回来。台账行本身的 `subagent` 仍是
  三个键，所以本次变更之前发布的运行时照常读得了台账。

### 旧版本留在项目里的文件

旧版本在任务冻结智能体时，会把 `.claude/agents/tenon-<name>.md` 和 `.codex/agents/tenon-<name>.toml` 写进项目。项目级文件的优先级高于
用户级，留下的旧文件会遮住你新装的那份，所以 Tenon 会清理它们，并且不再写新的：

- 什么时候：`tenon init` 时，以及任务归档或删除时（CLI 与 Dashboard 都一样）；
- 删哪些：项目的 `.pipeline-owned.json` 记着该文件且内容仍与记录的摘要一致的，或者内容与当前库为该智能体渲染的结果完全一致的
  （CLI 与 Dashboard 用同样两条规则）。读不到库时给一条 `WARN`，只按第一条规则删。同时移除 `.pipeline-owned.json` 里对应的条目；
  路径上有符号链接的不删；
- 其余一律保留，并用 `WARN` 点名文件：被改过的、两条规则都不符合的、读不了的。确认不需要之后请自己手动删除；
- 在任务 worktree 里执行时，清理的对象是主检出，旧文件与 `.pipeline-owned.json` 都在那里；
- 清理尽力而为：失败只给 WARN，不改变 `init`、归档、删除的退出码。

## 在工作流里使用

步骤声明自己的执行者与评审者：

```yaml
agents:
  executors:
    - agent: builder
  reviewers:
    - agent: code-size
      required: true
      block_at: medium
      reads_tests: [code-size]
    - agent: security
      required: false
      block_at: medium
```

执行者先跑，必须 `done` 才能离开步骤；必需评审者必须在当前候选上通过；参考评审者只报告。默认工作流在
每条轨道的调研挂 `researcher`、实现挂 `builder`（按独立任务各起一个子代理，合成一份报告）、验证挂
`code-size` 评审者及其 `code-size` 测试；对话与自由轨道的验证再加参考评审者 `security`。见
[默认工作流](default-workflow.md) 与 [自定义工作流](custom-workflows-and-tracks.md)。

智能体声明的技能（它文件里的 `skills:`）只能在该智能体运行期间加载。所以退回边——用来回头修问题的那条路，例如验证的 `verify-fail`、
实现的 `requirements-changed`——不要求本步声明的智能体的技能，你不必为了退回去先开始一次 builder。主线自己加载的技能在退回边上仍然要求，
前进边则照旧要求全部。`tenon status`、`tenon check` 与 Dashboard 的流转用的是同一条规则。

## 跨厂商评审

Claude 写、Codex 审（反过来也行）。步骤里的评审者写明它必须在哪个宿主上跑：

```yaml
agents:
  reviewers:
    - agent: security
      required: true
      block_at: medium
      host: codex        # codex | claude | any
```

| 写在哪 | 含义 |
| --- | --- |
| 步骤 `host: codex` 或 `claude` | 硬要求：只有随裁决登记的宿主就是它，裁决才算数 |
| 步骤 `host: any` | 不要求；盖过智能体的建议 |
| 步骤没写 `host`，智能体文件里有 `host:` | 建议：`tenon agent prompt` 仍然路由到那个宿主，别的宿主给出的裁决照样算数 |
| 都没有 | 不路由、不要求 |

**路由。** `tenon agent prompt <change> <agent>` 知道自己在哪个宿主里跑（进程环境，或 `--host`）。不是要求的宿主时，它照常开出这次运行，
但把提示词写进 `openspec/changes/<change>/.pipeline-agent-reports/<run-id>.prompt.md`，并打印在另一个宿主上运行的确切命令，不再打印提示词：

```bash
codex exec --sandbox workspace-write - < openspec/changes/demo/.pipeline-agent-reports/<run-id>.prompt.md
# 要求 Claude 审时（在 Codex 里）：
claude -p --allowedTools "Read,Grep,Glob,Write,Bash(tenon agent record:*)" < openspec/changes/demo/.pipeline-agent-reports/<run-id>.prompt.md
```

Tenon 不会替你起那个 CLI：命令由你、或当前宿主里的 agent 去执行。提示词末尾是 `tenon agent record <change> <run-id> --host <host>`，
所以评审能自己登记时就自己登记；另一个 CLI 写不了 Tenon 的状态时，在原宿主执行 `tenon agent record <change> <run-id> --host codex`，
宿主来源就记为 `declared`（声明），而不是 `detected`（检测）。

**绑定。** 跨厂商的裁决绑两次。*绑代码*：运行行带着候选（评审开始时工作区的内容哈希），评审期间代码变了 `record` 拒绝，之后任何改动都让裁决过期、
必须重跑。*绑宿主*：`record` 存下 `host` 与 `host_source`；步骤要求了宿主时，来自别的（或未知的）宿主的登记被拒（exit `2`），台账里仍然对不上的行
也不算裁决——评审者显示 `stale`，离开步骤报 `reviewer-wrong-host`，在对的宿主上重跑不需要 `--rerun-reason`。宿主是登记者的声明，与台账其余部分同一信任
模型；`host_source` 让人看得出它是检测来的还是声明的。

**与 `attach_on` 的关系。** 先按风险挂载。`attach_on` 没有挂载到本任务的评审者根本不在该步骤里，所以它的 `host` 要求既不路由也不检查：
不列出、不等待，也不会报 `reviewer-wrong-host`。上面的宿主规则只作用于已挂载的评审者。

状态 JSON（`step.reviewers[]` 的 `required_host`、`route_host`、`host`、`host_source`、`wrong_host`）和 `run-agent` 动作（`host`）给运行器带同样的事实；
工作流页在 `block_at` 旁边编辑评审者的 `host`。

Dashboard 的 agent 运行抽屉里，宿主一行并排显示登记的宿主和要求的宿主，要求的那个带一个小的「要求」标记（两者一致时合成一个）；登记的宿主违反要求时另有红点加「宿主不符」。抽屉还显示绑定的候选。
评审者在要求的宿主上还没有有效运行、且该步骤是未归档任务当前或之后的步骤时，多出一行「命令」，给出可复制的 `tenon agent prompt <change> <agent>`。Dashboard 只展示它，从不运行。

## Dashboard

库页按身份分组列出智能体，每行显示来源（官方 / 项目 / 自定义）与版本。详情显示字段表、正文渲染、
使用它的工作流步骤，以及所选项目里的最近运行（含每次用的子代理）。自定义与项目级可编辑正文；官方可
「复制为自定义」。库为空时给出可复制的 `tenon agent new` 命令。
