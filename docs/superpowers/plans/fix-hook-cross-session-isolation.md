# Hook 跨会话隔离与评审回执撤销 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**本计划分 A、B 两部分。** A 部分（本文 Task 1-11）实现 hook 按宿主会话判定「当前任务」、交互标记带归属、放行语整条匹配、评审回执可撤销、串单状态的更正。**B 部分（源码开发安装 + 漂移检查）由主线另行补入**，见文末 `## Part B — 源码开发安装与漂移检查`。A 部分不依赖 B 部分，但 A 的改动要等 B 部分的本地运行时重装后才在真实会话里生效。

**Goal:** 并行会话各做一个 Change 时，拦截、代为确认与记证据的 hook 只作用于本会话自己的任务；误记的评审批准可正规撤回为待确认。

**Architecture:** `hooks/active-change.sh` 新增唯一的「本会话任务」解析 `pipeline_session_change_dir`（复用 `hooks/host-session-binding.sh` 的会话绑定，纯 bash 无 fork 扫描），10 个拦截与记证据的 hook 加一个小保护的 router 改用它；`.pipeline-pending-interaction` 升级为带 change / session 归属的 v2 标记（新文件 `hooks/pending-marker.sh`）；放行语判定收敛到 `pipeline_text_is_approval_phrase`，对话回复与 AskUserQuestion 答案值共用。CLI 侧新增 `tenon review revoke`，`session activate --host-session` 在写绑定前移交同一 Change 的旧绑定；kernel 的评审确认应用修正「账本 replay 吞掉撤销后的重新确认」。

**Tech Stack:** bash 3.2 / BSD+GNU 兼容的 hook 与 `tools/test-hooks.sh`；TypeScript ESM + Commander + Vitest（`packages/kernel`、`packages/cli`）；esbuild 单文件 bundle（tracked `packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`）。

**Spec:**
- 设计：`docs/superpowers/specs/fix-hook-cross-session-isolation-design.md`（本计划覆盖 1-4、6 与「模块与接缝」；5「已污染状态」是最后一个 Task）
- ADR：`docs/adr/fix-hook-cross-session-isolation.md`
- Delta spec：`openspec/changes/fix-hook-cross-session-isolation/specs/interaction-and-skill-provenance/spec.md`（每个 Scenario 在下面「Scenario 覆盖」表里有对应测试）
- 规则：`.agent-rules/COMMON.md`、`.agent-rules/BACKEND.md`

## Global Constraints

- hook 热路径纯 bash：`active-change.sh`、`pending-marker.sh`、gate / CC / CP 等不得 spawn node、python、jq 等解释器；`tools/test-hooks.sh` §3 的红线自证按「剥注释后的可执行行」检查，新文件同样加红线断言。
- 兼容 macOS 系统 bash 3.2 与 BSD 工具，同时兼容 Linux/GNU：不用 `read -N`、`mapfile`、关联数组、`${var,,}`；有界读取用 `IFS= read -r -d '' -n <N> var < file`（已在 /bin/bash 3.2.57 验证）。
- 会话 id 合法字符集 `[A-Za-z0-9_-]`、长度 ≤128；不合法一律按「宿主没给 session_id」处理（回退共享指针的旧行为）。
- 会话绑定文件 `.pipeline/terminal-sessions/<id>.json`：单文件读取上限 4096 字节；符号链接、超大、损坏、`session_id` 与文件名不符、协议名不是 `pipeline-terminal-session-v1` 的文件一律不算绑定。扫描他会话绑定的文件数上限 1024，超过时无法证明「没人绑定」，保守按「已被别的会话绑定」处理。
- 「本会话任务」解析顺序（设计 §1，不改）：本会话有绑定 → 绑定的 Change；有合法 session_id、无本会话绑定、共享指针指向的 Change 已被别的会话绑定 → 无（返回 1）；宿主没给 session_id 或该 Change 无人绑定 → 回退 `pipeline_active_change_dir`。
- 交互标记 v2：首行 `pipeline-interaction-v2`，随后 `change=`、`session=`、`skills=`、`requested_at=`；`session` 非空 → 只属该会话；`session` 空而 `change` 非空 → 属于本会话任务为该 Change 的会话；两者皆空 → 属于全部会话。旧格式（首行不是协议名，含空文件）见到即删除、不拦截。`.pipeline-pending-confirm` 不改格式。子代理（`agent_id`）对 confirm / interaction 标记的豁免保持不变。
- 放行语：去首尾空白与句末标点（`。！!.，,～~` 与空格）、去掉「 (Recommended)」「（推荐）」后缀后，整条等于清单中的一项才算；长度超过 160 直接不算。AskUserQuestion 只看 `tool_response.answers` 里的答案值；取不到 `answers`（schema 漂移或损坏）必须不确认。拒绝 / 附条件的既有判定顺序不变。
- `tenon review revoke <change> --reason <原因>`：原因必填、一行、≤200 字、无控制字符；`assertOwner` 限定负责人；在 Change 锁内把当前步 `approved` 且未被消费的回执撤回为同一 event 的 `pending`，沿用原 `review_requested_at` 与 `.pipeline-review-gate-binding.json`，用 `writeReviewMarker` 重写 v2 评审标记，写 `review.revoked` 审计行并经 `store.writeUnderLock` 同步 `.pipeline.yaml` 投影；缺原因、已消费、本就待确认、无回执、非负责人 → exit 1 且不改任何状态。
- `session activate --host-session <id>`：写绑定前删除其他会话对同一 Change 的合法绑定，stderr 逐个输出 `[activate] 已从会话 <旧 id> 移交 <change>`。
- CLI / kernel 源码改动后必须重新生成 tracked `packages/cli/dist/tenon.mjs`（`npm run bundle`）；kernel 的评审确认应用同时进入 server bundle，所以还要重新生成 `packages/server/dist/dashboard.mjs`（`npm run build:server`）。不手改 dist。
- 新增 CLI 文案进 `packages/cli/src/i18n/messages-review.ts`，`zh` 与 `en` 成对，`en` 不含中日韩字符，占位符两边一致；新增选项同步 `help-en-core.ts`。
- 本任务用到与新增的全部测试脚本都登记进任务的测试计划，运行经 `tenon test run`；下面每步给出的命令是被登记的底层命令。
- 所有 `git commit` 的信息结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 不改 `router.sh` / `breadcrumb.sh` 的恢复候选逻辑（router 只改 `router_confirms_open_review` 一处小保护）。离开评审步仍需 canonical 回执（transition 校验不变）。
- 非目标：Dashboard 里「撤销后重新批准」的 `consumed` 证据链会读作 `answered` / `unknown`（第二条 `review.acknowledged` 事件的 `stateBeforeHash` 对不上 `request.stateAfterHash`，见 `packages/kernel/src/decision/projection.ts` 的 `reviewEvidence`），只影响展示，不处理；单文件标记结构不改；不提供按会话存放共享指针。

## Review Focus

计划里设计与任务测试都没覆盖、但最可能在真实并行会话里出问题的输入或条件，各自在所属 Task 里有一条测试把它钉住：

1. **session_id 含非法字符或超长**（如 `../etc/passwd`、含空格、129 位）：应按「宿主没给 session_id」回退共享指针，不得拿它拼路径或写进标记。Task 1 钉住。
2. **绑定文件是符号链接 / 超过 4096 字节 / JSON 损坏 / `session_id` 与文件名不符 / 数量超过扫描上限**：前四类不算「别的会话已绑定」；超过扫描上限保守判为已绑定（无任务）。Task 1 钉住。
3. **同一 Change 有两个绑定（移交前遗留）**：两个会话各自仍解析到该 Change，新 id 无任务；下一次 `session activate` 把它们都移交。Task 1、Task 7 钉住。
4. **交互 / 评审标记是项目根上的单文件，两个会话几乎同时落标记时后写者整份替换先写者**：已知限制，本任务不改结构。后果是 fail-open（先写者那一方不再被拦），不会产生半截文件（临时文件 + 原子 rename），离开评审步仍需 canonical 回执。Task 4 钉住「后写者整份替换且无残留临时文件」。
5. **AskUserQuestion 的 `tool_response` schema 漂移**（没有 `answers`、`answers` 是数组、成员不是字符串、JSON 截断）：必须不确认评审，但 interaction 标记照旧按会话解除。Task 5、Task 6 钉住。
6. **撤销后重新确认被账本 replay 吞掉**：终端 / delegated 通道的幂等 key 由 requestedAt、绑定摘要等确定性算出，撤销沿用它们，旧 `approved` 账本记录会让 `review acknowledge` 返回成功却不写状态。Task 8 钉住（先红）。
7. **`--reason` 注入**：含换行 / 控制字符 / 超长 / 纯空白的原因必须被拒绝，不得写进审计行。Task 9 钉住。

## Scenario 覆盖（delta spec → 测试）

| Scenario | 测试位置 |
| --- | --- |
| 另一个会话的评审不拦本会话 | Task 2：`tools/test-hooks.sh` §15 gate 用例 |
| 另一个会话的放行语不确认本任务 | Task 6：§15 CP 用例 |
| 技能证据记到本会话任务 | Task 3：§15 skill-tracker 用例；Task 2：技能顺序门用例 |
| 会话恢复换了 id 尚未重新绑定 | Task 1 / 2 / 3 / 6：新 id 不拦、不确认、不记证据 |
| 宿主不提供会话标识 | Task 1 / 2 / 3：无 session_id 回退旧行为 |
| 恢复后的新会话接管任务 | Task 7：session.integration.test.ts |
| 一个会话加载交互技能不锁其他会话 | Task 4 |
| 其他会话的提问不解除本会话标记 | Task 6：CC 用例 |
| 旧格式标记退役 | Task 4 |
| 粘贴文本里的放行语不构成放行 | Task 5（分类、提示）、Task 6（CP 会话内） |
| 整条短回复构成放行 | Task 5、Task 6 |
| AskUserQuestion 只看答案值 | Task 5（helper）、Task 6（CC） |
| 撤回误记的批准 / 已被消费 / 缺少原因 / 撤销后状态已变化 | Task 9：`review-revoke.integration.test.ts` |

## 文件结构

**新增**

- `hooks/pending-marker.sh`：v2 交互标记的写入、归属判定、认领与技能名读取（唯一知道标记格式的地方）。
- `packages/cli/src/commands/review-revoke.ts`：`tenon review revoke` 的应用逻辑。
- `packages/cli/src/commands/review-revoke.integration.test.ts`：revoke 的真实 e2e。
- `packages/kernel/src/state/review-gate-revoke.test.ts`：`reviewGateRevokePatch` 单测。

**修改（hooks）**

- `hooks/active-change.sh`：`pipeline_valid_session_id`、`pipeline_hook_session_id`、`pipeline_session_change_dir`。
- `hooks/review-ack.sh`：`pipeline_review_active_change_name` / `pipeline_acknowledge_active_review` 增加 session 参数，改正「per-session」注释。
- `hooks/gate.sh`：评审标记归属、技能顺序门、动画门、交互标记归属、提示文案。
- `hooks/skill-tracker.sh`、`hooks/skill-start.sh`、`hooks/codex-skill-receipt.sh`、`hooks/decision-recorder.sh`、`hooks/test-nudge.sh`：改用会话解析。
- `hooks/interactive-skill-gate.sh`：改用会话解析（含持续授权）、写 v2 标记。
- `hooks/json-input.sh`：`pipeline_json_object_any_value`。
- `hooks/prompt-intent.sh`：`pipeline_approval_phrase_class`、`pipeline_text_is_approval_phrase`，显式放行分支改整条匹配。
- `hooks/confirm-clear.sh`、`hooks/confirm-clear-prompt.sh`：只解归属本会话的标记，按会话确认评审与记证据，答案值判定。
- `hooks/router.sh`：`router_confirms_open_review` 一处小保护。

**修改（CLI / kernel）**

- `packages/kernel/src/state/review-gate.ts`、`packages/kernel/src/state/index.ts`：`reviewGateRevokePatch`。
- `packages/kernel/src/decision/review-application.ts`、`packages/kernel/src/decision/review-application.test.ts`：账本 replay 修正。
- `packages/cli/src/commands/session.ts`、`session.test.ts`、`packages/cli/src/session.integration.test.ts`：绑定移交。
- `packages/cli/src/commands/review.ts`、`packages/cli/src/program-review.ts`、`packages/cli/src/i18n/messages-review.ts`、`packages/cli/src/i18n/help-en-core.ts`、`packages/cli/src/i18n/agent-messages.test.ts`：revoke 分派、选项、文案、help。
- `packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`：重新生成。

**修改（测试与文档）**

- `tools/test-hooks.sh`：新增 §15，并迁移受影响的旧用例。
- `tools/test-adapters.sh`：迁移 5 处旧格式交互标记。
- `packages/cli/src/terminal-activity-hook.integration.test.ts`：放行语整条匹配后的 router 用例。
- `docs/CONTRACT.md`、`docs/usage/cli-reference.md`、`docs/usage/zh-CN/cli-reference.md`、`.trellis/spec/cli/frontend/hook-guidelines.md`。

不需要改 `tools/verify-skills.sh`：它只列入口 hook（`:190-203`）与 `canonical-state` / `json-input` / `prompt-intent` 三个 helper 的存在性；`:213-219` 对 `hooks/` 下全部 `*.sh` 做 `bash -n`；发布载荷整目录携带 `hooks`（`packages/cli/src/runtime/release-store-codecs.ts` 的 `PAYLOAD_ENTRIES`）。`pending-marker.sh` 随目录发布并被语法检查覆盖。

## 实现前提醒：`tools/test-hooks.sh` 的编号与插入位置

现有最大节号是 14（`# ── 14. 归档`），`13.` 出现过两次（多用户、launcher）。新增一节编号 **15**，所有新用例追加在文件末尾 `# ───────────────────────── 汇总 ─────────────────────────` 这一行之前，同一节内按 Task 顺序追加小节。该文件一次完整运行较慢（数十秒到数分钟，含多处 node 子进程），每个 Task 的「运行」步都是完整运行，用 `2>&1 | grep -E '^(FAIL|[0-9]+ passed)'` 过滤输出。

---

### Task 1: 本会话任务解析（`active-change.sh`）与 §15 测试夹具

**Files:**
- Modify: `hooks/active-change.sh`（头部注释 1-9 行追加一段；文件末尾追加新函数）
- Modify: `tools/test-hooks.sh`（在 `# ───────────────────────── 汇总 ─────────────────────────` 之前追加 §15 夹具与 Task 1 用例）
- Test: `tools/test-hooks.sh`

**Interfaces:**
- Consumes: `pipeline_active_change_dir <root>`（同文件，只读）、`pipeline_host_session_change_name <root> <session_id>`（`hooks/host-session-binding.sh:15`）、`pipeline_json_get_string <json> <key>`（`hooks/json-input.sh`）。
- Produces:
  - `pipeline_valid_session_id <id>`：0 = 可作绑定键（`[A-Za-z0-9_-]`、1-128）。
  - `pipeline_hook_session_id <hook-input-json>`：stdout 打印通过校验的 session id；缺失或不合法打印空，始终返回 0。
  - `pipeline_session_change_dir <verified-root> <session-id>`：stdout 打印 Change 目录绝对路径（`<root>/openspec/changes/<name>`）；返回 1 表示「没有任务」。session-id 不合法或为空时等价于 `pipeline_active_change_dir`。
  - `PIPELINE_SESSION_SCAN_MAX=1024`。

- [ ] **Step 1: 写失败测试**

在 `tools/test-hooks.sh` 的汇总行之前追加（夹具先于用例，后续 Task 复用这些夹具与 `XS_TENON_*`）：

```bash
# ═══════════════ 15. 跨会话隔离：hook 按宿主 session_id 解析「本会话任务」（fix-hook-cross-session-isolation） ═══════════════
# 夹具：Change A 绑定会话 A，Change B 绑定会话 B，共享指针（恢复候选）指向 A；XS_SID_NEW 是恢复后换了 id、没有任何绑定的会话。
XS_SID_A='session-a-0001'; XS_SID_B='session-b-0002'; XS_SID_NEW='session-new-0003'
xs_assert_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望「${2}」，实得「${3}」"; fi
}
xs_mk_change() { # $1=root $2=name $3=phase
  mkdir -p "$1/openspec/changes/$2"
  printf 'phase: %s\ntrack: backend\nworkflow: default\narchived: false\n' "$3" > "$1/openspec/changes/$2/.pipeline.yaml"
}
xs_bind() { # $1=root $2=session id $3=change
  mkdir -p "$1/.pipeline/terminal-sessions"
  printf '{"protocol":"pipeline-terminal-session-v1","session_id":"%s","change":"%s","bound_at":"2026-10-07T00:00:00Z"}\n' "$2" "$3" \
    > "$1/.pipeline/terminal-sessions/$2.json"
}
xs_project() { # $1=目录名 → 打印项目根（A 绑 A、B 绑 B、指针指向 A）
  local p="$TMP/$1"
  mkdir -p "$p/.git"
  xs_mk_change "$p" xs-change-a spec
  xs_mk_change "$p" xs-change-b build
  xs_bind "$p" "$XS_SID_A" xs-change-a
  xs_bind "$p" "$XS_SID_B" xs-change-b
  set_active "$p" xs-change-a
  printf '%s' "$p"
}
xs_resolve() { # $1=项目根 $2=session id（可空）→ 打印 Change 名；没有任务打印 NONE
  bash -c '. "$1/hooks/json-input.sh"; . "$1/hooks/canonical-state.sh"; . "$1/hooks/active-change.sh"; d="$(pipeline_session_change_dir "$2" "$3")" && printf "%s" "${d##*/}" || printf NONE' _ "$ROOT" "$1" "$2" 2>/dev/null
}
xs_hook_sid() { # $1=hook 输入 JSON → 打印通过校验的 session id（可能为空）
  bash -c '. "$1/hooks/json-input.sh"; . "$1/hooks/canonical-state.sh"; . "$1/hooks/active-change.sh"; pipeline_hook_session_id "$2"' _ "$ROOT" "$1" 2>/dev/null
}
XS_TENON_BIN="$TMP/xs-fake-tenon-bin"; XS_TENON_LOG="$TMP/xs-fake-tenon.log"
mkdir -p "$XS_TENON_BIN"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$TENON_HOOK_LOG"\n' > "$XS_TENON_BIN/tenon"
chmod +x "$XS_TENON_BIN/tenon"

# ── 15a. pipeline_session_change_dir：绑定、他会话绑定、回退、非法输入 ──
xs_p="$(xs_project xs-resolve)"
xs_assert_eq "session-resolve: 会话 A 取自己绑定的 Change A" xs-change-a "$(xs_resolve "$xs_p" "$XS_SID_A")"
xs_assert_eq "session-resolve: 会话 B 取自己绑定的 Change B（共享指针指向 A 也不借用）" xs-change-b "$(xs_resolve "$xs_p" "$XS_SID_B")"
xs_assert_eq "session-resolve: 恢复后的新 id 无绑定、指针指向的 A 已被会话 A 绑定 → 无任务" NONE "$(xs_resolve "$xs_p" "$XS_SID_NEW")"
xs_assert_eq "session-resolve: 宿主没给 session_id → 回退共享指针（旧行为）" xs-change-a "$(xs_resolve "$xs_p" '')"
xs_long_id="$(printf '%0129d' 0)"
for xs_bad_id in '../etc/passwd' 'has space' "$xs_long_id"; do
  xs_assert_eq "session-resolve: 非法或超长 id「${xs_bad_id:0:16}」按没给 id 处理 → 回退共享指针" xs-change-a "$(xs_resolve "$xs_p" "$xs_bad_id")"
done
xs_assert_eq "hook-session-id: 合法 id 原样返回" "$XS_SID_A" "$(xs_hook_sid "{\"session_id\":\"$XS_SID_A\",\"cwd\":\"/x\"}")"
xs_assert_eq "hook-session-id: 含空格的 id 返回空" "" "$(xs_hook_sid '{"session_id":"a b","cwd":"/x"}')"
xs_assert_eq "hook-session-id: 没有 session_id 返回空" "" "$(xs_hook_sid '{"cwd":"/x"}')"
xs_assert_eq "hook-session-id: 129 位 id 返回空" "" "$(xs_hook_sid "{\"session_id\":\"$xs_long_id\"}")"

# 指针指向无人绑定的 Change：回退共享指针（用户确认的旧行为，例如未带 --host-session 激活）。
xs_mk_change "$xs_p" xs-change-c build
set_active "$xs_p" xs-change-c
xs_assert_eq "session-resolve: 指针指向无人绑定的 Change → 回退指针" xs-change-c "$(xs_resolve "$xs_p" "$XS_SID_NEW")"
# 同一 Change 两个绑定（移交前遗留）：两个会话各自仍取它，新 id 仍无任务。
set_active "$xs_p" xs-change-a
xs_bind "$xs_p" session-a-legacy xs-change-a
xs_assert_eq "session-resolve: 遗留的第二个绑定仍取该 Change" xs-change-a "$(xs_resolve "$xs_p" session-a-legacy)"
xs_assert_eq "session-resolve: 同一 Change 有两个绑定时新 id 仍无任务" NONE "$(xs_resolve "$xs_p" "$XS_SID_NEW")"

# 不合法的他会话绑定不算「已被别的会话绑定」：符号链接、超过 4096 字节、损坏、session_id 与文件名不符。
xs_p2="$(xs_project xs-invalid-bindings)"
rm -f "$xs_p2/.pipeline/terminal-sessions/$XS_SID_B.json"
set_active "$xs_p2" xs-change-b
printf '{"protocol":"pipeline-terminal-session-v1","session_id":"session-link-0004","change":"xs-change-b","bound_at":"x"}\n' > "$xs_p2/real-binding.json"
ln -s "$xs_p2/real-binding.json" "$xs_p2/.pipeline/terminal-sessions/session-link-0004.json"
xs_assert_eq "session-resolve: 符号链接的绑定文件不算别人已绑定 → 回退指针" xs-change-b "$(xs_resolve "$xs_p2" "$XS_SID_NEW")"
rm -f "$xs_p2/.pipeline/terminal-sessions/session-link-0004.json"
printf '{"protocol":"pipeline-terminal-session-v1","session_id":"session-big-0005","change":"xs-change-b","pad":"%s"}\n' "$(head -c 5000 /dev/zero | tr '\0' x)" \
  > "$xs_p2/.pipeline/terminal-sessions/session-big-0005.json"
xs_assert_eq "session-resolve: 超过 4096 字节的绑定文件不算别人已绑定 → 回退指针" xs-change-b "$(xs_resolve "$xs_p2" "$XS_SID_NEW")"
rm -f "$xs_p2/.pipeline/terminal-sessions/session-big-0005.json"
printf '"xs-change-b" garbage not json\n' > "$xs_p2/.pipeline/terminal-sessions/session-bad-0006.json"
xs_assert_eq "session-resolve: 损坏的绑定文件不算别人已绑定 → 回退指针" xs-change-b "$(xs_resolve "$xs_p2" "$XS_SID_NEW")"
rm -f "$xs_p2/.pipeline/terminal-sessions/session-bad-0006.json"
xs_bind "$xs_p2" other-name-0007 xs-change-b
mv "$xs_p2/.pipeline/terminal-sessions/other-name-0007.json" "$xs_p2/.pipeline/terminal-sessions/session-mismatch-0008.json"
xs_assert_eq "session-resolve: session_id 与文件名不符的绑定文件不算别人已绑定 → 回退指针" xs-change-b "$(xs_resolve "$xs_p2" "$XS_SID_NEW")"
rm -f "$xs_p2/.pipeline/terminal-sessions/session-mismatch-0008.json"
xs_bind "$xs_p2" session-real-0009 xs-change-b
xs_assert_eq "session-resolve: 合法的他会话绑定让新 id 判为无任务" NONE "$(xs_resolve "$xs_p2" "$XS_SID_NEW")"

# 绑定文件数超过扫描上限：无法证明没人绑定，保守返回无任务。
xs_p3="$(xs_project xs-scan-cap)"
rm -f "$xs_p3/.pipeline/terminal-sessions/$XS_SID_B.json"
set_active "$xs_p3" xs-change-b
for xs_i in $(seq 1 1100); do printf 'garbage' > "$xs_p3/.pipeline/terminal-sessions/g$xs_i.json"; done
xs_assert_eq "session-resolve: 绑定文件超过扫描上限 → 保守返回无任务" NONE "$(xs_resolve "$xs_p3" "$XS_SID_NEW")"

# 红线：解析全程纯 bash，可执行行里没有 node / jq / python。
xs_exec="$(grep -vE '^[[:space:]]*#' "$ROOT/hooks/active-change.sh")"
for xs_tool in node jq python; do
  n="$(printf '%s' "$xs_exec" | grep -c "$xs_tool" || true)"
  [ "$n" = "0" ] && ok "红线: active-change.sh 可执行行无 ${xs_tool}（会话解析走热路径）" || bad "红线: active-change.sh 可执行行无 ${xs_tool}" "实得 ${n} 行"
done
```

- [ ] **Step 2: 运行确认失败**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: FAIL，新增用例变红，例如 `FAIL - session-resolve: 会话 B 取自己绑定的 Change B（共享指针指向 A 也不借用）` 附 `期望「xs-change-b」，实得「NONE」`（函数尚未定义，`bash -c` 里 `pipeline_session_change_dir` 报 command not found，被打印成 NONE）；末行 `N passed, M failed`，退出码非零。原有用例仍通过。

- [ ] **Step 3: 写最小实现**

`hooks/active-change.sh` 头部注释（第 1-9 行）末尾追加一段：

