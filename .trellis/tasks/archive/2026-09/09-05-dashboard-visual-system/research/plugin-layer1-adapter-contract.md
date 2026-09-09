# 插件体系全链路排查 · 第 1 层：适配器契约层 审计报告

- **审计范围**：`adapters/contract.md`、`adapters/registry.yaml`、`adapters/lint-adapter.sh`、`tools/test-adapters.sh`、`adapters/*/`（11 个平台）、`hooks/{session-start,gate,skill-tracker}.sh`
- **仓库根**：`/Users/a1234/Documents/code-manager/projects/tenon-local`
- **审计日期**：2026-09-08
- **审计方式**：只读取证 + 真实执行复现（`bash adapters/lint-adapter.sh --all` 全绿；`bash tools/test-adapters.sh` = **272 passed, 0 failed**）

---

## 一句话结论

**这一层"绿得漂亮但守不住门"**：lint 与 conformance 全绿，代码整洁度高、降级声明的文风也诚实，但绿灯覆盖的是"registry 字段填齐 + wrapper 在 CC 形状输入下透传正确"这一窄面；真实宿主形状输入、HITL 解封路径、安装失败路径、静态降级层的内容新鲜度**全部无断言**——已实测出 3 类可复现的 P0（Cursor/Cline/Amp 上 `tenon review acknowledge` 被自己的门锁死、安装未生效却宣称"档 A 全保真完成"、aider inject 声明 native 实为安装期快照），契约"机器约束"的自我定位目前**名不副实**。

---

## 一、逐平台一致性核对表

图例：✅ 吻合 / ⚠️ 部分吻合（有未声明的语义缺口）/ ❌ 不吻合

| 平台 | 声明 tier | 声明三能力 | 实际行为（实测） | 吻合 | 证据 |
|---|---|---|---|---|---|
| claude-code | A（baseline） | 全 native | baseline 自身；`hooks/hooks.json` 实际注册 **8 个 hook 脚本 / 11 条 entry**，远超契约声明的三能力 | ⚠️ | `hooks/hooks.json:1-46`；`adapters/contract.md:16-22` |
| codex | A | 全 native | 三 wrapper 真透传 baseline；**额外**有第 4 个能力 `hooks/prompt.sh`（UserPromptSubmit 路由），registry 无字段可表达 | ⚠️ | `adapters/codex/hooks.json:11-17`、`adapters/codex/hooks/prompt.sh`；`adapters/registry.yaml:55-72` |
| cursor | B（veto/track native、inject degraded） | veto=permission-json+failClosed | wrapper 逻辑正确；但**真实 Cursor `beforeShellExecution` 载荷无 `tool_name` 键**时 `TOOL="?"` → acknowledge 放行分支失效（实测 DENY）；载荷无顶层 `cwd`（仅 `workspace_roots`）时**静默放行**（实测 allow） | ❌ | `adapters/cursor/hooks/veto.sh:26-33`；`hooks/gate.sh:45-46,190`；实测见 §二 P0-1/P0-2 |
| gemini | A 全 native | 三能力 native | wrapper 与 continue/copilot/pi **逐字相同**（去注释后 diff=0）；但 `.gemini/settings.json` 已存在时安装器**只写 `.pipeline-adapter` 旁挂文件、仍打印"档 A 全保真完成"并 exit 0** | ❌ | `adapters/gemini/install.sh:41-49,55`；实测见 §二 P0-3 |
| copilot | B（veto/track native、inject degraded） | veto_format=exit2-stderr、dual hookContainer | wrapper 正确；`hooks.json` 用的是 **Cursor 式 flat schema（`version:1` + `command` 数组）却声明 CC 的 exit-2 协议**，且**无 `failClosed`**；dual container 只写成一份时仍打印"两份都已写" | ❌ | `adapters/copilot/hooks.json:3-11` vs `adapters/registry.yaml:137-139`；`adapters/copilot/install.sh`（实测输出见 §二 P0-3） |
| pi | B（veto degraded=`extension-advisory`） | inject/track native | 无 `hooks/veto.sh`（如实不伪装 ✅）；但**声明的 fallback `extension-advisory`（`.pi/extensions` 运行时）在仓库里不存在**，install 只落 `.pi/rules/pipeline.md` 一份静态 markdown | ❌ | `adapters/registry.yaml:160-163`；`adapters/pi/install.sh:38-61`；`grep -rn extensions adapters/pi/` 仅命中注释 |
| devin | C 全 degraded | 三能力 degraded + fallback | install 真落 `.devin/workflows/pipeline.md`；但 `track_status: degraded` + `track_format: none` + `track_fallback: manual-note` 实为 **`none` 披着 `degraded` 外衣** | ⚠️ | `adapters/registry.yaml:189-192` |
| zed | C 全 degraded | 同 devin | install 真落 `.rules`、幂等 ✅；`track` 同 devin 的 degraded/none 混淆 | ⚠️ | `adapters/registry.yaml:215-218`；`adapters/zed/install.sh` |
| aider | B（veto degraded=commit-gate、inject/track native） | inject_format=`conf-read-file` | veto commit-gate 端到端真挡 ✅；**inject 声明 native 但内容是 `install.sh` 运行时刻的一次性快照**（`refresh_context` 写死文件，phase/门状态一变即陈旧）；git hook 遇到陌生既有 hook 时**只写 `.pipeline-adapter` 建议文件**、veto/track 静默不生效 | ❌ | `adapters/aider/install.sh:41-53,80-99`；`adapters/registry.yaml:242-244` |
| continue | A 全 native | 三能力 native | wrapper 与 gemini 逐字相同；同样有"settings.json 已存在→只写旁挂文件仍宣称档 A 完成"问题 | ❌ | `adapters/continue/install.sh`（实测见 §二 P0-3） |
| cline | A 全 native | inject=`contextModification-json` | veto/track 形状转换正确；**inject 把 baseline 的 codex-json 信封整个塞进 `contextModification` 字符串（串格式）**；veto 直传 Cline 原生工具名 → baseline 的只读放行与 acknowledge 放行**全部失效**（实测 `read_file`、`execute_command` 均被拦） | ❌ | `adapters/cline/hooks/TaskStart:48`（缺 `TENON_SESSION_START_FORMAT=plain`）；`hooks/session-start.sh:92-95`；实测见 §二 P0-1/P1-1 |
| amp | A 全 native | 三能力 native | 纯函数三能力真跑真副作用 ✅；同 cline 的工具名/命令未归一问题（实测 `read_file` 被拦、`Bash + acknowledge` 被拦）；`extractCwd` 兜底 `process.cwd()` 与其余平台的项目根解析策略不同 | ❌ | `adapters/amp/plugins/pipeline.js:83-95,135-144`；实测见 §二 P0-1 |

