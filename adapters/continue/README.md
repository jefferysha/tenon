# Continue CLI（`cn`）pipeline 适配器（lite，档 A 全保真）

> 契约：`adapters/contract.md`。本 adapter 把 **Continue CLI**（`cn`）的 hook 能力映射到 pipeline
> 三能力。Continue CLI 与 Claude Code **hook 协议逐字同构**（spike 实证，见下）：三 wrapper 薄包
> lite baseline `hooks/session-start.sh` · `hooks/gate.sh` · `hooks/skill-tracker.sh`（同 codex/gemini 做法）。

## 面向哪个"Continue"（重要，读前须知）

"Continue" 这个名字目前对应两个不同的产品面：

1. **Continue.dev IDE 插件**（VSCode/JetBrains，`config.yaml` + Rules）——spike 实测其官方文档
   （`docs.continue.dev/reference`）确认 Rules 只是拼进 system message 的**纯静态文本**，
   无 session/tool 生命周期钩子、无命令执行能力。这个面**没有**可挂 veto/track 的原语。
2. **Continue CLI（`cn`）**——一个独立、更新的 CLI 工具，源码
   （`continuedev/continue` 仓库 `extensions/cli/src/hooks/types.ts`）头注明确写：

   > "Claude Code-compatible hooks system for Continue CLI. These types match the exact
   > schemas from Claude Code so that any hook written for `claude` works with `cn` out of
   > the box."

   即：事件名（`PreToolUse`/`PostToolUse`/`SessionStart`/…）、输入字段（`cwd`/`tool_name`/…）、
   阻断机制（`exit code 2` 或 `decision:"block"`）**逐字照抄 Claude Code**。`extensions/cli/src/hooks/hookConfig.ts`
   甚至显式把 `~/.claude/settings.json`/`.claude/settings.json` 也列进读取路径（"Also supports
   Claude Code's native locations for cross-compatibility"）。

本 adapter **面向 (2) Continue CLI**——这是唯一真正具备"原生 hook 等价实现三能力"的面，也是
本框架"给其它 AI coding 工具补齐 inject/veto/track"这一目的下唯一有意义的目标。

> **对 registry 原目标档的修正说明**：`registry.yaml` longtail 曾登记 continue 目标档 B
> （"veto 无硬拦原语 → 降级"），那是填表阶段的初始假设，尚未见到 Continue CLI 源码。本轮
> spike（读 `extensions/cli/src/hooks/{types,hookConfig,HookService}.ts` 源码，非猜测）证实
> Continue CLI 的 PreToolUse **真硬拦**（`exit 2`，与 CC 完全同构），故三能力全 native，
> 档位由 B 上修为 **A**。如实纠偏，不照抄原表（GOAL 反 padding 同一红线也反低报）。

## 三能力（全 native，档 A）

```yaml
inject:
  status: native
  event: SessionStart
  format: json-additionalContext   # {"hookSpecificOutput":{"hookEventName","additionalContext"}}
  impl: hooks/inject.sh 薄包 hooks/session-start.sh 的 stdout（纯 bash json_escape，不引 jq）
veto:
  status: native
  event: PreToolUse
  format: exit2-stderr             # 命中新鲜 .pipeline-pending-* marker → exit 2 + stderr 指引（与 CC 逐字同构）
  impl: hooks/veto.sh 透传 hooks/gate.sh 退出码与 stderr
track:
  status: native
  event: PostToolUse
  format: history-append           # append openspec/changes/<name>/.pipeline-history.jsonl
  impl: hooks/track.sh 透传 hooks/skill-tracker.sh
```

## 安装

```bash
adapters/continue/install.sh --target <项目目录>            # 档 A 全保真（默认）
adapters/continue/install.sh --continue-home <dir>          # 自定义 CONTINUE_GLOBAL_DIR
adapters/continue/install.sh --no-hooks                     # 只提示（无 hook；仍须走 CLI review receipt）
```

或经顶层派发器：`adapters/install.sh --continue --target <dir>`。

投影产物：`.continue/settings.json#hooks`（三能力 hook，`__ADAPTER_DIR__` 定死绝对路径）。

## 人工确认（HITL）

review marker 只是 hook 投影，绝不是授权来源。完成本相位产物并选择 event 后，必须运行：

```bash
tenon review request <change> --event <event>
```

然后等用户确认：用户在 Dashboard（`tenon dashboard --open`）确认，或由**用户本人在自己的终端**运行
`tenon review acknowledge <change>`（本适配器没有写回执的 UserPromptSubmit hook，回复放行语不会写回执）；
agent 不得代为执行该命令，持续授权下只可用 `--delegated`（它不批准待批准的测试豁免）。

不得手动删除 `.pipeline-pending-review`；删除不会记录确认事实，也不能授权 transition。

## stdout 格式（不串格式）

- 输入 JSON 走 **stdin**（含顶层 `cwd` 字段，与 lite baseline 直接兼容）；事件名由 settings.json
  command 行 **argv `$1`** 传（wrapper argv+stdin 双吃）。
- **无 trust 机制**、落盘即生效。
- Continue CLI 同时兼容读取 `~/.claude/settings.json`/`.claude/settings.json`（跨工具共用），
  但本 adapter 仍写独立的 `.continue/settings.json`，保持"各平台各自 configDir"的填表惯例。