```bash
#
# 共享指针按用户共享：并行会话谁最后 `tenon session activate` 谁就是指针。拦截、代为确认与记证据的 hook
# 因此不能直接用 pipeline_active_change_dir，而要用本文件的 pipeline_session_change_dir：它先看本会话自己的
# 会话绑定（.pipeline/terminal-sessions/<id>.json），只有宿主没给 session_id、或指针指向的 Change 无人绑定时
# 才回退指针。pipeline_active_change_dir 保留给只做「恢复候选」的 router / breadcrumb。
```

在文件末尾（`pipeline_active_change_dir` 之后）追加：

```bash

if ! declare -F pipeline_json_get_string >/dev/null 2>&1; then
  _TENON_ACTIVE_JSON_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
  # shellcheck source=json-input.sh
  [ -r "$_TENON_ACTIVE_JSON_HELPER" ] && . "$_TENON_ACTIVE_JSON_HELPER"
fi

if ! declare -F pipeline_host_session_change_name >/dev/null 2>&1; then
  _TENON_ACTIVE_BINDING_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/host-session-binding.sh"
  # shellcheck source=host-session-binding.sh
  [ -r "$_TENON_ACTIVE_BINDING_HELPER" ] && . "$_TENON_ACTIVE_BINDING_HELPER"
fi

# 会话绑定目录只增不删，热路径不能随它线性变慢。超过上限就无法证明「没有别的会话绑定它」，
# 保守按「已被别的会话绑定」处理（本会话判为没有任务：不拦、不代确认、不记证据）。
PIPELINE_SESSION_SCAN_MAX=1024

# 宿主 session_id 能不能当文件名与绑定键用：只认字母数字与 _-，长度 1-128（与 host-session-binding.sh 同一契约）。
pipeline_valid_session_id() { # $1=candidate session id → 0=usable as a binding key
  case "${1:-}" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}

# 各 hook 取会话 id 的唯一入口：打印通过校验的 id；宿主没给或不合法打印空（始终返回 0，调用方按空处理）。
pipeline_hook_session_id() { # $1=hook input JSON → host session id on stdout, empty when absent or illegal
  local id
  id="$(pipeline_json_get_string "${1:-}" session_id || true)"
  pipeline_valid_session_id "$id" && printf '%s' "$id"
  return 0
}

# 0 = 另一个会话已绑定 $2 这个 Change（或绑定数量多到无法证明没有）。
# 纯 bash、无 fork：每个文件只做一次有界读取（≤4096 字符）与字符串判定；符号链接、超大、损坏、
# session_id 与文件名不符、协议名不对的文件都不算绑定。
_pipeline_change_bound_to_other_session() { # $1=root $2=change name $3=this session id
  local dir="$1/.pipeline/terminal-sessions" change="$2" own="$3" file base body count=0
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  for file in "$dir"/*.json; do
    count=$((count + 1))
    [ "$count" -le "$PIPELINE_SESSION_SCAN_MAX" ] || return 0
    [ -f "$file" ] && [ ! -L "$file" ] && [ -r "$file" ] || continue
    base="${file##*/}"
    base="${base%.json}"
    [ "$base" != "$own" ] || continue
    pipeline_valid_session_id "$base" || continue
    body=''
    IFS= read -r -d '' -n 4097 body < "$file" || true
    [ "${#body}" -le 4096 ] || continue
    case "$body" in *"\"$change\""*) ;; *) continue ;; esac
    [ "$(pipeline_json_get_string "$body" protocol || true)" = 'pipeline-terminal-session-v1' ] || continue
    [ "$(pipeline_json_get_string "$body" session_id || true)" = "$base" ] || continue
    [ "$(pipeline_json_get_string "$body" change || true)" = "$change" ] || continue
    return 0
  done
  return 1
}

# 本会话任务：所有拦截、代为确认与记证据的 hook 的唯一解析（router / breadcrumb 只做恢复候选，不用它）。
#   1. 有合法 session_id 且有本会话绑定 → 绑定的 Change；
#   2. 有合法 session_id、无本会话绑定，而共享指针指向的 Change 已被别的会话绑定 → 无（返回 1）；
#   3. 其余（没给 / 不合法的 session_id；指针指向的 Change 无人绑定）→ 共享指针（旧行为）。
# 调用方须先 source canonical-state.sh（pipeline_state_source / pipeline_state_get）。
pipeline_session_change_dir() { # $1=verified project root $2=host session id → Change dir on stdout; status 1 = none
  local root="${1:-}" session_id="${2:-}" bound pointer name
  [ -n "$root" ] && [ -d "$root/openspec/changes" ] || return 1
  if pipeline_valid_session_id "$session_id" \
    && declare -F pipeline_host_session_change_name >/dev/null 2>&1 \
    && declare -F pipeline_json_get_string >/dev/null 2>&1; then
    bound="$(pipeline_host_session_change_name "$root" "$session_id" || true)"
    if [ -n "$bound" ]; then
      printf '%s' "$root/openspec/changes/$bound"
      return 0
    fi
    pointer="$(pipeline_active_change_dir "$root" || true)"
    [ -n "$pointer" ] || return 1
    name="${pointer##*/}"
    _pipeline_change_bound_to_other_session "$root" "$name" "$session_id" && return 1
    printf '%s' "$pointer"
    return 0
  fi
  pipeline_active_change_dir "$root"
}
```

- [ ] **Step 4: 运行确认通过**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: 没有 `FAIL` 行；末行 `N passed, 0 failed`，退出码 0。

- [ ] **Step 5: Commit**

```bash
git add hooks/active-change.sh tools/test-hooks.sh
git commit -m "feat(hooks): resolve the conversation's own Change from its host-session binding" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 评审标记、技能顺序门、动画门与 router 确认提示按会话解析

**前置条件：** 改动 `tools/test-hooks.sh` 里的动画门夹具前，执行者须先在当前步加载 `tenon:gsap-core`（动画门要求）。

**Files:**
- Modify: `hooks/review-ack.sh:82-97`（`pipeline_review_active_change_name` 与注释）、`hooks/review-ack.sh:99-119`（`pipeline_acknowledge_active_review`）
- Modify: `hooks/gate.sh:385-404`（评审标记归属）、`:510-524`（交互 / 评审 marker 循环，本 Task 只动评审相关注释，不动逻辑）、`:569-587`（技能顺序门）、`:619-631`（动画门）
- Modify: `hooks/router.sh:196-203` 与 `:262-267`（`router_confirms_open_review` 与它的注释）
- Modify: `tools/test-hooks.sh`（§15 追加 15b）
- Test: `tools/test-hooks.sh`

**Interfaces:**
- Consumes: Task 1 的 `pipeline_session_change_dir`、`pipeline_hook_session_id`。
- Produces:
  - `pipeline_review_active_change_name <root> <hook_dir> [session_id]`：第 3 参可选；缺省或为空回退共享指针（`statusline.sh:66`、`session-start.sh:147` 两个 2 参调用方行为不变）。
  - `pipeline_acknowledge_active_review <root> <hook_dir> [manual|delegated] [host_session]`：第 4 参同时用于解析本会话任务（manual 与 delegated 都按会话解析），delegated 仍要求它是合法 id。

- [ ] **Step 1: 写失败测试**

在 §15 末尾（汇总行之前）追加：

```bash
# ── 15b. 评审标记 / 技能顺序门 / 动画门 / router 确认提示：按会话解析 ──
xs_run_gate_in() { # $1=项目根 $2=session id（可空）$3=tool 名 → 设 RC / ERR
  local sid_field=''
  [ -n "$2" ] && sid_field=",\"session_id\":\"$2\""
  run_gate "{\"cwd\":\"$1\"${sid_field},\"tool_name\":\"$3\"}"
}
xs_p="$(xs_project xs-gate-review)"
write_v2_review_marker "$xs_p" xs-change-a spec
xs_run_gate_in "$xs_p" "$XS_SID_A" Write
assert_exit "gate: 会话 A 的评审标记拦会话 A（写类工具）" 2 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_B" Write
assert_exit "gate: 会话 A 的评审标记不拦会话 B（写类工具）" 0 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_B" Bash
assert_exit "gate: 会话 A 的评审标记不拦会话 B（Bash）" 0 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_NEW" Write
assert_exit "gate: 恢复后的新 id 无绑定、指针指向的 A 属于别的会话 → 不拦" 0 "$RC"
xs_run_gate_in "$xs_p" "" Write
assert_exit "gate: 宿主没给 session_id → 旧行为，共享指针指向 A → 拦" 2 "$RC"

# 技能顺序门与动画门委托 CLI 判定：用 node 替身记录它拿到的 Change 名，证明解析按会话而不是按共享指针。
XS_PLUGIN="$TMP/xs-plugin"; XS_NODE_SHIM="$TMP/xs-node-shim"; XS_NODE_LOG="$TMP/xs-node.log"
mkdir -p "$XS_PLUGIN/packages/cli/dist" "$XS_PLUGIN/skills" "$XS_NODE_SHIM"
printf '// placeholder bundle\n' > "$XS_PLUGIN/packages/cli/dist/tenon.mjs"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$XS_NODE_LOG"\ncat >/dev/null 2>&1 || true\nexit 0\n' > "$XS_NODE_SHIM/node"
chmod +x "$XS_NODE_SHIM/node"
xs_gate_node() { # $1=stdin-json → 设 RC；node 替身的调用参数写入 XS_NODE_LOG
  rm -f "$XS_NODE_LOG"
  printf '%s' "$1" | env -u TENON_AFK PATH="$XS_NODE_SHIM:$PATH" XS_NODE_LOG="$XS_NODE_LOG" PLUGIN_ROOT="$XS_PLUGIN" bash "$GATE" >/dev/null 2>&1
  RC=$?
}
xs_p="$(xs_project xs-gate-node)"
xs_skill_input() { printf '{"cwd":"%s","session_id":"%s","tool_name":"Skill","tool_input":{"skill":"tenon:xs-skill"}}' "$1" "$2"; }
xs_gate_node "$(xs_skill_input "$xs_p" "$XS_SID_B")"
assert_contains "gate 技能顺序门: 会话 B 按 Change B 判定（共享指针指向 A）" "$(cat "$XS_NODE_LOG" 2>/dev/null)" "internal-skill-gate xs-change-b tenon:xs-skill"
assert_not_contains "gate 技能顺序门: 会话 B 不碰 Change A" "$(cat "$XS_NODE_LOG" 2>/dev/null)" "xs-change-a"
xs_gate_node "$(xs_skill_input "$xs_p" "$XS_SID_A")"
assert_contains "gate 技能顺序门: 会话 A 按 Change A 判定" "$(cat "$XS_NODE_LOG" 2>/dev/null)" "internal-skill-gate xs-change-a tenon:xs-skill"
xs_gate_node "$(xs_skill_input "$xs_p" "$XS_SID_NEW")"
assert_empty "gate 技能顺序门: 恢复后无绑定的会话没有任务，不委托 CLI" "$(cat "$XS_NODE_LOG" 2>/dev/null)"
xs_gate_node "{\"cwd\":\"$xs_p\",\"tool_name\":\"Skill\",\"tool_input\":{\"skill\":\"tenon:xs-skill\"}}"
assert_contains "gate 技能顺序门: 宿主没给 session_id → 旧行为按共享指针（A）判定" "$(cat "$XS_NODE_LOG" 2>/dev/null)" "internal-skill-gate xs-change-a tenon:xs-skill"
xs_motion_input() { printf '{"cwd":"%s","session_id":"%s","tool_name":"Write","tool_input":{"file_path":"a.ts","content":"gsap.to(box)"}}' "$1" "$2"; }
xs_gate_node "$(xs_motion_input "$xs_p" "$XS_SID_B")"
assert_contains "gate 动画门: 会话 B 按 Change B 判定" "$(cat "$XS_NODE_LOG" 2>/dev/null)" "internal-motion-gate xs-change-b"
xs_gate_node "$(xs_motion_input "$xs_p" "$XS_SID_NEW")"
assert_empty "gate 动画门: 恢复后无绑定的会话不委托 CLI" "$(cat "$XS_NODE_LOG" 2>/dev/null)"

# router：「恢复后无绑定」或别的会话的回复，不被告知「本条回复是对 A 的评审确认」。
if command -v node >/dev/null 2>&1; then
  xs_p="$(xs_project xs-router)"
  write_v2_review_marker "$xs_p" xs-change-a spec
  run_router "{\"prompt\":\"按推荐\",\"cwd\":\"$xs_p\",\"session_id\":\"$XS_SID_A\"}"
  assert_contains "router: 会话 A（绑定 Change A）回「按推荐」→ 告知本条回复确认 A 的待决评审" "$ROUT" "本条回复就是对 xs-change-a 待决评审的确认"
  run_router "{\"prompt\":\"按推荐\",\"cwd\":\"$xs_p\",\"session_id\":\"$XS_SID_NEW\"}"
  assert_not_contains "router: 恢复后无绑定的会话不被告知回复是对 A 的评审确认" "$ROUT" "本条回复就是对 xs-change-a 待决评审的确认"
  run_router "{\"prompt\":\"按推荐\",\"cwd\":\"$xs_p\",\"session_id\":\"$XS_SID_B\"}"
  assert_not_contains "router: 会话 B 的回复不被告知是对 A 的评审确认" "$ROUT" "本条回复就是对 xs-change-a 待决评审的确认"
else
  ok "router 会话保护用例（缺 node，按约定跳过）"
fi
```

- [ ] **Step 2: 运行确认失败**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: FAIL，至少以下变红：`gate: 会话 A 的评审标记不拦会话 B（写类工具）`（实得 exit 2，期望 0）、`gate 技能顺序门: 会话 B 按 Change B 判定`（日志里是 `xs-change-a`）、`gate 动画门: 会话 B 按 Change B 判定`、`router: 会话 B 的回复不被告知是对 A 的评审确认`。

- [ ] **Step 3: 写最小实现**

`hooks/review-ack.sh`：把第 82-97 行（注释与 `pipeline_review_active_change_name`）整体替换为：

```bash
# 共享指针（.tenon/users/<slug>/local/active-change）是「按用户」的恢复候选，不是「按会话」的选择：并行会话共用它，
# 最后一个 activate 的会话改写它。root 级标记只对本会话自己的任务有意义，所以本会话任务要经宿主 session_id 对应
# 的会话绑定解析（pipeline_session_change_dir）；不带 session id 的调用方（statusline、session-start）回退共享指针。
pipeline_review_active_change_name() { # $1=verified project root $2=hook directory [$3=host session id]
  local root="$1" hook_dir="$2" session_id="${3:-}" state_helper active_helper dir
  [ -n "$root" ] && [ -d "$root" ] || return 1
  state_helper="$hook_dir/canonical-state.sh"
  active_helper="$hook_dir/active-change.sh"
  [ -r "$state_helper" ] && [ -r "$active_helper" ] || return 1
  # shellcheck source=canonical-state.sh
  . "$state_helper"
  # shellcheck source=active-change.sh
  . "$active_helper"
  dir="$(pipeline_session_change_dir "$root" "$session_id" || true)"
  [ -n "$dir" ] || return 1
  printf '%s' "${dir##*/}"
}
```

同文件 `pipeline_acknowledge_active_review`（第 99-119 行）替换为：

```bash
# Return success only when the v2 projection belongs to the conversation's own live Change and
# the stable CLI persisted the canonical approval receipt.  This function never deletes v2 marker
# files itself; `tenon review acknowledge` owns both the receipt and its projection.
# The host session id (4th argument, both modes) decides which Change is "this conversation's": a
# confirmation typed in another conversation can never acknowledge this one's review, and vice versa.
pipeline_acknowledge_active_review() { # $1=root $2=hook directory [$3=manual|delegated] [$4=host session id]
  local root="$1" hook_dir="$2" mode="${3:-manual}" host_session="${4:-}" marker expected active
  marker="$root/.pipeline-pending-review"
  expected="$(pipeline_review_marker_change "$marker" || true)"
  [ -n "$expected" ] || return 1
  active="$(pipeline_review_active_change_name "$root" "$hook_dir" "$host_session" || true)"
  [ -n "$active" ] && [ "$active" = "$expected" ] || return 1
  command -v tenon >/dev/null 2>&1 || return 1
  case "$mode" in
    delegated)
      case "$host_session" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
      [ "${#host_session}" -le 128 ] || return 1
      ( cd "$root" && TENON_HOST_SESSION_ID="$host_session" command tenon review acknowledge "$active" --delegated ) >/dev/null 2>&1
      ;;
    manual) ( cd "$root" && command tenon review acknowledge "$active" ) >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
```

`hooks/gate.sh`：

(a) 第 385-389 行注释末句改为：`# review in another conversation cannot lock unrelated normal dialogue.` 之前加一句 `# 「explicitly selected Change」按宿主 session_id 解析（本会话自己的任务），不是共享指针。`；第 402 行：

```bash
  active_change="$(pipeline_review_active_change_name "$TENON_ROOT" "$HOOK_DIR" || true)"
```
改为
```bash
  active_change="$(pipeline_review_active_change_name "$TENON_ROOT" "$HOOK_DIR" "$(json_get session_id || true)" || true)"
```

(b) 第 582 行（技能顺序门，`pipeline_enforce_skill_gate` 内）：

```bash
    sg_change_dir="$(pipeline_active_change_dir "$sg_proot" || true)"
```
改为
```bash
    sg_change_dir="$(pipeline_session_change_dir "$sg_proot" "$(pipeline_hook_session_id "$INPUT")" || true)"
```
第 574-575 行注释改为：`# 与其它 hook 共用已验证的项目根，并按宿主 session_id 解析本会话自己的任务，避免跨项目、按 mtime 或借用共享指针把 Skill DAG 错绑到别的会话的 Change。没有已选择 target 时不猜测，入口 skill 会在选定/创建后先 activate。`

(c) 第 627 行（动画门，`pipeline_enforce_motion_gate` 内）：

```bash
    mg_change_dir="$(pipeline_active_change_dir "$mg_proot" || true)"
```
改为
```bash
    mg_change_dir="$(pipeline_session_change_dir "$mg_proot" "$(pipeline_hook_session_id "$INPUT")" || true)"
```

`hooks/router.sh`：把 `router_confirms_open_review` 整个函数（第 196-203 行）替换为：

```bash
  router_confirms_open_review() { # $1=change $2=canonical phase → 0=prompt approves its open review
    local intent mine
    declare -F pipeline_review_receipt_open >/dev/null 2>&1 || return 1
    pipeline_prompt_rejects_resume "$PROMPT" && return 1
    intent="$(pipeline_prompt_approval_intent "$PROMPT" 2>/dev/null || true)"
    case "$intent" in confirm|contextual-confirm) ;; *) return 1 ;; esac
    # 回复只可能确认「本会话任务」的评审（与 confirm-clear-prompt 同一解析）：恢复后无绑定的会话、或共享指针指向别的会话
    # 任务时，不得被告知「本条回复是对 ${1} 的评审确认」——那条回执不会被写。宿主没给 session id 时保持旧行为。
    if [ -n "$HOST_SESSION_ID" ] && declare -F pipeline_session_change_dir >/dev/null 2>&1; then
      mine="$(pipeline_session_change_dir "$PROOT" "$HOST_SESSION_ID" || true)"
      [ "${mine##*/}" = "$1" ] || return 1
    fi
    pipeline_review_receipt_open "$PROOT" "$1" "$2"
  }
```
并把第 266-267 行注释（`--host-session).  confirm-clear-prompt acknowledges the same receipt through the same` / `per-user pointer, so both hooks agree on which Change the confirmation belongs to.`）改为：

```bash
    # --host-session).  confirm-clear-prompt acknowledges the same receipt through the same
    # per-conversation resolution (pipeline_session_change_dir), so both hooks agree on which Change the confirmation belongs to.
```

- [ ] **Step 4: 运行确认通过**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: 没有 `FAIL`；`N passed, 0 failed`。原有 gate / router 用例（无 session_id 或无绑定）全部沿用旧行为。

- [ ] **Step 5: Commit**

```bash
git add hooks/review-ack.sh hooks/gate.sh hooks/router.sh tools/test-hooks.sh
git commit -m "fix(hooks): block, acknowledge and gate skills against the conversation's own Change" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 记证据的 hook 按会话解析（skill-tracker / skill-start / codex-skill-receipt / decision-recorder / test-nudge）

**Files:**
- Modify: `hooks/skill-tracker.sh:86`、`hooks/skill-start.sh:48`、`hooks/codex-skill-receipt.sh:70`、`hooks/decision-recorder.sh:91`、`hooks/test-nudge.sh:34`（各一行）
- Modify: `tools/test-hooks.sh`（§15 追加 15c）
- Test: `tools/test-hooks.sh`

**Interfaces:**
- Consumes: Task 1 的 `pipeline_session_change_dir`、`pipeline_hook_session_id`；五个 hook 各自已有的 `INPUT` 变量与已 source 的 `canonical-state.sh`、`json-input.sh`、`active-change.sh`。
- Produces: 无新函数；五个 hook 的 Change 解析统一为本会话任务。

- [ ] **Step 1: 写失败测试**

§15 末尾追加：

```bash
# ── 15c. 记证据的 hook：证据只写本会话任务，新 id 什么都不写 ──
xs_hist() { printf '%s/openspec/changes/%s/.pipeline-history.jsonl' "$1" "$2"; }
xs_p="$(xs_project xs-evidence)"
xs_skill_payload() { printf '{"cwd":"%s","session_id":"%s","tool_name":"Skill","tool_input":{"skill":"superpowers:brainstorming"}}' "$1" "$2"; }
printf '%s' "$(xs_skill_payload "$xs_p" "$XS_SID_B")" | bash "$ST" >/dev/null 2>&1
assert_contains "skill-tracker: 会话 B 加载技能 → 证据写进 Change B" "$(cat "$(xs_hist "$xs_p" xs-change-b)" 2>/dev/null)" 'Skill: superpowers:brainstorming'
[ ! -f "$(xs_hist "$xs_p" xs-change-a)" ] && ok "skill-tracker: 会话 B 的证据没有串进共享指针指向的 Change A" || bad "skill-tracker: 会话 B 的证据没有串进共享指针指向的 Change A" "A 的历史被写入"
rm -f "$(xs_hist "$xs_p" xs-change-b)"
printf '%s' "$(xs_skill_payload "$xs_p" "$XS_SID_NEW")" | bash "$ST" >/dev/null 2>&1
{ [ ! -f "$(xs_hist "$xs_p" xs-change-a)" ] && [ ! -f "$(xs_hist "$xs_p" xs-change-b)" ]; } \
  && ok "skill-tracker: 恢复后无绑定的会话不记证据" || bad "skill-tracker: 恢复后无绑定的会话不记证据" "有历史被写入"
printf '%s' "{\"cwd\":\"$xs_p\",\"tool_name\":\"Skill\",\"tool_input\":{\"skill\":\"superpowers:brainstorming\"}}" | bash "$ST" >/dev/null 2>&1
assert_contains "skill-tracker: 宿主没给 session_id → 旧行为记进共享指针指向的 Change A" "$(cat "$(xs_hist "$xs_p" xs-change-a)" 2>/dev/null)" 'Skill: superpowers:brainstorming'
rm -f "$(xs_hist "$xs_p" xs-change-a)"

printf '%s' "$(xs_skill_payload "$xs_p" "$XS_SID_B")" | bash "$SKILL_START" >/dev/null 2>&1
assert_contains "skill-start: 会话 B 的开始标记写进 Change B" "$(cat "$(xs_hist "$xs_p" xs-change-b)" 2>/dev/null)" '"kind":"tool-start"'
[ ! -f "$(xs_hist "$xs_p" xs-change-a)" ] && ok "skill-start: 会话 B 的开始标记不写 Change A" || bad "skill-start: 会话 B 的开始标记不写 Change A" "A 的历史被写入"
rm -f "$(xs_hist "$xs_p" xs-change-b)"
printf '%s' "$(xs_skill_payload "$xs_p" "$XS_SID_NEW")" | bash "$SKILL_START" >/dev/null 2>&1
{ [ ! -f "$(xs_hist "$xs_p" xs-change-a)" ] && [ ! -f "$(xs_hist "$xs_p" xs-change-b)" ]; } \
  && ok "skill-start: 恢复后无绑定的会话不记开始标记" || bad "skill-start: 恢复后无绑定的会话不记开始标记" "有历史被写入"

xs_ask_payload() { printf '{"cwd":"%s","session_id":"%s","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"走哪条路？","header":"路线"}]},"tool_response":{"answers":{"路线":"tenon"}}}' "$1" "$2"; }
printf '%s' "$(xs_ask_payload "$xs_p" "$XS_SID_B")" | bash "$DR" >/dev/null 2>&1
assert_contains "decision-recorder: 会话 B 的提问记进 Change B" "$(cat "$(xs_hist "$xs_p" xs-change-b)" 2>/dev/null)" 'HostInteractionRecorded'
[ ! -f "$(xs_hist "$xs_p" xs-change-a)" ] && ok "decision-recorder: 会话 B 的提问不记进 Change A" || bad "decision-recorder: 会话 B 的提问不记进 Change A" "A 的历史被写入"
rm -f "$(xs_hist "$xs_p" xs-change-b)"
printf '%s' "$(xs_ask_payload "$xs_p" "$XS_SID_NEW")" | bash "$DR" >/dev/null 2>&1
{ [ ! -f "$(xs_hist "$xs_p" xs-change-a)" ] && [ ! -f "$(xs_hist "$xs_p" xs-change-b)" ]; } \
  && ok "decision-recorder: 恢复后无绑定的会话不记提问" || bad "decision-recorder: 恢复后无绑定的会话不记提问" "有历史被写入"

# test-nudge：冻结计划在 Change B 里；会话 B 被提醒登记 Change B 的测试，会话 A / 新 id 零输出。
printf 'track: backend\nphase: build\nworkflow: tested\n' > "$xs_p/openspec/changes/xs-change-b/.pipeline.yaml"
printf '%s' '{"name":"tested","steps":[{"id":"build","label":"构建","gate":null,"tests":[{"id":"unit","direction":"unit","command":"npm test","cwd":".","timeout_s":900}],"transitions":[]}]}' \
  > "$xs_p/openspec/changes/xs-change-b/.pipeline-workflow-plan.json"
