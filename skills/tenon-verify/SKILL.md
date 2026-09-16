---
name: tenon-verify
description: "Pipeline Phase 5: Verify · 三轨并行验证。PM Track 做原型走查（无 review agent），frontend/backend Track 跑 reviewer agent + codex + e2e 三轨并行，同读冻结的 build_sha token。"
---

<!-- TENON:INTERACTION-MODE:START -->
## 交互模式契约（生成区，优先于本 Skill 的普通模式措辞）

进入本 Skill 时，先从 `<tenon-dispatch>.continuous_execution`、当前 Change 的
`pipeline-interaction-authority-v2`（Change 与 host session 均精确匹配）注入上下文和
`tenon session activate --continuous --host-session <id>` 的成功结果
判定模式；不得仅凭对话记忆猜测。若三者均无有效证据，则使用普通交互模式。

- 普通交互模式：执行本 Skill 下文声明的提问、方案选择和 review 确认。
- 持续自主模式：不得为 preset、调研维度、低风险实现细节、build mode、原型数量/推荐方向、
  verify-fail 的“修复或接受偏差”、归档沉淀等具有安全默认值的例行选择暂停或强制用户输入。
  应选择最保守、可逆、可审计的推荐值并写入 Assumptions / Decision Log；verify-fail 一律默认修复，
  不得默认接受偏差；没有高质量可复用内容时默认跳过用户级沉淀。
- 下文出现的“必须询问 / 暂停 / 等用户 / HARD GATE”默认描述普通交互模式；持续自主模式按上一条
  执行。只有会实质改变范围、安全、费用、生产/外部状态，或不存在安全可逆默认值时才暂停。
- 持续自主模式不跳过 Skill、OpenSpec 文档、ADR、验证、guard 或读取收据。review 产物和精确
  `review request --event` 完成后，使用 `review acknowledge --delegated` 留下 Change-bound 回执。
  发布、推送、部署等外部动作仍要求本次任务已有明确授权；持续模式本身不扩大授权。
<!-- TENON:INTERACTION-MODE:END -->

# /tenon-verify — Phase 5: Verify

> **语言：** verification report 沿用 Change 固定 locale（默认中文，显式 `en` 时使用英文）；验证范围、结果、失败和剩余
> 风险使用同一 locale，命令、路径、测试名、退出码、kind/producer 和协议字段保持原样。模板只提供结构，
> 未执行的验证不得写成通过。

> 移植来源：老仓 `skills/tenon-verify/SKILL.md`；脚本面已改写为 `pipeline` CLI。

> **Codex 打包 Skill 身份：** 本文件提到的裸 skill id 是 DAG/ledger 的逻辑 id；在 Codex
> 必须实际加载 `tenon:<id>` 的当前插件副本，绝不以同名全局或项目 SKILL.md 替代。

## 输入

- `$TENON_TRACK` / `$TENON_CHANGE_NAME`

**上下文恢复（强制）**：优先读取 `<pipeline-dispatch>` 的 `change/track/phase`，再跑
`tenon list --json` 和 `tenon status <change> --json` 复核。环境变量只是兼容快捷方式；为空时
不得退出到普通对话。若有多个候选且 dispatch 未指定，才请用户选择。

## 前置条件

- `phase=verify`
- `build_mode` / `isolation` 已设
- `tasks.md` 全勾选
- `build_sha` 已由 `build-complete` 冻结为 canonical token（`tenon get <name> build_sha`）：
  `build:v1:<git|workspace>:<revision_hash>:<repository_hash>:<worktree_hash>`。token 是审查输入身份，
  不是裸 SHA 或可回填的 workspace baseline；Verify 必须重新评估当前 HEAD/workspace、physical identity、
  provenance 与 canonical state digest。

## 步骤

### Step 0: 入口定位

```bash
tenon status "$TENON_CHANGE_NAME"

# Verify 的判断只能基于已被本 phase 实际读取的冻结文档版本，不能凭上一轮对话记忆。
tenon document read "$TENON_CHANGE_NAME" all

# 支持 Context Bundle v1 的 runtime 应从 ledger 编译 verify 上下文，消费精确冻结输入。
# 旧 runtime 没有 --bundle 时继续以上述 document read receipt 为准。
tenon handoff "$TENON_CHANGE_NAME" --bundle --target verify --json
```