---

## 二、缺陷清单

### P0-1　三个平台上 HITL 唯一解封路径被自己的门锁死（可复现死锁）

**证据（实测复现）**

夹具：`/tmp/aud1` 含 git 根 + `openspec/changes/demo-change/.pipeline.yaml` + `.pipeline-active=demo-change` + 新鲜 v2 `.pipeline-pending-review`。

```
baseline  gate.sh   tool_name=Bash, command="tenon review acknowledge demo-change"  → rc=0（ALLOW）
cline     PreToolUse toolName=execute_command, parameters.command=同上              → {"cancel":true,...}
amp       decideToolCall(cwd,"Bash")（命令字段根本没传）                              → {"action":"reject-and-continue",...}
cursor    beforeShellExecution 形状（有 command/cwd、无 tool_name）                   → {"permission":"deny",...}
```

**根因**：`hooks/gate.sh:190` 的放行分支要求 `pipeline_json_is_command_tool "$TOOL"`（`hooks/json-input.sh:73-78` 只认 `Bash|command_execution|exec`）**且** `json_command` 能取到 `command`/`cmd`。三个适配器都只合成 `{"cwd","tool_name"}`，把宿主原生工具名（`execute_command` / `read_file` / Amp 工具名）直传或干脆丢弃命令体：

- `adapters/cline/hooks/PreToolUse:80` — `printf '{"cwd":"%s","tool_name":"%s"}' "$CWD" "$TOOL"`（丢 command）
- `adapters/amp/plugins/pipeline.js:85` — `JSON.stringify({ cwd, tool_name: toolName })`（丢 command）
- `adapters/cursor/hooks/veto.sh:26` — 原样透传宿主载荷，但 Cursor 的 shell 事件不带 `tool_name`

**影响**：`adapters/contract.md:61` 明写"review 的唯一解封写路径是 `tenon review acknowledge`"。在 cline/amp/cursor 上，marker 新鲜期内该命令被自己拦下 → 用户只能等 1800s TTL 自然过期、或设 `TENON_AFK=1` 整门放行（`hooks/gate.sh:29`）、或手删 marker——而手删正是契约 §2 明令禁止的"把删除 marker 当作确认"。**这是把契约红线逼成唯一可行操作**。

**修复方向**：在契约里新增第 4 项必填能力字段 `tool_identity_map`（宿主工具名 → baseline 词汇：write/read/command）与 `command_passthrough: true|false`，由 wrapper 统一归一后再喂 gate.sh；conformance 增加"acknowledge 必须放行"与"只读工具必须放行"两个跨平台场景。

---

### P0-2　Cursor：载荷缺 `cwd` 时静默放行（门形同虚设）

**证据**

```
printf '{"hook_event_name":"preToolUse","workspace_roots":["/tmp/aud1"],"tool_name":"Write"}' \
  | bash adapters/cursor/hooks/veto.sh preToolUse
→ {"permission":"allow"}          # 同一项目有新鲜 review marker，baseline 判 DENY
```

`hooks/gate.sh:42-44`：`CWD` 取不到就退回 `$PWD`（hook 进程 cwd）；进程 cwd 不在项目内 → `pipeline_project_root` 找不到 marker → 放行。`adapters/cursor/hooks/veto.sh` 全程不做 `workspace_roots → cwd` 归一。

**影响**：`veto_failclosed: true` 的声明（`adapters/registry.yaml:93`）只覆盖"hook 进程崩溃"，覆盖不了"hook 正常返回 allow"。声明 native 硬拦、实际按宿主载荷形状随机降级。

**修复方向**：与 P0-1 合并——所有 wrapper 必须显式做载荷归一（cwd 至少要覆盖 `cwd` / `workspace_roots[0]` / `workspaceRoots[0]` 三种形状），并在 conformance 里用**各平台真实载荷形状**（而非 CC 形状）驱动。

---

### P0-3　安装未生效仍宣称"档 A 全保真完成"（虚假成功）

**证据（实测复现）**

```
# .gemini/settings.json 已存在（真实用户的常态）
$ bash adapters/gemini/install.sh --target /tmp/geminstall --yes ; echo RC=$?
[gemini] /tmp/geminstall/.gemini/settings.json 已存在——不自动覆盖你既有 settings。
[gemini] 已替换占位的版本写到 ....pipeline-adapter（供你手动合并 hooks 段）。
[gemini] 档 A 全保真完成：三能力全 native（settings.json#hooks，无 trust，落盘即生效）。
RC=0
```