xs_nudge() { printf '{"tool_name":"Bash","cwd":"%s","session_id":"%s","command":"npm test"}' "$1" "$2" | bash "$TN" 2>/dev/null; }
assert_contains "test-nudge: 会话 B 被提醒登记 Change B 的测试（共享指针指向 A）" "$(xs_nudge "$xs_p" "$XS_SID_B")" 'tenon test run xs-change-b unit'
assert_empty "test-nudge: 会话 A 的 Change 没有冻结计划 → 零输出" "$(xs_nudge "$xs_p" "$XS_SID_A")"
assert_empty "test-nudge: 恢复后无绑定的会话零输出" "$(xs_nudge "$xs_p" "$XS_SID_NEW")"

# codex-skill-receipt：node 替身记录它拿到的 Change 名。
xs_p="$(xs_project xs-codex-receipt)"
XS_CSR_LOG="$TMP/xs-codex-receipt.log"
xs_csr() { # $1=session id → 设日志
  rm -f "$XS_CSR_LOG"
  printf '%s' "{\"cwd\":\"$xs_p\",\"session_id\":\"$1\",\"turn_id\":\"turn-1\",\"tool_use_id\":\"tool-1\",\"transcript_path\":\"$TMP/xs-transcript.jsonl\",\"tool_name\":\"exec\",\"tool_input\":{\"cmd\":\"/bin/zsh -lc \\\"sed -n '1,120p' $ROOT/skills/tenon/SKILL.md\\\"\"}}" \
    | env PATH="$XS_NODE_SHIM:$PATH" XS_NODE_LOG="$XS_CSR_LOG" CLAUDE_PLUGIN_ROOT="$ROOT" bash "$ROOT/hooks/codex-skill-receipt.sh" >/dev/null 2>&1
}
xs_csr "$XS_SID_B"
assert_contains "codex-skill-receipt: 会话 B 的收据绑定 Change B" "$(cat "$XS_CSR_LOG" 2>/dev/null)" 'internal-codex-skill-receipt xs-change-b tenon'
assert_not_contains "codex-skill-receipt: 会话 B 的收据不绑定 Change A" "$(cat "$XS_CSR_LOG" 2>/dev/null)" 'xs-change-a'
xs_csr "$XS_SID_NEW"
assert_empty "codex-skill-receipt: 恢复后无绑定的会话不落收据" "$(cat "$XS_CSR_LOG" 2>/dev/null)"
```

- [ ] **Step 2: 运行确认失败**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: FAIL，例如 `FAIL - skill-tracker: 会话 B 加载技能 → 证据写进 Change B`（证据被写进了 A 的历史）、`FAIL - test-nudge: 会话 B 被提醒登记 Change B 的测试`、`FAIL - codex-skill-receipt: 会话 B 的收据绑定 Change B`。

- [ ] **Step 3: 写最小实现**

五个文件各有且仅有一行（行号即上面 Files 所列）：

```bash
CHANGE_DIR="$(pipeline_active_change_dir "$PROOT" || true)"
```

逐个改为（`hooks/skill-tracker.sh`、`hooks/skill-start.sh`、`hooks/codex-skill-receipt.sh`、`hooks/decision-recorder.sh`、`hooks/test-nudge.sh`）：

```bash
# 本会话任务（按宿主 session_id 解析）：并行会话各记各的 Change，证据不再串到共享指针指向的任务；
# 没有本会话任务（例如恢复后换了 id 尚未重新 activate）时什么都不记。
CHANGE_DIR="$(pipeline_session_change_dir "$PROOT" "$(pipeline_hook_session_id "$INPUT")" || true)"
```

注意五个文件的变量名都是 `INPUT`（hook 标准输入）与 `PROOT`，且都已在这一行之前 source 了 `json-input.sh`、`canonical-state.sh` 与 `active-change.sh`（`test-nudge.sh` 通过它的 helper 循环），无需新增 source。

- [ ] **Step 4: 运行确认通过**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: 没有 `FAIL`；`N passed, 0 failed`（含原有 10b / 10c / 10d2 用例：它们不带 session_id，走回退）。

- [ ] **Step 5: Commit**

```bash
git add hooks/skill-tracker.sh hooks/skill-start.sh hooks/codex-skill-receipt.sh hooks/decision-recorder.sh hooks/test-nudge.sh tools/test-hooks.sh
git commit -m "fix(hooks): record skill, decision and test evidence against the conversation's own Change" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: v2 交互标记（`pending-marker.sh`）、写入、归属拦截，并迁移旧格式夹具

**Files:**
- Create: `hooks/pending-marker.sh`
- Modify: `hooks/interactive-skill-gate.sh:103-156`（会话 id、会话解析、持续授权判定、写标记）
- Modify: `hooks/gate.sh:404` 之后新增函数；`:515-523`（interaction 归属判定）
- Modify: `hooks/confirm-clear-prompt.sh`（仅释放块里读技能名的三处，使 v2 标记下 InteractionConfirmed 仍能记账；Task 6 会整体重写该文件）
- Modify: `tools/test-hooks.sh`（新增夹具 `write_v2_interaction_marker`、迁移旧用例、§15 追加 15d）
- Modify: `tools/test-adapters.sh`（新增同名夹具、迁移 5 处）
- Test: `tools/test-hooks.sh`、`tools/test-adapters.sh`

**Interfaces:**
- Consumes: Task 1 的 `pipeline_session_change_dir`、`pipeline_hook_session_id`。
- Produces（均在 `hooks/pending-marker.sh`，source-only）：
  - `TENON_INTERACTION_MARKER_PROTOCOL='pipeline-interaction-v2'`
  - `pipeline_write_interaction_marker <root> <change> <session> <skills>`：同目录临时文件 + `mv -f` 原子写 `<root>/.pipeline-pending-interaction`；非法 change / session 字符按空处理；失败返回 1。
  - `pipeline_interaction_marker_owned <marker> <root> <session>`：0 = 归本会话；1 = 不归；旧格式（含空文件、符号链接、损坏）删除标记并返回 1。
  - `pipeline_interaction_marker_skills <marker>`：打印 `skills=` 的值。
  - `pipeline_claim_interaction_marker <root> <session> <claim-path>`：归属本会话才原子认领（`mv` 到 claim 路径），认领后复核归属，不归则尽量放回；0 = 已认领（文件现在在 claim 路径）。（设计只列前两个函数；认领把「检查归属 + 原子占有」收进同一模块，供 CC / CP 共用。）

- [ ] **Step 1: 写失败测试**

(1) 在 `tools/test-hooks.sh` 的 `write_v2_review_marker` 函数结束的 `}` 之后（`# 前置：被测文件必须存在` 注释之前）新增夹具：

```bash
# v2 交互标记夹具：$1=项目根 [$2=change] [$3=session] [$4=skills]。change 与 session 都为空 = 归属全部会话，
# 即旧格式时代大多数用例依赖的行为（宿主不给 session_id 时的旧语义）。
write_v2_interaction_marker() {
  printf 'pipeline-interaction-v2\nchange=%s\nsession=%s\nskills=%s\nrequested_at=2026-10-07T00:00:00Z\n' \
    "${2:-}" "${3:-}" "${4:-fixture-skill}" > "$1/.pipeline-pending-interaction"
}
```

(2) 迁移旧用例（旧格式标记现在会被删除且不拦截，这些用例要的是「拦所有会话」的标记）：

- `tools/test-hooks.sh`：用 Edit 的 `replace_all`，把字符串 `touch "$proj/.pipeline-pending-interaction"` 全部替换为 `write_v2_interaction_marker "$proj"`（覆盖原 187、196、285、495、1935、1961、1973、2040、2048、2514 行；495 行形如 `touch "$proj/.pipeline-pending-interaction"; touch_age …`，替换后仍先写标记再调 mtime）。
- 同文件原 1926 行 `touch "$proj/.pipeline-pending-confirm" "$proj/.pipeline-pending-interaction"` 改为 `touch "$proj/.pipeline-pending-confirm"; write_v2_interaction_marker "$proj"`。
- 原 2064 行 `printf 'tenon:brainstorming\n' > "$proj/.pipeline-pending-interaction"` 改为 `write_v2_interaction_marker "$proj" '' '' 'tenon:brainstorming'`。
- 原 2100 行 `printf 'tenon:dup-skill\n' > "$proj/.pipeline-pending-interaction"` 改为 `write_v2_interaction_marker "$proj" '' '' 'tenon:dup-skill'`。
- `tools/test-adapters.sh`：在 `write_v2_review_marker` 函数结束的 `}`（约 181 行）之后新增：

```bash
write_v2_interaction_marker() { # <project root>：归属全部会话的 v2 交互标记（change 与 session 都为空）
  printf 'pipeline-interaction-v2\nchange=\nsession=\nskills=fixture-skill\nrequested_at=2026-10-07T00:00:00Z\n' \
    > "$1/.pipeline-pending-interaction"
}
```
然后 `replace_all` 把 `touch "$p/.pipeline-pending-interaction"` 全部替换为 `write_v2_interaction_marker "$p"`（原 230、617、771、866、920 行）。

(3) §15 追加：

```bash
# ── 15d. 交互标记 v2：写入、归属、旧格式退役、并发覆盖 ──
xs_p="$(xs_project xs-marker)"
xs_ig_input() { printf '{"cwd":"%s","session_id":"%s","tool_name":"Skill","tool_input":{"skill":"superpowers:brainstorming"}}' "$1" "$2"; }
printf '%s' "$(xs_ig_input "$xs_p" "$XS_SID_A")" | bash "$IG" >/dev/null 2>&1
xs_marker="$(cat "$xs_p/.pipeline-pending-interaction" 2>/dev/null)"
assert_contains "interactive-skill-gate: 标记首行是协议名" "$(printf '%s' "$xs_marker" | head -1)" 'pipeline-interaction-v2'
assert_contains "interactive-skill-gate: 标记记录会话 A" "$xs_marker" "session=$XS_SID_A"
assert_contains "interactive-skill-gate: 标记记录本会话任务 Change A" "$xs_marker" 'change=xs-change-a'
assert_contains "interactive-skill-gate: 标记记录技能显示名" "$xs_marker" 'skills=superpowers:brainstorming'
assert_contains "interactive-skill-gate: 标记记录请求时间" "$xs_marker" 'requested_at='
xs_run_gate_in "$xs_p" "$XS_SID_A" Write
assert_exit "gate: 会话 A 加载交互技能 → 会话 A 的写类工具被拦" 2 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_B" Write
assert_exit "gate: 会话 A 加载交互技能 → 会话 B 的写类工具放行" 0 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_NEW" Write
assert_exit "gate: 会话 A 的交互标记不拦恢复后无绑定的新会话" 0 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_A" AskUserQuestion
assert_exit "gate: 归属方仍可调用提问工具" 0 "$RC"
run_gate "{\"cwd\":\"$xs_p\",\"session_id\":\"$XS_SID_A\",\"agent_id\":\"sub-1\",\"tool_name\":\"Write\"}"
assert_exit "gate: 子代理（agent_id）豁免交互标记保持不变" 0 "$RC"
[ -f "$xs_p/.pipeline-pending-interaction" ] && ok "gate: 放行他会话与子代理不删除标记" || bad "gate: 放行他会话与子代理不删除标记" "标记被错误删除"

# 后写者整份替换先写者；不残留临时文件（fail-open：先写者不再被拦，transition 仍需回执）。
printf '%s' "$(xs_ig_input "$xs_p" "$XS_SID_B")" | bash "$IG" >/dev/null 2>&1
xs_marker="$(cat "$xs_p/.pipeline-pending-interaction" 2>/dev/null)"
assert_contains "interactive-skill-gate: 后写者（会话 B）整份替换标记" "$xs_marker" "session=$XS_SID_B"
assert_not_contains "interactive-skill-gate: 替换后不残留先写者（会话 A）的归属" "$xs_marker" "session=$XS_SID_A"
xs_run_gate_in "$xs_p" "$XS_SID_A" Write
assert_exit "gate: 已知限制：先写者（会话 A）被后写者替换后不再被拦（fail-open）" 0 "$RC"
xs_tmp_left="$(ls "$xs_p"/.pipeline-pending-interaction.tmp.* 2>/dev/null || true)"
assert_empty "interactive-skill-gate: 原子写不残留临时文件" "$xs_tmp_left"

# 没给 session_id 的写入：标记按本会话任务（共享指针 A）归属。
rm -f "$xs_p/.pipeline-pending-interaction"
printf '%s' "{\"cwd\":\"$xs_p\",\"tool_name\":\"Skill\",\"tool_input\":{\"skill\":\"superpowers:brainstorming\"}}" | bash "$IG" >/dev/null 2>&1
xs_marker="$(cat "$xs_p/.pipeline-pending-interaction" 2>/dev/null)"
assert_contains "interactive-skill-gate: 宿主没给 session_id → 标记带 change 不带 session" "$xs_marker" 'change=xs-change-a'
assert_contains "interactive-skill-gate: 宿主没给 session_id → session 为空" "$xs_marker" 'session='
assert_not_contains "interactive-skill-gate: 宿主没给 session_id → 不记会话" "$xs_marker" "session=$XS_SID_"
xs_run_gate_in "$xs_p" "" Write
assert_exit "gate: 无 session_id 的标记拦同样没给 id 的调用（旧行为）" 2 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_A" Write
assert_exit "gate: 带 change 不带 session 的标记拦任务为该 Change 的会话 A" 2 "$RC"
xs_run_gate_in "$xs_p" "$XS_SID_B" Write
assert_exit "gate: 带 change 不带 session 的标记不拦任务是别的 Change 的会话 B" 0 "$RC"

# 旧格式（空文件、只有技能名）见到即删除、不拦截。
rm -f "$xs_p/.pipeline-pending-interaction"
touch "$xs_p/.pipeline-pending-interaction"
xs_run_gate_in "$xs_p" "$XS_SID_A" Write
assert_exit "gate: 空文件旧格式标记不拦截" 0 "$RC"
[ ! -e "$xs_p/.pipeline-pending-interaction" ] && ok "gate: 空文件旧格式标记被删除" || bad "gate: 空文件旧格式标记被删除" "标记仍在"
printf 'tenon:brainstorming\n' > "$xs_p/.pipeline-pending-interaction"
xs_run_gate_in "$xs_p" "" Write
assert_exit "gate: 只有技能名的旧格式标记不拦截" 0 "$RC"
[ ! -e "$xs_p/.pipeline-pending-interaction" ] && ok "gate: 只有技能名的旧格式标记被删除" || bad "gate: 只有技能名的旧格式标记被删除" "标记仍在"

# 持续授权按会话解析：授权属于 Change B + 会话 B 时，会话 B 加载交互技能不落标记；会话 A 仍落标记。
xs_p="$(xs_project xs-ig-authority)"
mkdir -p "$(dirname "$(active_authority_path "$xs_p")")"
printf 'pipeline-interaction-authority-v2\nchange=xs-change-b\nhost_session=%s\nscope=interactive-skills\nreview=delegated\nissued_at=2026-10-07T00:00:00Z\n' "$XS_SID_B" \
  > "$(active_authority_path "$xs_p")"
printf '%s' "$(xs_ig_input "$xs_p" "$XS_SID_B")" | bash "$IG" >/dev/null 2>&1
[ ! -e "$xs_p/.pipeline-pending-interaction" ] && ok "interactive-skill-gate: 会话 B 的持续授权按本会话任务 B 判定（共享指针指向 A）→ 不落标记" || bad "interactive-skill-gate: 会话 B 的持续授权按本会话任务 B 判定 → 不落标记" "仍落了标记"
printf '%s' "$(xs_ig_input "$xs_p" "$XS_SID_A")" | bash "$IG" >/dev/null 2>&1
[ -f "$xs_p/.pipeline-pending-interaction" ] && ok "interactive-skill-gate: 授权属于 B，会话 A 照常落标记" || bad "interactive-skill-gate: 授权属于 B，会话 A 照常落标记" "未落标记"
rm -f "$xs_p/.pipeline-pending-interaction"

# 红线：标记模块纯 bash。
xs_exec="$(grep -vE '^[[:space:]]*#' "$ROOT/hooks/pending-marker.sh")"
for xs_tool in node jq python; do
  n="$(printf '%s' "$xs_exec" | grep -c "$xs_tool" || true)"
  [ "$n" = "0" ] && ok "红线: pending-marker.sh 可执行行无 ${xs_tool}" || bad "红线: pending-marker.sh 可执行行无 ${xs_tool}" "实得 ${n} 行"
done
```

- [ ] **Step 2: 运行确认失败**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: FAIL，例如 `FAIL - interactive-skill-gate: 标记首行是协议名`；迁移后的旧用例也会因为 `write_v2_interaction_marker` 写出的 v2 标记仍被旧 gate 当作任意文件而照常通过，所以红的主要是 §15 的 15d 用例（`bash: .../hooks/pending-marker.sh: No such file` 对应红线用例）。`bash tools/test-adapters.sh` 此时应仍全绿。

- [ ] **Step 3: 写最小实现**

新建 `hooks/pending-marker.sh`：

```bash
#!/usr/bin/env bash
# pending-marker.sh — source-only v2 `.pipeline-pending-interaction` marker.
#
# 项目根上只有这一个交互标记文件，而并行会话各自加载交互技能、各自提问。v2 标记因此记录归属，
# 门禁只拦归属方，AskUserQuestion / 放行语也只解归属本会话的标记：
#
#   pipeline-interaction-v2
#   change=<加载技能时本会话任务的 Change，可空>
#   session=<宿主 session_id，可空>
#   skills=<技能显示名，以 、 连接>
#   requested_at=<UTC ISO>
#
# 归属：session 非空 → 只属于该会话；session 为空而 change 非空 → 属于「本会话任务为该 Change」的会话；
# 两者皆空 → 属于全部会话（宿主不给 session_id 时的旧行为）。旧格式（首行不是协议名，含空文件）见到即删除、
# 不拦截。单文件结构下两个会话同时落标记时后写者整份替换先写者（fail-open，canonical 回执仍保护 transition）。
# 纯 bash：不 spawn 解释器；`.pipeline-pending-confirm` 没有写入方，不在本模块内。

TENON_INTERACTION_MARKER_PROTOCOL='pipeline-interaction-v2'

if ! declare -F pipeline_session_change_dir >/dev/null 2>&1; then
  _TENON_MARKER_ACTIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
  # shellcheck source=active-change.sh
  [ -r "$_TENON_MARKER_ACTIVE_HELPER" ] && . "$_TENON_MARKER_ACTIVE_HELPER"
fi

# 同目录临时文件 + 原子 rename：读者只会看到完整的一份，并发写后写者胜出。
pipeline_write_interaction_marker() { # $1=project root $2=change(可空) $3=session id(可空) $4=skills display names
  local root="${1:-}" change="${2:-}" session="${3:-}" skills="${4:-}" marker tmp stamp
  [ -n "$root" ] && [ -d "$root" ] || return 1
  case "$change" in *[!A-Za-z0-9_-]*) change='' ;; esac
  case "$session" in *[!A-Za-z0-9_-]*) session='' ;; esac
  skills="${skills//$'\r'/}"
  skills="${skills//$'\n'/、}"
  marker="$root/.pipeline-pending-interaction"
  tmp="$marker.tmp.$$"
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  printf '%s\nchange=%s\nsession=%s\nskills=%s\nrequested_at=%s\n' \
    "$TENON_INTERACTION_MARKER_PROTOCOL" "$change" "$session" "$skills" "$stamp" > "$tmp" 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$marker" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
}

# 0 = 归本会话；1 = 不归（旧格式：删除标记后返回 1）。读取上限 4096 字符。
pipeline_interaction_marker_owned() { # $1=marker path $2=verified project root $3=this conversation's session id
  local marker="${1:-}" root="${2:-}" session="${3:-}" body='' first line mchange='' msession='' mine
  if [ -f "$marker" ] && [ ! -L "$marker" ] && [ -r "$marker" ]; then
    IFS= read -r -d '' -n 4096 body < "$marker" 2>/dev/null || true
  fi
  first="${body%%$'\n'*}"
  if [ "$first" != "$TENON_INTERACTION_MARKER_PROTOCOL" ]; then
    rm -f "$marker" 2>/dev/null || true
    return 1
  fi
  while IFS= read -r line; do
    case "$line" in
      change=*) mchange="${line#change=}" ;;
      session=*) msession="${line#session=}" ;;
    esac
  done <<< "$body"
  if [ -n "$msession" ]; then
    [ "$msession" = "$session" ]
    return
  fi
  if [ -n "$mchange" ]; then
    mine="$(pipeline_session_change_dir "$root" "$session" || true)"
    [ "${mine##*/}" = "$mchange" ]
    return
  fi
  return 0
}

pipeline_interaction_marker_skills() { # $1=v2 marker path → skills= 的值（技能显示名以 、 连接）
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in skills=*) printf '%s' "${line#skills=}"; return 0 ;; esac
  done < "$1"
  return 1
}

# 认领归属本会话的标记：先看归属（不归就原样不动），再用原子 mv 占有；占有后复核刚移走的内容仍归本会话，
# 不归（检查与认领之间被别的会话替换）就放回。多份 hook 并发运行时只有 mv 成功的那一份认领到。
pipeline_claim_interaction_marker() { # $1=verified project root $2=session id $3=claim path → 0 = claimed (the marker now sits at $3)
  local marker="$1/.pipeline-pending-interaction" claim="$3"
  [ -e "$marker" ] || [ -L "$marker" ] || return 1
  pipeline_interaction_marker_owned "$marker" "$1" "$2" || return 1
  mv "$marker" "$claim" 2>/dev/null || return 1
  pipeline_interaction_marker_owned "$claim" "$1" "$2" && return 0
  mv -n "$claim" "$marker" 2>/dev/null || true
  rm -f "$claim" 2>/dev/null || true
  return 1
}
```

`chmod +x` 不需要（source-only，同 `host-session-binding.sh`）。

`hooks/interactive-skill-gate.sh`：把第 103-130 行（从 `HOST_SESSION_ID="$(json_get session_id || true)"` 起，到持续授权块 `fi` 止——即 `HOST_SESSION_ID` 三行、`ROOT=…` 块之后的 `AUTONOMOUS=0` … 授权块）替换为下面两段。先是会话 id 三行删掉并在 ROOT 解析之后统一取：

原文：

```bash
HOST_SESSION_ID="$(json_get session_id || true)"
case "$HOST_SESSION_ID" in ''|*[!A-Za-z0-9_-]*) HOST_SESSION_ID='' ;; esac
[ "${#HOST_SESSION_ID}" -le 128 ] || HOST_SESSION_ID=''
```
改为：

```bash
# 会话 id 由 active-change.sh 的 pipeline_hook_session_id 统一校验，下面 source 之后再取。
HOST_SESSION_ID=''
```

原文授权块：

```bash
AUTONOMOUS=0
ACTIVE_CHANGE=''
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
AUTHORITY_HELPER="$HOOK_DIR/interaction-authority.sh"
STATE_HELPER="$HOOK_DIR/canonical-state.sh"
ACTIVE_HELPER="$HOOK_DIR/active-change.sh"
if [ -n "$ROOT" ] && [ -d "$ROOT" ] && [ -r "$AUTHORITY_HELPER" ] && [ -r "$STATE_HELPER" ] && [ -r "$ACTIVE_HELPER" ]; then
  # shellcheck source=interaction-authority.sh
  . "$AUTHORITY_HELPER"
  # shellcheck source=canonical-state.sh
  . "$STATE_HELPER"
  # shellcheck source=active-change.sh
  . "$ACTIVE_HELPER"
  ACTIVE_DIR="$(pipeline_active_change_dir "$ROOT" || true)"
  ACTIVE_CHANGE="${ACTIVE_DIR##*/}"
  if [ -n "$ACTIVE_DIR" ] \
    && pipeline_interaction_authority_for_change "$ROOT" "$ACTIVE_CHANGE" "$HOST_SESSION_ID"; then
    AUTONOMOUS=1
  fi
fi
```
改为：

```bash
AUTONOMOUS=0
ACTIVE_CHANGE=''
ACTIVE_DIR=''
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
AUTHORITY_HELPER="$HOOK_DIR/interaction-authority.sh"
STATE_HELPER="$HOOK_DIR/canonical-state.sh"
ACTIVE_HELPER="$HOOK_DIR/active-change.sh"
MARKER_HELPER="$HOOK_DIR/pending-marker.sh"
if [ -n "$ROOT" ] && [ -d "$ROOT" ] && [ -r "$STATE_HELPER" ] && [ -r "$ACTIVE_HELPER" ]; then
  # shellcheck source=canonical-state.sh
  . "$STATE_HELPER"
  # shellcheck source=active-change.sh
  . "$ACTIVE_HELPER"
  HOST_SESSION_ID="$(pipeline_hook_session_id "$INPUT")"
  # 本会话任务（按宿主 session_id 解析）：持续授权与已确认记录都按它判定，不借用共享指针指向的别的会话的任务。
  ACTIVE_DIR="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
  ACTIVE_CHANGE="${ACTIVE_DIR##*/}"
  if [ -n "$ACTIVE_DIR" ] && [ -r "$AUTHORITY_HELPER" ]; then
    # shellcheck source=interaction-authority.sh
    . "$AUTHORITY_HELPER"
    if pipeline_interaction_authority_for_change "$ROOT" "$ACTIVE_CHANGE" "$HOST_SESSION_ID"; then
      AUTONOMOUS=1
    fi
  fi
fi
```

同文件落标记处（约第 152-155 行）：

```bash
if [ "$AUTONOMOUS" -eq 0 ]; then
  [ -n "$ROOT" ] && [ -d "$ROOT" ] && printf '%s\n' "$MATCHED_DISPLAY" > "$ROOT/.pipeline-pending-interaction" 2>/dev/null || true
fi
```
改为：

