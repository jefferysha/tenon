# Devin（前 Windsurf）pipeline 适配器（lite，档 C 静态降级）

> 契约：`adapters/contract.md`。Devin 是 **workflow-only 平台**（`hasHooks=false`，无任何 enforcement
> hook）——三能力**全静态降级**。诚实：devin 确实只能到 C 档，本目录**无 `hooks/`**（不伪装 hook 强制）。

## 为什么是档 C（而非 A/B）

档 A/B 要求至少一项能力在原生 hook 上等价实现。Devin 无 hook 系统（只有 `.devin/workflows/*.md`
声明式工作流），故三能力全靠**静态注入 + 保留人工确认事实的 CLI receipt**——这正是 contract §1 的档 C 定义。
如实标注为 C，不为对齐其它平台而伪装原生（GOAL C9/C10 无伪测试 + contract §1 红线）。

## 三能力（全静态降级，档 C）

```yaml
inject:
  status: degraded
  fallback: static-workflow          # .devin/workflows/pipeline.md（无会话级注入原语）
veto:
  status: degraded
  fallback: cli-review-receipt       # 无硬拦；仍以 CLI 记录 review 的人工确认
track:
  status: degraded
  fallback: manual-note              # 无自动留痕（无 hook 触发点）——如实标注
```

## 安装

```bash
adapters/devin/install.sh --target <项目目录>   # 默认 $PWD
```

或经顶层派发器：`adapters/install.sh --devin --target <dir>`。

## windsurf 别名

Cognition 2026-06 把 Windsurf 改名 Devin（`.windsurf/` → `.devin/`）。windsurf 用户用 `--devin` 派发；
install 检测到旧 `.windsurf/workflows/` 只提示、不迁移（旧目录保留不动）。

## 人工确认（HITL）

Devin 无 hook、无 `AskUserQuestion`；仍须在完成产物并选择 event 后运行
`tenon review request <change> --event <event>`，然后等用户确认：用户在 Dashboard（`tenon dashboard --open`）
确认，或由**用户本人在自己的终端**运行 `tenon review acknowledge <change>`；agent 不得代为执行该命令
（持续授权下 agent 只可用 `--delegated`，它不批准待批准的测试豁免）。不得以删除 marker 替代确认。