同一模式：`adapters/continue/install.sh`（"档 A 全保真完成"）、`adapters/cursor/install.sh`（"Cursor 适配器安装完成"）、`adapters/aider/install.sh:80-99`（陌生 git hook → 只写 `.pipeline-adapter`，仍打印"档 B 完成"）。

**copilot 更严重**：只写成一份 container 时仍打印 `dual hookContainer：两份都已写（漏一份 copilot 引擎读不到 hook、不生效）`——**输出内容与事实直接相反**。

代码位置：`adapters/gemini/install.sh:41-49`（早退分支 `return 0`）+ `:55`（无条件打印成功）。

**影响**：用户端"我装好了 = 门在生效"的因果链断裂；叠加所有 veto wrapper 的 fail-open（找不到 gate.sh → 放行），一个未生效的安装**不会产生任何可观测信号**。

**修复方向**：install 脚本区分 `INSTALLED` / `NEEDS_MERGE` / `SKIPPED` 三态并以退出码区分；新增 `adapters/verify-install.sh <id> --target <dir>` 做安装后自检（hook 是否真的注册进宿主容器 + 真跑一次 DENY 场景），把它接进 `tenon setup` 的 `adapter-deploy` 步骤（`packages/cli/src/commands/host-target-plan.ts:181` 目前只是打印一条**人工执行的命令**，不校验结果）。

---

### P0-4　aider `inject_status: native` 与实现不符（安装期快照冒充会话级注入）

**证据**：`adapters/aider/install.sh:41-53` 的 `refresh_context()` 在**安装时**跑一次 `hooks/inject.sh` 并把 stdout 写死进 `.aider-pipeline-context.md`；`.aider.conf.yml` 的 `read:` 只保证 aider 每次启动**重读该文件**，不保证文件内容新鲜。registry 却登记 `inject_status: native`（`adapters/registry.yaml:242`），注释写"每次启动重新读盘，非缓存，视为 native"（`:224-225`）——把"宿主重读文件"偷换成"内容新鲜"。

**影响**：phase 推进、门状态变化后，aider 会话注入的仍是上次安装时的旧上下文；这正是契约 §1 红线"声明 native 却降级"。conformance 只断言 `hooks/inject.sh` 的**直跑输出**含 `tenon`（`tools/test-adapters.sh:735-737`），完全绕开了"落盘文件是否新鲜"这一真实交付面。

**修复方向**：要么降级为 `degraded / fallback: install-time-snapshot`，要么在 `hooks/veto.sh`（pre-commit，每次工作单元都会跑）里顺手刷新上下文文件，并在 conformance 里断言"phase 变化后重新触发 → 文件内容跟着变"。

---

### P1-1　cline inject 串格式（把 codex-json 信封嵌进 contextModification）

**证据（实测）**

```
$ printf '{"hookName":"TaskStart","workspaceRoots":["/tmp/clinechk"],"taskStart":{}}' | bash adapters/cline/hooks/TaskStart
{"cancel":false,"contextModification":"{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Tenon：7-phase ...
```

`adapters/cline/hooks/TaskStart:48` 调 baseline 时**漏了 `TENON_SESSION_START_FORMAT=plain`**（codex/gemini/pi/continue/aider/amp 六处都带了）。`hooks/session-start.sh:92-95` 的注释恰好点名这个坑：*"prevents one host's JSON envelope from being nested inside another's context"*。

**影响**：违反 `adapters/contract.md:73-88`「不串格式」；Cline 侧模型收到的是一坨转义 JSON 而非可读上下文。conformance 只断言 `contextModification` 与 `tenon` 两个子串，两者在错误输出里都命中 → **绿灯放行**（`tools/test-adapters.sh` cline inject 两条断言）。

**修复方向**：补 `TENON_SESSION_START_FORMAT=plain`；conformance 增加 `assert_not_contains "hookSpecificOutput"` 类的反向断言（aider inject 已有该模式，可直接复用）。

---

### P1-2　hook 崩溃时 fail-open / fail-closed 在平台间分裂，且无任何声明位

**实测矩阵**（`TENON_CC_GATE` 指向一个 `exit 1` 的假 gate）：

| 平台 | 声明 | gate 崩溃（rc=1） | gate 缺失 | 实际语义 |
|---|---|---|---|---|
| codex / gemini / copilot / continue | native, exit2-stderr | 透传 rc=1 → 宿主只认 2 → **ALLOW** | `exit 0` → ALLOW | fail-**open** |
| amp | native | `status !== 2` → `{action:"allow"}` | 同上 | fail-**open** |
| cursor | native + `veto_failclosed: true` | rc≠0 → `{"permission":"deny"}` | **打印 allow 后 exit 0** | 崩溃 fail-closed，缺失 fail-**open** |
| cline | native | rc≠0 → `{"cancel":true}` | `fail_open()` → cancel:false | 同上 |
| aider | degraded | rc≠0 → exit 1（挡 commit） | exit 0 | 同上 |

证据：`adapters/codex/hooks/veto.sh:24,27-28`、`adapters/cursor/hooks/veto.sh:23,26-33`、`adapters/cline/hooks/PreToolUse:64,78,80-85`、`adapters/amp/plugins/pipeline.js:57-58,87-91`。