```bash
if [ "$AUTONOMOUS" -eq 0 ] && [ -n "$ROOT" ] && [ -d "$ROOT" ] && [ -r "$MARKER_HELPER" ]; then
  # shellcheck source=pending-marker.sh
  . "$MARKER_HELPER"
  pipeline_write_interaction_marker "$ROOT" "$ACTIVE_CHANGE" "$HOST_SESSION_ID" "$MATCHED_DISPLAY" || true
fi
```
文件头注释里「落 .pipeline-pending-interaction marker」后补一句：`marker 为 v2 格式（pending-marker.sh），带 change / session 归属，只拦归属方`。

`hooks/gate.sh`：在 `review_marker_relevant_to_active_change` 函数（第 390-404 行）之后新增：

```bash

# 交互标记 v2 只拦归属方（pending-marker.sh）：归属其它会话的标记不拦本会话；旧格式（含空文件）见到即删除、不拦截。
# helper 缺失按本文件 fail-open 总纲放行。
interaction_marker_relevant_to_session() { # $1=marker → 0=本会话被它拦
  local marker_helper="$HOOK_DIR/pending-marker.sh" active_helper="$HOOK_DIR/active-change.sh"
  [ -r "$marker_helper" ] && [ -r "$active_helper" ] || return 1
  # shellcheck source=active-change.sh
  . "$active_helper"
  # shellcheck source=pending-marker.sh
  . "$marker_helper"
  pipeline_interaction_marker_owned "$1" "$TENON_ROOT" "$(pipeline_hook_session_id "$INPUT")"
}
```
并在循环里（第 520-522 行 agent_id 豁免块之后、`if [ "$kind" = "review" ]; then` 之前）插入：

```bash
    if [ "$kind" = "interaction" ]; then
      interaction_marker_relevant_to_session "$m" || continue
    fi
```

`hooks/confirm-clear-prompt.sh`（Task 6 会整体重写；这里只让 v2 标记下 InteractionConfirmed 仍然记账，保证本 Task 结束时 `tools/test-hooks.sh` 全绿）：释放块里的

```bash
if [ -f "$INTERACTION_CLAIM" ] \
  && [ -r "$HOOK_DIR/canonical-state.sh" ] && [ -r "$HOOK_DIR/active-change.sh" ]; then
```
改为

```bash
if [ -f "$INTERACTION_CLAIM" ] \
  && [ -r "$HOOK_DIR/canonical-state.sh" ] && [ -r "$HOOK_DIR/active-change.sh" ] && [ -r "$HOOK_DIR/pending-marker.sh" ]; then
```
紧接着 `. "$HOOK_DIR/active-change.sh"` 之后新增两行：

```bash
  # shellcheck source=pending-marker.sh
  . "$HOOK_DIR/pending-marker.sh"
```
并把 `CONFIRMED_SKILLS="$(<"$INTERACTION_CLAIM")"` 改为 `CONFIRMED_SKILLS="$(pipeline_interaction_marker_skills "$INTERACTION_CLAIM")"`。

- [ ] **Step 4: 运行确认通过**

Run:
```bash
bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'
bash tools/test-adapters.sh 2>&1 | tail -3
bash tools/verify-skills.sh --quiet
```
Expected: 三条都通过——test-hooks `N passed, 0 failed`；test-adapters 末行无失败；verify-skills 无输出且退出码 0（它对 `hooks/pending-marker.sh` 做 `bash -n`）。

- [ ] **Step 5: Commit**

```bash
git add hooks/pending-marker.sh hooks/interactive-skill-gate.sh hooks/gate.sh hooks/confirm-clear-prompt.sh tools/test-hooks.sh tools/test-adapters.sh
git commit -m "feat(hooks): scope the interaction marker to the conversation that raised it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 放行语整条匹配（`pipeline_text_is_approval_phrase`）、答案值遍历 helper 与提示文案

**Files:**
- Modify: `hooks/prompt-intent.sh:332-365`（`pipeline_prompt_approval_intent` 之前新增函数；末段改整条匹配）
- Modify: `hooks/json-input.sh`（在 `pipeline_json_get_string_array` 之后新增 `pipeline_json_object_any_value`）
- Modify: `hooks/gate.sh:556`（提示文案）、`hooks/confirm-clear-prompt.sh:59`（提示文案）
- Modify: `tools/test-hooks.sh`（`intent_is` 与 6 条期望、§15 追加 15e）
- Modify: `packages/cli/src/terminal-activity-hook.integration.test.ts:188`
- Test: `tools/test-hooks.sh`、`tools/test-adapters.sh`、`packages/cli/src/terminal-activity-hook.integration.test.ts`

**Interfaces:**
- Consumes: 无新增依赖。
- Produces:
  - `pipeline_approval_phrase_class <text>`：整条等于清单中的一项时打印 `confirm`（显式放行语，不依赖待处理上下文）或 `contextual-confirm`（简短同意，只在有待处理标记时算数）并返回 0；否则返回 1。
  - `pipeline_text_is_approval_phrase <text>`：0 = 整条是放行语。
  - `pipeline_json_object_any_value <json> <key> <predicate-fn>`：遍历 `"<key>":{…}` 对象的字符串成员，对每个解码后的值调用 `<predicate-fn> <value>`，任一返回 0 即成功；key 缺失、不是对象、成员不是字符串、JSON 损坏一律失败。
  - `pipeline_prompt_approval_intent` 的 `confirm` / `contextual-confirm` 分支改用 `pipeline_approval_phrase_class`；拒绝 / 附条件 / 授权的判定顺序不变。

- [ ] **Step 1: 写失败测试**

(1) 改 `tools/test-hooks.sh` 的 `intent_is`（让 `none` 表示「不是放行」），原：

```bash
    [ "$actual" = "$2" ] \
      && ok "classifier: 「${label}」→ $2" \
      || bad "classifier: 「${label}」→ $2" "实际 intent=${actual:-<empty>}"
```
改为：

```bash
    local expected="$2"
    [ "$expected" != none ] || expected=''
    [ "$actual" = "$expected" ] \
      && ok "classifier: 「${label}」→ ${2}" \
      || bad "classifier: 「${label}」→ ${2}" "实际 intent=${actual:-<empty>}"
```
把原先期望 `confirm` 的四条长文本与两条带 `INTENT_PAD` 的断言改成 `none`（放行语夹在更长的文字里不再算）：

```bash
  intent_is '确认继续，按你的推荐执行。另外这个方案不错，但配色偏暗。' none
  intent_is '可以继续。顺便说一下，昨天那个问题很烦，但已经修好了。' none
  intent_is '继续执行。这个库很好用，不过文档差了点。' none
  intent_is '这个方案不错但一般。确认继续。' none
```
```bash
  intent_is "${INTENT_PAD}确认继续，按你的推荐执行。另外这个方案不错，但配色偏暗。" none
  intent_is "${INTENT_PAD}这个方案不错但一般。确认继续。" none
```
并在 `intent_is '继续，按照你的推荐' contextual-confirm` 之后追加整条匹配的正反例：

```bash
  intent_is '确认继续' confirm
  intent_is '确认继续。' confirm
  intent_is '  确认继续！ ' confirm
  intent_is '确认继续 (Recommended)' confirm
  intent_is '确认继续（推荐）' confirm
  intent_is '确认继续，全部执行' confirm
  intent_is '确认继续，按你的推荐' confirm
  intent_is 'go ahead.' confirm
  intent_is '继续 (Recommended)' contextual-confirm
  intent_is '按推荐' contextual-confirm
  intent_is '好的，确认继续吧' none
  intent_is '请看下面的日志，里面有一句确认继续，别当成放行' none
  intent_is '不确认继续' none
```

(2) `packages/cli/src/terminal-activity-hook.integration.test.ts:188`：

```ts
    const confirm = { prompt: '确认继续，按你的推荐实现响应式 React 页面', cwd: h.cwd, session_id: SESSION_ID }
```
改为（放行语必须整条；清单里有「确认继续，按你的推荐」）：

```ts
    const confirm = { prompt: '确认继续，按你的推荐', cwd: h.cwd, session_id: SESSION_ID }
```
该用例后面的 `'确认继续，新建一个任务实现响应式 React 页面'` 保持不变（它本来就不是放行）。

(3) §15 追加：

```bash
# ── 15e. 放行语整条匹配 + AskUserQuestion 答案值 helper + 提示文案 ──
xs_phrase() { bash -c '. "$1"; pipeline_text_is_approval_phrase "$2"' _ "$ROOT/hooks/prompt-intent.sh" "$1" >/dev/null 2>&1; }
xs_assert_phrase() { # $1=文本 $2=期望 yes|no
  local got=no
  xs_phrase "$1" && got=yes
  xs_assert_eq "approval-phrase:「${1:0:24}」→ $2" "$2" "$got"
}
for xs_text in '确认继续' '确认继续。' '  确认继续！ ' '确认继续，' '确认继续 (Recommended)' '确认继续（推荐）' '按推荐' 'go ahead.' '继续，按你的推荐' '确认继续，全部执行' '好的'; do
  xs_assert_phrase "$xs_text" yes
done
xs_pasted="这是一段粘贴进来的日志，里面恰好有一句确认继续，$(printf '填充文字%.0s' $(seq 1 40))"
for xs_text in '好的，确认继续吧' '先不放行' '不确认继续' '"确认继续"' '请确认继续或者拒绝' '' '   ' "$xs_pasted"; do
  xs_assert_phrase "$xs_text" no
done

xs_any() { bash -c '. "$1/hooks/json-input.sh"; . "$1/hooks/prompt-intent.sh"; pipeline_json_object_any_value "$2" answers pipeline_text_is_approval_phrase' _ "$ROOT" "$1" >/dev/null 2>&1; }
xs_assert_any() { # $1=desc $2=json $3=期望 yes|no
  local got=no
  xs_any "$2" && got=yes
  xs_assert_eq "answers-values: $1" "$3" "$got"
}
xs_assert_any "答案「确认继续 (Recommended)」→ 放行" '{"answers":{"问题？":"确认继续 (Recommended)"}}' yes
xs_assert_any "多个成员里有一个放行 → 放行" '{"answers":{"a":"先不放行","b":"确认继续"}}' yes
xs_assert_any "问题文本与选项说明含放行语、答案是「先不放行」→ 不放行" '{"questions":[{"question":"确认继续？","options":[{"label":"确认继续 (Recommended)"},{"label":"先不放行"}]}],"answers":{"确认继续？":"先不放行"}}' no
xs_assert_any "答案值里的换行不会拆成第二个答案" '{"answers":{"q":"其它说明\n确认继续"}}' no
xs_assert_any "没有 answers → 不放行（schema 漂移）" '{"result":"确认继续 (Recommended)"}' no
xs_assert_any "answers 是数组 → 不放行" '{"answers":["确认继续"]}' no
xs_assert_any "answers 成员不是字符串 → 不放行" '{"answers":{"q":["确认继续"]}}' no
xs_assert_any "JSON 截断 → 不放行" '{"answers":{"q":"确认继续' no
xs_assert_any "空对象 → 不放行" '{"answers":{}}' no

# 提示文案：gate 与 confirm-clear-prompt 都写明「整条回复」。
assert_contains "gate: 解封提示写明须整条回复" "$(grep -o '没有提问工具时.*解封后再重发' "$ROOT/hooks/gate.sh")" '放行语须是整条回复'
assert_contains "confirm-clear-prompt: 未识别提示写明需整条回复" "$(grep -o '用户回复「确认继续」.*重新提问[^\\]*' "$ROOT/hooks/confirm-clear-prompt.sh")" '需整条回复'

