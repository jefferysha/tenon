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
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

- `new` 在交互终端里逐个问缺的项；必填参数给全时非交互也能用。没有 `--from` 时写一份五节的正文骨架；
  `--from builder` 以官方智能体的字段与正文为底。
- `validate` 检查 frontmatter 与正文、每个技能在插件里存在、工具名是合法的 Claude Code 工具。
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
  宿主用这个专属子代理执行，工具白名单由宿主强制。宿主不认识的型号别名直接省略。
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

## Dashboard

库页按身份分组列出智能体，每行显示来源（官方 / 项目 / 自定义）与版本。详情显示字段表、正文渲染、
使用它的工作流步骤，以及所选项目里的最近运行（含每次用的子代理）。自定义与项目级可编辑正文；官方可
「复制为自定义」。库为空时给出可复制的 `tenon agent new` 命令。