**关键悖论**：cursor 的 `failClosed:true`（`adapters/cursor/hooks.json:6,9`）只在**宿主观察到 hook 进程异常**时生效；而 wrapper 自己在"找不到 gate.sh"时会**正常退出并输出 allow**——宿主看不到异常，failClosed 永不触发。即"必须显式 failClosed:true"这条契约条款在最重要的失效场景下是**空头支票**。

**影响**：`adapters/contract.md:49` 把 fail-open/closed 写成 cursor 一家的属性，registry 也只给 cursor 留了 `veto_failclosed` 字段（`adapters/registry.yaml:29` 注释直书"cursor 专用"）。copilot 用同款 flat schema 却**没有** `failClosed`，无人发现。

**修复方向**：`<cap>_failmode: open|closed` 提升为**所有平台必填**；wrapper 内部的 fail-safe 分支必须与声明一致（声明 closed 就不许在缺 gate 时输出 allow）；conformance 增加"注入损坏 baseline → 断言与声明的 failmode 一致"这一场景。

---

### P1-3　conformance 覆盖矩阵是硬编码的，registry 不是真源

**证据**：`tools/test-adapters.sh:38` `ADAPTER_IDS="codex cursor"`、`:510` `NEW_IDS="gemini copilot pi devin"`、`:554` `NV="gemini copilot"`、`:669` `LONGTAIL_IDS="zed aider continue cline amp"`。全文**没有** `platform_ids()`，从不遍历 registry 的 platforms 块。

而 `adapters/registry.yaml:5` 宣称 *"tools/test-adapters.sh 从本表派生 conformance 断言"*，`adapters/contract.md:8` 宣称 *"对每个适配器跑同一组输入场景"*。

**影响**：往 registry 新增一个平台，**lint 会跑、conformance 不会跑**（一条行为断言都没有）。契约 §4 checklist 第 6 项"进 conformance"是纯人工纪律，无机器约束。

**次生问题（断言循环论证）**：大量断言形如
`assert_eq "tier/gemini: veto native" native "$(reg_field gemini veto_status)"` —— 用测试里的字面量校验 registry 的字面量，与实际行为无关。全文 63 处 `reg_field` 里，只有 `norm_veto` 那条链把声明真正接到了行为上。

**修复方向**：conformance 主循环改为 `for id in $(platform_ids)`；按 `<cap>_status` 自动选断言族（native → 驱动比对 baseline；degraded → 断言 `<cap>_fallback` 命名的落点**真实存在且含 baseline 内容**；none → 断言无对应 hook 产物）。加平台从此**不写一行测试代码**。

---

### P1-4　pi 的 `veto_fallback: extension-advisory` 指向不存在的落点

**证据**：`adapters/registry.yaml:161` 声明 `veto_fallback: extension-advisory`，注释（`:146-147`）与 `adapters/pi/README.md:13,37`、`adapters/pi/settings.json:2` 均写 *"enforcement 走 `.pi/extensions` 运行时 advisory"*。`grep -rn "extensions" adapters/pi/` 只命中这三处**注释**——`adapters/pi/install.sh` 只写 `.pi/rules/pipeline.md`（`:38-61`），仓库里没有任何 `.pi/extensions` 产物或生成逻辑。

conformance 对此只有两条断言：`veto_fallback` 非空、`hooks/veto.sh` 不存在（`tools/test-adapters.sh` §⑧.5）——**恰好都通过**。

**影响**：契约 §1 红线之一"声明 degraded 实际没有 fallback 落点"的教科书案例，且当前测试**结构上无法**发现它。

**修复方向**：registry 增 `<cap>_fallback_path`（相对 target 的落盘路径），lint 校验非空、conformance 校验安装后该路径真实存在。

---

### P1-5　"三能力"抽象覆盖不了 baseline 的实际强制面

**证据**：`hooks/hooks.json` 里 Claude Code baseline 注册了 **8 个不同 hook 脚本 / 11 条 entry**：`session-start`、`confirm-clear-prompt`、`breadcrumb`、`router`、`gate`、`codex-skill-receipt`、`terminal-activity`、`confirm-clear`、`decision-recorder`、`skill-tracker`、`interactive-skill-gate`。契约（`adapters/contract.md:16-22`）只把其中 3 个定义为"内核依赖的三类能力"。

其中至少两个是**闭环强制的必要件**：

- `hooks/interactive-skill-gate.sh:9-16` — 交互式 skill 加载后**写** `.pipeline-pending-interaction`；
- `hooks/confirm-clear.sh:4-8` — AskUserQuestion 完成后**清** confirm/interaction marker。

除 codex（多了 `prompt.sh` 一个路由 wrapper）外，**11 个平台无一实现这两者**。registry 也没有字段能表达"缺这两个能力"。

**影响**：gemini/continue/cline/amp 的"档 A 全保真"实为"3/8 能力保真"。`adapters/contract.md:28-29` 对档 A 的定义（"三能力均在目标工具原生 hook 上等价实现"）与用户直觉的"全保真"之间存在结构性落差。

**修复方向**：要么把能力矩阵扩到覆盖 baseline 全部强制 hook（推荐：`hooks/hooks.json` 与 `registry.yaml` 之间加机器一致性检查），要么把档 A 明确改名为"三能力保真"并在 README/文档里显式列出未覆盖能力清单。

---

### P1-6　registry "单一真源" 被 TypeScript 侧的第二份硬编码清单破坏

**证据**：`packages/cli/src/commands/plugin-host.ts:11-24` 硬编码 `TENON_HOSTS = ['codex','claude','cursor','gemini','copilot','pi','devin','zed','aider','continue','cline','amp']`，注释自陈 *"Keep the list aligned with adapters/registry.yaml"* —— **纯人工同步纪律**。`grep` 全仓无任何测试/脚本交叉校验这两份清单。