> **review 门提示**：verify 是 review 相位，但进入时不会落 marker；三轨验证、报告生成和文档读取必须
> 先完整执行。`tenon check` 是 `verify-pass` 的成功出口校验，放在 Step 4 跑；回退则走独立的
> `tenon review request --event verify-fail` 证据校验，不能拿通过路径的 guard 卡死失败决策。

### Step 0.5: 开始唯一的候选 Review attempt（任何 Review 派发前 HARD GATE）

先读取冻结候选，再原子 begin；默认 Workflow 的 required lanes 是 `standards/spec/e2e`。本命令在
预算耗尽时非零退出，必须立即停止，不能派发 Skill、reviewer agent 或 E2E runner，也不能自动提高预算。

```bash
BUILD_BASELINE="$(tenon get "$TENON_CHANGE_NAME" build_sha)"
ATTEMPT_JSON="$(tenon review-attempt begin "$TENON_CHANGE_NAME" \
  --candidate "$BUILD_BASELINE" --json)" || exit $?
ATTEMPT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.attemptId)' "$ATTEMPT_JSON")"
```

`review-attempt begin` 接受当前 canonical `build:v1` token，并在比较/存储前规范化为既有
`sha256:<revision_hash>` candidate ABI；同一 token resume 不增加 `used`，token 变化必须产生新的
candidate/attempt。非 canonical token、旧裸 SHA、任意 workspace baseline、空白包裹值或伪造输入均拒绝。

同一候选重启或上下文恢复时，`begin` 返回相同 `ATTEMPT_ID` 且不增加 used。Standards/Spec reviewer、
security、E2E/API/browser/visual/public acceptance、Codex 轨都消费这个 id；lane 重试、E2E shard 和进程
恢复不得再次 begin。TDD、unit、typecheck、lint 已属于 Build 反馈，不在这里另扣次数。

> **全量聚合规则（HARD）**：所有适用轨必须读取同一冻结基线。Reviewer 必须审完整冻结 diff、
> 全部 changed/untracked 交付文件与所有受影响 capability，调用方给出的“重点关注”只能增加专项，
> 不能缩小范围。任一轨先发现 CRITICAL/HIGH 时，其余已适用轨仍要完成；主线等待全部轨返回后，
> 去重并一次性聚合全部 findings 再作 pass/fail。verify-fail 后的下一轮既回归已知 finding，也重新
> 全量审冻结 diff，禁止只复查上轮问题。

> **有限次数规则（HARD）**：上述全部轨只是同一个 attempt 内的 lanes，不是多个 Review。任何可选
> Review Skill 也必须先由 internal Skill gate 证明 active attempt；第三方 Skill 通过 Workflow
> `kind: review` + `review_lane` 显式分类，不按名称猜测。

> **repo-zero-output barrier（HARD）**：`in-place` 从读取 `build_sha` 到全部轨聚合完成期间，
> 真实工作区必须保持零实现/配置/生成物写入，且 dispatch 前必须确认没有仍在运行的 writer。
> build、bundle、codegen、release asset 生成、会重写 tracked snapshot 的测试等命令必须在 Build
> 冻结前完成；Verify 如需重跑，只能在保留权限和 symlink 的隔离副本执行。截图、Playwright
> snapshot、trace、coverage、各轨原始审查产物与日志必须显式写到仓库外的临时目录；例外是工作流测试项
> 声明过的输出（`test-results/`、`playwright-report/`、`coverage/`）——这三个目录不进工作区指纹，
> 由 `tenon test run` 登记，报告的测试段由 `tenon test report --write` 从记录生成。全部轨结束并
> 一次性聚合后，workflow 声明的 canonical `verification_report` 是唯一允许写入仓库并登记的
> 治理产物；不得由某一轨边跑边写。每轨前后都重算 fingerprint；
> 任一瞬时不一致即该轨无效并走 `verify-fail`，不得通过删除/还原产物来“恢复”冻结结论。

### Step 1: Track 分支调用

#### 📋 Track = pm（原型走查 / 人工 verify）