# 会话内行为：粘贴长文本里的放行语不确认，整条短回复确认（单项目、共享指针指向 A、无 session_id 的旧路径）。
xs_p="$(xs_project xs-phrase)"
write_v2_review_marker "$xs_p" xs-change-a spec
: > "$XS_TENON_LOG"
OUT="$(printf '%s' "{\"cwd\":\"$xs_p\",\"prompt\":\"$xs_pasted\"}" | PATH="$XS_TENON_BIN:$PATH" TENON_HOOK_LOG="$XS_TENON_LOG" bash "$CP" 2>/dev/null)"
assert_not_contains "confirm-clear-prompt: 粘贴长文本里的放行语不调用 acknowledge" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
assert_contains "confirm-clear-prompt: 粘贴长文本时输出未识别为确认的提示" "$OUT" '本条回复未被识别为确认'
assert_contains "confirm-clear-prompt: 提示写明需整条回复" "$OUT" '需整条回复'
[ -f "$xs_p/.pipeline-pending-review" ] && ok "confirm-clear-prompt: 粘贴长文本不动评审标记" || bad "confirm-clear-prompt: 粘贴长文本不动评审标记" "标记被删除"
OUT="$(printf '%s' "{\"cwd\":\"$xs_p\",\"prompt\":\"确认继续。\"}" | PATH="$XS_TENON_BIN:$PATH" TENON_HOOK_LOG="$XS_TENON_LOG" bash "$CP" 2>/dev/null)"
assert_contains "confirm-clear-prompt: 整条「确认继续。」为本会话任务写评审回执" "$(cat "$XS_TENON_LOG")" 'review acknowledge xs-change-a'
assert_contains "confirm-clear-prompt: 整条确认宣告已记录" "$OUT" '<tenon-review-confirmed>'
rm -f "$xs_p/.pipeline-pending-review"
```

- [ ] **Step 2: 运行确认失败**

Run:
```bash
bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'
npx vitest run packages/cli/src/terminal-activity-hook.integration.test.ts
```
Expected: test-hooks 红：`FAIL - classifier: 「确认继续，按你的推荐执行。…」→ none`（实际 intent=confirm）、`FAIL - approval-phrase: …`（函数未定义，全部 `no`）、`FAIL - answers-values: …`、`FAIL - gate: 解封提示写明须整条回复`。vitest 用例此时仍绿（它只依赖旧的子串匹配）。

- [ ] **Step 3: 写最小实现**

`hooks/prompt-intent.sh`：在 `pipeline_prompt_approval_intent() {` 之前（`# Shared approval/authority vocabulary` 之后适当位置，建议紧邻该函数上方）新增：

```bash
# 放行语只认整条短回复：去首尾空白、句末标点与「 (Recommended)」「（推荐）」后缀之后，整条必须等于下面清单里的一项。
# 任何更长的文字、引用或粘贴里出现放行语都不算（修复：粘贴文字里的「确认继续」被当成确认）。清单就是这里一份：
# 对话回复（pipeline_prompt_approval_intent）与 AskUserQuestion 答案值（confirm-clear.sh）共用，不再各写一份。
# 结果放进全局 _PIPELINE_APPROVAL_TEXT，不开子 shell。去标点逐个后缀按字节剥，bash 3.2 的任何 locale 都精确。
_pipeline_approval_normalize() { # $1=text → 0=可比对（结果在 _PIPELINE_APPROVAL_TEXT）/ 1=过长
  local text="${1:-}" changed=1 tail
  _PIPELINE_APPROVAL_TEXT=''
  [ "${#text}" -le 160 ] || return 1
  text="${text#"${text%%[![:space:]]*}"}"
  while [ "$changed" -eq 1 ]; do
    changed=0
    for tail in ' ' $'\t' $'\r' $'\n' '。' '！' '!' '.' '，' ',' '～' '~' ' (Recommended)' '（推荐）'; do
      case "$text" in *"$tail") text="${text%"$tail"}"; changed=1 ;; esac
    done
  done
  _PIPELINE_APPROVAL_TEXT="$text"
}

# 显式放行语（confirm）本身就是确认；简短同意（contextual-confirm）只在调用方确认有待处理标记时才算。
pipeline_approval_phrase_class() { # $1=text → stdout confirm|contextual-confirm；非零 = 整条不是清单里的放行语
  _pipeline_approval_normalize "${1:-}" || return 1
  case "$_PIPELINE_APPROVAL_TEXT" in
    确认继续|确认执行|确认并继续|继续执行|全部执行|可以继续|同意继续|请继续执行|批准继续|自行执行|自己执行|\
    '确认继续，全部执行'|'确认继续，按你的推荐'|'确认继续，按照你的推荐'|'go ahead'|'proceed with it'|'continue execution')
      printf 'confirm'; return 0 ;;
    继续|接着|可以|同意|好|好的|没问题|按推荐|按推荐方案|按你的推荐|按照你的推荐|\
    '继续，按照你的推荐'|'继续，按你的推荐'|继续按照你的推荐|继续按推荐|continue|Continue)
      printf 'contextual-confirm'; return 0 ;;
  esac
  return 1
}

pipeline_text_is_approval_phrase() { # $1=text → 0 when the whole text is one entry of the approval list
  pipeline_approval_phrase_class "${1:-}" >/dev/null
}
```

同文件 `pipeline_prompt_approval_intent` 末段，把

```bash
  case "$prompt" in
    *确认继续*|*确认执行*|*确认并继续*|*继续执行*|*全部执行*|*可以继续*|*同意继续*|*请继续执行*|*批准继续*|*自行执行*|*自己执行*|*go\ ahead*|*proceed\ with\ it*|*continue\ execution*)
      printf 'confirm'; return 0 ;;
    继续|继续。|继续！|接着|接着。|可以|可以。|可以！|同意|同意。|好|好的|没问题|按推荐|按推荐方案|按你的推荐|按照你的推荐|\
    *继续，按照你的推荐*|*继续，按你的推荐*|*继续按照你的推荐*|*继续按推荐*|continue|Continue)
      printf 'contextual-confirm'; return 0 ;;
  esac
  return 1
}
```
整体替换为：

```bash
  # 放行语只认整条短回复；上面的 revoke / reject / modify / authorize 判定顺序不变。
  pipeline_approval_phrase_class "$prompt"
}
```

`hooks/json-input.sh`：在 `pipeline_json_get_string_array` 函数之后新增：

```bash
# Walk the string members of the JSON object stored under "$2" and hand each decoded value to the function
# named by "$3".  Succeeds as soon as one call succeeds.  An absent key, a value that is not an object, a
# member that is not a string, or malformed JSON fails the whole walk: callers use this to judge consent, and
# an answer that cannot be read must never count as one.  One call per member with the decoded value, so a
# newline inside an answer can never be split into a second answer.
pipeline_json_object_any_value() { # $1=input JSON, $2=key, $3=predicate function name
  local rest value predicate="${3:-}"
  [ -n "$predicate" ] || return 1
  _pipeline_json_seek_value "${1:-}" "${2:-}" || return 1
  rest="$_PIPELINE_JSON_REST"
  case "$rest" in
    '{'*) rest="${rest#\{}" ;;
    *) return 1 ;;
  esac
  while true; do
    while true; do
      case "$rest" in
        [$' \t\r\n']*) rest="${rest#?}" ;;
        ','*) rest="${rest#,}" ;;
        *) break ;;
      esac
    done
    case "$rest" in
      '"'*) ;;
      *) return 1 ;; # '}' = the object ended without a consenting value; anything else is malformed
    esac
    _pipeline_json_read_string "$rest" || return 1 # member name
    rest="$_PIPELINE_JSON_REST"
    while true; do
      case "$rest" in
        [$' \t\r\n']*) rest="${rest#?}" ;;
        *) break ;;
      esac
    done
    case "$rest" in
      ':'*) rest="${rest#:}" ;;
      *) return 1 ;;
    esac
    while true; do
      case "$rest" in
        [$' \t\r\n']*) rest="${rest#?}" ;;
        *) break ;;
      esac
    done
    case "$rest" in
      '"'*) ;;
      *) return 1 ;;
    esac
    _pipeline_json_read_string "$rest" || return 1
    value="$_PIPELINE_JSON_VALUE"
    rest="$_PIPELINE_JSON_REST"
    if "$predicate" "$value"; then return 0; fi
  done
}
```

`hooks/gate.sh:556`：把提示里的 `…或其他回复不会解封。解封后再重发本次操作。` 改为 `…或其他回复不会解封；放行语须是整条回复，夹在更长的文字里不算。解封后再重发本次操作。`（只替换这一小段，其余字符不动；新增文字不含「」，不影响 test-hooks 对提示里解封短语与拒绝示例的解析）。

`hooks/confirm-clear-prompt.sh:59`：把提示尾部 `带条件的请先说明条件并重新提问。` 改为 `带条件的请先说明条件并重新提问；需整条回复：放行语夹在更长的文字、引用或粘贴里不算。`。

- [ ] **Step 4: 运行确认通过**

Run:
```bash
bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'
bash tools/test-adapters.sh 2>&1 | tail -3
npx vitest run packages/cli/src/terminal-activity-hook.integration.test.ts
```
Expected: 全部通过。注意 `tools/test-hooks.sh` 里原有的 `unlock_phrases_ok`（逐条核对 gate / CP / SKILL.md 提示里列出的解封语确实解封、不解封示例确实不解封）依然通过。

- [ ] **Step 5: Commit**

```bash
git add hooks/prompt-intent.sh hooks/json-input.sh hooks/gate.sh hooks/confirm-clear-prompt.sh tools/test-hooks.sh packages/cli/src/terminal-activity-hook.integration.test.ts
git commit -m "fix(hooks): accept an approval phrase only as the whole reply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: confirm-clear / confirm-clear-prompt 按会话解标记、确认与记账

**Files:**
- Modify（整体替换）: `hooks/confirm-clear.sh`
- Modify（整体替换）: `hooks/confirm-clear-prompt.sh`
- Modify: `tools/test-hooks.sh`（§15 追加 15f）
- Modify: `docs/CONTRACT.md`、`.trellis/spec/cli/frontend/hook-guidelines.md`
- Test: `tools/test-hooks.sh`、`tools/test-adapters.sh`

**Interfaces:**
- Consumes: Task 1 `pipeline_session_change_dir`、`pipeline_hook_session_id`；Task 2 `pipeline_acknowledge_active_review <root> <hook_dir> [mode] [host_session]`、`pipeline_review_marker_change`；Task 4 `pipeline_claim_interaction_marker`、`pipeline_interaction_marker_owned`、`pipeline_interaction_marker_skills`；Task 5 `pipeline_text_is_approval_phrase`、`pipeline_json_object_any_value`。
- Produces: 无新公共函数；两个 hook 对外行为：只清归属本会话的交互标记、只为本会话任务写回执 / InteractionConfirmed / 持续授权，AskUserQuestion 只看答案值。

- [ ] **Step 1: 写失败测试**

§15 追加：

```bash
# ── 15f. confirm-clear / confirm-clear-prompt：只解归属本会话的标记，只确认本会话任务，答案只看答案值 ──
xs_cp() { # $1=项目根 $2=session id（可空）$3=prompt（不含双引号与反斜杠）→ 打印 hook 输出
  local sid_field=''
  [ -n "$2" ] && sid_field=",\"session_id\":\"$2\""
  printf '%s' "{\"cwd\":\"$1\"${sid_field},\"prompt\":\"$3\"}" | PATH="$XS_TENON_BIN:$PATH" TENON_HOOK_LOG="$XS_TENON_LOG" bash "$CP" 2>/dev/null
}
xs_cc() { # $1=项目根 $2=session id $3=tool_response JSON → 运行 confirm-clear
  printf '%s' "{\"cwd\":\"$1\",\"session_id\":\"$2\",\"tool_name\":\"AskUserQuestion\",\"tool_response\":$3}" \
    | PATH="$XS_TENON_BIN:$PATH" TENON_HOOK_LOG="$XS_TENON_LOG" bash "$CC" >/dev/null 2>&1
}

# 评审：另一个会话的放行语不确认本任务。
xs_p="$(xs_project xs-cp-review)"
write_v2_review_marker "$xs_p" xs-change-a spec
: > "$XS_TENON_LOG"
xs_cp "$xs_p" "$XS_SID_B" '确认继续' >/dev/null
assert_not_contains "confirm-clear-prompt: 会话 B 整条「确认继续」不为 Change A 写回执" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
xs_cp "$xs_p" "$XS_SID_NEW" '确认继续' >/dev/null
assert_not_contains "confirm-clear-prompt: 恢复后无绑定的新会话「确认继续」不确认、不写回执" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
OUT="$(xs_cp "$xs_p" "$XS_SID_B" '确认继续')"
assert_not_contains "confirm-clear-prompt: 会话 B 的回复不宣告已确认 A 的评审" "$OUT" '<tenon-review-confirmed>'
OUT="$(xs_cp "$xs_p" "$XS_SID_B" '为什么需要确认')"
assert_not_contains "confirm-clear-prompt: 别的会话的评审标记不让会话 B 收到「保持锁定」提示" "$OUT" 'tenon-pending-confirmation'
OUT="$(xs_cp "$xs_p" "$XS_SID_A" '确认继续。')"
assert_contains "confirm-clear-prompt: 会话 A 整条回复为 Change A 写回执" "$(cat "$XS_TENON_LOG")" 'review acknowledge xs-change-a'
assert_contains "confirm-clear-prompt: 会话 A 的确认被宣告" "$OUT" '<tenon-review-confirmed>'
rm -f "$xs_p/.pipeline-pending-review"

# 交互标记：别的会话的放行语 / 提问不解本会话标记；本会话的解，并只记到本会话任务。
xs_p="$(xs_project xs-cp-interaction)"
printf '%s' "$(xs_ig_input "$xs_p" "$XS_SID_A")" | bash "$IG" >/dev/null 2>&1
xs_cp "$xs_p" "$XS_SID_B" '确认继续' >/dev/null
[ -f "$xs_p/.pipeline-pending-interaction" ] && ok "confirm-clear-prompt: 会话 B 的放行语不解会话 A 的交互标记" || bad "confirm-clear-prompt: 会话 B 的放行语不解会话 A 的交互标记" "标记被清除"
xs_cp "$xs_p" "$XS_SID_B" '继续' >/dev/null
[ -f "$xs_p/.pipeline-pending-interaction" ] && ok "confirm-clear-prompt: 会话 B 的简短同意也不解会话 A 的标记" || bad "confirm-clear-prompt: 会话 B 的简短同意也不解会话 A 的标记" "标记被清除"
xs_cc "$xs_p" "$XS_SID_B" '{"answers":{"q":"确认继续"}}'
[ -f "$xs_p/.pipeline-pending-interaction" ] && ok "confirm-clear: 会话 B 完成 AskUserQuestion 不解会话 A 的交互标记" || bad "confirm-clear: 会话 B 完成 AskUserQuestion 不解会话 A 的交互标记" "标记被清除"
assert_not_contains "confirm-clear: 会话 B 的答案不为 A 写回执" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
OUT="$(xs_cp "$xs_p" "$XS_SID_A" '确认继续')"
[ ! -e "$xs_p/.pipeline-pending-interaction" ] && ok "confirm-clear-prompt: 会话 A 的放行语解会话 A 的交互标记" || bad "confirm-clear-prompt: 会话 A 的放行语解会话 A 的交互标记" "标记仍在"
assert_contains "confirm-clear-prompt: 解封后告知重试被拦截的操作" "$OUT" 'tenon-interaction-confirmed'
assert_contains "confirm-clear-prompt: InteractionConfirmed 记到本会话任务 Change A" "$(cat "$(xs_hist "$xs_p" xs-change-a)" 2>/dev/null)" 'InteractionConfirmed: superpowers:brainstorming'
[ ! -f "$(xs_hist "$xs_p" xs-change-b)" ] && ok "confirm-clear-prompt: InteractionConfirmed 没有记到别的 Change" || bad "confirm-clear-prompt: InteractionConfirmed 没有记到别的 Change" "B 的历史被写入"
assert_empty "confirm-clear-prompt: 解封不留认领临时文件" "$(ls "$xs_p"/.pipeline-pending-*.claim.* 2>/dev/null || true)"
# AskUserQuestion 由本会话完成 → 解本会话标记（与答案内容无关）。
printf '%s' "$(xs_ig_input "$xs_p" "$XS_SID_B")" | bash "$IG" >/dev/null 2>&1
xs_cc "$xs_p" "$XS_SID_B" '{"answers":{"q":"先不放行"}}'
[ ! -e "$xs_p/.pipeline-pending-interaction" ] && ok "confirm-clear: 会话 B 完成 AskUserQuestion 解自己的交互标记" || bad "confirm-clear: 会话 B 完成 AskUserQuestion 解自己的交互标记" "标记仍在"

# AskUserQuestion 答案只看答案值：问题文本里的放行语不触发，「确认继续 (Recommended)」触发，schema 漂移不触发。
xs_p="$(xs_project xs-cc-answers)"
write_v2_review_marker "$xs_p" xs-change-a spec
: > "$XS_TENON_LOG"
xs_cc "$xs_p" "$XS_SID_A" '{"questions":[{"question":"确认继续？","options":[{"label":"确认继续 (Recommended)"},{"label":"先不放行"}]}],"answers":{"确认继续？":"先不放行"}}'
assert_not_contains "confirm-clear: 问题文本与选项里的放行语、答案是「先不放行」→ 不确认" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
xs_cc "$xs_p" "$XS_SID_A" '{"result":"确认继续 (Recommended)"}'
assert_not_contains "confirm-clear: 没有 answers（schema 漂移）→ 不确认" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
xs_cc "$xs_p" "$XS_SID_A" '{"answers":["确认继续"]}'
assert_not_contains "confirm-clear: answers 是数组（schema 漂移）→ 不确认" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
xs_cc "$xs_p" "$XS_SID_A" '{"answers":{"确认继续？":"确认继续 (Recommended'
assert_not_contains "confirm-clear: tool_response 截断 → 不确认" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
xs_cc "$xs_p" "$XS_SID_B" '{"answers":{"确认继续？":"确认继续 (Recommended)"}}'
assert_not_contains "confirm-clear: 会话 B 的「确认继续 (Recommended)」不确认 Change A" "$(cat "$XS_TENON_LOG")" 'review acknowledge'
xs_cc "$xs_p" "$XS_SID_A" '{"answers":{"确认继续？":"确认继续 (Recommended)"}}'
assert_contains "confirm-clear: 会话 A 的答案「确认继续 (Recommended)」→ 确认 Change A" "$(cat "$XS_TENON_LOG")" 'review acknowledge xs-change-a'
rm -f "$xs_p/.pipeline-pending-review"

# 持续授权：会话 B 说「后续不用问我」不得给 Change A 写授权；新 id 不写；会话 A 写给 A。
xs_p="$(xs_project xs-cp-authority)"
xs_say="确认。后续不用问我，自己执行完成"
rm -f "$(active_authority_path "$xs_p")"
xs_cp "$xs_p" "$XS_SID_NEW" "$xs_say" >/dev/null
[ ! -e "$(active_authority_path "$xs_p")" ] && ok "confirm-clear-prompt: 恢复后无绑定的会话说「后续不用问我」不给 Change A 写授权" || bad "confirm-clear-prompt: 恢复后无绑定的会话说「后续不用问我」不给 Change A 写授权" "写了授权"
xs_cp "$xs_p" "$XS_SID_B" "$xs_say" >/dev/null
assert_contains "confirm-clear-prompt: 会话 B 的授权绑定本会话任务 Change B" "$(cat "$(active_authority_path "$xs_p")" 2>/dev/null)" 'change=xs-change-b'
assert_not_contains "confirm-clear-prompt: 会话 B 的授权不绑定共享指针指向的 Change A" "$(cat "$(active_authority_path "$xs_p")" 2>/dev/null)" 'change=xs-change-a'
assert_contains "confirm-clear-prompt: 会话 B 的授权绑定会话 B" "$(cat "$(active_authority_path "$xs_p")" 2>/dev/null)" "host_session=$XS_SID_B"
rm -f "$(active_authority_path "$xs_p")"
xs_cp "$xs_p" "$XS_SID_A" "$xs_say" >/dev/null
assert_contains "confirm-clear-prompt: 会话 A 的授权绑定 Change A" "$(cat "$(active_authority_path "$xs_p")" 2>/dev/null)" 'change=xs-change-a'
```

- [ ] **Step 2: 运行确认失败**

Run: `bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'`
Expected: FAIL，例如 `FAIL - confirm-clear-prompt: 会话 B 整条「确认继续」不为 Change A 写回执`、`FAIL - confirm-clear: 会话 B 完成 AskUserQuestion 不解会话 A 的交互标记`、`FAIL - confirm-clear-prompt: 会话 B 的授权绑定本会话任务 Change B`、`FAIL - confirm-clear: 问题文本与选项里的放行语、答案是「先不放行」→ 不确认`。

- [ ] **Step 3: 写最小实现**

用下面内容**整体替换** `hooks/confirm-clear.sh`：

```bash
#!/usr/bin/env bash
# confirm-clear.sh — PostToolUse hook（matcher: AskUserQuestion|request_user_input）。
#
# agent 一旦用 AskUserQuestion 跟用户确认/收反馈了，就清掉纯交互 marker：
#   .pipeline-pending-confirm     解封 confirm 门（没有写入方，只保留兼容清理，不带归属）
#   .pipeline-pending-interaction 解封 interaction 门——只清归属本会话的 v2 标记（pending-marker.sh）：
#                                 别的会话的提问解不开本会话的锁，本会话的提问也解不开别的会话的。
# review v2 marker 不可由这个 hook 直接删除：它对应 canonical receipt，只有用户答复中包含
# 显式批准语义时才调用 `tenon review acknowledge`（且只确认本会话任务的评审）。这样“要修改”这类回答不会误放行离开
# review phase。
#
# 答案判定：只看 tool_response.answers 里每个答案值本身（去掉「 (Recommended)」「（推荐）」后缀后整值等于放行语，
# 清单在 prompt-intent.sh 的 pipeline_text_is_approval_phrase），不在问题文本、选项说明或整段响应里找子串；
# 取不到 answers（宿主 schema 漂移、JSON 损坏）一律不确认评审（fail-closed），interaction 标记的解封语义不变。
#
# 清除范围与 gate/router 共用项目根定位：只接受 Git worktree、显式
# TENON_PROJECT_ROOT 或当前 cwd。这样子目录中的确认仍能解封当前 Git 项目，且绝不会清到
# 共享临时父目录的另一项目 marker。
#
# 纯 bash 热路径（CONTRACT §5.4：PostToolUse 每次工具后触发）：零解释器 / 外部 JSON 解析器 spawn。
# fail-safe：任何异常一律 exit 0，绝不打断。
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

# Shared escape-aware parsing keeps quoted host payloads from changing which project marker is
# cleared. It remains Bash-only and preserves this hook's fail-open behaviour.
JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

CWD="$(json_get cwd || true)"
[ -z "$CWD" ] && CWD="$PWD"
[ -d "$CWD" ] || exit 0

# 无共享 helper 的单文件旧安装保留 cwd fallback；当前安装一定经 helper 取得同一个项目根。
ROOT="$CWD"
ROOT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
if [ -r "$ROOT_HELPER" ]; then
  # shellcheck source=project-root.sh
  . "$ROOT_HELPER"
  ROOT="$(pipeline_project_root "$CWD" bootstrap changes || true)"
fi
[ -n "$ROOT" ] || exit 0
rm -f "$ROOT/.pipeline-pending-confirm" 2>/dev/null || true

# 会话归属要靠这几个 helper：缺任何一个就无法判定「本会话」，此时不碰 interaction 标记、不确认评审，照旧 exit 0。
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
[ -n "$HOOK_DIR" ] || exit 0
for helper in canonical-state.sh active-change.sh pending-marker.sh prompt-intent.sh review-ack.sh; do
  [ -r "$HOOK_DIR/$helper" ] || exit 0
  # shellcheck source=/dev/null
  . "$HOOK_DIR/$helper"
done
SESSION_ID="$(pipeline_hook_session_id "$INPUT")"

# 本会话完成了一次提问：只认领、清掉归属本会话的交互标记（旧格式标记在判定时被删除）。
CLAIM="$ROOT/.pipeline-pending-interaction.claim.$$"
if pipeline_claim_interaction_marker "$ROOT" "$SESSION_ID" "$CLAIM"; then
  rm -f "$CLAIM" 2>/dev/null || true
fi

# Hosts place AskUserQuestion answers in tool_response.answers (an object of answer strings).  Inspect only
# those values: question text and option labels often contain “确认继续” and must never be mistaken for consent.
case "$INPUT" in
  *\"tool_response\"*) RESPONSE_PART="${INPUT#*\"tool_response\"}" ;;
  *) exit 0 ;;
esac
if pipeline_json_object_any_value "$RESPONSE_PART" answers pipeline_text_is_approval_phrase; then
  pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" manual "$SESSION_ID" || true
fi

exit 0
```

用下面内容**整体替换** `hooks/confirm-clear-prompt.sh`：

```bash
#!/usr/bin/env bash
# confirm-clear-prompt.sh — actual user-confirmation unlock for UserPromptSubmit.
#
# `confirm-clear.sh` is retained for hosts which expose AskUserQuestion responses.  Codex desktop's
# normal conversation path does not expose that tool, however, so clearing only on PostToolUse made a
# review marker self-lock every subsequent tool call.  This hook receives the user's next prompt and
# turns an explicit approval phrase into the canonical `tenon review acknowledge` receipt before
# the next PreToolUse gate runs.  It never deletes a v2 review marker by itself.
#
# It intentionally recognises a narrow, auditable set of affirmative phrases, and only when the WHOLE reply is
# one of them (prompt-intent.sh pipeline_text_is_approval_phrase): a phrase inside a longer text, a quotation or a
# paste is not consent.  Questions such as "为什么" or "看看状态" do not clear review evidence.  Fail-open:
# malformed hook input merely leaves the marker in place; it never blocks the user's prompt itself.
#
# Session scoping: parallel conversations share one project root.  Everything this hook mutates — the interaction
# marker it releases, the review it acknowledges, the InteractionConfirmed row, the continuous-execution authority —
# belongs to THIS conversation (host session id → pipeline_session_change_dir), never to the Change the
# per-user shared pointer happens to name.
set -uo pipefail

INPUT="$(cat 2>/dev/null || printf '{}')"

JSON_INPUT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
[ -r "$JSON_INPUT_HELPER" ] || exit 0
# shellcheck source=json-input.sh
. "$JSON_INPUT_HELPER"
json_get() { pipeline_json_get_string "$INPUT" "$1"; }

# A pasted multi-MB log must not push this hook past the host timeout: keep only the prompt's first
# and last 8 KiB before any parsing (pipeline_prompt_bound_input, prompt-intent.sh).
INTENT_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/prompt-intent.sh"
[ -r "$INTENT_HELPER" ] || exit 0
# shellcheck source=prompt-intent.sh
. "$INTENT_HELPER"
INPUT="$(pipeline_prompt_bound_input "$INPUT")" || exit 0

PROMPT="$(json_get prompt || true)"
[ -n "$PROMPT" ] || exit 0

# A one-turn confirmation and durable, Change-bound continuous-execution authority are different
# intents.  The latter must contain a deliberately strong phrase; a bare “继续执行” still clears
# only the current short-lived marker.  Revocation is also explicit and never falls through to
# marker-clearing, so a user can safely restore step-by-step questions.
INTENT="$(pipeline_prompt_approval_intent "$PROMPT" || true)"

# 项目根、共享 helper 与本会话 id。任何一步缺失都返回 1：没有「本会话」就不碰标记、不确认。
CP_READY=0
ROOT='' HOOK_DIR='' HOST_SESSION_ID=''
cp_load_context() {
  local cwd root_helper helper
  [ "$CP_READY" -eq 1 ] && return 0
  cwd="$(json_get cwd || true)"
  [ -n "$cwd" ] || cwd="$PWD"
  [ -d "$cwd" ] || return 1
  root_helper="$(dirname "${BASH_SOURCE[0]:-$0}")/project-root.sh"
  [ -r "$root_helper" ] || return 1
  # shellcheck source=project-root.sh
  . "$root_helper"
  ROOT="$(pipeline_project_root "$cwd" bootstrap changes || true)"
  [ -n "$ROOT" ] || return 1
  HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  [ -n "$HOOK_DIR" ] || return 1
  for helper in canonical-state.sh active-change.sh pending-marker.sh review-ack.sh; do
    [ -r "$HOOK_DIR/$helper" ] || return 1
    # shellcheck source=/dev/null
    . "$HOOK_DIR/$helper"
  done
  HOST_SESSION_ID="$(pipeline_hook_session_id "$INPUT")"
  CP_READY=1
}

# 有没有归属本会话的待处理项：confirm 标记（无归属）、归属本会话的交互标记、任务是本会话任务的评审标记。
# 别的会话的标记不让本会话的 agent 误以为自己被锁住。
cp_session_has_pending() {
  local review_change mine
  [ -f "$ROOT/.pipeline-pending-confirm" ] && return 0
  if [ -e "$ROOT/.pipeline-pending-interaction" ] || [ -L "$ROOT/.pipeline-pending-interaction" ]; then
    pipeline_interaction_marker_owned "$ROOT/.pipeline-pending-interaction" "$ROOT" "$HOST_SESSION_ID" && return 0
  fi
  review_change="$(pipeline_review_marker_change "$ROOT/.pipeline-pending-review" 2>/dev/null || true)"
  if [ -n "$review_change" ]; then
    mine="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
    [ "${mine##*/}" = "$review_change" ] && return 0
  fi
  return 1
}

# A reply that is not an approval never unlocks anything, but it must not be silent either: while an
# interaction/confirm/review marker of this conversation is pending, tell the agent this reply was not taken as
# approval and which reply unlocks it, so the user is never left guessing the phrase.
pending_unlock_hint_and_exit() {
  cp_load_context || exit 0
  cp_session_has_pending || exit 0
  printf '<tenon-pending-confirmation>\n本条回复未被识别为确认，待确认的交互或评审保持锁定。用户回复「确认继续」「继续执行」「同意继续」，或简短同意「继续」「可以」「同意」「好的」「按推荐」「按你的推荐」（采纳推荐项），即确认当前待决事项（评审按已请求的事件推进）；拒绝或带条件的回复不会解封，带条件的请先说明条件并重新提问；需整条回复：放行语夹在更长的文字、引用或粘贴里不算。\n</tenon-pending-confirmation>\n'
  exit 0
}
[ -n "$INTENT" ] || pending_unlock_hint_and_exit

# 拒绝或带约束的混合表达不是一次无条件 unlock。当前 v1 marker 还不能持久化细粒度
# constraints，因此安全行为是保留 exact pending target，让调用方展示约束后的下一动作；
# 绝不能因为文本里同时出现“继续/可以”就清掉整道门。
case "$INTENT" in
  reject|modify) pending_unlock_hint_and_exit ;;
esac

cp_load_context || exit 0

# A bare “继续” is both a resume phrase and, in an exact pending context, the user's natural
# approval.  It must not become a repository-wide unlock: without a pending marker of THIS conversation it
# remains resume-only and this hook exits without mutation.
if [ "$INTENT" = 'contextual-confirm' ]; then
  cp_session_has_pending || exit 0
  INTENT='confirm'
fi

# Resolve this conversation's live Change before issuing or revoking authority.  No Change of this conversation
# (for example a resumed session that has not re-activated yet), malformed canonical state, or a missing helper is
# fail-closed: normal confirmation remains available but no broad repo/session authority is ever created.
if [ "$INTENT" = 'authorize' ] || [ "$INTENT" = 'revoke' ]; then
  AUTHORITY_HELPER="$HOOK_DIR/interaction-authority.sh"
  if [ -r "$AUTHORITY_HELPER" ]; then
    # shellcheck source=interaction-authority.sh
    . "$AUTHORITY_HELPER"
    ACTIVE_DIR="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
    ACTIVE_NAME="${ACTIVE_DIR##*/}"
    if [ -n "$ACTIVE_DIR" ] && [ -n "$HOST_SESSION_ID" ]; then
      if [ "$INTENT" = 'authorize' ]; then
        pipeline_write_interaction_authority "$ROOT" "$ACTIVE_NAME" "$HOST_SESSION_ID" \
          && pipeline_record_interaction_authority_event "$ROOT" "$ACTIVE_NAME" enabled "$HOST_SESSION_ID" || true
      else
        pipeline_revoke_interaction_authority "$ROOT" "$ACTIVE_NAME" "$HOST_SESSION_ID" \
          && pipeline_record_interaction_authority_event "$ROOT" "$ACTIVE_NAME" revoked "$HOST_SESSION_ID" || true
      fi
    fi
  fi
fi

# A revocation only changes the persistent authority projection.  It must not accidentally clear
# a fresh interaction/review safety marker while the user is asking to return to explicit prompts.
[ "$INTENT" = 'revoke' ] && exit 0

# Confirm/interaction markers do not carry a canonical review receipt and retain their original
# idempotent clear-on-explicit-approval semantics.  The review marker is intentionally excluded:
# the CLI owns both its removal and the durable approval state, preventing a hook-only deletion
# from bypassing the exit gate.  The interaction marker is released only when it belongs to this conversation.
#
# Release is claimed with an atomic rename, not "test then rm": when the host runs this hook more than once for the
# same prompt (duplicate registrations run concurrently), every copy used to see the marker, each announced the
# release and each wrote the InteractionConfirmed rows.  Only the copy whose rename wins releases the lock, records
# the confirmation and announces it.
RELEASED_LOCK=0
INTERACTION_CLAIM="$ROOT/.pipeline-pending-interaction.claim.$$"
CONFIRM_CLAIM="$ROOT/.pipeline-pending-confirm.claim.$$"
pipeline_claim_interaction_marker "$ROOT" "$HOST_SESSION_ID" "$INTERACTION_CLAIM" && RELEASED_LOCK=1
mv "$ROOT/.pipeline-pending-confirm" "$CONFIRM_CLAIM" 2>/dev/null && RELEASED_LOCK=1

# Remember which interactive skill the user just approved in this step visit, so reading the same
# skill again (Codex re-reads a producer skill to record its document) does not ask again.  The row goes to
# THIS conversation's Change.
if [ -f "$INTERACTION_CLAIM" ]; then
  CONFIRMED_DIR="$(pipeline_session_change_dir "$ROOT" "$HOST_SESSION_ID" || true)"
  if [ -n "$CONFIRMED_DIR" ]; then
    CONFIRMED_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
    CONFIRMED_SKILLS="$(pipeline_interaction_marker_skills "$INTERACTION_CLAIM" || true)"
    CONFIRMED_SKILLS="${CONFIRMED_SKILLS//、/$'\n'}"
    while IFS= read -r CONFIRMED_SKILL; do
      case "$CONFIRMED_SKILL" in ''|*[!A-Za-z0-9_:-]*) continue ;; esac
      printf '{"ts":"%s","kind":"tool","raw":"%s"}\n' "$CONFIRMED_TS" \
        "$(pipeline_json_escape "InteractionConfirmed: $CONFIRMED_SKILL")" \
        >> "$CONFIRMED_DIR/.pipeline-history.jsonl" 2>/dev/null || true
    done <<< "$CONFIRMED_SKILLS"
  fi
fi

rm -f "$INTERACTION_CLAIM" "$CONFIRM_CLAIM" 2>/dev/null || true
# Announce a released lock: an agent that was blocked earlier otherwise assumes the gate still holds
# and stops without retrying the blocked action.
if [ "$RELEASED_LOCK" -eq 1 ]; then
  printf '<tenon-interaction-confirmed>\n用户已确认，待确认的交互已解封；请重试刚才被拦截的操作。\n</tenon-interaction-confirmed>\n'
fi

# Read the exact target before acknowledging: `tenon review acknowledge` removes the marker.
REVIEW_CHANGE="$(pipeline_review_marker_change "$ROOT/.pipeline-pending-review" 2>/dev/null || true)"
REVIEW_EVENT="$(pipeline_review_marker_event "$ROOT/.pipeline-pending-review" 2>/dev/null || true)"
REVIEW_ACKED=0
if [ "$INTENT" = 'authorize' ]; then
  pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" delegated "$HOST_SESSION_ID" && REVIEW_ACKED=1
else
  pipeline_acknowledge_active_review "$ROOT" "$HOOK_DIR" manual "$HOST_SESSION_ID" && REVIEW_ACKED=1
fi
# Real session, round 4: the receipt was written and the marker removed, yet the agent — told
# nothing — answered that the gate "only accepts 确认继续" and did not move.  Say it was recorded.
if [ "$REVIEW_ACKED" -eq 1 ] && [ -n "$REVIEW_CHANGE" ]; then
  REVIEW_EVENT_NOTE=''
  [ -n "$REVIEW_EVENT" ] && REVIEW_EVENT_NOTE="（事件 ${REVIEW_EVENT}）"
  printf '<tenon-review-confirmed>\n用户本条回复已记录为对任务 %s 的评审确认%s：评审回执已写入（review.status=approved），不要再让用户说「确认继续」。现在执行 tenon status %s --json，照 next 推进（transition %s %s）。\n</tenon-review-confirmed>\n' \
    "$REVIEW_CHANGE" "$REVIEW_EVENT_NOTE" "$REVIEW_CHANGE" "$REVIEW_CHANGE" "${REVIEW_EVENT:-<event>}"
fi

exit 0
```

文档：

- `docs/CONTRACT.md`：在「门 marker 文件」条目里（以「`-review` 不在此列，对子代理照拦（人工确认不能被绕过）。」结尾的那一条）之后新增一条：

```markdown
- **交互 marker v2（按会话归属）**：`.pipeline-pending-interaction` 首行为 `pipeline-interaction-v2`，随后 `change=`、`session=`、`skills=`、`requested_at=`。`session` 非空只属于该会话；`session` 为空而 `change` 非空属于「本会话任务为该 Change」的会话；两者皆空属于全部会话（宿主不给 session id 时的旧行为）。gate 只拦归属方；`confirm-clear.sh` 与 `confirm-clear-prompt.sh` 只解归属本会话的标记，InteractionConfirmed 只记到本会话任务；旧格式（首行不是协议名，含空文件）见到即删除、不拦截。「本会话任务」由 `hooks/active-change.sh` 的 `pipeline_session_change_dir` 解析：本会话有会话绑定取绑定的 Change；无绑定而共享指针指向的 Change 已被别的会话绑定则没有任务；宿主没给 `session_id` 或该 Change 无人绑定则回退共享指针。放行语只认整条短回复（`pipeline_text_is_approval_phrase`），AskUserQuestion 只看 `tool_response.answers` 的答案值。
```

- `.trellis/spec/cli/frontend/hook-guidelines.md`：把 `### 2. Signatures` 里的 `<root>/.pipeline-pending-interaction          # skill display names joined by 、` 改为 `<root>/.pipeline-pending-interaction          # v2: pipeline-interaction-v2 / change= / session= / skills= (names joined by 、) / requested_at=`；在 `### 3. Contracts` 的 `Approval phrases` 条目之后新增一条：

```markdown
- **Ownership and whole-reply approval**: a v2 interaction marker only blocks and is only released by the conversation it
  names (`session=`; else the conversation whose Change is `change=`; else everyone). An approval phrase counts only as the
  whole reply (`pipeline_text_is_approval_phrase`: trimmed, trailing punctuation and `(Recommended)` / `（推荐）` removed,
  then equal to one list entry), and AskUserQuestion answers are judged per answer value from `tool_response.answers`.
```

- [ ] **Step 4: 运行确认通过**

Run:
```bash
bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'
bash tools/test-adapters.sh 2>&1 | tail -3
bash tools/verify-skills.sh --quiet
```
Expected: 全部通过。原有 10a / 10a' / 10a''' / 10a'' 用例（无 session_id、无绑定，走共享指针回退）与「并发重复运行只宣告一次、只记一行确认」用例保持绿。

- [ ] **Step 5: Commit**

```bash
git add hooks/confirm-clear.sh hooks/confirm-clear-prompt.sh tools/test-hooks.sh docs/CONTRACT.md .trellis/spec/cli/frontend/hook-guidelines.md
git commit -m "fix(hooks): release, confirm and record only for the conversation that owns the marker" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `tenon session activate --host-session` 移交同一 Change 的旧绑定

**Files:**
- Modify: `packages/cli/src/commands/session.ts:23`（import）、`:78`（`SessionFs.bindTerminalSession` 类型）、`:87-111`（`writeTerminalSessionBinding`）、`:306-316`（`cmdActivate` 里的绑定调用）
- Modify: `packages/cli/src/commands/session.test.ts:13-30`、`:73-83` 附近（fake 的返回类型与新增用例）
- Modify: `packages/cli/src/session.integration.test.ts`（import 与两条真实 e2e）
- Test: `packages/cli/src/commands/session.test.ts`、`packages/cli/src/session.integration.test.ts`

**Interfaces:**
- Consumes: kernel `TERMINAL_SESSION_BINDINGS_DIR`、`TERMINAL_SESSION_PROTOCOL`、`isTerminalSessionId`（已在 `session.ts` 导入）。
- Produces: `SessionFs.bindTerminalSession?: (cwd: string, name: string, sessionId: string) => Promise<readonly string[]>`，返回被移交的旧会话 id（可为空数组）；`cmdActivate` 对每个旧 id 在 stderr 输出 `[activate] 已从会话 <旧 id> 移交 <change>`。

- [ ] **Step 1: 写失败测试**

`packages/cli/src/commands/session.test.ts`：把 `fakeFs` 里的 `bindTerminal` 类型与默认实现改成返回数组：

```ts
  bindTerminal: ReturnType<typeof spy<[string, string, string], Promise<readonly string[]>>>
```
```ts
  const bindTerminal = spy(async (_cwd: string, _name: string, _sessionId: string): Promise<readonly string[]> => [])
```
并在 `activate --host-session 仅绑定精确 host session…` 这条用例之后追加：

```ts
  test('activate --host-session：绑定实现返回被移交的旧会话 → stderr 逐个提示', async () => {
    const deps = makeDeps({ state: mockState() })
    const fs = fakeFs({ bindTerminalSession: async () => ['old-session-1', 'old-session-2'] })
    expect(await cmdSession(deps, 'activate', ['chg', '--host-session', 'new-session'], fs)).toBe(0)
    const err = deps.errLines.join('\n')
    expect(err).toContain('[activate] 已从会话 old-session-1 移交 chg')
    expect(err).toContain('[activate] 已从会话 old-session-2 移交 chg')
  })

  test('activate --host-session：没有旧绑定可移交时不输出移交提示', async () => {
    const deps = makeDeps({ state: mockState() })
    expect(await cmdSession(deps, 'activate', ['chg', '--host-session', 'new-session'], fakeFs())).toBe(0)
    expect(deps.errLines.join('\n')).not.toContain('移交')
  })
```

`packages/cli/src/session.integration.test.ts`：import 行改为 `import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'`，并在 `describe('真实 e2e —— session activate…')` 里，紧接 `activate --host-session → 真写会话到 Change 的非 canonical 绑定…` 用例之后、该 describe 的结束 `})` 之前追加：

```ts
  test('activate --host-session 把同一 Change 的其他会话绑定移交给新会话，并在 stderr 说明从哪个会话移交', async () => {
    const sessionsDir = join(h.cwd, '.pipeline', 'terminal-sessions')
    expect((await session(h, 'activate', ['feat', '--host-session', 'session-x1'])).code).toBe(0)
    // 移交前遗留：同一 Change 还有第二个会话的绑定。
    await writeFile(
      join(sessionsDir, 'session-x2.json'),
      `${JSON.stringify({ protocol: 'pipeline-terminal-session-v1', session_id: 'session-x2', change: 'feat', bound_at: '2026-10-07T00:00:00Z' })}\n`,
      'utf8',
    )
    const moved = await session(h, 'activate', ['feat', '--host-session', 'session-y'])
    expect(moved.code).toBe(0)
    const err = moved.err.join('\n')
    expect(err).toContain('[activate] 已从会话 session-x1 移交 feat')
    expect(err).toContain('[activate] 已从会话 session-x2 移交 feat')
    expect(await exists(join(sessionsDir, 'session-x1.json'))).toBe(false)
    expect(await exists(join(sessionsDir, 'session-x2.json'))).toBe(false)
    expect(JSON.parse(await readFile(join(sessionsDir, 'session-y.json'), 'utf8'))).toMatchObject({ session_id: 'session-y', change: 'feat' })
    // 同一会话再次激活自己的 Change：没有可移交的，不提示。
    const again = await session(h, 'activate', ['feat', '--host-session', 'session-y'])
    expect(again.code).toBe(0)
    expect(again.err.join('\n')).not.toContain('移交')
  })

  test('移交只动同一 Change 的合法绑定：别的 Change、符号链接、超大、损坏与 id 不符的文件原样保留', async () => {
    await init(h, 'other')
    const sessionsDir = join(h.cwd, '.pipeline', 'terminal-sessions')
    expect((await session(h, 'activate', ['other', '--host-session', 'session-z'])).code).toBe(0)
    await mkdir(sessionsDir, { recursive: true })
    const binding = (id: string, change: string, pad = ''): string => `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1', session_id: id, change, bound_at: '2026-10-07T00:00:00Z', ...(pad === '' ? {} : { pad }),
    })}\n`
    await writeFile(join(h.cwd, 'outside-binding.json'), binding('session-link', 'feat'), 'utf8')
    await symlink(join(h.cwd, 'outside-binding.json'), join(sessionsDir, 'session-link.json'))
    await writeFile(join(sessionsDir, 'session-big.json'), binding('session-big', 'feat', 'x'.repeat(5000)), 'utf8')
    await writeFile(join(sessionsDir, 'session-bad.json'), '{"change":"feat" not json', 'utf8')
    await writeFile(join(sessionsDir, 'session-mismatch.json'), binding('another-id', 'feat'), 'utf8')
    const moved = await session(h, 'activate', ['feat', '--host-session', 'session-y'])
    expect(moved.code).toBe(0)
    expect(moved.err.join('\n')).not.toContain('移交')
    for (const kept of ['session-z', 'session-link', 'session-big', 'session-bad', 'session-mismatch']) {
      expect(await exists(join(sessionsDir, `${kept}.json`)), kept).toBe(true)
    }
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/session.test.ts packages/cli/src/session.integration.test.ts`
Expected: FAIL，新增用例变红：`AssertionError: expected '…' to contain '[activate] 已从会话 old-session-1 移交 chg'`（stderr 里没有移交提示）、`expected true to be false`（`session-x1.json` 仍存在）。

