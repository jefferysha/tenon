---
name: agent-author
description: "按用户的描述起草一个 Tenon 智能体（执行者或评审者）的定义文件，校验后用 `tenon agent add` 登记进库；只写草稿文件，不写任何 Tenon 状态。"
---

# agent-author — 在终端起草并登记智能体

用户说「做一个 SQL 评审者」「加一个只写文档的执行者」这类话时用本技能。产出是一份 agent 文件，
登记进 Tenon 的智能体库；之后在工作流的某一步把它挂成执行者或评审者，任务运行时宿主用
`tenon-<name>` 专属子代理执行它。

## 硬规则

- 不写任何 Tenon 状态：不碰 `.pipeline*`、`openspec/`、`.tenon/`、`~/.claude`、`~/.agents` 或库目录里的文件。
  草稿写在临时目录，登记只经 `tenon agent add`（它负责校验和落盘）。
- 不改工作流、不开任务。挂到哪一步由用户在 Dashboard 的工作流页决定。
- 面向用户的回复用用户的语言；命令、字段名保持原样。

## 步骤

1. **问清楚**（缺什么问什么，一次一个问题）：
   - 身份：`executor`（完成步骤的工作、会改文件）还是 `reviewer`（离开步骤前检查、只读、报问题）；
   - 名字：小写字母、数字与 `-`，不能与官方同名（`tenon agent list --source official` 看官方名字）；
   - 一句话说明（≤200 字，一行）；只做什么、明确不做什么；
   - 要用的技能（`tenon agent list --json` 能看到别的 agent 用了哪些；技能必须是插件里有的）；
   - 登记到哪一层：`user`（缺省，只自己用）或 `project`（写进项目 `.tenon/agents/`，随仓库共享）。
2. **找一个相近的官方 agent 作参照**：`tenon agent show <name>`（执行者看 `builder`，评审者看
   `security` 或 `spec-consistency`），沿用它的结构与口吻，不照抄它的职责。
3. **写草稿**到临时目录：`${TMPDIR:-/tmp}/tenon-agent-<name>.md`。格式是闭集 frontmatter + 正文：

   ```markdown
   ---
   name: <name>
   description: <一句话>
   role: executor | reviewer
   version: 0.1.0
   skills: [<技能>, ...]
   tools: [Read, Grep, Glob, ...]
   model: sonnet
   ---

   # <name>（执行者 | 评审者）
   ## 职责
   ## 只做与不做
   ## 方法
   ## 自检
   ## 报告
   ```

   - frontmatter 只允许 `name / description / role / version / skills / tools / model / hosts`，一行一个，
     列表写成单行 `[a, b]`。
   - `tools` 是宿主工具白名单（专属子代理里真正生效）：评审者只给读的工具（`Read, Grep, Glob`，需要跑命令
     再加 `Bash`）；执行者再加 `Write, Edit`。声明了技能就加 `Skill`。
   - 正文五节都要写实：职责一句话；只做与不做各列两三条；方法是编号步骤；自检是写报告前必须满足的条件。
   - **报告**一节写清：结果写进派发提示给的报告路径，报告最后一个代码块必须是 `tenon-result`：
     评审者 `{"findings":[{"severity":"critical|high|medium|low","location":"<path:line>","message":"<一句话>"}]}`
     （不自报结论，结论由阻断级别算）；执行者 `{"result":"done|failed","findings":[...]}`。
4. **校验**：`tenon agent validate <草稿路径>`。有 `[FAIL]` 就按提示改草稿再跑，直到 `PASS`；
   `[WARN]` 讲给用户听。
5. **登记**：`tenon agent add <草稿路径> [--scope project]`。已登记过、这次是修改时加 `--replace`。
6. **收尾报告**：名字、身份、来源层、文件路径（`add` 的输出里有），以及下一步：在 Dashboard 工作流页
   给某个步骤挂上它；想先看宿主文件长什么样用 `tenon agent export <name> --host claude|codex`。