**强制 Skill**（禁止跳过）：

1. 使用 Skill 工具加载 `browser-qa`。**禁止跳过此步骤**。
   - 在浏览器走查原型可点击性

2. 使用 Skill 工具加载 `web-design-guidelines`。**禁止跳过此步骤**。
   - 对照 UI 设计规范

3. 使用本插件打包的 Skill `design-taste-frontend`。**禁止跳过此步骤**。
   - 设计 review 二次把关

4. 使用本插件打包的 Skill `verification-before-completion`。**禁止跳过此步骤**。
   - 验收 checklist

**PM Track 没有 reviewer agent。** 验证完成后由用户**手动**确认，然后设置：

```bash
tenon set "$TENON_CHANGE_NAME" verify_result pass
tenon artifact register "$TENON_CHANGE_NAME" verification_report \
  "docs/superpowers/reports/$(date +%Y-%m-%d)-<name>-prototype-review.md" \
  --producer verification-before-completion
tenon set "$TENON_CHANGE_NAME" branch_status handled
```

跳到 Step 4。

#### 🎨 Track = frontend（三轨并行）

⚡ **HARD RULE**：以下 3 轨**必须在同一条 Agent 消息**内并行 dispatch。

> **三轨同读冻结的 `build_sha` token（barrier）**：verify 审的是 build-complete 时冻结的固定靶，不是漂移中的 working tree。先取 token 并按 kind 分流。Git 分支随后读取当前 HEAD 作为执行锚点；它不是 token 解码结果：
> ```bash
> BUILD_BASELINE="$(tenon get "$TENON_CHANGE_NAME" build_sha)"
> case "$BUILD_BASELINE" in
>   build:v1:workspace:*)
>     # in-place token：审查同一 workspace content identity；不得把 token 当作 raw path 或 baseline 回填。
>     unset BUILD_SHA
>     echo "[verify] workspace build token captured"
>     ;;
>   build:v1:git:*)
>     # token 不能解码为 raw SHA。后续 Codex/E2E/quality snippets 只使用当前 HEAD 锚点。
>     BUILD_SHA="$(git rev-parse HEAD 2>/dev/null)" || {
>       echo "[verify] cannot read current git HEAD; fail closed" >&2
>       exit 2
>     }
>     if ! printf '%s\n' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'; then
>       echo "[verify] current git HEAD is not a valid object id; fail closed" >&2
>       exit 2
>     fi
>     export BUILD_SHA
>     # 这只是后续 Codex/E2E/quality 命令的执行锚点；最终 tenon check/transition 的 typed assessor
>     # 才建立 token ↔ 当前 HEAD、physical identity、provenance 与 canonical state digest 的可信性。
>     # repo-zero-output barrier 证明审查期间工作区没有写入。
>     echo "[verify] current HEAD anchor captured; typed revalidation required"
>     ;;
>   *)
>     echo "[verify] untrusted build revision; return to build and capture current revision" >&2
>     exit 2
>     ;;
> esac
> ```
> reviewer agent / e2e 审该 token 对应的代码状态；Git token 的当前 HEAD/identity 绑定由 typed assessor 复核，workspace token
> 需审当前内容 identity。任一 assessment 失败都保留 `verify-build-revision-untrusted`、reason、stateHash/
> revisionHash 与 remediation=`return-to-build-and-capture-current-revision`，不允许 set/backfill。

**并发实现指南**：
- 主 agent 一次性发起 3 个 tool 调用（2 个 Agent + 1 个 Bash）；含 UI 改动时再加第四轨 `tenon-design-reviewer` agent（视觉），同消息一并发起
- 不要等任一返回再发下一个
- 每个 reviewer agent 独立 context，彼此不知道对方
- Codex CLI 通过 Bash 工具独立进程执行
- 完成后聚合到 verification_report

> ⏳ **待迁移（M2 #21）**：老仓 skill-tracker hook 自动写 tools_history（三轨留痕 → 看板可视化
> + guard V9 留痕硬卡）尚未迁移；当前证据落 `verification_report` 文件本体 +
> `.pipeline-history.jsonl`。

**强制 Skill**（禁止跳过）：

