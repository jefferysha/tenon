# 能力契约 — Pipeline 工具适配器接口（lite 版，BACKLOG #39）

> 本文档定义**可移植内核**（TypeScript CLI + 纯 bash 门 shim）与**目标工具适配器**之间的接口契约。
> 每个目标工具（Claude Code / Codex / Cursor / Gemini / …）实现一个 Adapter，把工具专属 hook
> 能力映射到 pipeline 的三能力，并按分档如实降级。
>
> **契约不是散文约定，而是机器约束**：`tools/test-adapters.sh` 对每个适配器跑同一组输入场景，
> 断言各适配器产出与 Claude Code baseline 等价的 inject/veto/track 决策——或以 `registry.yaml`
> 声明的降级档位如实降级。改坏任一契约（该拦却放行 / 该注却空 / 该留痕却不写 / 声明 native 却降级）
> **必被 conformance 抓红**。这解决老仓「contract 是约定不是测试」的病灶。

---

## 1. 三能力 + 分档降级（Capability Contract & Fidelity Tiers）

pipeline 内核依赖三类 Claude Code hook 能力。适配器须对每一项给出「原生等价实现」或「降级声明」。

| 能力 | Claude Code baseline（可移植内核真源） | 语义 |
|------|----------------------------------------|------|
| **inject** | `hooks/session-start.sh`（SessionStart） | 会话启动时注入 pipeline 上下文：宪法 + 活跃 change 相位/门状态 + openspec 提示 |
| **veto** | `hooks/gate.sh`（PreToolUse） | 工具调用前检查项目根新鲜 `.pipeline-pending-*` marker，命中则**硬拦**（非 0 退出） |
| **track** | `hooks/skill-tracker.sh`（PostToolUse Skill） | 工具调用后把记录 append 到 `openspec/changes/<name>/.pipeline-history.jsonl` |

### 分档（tier）

适配器整体档位由三能力的保真度决定，`registry.yaml` 每平台 `tier` 字段登记：

- **档 A — 全保真（full-fidelity）**：inject/veto/track 三能力均在目标工具原生 hook 上**等价实现**
  （硬拦 veto、会话级 inject、真留痕 track）。例：**codex**（与 CC 同构 hook 协议，wrapper 薄包 baseline 三 hook）。
- **档 B — 部分降级（partial）**：部分能力原生等价，部分**如实声明降级** fallback。例：**cursor**
  （veto/track native、inject 无 SessionStart 原语 → 降级 `.cursor/rules` 静态层 + `postToolUse.additional_context` 动态补）。
- **档 C — 静态降级（static-only）**：无 enforcement hook，三能力全靠**静态注入 + 保留人工确认事实的 CLI receipt**。
  例：**codex `--static`**、workflow-only 平台（devin，`hasHooks=false`）。

> **档位必须与实际行为一致**：声明 native 的能力，conformance 断言其产出与 baseline 等价；
> 声明 degraded 的能力，conformance 断言其**如实降级**（如 cursor inject 落 `.cursor/rules`、
> 且**不暴露伪 SessionStart inject**）。不得把降级伪装成硬门/原生（老仓 §2.2 红线）。

### 降级声明格式（写入平台 registry + 适配器 README）

```yaml
inject:
  status: degraded
  fallback: static-rules          # .cursor/rules/pipeline.md 静态层 + postToolUse.additional_context 动态补
  note: "工具无 SessionStart 级会话注入原语（spike 实证）"
veto:
  status: native
  format: permission-json         # {"permission":"deny","user_message":"<reason>"}；亦支持 exit 2
  failClosed: true                # 默认 fail-open，必须显式 failClosed:true，否则崩了放行——与硬拦冲突
```

---

## 2. Human acknowledgement（HITL 解封路径）

review/interaction/confirm 三门由项目根 `.pipeline-pending-{review,interaction,confirm}` marker 驱动
（`hooks/gate.sh` 命中新鲜 marker 即拦）。marker 是短时 hook 投影，**不是授权本身**：

| 场景 | 正确机制 |
|------|------|
| review 出口 | `tenon review request <change> --event <event>` → 人类确认 → `tenon review acknowledge <change>`；CLI 原子写 canonical approval receipt 后清 review marker |
| confirm / interaction | 宿主的真实问答完成 hook 记录确认事实并清对应投影；无该能力的静态宿主必须保留确认事实、重新发起操作，不得把删除 marker 当作确认 |

- `verify-fail` 与 `verify-pass` 是不同的人类决定；receipt 必须绑定 exact event，不能互相复用。
- 不得绕过 review-gate（会产生 solo 推进）。review marker 只由 `tenon review request` 在产物完成后
  写入；**不得**直接删除 v2 marker 或直接编辑 `.pipeline.yaml` 状态。

> lite 现实：内核是 TS CLI（`pipeline` 命令），review 的唯一解封写路径是 `tenon review acknowledge`；
> 状态写一律走 `pipeline` CLI。

---

## 3. stdout / 格式矩阵（不串格式）

不同目标工具要求 hook 输出不同格式。适配器须按工具映射正确格式，`registry.yaml` 的 `<cap>_format` 登记。

