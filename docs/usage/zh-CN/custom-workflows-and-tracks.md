# 自定义 Workflow 与 Track

自定义能力用于表达团队真实流程，而不是给 default 换一个名字。

## 目标

创建一个可编译、可验证、能被新 Change 固定引用的项目 Workflow，并按需把它拆成路由可以推荐的 Track。短 Workflow 只生成合同声明的文档，不被强制扩成 default 七阶段。

## 前置条件

- 已理解[选择执行模式](./routing-and-workflows.md)和[文档、Skill 与证据链](./documents-skills-and-evidence.md)；
- 能修改项目的 `.pipeline/workflows/`；
- 工作流名唯一（名为 `default` 或 `design-system` 的文件会替换随插件发布的同名模板）；
- 已确定稳定 step id、可见 label、合法出边、review gate 和必要 Skill；
- 对需要保留的 OpenSpec 文档已经定义 owner、producer 和 read 关系。

## 步骤

### 1. 定义 Workflow

Workflow YAML 定义 step id、可见 label、transition event、回边、每步 Skill、guard、review gate、artifact 和可选 document contract。

step id 是稳定协议 token，可见 label 可以中文化。最小 Workflow 至少需要名称、非空 steps、每步的 inputs/outputs/guards/transitions。不要用 label 充当 id，也不要按 step 名猜测它应该拥有某种默认文档。

### 2. 定义 Track

Track 是 Workflow 里的一个分支，`tracks:` 下的分支就是全部的 Track：身份是「工作流 + 轨道 id」，没有独立的轨道登记表。在 Workflow YAML 里（或在 Dashboard 工作流页）声明分支，每个分支自带步骤。分支的键是闭集，其他键在加载时被拒绝：

| 键 | 含义 |
| --- | --- |
| `label` | CLI 与 Dashboard 里显示的名称 |
| `steps` | 分支的步骤 |
| `document_contract` | 分支的文档契约，写在它引用的步骤旁边 |
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
        inputs: []
        outputs: []
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

### 3. 声明 Document contract

`openspec: true` 打开文档治理；`document_contract:v1` 只声明 slot 与 read：

- kind；
- owner step；
- producers；
- 后续 step 需要读取哪些 kind。

locale 不进入 contract。呈现由 Document Presentation Registry 决定，治理仍由 kind、producer、path、digest 决定。

每个 slot 必须有唯一 owner step 和至少一个允许 producer；每个 read 必须指向合同中真实存在的 kind。scaffold 只能为合同声明的 kind 建结构，不能新增合同外文档来“补齐流程”。

delta spec 是 capability 文档，创建时必须显式提供真实 capability：

```bash
tenon document scaffold <change> delta-spec --capability <capability>
```

Change 名和 capability 名不是同一个概念，多 capability Change 也不能靠目录猜测。

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

如果合同只声明 proposal、plan、verification-report，Tenon 只生成这三种结构。它不会因为步骤叫 `approve` 或使用中文 label 就补齐 default 十类文档。

## 预期结果

- `tasks.md` 的一级项只列自定义 Workflow 的真实步骤；
- 当前 step 只调用它声明的 mandatory Skill；
- 未声明 kind、错误 producer 和未来 step 文档会被拒绝；
- review gate 只接受当前 step 的精确 outgoing event；auto gate（`gate: null` 或缺省同义）要求本步声明的输出齐全才放行前进边，退回边不受影响，引擎自己写的 `build_sha`、`archived` 不在检查内；已冻结的旧计划保持它记录的行为；
- 三步 Workflow 不会自动生成 default 的十类文档；
- 中文或英文只改变可见呈现，不改变 id、path、digest 和 guard。

## 验证

```bash
tenon tracks list
tenon status <change> --json
tenon document status <change>
```

非法 step、未知 producer、未声明 kind、未来阶段文档或缺失读取收据必须 fail-loud。提交 Workflow 前还应执行项目的 workflow freshness、skills、bundle 和 oracle 检查。

## 常见失败

- `workflow not found`：确认文件名与 Workflow `name` 一致；
- 路由不理我的 Workflow：分支只有写了 `route.keywords` 才是路由行，保存后下一条消息按新内容重建路由表；`tenon tracks list` 的 `ROUTABLE` 列可以核对；
- 保存了自己的 `default` 之后 `tenon assess` 报「该轨道没有改动风险阈值」：保存的文件里没有带 `diff-risk` 测试的 `lite` 分支，Tenon 不猜阈值；已开始的任务仍按冻结的计划走；
- Todo 仍显示七阶段：Change 实际绑定了 default，检查 init 参数和 status；
- 三步流程生成完整 OpenSpec：错误沿用了 default 的契约，而不是自己精确声明的 document contract；
- document record 被拒：producer 不属于 owner step，或没有当前 visit 的真实 Skill 证据；
- 修改 YAML 后旧 Change 没变化：这是固定身份的预期行为，需要显式迁移或新建 Change；
- delta spec 进入 `<change>/<change>`：调用 scaffold 时遗漏真实 `--capability`。

## 下一步

阅读[Default 七阶段工作流](./default-workflow.md)比较完整流程，或到[CLI 参考](./cli-reference.md)查找 Track、Workflow 和 document 子命令。