**影响**：加平台成本不止"填表 + 写 configure"，还要改 TS 常量、改 `tools/test-adapters.sh` 的 4 个硬编码 id 列表；漏改 TS 则 `tenon setup --<新平台>` 直接不认。

**修复方向**：TS 侧在构建期从 `registry.yaml` 生成 `TENON_HOSTS`（仓库已有 `tools/generate-*.mjs` 生成器范式），或加一条 node-test 断言两者相等。

---

### P2-1　反例哨兵中 3/8 是同义反复，不构成判别力自证

**证据**：`tools/test-adapters.sh` 反例 B（`:480-489`）写一个 `exit 0` 的假 track.sh，然后断言 history 文件**没被创建**；反例 C（`:492-500`）写一个 `exit 0` 的假 inject.sh，断言输出**不含** `additionalContext`；变异 E（`:657-665`）同形。这些只证明"什么都不做的脚本什么都不做"，**没有复用 §⑤/§⑧.4 的真实断言路径**，因此并不能证明真实断言会抓红。

反例 A / 变异 D / F / G 是合格的（复用了 `baseline_veto` + `drive_veto_at` + `norm_veto` 真实判别链）。

**修复方向**：把断言体抽成函数（`assert_track_records <wrapper> <proj>`），哨兵直接调同一个函数并断言其返回 FAIL。

---

### P2-2　"不伪装 native" 靠 `assert_absent hooks/inject.sh` 这类否定式存在性断言，可被绕过

**证据**：`tools/test-adapters.sh` 用 `assert_absent "$ADAPTERS/cursor/hooks/inject.sh"` 证明 cursor 没伪装会话级 inject。但 cursor **确实在做 inject**——藏在 `adapters/cursor/hooks/track.sh:30-42`（postToolUse 里返回 `additional_context`）。文件名不存在 ≠ 能力不存在。

**修复方向**：改为断言"宿主 hook 容器里没有注册任何 SessionStart 级 inject 事件"（读 `hooks.json`/`settings.json` 产物），而非断言某个源文件不存在。

---

### P2-3　契约引用的实证依据在本仓库不存在（不可复核）

**证据**：`adapters/contract.md:87` 与 `adapters/cursor/README.md:3` 均把 Cursor 的 stdout 格式归因于 *"老仓 `adapters/cursor/spike/NOTES.md`"*；`find adapters -iname "*spike*" -o -iname "*NOTES*"` → **0 命中**。amp 的 README §5 亦自陈"未经真实 Amp 会话端到端实测，event payload 字段名为防御性推断"（`adapters/registry.yaml:303-304`）。

**影响**：契约 §3 的格式矩阵是不可在本仓库内复核的断言；P0-2 正是这条断链的直接后果（Cursor 真实载荷形状与假设不符）。

**修复方向**：把每个平台的载荷样本落成 `adapters/<id>/fixtures/<event>.json`（哪怕标注 unverified），conformance 用 fixture 而非 CC 形状驱动；载荷来源与置信度进 registry 字段。

---

### P2-4　lint 的 `platform_ids` 块边界判定有潜伏 bug

**证据**：`adapters/lint-adapter.sh:26-30` 用 `/^[A-Za-z_].*:[[:space:]]*$/` 判定"下一个顶层 key"来退出 platforms 块。文件末尾的 `longtail: []`（`adapters/registry.yaml:341`）因为**行尾带值**而不匹配该正则 → `inp` 保持 1。当前 longtail 为空所以无害；一旦有人在 longtail 下恢复 `  - id:` 条目，这些**规划中、未实现**的平台会被 lint 与 `adapters/install.sh`（同款 awk，`:23-29`）当作 active 平台处理。

**修复方向**：正则改为 `/^[A-Za-z_][A-Za-z0-9_]*:/`。

---

### P2-5　legacy 身份漂移（契约自身也在漂）

**证据**：`adapters/contract.md:69,102` 写 *"状态写一律走 `pipeline` CLI"*，而同文件 `:61,68` 与全部测试/实现用的是 `tenon`。落盘的静态降级层同样写死旧身份：`adapters/cursor/install.sh:45,53`、`adapters/copilot/install.sh:49`、`adapters/devin/install.sh:53,61`、`adapters/zed/install.sh:46,54`、`adapters/pi/install.sh:51`（含 `命令前缀为 /pipeline-（如 /tenon-explore）` 这种自相矛盾句）。`hooks/gate.sh:204` 打印 `【Tenon 门】`、`:243` 打印 `【pipeline 门】`。

`tools/check-legacy-identity.mjs` 覆盖 `adapters` 目录，但禁用模式（`:55-58`）只含 `Pipeline Lite` / `pipeline-lite` / `pipeline-worklfow`，抓不到上述用法。

**影响**：用户在 Cursor/Copilot/Devin/Zed/Pi 上读到的**唯一** pipeline 指引里，CLI 名与命令前缀都是错的——静态降级层是这些平台的主要（甚至唯一）上下文来源。

---

### P2-6　静态降级层内容与 native inject 不等价，且无新鲜度

**证据**：native inject 交付的是 `templates/workflow.md` 全文宪法 + 活跃 change 列表 + 门状态（`hooks/session-start.sh:199-254`）。degraded 静态层交付的是 **20 行手写 prose**，既无宪法全文、也无任何项目实时状态：`adapters/cursor/install.sh:34-56`、`adapters/copilot/install.sh:36-70`、`adapters/devin/install.sh`、`adapters/zed/install.sh`。conformance 只断言"文件存在"（copilot/devin）或"含 `Pipeline Workflow` 字样"（zed）。

