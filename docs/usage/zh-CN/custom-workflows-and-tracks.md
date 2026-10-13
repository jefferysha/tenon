# 自定义 Workflow 与 Track

自定义能力用于表达团队真实流程，而不是给 default 换一个名字。

## 目标

创建一个可编译、可验证、能被新 Change 固定引用的项目 Workflow，并按需把它拆成路由可以推荐的 Track。短 Workflow 不会被强制扩成 default 七阶段；文档由各步的技能按自己的 `SKILL.md` 写，Workflow 只写必须产出。

## 前置条件

- 已理解[选择执行模式](./routing-and-workflows.md)和[文档、Skill 与证据链](./documents-skills-and-evidence.md)；
- 能修改项目的 `.pipeline/workflows/`；
- 工作流名唯一（名为 `default` 或 `design-system` 的文件会替换随插件发布的同名模板）；
- 已确定稳定 step id、可见 label、合法出边、review gate 和必要 Skill；
- 已确定哪些步骤必须写出哪些文件（用 `required-output` 守卫表达）。

## 步骤

### 1. 定义 Workflow

Workflow YAML 定义 step id、可见 label、transition event、回边、每步技能、guard（含按路径的 `required-output`）和 review gate。

step id 是稳定协议 token，可见 label 可以中文化。最小 Workflow 至少需要名称、非空 steps、每步的 guards/transitions。不要用 label 充当 id，也不要按 step 名猜测它应该拥有某种默认文档。

门禁只有两种：`review`（人确认后才能离开）与 `auto`（本步的离开条件满足就能离开）。`gate: null` 或缺省同 `auto`。离开条件就是写在步骤和所走的边上的 guard，`auto` 自己不再追加检查：以前它由步骤的 `outputs` 推导「输出齐全」，现在步骤没有 `outputs` 了——要求某个字段有值写 `field-nonempty`，要求写出某个文件写 `required-output`。任务保留启动时冻结的计划，升级前开始的任务保持它记录的门禁行为。新的自定义 Workflow 若要为验证步冻结构建修订，要像 `templates/workflows/default.yaml` 一样显式写出 `build-complete` 边上的 `freeze-build-sha` 动作和 `verify-pass` 边上的 `build-head-unchanged` 守卫，它们不再从步骤的 `outputs` 推断。

### 2. 定义 Track

Track 是 Workflow 里的一个分支，`tracks:` 下的分支就是全部的 Track：身份是「工作流 + 轨道 id」，没有独立的轨道登记表。在 Workflow YAML 里（或在 Dashboard 工作流页）声明分支，每个分支自带步骤。分支的键是闭集，其他键在加载时被拒绝：

| 键 | 含义 |
| --- | --- |
| `label` | CLI 与 Dashboard 里显示的名称 |
| `steps` | 分支的步骤 |
| `spec` | `openspec` 或 `none`；不写时继承顶层 `openspec`（`openspec: true` 视为 `spec: openspec`），旧文件不用改 |
| `route` | 自动路由：`keywords`、`exclude`、`priority`，可选 `fallback: true`；不写表示路由从不选它，只能点名使用 |
| `automation` | `eligible`（能否进入 AFK）与 `enqueue_after_spec`（规格完成后自动入队）；不写时两者都关 |

```yaml
name: release-note
tracks:
  docs:
    label: 文档
    spec: none
    route:
      keywords: [changelog, 发布说明]
      priority: 50
    steps:
      - id: shape
        label: 整理
        gate: auto
        skills: []
        guards: []
        transitions:
          - event: shape-complete
            to: prove
```

声明了 `tracks:` 的 Workflow 只接受它列出的分支。`tenon init <change> --workflow release-note --track docs` 成功，因为 `release-note` 声明了 `docs`；要求一个 Workflow 没有声明的分支，会在写入任何东西之前被拒绝，并列出可选的轨道：

```text
ERROR: 工作流 'default' 没有轨道 'docs'（可选：lite, pm, frontend, backend）
```

没有 `tracks:` 的 Workflow 是平铺工作流，本身就是唯一的 Track：写 `--workflow <name>`，不写 `--track`。

带 `route` 的分支就是一行路由数据：关键词得分最高时路由器会推荐它。因为它属于自定义工作流，路由器不替你决定，而是让你选一对「工作流 + 轨道」。Dashboard 的轨道设置只能改 `keywords` 与 `spec`；`exclude`、`priority`、`fallback` 与 `automation` 只在 YAML 里改。`automation` 决定 AFK：只有 `eligible: true` 的分支能入队，没写 `automation` 的分支（所有平铺工作流也一样）不能：`tenon afk enqueue` 退出码 `3`，带 `--json` 时给出 `reason: "track-not-afk-eligible"`。

原来的内建轨道登记表和 `.pipeline/tracks.yaml` 不再读取。文件还在时 Tenon 只打印一行提示，把它的路由词写进 Workflow 分支的 `route` 即可。`tenon tracks list` 列出项目可用的全部工作流的全部轨道（列 `WORKFLOW:TRACK`、`LABEL`、`ROUTABLE`），`tenon tracks show <工作流>:<轨道>` 看单条；轨道 id 只在一个工作流里出现时可省略工作流名。

