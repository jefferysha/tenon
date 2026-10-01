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

官方智能体：执行者 `builder`、`researcher`；评审者 `architecture`、`backend-quality`、`code-size`、
`e2e`、`frontend-quality`、`security`、`spec-consistency`。

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
- 在 Claude Code 或 Codex 里，`tenon:agent-author` 技能按你的描述起草正文（职责、只做与不做、方法、
  自检、带 `tenon-result` 块的报告格式），校验草稿后用 `tenon agent add` 登记；它不写任何 Tenon 状态。

## 宿主原生文件

任务冻结智能体时（`tenon init`，或第一次 `tenon agent prompt --host <host>`），Tenon 为当前宿主生成
原生子代理文件：

| 宿主 | 文件 | 字段 |
| --- | --- | --- |
| Claude Code | `.claude/agents/tenon-<name>.md` | name、description、tools、model |
| Codex | `.codex/agents/tenon-<name>.toml` | name、description、developer_instructions、model；工具既不能写也不能跑命令时加 `sandbox_mode = "read-only"` |

- `tenon agent prompt <change> <agent> --host claude|codex --json` 返回 `subagent_type: tenon-<name>`，
  宿主用这个专属子代理执行。Claude Code 强制执行 `tools` 白名单；Codex 的自定义智能体没有按 agent 的工具白名单，
  Tenon 只在 agent 的工具里没有写文件或执行命令的能力时设 `sandbox_mode = "read-only"`，其余限制只是 agent 正文里的
  指令。宿主不提供的工具（例如部分无头运行里的 `Grep`）会回答 `No such tool available`，agent 改用 shell 里的等价命令。
  宿主不认识的型号别名直接省略。
- 生成不了时（同名文件不是 Tenon 写的、文件被你改过、路径是符号链接），宿主退回通用子代理，运行记录里
  写明。宿主加载不了给它的子代理时，用 `tenon agent record <change> <run-id> --subagent <type>` 记下实际
  用的类型。
- 每条运行记录都带 `subagent: { host, type, native }`。
- 这些文件连同内容摘要记在项目的 `.pipeline-owned.json`。任务走到终点时，Tenon 删除其它在途任务都不再
  使用的文件；`tenon uninstall` 只删它生成且你没改过的文件。它们不进交付提交，也不改变评审候选。

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

状态 JSON（`step.reviewers[]` 的 `required_host`、`route_host`、`host`、`host_source`、`wrong_host`）和 `run-agent` 动作（`host`）给运行器带同样的事实；
Dashboard 的 agent 运行抽屉显示登记的宿主与绑定的候选，登记的宿主违反要求时是红点加「宿主不符」。工作流页在 `block_at` 旁边编辑评审者的 `host`。

## Dashboard

库页按身份分组列出智能体，每行显示来源（官方 / 项目 / 自定义）与版本。详情显示字段表、正文渲染、
使用它的工作流步骤，以及所选项目里的最近运行（含每次用的子代理）。自定义与项目级可编辑正文；官方可
「复制为自定义」。库为空时给出可复制的 `tenon agent new` 命令。