**修复方向**：静态层由 `hooks/session-start.sh --format plain` 生成（与 aider 同法），并至少断言其含宪法首行；registry 增 `<cap>_freshness: session|install-time|static`。

---

### P2-7　`degraded` 与 `none` 语义不可分

**证据**：devin/zed 的 `track_status: degraded` + `track_format: none` + `track_fallback: manual-note`（`adapters/registry.yaml:189-192,215-218`）。lint 只要 `<cap>_fallback` 非空即通过（`adapters/lint-adapter.sh:65-67`），"写一句话让人手动记"与"有真实自动降级落点"在数据模型里**没有区别**。

**修复方向**：把 `degraded` 拆成 `degraded`（有自动落点，可机器验证）与 `manual`（仅人工纪律，不产出任何自动副作用），并在 tier 计算规则里让 `manual` 不计入保真度。

---

## 三、契约条款测试覆盖缺口表

| # | 契约条款 | 出处 | lint | conformance | 缺口判定 |
|---|---|---|---|---|---|
| 1 | 该拦却放行（veto 等价 baseline） | contract.md:9 | ✗ | ✅（7 平台 × 3–4 场景，含变异哨兵） | **已覆盖**，但只用 CC 形状载荷（见 #12） |
| 2 | 该注却空（inject 非空且含 baseline） | contract.md:9 | ✗ | ⚠️ 仅子串 `tenon`；不查格式串台、不查内容新鲜度 | **弱覆盖** → P1-1 / P0-4 漏网 |
| 3 | 该留痕却不写（track 真 append） | contract.md:9 | ✗ | ✅ 7 平台真文件系统副作用 | 已覆盖 |
| 4 | 声明 native 却降级 | contract.md:35-37 | ✗ | ⚠️ 仅对**已手写**的平台生效；aider inject 快照未被识别 | **弱覆盖** → P0-4 |
| 5 | 声明 degraded 须有真实 fallback 落点 | contract.md:37, registry.yaml:28 | 只查字段非空 | 只查字段非空（copilot/devin/zed 额外查文件存在） | **缺失** → P1-4（pi） |
| 6 | veto 默认 fail-open，须显式 `failClosed:true` | contract.md:49 | **✗ 完全不查** | 仅 cursor：查 registry 字段 = true + hooks.json 含 `failClosed` 字符串 | **缺失**（其余 10 平台无声明位、无断言）→ P1-2 |
| 7 | hook 崩溃/缺失时的实际行为与声明一致 | contract.md:49 隐含 | ✗ | **✗ 零断言** | **完全缺失** → P1-2 |
| 8 | HITL：`review acknowledge` 是唯一解封路径且必须可达 | contract.md:56-66 | ✗ | 仅 codex `prompt.sh` 一条（UserPromptSubmit 面）；**veto 面零覆盖** | **完全缺失** → P0-1 |
| 9 | 不得把删除 marker 当确认 | contract.md:62 | ✗ | 仅 codex 两条（"不误清/不直接删除"） | 仅 1/12 平台覆盖 |
| 10 | 不串格式（`<cap>_format` 与实际产出一致） | contract.md:73-88 | **✗ 不查 `<cap>_format` 是否填** | 间接（`norm_veto` 按 format 解读）；inject 侧仅 aider 有反向断言 | **弱覆盖** → P1-1 |
| 11 | 新平台必须进 conformance | contract.md:101 | ✗ | **✗**（覆盖表硬编码，见 P1-3） | **完全缺失** |
| 12 | "同一组输入场景喂每个适配器" | contract.md:8,114 | — | 实际是**baseline 形状**输入喂所有适配器；只有 cline/amp 用了各自原生形状 | **语义缺失** → P0-1/P0-2 |
| 13 | 状态写一律经 CLI，不直接编辑 `.pipeline.yaml` | contract.md:102 | ✗ | ✗（无 grep 类静态检查） | **完全缺失** |
| 14 | README 须说明 HITL 路径 | contract.md:100 | ✗ | ✗（codex README 无 `review request`） | **完全缺失** |
| 15 | `hasHooks=true → hookContainer` 非空 | contract.md:96 | ✅ | 间接 | 已覆盖（但不校验 container 路径**格式**，copilot 用 `a|b` 自造多值语法） |
| 16 | tier ∈ {A,B,C}、status 枚举 | contract.md:96 | ✅ | ✅ | 已覆盖 |
| 17 | configure 脚本存在 | contract.md:97 | ✅ | ✅ | 已覆盖（不校验可执行位、不校验能成功执行） |
| 18 | 安装真的生效 | 契约未定义 | — | **✗** | **契约本身缺该条款** → P0-3 |

**统计**：契约可辨识的 18 条约束里，**完全无测试 6 条、弱覆盖 5 条、已覆盖 7 条**。声称"必被 conformance 抓红"的四条红线中，只有 #1、#3 是真硬约束。

---

## 四、"加平台是填表非重写" 达成度评估

### 实测重复度

去注释/空行后逐字 diff：