1. 使用本插件打包的 Skill `verification-before-completion`。**禁止跳过此步骤**。

2. 使用 Skill 工具加载 `e2e-testing`。**禁止跳过此步骤**。
   - Playwright E2E 模式

3. 使用 Skill 工具加载 `browser-qa`。**禁止跳过此步骤**。
   - 可视化 QA 验证

4. 使用 Skill 工具加载 `verify`。**禁止跳过此步骤**。
   - 运行 app 实际验证行为

**含 UI 改动时强制（视觉轨；下面三轨全是代码/行为验证、不覆盖视觉）**：

5. **含 UI 改动时禁止跳过**：把视觉审作为**第四并行轨**——与上面三轨**同消息** dispatch 一个 **`tenon-design-reviewer` agent**（本仓 agents/tenon-design-reviewer.md，隔离上下文，读冻结的 `build_sha` 固定靶），让它加载 `web-design-guidelines` + `design-taste-frontend`，对**跑起来的 app**做视觉审查（截图关键屏 + 主要状态、查交互态/材质/反模板红线/无 emoji）。
   - Verify 视觉轨严格只读，不写仓库内 REVIEW.md、不修页面；截图/trace 只能写仓库外临时目录。
     它回传 severity findings + 「已无 critical/high/medium」结论；主线把视觉结论并入
     verification_report，有 critical/high/medium 或证据不完整则 verify-fail 回 build。主线
     **不内联**跑视觉审。

**可选 Skill**：
- 使用 Skill 工具加载 `run` — 启动 dev server
- 使用 Skill 工具加载 `security-review`（builtin）

**【轨道 1】Reviewer Agent（并行）**：
- Agent 工具调用 `tenon-reviewer`（本仓 agents/tenon-reviewer.md）— 读冻结 build token；Git 分支由 typed assessor 复核当前 HEAD/identity 后审完整提交区间 diff，in-place 枚举并审当前未漂移工作区全部 changed/untracked 交付文件；回读全部受影响 capability，按改动语言套评审视角（TS/JS 专项 + 通用），回传 coverage、全部 severity 发现 + PASS/FAIL。固定靶全量 brief 已收进 agent，无需在此重述。

**【轨道 2】E2E（并行）**：
- dispatch 一个通用子 agent（Agent 工具），brief：Git 分支先由 typed assessor 复核 token 与当前 HEAD/identity，再以已读取的 `BUILD_SHA` 作为只读执行锚点；
  in-place 时读取当前未漂移工作区，加载 `e2e-testing` skill 跑 repo-zero-output E2E；所有截图、
  snapshot、trace、coverage 与日志写仓库外临时目录，会写 tracked 产物的命令改在隔离副本运行；
  前后 fingerprint 必须精确一致，回传通过/失败清单。（老仓专职 `e2e-runner` agent 未迁移，
  若本机装有可直接用。）

**【轨道 3】Codex CLI（并行，审冻结 SHA 的提交区间；缺失优雅降级）**：

```bash
# codex 缺失 → 第三轨跳过（reviewer+e2e 两轨仍审固定靶），不算 FAIL。
if [ -n "${BUILD_SHA:-}" ] && command -v codex >/dev/null 2>&1; then
  git diff "$BUILD_SHA"^.."$BUILD_SHA" | codex exec "review this diff: correctness/security/error-handling; 输出带 severity 的发现清单 + PASS/FAIL 结论" || echo "[WARN] codex 轨异常，降级两轨"
elif [ -z "${BUILD_SHA:-}" ]; then
  echo "[INFO] in-place 内容基线：Codex 轨审当前未漂移工作区；最终 verify-pass 会重算基线"
else
  echo "[WARN] codex CLI 未装，第三轨跳过（两轨仍有效）"
fi
# 多提交区间（verify-fail 回环产生多个 build commit）：git diff <review base>..."$BUILD_SHA"
```

> ⏳ **待迁移（M2 verify 全量面）**：老仓 `pipeline-codex-review.sh`（commit-scoped /
> 绕 #17160 / --commit-vs-stdin / xhigh 全部 nuance 已收敛进脚本）未迁移，上面是直接调
> codex CLI 的等价降级写法。