| 工具 | inject 格式 | veto 格式 | track 格式 |
|------|------------|-----------|-----------|
| Claude Code (baseline) | JSON `hookSpecificOutput.additionalContext`（SessionStart）| `exit 2` + stderr 指引 | append `.pipeline-history.jsonl` |
| **Codex** | 同 CC：JSON `hookSpecificOutput.additionalContext`（**非 plain**，spike 实证）| 同 CC：`exit 2` + stderr | 同 CC：wrapper 透传 baseline tracker |
| **Cursor** | **无会话级 inject → 降级 `.cursor/rules` 静态层**；动态仅 `postToolUse.additional_context` | JSON `{"permission":"deny"}` 或 `exit 2`（**非 exit 1**；默认 fail-open，须 `failClosed:true`）| `postToolUse` 时 wrapper 透传 baseline tracker append history |

**输入契约**：hook 输入 JSON 走 **stdin**（Codex 亦可 argv `$2`，wrapper argv+stdin 双吃）；
事件名由 hooks.json command 行 **argv `$1`** 传。**matcher**：Cursor 是 JS 正则（非 POSIX）。

> ⚠ 老仓 §3 对 Cursor 的「veto=exit1 / inject=会话级 additional_context」描述已被 spike 证伪，
> 本表以 `adapters/cursor/README.md` + 实测为准（详见老仓 `adapters/cursor/spike/NOTES.md`）。

---

## 4. Adapter 实现清单（Implementation Checklist）

新建 Adapter（如 `adapters/gemini/`）须满足（`adapters/lint-adapter.sh <id>` 机器校验前 5 项）：

- [ ] `registry.yaml` platforms 块登记：`tier` + `configDir` + `cliFlag` + `configure` + `agentCapable` + `hasHooks`
      + 三能力 `<cap>_status`/`<cap>_format`（`hasHooks=true` 须 `hookContainer` 非空；degraded 须 `<cap>_fallback`）
- [ ] `configure` 脚本（install 入口）存在
- [ ] inject/veto/track 各实现或声明降级（wrapper 薄包 baseline 三 hook，或降级落静态层）
- [ ] stdout/exit 格式与目标工具匹配（不串格式）
- [ ] Adapter README 已说明 `tenon review request --event` → 人工确认 → `tenon review acknowledge` 的 HITL 路径
- [ ] **进 conformance**：`tools/test-adapters.sh` 里对该平台跑同一组输入场景，断言等价/如实降级
- [ ] 状态写一律经 `pipeline` CLI（不直接编辑 `.pipeline.yaml`）
- [ ] **配置落盘走 `adapters/lib/atomic-write.sh`**，且 installer 顶部 `set -euo pipefail`：
      `atomic_write` / `atomic_render_template` / `atomic_stage`+`atomic_commit` 三选一，
      JSON 目标加 `--json`。裸 `cmd > "$目标"` 是 O_TRUNC，被打断就留半个文件；宿主解析失败普遍
      fail-open，`veto_failclosed` 会静默失效且无 receipt。不要复制第 12 份落盘逻辑。
- [ ] **未生效必须非零退出**：目标配置已被用户占用、只能旁挂 `<dst>.pipeline-adapter` 时，调
      `adapter_mark_not_applied <旁挂路径> <原因>`，收尾用 `adapter_finish`（有未生效项 → exit 3，
      并列出「需人工合并 <路径>」）。「完成 / 全保真」这类话只许在真接管时打印。

**加平台 = 填表非重写（D7/D14）**：`registry.yaml` 填一行平台条目 + 写 configure（落盘复用
`adapters/lib/atomic-write.sh`）+ 三个 wrapper（薄包 baseline hook）+ 在 conformance 加该 id
→ lint 与 conformance 自动覆盖。矩阵铺开对标
Tenon contract 16 平台 / Tenon runtime 30 平台的策略面。后续平台（gemini/copilot/pi/devin）目标档位见 registry `planned:`。

---

## 5. conformance 如何把契约变机器约束

`tools/test-adapters.sh`（仿 `tools/test-hooks.sh` 风格，真跑真断言，GOAL C9/C10 无伪测试）：

1. **同一组输入场景**喂每个适配器（veto 三态 marker / inject 活跃 change / track Skill 调用）。
2. **归一决策**：按 registry `<cap>_format` 把各适配器异构产出（exit 2 / permission-json /
   additionalContext / history append）归一成 canonical 决策（DENY/ALLOW · CONTEXT/EMPTY · RECORDED/NOT）。
3. **断言等价或如实降级**：native 能力须与 baseline（`gate.sh`/`session-start.sh`/`skill-tracker.sh`）
   同决策；degraded 能力须落声明的 fallback 且不伪装 native。
4. **真实副作用**：track 真 append `.pipeline-history.jsonl`（真文件系统），veto 真读项目根 marker，
   inject 真 cat baseline 宪法——断言的是真实副作用，非桩返回值。
5. **反例哨兵**：内建改坏的适配器（veto 放行 / track 不写 / inject 伪装 native），断言判别器把它们
   判为红——自证 conformance 有判别力（非空跑）。

**验收门**：`bash tools/test-adapters.sh` 全绿；`bash tools/verify-skills.sh` 不弄坏；
`bash tools/test-hooks.sh` 不弄坏现有 180。