```
gemini vs continue  [inject] 22 行, diff=0
gemini vs continue  [veto]   12 行, diff=0
gemini vs continue  [track]  12 行, diff=0
gemini vs copilot   [veto]   12 行, diff=0
gemini vs copilot   [track]  12 行, diff=0
gemini vs pi        [inject] 22 行, diff=0
gemini vs pi        [track]  12 行, diff=0
codex  vs gemini    [inject] 22 行, diff=6   ← 副本已经开始漂移
codex  vs gemini    [veto]   12 行, diff=2
codex  vs gemini    [track]  12 行, diff=2
```

`adapters/install.sh` 顶层派发**确实**是 registry 驱动的（`:42-48` `resolve_flag` 遍历 registry cliFlag），这一半做到了。

### 新增一个 A 档平台的真实成本

| 产物 | 行数 | 性质 |
|---|---|---|
| `registry.yaml` 平台条目 | ~20 | 声明式 ✅ |
| `hooks/{inject,veto,track}.sh` | ~46 行代码（+ ~40 行注释） | **命令式，逐字复制** ❌ |
| `settings.json` / `hooks.json` 模板 | ~25 | 半声明式 |
| `install.sh` | 58–98 | **命令式，结构复制、细节各异** ❌ |
| `README.md` | ~50 | 文档 |
| `tools/test-adapters.sh` 手写断言块 | 20–60 | **命令式** ❌ |
| `packages/cli/.../plugin-host.ts` `TENON_HOSTS` | 1 | **命令式，第二真源** ❌ |

**结论：目标未达成（约 50% 完成度）**。声明式的部分（registry + 顶层派发 + lint）做得干净；但**三个 wrapper 是 100% 复制粘贴**（已在 codex 副本上出现 6/2/2 行漂移，包括 `_ROOT` 探测条件从 `-f .../session-start.sh` 变成 `-d .../hooks` 这类语义差异），install.sh 与 conformance 断言也都是手写。一个 wrapper 层 bug（如 P0-1 的工具名归一）需要在 **8 份副本**里分别修。

---

## 五、contract.md 自身的设计缺陷

| # | 缺陷 | 位置 | 性质 |
|---|---|---|---|
| C1 | **能力模型欠拟合**：宣称"内核依赖三类 hook 能力"，实际 baseline 注册 8 个脚本；`confirm-clear`（唯一的 confirm/interaction 解封件）与 `interactive-skill-gate`（写 marker 的那一半）不在模型内，导致适配器上的门只有"上锁"没有"开锁" | contract.md:16-22 vs hooks/hooks.json | 语义不完备 |
| C2 | **fail-mode 被写成 cursor 的私有属性**，而它是所有 hook 宿主的通用维度；且"必须显式 failClosed:true"这条在 wrapper 自身 fail-safe 面前失效 | contract.md:49；registry.yaml:29 | 条款不可机器验证 |
| C3 | **档位判据"能力保真而非传输协议"缺可操作定义**：amp 因此判 A（registry.yaml:302），aider 的 inject 也自称 native（安装期快照）——同一句话既能撑住合理判定，也能撑住 P0-4 那种误判 | contract.md:28-33 | 语义含糊 |
| C4 | **"同一组输入场景"未定义"场景"的形状**：实现选择了 baseline 形状，于是测的是 wrapper 的透传能力，而非它与真实宿主的契约 | contract.md:8,114 | 语义含糊 → 直接导致 P0-1/P0-2 |
| C5 | **§5 承诺"conformance 从 registry 派生"，实现是硬编码 id 列表**；契约与实现已脱节 | contract.md:110-118；registry.yaml:5 vs test-adapters.sh:38,510,554,669 | 已脱节 |
| C6 | **checklist 8 项里 5 项不可机器验证**（§3 stdout 格式匹配、§5 README HITL、§6 进 conformance、§7 状态写走 CLI、以及安装生效），文档自陈"lint 机器校验前 5 项"但实际 lint 只覆盖其中 4 项半 | contract.md:93-102 | 散文条款 |
| C7 | **引用了本仓库不存在的证据**（老仓 spike NOTES） | contract.md:87 | 不可复核 |
| C8 | **契约里没有"安装/部署"这一层**：三能力全部按"wrapper 被正确调用"来定义，完全不管 hook 有没有真的进宿主容器 | 全文缺失 | 结构性盲区 → P0-3 |
| C9 | **自身身份漂移**：`pipeline` CLI vs `tenon` CLI 混用 | contract.md:69,102 | 文档债 |
| C10 | **`degraded` 无强度分级**：真实自动 fallback 与"写句话让人手动做"共用一个枚举值 | contract.md:39-50 | 数据模型欠拟合 |

---

## 六、面向"契约即机器约束"的重构建议

按投入产出排序：

1. **把 registry 从"描述表"升级为"可执行规格"（治 P1-3 / C5 / #11）**
   - `tools/test-adapters.sh` 主循环改成 `for id in $(platform_ids)`，按 `<cap>_status` 自动派生断言族；删掉 4 个硬编码 id 列表。
   - 每个 status 值对应一族强制断言：`native` → 驱动 + 比对 baseline 决策；`degraded` → `<cap>_fallback_path` 必须存在且含 baseline 内容切片；`none` → 断言无对应产物。
   - 效果：加平台后**不写测试也会被覆盖**，忘填字段直接红。

2. **引入"宿主载荷 fixture"作为契约的一等公民（治 P0-1 / P0-2 / C4 / C7）**
   - `adapters/<id>/fixtures/{pretool,posttool,sessionstart}.json` + `adapters/<id>/fixtures/PROVENANCE.md`（证据来源与置信度：`verified-e2e` / `source-read` / `inferred`）。
   - registry 增 `payload_confidence` 字段；conformance 用 fixture 驱动，不再用 CC 形状。
   - 强制场景清单（跨平台统一）：新鲜 marker + 写类 → DENY；新鲜 marker + 只读 → ALLOW；新鲜 marker + `tenon review acknowledge` → **ALLOW**；陈旧 marker → ALLOW；子目录上溯 → DENY。第三条就是 P0-1 的哨兵。