**可选 Agent**：
- `database-reviewer`（外部，若装有）— 若涉及 DB schema

#### ⚙️ Track = backend（多语言 reviewer 并行）

> **三轨同读冻结的 `build_sha` token（barrier）**：同 frontend，先按上方 `BUILD_BASELINE` 分流。Git 分支的提交区间命令只能使用已读取并校验的当前 `BUILD_SHA` 锚点；不得从 token 解码 SHA。in-place 必须审当前未漂移工作区，最终由 `verify-pass` 重新指纹验证。

**强制 Skill**：
1. 使用本插件打包的 Skill `verification-before-completion`。**禁止跳过此步骤**。

**推荐 Skill**：
- 使用 Skill 工具加载 `e2e-testing` — API E2E 测试
- 使用 Skill 工具加载 `verify` — 运行服务实际验证
- 使用 Skill 工具加载 `security-review`（builtin） — 后端安全专项

**可选 Skill**：
- 使用 Skill 工具加载 `run`
- 使用 Skill 工具加载 `code-review`（builtin）
- 使用 Skill 工具加载 `python-testing`（若 Python）

**【轨道 1】强制 Reviewer Agent（并行）**：
- Agent 工具调用 `tenon-reviewer` — 读冻结 build token；Git 分支由 typed assessor 复核当前 HEAD/identity 后审完整提交区间 diff，in-place 枚举并审当前未漂移工作区全部 changed/untracked 交付文件；回读全部受影响 capability，**按改动语言自动套视角**（Python/Go/Rust/Java/TS 后端），回传 coverage、全部 severity 发现 + PASS/FAIL。多语言全量 brief 已收进 agent，**无需逐语言列 reviewer**。
- `database-reviewer`（外部，若装有）— 涉及 DB schema/查询时（专项，tenon-reviewer 不覆盖）

**【轨道 2】E2E（并行）**：
- dispatch 通用子 agent 加载 `e2e-testing` 跑 API E2E（同 frontend 轨道 2 写法）。

**【轨道 3】Codex CLI（并行）**：同 frontend 轨道 3 的降级写法。

#### 🕊️ Track = free（中性验证）

1. 使用本插件打包的 Skill `verification-before-completion`。**禁止跳过此步骤**。
2. 全文读取冻结基线、Change 文档、delta spec 和 plan；按目标本身运行最新的
   build、类型、测试、lint 与行为 smoke，不自动叠加前端、后端或 PM 验证矩阵。
3. 对 UI/API/安全等仅在 Change 实际涉及该面时运行相应验证，报告必须列出运行项、
   未运行项和残余风险。
4. 完成下方逐文件 spec 回读与隔离副本 delta 应用演练，生成 verification report，
   登记文档证据，并设置：

```bash
tenon set "$TENON_CHANGE_NAME" branch_status handled
```

`free` 保留冻结基线、报告、tasks、文档读取、review receipt 与
`verify-pass` barrier；它不继承工程 Track 的强制双 reviewer 字段。

### Step 1.5: Quality Check — git diff 逐文件回读规范（HARD RULE · 硬门）

⚡ **HARD RULE**：spec/stack 规范的注入是**软的**；本步用 `git diff --name-only` 把改动
**逐文件**对照对应 capability `spec.md` **回读勾选**，作为 verify 通过的**硬门**——未逐项勾选
不得 verify-pass。对标 Tenon contract check agent 强制 `git diff --name-only` + `git diff` 逐条对 spec。

```bash
# 1) Git 分支列出 typed assessor 复核后的 review 区间改动文件；in-place 没有 Git 区间，逐文件审当前工作区并保持其不变。
if [ -n "${BUILD_SHA:-}" ]; then
  git diff --name-only "${BUILD_SHA:-HEAD}" 2>/dev/null || git diff --name-only
else
  git diff --name-only
fi

# 2) 逐文件：找对应 capability 的主 spec 回读比对
find openspec/specs -name spec.md 2>/dev/null    # 每 capability → spec.md 路径
```

> ⏳ **待迁移（M1 #16 living-spec / #18 manifest 派生）**：老仓 `pipeline-state.sh specs`
> 的逐 capability 细粒度路由表与 L4 Pre-Dev Checklist 映射未迁移——当前用上面 `find` 全列 +
> 人工匹配，语义等价但无自动路由。

