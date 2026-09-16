# Codex pipeline 适配器（lite，档 A/B/C）

> 契约：`adapters/contract.md`。本 adapter 把 Codex hook 能力映射到 pipeline 三能力。
> Codex 与 Claude Code **hook 协议同构**（spike 实证）：四 wrapper 薄包 lite baseline
> `hooks/session-start.sh` · `hooks/breadcrumb.sh`/`router.sh` · `hooks/gate.sh` · `hooks/skill-tracker.sh`。

## 安装

正常用户安装完整插件时，优先使用唯一的原生入口：

```bash
tenon setup --codex
# 可选：每天最多一次后台检查官方 marketplace 更新
tenon setup --codex --auto-update
```

它让 Codex 安装同一个 `tenon` marketplace 插件，包含 hooks、默认 workflow、所有 skill、CLI、
dashboard/AFK 工具和其他宿主 adapter。升级使用 `tenon update --codex`；自动更新只在新会话加载新的
skills 和 hooks。安装后必须在 Codex 输入 `/hooks` 并信任 `tenon` 一次；这是 Codex 的安全确认，未
信任时 package/skills 仍可见，但正常对话不会执行 SessionStart/UserPromptSubmit 路由。

下面的脚本是**项目级兼容 adapter**，只在需要将已安装插件投递进特定项目、受管设备或静态降级环境时使用：

```bash
adapters/codex/install.sh --target <项目目录>            # 档 A 全保真·manual-trust（默认）
adapters/codex/install.sh --managed --target <项目目录>  # 档 B 全保真·managed/MDM（需 root，免 trust）
adapters/codex/install.sh --static  --target <项目目录>  # 档 C 静态降级（无 hook，靠明确用户确认）
```

或经顶层派发器：`adapters/install.sh --codex --target <dir>`。

## 四能力（全 native，档 A/B）

```yaml
inject:
  status: native
  event: SessionStart
  format: json-additionalContext   # {"hookSpecificOutput":{"hookEventName","additionalContext"}}
  impl: hooks/inject.sh 薄包 hooks/session-start.sh 的 stdout（纯 bash json_escape，不引 jq）
route:
  status: native
  event: UserPromptSubmit
  format: json-additionalContext
  impl: hooks/prompt.sh 顺序包装 hooks/breadcrumb.sh 与 hooks/router.sh；开发型普通对话直接派发 default 的 pipeline 根 skill，不再先问是否走 workflow；用户的 active-change 只是恢复候选，只有用户明确继续/点名 change 时才读取对应 REAL_AGENT_TASK.md，新目标一律派发独立 `intent: new`
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

## 分档降级

| 档 | 部署 | inject/route/veto/track | trust |
|----|------|-------------------|-------|
| A 全保真·manual-trust | hooks.json → CODEX_HOME | 全 native | 一次性人工 trust（`/hooks` 按 t） |
| B 全保真·managed/MDM | /etc/codex/managed_hooks | 全 native | **免 trust**（唯一 headless 路径，需 root） |
| C 静态降级 | 仅 AGENTS.md 静态层 | 无 enforcement hook | 无 hook；靠静态纪律 + 用户下一条明确确认 |

## 人工确认（HITL）

档 A/B 的 Codex 正常对话会在 `UserPromptSubmit` 阶段识别用户的明确继续意图；用户输入
“确认继续”“继续执行”“全部执行”等，会在下一次工具调用前写入 event-bound approval receipt 并清除其
hook 投影。普通提问（如
“为什么需要确认？”）不会误放行。

档 C 没有 hook，因而不能自动确认；它也**不允许**通过删除 `.pipeline-pending-*` marker 绕过
review。必须保留用户已明确确认的对话事实，再执行 `tenon review acknowledge <change>` 与对应
transition。自动化/CI 只有在显式
`TENON_AFK=1` 的受控 AFK 路径才会旁路交互门。

## 打包 skills 的项目级投递

兼容 adapter 只会把本仓 `skills/` 下的完整 first-party skill 包以项目级软链投递到
`.agents/skills/`。它不读取或要求 Superpowers、OpenSpec CLI 或其他宿主的缓存；default workflow
使用的 `brainstorming`、`writing-plans`、`verification-before-completion` 等均随插件提供。

## hook trust（Codex 特有约束）

Codex 普通用户态对自定义 hook 要求一次性人工 trust；未 trust 前三能力静默不触发。档 B（managed
hooks + `/etc/codex/requirements.toml`）是唯一 always-on 免 trust 的路径，但只对 root/MDM 管理层生效。