3. **把"载荷归一"从各 wrapper 里抽出来，做成共享库（治 P0-1 / "填表非重写"）**
   - 新增 `adapters/lib/normalize.sh`，导出 `tenon_adapter_normalize <cwd_paths...> <tool_map>`，把宿主载荷统一翻译成 baseline 词汇（cwd / tool_name ∈ {Read,Write,Bash,...} / command）。
   - registry 增 `tool_identity_map`（如 `cline: write_to_file=Write,read_file=Read,execute_command=Bash`）与 `cwd_keys`（如 `workspaceRoots[0]`）。
   - 三个 wrapper 缩到每个 5–8 行、且各平台差异**全部落在 registry 声明里**——这才是真正的"填表非重写"。当前 46 行 × 8 份复制随之消失。

4. **`failmode` 全平台化并可测（治 P1-2 / C2）**
   - registry：`<cap>_failmode: open|closed` 必填，lint 校验。
   - wrapper：fail-safe 分支从"硬编码 allow"改为读取声明。
   - conformance 新场景：把 baseline 脚本临时替换为 `exit 1` / 删除，断言产出与声明的 failmode 一致。

5. **把"安装生效"纳入契约（治 P0-3 / C8）**
   - 契约新增 §6「部署契约」：install 必须以退出码区分 `installed(0) / needs-merge(3) / skipped(4)`，且不得在非 0 路径打印成功语。
   - 新增 `adapters/verify-install.sh <id> --target <dir>`：读宿主容器确认 hook 已注册 → 在临时项目里跑一次 DENY 场景 → 输出机器可读结果；接进 `tenon setup` 的 `adapter-deploy` 步骤（替换掉 `host-target-plan.ts:181` 的"打印一条人工命令"）。
   - conformance 增加"目标目录已有配置"这一路径的断言（当前只测空目录）。

6. **扩展能力矩阵到 baseline 全面（治 P1-5 / C1）**
   - 先加机器检查：`hooks/hooks.json` 里注册的每个 hook id，必须在 registry 的能力枚举里有对应列（或显式列入 `not_portable` 白名单并写明理由）。
   - 至少把 `confirm-clear`（unlock）提升为第 4 能力 `ack`——没有它，veto 在该平台就是单向锁。

7. **`degraded` 分级 + 新鲜度维度（治 P2-6 / P2-7 / C10）**
   - `<cap>_status: native | degraded | manual | none`；`<cap>_freshness: session | install-time | static`。
   - tier 由 status × freshness 矩阵**计算**得出，不再手填——这样 aider inject（native + install-time）会自动落到 B 而非被人工标成 native。

8. **修哨兵的同义反复（治 P2-1）**：断言体抽函数，哨兵调同一函数并断言其 FAIL；把否定式存在性断言（P2-2）换成"读宿主容器产物"的正面断言。

9. **身份与文档债（治 P2-5 / C9）**：`tools/check-legacy-identity.mjs` 的 `forbidden` 增加 ``/`pipeline` CLI/``、`/\/pipeline-/`；统一 gate.sh 的两种门标签。

---

## 附：本轮实际执行的验证命令

```bash
bash adapters/lint-adapter.sh --all          # 12/12 OK
bash tools/test-adapters.sh                  # 272 passed, 0 failed
# P0-1 复现：新鲜 v2 review marker + acknowledge 命令，逐平台驱动 veto wrapper
# P0-2 复现：Cursor workspace_roots 形状载荷 → {"permission":"allow"}
# P0-3 复现：预置 .gemini/settings.json 后跑 install.sh → RC=0 且打印"档 A 全保真完成"
# P1-1 复现：cline TaskStart 输出中 contextModification 内嵌 hookSpecificOutput 信封
# P1-2 复现：TENON_CC_GATE 指向 exit 1 假 gate，逐平台观察 DENY/ALLOW
# 重复度：去注释后 diff gemini/continue/copilot/pi 三 wrapper → 全 0
```

## Caveats / 未能验证

- **各宿主的真实 hook 协议无法在本仓库内复核**：Cursor / Copilot / Cline / Amp / Pi / Continue 的事件名、载荷字段、fail 语义均来自 README 里引述的"老仓 spike"或反编译笔记，本仓库无 fixture、无 spike 目录。P0-2 的严重度取决于 Cursor 是否真的在某些事件里不发 `tool_name`——**该结论基于"wrapper 未做归一 + gate.sh 缺 cwd 即放行"这一可复现的代码事实**，宿主侧行为本身未经真机验证。
- 未审计 `adapters/codex/install.sh`（297 行，含 AGENTS.md 哨兵块 / skills 投影 / native-vs-static 互斥迁移）的完整逻辑——它是唯一被 conformance 深度覆盖的 installer，与本层其余 installer 不同构，建议单列一轮。
- 未评估 `hooks/router.sh` / `hooks/breadcrumb.sh` / `hooks/skill-evidence.sh` 等 baseline hook 的内部正确性（属第 2 层 baseline hook 审计范围），本报告只在"适配器未覆盖它们"这一点上引用。
- `tools/test-hooks.sh`（150KB）与 `tools/verify-skills.sh` 未运行，无法确认本层问题是否在其它测试面被间接覆盖。