**逐文件回读勾选**（每个改动文件至少勾一行，否则 HARD STOP，不得进 Step 4 verify-pass）：

| 改动文件 | 命中的 capability spec | 已回读规范并比对 diff |
|---------|------------------------|----------------------|
| （git diff --name-only 逐行填）| openspec/specs/<cap>/spec.md | ☐ |

### Step 1.6: OpenSpec 隔离应用演练（HARD RULE · 硬门，frontend/backend/free）

⚡ **HARD RULE（固定靶 + 单一应用边界）**：Verify 不得写真实 `openspec/specs/`。将完整工作区复制到
隔离临时目录，在副本中运行官方 `openspec show`、strict validate 和 archive/apply 演练；记录命令、
版本、退出码和主规格前后 digest。Ship 是唯一真实应用边界，负责幂等写主规格并生成 applied-spec
receipt；Archive 对已应用 Change 使用 `--skip-specs`，不得第三次合并。

```bash
openspec show "$TENON_CHANGE_NAME" --json --deltas-only
openspec validate "$TENON_CHANGE_NAME" --strict
VERIFY_COPY="$(mktemp -d)"
# 用保留 symlink/权限的仓库复制方式建立隔离副本后，在副本运行：
openspec archive "$TENON_CHANGE_NAME" --yes --json
```

演练前后真实工作区的冻结 fingerprint 与 `openspec/specs/**/spec.md` digest 必须相同；临时副本中的
archive 必须成功且产出的 main spec 通过 strict validate。缺少官方 CLI、show/validate/archive 失败、
真实主规格被修改或 digest 漂移均为 **HARD STOP**，不得 verify-pass。

### Step 2: 聚合 review 结果

必须等待全部适用轨完成；合并、去重 findings，并保留每轨覆盖面与未验证项。完成后才可显式写入状态
（防止下一阶段误判）：

```bash
# 若所有 reviewer agent 都 pass
tenon set "$TENON_CHANGE_NAME" agent_review_result pass

# 若 codex pass（codex 缺失跳过时同样置 pass 并在报告注明"第三轨降级"）
tenon set "$TENON_CHANGE_NAME" codex_review_result pass

# 生成聚合报告
REPORT_PATH="docs/superpowers/reports/$(date +%Y-%m-%d)-${TENON_CHANGE_NAME}-verify.md"
# ... 写报告（含三/四轨结论 + Step 1.5 勾选表 + Step 1.6 隔离演练记录）...
tenon artifact register "$TENON_CHANGE_NAME" verification_report "$REPORT_PATH" \
  --producer verification-before-completion

# 三条 lane 都绑定同一 attempt。每条 result 来自报告中的对应结论；任一 fail 则整轮只能 complete=fail。
tenon review-attempt lane "$TENON_CHANGE_NAME" --attempt-id "$ATTEMPT_ID" \
  --lane standards --result <pass|fail> --report "$REPORT_PATH"
tenon review-attempt lane "$TENON_CHANGE_NAME" --attempt-id "$ATTEMPT_ID" \
  --lane spec --result <pass|fail> --report "$REPORT_PATH"
tenon review-attempt lane "$TENON_CHANGE_NAME" --attempt-id "$ATTEMPT_ID" \
  --lane e2e --result <pass|fail> --report "$REPORT_PATH"

# 全部 lane 通过才允许 pass；否则用 fail 完成同一次 attempt，再走 verify-fail。
tenon review-attempt complete "$TENON_CHANGE_NAME" --attempt-id "$ATTEMPT_ID" \
  --result <pass|fail> --report "$REPORT_PATH"
```

### Step 2.25: 登记验证报告（受治理 workflow 强制）

先实际调用本插件 `verification-before-completion`，再登记最终报告。报告每次修改都会改变 SHA-256；
修改后必须重新登记，不能沿用旧证据。

