# Gemini CLI pipeline 适配器（lite，档 A 全保真）

> 契约：`adapters/contract.md`。本 adapter 把 Gemini CLI hook 能力映射到 pipeline 三能力。
> Gemini CLI 与 Claude Code **hook 协议同构**（`settings.json#hooks`，`type:command`）：三 wrapper
> 薄包 lite baseline `hooks/session-start.sh` · `hooks/gate.sh` · `hooks/skill-tracker.sh`（同 codex 做法）。

## 安装

```bash
adapters/gemini/install.sh --target <项目目录>            # 档 A 全保真（默认）
adapters/gemini/install.sh --gemini-home <dir>            # 自定义 GEMINI_HOME
adapters/gemini/install.sh --no-hooks                     # 只提示（无 hook；仍须走 CLI review receipt）
```

或经顶层派发器：`adapters/install.sh --gemini --target <dir>`。

## 三能力（全 native，档 A）

```yaml
inject:
  status: native
  event: SessionStart
  format: json-additionalContext   # {"hookSpecificOutput":{"hookEventName","additionalContext"}}
  impl: hooks/inject.sh 薄包 hooks/session-start.sh（纯 bash json_escape，不引 jq）
veto:
  status: native
  event: PreToolUse
  format: exit2-stderr             # 命中新鲜 .pipeline-pending-* marker → exit 2 + stderr 指引
  impl: hooks/veto.sh 透传 hooks/gate.sh 退出码与 stderr
track:
  status: native
  event: PostToolUse
  format: history-append           # append openspec/changes/<name>/.pipeline-history.jsonl
  impl: hooks/track.sh 透传 hooks/skill-tracker.sh
```

## 已知 caveat（诚实登记，不降主档）

sub-agent 层无 `inject-subagent-context`（Gemini #18128：BeforeTool 链路受限）——仅影响 sub-agent
的上下文注入，主会话三能力全 native，故 tier 仍为 A。sub-agent 上下文改 pull-based prelude 补偿。

## 人工确认（HITL）

完成产物并选择 event 后运行 `tenon review request <change> --event <event>`；然后等用户确认：用户在
Dashboard（`tenon dashboard --open`）确认，或由**用户本人在自己的终端**运行 `tenon review acknowledge <change>`
（本适配器没有写回执的 UserPromptSubmit hook，回复放行语不会写回执）；agent 不得代为执行该命令，持续授权下只可用
`--delegated`（它不批准待批准的测试豁免）。不得手动删除 `.pipeline-pending-review`，它只是投影而非授权。

## stdout 格式（不串格式）

- 输入 JSON 走 **stdin**；事件名由 settings.json command 行 **argv `$1`** 传（wrapper argv+stdin 双吃）。
- **无 trust 机制**、落盘即生效（部署优势 vs Codex 的一次性 trust）。
