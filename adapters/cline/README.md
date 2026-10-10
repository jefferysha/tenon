# Cline pipeline 适配器（lite，档 A 全保真）

> 契约：`adapters/contract.md`。本 adapter 把 Cline（VSCode 扩展 / SDK / CLI）的 hooks 能力映射到
> pipeline 三能力。Cline 有**真实、生产级**的 hooks 系统（非猜测——spike 直读
> `cline/cline` 开源仓库源码，见下）：三 wrapper 薄包 lite baseline `hooks/session-start.sh` ·
> `hooks/gate.sh` · `hooks/skill-tracker.sh`。

## 研究结论（2026-07-07 spike，非假设；对 registry 原目标档的修正说明）

`registry.yaml` longtail 曾登记 cline 目标档 B（"veto 降级为审批流"），那是填表阶段的初始假设。
本轮 spike 直接读 `cline/cline` GitHub 仓库源码（非二手摘要）：

- `.clinerules/hooks/README.md`（仓库自带文档）：明确列出 `PreToolUse`/`PostToolUse`/`TaskStart`/
  `TaskResume`/`TaskCancel`/`UserPromptSubmit` 等钩子，**"PreToolUse hook runs → can block or add
  context"**——真硬拦，非审批流。
- `sdk/examples/hooks/PreToolUse_BlockDestructive.sh`：官方示例脚本，标题即"阻止破坏性操作"。
- `apps/vscode/proto/cline/hooks.proto`：生产级 protobuf schema（`PreToolUseData` 等 message），
  证明这是正式基础设施，非实验特性。
- 输出契约明写：`{"cancel":bool,"contextModification"?:str,"errorMessage"?:str}`——`cancel:true`
  **阻止工具执行**（"Block execution and show error message to user"）。

三能力全部有真实、生产级、非猜测的原生实现——档位由 B 上修为 **A**。如实纠偏，不照抄原表
（GOAL 反 padding 同一红线也反低报；见 `registry.yaml` 对应条目注释）。

## 三能力（全 native，档 A）

```yaml
inject:
  status: native
  event: TaskStart + TaskResume        # 分别对应 CC SessionStart 的 source ∈ {startup, resume}
  format: contextModification          # {"cancel":false,"contextModification":"<pipeline 上下文>"}
  impl: hooks/TaskStart 薄包 hooks/session-start.sh；TaskResume 委托同一份逻辑
veto:
  status: native
  event: PreToolUse
  format: cancel-json                  # {"cancel":true,"errorMessage":"<reason>"}（真阻止工具执行）
  impl: hooks/PreToolUse 透传 hooks/gate.sh 的 marker 扫描决策
track:
  status: native
  event: PostToolUse
  format: history-append               # append openspec/changes/<name>/.pipeline-history.jsonl
  impl: hooks/PostToolUse 透传 hooks/skill-tracker.sh（真实工具名强制映射进 skill 字段，见下）
```

## 输入/输出 schema（与 CC/codex/gemini 不同——不串格式，contract §3）

- 输入**仅走 stdin**（无 argv 事件名——事件名嵌在 payload 的 `hookName` 字段里）。
- `cwd` 不是扁平键，而是 `workspaceRoots` 数组首项：`{"workspaceRoots":["<cwd>"]}`。
- 输出**恒为合法 JSON**（无 exit-code 语义——即使拦截也是 `exit 0` + `{"cancel":true,...}`）。
- 钩子文件**无扩展名**、精确命名（`PreToolUse`/`PostToolUse`/`TaskStart`/`TaskResume`），
  放在 `.clinerules/hooks/`（项目级）或 `~/Documents/Cline/Hooks/`（全局），需 `chmod +x` + shebang。

## track 的诚实适配：真实工具名强制映射

Cline 没有 Claude 式"Skill"工具概念——它自己的工具名是 `write_to_file`/`execute_command`/
`read_file` 等。若直接把这些真实工具名传给 baseline `hooks/skill-tracker.sh`（它只认
`tool_name ∈ {Skill,Agent,Task}`），track 会对**所有真实 Cline 工具调用恒不触发**——这正是
老仓"声明 track 却不写"的病灶（cursor README 也点过名）。本 adapter 的 `hooks/PostToolUse`
因此**强制**把 `tool_name` 设为字面 `"Skill"`、真实 Cline 工具名放进 `skill` 字段——保证
history 记录对任意真实工具调用都会真写（`raw="Skill: <真实工具名>"`），与 aider adapter 的
`aider-edit` 处理手法同一原则。

## 安装

```bash
adapters/cline/install.sh --target <项目目录>   # 默认 $PWD，装 .clinerules/hooks/
adapters/cline/install.sh --global              # 改装 ~/Documents/Cline/Hooks/（全局）
adapters/cline/install.sh --no-hooks            # 跳过 hook 安装（降级）
```

或经顶层派发器：`adapters/install.sh --cline --target <dir>`。

投影产物是**薄 shim 文件**（`.clinerules/hooks/<Name>`，每个只 `exec` 本仓库
`adapters/cline/hooks/<Name>` 的绝对路径）——因为 Cline 要求钩子是物理文件、精确命名，
不像 hooks.json 那样能在配置里指向任意绝对路径；shim 只做路径转发，逻辑本体仍留在本仓库、
可被 conformance 直接驱动。

## 一次性手动步骤（不降主档）

Cline 要求在 VSCode 设置里手动勾选一次「Enable Hooks」（Cline 侧栏 → 设置 → Feature Settings），
钩子文件落盘后才会真正生效——这与 Codex 的一次性 trust 步骤同理：contract.md 档 A 的判据是
"三能力在原生 hook 上等价实现"，不是"零人工步骤"，故不降档。

## 人工确认（HITL）

完成产物并选择 event 后运行 `tenon review request <change> --event <event>`；然后等用户确认：用户在
Dashboard（`tenon dashboard --open`）确认，或由**用户本人在自己的终端**运行 `tenon review acknowledge <change>`
（本适配器没有写回执的 UserPromptSubmit hook，回复放行语不会写回执）；agent 不得代为执行该命令，持续授权下只可用
`--delegated`（它不批准待批准的测试豁免）。不得手动删除 `.pipeline-pending-review`，它只是投影而非授权。

## 平台支持局限（如实登记，非本 adapter 缺陷）

Cline hooks 官方文档明写"Windows support is not available"（仅 macOS/Linux）——继承自 Cline
自身限制，非本适配器引入。
