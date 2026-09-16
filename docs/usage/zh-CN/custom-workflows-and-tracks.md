# 自定义 Workflow 与 Track

自定义能力用于表达团队真实流程，而不是给 default 换一个名字。

## 目标

创建一个可编译、可验证、能被新 Change 固定引用的项目 Workflow，并用 Track 决定谁可以选择它。短 Workflow 只生成合同声明的文档，不被强制扩成 default 七阶段。

## 前置条件

- 已理解[选择执行模式](./routing-and-workflows.md)和[文档、Skill 与证据链](./documents-skills-and-evidence.md)；
- 能修改项目的 `.pipeline/workflows/` 与 Track 配置；
- 已确定稳定 step id、可见 label、合法出边、review gate 和必要 Skill；
- 对需要保留的 OpenSpec 文档已经定义 owner、producer 和 read 关系。

## 步骤

### 1. 定义 Workflow

Workflow YAML 定义 step id、可见 label、transition event、回边、每步 Skill、guard、review gate、artifact 和可选 document contract。

step id 是稳定协议 token，可见 label 可以中文化。最小 Workflow 至少需要名称、非空 steps、每步的 inputs/outputs/guards/transitions。不要用 label 充当 id，也不要按 step 名猜测它应该拥有某种默认文档。

### 2. 定义 Track

Track 约束允许的 workflow、默认 workflow、review seed、技能和领域覆盖等策略。内建 simple、free、frontend、backend、pm 不是可以随意互换的别名。

Track 和 Workflow 是两个维度：Workflow 决定时序与证据合同，Track 决定策略覆盖和默认选择。一个 Track 可以允许多个 Workflow，但创建 Change 时必须解析出唯一 effective plan。

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
tenon init <change> --track <track> --workflow <workflow> --preset full
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
- review gate 只接受当前 step 的精确 outgoing event；
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

- `workflow not found`：确认文件名、Workflow `name` 和 Track allowlist 一致；
- Todo 仍显示七阶段：Change 实际绑定了 default，检查 init 参数和 status；
- 三步流程生成完整 OpenSpec：错误沿用了 default 的契约，而不是自己精确声明的 document contract；
- document record 被拒：producer 不属于 owner step，或没有当前 visit 的真实 Skill 证据；
- 修改 YAML 后旧 Change 没变化：这是固定身份的预期行为，需要显式迁移或新建 Change；
- delta spec 进入 `<change>/<change>`：调用 scaffold 时遗漏真实 `--capability`。

## 下一步

阅读[Default 七阶段工作流](./default-workflow.md)比较完整流程，或到[CLI 参考](./cli-reference.md)查找 Track、Workflow 和 document 子命令。