### 3. 声明必须产出

Workflow 不声明每一步的输入、输出文档。技能按自己的 `SKILL.md` 写文件；Tenon 在离开步骤时记录本步新增、修改、删除的文件与来源技能，把直接上游的 Markdown 文档交给下一步（下一步必须读完才能离开），并检查 `required-output` 守卫。这对每个 Workflow 和 Track 都一样，与是否走 OpenSpec 无关，见[文档、技能与证据链](./documents-skills-and-evidence.md)。

要求某个文件写出来，在步骤上（任何出口都要满足）或某条边上写 `required-output` 守卫：

```yaml
guards:
  - type: required-output
    path: docs/release-notes/{change}.md
```

`path` 是以 `/` 分隔的项目相对路径。`{change}` 是任务名，`*` 匹配一段内的任意字符，`**`（单独占一段）匹配任意多段，`?` 匹配一个字符；守卫和其他守卫一样可以带 `when`。满足条件：本任务里这一步的某次访问新增或修改过匹配的文件，且文件现在存在；仓库里本来就有的匹配文件，除非本步改过，否则不算。校验拒绝空串、绝对路径、`..`、反斜杠和 `{change}` 以外的占位符。

已删除的键：Workflow 不再接受 `document_contract`（顶层或 `tracks.<id>` 分支下）、非空的步骤 `inputs`、`outputs`、`artifacts`，以及依赖 `outputs` 的 `nonempty-output` 守卫。保存文件、创建任务和编译新计划时都会报错并给出替代写法：文档自动记录，文档条件写 `required-output`，字段条件写 `field-nonempty` 或 `field-equals`。

```text
document_contract 已删除：步骤的文档产出由 Tenon 在离开步骤时自动记录；需要门禁时写 { type: required-output, path: <路径> }
```

空的 `inputs: []`、`outputs: []`、`artifacts: []` 仍然可以读（Dashboard 以前保存的文件都带着它们），保存时不再写出。升级前创建的任务保留冻结的旧键计划，按它走完。

### 4. 创建并使用

```bash
tenon init <change> --workflow <workflow> --track <track> --preset full
tenon init <change> --workflow <平铺工作流>
tenon status <change> --json
tenon workflow plan <change> --json
```

新 Change 会固定 workflow identity 和文档语言；之后修改 YAML 不会静默重写正在运行的 Change。

### 5. 理解三步短流程

```text
draft → approve → done
```

如果只有 `draft`、`approve` 两步写了 `required-output`，Tenon 只要求这些文件。它不会因为步骤叫 `approve` 或使用中文 label 就补齐 default 的文档，也不会替任何一步铺 proposal、design 骨架。

## 预期结果

- `tasks.md` 的一级项只列自定义 Workflow 的真实步骤；
- 当前 step 只调用它声明的 mandatory Skill；
- 每次转换都记录本步实际新增、修改、删除的文件，只有声明的 `required-output` 会拦截离开；
- review gate 只接受当前 step 的精确 outgoing event；auto gate（`gate: null` 或缺省同义）在本步的离开条件满足时放行，自己不再追加「输出齐全」检查；已冻结的旧计划保持它记录的行为；
- 三步 Workflow 不会自动生成 default 的文档；
- 中文或英文只改变可见呈现，不改变 id、path 和 guard。

## 验证

```bash
tenon tracks list
tenon status <change> --json
tenon document status <change>
```

非法 step、被删除的旧键、`required-output` 路径模式不合法、有未读的交接输入或必须产出缺失必须 fail-loud。提交 Workflow 前还应执行项目的 workflow freshness、skills、bundle 和 oracle 检查。

## 常见失败

- `workflow not found`：确认文件名与 Workflow `name` 一致；
- 路由不理我的 Workflow：分支只有写了 `route.keywords` 才是路由行，保存后下一条消息按新内容重建路由表；`tenon tracks list` 的 `ROUTABLE` 列可以核对；
- 保存了自己的 `default` 之后 `tenon assess` 报「该轨道没有改动风险阈值」：保存的文件里没有带 `diff-risk` 测试的 `lite` 分支，Tenon 不猜阈值；已开始的任务仍按冻结的计划走；
- Todo 仍显示七阶段：Change 实际绑定了 default，检查 init 参数和 status；
- 保存 Workflow 时报 `document_contract`、`inputs`、`outputs` 或 `artifacts`：这些键已删除，删掉它们；文件条件写 `required-output`，字段条件写 `field-nonempty` 或 `field-equals`；
- 短流程没有产出我期望的文档：Workflow 自己不创建文档，是各步的技能按自己的 `SKILL.md` 写。给必须留下文件的那一步加 `required-output`，没有它就不能离开；
- 必须产出显示缺失：只有本任务里这一步新增或修改过、且现在仍存在的文件才算，见[文档、技能与证据链](./documents-skills-and-evidence.md#必须产出)；
- 修改 YAML 后旧 Change 没变化：这是固定身份的预期行为，需要显式迁移或新建 Change。

## 下一步

阅读[Default 七阶段工作流](./default-workflow.md)比较完整流程，或到[CLI 参考](./cli-reference.md)查找 Track、Workflow 和 document 子命令。