```bash
REPORT_PATH="$(tenon get "$TENON_CHANGE_NAME" verification_report)"
tenon document record "$TENON_CHANGE_NAME" verification-report "$REPORT_PATH" \
  --producer verification-before-completion
# 勾选本阶段的 Verify checkbox 后，由 phase driver 登记 tasks 当前 digest。
TASKS_PATH="openspec/changes/$TENON_CHANGE_NAME/tasks.md"
tenon document record "$TENON_CHANGE_NAME" tasks "$TASKS_PATH" --producer tenon-verify
tenon document read "$TENON_CHANGE_NAME" all
tenon document status "$TENON_CHANGE_NAME"
```

### Step 3: 处理分支

**立即执行**：使用本插件打包的 Skill `finishing-a-development-branch`（推荐，按需）。

完成后：
```bash
tenon set "$TENON_CHANGE_NAME" branch_status handled
```

### Step 4: 验证（不自动推进）

```bash
tenon document status "$TENON_CHANGE_NAME"
tenon check "$TENON_CHANGE_NAME"     # verify 出口：0 过 / 2 不过
```

`tenon check` 在 review fields 或 verification evidence 尚未登记时可以按上述规则返回非零；这只是前期状态检查，
不能声称 Verify 在 Review 前整体 PASS。最终可信性仍由 typed assessor 对当前 HEAD/workspace、physical identity、
provenance 和 state digest 的复核决定。

guard 通过条件（GUARD-RULES §5，按 Track 不同）：

**PM Track**:
- `verify_result=pass`（人工设）

**frontend/backend Track**:
- `agent_review_result=pass`
- `codex_review_result=pass`
- `verification_report` 字段非空且文件存在
- `branch_status=handled`

**free Track**:
- `verification_report` 字段非空且文件存在
- `branch_status=handled`
- 不要求工程 Track 的 `agent_review_result` / `codex_review_result`

guard **只校验、不自动 transition**。若验证通过，先运行：

```bash
tenon review request "$TENON_CHANGE_NAME" --event verify-pass
```

它会为 **verify-pass** 写 pending receipt 并阻止在最终报告之后再静默改写结论。把 verification_report
交用户过目；用户明确确认、hook 写入 `tenon review acknowledge` receipt 后，手动推进
`tenon transition "$TENON_CHANGE_NAME" verify-pass`。CLI 副作用会落 `verify_result=pass` + `verified_at`。

若报告结论是失败、需要回到 build：不要运行成功路径的 `tenon check`（它故意要求 pass）。先保证
`verification_report` 已生成、文件存在且 OpenSpec 文档证据已登记，然后运行：

```bash
tenon document status "$TENON_CHANGE_NAME"
tenon review request "$TENON_CHANGE_NAME" --event verify-fail
```

该 request 只校验失败决策可审计所需的报告与文档证据；用户确认回退决定后，hook 写入同一个
`verify-fail` receipt，再手动运行 `tenon transition "$TENON_CHANGE_NAME" verify-fail`。CLI 会落
`verify_result=fail`、清空 `build_sha`，并把 `pre_verify_review_result` 重置为 `pending`。
返工后的下一轮必须同时回归已知 finding 与重新全量审查新冻结 diff。
`verify-fail` receipt 不能用于 `verify-pass`，反之亦然。

## 出口

- 事件：`verify-pass` 或 `verify-fail`
- pass 下一 phase：`ship`；fail 下一 phase：`build`（回退）
- 均**用户确认后手动进入**，不自动 chaining

## 决策节点（暂停等用户）

verify-fail 时**必须暂停**询问用户：
- 修复（回到 build）
- 接受偏差并强制通过（需说明原因，写入 verification_report）

提问时写明可解锁的回复：用户回复「确认继续」即确认已请求的 `verify-fail` 评审并回到 build 修复；
「修复」「好的」这类回复不会确认评审。用户要接受偏差时须说明理由，不能用「确认继续」代替。

## 打包 skill 依赖（随 tenon 插件安装）

- bundled-skill: verification-before-completion · 强制
- bundled-skill: finishing-a-development-branch · 推荐
- bundled-skill: browser-qa / web-design-guidelines / design-taste-frontend · PM、前端与视觉轨
- bundled-skill: e2e-testing / verify · 前端强制、后端推荐
- bundled-skill: run / security-review / code-review / python-testing · 条件或可选
