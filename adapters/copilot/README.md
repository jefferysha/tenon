# GitHub Copilot pipeline 适配器（lite，档 B）

> 契约：`adapters/contract.md`。本 adapter 把 Copilot coding agent 能力映射到 pipeline 三能力：
> **veto/track native、inject 降级**（档 B）。

## 转 active 做了什么（#40）

1. **veto native**：`hooks/veto.sh` 透传 lite baseline `hooks/gate.sh`，命中新鲜 marker → `exit 2` + stderr 硬拦。
2. **track native**：`hooks/track.sh` 透传 `hooks/skill-tracker.sh`，真 append
   `openspec/changes/<name>/.pipeline-history.jsonl`——与 codex/gemini/CC **同一条 history 记录**（conformance §⑧.4 断言）。
3. **inject 如实降级**：Copilot session-start 为平台私有、不可控 → 落 `.github/copilot-instructions.md`
   静态层（平台文档级上下文文件）+ userPromptSubmitted 动态补；**不暴露伪 SessionStart inject**
   （conformance 断言无 `hooks/inject.sh`）。

## dual hookContainer（Copilot 特有约束）

Copilot 引擎从 `.github/copilot/hooks.json` **与** `.github/hooks/tenon.json` 两处读 hook——
`install.sh` 同源写两份，**漏一份则 hook 不生效**。

## 安装

```bash
adapters/copilot/install.sh --target <项目目录>   # 默认 $PWD
adapters/copilot/install.sh --no-hooks            # 只装静态层（降级）
```

或经顶层派发器：`adapters/install.sh --copilot --target <dir>`。

## 三能力

```yaml
inject:
  status: degraded
  fallback: copilot-instructions             # .github/copilot-instructions.md 静态层 + userPromptSubmitted 动态补
  note: "Copilot session-start 平台私有不可控（无可控 SessionStart 原语）"
veto:
  status: native
  format: exit2-stderr                        # 命中新鲜 marker → exit 2 + stderr 指引
  container: dual (.github/copilot/hooks.json | .github/hooks/tenon.json)
track:
  status: native
  format: history-append                      # 真 append .pipeline-history.jsonl
```

## 人工确认（HITL）

完成产物并选择 event 后运行 `tenon review request <change> --event <event>`；然后等用户确认：用户在
Dashboard（`tenon dashboard --open`）确认，或由**用户本人在自己的终端**运行 `tenon review acknowledge <change>`
（本适配器没有写回执的 UserPromptSubmit hook，回复放行语不会写回执）；agent 不得代为执行该命令，持续授权下只可用
`--delegated`（它不批准待批准的测试豁免）。不得手动删除 `.pipeline-pending-review`，它只是投影而非授权。