- [ ] **Step 3: 写最小实现**

`packages/cli/src/commands/session.ts`：

(a) import：`import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'` 改为 `import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'`。

(b) 第 78 行：

```ts
  bindTerminalSession?: (cwd: string, name: string, sessionId: string) => Promise<void>
```
改为：

```ts
  /** Returns the ids of the other sessions whose binding to the same Change was handed over (deleted). */
  bindTerminalSession?: (cwd: string, name: string, sessionId: string) => Promise<readonly string[]>
```

(c) 在 `writeTerminalSessionBinding` 之前新增：

```ts
/** A session binding is a few dozen bytes; anything bigger is not one and is never touched. */
const MAX_SESSION_BINDING_BYTES = 4096

/**
 * A Change is bound to one conversation at a time: before the new binding is written, every other session's
 * binding to the same Change is deleted and its id returned, so the caller can say where the Change came from.
 * Only well-formed bindings count (ordinary small file, right protocol, `session_id` equal to the file name,
 * same Change); links, oversize, damaged files and other Changes' bindings are left alone.
 */
async function removeOtherSessionBindings(sessionsDir: string, name: string, sessionId: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionsDir)
  } catch {
    return []
  }
  const handedOver: string[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const other = entry.slice(0, -'.json'.length)
    if (other === sessionId || !isTerminalSessionId(other)) continue
    const path = join(sessionsDir, entry)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_BINDING_BYTES) continue
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      if (record.protocol !== TERMINAL_SESSION_PROTOCOL || record.session_id !== other || record.change !== name) continue
      await rm(path, { force: true })
      handedOver.push(other)
    } catch {
      continue
    }
  }
  return handedOver
}
```

(d) `writeTerminalSessionBinding` 的签名改为 `async function writeTerminalSessionBinding(cwd: string, name: string, sessionId: string): Promise<readonly string[]> {`；在 `const target = join(sessionsDir, \`${sessionId}.json\`)` 与 `await assertRegularOrMissing(target)` 之后（紧接 `const timestamp = authorityTimestamp()` 之前，即函数里第一次 `assertRegularOrMissing(target)` 之后）插入：

```ts
  // 写本会话绑定之前先移交：删除其他会话对同一 Change 的绑定（一个 Change 同时只绑一个会话）。
  const handedOver = await removeOtherSessionBindings(sessionsDir, name, sessionId)
```
并在该函数的 `finally { … }` 块之后（函数结束的 `}` 之前）加：

```ts
  return handedOver
```

(e) `cmdActivate` 里：

```ts
      try {
        await fs.bindTerminalSession(deps.cwd, name, options.hostSessionId)
        terminalSessionBound = true
      } catch (e) {
```
改为：

```ts
      try {
        const handedOver = await fs.bindTerminalSession(deps.cwd, name, options.hostSessionId)
        terminalSessionBound = true
        for (const previous of handedOver) deps.io.err(`[activate] 已从会话 ${previous} 移交 ${name}`)
      } catch (e) {
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/session.test.ts packages/cli/src/session.integration.test.ts && npm run build:packages`
Expected: vitest 全部 PASS；`tsc -b` 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/session.ts packages/cli/src/commands/session.test.ts packages/cli/src/session.integration.test.ts
git commit -m "feat(cli): hand a Change over to the activating session and delete the old binding" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: kernel——账本 replay 不得吞掉撤销后的重新确认；`reviewGateRevokePatch`

**Files:**
- Modify: `packages/kernel/src/decision/review-application.ts`（import 与 replay 分支，约第 169-190 行）
- Modify: `packages/kernel/src/decision/review-application.test.ts`（新增用例）
- Modify: `packages/kernel/src/state/review-gate.ts`（新增 `reviewGateRevokePatch`）、`packages/kernel/src/state/index.ts:96-98`（导出）
- Create: `packages/kernel/src/state/review-gate-revoke.test.ts`
- Test: 上述两个测试文件

**Interfaces:**
- Consumes: 现有 `reviewGateStatus`、`REVIEW_GATE_PENDING`、`REVIEW_GATE_APPROVED`、`reviewGateApprovalPatch`、`reviewGateRequestPatch`。
- Produces: `reviewGateRevokePatch(): Partial<Record<FieldName, string>>`——`{ review_gate_status: 'pending', review_acknowledged_at: '', review_acknowledged_via: 'unknown' }`，不动 `review_gate_phase / event / review_requested_at`；从 `@tenon/kernel` 导出。`executeReviewAcknowledge` 行为改为：账本命中同 key 的已批准记录，但当前回执是 `pending` 时不走 replay，按正常路径重新批准并追加一条账本记录。

- [ ] **Step 1: 写失败测试**

`packages/kernel/src/decision/review-application.test.ts`：在 `it('replays a stored success, clears the marker and runs no other side effect', …)` 之后追加：

```ts
  it('does not replay a stored approval while the receipt is pending again: a revoked approval is approved again', async () => {
    const approved = fixture()
    expect(await executeReviewAcknowledge(approved.ports)).toMatchObject({ ok: true, code: 'approved' })
    // `tenon review revoke` returns the receipt to pending with the same requestedAt, binding and state digest, so the
    // terminal key is identical and the ledger still holds the old approval for it.
    const revoked = fixture({ ledger: approved.getLedger() })
    const result = await executeReviewAcknowledge(revoked.ports)
    expect(result).toMatchObject({ ok: true, code: 'approved', changed: true, idempotent: false })
    expect(revoked.writes).toEqual(['state', 'ledger', 'interaction', 'history', 'marker'])
    expect(revoked.getState().fields).toMatchObject({ review_gate_status: 'approved' })
    expect(revoked.getLedger().split('\n').filter(Boolean)).toHaveLength(2)
  })
```

新建 `packages/kernel/src/state/review-gate-revoke.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { emptyFields, type PipelineState } from '../index.js'
import type { FieldName } from '../types.js'
import {
  reviewGateApprovalPatch,
  reviewGateApprovedFor,
  reviewGatePendingFor,
  reviewGateRequestPatch,
  reviewGateRevokePatch,
} from './review-gate.js'

const REQUESTED_AT = '2026-10-07T00:00:00.000Z'
const ACKNOWLEDGED_AT = '2026-10-07T00:01:00.000Z'

function stateWith(patch: Partial<Record<FieldName, string>>): PipelineState {
  return { fields: { ...emptyFields(), phase: 'spec', ...patch }, opaqueTail: '' } as PipelineState
}

describe('reviewGateRevokePatch', () => {
  it('returns an approved receipt to pending for the same event and keeps requestedAt', () => {
    const approved = stateWith({
      ...reviewGateRequestPatch('spec', 'spec-complete', REQUESTED_AT),
      ...reviewGateApprovalPatch(ACKNOWLEDGED_AT, 'terminal'),
    })
    expect(reviewGateApprovedFor(approved, 'spec', 'spec-complete')).toBe(true)

    const revoked = stateWith({
      ...reviewGateRequestPatch('spec', 'spec-complete', REQUESTED_AT),
      ...reviewGateApprovalPatch(ACKNOWLEDGED_AT, 'terminal'),
      ...reviewGateRevokePatch(),
    })
    expect(reviewGatePendingFor(revoked, 'spec', 'spec-complete')).toBe(true)
    expect(reviewGateApprovedFor(revoked, 'spec', 'spec-complete')).toBe(false)
    expect(revoked.fields.review_requested_at).toBe(REQUESTED_AT)
    expect(revoked.fields.review_acknowledged_at).toBe('')
    expect(revoked.fields.review_acknowledged_via).toBe('unknown')
  })

  it('touches only the status and the acknowledgement fields', () => {
    expect(Object.keys(reviewGateRevokePatch()).sort()).toEqual([
      'review_acknowledged_at', 'review_acknowledged_via', 'review_gate_status',
    ])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/kernel/src/decision/review-application.test.ts packages/kernel/src/state/review-gate-revoke.test.ts`
Expected: FAIL——`does not replay a stored approval…`：`expected [ 'marker' ] to deeply equal [ 'state', 'ledger', … ]`（命中 replay，只清了标记）；`review-gate-revoke.test.ts`：`reviewGateRevokePatch is not a function`（或 TS 导入错误）。

- [ ] **Step 3: 写最小实现**

`packages/kernel/src/state/review-gate.ts`：在 `reviewGateApprovalPatch` 之后新增：

```ts
/**
 * 撤回一份已批准、尚未被 transition 消费的回执：回到同一 event 的待确认。phase / event / requestedAt 不动，
 * 所以 `.pipeline-review-gate-binding.json` 仍然匹配，用户确认时走原来的绑定校验（决策状态已变则要求重新 request）。
 */
export function reviewGateRevokePatch(): Partial<Record<FieldName, string>> {
  return {
    review_gate_status: REVIEW_GATE_PENDING,
    review_acknowledged_at: '',
    review_acknowledged_via: 'unknown',
  }
}
```

`packages/kernel/src/state/index.ts` 第 96-97 行导出列表改为（加入 `reviewGateRevokePatch`）：

```ts
export {
  clearReviewGatePatch, reviewGateApprovedFor, reviewGateApprovalPatch, reviewGateEvent, reviewGateMatches,
  reviewGatePendingFor, reviewGateRequestPatch, reviewGateRevokePatch, reviewGateStatus, REVIEW_GATE_APPROVED, REVIEW_GATE_PENDING,
} from './review-gate.js'
```

`packages/kernel/src/decision/review-application.ts`：import 增加 `REVIEW_GATE_PENDING`：

```ts
import {
  REVIEW_GATE_PENDING,
  reviewGateApprovalPatch,
  reviewGateApprovedFor,
  reviewGateEvent,
  reviewGateStatus,
  type ReviewAcknowledgedVia,
} from '../state/review-gate.js'
```
并把 replay 分支的条件

```ts
      if (prior.kind === 'replay') {
```
改为：

```ts
      // 账本里的已批准记录只在回执仍是已批准（或已被消费）时才代表「重复确认」。回执又变回 pending（`tenon review
      // revoke` 沿用同一 requestedAt / 绑定 / 摘要，终端与 delegated 的 key 因此不变）时，旧记录不能替它回答：
      // 走正常路径重新批准，并追加新的账本记录（同 key、同 payload，lookup 取第一条，两条等价）。
      if (prior.kind === 'replay' && reviewGateStatus(state) !== REVIEW_GATE_PENDING) {
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/kernel/src/decision/review-application.test.ts packages/kernel/src/state/review-gate-revoke.test.ts packages/kernel/src/decision/idempotency.test.ts packages/server/src/serverDecisionRoutes.test.ts`
Expected: 全部 PASS（原有 replay / 幂等 / Dashboard 路由用例不变：它们的回执在 replay 时是 approved 或已被消费）。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/state/review-gate.ts packages/kernel/src/state/index.ts packages/kernel/src/state/review-gate-revoke.test.ts packages/kernel/src/decision/review-application.ts packages/kernel/src/decision/review-application.test.ts
git commit -m "fix(kernel): a stored approval cannot answer for a receipt that is pending again" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `tenon review revoke <change> --reason <原因>`

**Files:**
- Create: `packages/cli/src/commands/review-revoke.ts`
- Create: `packages/cli/src/commands/review-revoke.integration.test.ts`
- Modify: `packages/cli/src/commands/review.ts:52-58`（`ReviewOpts`）、`:154-167`（分派与用法检查）、`:173-175`（try 内分派）
- Modify: `packages/cli/src/program-review.ts`
- Modify: `packages/cli/src/i18n/messages-review.ts`（`review.usage` 与新增文案）、`packages/cli/src/i18n/help-en-core.ts:117-120`、`packages/cli/src/i18n/agent-messages.test.ts:125`
- Modify: `docs/usage/cli-reference.md`、`docs/usage/zh-CN/cli-reference.md`、`docs/CONTRACT.md`
- Test: `packages/cli/src/commands/review-revoke.integration.test.ts`、`packages/cli/src/i18n/agent-messages.test.ts`、`packages/cli/src/i18n/review-messages.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `reviewGateRevokePatch`；kernel 的 `assertOwner`、`formatAuditDetail`、`reviewDecisionRef`、`selectReviewAnchor`、`reviewGateDecisionStateDigest`、`reviewGateEvent`、`reviewGateMatches`、`reviewGateStatus`、`REVIEW_GATE_PENDING`；CLI 的 `requireActor`、`recordHistory`（`./fields.js`）、`readReviewGateBindingForRequest`、`writeReviewMarker`（`./review-binding.js`）、`msg`。
- Produces:
  - `cmdReviewRevoke(deps: CliDeps, name: string, dir: string, opts: { readonly event?: string; readonly delegated?: boolean; readonly as?: string; readonly reason?: string }): Promise<number>`：0 = 已撤回；2 = 撤回已提交但评审标记写入失败；1 = 拒绝（不改状态）。
  - `ReviewOpts.reason?: string`；`cmdReview(deps, 'revoke', name, opts)` 分派到它。
  - 审计行：`kind: 'tool'`，`raw: 'review.revoked phase=… event=… receipt=decision:… acknowledged_at=… via=… reason=…'`，`actor` 为声明身份（`formatAuditDetail` 会把原因里的空白折成下划线）。

- [ ] **Step 1: 写失败测试**

新建 `packages/cli/src/commands/review-revoke.integration.test.ts`：

```ts
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REVIEW_GATE_BINDING_FILE, REVIEW_MARKER_PROTOCOL } from '@tenon/kernel'
import { freshHarness, type Harness } from '../integration-harness.js'

describe('真实 e2e —— review revoke（撤回已批准、未被消费的评审回执）', () => {
  let h: Harness
  const dir = (): string => join(h.cwd, 'openspec/changes/demo')
  const marker = (): string => join(h.cwd, '.pipeline-pending-review')

  beforeEach(async () => {
    h = await freshHarness()
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['check', 'demo'])).toBe(0)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  async function approveExploreExit(): Promise<void> {
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
  }

  test('撤回误记的批准：回到同一 event 的待确认，沿用 requestedAt 与绑定，重写评审标记并写审计行', async () => {
    await approveExploreExit()
    const bindingPath = join(dir(), REVIEW_GATE_BINDING_FILE)
    const binding = await readFile(bindingPath, 'utf8')
    const requestedAt = (JSON.parse(binding) as { requestedAt: string }).requestedAt

    expect(await h.run(['review', 'revoke', 'demo', '--reason', '串会话误确认'])).toBe(0)

    const state = await h.read('demo')
    expect(state).toMatch(/^review_gate_status: pending$/m)
    expect(state).toMatch(/^review_gate_event: explore-complete$/m)
    expect(await readFile(bindingPath, 'utf8')).toBe(binding)
    const projection = await readFile(marker(), 'utf8')
    expect(projection).toContain(`${REVIEW_MARKER_PROTOCOL}\n`)
    expect(projection).toContain('phase=explore\n')
    expect(projection).toContain('change=demo\n')
    expect(projection).toContain('event=explore-complete\n')
    expect(projection).toContain(`requested_at=${requestedAt}\n`)
    const history = await readFile(join(dir(), '.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('review.revoked phase=explore event=explore-complete')
    expect(history).toMatch(/review\.revoked [^"]*receipt=decision:[0-9a-f]{16}/u)
    expect(history).toContain('reason=串会话误确认')
    expect(history).toContain('"actor":{"id":"tester@tenon.test"')
  })

  test('撤销后门重新拦住；用户重新确认（账本里的旧批准记录不能吞掉它）后可以流转', async () => {
    await approveExploreExit()
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '串会话误确认'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(2)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^review_gate_status: approved$/m)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: spec$/m)
  })

  test('缺少 --reason 或原因非法时拒绝，状态与标记不变', async () => {
    await approveExploreExit()
    const before = await h.read('demo')
    expect(await h.run(['review', 'revoke', 'demo'])).toBe(1)
    expect(h.err.join('\n')).toContain('--reason')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '   '])).toBe(1)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'x'.repeat(201)])).toBe(1)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'a\nb'])).toBe(1)
    expect(await h.read('demo')).toBe(before)
    await expect(stat(marker())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('回执不存在、本就待确认、或已被 transition 消费时拒绝，状态与标记不变', async () => {
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '没有回执'])).toBe(1)
    expect(h.err.join('\n')).toContain('没有评审回执')

    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const pending = await h.read('demo')
    const projection = await readFile(marker(), 'utf8')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '本就待确认'])).toBe(1)
    expect(h.err.join('\n')).toContain('本就待确认')
    expect(await h.read('demo')).toBe(pending)
    expect(await readFile(marker(), 'utf8')).toBe(projection)

    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    await h.run(['check', 'demo']) // 新 step visit 的第一条命令会落 phase skill，先让它落定再比较。
    const consumed = await h.read('demo')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '已消费'])).toBe(1)
    expect(await h.read('demo')).toBe(consumed)
  })

  test('撤销后决策状态已变化：确认被拒，对同一 event 重新 request 刷新回执与绑定后可以确认', async () => {
    await approveExploreExit()
    expect(await h.run(['set', 'demo', 'scope', 'changed-after-approval.ts'])).toBe(0)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '批准后范围变了'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(2)
    expect(await h.read('demo')).toMatch(/^review_gate_status: pending$/m)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
  })

  test('只有任务负责人能撤销；其它参数不适用于 revoke', async () => {
    await approveExploreExit()
    const before = await h.read('demo')
    expect(await h.run(['review', 'revoke', 'demo', '--reason', '不是负责人'], { env: { TENON_USER: 'b@x.io' } })).toBe(1)
    expect(await h.read('demo')).toBe(before)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'x', '--event', 'explore-complete'])).toBe(1)
    expect(await h.run(['review', 'revoke', 'demo', '--reason', 'x', '--delegated'])).toBe(1)
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete', '--reason', 'x'])).toBe(1)
    expect(h.err.join('\n')).toContain('--reason')
    expect(await h.read('demo')).toBe(before)
  })
})
```

`packages/cli/src/i18n/agent-messages.test.ts:125`：

```ts
    expect(zh('review.usage')).toBe('用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer]')
```
改为：

```ts
    expect(zh('review.usage')).toBe('用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer] | revoke <change> --reason <原因>')
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/review-revoke.integration.test.ts packages/cli/src/i18n/agent-messages.test.ts`
Expected: FAIL——revoke 用例得到 exit 1（`cmdReview` 的子命令检查把 `revoke` 当非法，stderr 是用法错误），`expected 1 to be 0`；`agent-messages.test.ts` 的 `review.usage` 断言失败。

- [ ] **Step 3: 写最小实现**

新建 `packages/cli/src/commands/review-revoke.ts`：

```ts
/**
 * `tenon review revoke <change> --reason <原因>` —— 撤回当前步已批准、尚未被 transition 消费的评审回执。
 *
 * 用途：误记的批准（例如串会话的放行语）在被 transition 消费之前可以正规撤回。撤销只会让状态更保守，所以 agent 可执行，
 * 不需要人在场证明；但必须写原因，且只认任务负责人（与 request 一致）。在 Change 锁内：只作用于「回执存在、属于当前 phase、
 * 状态是 approved」的情形，把它撤回为同一 event 的 pending（requestedAt 与 `.pipeline-review-gate-binding.json` 原样沿用），
 * 经 store.writeUnderLock 提交（canonical 与 .pipeline.yaml 投影同一次落盘）；锁外再重写 v2 评审标记并追加 `review.revoked`
 * 审计行。缺原因、回执不存在 / 本就待确认 / 已被消费、非负责人都拒绝，exit 1 且不改任何状态。
 * 与 acknowledge / transition 共用同一把 Change 锁，所以撤销与它们互斥。
 */
import {
  assertOwner,
  formatAuditDetail,
  reviewDecisionRef,
  reviewGateDecisionStateDigest,
  reviewGateEvent,
  reviewGateMatches,
  reviewGateRevokePatch,
  reviewGateStatus,
  selectReviewAnchor,
  REVIEW_GATE_PENDING,
} from '@tenon/kernel'
import type { PipelineState } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'
import { requireActor } from '../userIdentity.js'
import { recordHistory } from './fields.js'
import { readReviewGateBindingForRequest, writeReviewMarker } from './review-binding.js'

const REASON_MAX = 200

interface RevokedReceipt {
  readonly phase: string
  readonly event: string
  readonly requestedAt: string
  readonly acknowledgedAt: string
  readonly via: string
  readonly receipt: string
}

function scalar(state: PipelineState, field: keyof PipelineState['fields']): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

/** 一行、非空、≤200 字、不含控制字符；否则 null（审计行里不得出现换行或控制字符）。 */
function revokeReason(raw: string | undefined): string | null {
  const reason = (raw ?? '').trim()
  if (reason === '' || reason.length > REASON_MAX || /\p{Cc}/u.test(reason)) return null
  return reason
}

export async function cmdReviewRevoke(
  deps: CliDeps,
  name: string,
  dir: string,
  opts: { readonly event?: string; readonly delegated?: boolean; readonly as?: string; readonly reason?: string },
): Promise<number> {
  if (opts.event !== undefined || opts.delegated === true || opts.as !== undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'review.revoke.onlyReason')}`)
    return 1
  }
  const reason = revokeReason(opts.reason)
  if (reason === null) {
    deps.io.err(`ERROR: ${msg(deps, 'review.revoke.reasonRequired', { max: REASON_MAX })}`)
    return 1
  }
  const actor = requireActor(deps)
  if (actor === null) return 1

  let revoked: RevokedReceipt | undefined
  let refusal = ''
  await deps.store.withLock(dir, async () => {
    const state = await deps.store.read(dir)
    assertOwner(name, state.fields, actor)
    const phase = scalar(state, 'phase')
    const status = reviewGateStatus(state)
    if (status === null || !reviewGateMatches(state, phase)) {
      refusal = msg(deps, 'review.revoke.none', { phase })
      return
    }
    const event = reviewGateEvent(state)
    if (status === REVIEW_GATE_PENDING) {
      refusal = msg(deps, 'review.revoke.pending', { phase, event })
      return
    }
    const requestedAt = scalar(state, 'review_requested_at')
    const binding = await readReviewGateBindingForRequest(dir)
    const receipt = reviewDecisionRef(name, phase, event, selectReviewAnchor({
      phase,
      event,
      requestedAt,
      binding,
      decisionStateDigest: reviewGateDecisionStateDigest(state),
      runId: state.runMetadata?.runId,
    }), null).id
    const next: PipelineState = { ...state, fields: { ...state.fields, ...reviewGateRevokePatch() } }
    await deps.store.writeUnderLock(dir, next, { kind: 'set-many' })
    revoked = {
      phase,
      event,
      requestedAt,
      acknowledgedAt: scalar(state, 'review_acknowledged_at'),
      via: scalar(state, 'review_acknowledged_via'),
      receipt,
    }
  })
  if (refusal !== '') {
    deps.io.err(`ERROR: ${refusal}`)
    return 1
  }
  if (!revoked) throw new Error('review revoke 未产生结果')

  const markerOk = await writeReviewMarker(deps, revoked.phase, revoked.event, name, revoked.requestedAt)
  // 审计事件名按设计取 review.revoked；与 review:request / review:acknowledge 同为 kind=tool 的历史行，actor 是声明身份。
  await recordHistory(deps, dir, {
    ts: deps.clock(),
    kind: 'tool',
    raw: `review.revoked ${formatAuditDetail({
      phase: revoked.phase,
      event: revoked.event,
      receipt: revoked.receipt,
      acknowledged_at: revoked.acknowledgedAt,
      via: revoked.via,
      reason,
    })}`,
    actor,
  })
  deps.io.out(`[REVIEW] ${name} phase=${revoked.phase} event=${revoked.event} ${msg(deps, 'review.revoke.done', { reason })}`)
  return markerOk ? 0 : 2
}
```

`packages/cli/src/commands/review.ts`：

(a) 文件头注释第一行 `` `tenon review request|acknowledge` `` 改为 `` `tenon review request|acknowledge|revoke` ``，并在 import 区加：

```ts
import { cmdReviewRevoke } from './review-revoke.js'
```

(b) `ReviewOpts` 增加：

```ts
  /** revoke only: why an approved receipt is withdrawn (required, one line). */
  readonly reason?: string
