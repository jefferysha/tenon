# 文档、Skill 与证据链

## 目标

弄清 Tenon 怎样记录每一步实际写出的文件、下一步必须读哪些、工作流怎样要求某个文件写出来之后才能离开步骤。

## 前置条件

- 一个在文档机制重做之后创建的任务；更早创建的任务按冻结的规则走完，见[升级前创建的任务](#升级前创建的任务)；
- 当前步骤声明的技能，以及随插件发布的 `tenon` 技能；
- 项目是 git 仓库（不在 git 里就不观察，见[常见失败](#常见失败)）。

## 工作流声明什么

工作流不列出每一步的输入、输出文档。技能按自己的 `SKILL.md` 写文件（`brainstorming` 在 `docs/superpowers/specs/` 写设计，`openspec-propose` 写 proposal 与 delta spec，等等），Tenon 只记录实际发生的事。工作流唯一能写的文档条件是[必须产出](#必须产出)：步骤离开之前必须已经写出匹配某个路径模式的文件。

## 步骤产出

*步骤访问*是任务从进入某个步骤到离开它的一次经过；经回退边重新进入同一步骤是新的一次访问。一次访问有两个时刻：

- **进入**：Tenon 记下*检查点*——git `HEAD`，以及所有与 `HEAD` 不同的文件（含未跟踪、不含被忽略）及其 SHA-256。
- **离开**：所有门禁通过之后、提交转换之前，在任务锁内，Tenon 把工作区与检查点比较。每个新增、修改或删除的文件就是一条*步骤产出*，带*来源技能*（或「未知」）。`tenon transition` 与 Dashboard 走同一份代码。

比较只看文件，不看是谁写的，所以 shell 命令和子代理写出的文件与技能自己写的一样被记录。

记录在 `openspec/changes/<change>/.pipeline-step-outputs.json`：这是 Tenon 状态，只经 Tenon 命令写入，随任务目录提交和归档。它保留最近 512 次访问，每次访问最多 2000 条产出。

不观察的内容：被 git 忽略的文件；任何一段以 `.pipeline` 开头或名为 `node_modules` 的路径；`.git`、`.tenon`、`.claude`、`.agents`、`.codex`、`.superpowers`、`.worktrees`、`.turbo` 下的路径；`.github/hooks/`；`openspec/.gitignore`；`openspec/changes/` 下其他任务的目录；任务目录里直接的点文件。符号链接按链接目标字符串取摘要，子模块和嵌套仓库不进入。

访问期间 `HEAD` 移动（提交、rebase）时，只算本任务自己的提交：上游引用（`origin/HEAD` 与当前分支自己的 upstream）可达的提交被排除，别人合并进来的文件不会算成本步产出。

不在 git 仓库里、或 git 命令失败时，这次访问记为 `observation: unavailable`：不记产出，也不阻断转换。改动路径超过 20000 条记为 `truncated`。

## 来源技能

宿主 hook 记录本次访问里每个技能的加载时间。对新增或修改的文件，来源是加载时间不晚于文件修改时间的最后一个技能（按秒比较）；编排技能 `tenon` 从不算来源。没有这样的技能，以及所有被删除的文件，显示为「未知」。这是尽力而为：同一秒内加载的两个技能、重写修改时间的 checkout 都会让标注模糊。它只用来标注产出，不决定任何门禁。

## 交接给下一步

下一步只拿到*直接上游*的产出，即转入它的那次访问。更早步骤的产出不交接，技能需要时自己去读。第一步没有输入。

交接的*输入*是上游那次访问新增或修改、且仍然存在的文档，扩展名为 `.md`、`.mdx` 或 `.markdown`。代码和其他文件照样记为产出、在 Dashboard 显示，但不是输入，所以验证步不会被要求读几十个源文件。

`tenon status --json` 把未读的输入放进 `read-documents` 动作（`documents` 列出路径）。agent 把每个文件读进上下文，再写读取回执。本步可以修改输入，修改记为本步的产出。

## 读取回执

```bash
tenon document read <change-name> all
tenon document read <change-name> <path>
```

命令对当前内容取摘要，写进当前访问的*读取回执*。只能点名交接来的输入，项目外的路径会被拒。回执摘要等于上游记下的摘要，或等于文件当前的摘要，这个输入就算读过——读完之后又改了它不用重读（改动成为本步产出）。之后被删除的输入不再列出。

离开这一步的所有边都要求输入读完：前进、回退、完结都一样；只有放弃边（终止任务）例外。有未读输入时转换被拒，退出码 `1`；`tenon status` 与 `tenon check` 把同一条阻断列为 `source: document`、`code: input-unread`、`subject: <path>`，提示里点名上游步骤和要执行的命令。

```bash
tenon document status <change-name>
tenon document status <change-name> --json
```

`document status` 打印本步的输入（`READ` 或 `UNREAD`、上游步骤、来源技能）、产出（`added`、`modified` 或 `deleted`、来源技能）和必须产出（`PRODUCED` 或 `MISSING`）。JSON 形式是 `{ change, workflow, mode, observation, inputs, outputs, required }`。有输入未读或必须产出缺失时退出码 `2`，否则 `0`。同一份视图是 `tenon status --json` 里 `step.documents`（`mode: "observed"`）。

## 必须产出

步骤用 `required-output` 守卫写下必须写出的文件，可以写在步骤的 `guards` 或某条边的 `guards` 上，支持 `when`：

```yaml
guards:
  - type: required-output
    path: openspec/changes/{change}/specs/*/spec.md
```

模式是以 `/` 分隔的项目相对路径。`{change}` 是任务名，`*` 匹配一段内的任意字符，`**`（单独占一段）匹配任意多段，`?` 匹配一个字符。校验拒绝空串、绝对路径、`..`、反斜杠和其他 `{...}` 占位符。

满足条件：本任务里这一步的某次访问产出过（新增或修改）匹配的文件，且该文件现在存在。仓库里本来就有的匹配文件，除非本步改过，否则不算，所以 `docs/superpowers/specs/` 下别的任务留下的旧设计满足不了新任务的调研步。回到这一步不要求重写。访问没能观察（`unavailable` 或 `truncated`）时，退化为「存在匹配的文件」。

必须产出没满足时转换被拒，退出码 `2`，点名步骤与模式；`tenon check` 把它和其他未满足的条件一起列出，`step.next` 把它变成 `fix`。必须产出是工作流 YAML 里唯一与文档有关的条件；默认工作流各步的模式见[默认工作流](./default-workflow.md)。

## 与规范无关

观察、交接、读取回执和必须产出不认识任何规范格式。它们在每条轨道、每个工作流上一样生效：轻量轨道、`spec: none`、平铺的自定义工作流。`spec: openspec` 只打开轨道的 OpenSpec 生命周期：`tasks.md` 骨架（Todo 的来源）、delta spec 的校验与应用、`spec-migration-applied` 条件和 `openspec archive` 收尾。新任务不铺 proposal、design 骨架，由技能自己写。

所以 Spec Kit 风格的流程就是一个普通工作流，让各步要求自己的文件：

```yaml
name: speckit
steps:
  - id: specify
    label: 规格
    gate: auto
    skills: []
    guards:
      - type: required-output
        path: specs/*/spec.md
    transitions:
      - event: specify-complete
        to: plan
  - id: plan
    label: 计划
    gate: auto
    skills: []
    guards:
      - type: required-output
        path: specs/*/plan.md
    transitions:
      - event: plan-complete
        to: done
  - id: done
    label: 完成
    gate: auto
    skills: []
    guards: []
    transitions: []
```

Tenon 不认识 `spec.md`、`plan.md` 这些名字，它们只是守卫里的路径。见[自定义工作流与轨道](./custom-workflows-and-tracks.md)。

## 技能解析与信任

默认工作流必需的技能随不可变发布包分发，解析先走随包的信任层。只有真正找不到时才考虑外部来源；随包技能损坏时失败关闭，不会悄悄换成同名外部副本。

随插件发布的 `tenon` 技能是编排入口。阶段技能和辅助技能仍需要本次访问里的真实证据。

## 评审证据

文档和技能回执不能代替人工评审。评审是单独的、精确到事件的回执：

```bash
tenon review request <change-name> --event <event>
```

确认只来自用户：回复放行语（hook 写入回执）、在 Dashboard 确认（`tenon dashboard --open`），或由用户本人在自己的终端运行 `tenon review acknowledge <change-name>`。agent 不得执行这种手动形式。删除待处理标记不会产生批准。

## 升级前创建的任务

任务保留启动时冻结的计划。冻结计划带旧文档契约（按文档 kind 声明的 slots 与 reads）的任务，按它原样走完：文档账本 `.pipeline-documents.json`、固定路径的 kind、producer 校验、按 kind 的读取回执、`scaffold-document`、`record-document` 与 `register-field` 动作，以及带 `mode: "contract"` 和 `reads`、`records`、`updates` 三张表的 `step.documents`。

| 命令 | 新任务 | 升级前创建的任务 |
| --- | --- | --- |
| `tenon document read <change> all` 或路径 | 为交接来的输入写读取回执 | `all` 或文档 kind，与之前一样 |
| `tenon document status <change>` | 输入、产出、必须产出 | 登记与读取 |
| `tenon document scaffold`、`record`、`init`、`migrate-delta` | 拒绝，退出码 `2` | 与之前一样 |
| `tenon artifact register` | 拒绝，退出码 `1` | 冻结步骤声明了该 artifact 时可用 |

拒绝的提示是：本任务的产出由 Tenon 在离开步骤时自动记录，该命令只服务升级前创建的任务。没有冻结快照、绑定过旧完整 OpenSpec 档案的更早任务，会挂上冻结的 OpenSpec 文档表。

冻结计划里没有契约的升级前任务（例如轻量轨道）改为观察模式：已经在跑的那次访问没有检查点，记为 `unavailable`，没有输入，也不阻断；从下一次转换起恢复观察。

## 预期结果

- 每次转换都留下该步新增、修改、删除的文件记录，带来源技能或「未知」；
- 下一步只列直接上游的文档，读完之前不能离开；
- `required-output` 守卫在步骤写出匹配的文件之前一直阻断；
- `tenon document status` 与 Dashboard 工作台显示同样的输入、产出与必须产出。

## 验证

```bash
tenon document status <change-name> --json
tenon check <change-name>
```

## 常见失败

### 转换因输入未读被拒

读完 `read-documents` 动作的 `documents` 里列出的文件，执行 `tenon document read <change-name> all`，再转换。

### 必须产出显示缺失

让技能把文件写到模式指向的路径。本任务之前就存在的文件，除非本步改过，否则不算；在别的步骤写出的文件，也不算这一步的。

### 来源技能显示「未知」

文件是在本次访问没有加载任何技能时、与技能加载同一秒内、或第一个技能加载之前，由 shell 命令或子代理写出的。产出照样被记录和交接，只缺标签。

### 某一步没有任何记录

项目不是 git 仓库、git 命令失败，或这次访问在升级之前开始、没有检查点（`observation: unavailable`）。这时必须产出只检查存在匹配的文件。

### `document record` 或 `artifact register` 被拒

任务是新任务：不需要登记。见[升级前创建的任务](#升级前创建的任务)。

### 读取回执不满足输入

回执摘要既不等于上游记下的摘要，也不等于文件当前的内容。按当前内容重新读取。

### Build 发现需求变了

用 `requirements-changed` 回到 Spec，在那里修订并评审。

## 下一步

阅读[默认工作流](./default-workflow.md)或[自定义工作流与轨道](./custom-workflows-and-tracks.md)。
