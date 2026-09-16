# Cursor pipeline 适配器（lite，档 B——spike 转正）

> 契约：`adapters/contract.md`。stdout 格式以老仓 `adapters/cursor/spike/NOTES.md` 实测为准。
> 本 adapter 把 Cursor 能力映射到 pipeline 三能力：**veto/track native、inject 降级**（档 B）。

## 转正做了什么（vs 老仓 spike）

老仓 cursor 是「规划中」spike：veto 有 wrapper，但 **track wrapper 只做 inject 补偿、从未真 append
history**（「声明 track 却不写」的病灶）。本轮转正：

1. **track 真留痕**：`hooks/track.sh` 透传 lite baseline `hooks/skill-tracker.sh`，真 append 到
   `openspec/changes/<name>/.pipeline-history.jsonl`——与 codex/CC **同一条 history 记录**（conformance §⑤ 断言等价）。
2. **veto 真硬拦**：`hooks/veto.sh` 透传 `hooks/gate.sh` 决策，命中新鲜 marker → `{"permission":"deny"}`；
   `hooks.json` 强制 `failClosed:true`（默认 fail-open 与硬拦冲突，conformance §⑥ 断言）。
3. **inject 如实降级**：无 SessionStart 原语 → `.cursor/rules/tenon.mdc` 静态层（install 真落盘；frontmatter
   `alwaysApply: true`。Cursor 项目规则只认 `.mdc`，旧版写的 `.cursor/rules/pipeline.md` 从未生效：字节未改则安装时删除，
   改过则保留并警告）
   + `postToolUse.additional_context` 动态补偿；**不暴露伪 SessionStart inject**（conformance 断言无 `hooks/inject.sh`）。

## 安装

```bash
adapters/cursor/install.sh --target <项目目录>   # 默认 $PWD
adapters/cursor/install.sh --no-hooks            # 只装静态层（降级）
```

或经顶层派发器：`adapters/install.sh --cursor --target <dir>`。

## 三能力

```yaml
inject:
  status: degraded
  fallback: static-rules                     # .cursor/rules/tenon.mdc + postToolUse.additional_context
  note: "Cursor 无 SessionStart 级会话注入原语（spike NOTES §1.1）"
veto:
  status: native
  format: '{"permission":"deny","user_message":"<reason>"}'   # 亦支持 exit 2
  failClosed: true                           # 不可省：默认 fail-open，崩了放行
track:
  status: native
  format: history-append (+ postToolUse additional_context)
  note: "真 append .pipeline-history.jsonl；fail-safe 不回滚"
```

## stdout 格式（不串格式）

- 输入 JSON 走 **stdin**；事件名由 hooks.json command 行 **argv** 传。
- `preToolUse` / `beforeShellExecution` → `permission` / `user_message`。
- `postToolUse` → `additional_context`。
- matcher 是 **JS 正则**（非 POSIX）；**无 trust 机制**、落盘即生效（部署优势 vs Codex）。

## 人工确认（HITL）

完成产物并选择 event 后运行 `tenon review request <change> --event <event>`；人类明确确认后运行
`tenon review acknowledge <change>`。不得手动删除 `.pipeline-pending-review`，它只是投影而非授权。