```

(c) `cmdReview` 开头把

```ts
  if (sub !== 'request' && sub !== 'acknowledge') {
    deps.io.err(`ERROR: ${msg(deps, 'review.usage')}`)
    return 1
  }
```
改为：

```ts
  if (sub !== 'request' && sub !== 'acknowledge' && sub !== 'revoke') {
    deps.io.err(`ERROR: ${msg(deps, 'review.usage')}`)
    return 1
  }
  if (sub !== 'revoke' && opts.reason !== undefined) {
    deps.io.err(`ERROR: ${msg(deps, 'review.reasonOnRevoke')}`)
    return 1
  }
```
(d) `try {` 之后、`if (sub === 'request') {` 之前插入：

```ts
    if (sub === 'revoke') return await cmdReviewRevoke(deps, name, dir, opts)
```

`packages/cli/src/program-review.ts`：

```ts
  program
    .command('review <sub> [name]')
    .description('review 出口确认：request <change> --event <event>（请求 review）/ acknowledge <change> [--delegated] [--as reviewer]（写精确 receipt；只认负责人，非负责人以评审人身份确认要加 --as reviewer）/ revoke <change> --reason <原因>（把已批准、未被消费的回执撤回为待确认；只认负责人）')
    .option('--event <event>', 'request 时绑定的确切 transition event；多出口 review step 必填')
    .option('--delegated', '仅用户已明确委托当前 Change 连续执行时，按该委托写审计化 review receipt')
    .option('--as <role>', '仅 acknowledge：非负责人以评审人身份确认（只支持 reviewer，角色与负责人记进历史）')
    .option('--reason <text>', '仅 revoke：撤回已批准回执的原因（必填，一行，不超过 200 字）')
    .action(async (sub: string, name: string | undefined, opts: { event?: string; delegated?: boolean; as?: string; reason?: string }) =>
      bail(await cmdReview(deps, sub, name, opts)))
```
（`interaction` 子命令块保持不变。）

`packages/cli/src/i18n/messages-review.ts`：把 `'review.usage'` 改为

```ts
  'review.usage': {
    zh: '用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer] | revoke <change> --reason <原因>',
    en: 'usage: tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer] | revoke <change> --reason <text>',
  },
```
并在 `'review.request.asOnAcknowledge'` 条目之后新增：

```ts
  'review.reasonOnRevoke': {
    zh: '--reason 只可用于 review revoke',
    en: '--reason applies to review revoke only',
  },
  'review.revoke.onlyReason': {
    zh: 'review revoke 只接受 --reason；--event、--delegated 与 --as 不适用',
    en: 'review revoke takes --reason only; --event, --delegated and --as do not apply',
  },
  'review.revoke.reasonRequired': {
    zh: 'review revoke 需要 --reason <原因>：一行说明为什么撤回，不超过 {max} 字且不含控制字符',
    en: 'review revoke needs --reason <text>: one line saying why the approval is withdrawn, at most {max} characters and no control characters',
  },
  'review.revoke.none': {
    zh: "phase '{phase}' 当前没有评审回执（未请求，或已被 transition 消费），没有可撤回的批准",
    en: "phase '{phase}' has no review receipt (none requested, or already consumed by a transition); there is no approval to withdraw",
  },
  'review.revoke.pending': {
    zh: "phase '{phase}' 的 event '{event}' 本就待确认，无需撤回",
    en: "event '{event}' of phase '{phase}' is already waiting for confirmation; nothing to withdraw",
  },
  'review.revoke.done': {
    zh: '已撤回已批准的回执，恢复为待确认；评审标记已重新写入（原因：{reason}）',
    en: 'the approved receipt is withdrawn and waits for confirmation again; the review marker is rewritten (reason: {reason})',
  },
```

`packages/cli/src/i18n/help-en-core.ts`：把 `review:` 条目（第 117 行）改为

```ts
  review: 'Review exit confirmation: request <change> --event <event> (ask for a review) / acknowledge <change> [--delegated] [--as reviewer] (write the exact receipt; only the owner may; a non-owner confirms as a reviewer with --as reviewer) / revoke <change> --reason <text> (turn an approved, unconsumed receipt back into a pending one; only the owner may)',
```
并在 `'review --as'` 条目之后新增：

```ts
  'review --reason': 'revoke only: why the approved receipt is withdrawn (required, one line, at most 200 characters)',
```

文档（每个行内代码保持在同一行，`npm run check:docs` 会检查跨行的含 `<` 的行内代码）：

- `docs/usage/cli-reference.md`：在 `tenon review acknowledge <change> [--delegated] [--as reviewer]` 那行（命令块里）之后加一行 `tenon review revoke <change> --reason <text>`；并在以 `` `review acknowledge` exit codes `` 开头的段落之后新增一段：

```markdown
`review revoke <change> --reason <text>` withdraws an approval given by mistake. It turns the current step's approved, not yet consumed receipt back into a pending one for the same event (same `requestedAt` and binding), rewrites the review marker so the gate holds again, and appends a `review.revoked` row (actor, reason, receipt id, event) to the change history. Only the task owner may run it, and `--reason` is required (one line, at most 200 characters). It refuses and writes nothing when the reason is missing, when the receipt is already pending, when there is none, or when a transition already consumed it (exit `1`). If the decision state changed after the approval, the next `review acknowledge` fails on the stale binding; run `review request` for the same event to refresh it.
```

- `docs/usage/zh-CN/cli-reference.md`：在命令块 `tenon review acknowledge <change> --as reviewer` 之后加一行 `tenon review revoke <change> --reason <原因>`；在以 `` `review acknowledge` 退出码 `` 开头的段落之后新增：

```markdown
`review revoke <change> --reason <原因>` 撤回误给的批准：把当前步已批准、尚未被 transition 消费的回执撤回为同一 event 的待确认（沿用原 `requestedAt` 与绑定），重写评审标记让门重新拦住，并在 change 历史追加一行 `review.revoked`（操作者、原因、回执标识、event）。只有任务负责人能执行，`--reason` 必填（一行，不超过 200 字）。原因缺失、回执本就待确认、不存在或已被 transition 消费时拒绝且不写任何东西（退出码 `1`）。批准之后决策状态变过的话，下一次 `review acknowledge` 会因绑定失效被拒；对同一 event 重新 `review request` 即可刷新。
```

- `docs/CONTRACT.md`：在以「`default` 的 `verify-fail` 是内建回退 event」开头的那条之前，紧接「…不能绕过 canonical exit check。」之后新增：

```markdown
  误给的批准在被 `transition` 消费之前可以撤回：`pipeline review revoke <name> --reason <原因>` 在 Change 锁内把当前步 approved 且未消费的回执撤回为同一 event 的 pending（沿用 `review_requested_at` 与绑定），重写 v2 marker，写 `review.revoked` 审计行；只有任务负责人能执行，缺原因、已消费、本就待确认或无回执一律拒绝且不改状态。终端与 delegated 的幂等账本不得让撤销后的重新确认退化成空操作（回执为 pending 时账本里的旧批准记录不参与 replay）。
```

- [ ] **Step 4: 运行确认通过**

Run:
```bash
npx vitest run packages/cli/src/commands/review-revoke.integration.test.ts packages/cli/src/commands/review.integration.test.ts packages/cli/src/i18n/agent-messages.test.ts packages/cli/src/i18n/review-messages.test.ts packages/cli/src/i18n/i18n.test.ts
npm run build:packages
npm run check:docs
```
Expected: vitest 全部 PASS（`review-messages.test.ts` 会校验新增 `review.*` 文案的 `en` 无中日韩字符且占位符与 `zh` 一致；`i18n.test.ts` 的帮助覆盖检查会校验 `review --reason` 的英文已登记）；`tsc -b` 无错误；`check:docs` 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/review-revoke.ts packages/cli/src/commands/review-revoke.integration.test.ts packages/cli/src/commands/review.ts packages/cli/src/program-review.ts packages/cli/src/i18n/messages-review.ts packages/cli/src/i18n/help-en-core.ts packages/cli/src/i18n/agent-messages.test.ts docs/usage/cli-reference.md docs/usage/zh-CN/cli-reference.md docs/CONTRACT.md
git commit -m "feat(cli): review revoke withdraws an approved receipt back to pending" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 重新生成 tracked bundle 并做全量验收

**前置条件：** 改动 `tools/test-hooks.sh` 里的动画门夹具前，执行者须先在当前步加载 `tenon:gsap-core`（动画门要求）。

**Files:**
- Modify: `packages/cli/dist/tenon.mjs`（`npm run bundle` 生成）
- Modify: `packages/server/dist/dashboard.mjs`（`npm run build:server` 生成；kernel 的评审确认应用同时进入 server bundle）
- Test: 全套验收命令

**Interfaces:**
- Consumes: Task 1-9 的全部源码改动。
- Produces: 与源码一致的 tracked bundle；验收证据。

- [ ] **Step 1: 构建并重新生成 bundle**

Run:
```bash
npm run build:packages
npm run bundle
npm run build:server
git status --short packages/cli/dist packages/server/dist
```
Expected: `tsc -b` 无错误；`git status` 只显示 `M packages/cli/dist/tenon.mjs` 与 `M packages/server/dist/dashboard.mjs`（若 server bundle 没有变化则只有前者，这是允许的）。不要手改 dist。

- [ ] **Step 2: 跑全量验收**

Run（逐条，全部通过才算过）：
```bash
bash tools/test-hooks.sh 2>&1 | grep -E '^(FAIL|[0-9]+ passed)'
bash tools/test-adapters.sh 2>&1 | tail -3
bash tools/verify-skills.sh
bash tools/test-bundle.sh
npm run check:comments
npm run check:docs
npm run check:architecture
npx vitest run packages/kernel/src/decision/review-application.test.ts packages/kernel/src/state/review-gate-revoke.test.ts packages/cli/src/commands/review-revoke.integration.test.ts packages/cli/src/commands/review.integration.test.ts packages/cli/src/commands/session.test.ts packages/cli/src/session.integration.test.ts packages/cli/src/terminal-activity-hook.integration.test.ts packages/cli/src/i18n/agent-messages.test.ts packages/cli/src/i18n/review-messages.test.ts packages/server/src/serverDecisionRoutes.test.ts
npm test
```
Expected: `test-hooks` `N passed, 0 failed`；`test-adapters` / `verify-skills` / `test-bundle` 无失败；三个 `check:*` 通过；定向 vitest 全部 PASS；`npm test`（含 `pretest` 的 `build:packages`）全绿。任何一条红：回到对应 Task 修，不在本 Task 里临时改源码。

- [ ] **Step 3: 确认 bundle 与源码一致**

Run: `npm run bundle && git diff --stat packages/cli/dist/tenon.mjs`
Expected: 第二次生成后没有新的 diff（与 Step 1 提交前的工作区内容一致，说明 bundle 新鲜）。

- [ ] **Step 4: Commit**

```bash
git add packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs
git commit -m "build: regenerate the CLI and dashboard server bundles for session isolation and review revoke" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
（若 `packages/server/dist/dashboard.mjs` 没有变化，`git add` 不会报错，提交里只含 CLI bundle。）

---

### Task 11: 已污染状态的处理（交付步执行）

**执行时机：** 本 Task 不改源码，**只在交付步执行**，且必须在 Task 9 的撤销命令与 Task 10 的新 bundle 经本地运行时重装（Part B 的安装流程）之后。它处理的是 `setup-host-agents-step-progress` 与 `unify-stage-skill-canvas` 两个其它任务的状态，所以不产生本任务的提交；这些任务的状态文件由它们各自的流程提交。

**Files:**
- Modify（追加一行，不删原行）: `openspec/changes/setup-host-agents-step-progress/.pipeline-history.jsonl`
- Modify（经 CLI）: `setup-host-agents-step-progress` 的评审回执

**Interfaces:**
- Consumes: kernel `createHistoryWriter`（`packages/kernel/src/state/history.ts`，`append(changeDir, entry)`）与 `formatAuditDetail`（`packages/kernel/src/test-system/audit.ts`），均从 `packages/kernel/dist/index.js` 导出；Task 9 的 `tenon review revoke`。
- Produces: 一条更正历史行；该任务规格步的评审回到待确认。

- [ ] **Step 1: 记录追加前的指纹（确认原行不会被改）**

Run:
```bash
wc -l openspec/changes/setup-host-agents-step-progress/.pipeline-history.jsonl
head -n 65 openspec/changes/setup-host-agents-step-progress/.pipeline-history.jsonl | shasum -a 256
```
Expected: 行数 `65`（若已不是 65，先停下核对：说明那个任务又有新历史，更正事件仍只列第 18-24 与 63 行，但指纹要对当时的实际行数取）；记下 sha256。

- [ ] **Step 2: 经 kernel 的 history writer 追加更正事件**

CLI 没有现成追加入口，所以用一次性 node 调用（不手写 jsonl）。`TENON_USER` 要设成操作者自己的声明身份，行里的 `actor` 取自它：

```bash
TENON_USER="<操作者的声明身份，例如 710227704@qq.com>" TENON_USER_NAME="<显示名>" node --input-type=module -e '
import { createHistoryWriter, formatAuditDetail } from "./packages/kernel/dist/index.js"
const id = process.env.TENON_USER
const actor = id ? { id, name: process.env.TENON_USER_NAME || id.split("@")[0], trust: "declared" } : undefined
const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
const raw = "history:correction " + formatAuditDetail({
  lines: "18-24,63",
  source_session: "4f9542da-59e8-40c2-9bf5-5324115f6498",
  source_events: "2026-10-07T10:02_brainstorming_and_openspec-explore_loads;2026-10-07T10:34_systematic-debugging",
  note: "these_rows_came_from_another_conversation_and_are_not_evidence_for_this_task;original_rows_kept",
})
await createHistoryWriter().append("openspec/changes/setup-host-agents-step-progress", { ts, kind: "tool", raw, ...(actor === undefined ? {} : { actor }) })
'
```
Expected: 无输出、退出码 0。

- [ ] **Step 3: 确认只追加了一行、原 65 行不变**

Run:
```bash
wc -l openspec/changes/setup-host-agents-step-progress/.pipeline-history.jsonl
head -n 65 openspec/changes/setup-host-agents-step-progress/.pipeline-history.jsonl | shasum -a 256
tail -n 1 openspec/changes/setup-host-agents-step-progress/.pipeline-history.jsonl
```
Expected: 行数 `66`；前 65 行的 sha256 与 Step 1 完全一致；最后一行含 `history:correction lines=18-24,63 source_session=4f9542da-59e8-40c2-9bf5-5324115f6498`，且是合法 JSON。更正只是信息性的，不改证据求值逻辑：该任务已离开调研步，求值不追溯；交付说明里写明影响——它调研步要求的 `openspec-explore` 实际没加载过。

- [ ] **Step 4: 撤销误记的规格批准**

用户已让那个会话先停在规格步（未被 transition 消费）。运行：

```bash
tenon review revoke setup-host-agents-step-progress --reason "跨会话放行语误确认（2026-10-07 10:39）"
```
Expected: 输出 `[REVIEW] setup-host-agents-step-progress phase=spec event=spec-complete 已撤回已批准的回执，恢复为待确认…`，退出码 0；`tenon status setup-host-agents-step-progress --json` 的 `step.review.status` 为 `pending`；项目根 `.pipeline-pending-review` 重新出现。若退出码 1，按输出的原因处理：「已被消费」说明那个会话已经流转，此路不通，改为向用户报告，不要绕过。

- [ ] **Step 5: 补齐画布任务的技能证据（本任务完结后、在会话里做，不是命令）**

`unify-stage-skill-canvas` 缺的调研技能证据：本任务完结后，在会话里恢复该任务（`tenon session activate unify-stage-skill-canvas --host-session <新会话 id>` 会把绑定从旧 id `4f9542da-59e8-40c2-9bf5-5324115f6498` 移交过来，stderr 会写「已从会话 … 移交」），再重新加载它调研步要求的技能补齐证据。

- [ ] **Step 6: 不提交**

这一步不 `git add`：`setup-host-agents-step-progress` 的目录当前是未跟踪的工作区状态，它的历史文件随它自己的交付提交处理；本 Task 只在最终回复里写明追加了一行、撤销了一份回执，以及第 25 行（10:03:14）经主线判断属于该任务自己的 brainstorming（被本会话交互标记拦下时记的），不属于串单，所以更正事件不列它。

---

## Part B — 源码开发安装与漂移检查

B 部分单独成文：`docs/superpowers/plans/fix-hook-cross-session-isolation-part-b.md`（17 个 Task）。要点：

- Task 1 是一次实验：在隔离 HOME 里实测两个宿主的本地目录 marketplace，结论写进该文件的「Spike 结论」表，后续 Task 按结论分支。
- Task 2-13 是 CLI / kernel / server 改动，与 A 部分文件不重叠，可以和 A 部分并行。
- Task 14 改 `hooks/session-start.sh`、`hooks/auto-update.sh` 与 `tools/test-hooks.sh`，与 A 部分共享文件，必须在 A 部分 Task 1-6 合入之后做。
- Task 16 重新生成 tracked bundle；A 部分 Task 10 也会生成，两部分都完成后以最后一次 `npm run build` 为准。
- Task 17（本机切到源码开发安装）只在交付步、用户确认后执行；回退用 `tenon update --claude --to-stable`。

执行顺序：A 部分 Task 1-9 与 B 部分 Task 1-13 可并行，各自在独立 worktree；随后 B 部分 Task 14-16；最后 A 部分 Task 10 的全量验收覆盖两部分。A 部分 Task 11 与 B 部分 Task 17 都在交付步执行。

---

## Part C — 步骤测试豁免（验证步加入，用户确认）

背景与决定见设计文档 §8 与 delta spec `step-test-waiver`。C 部分只有一个 Task，由 builder 在实现步按 TDD 完成；代码已落在下列文件里，本节记录决定与验收，不重抄实现。

**Review Focus（C 部分）**：spec 隐含、最可能出问题的输入，每条后面写明由哪个用例钉住。

1. 豁免批准之后代码又变了：记录过期，必须重跑，已批准的豁免不能放行旧结果。（集成测试「豁免只覆盖新鲜的失败」）
2. 豁免在评审请求之后才登记，或理由改过：这次确认不批准它，转换仍被拒。（沿用 `approveWaivers` 的冻结清单规则；`plan-waivers.test.ts` 的 `test:` 键用例）
3. 测试计划被手改（摘要与台账不符）：豁免一律不生效，判定与评审者提示都不认它。实现已如此，用例缺失，由 Step 7 在 `evaluate-v2.test.ts` 补。
4. 理由里有换行：评审者提示按单行折叠，不打乱提示词结构。实现已如此，用例缺失，由 Step 7 在 `agent-prompt.test.ts` 补。
5. 自定义工作流的步骤有测试、没有 `test_policy`：豁免登记得进但不生效。这是已知限制，写进文档，不做拦截。

### Task C1: `tenon test waive --test <步骤测试>`

**Files:**
- kernel：
  - `packages/kernel/src/workflow/compile-tests.ts`：导出 `isStepTestId`。
  - `packages/kernel/src/test-system/plan.ts`：`test` 键、三选一、`waiverKey`、序列化。
  - `packages/kernel/src/test-system/review-waivers.ts`：冻结清单接受 `test:`。
  - `packages/kernel/src/test-system/evaluate-v2.ts`：`evaluateInline` 的豁免判定。
  - `packages/kernel/src/test-system/evaluate-types.ts`、`blockers.ts`：新状态与提示码。
  - `packages/kernel/src/test-evidence/evaluate.ts`：证据项的 `waiver`、`testItemSettled`。
- CLI：
  - `packages/cli/src/commands/test-register.ts`、`program-tests.ts`、`i18n/help-en-tests.ts`、`test-system/plan-edit.ts`、`commands/test-plan.ts`：命令、帮助与显示。
  - `packages/cli/src/commands/statusStep.ts`、`statusStepNext.ts`、`statusStepTests.ts`、`agentGate.ts`、`agent-tests-ready.ts`、`statusStepAgents.ts`、`verdictFieldGate.ts`：编排与就绪。
  - `packages/cli/src/commands/agent.ts`、`agent-prompt.ts`、`agent-prompt-tests.ts`、`test-system/report-md.ts`：提示与报告。
- server / Dashboard：只同步 DTO、解码器与状态词。
  - `packages/server/src/testSystemDto*.ts`、`workflowOrchestration.ts`。
  - `packages/dashboard-app/src/api/testSystem*.ts`、`testPolicyDecoders.ts`、`tests/TestState.tsx`、`workspace/testsTabModel.ts`、`i18n/testsShared.ts`。
- 文档：`docs/usage/{,zh-CN/}cli-reference.md`、`docs/usage/{,zh-CN/}default-workflow.md`。
- Test：
  - 新增 `packages/cli/src/test-waive-step.integration.test.ts`（真 CLI、真失败步骤测试）。
  - 修改旁边对应的 `*.test.ts`（plan、plan-waivers、review-waivers、evaluate-v2、evaluate-policy、compile-tests、statusStepTests、agent-prompt、plan-edit、server 两个路由测试、dashboard 解码器）。

- [x] **Step 1: 写失败测试**：
  - 计划 `test:` 往返、三选一与非法 id 报错；
  - 冻结清单读回 `test:` 键；
  - `evaluateInline` 五种情形：已批准、未批准、无豁免、过期或未运行带豁免、通过；
  - `next` 排序：待批准不出 `run-test` 而出 `request-review` 并列出 `test:<id>`，已批准且评审已确认可转换，无豁免仍 `run-test`；
  - 评审者提示的豁免行；
  - 集成测试的登记、撤销、互斥、未知 id 退出 2，以及「代码变了已批准豁免也不放行」。
- [x] **Step 2: 确认红**：kernel 16 条、CLI 若干条因功能缺失失败（见 builder 报告 `e63d3b1b…`）。
- [x] **Step 3: 实现**：按设计文档 §8。
- [x] **Step 4: 确认绿**，每条一次：
  - `npx vitest run` 跑上述测试文件；
  - `npx tsc -b packages/kernel packages/channel packages/tap packages/automation packages/cli packages/server`；
  - `npm run typecheck:web`；
  - `node tools/check-architecture.mjs`；
  - `node tools/check-docs.mjs`。
- [x] **Step 5: 重新生成入库产物**：`npm run build`。dashboard-app 的 dist 换了带哈希的资产文件名，交付提交要带上新增与删除。
- [ ] **Step 7: 补 Review Focus 第 3、4 条的用例**（实现步）：
  - `evaluate-v2.test.ts`：计划状态为 `tampered` 时，失败的步骤测试即使计划文本里有已批准的 `test:<id>` 豁免，仍是 `test-failed`。
  - `agent-prompt.test.ts`：理由含 `\n` 与连续空格时，豁免行是单行，且空白折成单个空格。
  - 跑法：`npx vitest run` 这两个文件，预期全绿。实现已存在，所以这是先绿的回归钉子：临时去掉折叠或计划状态判断，确认会转红，再恢复。
- [ ] **Step 6: 验证步**，按以下顺序：
  1. 本机切到源码开发安装（B 部分 Task 17，用户确认后），让新 CLI 判定；
  2. 用 `tenon test unregister <c> --waiver code-size` 撤掉无效的种类豁免；
  3. 用 `tenon test waive <c> --test code-size --reason …` 登记，再跑阶段测试；
  4. 验证评审门上由用户批准。

---

## Part D — 验证评审后的修正（第二轮验证后加入，用户逐条确认）

背景与决定见设计文档 §9 与三份 delta spec 的新增条目。三组由 builder 串行完成（同一检出不并发写），报告见 `.pipeline-agent-reports/d4f512f7…`（三组各一节，末尾为主线合成）。代码已落地，本节只记决定与验收。

**Review Focus（D 部分）**：

1. 宿主不给会话 id。交互标记走单个文件，拦截与解锁行为与修改前相同。（D1 的 §15d / §15f 无会话 id 用例）
2. 用户在 Claude Code 里用 `!` 前缀自己运行 `tenon review acknowledge`。这类命令不经模型的 Bash 工具，预期不触发 PreToolUse，不被拦；若宿主实际会触发，用户仍可回复放行语或用 Dashboard 确认。这一条没有自动化用例，交付说明里写明。
3. 批准后代码变了、同一测试再失败。转换被拒，`next` 点名 `review revoke`，撤回后重新请求能再次批准。（D2 端到端用例）
4. 两个会话并发 `session activate` 同一 Change，最终恰好一个绑定；写失败时旧绑定保留。（D3 `session-binding.test.ts`）
5. 只提交文档、不改安装内容时不出现漂移提示；路径含空格时提示里的命令可直接执行。（D1 §13c 用例）

### Task D1：hook 组

- [x] 交互标记按会话分文件。涉及 `hooks/pending-marker.sh`、`gate.sh`、`confirm-clear-prompt.sh`，kernel 指纹排除，CLI 的 `gitWorkspace` / `gateMarkers` / `advance` / `doctor`。
- [x] agent 不能执行手动 `tenon review acknowledge`（`gate.sh` 的 `pipeline_command_runs_manual_acknowledge`）。用例覆盖 `bash -c`、`env`、`npx`、`node …/tenon.mjs`、串接、注释与 `--` 之后的 `--delegated`。
- [x] gate 评审分支用 `pipeline_hook_session_id`。
- [x] 漂移提示路径：含控制字符不输出，命令里 `printf %q`。
- 验收：`npm run test:hooks` 1763 通过；kernel、CLI 套件通过。

### Task D2：kernel / CLI 豁免组

- [x] 批准绑定候选：冻结清单带 `candidate`，计划带 `approved_candidate`，判定与重新批准；端到端补「批准后代码变了」用例。
- [x] 拆分：`step-test-waivers.ts`、`evaluate-inline.ts`、`statusStepExits.ts`。`evaluate-v2.ts` 383 行，`statusStepNext.ts` 307 行。
- [x] 豁免理由标注自述、截短、去结构字符。
- [x] Dashboard 快照带 `waiver`。
- 验收：kernel 4097、CLI 3438、server 1314、Dashboard 1870 通过。

### Task D3：CLI 小项与文档组

- [x] `session-binding.ts`：先写后移交，在 Change 锁内完成。新测试覆盖写失败与 4 个会话并发。
- [x] 上游技能 id 校验：解析器已限制，补钉住用例。
- [x] 安装通道标记写失败清临时文件。
- [x] 会话标记符号移到 `kernel/state/markers.ts`，`types.ts` 445 行。
- [x] `templates/workflow.md`、`adapters/contract.md`、11 个适配器 README、5 个 `install.sh`、aider veto 提示、CLI 停下提示、两个 README、`docs/usage` 改为三条确认路径。
- 验收：kernel 4102、CLI 3447、hooks 1763 通过；`check-architecture`、`check-docs` 通过。adapters 套件由主线经 `tenon test run` 跑。

### Task D4：入库产物与验证（主线）

- [x] `npm run build` 重建入库产物（退出码 0）。
- [x] 登记新测试文件，跑 build 与 verify 阶段套件（含 adapters），重跑四个评审者（第三轮验证已执行：spec-consistency、security 各一条阻断，用户确认 verify-fail，转 Part E）。

---

## Part E — 第三、四轮验证评审后的 gate 加固（用户确认回退修复）

背景与决定见设计文档 §10。两组由 builder 串行完成，报告：`.pipeline-agent-reports/8f00c1b9…`（第三轮两条阻断，含花括号、转义编码与读取上限的追加）、`.pipeline-agent-reports/9cb026ca…`（第四轮三条阻断）。代码已落地，本节只记决定与验收。

**Review Focus（E 部分）**：

1. 被引号、反斜杠、`$'…'` 拆开的子命令词，以及转义编码、花括号拼出的子命令。（`tools/test-hooks.sh` 手动确认拦截表，评审挂起与无标记两种状态各跑一遍）
2. `--delegated` 来自含空白的引号串、带值选项的值、注释或别的命令段。（同上，含评审挂起时放行表不再命中 P1 写法）
3. 带值选项夹在 `review` 与子命令之间。（同上，`--as` / `--event` / `--reason` 与 `=` 写法）
4. 上限附近的密集载荷不超过 hook 时限。（性能用例，3 秒断言）
5. 判定库缺失。（预筛命中即失败关闭；`tools/verify-skills.sh` 检查库存在）

### Task E1：第三轮阻断（builder `8f00c1b9…`）

- [x] 预筛与判定改为先还原再判定：JSON 转义 ASCII、`\xHH` / `\NNN` / `\uHHHH` / `\UHHHHHHHH`、续行、反斜杠、引号与 `$'…'` / `$"…"` 的 `$`、花括号展开（超预算失败关闭）。
- [x] 还原出的字符垫 `\002`，`--delegated` 只认不带标记的原词。
- [x] 判定读取上限 512 KiB → 64 KiB，超过上限只做字面检查；拒绝提前到受保护路径判定之前；命令段切分改为线性。
- [x] 五处文档补写 `--from-source` 的已知风险。
- 验收：`npm run test:hooks` 1888 通过；`npm run check:docs` 通过；build 退出码 0。

### Task E2：第四轮阻断（builder `9cb026ca…`）

- [x] 判定移到 `hooks/lib/ack-command.sh`，`gate.sh` 1273 → 845 行；库缺失时预筛命中即拒绝；`tools/verify-skills.sh` 加存在性检查。
- [x] 含空白引号串里的词垫 `\003`，`--delegated` 不认它；整串 `<shell> -c "…"` 先取出再判定。
- [x] `review` 之后按 `review <sub> [name]` 与带值选项的真实结构找子命令，结构核对不了时退回宽判。
- [x] 花括号步长与认不出的组失败关闭；补 `arch`、`caffeinate`、`flock`、`tsx` 等包装器与源码 / 产物入口。
- [x] 已知误拦表固定现状（包装器后引号里只是提到子命令等）。
- 验收：`npm run test:hooks` 2115 通过；build 退出码 0；`node tools/check-architecture.mjs` 通过。

---

## Part F — 验证轮次上限（第四轮验证后用户提出，逐条确认）

**Goal:** build ⇄ verify 不再无休止回退：步骤有可声明、可覆盖的验证轮次上限，用完后停下交给用户，用户可以接受剩余阻断。

**Architecture:** 工作流步骤新增 `max_rounds` 键随计划冻结；任务字段 `max_rounds` 覆盖。kernel 新增纯函数按 canonical 转换链计当前轮次。CLI `next` 在 `exitActions` 里用完即改道，`review request` / `transition` 对回退边做强制拒绝；剩余阻断照搬步骤测试豁免的冻结 → 人工确认 → 候选绑定流程，在 `evaluateStepAgents` 一侧把已接受的评审者阻断视为已处置。

**Spec:** delta spec `openspec/changes/fix-hook-cross-session-isolation/specs/verify-round-limit/spec.md`；设计文档 §11；ADR 第 8 条。

### Global Constraints（F 部分）

- `max_rounds` 取值：1 到 20 的整数；工作流里只允许在设了评审门（`gate: review`）且至少有一条回退边的步骤上声明；这类步骤内置默认 2；没有评审门的步骤（build）不受约束。
- `default` 工作流五条轨道的 verify 步声明 `max_rounds: 2`；改 `templates/workflows/default.yaml` 后用 `npm run generate:default-workflow` 重新生成内置副本，`npm run check:default-workflow-freshness` 要通过。
- 任务字段 `max_rounds` 严格追加在 `packages/kernel/src/types.ts` 的 `FIELD_ORDER` 末尾（`review_acknowledged_via` 之后）。
- 轮次计数只读 canonical 转换记录链（`deps.recordStore.readChain` 加 `state.runMetadata`），没有链的旧任务读 `.pipeline-history.jsonl` 的 `kind: transition` 行；只数当前 run。
- 剩余阻断的键：`reviewer:<agent>`；委托确认与 AFK 不批准；批准绑定当前候选与评审者运行 id。
- 旧冻结计划（没有 `max_rounds`）照常读取、指纹不变，按内置默认 2。
- 新增 CLI 文案 `zh` / `en` 成对，`en` 不含中日韩字符；新增选项与字段同步 help。
- 测试不得读写真实的 `~/.claude`、`~/.codex`、`~/Library/Application Support/tenon`。

### Review Focus（F 部分）

1. **升级前冻结的计划**（本仓已有的在途任务，快照 v4 没有 `max_rounds`）：必须照常解码、指纹不变，上限按 2、来源 `default`。Task F1 用旧快照夹具钉住。
2. **`tenon set … max_rounds` 设得比当前轮次低**（第 2 轮时设为 1）：立即视为用完；调高到等于当前轮次仍是用完，只有大于当前轮次才恢复回退。Task F3 钉住。
3. **同一候选上评审者带 `--rerun-reason` 重跑**：接受只对被接受的那次运行有效，新运行结论不通过要重新接受。Task F4 钉住。
4. **自定义工作流里步骤有多条回退边、回退目标不相邻**：清零只在落到早于所有回退目标的步骤时发生，落到中间步骤不清零。Task F2 用自定义工作流夹具钉住。
5. **另一个 run 的转换记录**（任务被重新 init 或 run id 变化）：不计入当前轮次。Task F2 钉住。

### Task F1：工作流步骤声明 `max_rounds`

**Files:**
- Modify: `packages/kernel/src/workflow/parse.ts`（步骤键解析）、`types.ts` / `ir.ts`（`WorkflowStep.maxRounds?: number`）、`validate.ts`（取值与回退边校验）、`serialize.ts`、`compile.ts`（冻结进 effective plan）、`effective-plan*.ts` 与 `workflow-plan-snapshot*.ts`（新键进入新计划，旧快照照常读取）。
- Modify: `templates/workflows/default.yaml`（五条轨道 verify 步）→ 重新生成 `packages/kernel/src/workflow/default-workflow.generated.ts`。
- Modify: `packages/dashboard-app/src/api/governanceSchema.ts`、`governanceTypes.ts`、`workbench/workbenchDefinition.ts`（解码与写回保留键）。
- Test: kernel `parse` / `validate` / `effective-plan` / 快照兼容测试、`default-workflow` 生成新鲜度、dashboard `governanceSchema.test.tsx`。

**Interfaces:**
- Produces: `WorkflowStep.maxRounds?: number`；`DEFAULT_MAX_ROUNDS = 2`；`effectiveMaxRounds(step): { max: number; source: 'workflow' | 'default' }`（kernel 导出）。

- [x] **Step 1: 写失败测试**：
  - `max_rounds: 2` 在 verify 步解析成 `maxRounds: 2`，序列化后原样写回。
  - `0`、`21`、`two`、`1.5` 报错并点名步骤；在没有评审门或没有回退边的步骤（如 build）上声明报错。
  - 编译后的 effective plan 带 `maxRounds`；`default` 五条轨道的 verify 步都是 2。
  - 用一份没有 `maxRounds` 的 v4 快照夹具：解码成功、指纹与原记录一致，`effectiveMaxRounds` 返回 `{ max: 2, source: 'default' }`。
  - Dashboard 解码含 `max_rounds` 的定义成功，写回保留。
- [x] **Step 2: 确认红**：`npx vitest run` 上述测试文件，新用例失败。
- [x] **Step 3: 实现**，`npm run generate:default-workflow` 重新生成内置副本。
- [x] **Step 4: 确认绿**：同一组 vitest、`npm run check:default-workflow-freshness`、`npx tsc -b packages/kernel packages/cli packages/server`、`npm run typecheck:web`。

### Task F2：轮次计数与任务覆盖

**Files:**
- Create: `packages/kernel/src/workflow/step-rounds.ts`（纯函数）与同名测试。
- Modify: `packages/kernel/src/types.ts`（`FIELD_ORDER` 末尾追加 `max_rounds`）、`packages/cli/src/commands/field-values.ts`（1–20 整数校验）、`fields.ts`（写入记历史，沿用现有 `set`）。
- Modify: `packages/cli/src/commands/statusStep.ts`（读转换链、组装 `rounds`）、`statusStepParts.ts`（字段视图）。
- Test: `step-rounds.test.ts`、`fields` 相关测试、`statusStep.test.ts`。

**Interfaces:**
- Consumes: F1 的 `effectiveMaxRounds`。
- Produces:
  - `currentRound(input: { stepId: string; steps: readonly string[]; backTargets: readonly string[]; transitions: readonly { readonly to: string; readonly runId?: string }[]; runId: string | null }): number`：自最近一次落到早于所有 `backTargets` 的步骤之后，进入 `stepId` 的次数（含当前；任务当前不在该步时返回已进入次数）。
  - `resolveMaxRounds(planMax, taskField): { max: number; source: 'workflow' | 'default' | 'task' }`。
  - `status --json` 步骤块新增 `rounds: { current: number; max: number; source: string } | null`（没有回退边的步骤为 `null`）。

- [x] **Step 1: 写失败测试**：
  - `currentRound`：第一次进入为 1；`verify-fail` 回 build 再 `build-complete` 为 2；经 `requirements-changed` 回 spec 再进入为 1；另一个 runId 的记录不计；自定义工作流（回退目标为 build 与 design 两步）落到 design 不清零、落到更早的 spec 才清零。
  - `tenon set <c> max_rounds 0` / `21` / `x` 拒绝；`3` 写入并记历史；`resolveMaxRounds` 来源为 `task`。
  - `status --json` 的 verify 步块含 `rounds`；build 步（没有评审门）与其他不受约束的步骤为 `null`。
- [x] **Step 2: 确认红** → **Step 3: 实现** → **Step 4: 确认绿**（`npx vitest run` 这几份测试与 `npx tsc -b …`）。

### Task F3：用完后停止自动回退（编排与强制）

**Files:**
- Modify: `packages/cli/src/commands/statusStepExits.ts`（`exitActions` 在 `requiredEvidenceFailed && back.length > 0` 分支前判断用完）、`statusStepNext.ts`（测试回退分支同样判断）、`statusStepAction.ts`（`stop` 的 code `rounds-exhausted`）。
- Modify: `packages/cli/src/commands/review.ts`（回退边的 `review request` 用完时拒绝）、`transition.ts`（回退边转换用完时拒绝，`requirements-changed` 等落到更早步骤的边不受限）、`packages/server/src/transition.ts`（同一判定）。
- Modify: `packages/cli/src/i18n/messages-*.ts`（拒绝与 stop 文案：写出 used/max、`tenon set <change> max_rounds <N>`、三条出路）。
- Test: `statusStep.test.ts` / `statusStepTests.test.ts`、`review.integration.test.ts`、`transition` 测试。

**Interfaces:**
- Consumes: F2 的 `rounds`。
- Produces: `StepNextInput.rounds?: { current: number; max: number; source: string }`；`roundsExhausted(rounds): boolean`（`current >= max`）。

- [x] **Step 1: 写失败测试**：
  - 第 2 轮、上限 2、必需评审者不通过：`next` 不含 `verify-fail` 的 `request-review` / `choose-exit` / `transition`，含前进边的 `request-review`（带 `residual: ['reviewer:<agent>']`，见 F4）。
  - 同上但必需测试失败且无豁免：`next` 为 `stop`，code `rounds-exhausted`，文案列出登记豁免与三条出路。
  - 第 1 轮、上限 2：行为与修改前一致（`request-review verify-fail`）。
  - 第 2 轮时 `tenon set … max_rounds 1`：仍用完；设为 3：恢复 `request-review verify-fail`。
  - `tenon review request <c> --event verify-fail` 在用完时 exit 1，输出 `2/2` 与调高命令；`tenon transition <c> verify-fail` 同样拒绝；build 步的 `requirements-changed` 不受影响。
- [x] **Step 2: 确认红** → **Step 3: 实现** → **Step 4: 确认绿**。

### Task F4：接受剩余阻断

**Files:**
- Modify: `packages/kernel/src/workflow/agent-verdict.ts`（`evaluateStepAgents` 接受 `accepted: readonly { agent; runId; candidate }[]`，被接受且运行与候选都对得上的 `reviewer-failed` 不再作为阻断，另出提示）。
- Modify / Create: 剩余阻断的冻结与批准（参照 `packages/kernel/src/test-system/review-waivers.ts` 与 `packages/cli/src/commands/review-waivers.ts` 的冻结清单与 `approveFrozenWaivers`）：请求时在 Change 锁内冻结 `reviewer:<agent>` 及其运行 id、候选、阻断级发现摘要；人工 `review acknowledge`（非 `--delegated`）在提交回执的同一把锁内写入接受，记 `review.residual-accepted` 历史行；有待接受项时 `--delegated` 拒绝。
- Modify: `packages/cli/src/commands/review.ts`（`checkReviewRequestReadiness`：用完时前进边放行评审者不通过，并列出待接受项）、`statusStepExits.ts`（前进边请求带 `residual`）、hook 端无需改动（确认仍由放行语写回执）。
- Test: kernel `agent-verdict` 测试、新的 `review-residual` 集成测试（参照 `packages/cli/src/test-waive-step.integration.test.ts`）。

**Interfaces:**
- Consumes: F2 / F3。
- Produces: `request-review` 动作的 `residual?: readonly string[]`；接受记录形状 `{ key: 'reviewer:<agent>'; runId: string; candidate: string; findings: number; acceptedBy: string; acceptedAt: string }`。

- [x] **Step 1: 写失败测试**：
  - 用完后 `review request --event verify-pass` 放行并列出 `reviewer:security` 与阻断级发现；人工确认后 `transition verify-pass` 成功，历史有 `review.residual-accepted`。
  - `review acknowledge --delegated` 在有待接受项时拒绝，评审保持待确认。
  - 接受后代码变了、评审者在新候选上重跑仍不通过：前进边重新被阻断。
  - 同一候选上带 `--rerun-reason` 重跑得到新运行：接受不覆盖新运行。
  - 未用完时 `review request --event verify-pass` 照旧被拒。
- [x] **Step 2: 确认红** → **Step 3: 实现** → **Step 4: 确认绿**。

### Task F5：文档、宪法与技能

**Files:**
- Modify: `docs/usage/cli-reference.md`、`docs/usage/zh-CN/cli-reference.md`（`max_rounds` 字段、`rounds-exhausted`、剩余阻断）、`docs/usage/default-workflow.md`、`docs/usage/zh-CN/default-workflow.md`（verify 最多两轮）、`templates/workflow.md`（宪法一句：上限用完停下交用户，agent 不自行调高）、`skills/tenon/SKILL.md`（动作表：`stop` 且 code `rounds-exhausted` 时摆出剩余阻断与四条出路、等用户；`request-review` 带 `residual` 时连同发现逐条展示）。
- Test: `npm run check:docs`；`tools/test-hooks.sh` 里若有对 SKILL.md 文案的断言，保持通过。

- [x] 写文档与技能说明 → `npm run check:docs` 通过。

### Task F6：入库产物、本任务上限与验证（主线）

- [x] `npm run build` 重建入库产物。
- [x] `tenon set fix-hook-cross-session-isolation max_rounds 1`（用户决定「这轮修完就停」），`tenon status --json` 显示 verify 的 `rounds`。
- [ ] 登记新测试文件；跑 build 与 verify 阶段套件、code-size 与其余登记套件；派四个评审者。验证不通过时按上限停下，把剩余阻断与出路交给用户。

### Task F7：就绪预审后的加固（已落地，builder `b8152749…-G4`、`dccca583…`）

写 `pre_verify_review_result` 前按 verify 的评审口径派了两份只读预审（规格一致性加后端质量、安全），都没有 high 及以上；下面是本步修掉的项。规格措辞的两处修正（「高于当前轮次」、回规格的两步路径）经 `requirements-changed` 回规格完成。

**Files:**
- Create: `packages/cli/src/commands/statusStepRoundsRoute.ts`（回规格出路的真实路径）与 `statusStepRoundsRoute.test.ts`；`packages/cli/src/status-step-rounds-stable.integration.test.ts`。
- Modify: `statusStepRoundsActions.ts`、`statusStep.ts`、`statusStepNext.ts`、`statusStepExits.ts`、`i18n/messages-transition.ts`；`packages/server/src/transitionResult.ts`、`serverPostDecisionRoutes.ts`、`transition.ts`；`packages/kernel/src/test-system/step-test-waivers.ts`、`review-residual.ts`；`packages/kernel/src/workflow/step-rounds-read.ts`；`docs/usage/*` 与 `docs/CONTRACT.md` 的对应描述。

**Interfaces:**
- Produces: `roundsRoute(plan, stepId): { back, reset, resettable } | null`；历史行 `review.residual-accepted reviewer=… run=… candidate=… findings=… by=… summary=<条1>|<条2>…`（最多 5 条，条内 `|` 换全角）。

- [x] 回规格出路按计划算出：受约束步骤自己声明的回退边不清零、用完后被拒，所以给两步路径（调高上限 → 回退边 → 在回退目标步骤上回规格），不给必然失败的单步命令；CLI 与 Dashboard 拒绝文案同改。验收：`statusStepRoundsRoute.test.ts` 7 条、`statusStepRoundsNext.test.ts` 27 条、`review-residual.integration.test.ts` 16 条、`transition-rounds.test.ts` 通过。
- [x] 发现摘要与确认人、时间去掉 C0 / C1 控制字符与双向覆盖 / 隔离字符，严格解码遇到即整份拒收；历史行带摘要。验收：`review-residual.test.ts`、`step-test-waivers.test.ts` 通过。
- [x] 有转换记录链头却没装配读取依赖时 `readStepRounds` 报错，不退回读历史文件。验收：`step-rounds-read.test.ts` 通过。
- [x] Dashboard 读不出冻结清单时确认返回 409 `residual-pending`。验收：`serverDecisionRoutes.test.ts` 通过。
- [x] 「删标记、重跑、删除或截断历史文件、伪造历史转换行」都不改变轮次（6 条），用临时改动（计数改读历史文件 / 忽略链）证明能变红。验收：`status-step-rounds-stable.integration.test.ts` 6 条通过。
- [x] 整套：`npx vitest run packages/kernel/src/test-system packages/kernel/src/workflow packages/cli/src/commands packages/server/src` 4327 通过；`npx tsc -b` 六个包、`check-architecture`、`check:comments`、`check:docs`、`test:hooks`（2124）、`npm run build` 通过。

**不修（记为已知限制或后续）**：Dashboard 转换不查评审者（HEAD 既有）；Dashboard 评审者面板与 `tenon agent next` 不读接受记录（只影响展示）；接受只绑定运行 id 不绑定报告摘要（评审台账本身不受 gate 保护）；持续授权口令被拒时 hook 不提示；Dashboard 编辑器清不掉 `max_rounds`；自定义工作流把 `scope-expanded` 指向更早步骤时的豁免判定。
