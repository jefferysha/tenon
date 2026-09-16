---
name: tenon-spec
description: "Pipeline Phase 3: Spec · 规格 + 实施计划。所有 Track 产出 OpenSpec delta spec + 可执行 Plan；PM 额外画用户旅程图。"
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

# /tenon-spec — Phase 3: Spec / Plan

> **语言：** 沿用 Change 在 `.pipeline-document-locale.json` 固定的 locale，新 Change 默认中文。delta spec 的
> requirement/scenario 正文与实施计划沿用固定 locale（默认中文，显式 `en` 时使用英文）；`ADDED/MODIFIED/REMOVED Requirements`、
> frontmatter key、coverage key、路径、kind、producer 和命令保持英文协议 token。缺失文档先用
> `tenon document scaffold` 建立结构，scaffold 本身不登记 producer。delta spec 必须使用
> `tenon document scaffold <change> delta-spec --capability <capability>`，真实 capability
> 不得用 Change 名或默认 scope 猜测。每条 requirement 正文必须含英文 `SHALL` 或 `MUST`（例如
> 「系统 SHALL 从 `board.tasks` 移除该任务」）：OpenSpec strict validate 不接受中文「必须」，Verify 会因此失败并退回
> Spec。请求 `spec-complete` review 前，官方 `openspec` CLI 可用时先运行 `openspec validate <change> --strict`。

> 移植来源：老仓 `skills/tenon-spec/SKILL.md`；脚本面已改写为 `pipeline` CLI。

> **Codex 打包 Skill 身份：** 本文件提到的裸 skill id 是 DAG/ledger 的逻辑 id；在 Codex
> 必须实际加载 `tenon:<id>` 的当前插件副本，绝不以同名全局或项目 SKILL.md 替代。

## 输入

- `$TENON_TRACK` / `$TENON_CHANGE_NAME`

**上下文恢复（强制）**：优先读取 `<pipeline-dispatch>` 的 `change/track/phase`，再跑
`tenon list --json` 和 `tenon status <change> --json` 复核。环境变量只是兼容快捷方式；为空时
不得退出到普通对话。若有多个候选且 dispatch 未指定，才请用户选择。

## 前置条件

- `phase=spec`
- `design_doc` 字段非空且文件存在

## 步骤

### Step 0: 入口定位

```bash
tenon status "$TENON_CHANGE_NAME"
```

> **review 门提示**：spec 是 review 相位，但进入时不会写 `.pipeline-pending-review`，所以可正常读取
> 前序证据、完成 delta spec 与计划。`tenon check` 是出口校验；通过后才 `tenon review request --event spec-complete`，
> 再按常规确认或已委托 Change 的 `acknowledge --delegated` 进入 Build。

### Step 1: 读上下文

```bash
DESIGN_DOC=$(tenon get "$TENON_CHANGE_NAME" design_doc)
# design_doc 全文注入：覆盖十层（业务规则/状态机/不变量），不截断
[ -f "$DESIGN_DOC" ] && cat "$DESIGN_DOC"

# 这会为 proposal / initial design / tasks / Superpower design / ADR 写入本 phase 的精确 hash 收据。
tenon document read "$TENON_CHANGE_NAME" all
```

### Step 2: Track 分支调用

> ⚠️ **交互式 skill（brainstorming / grill-with-docs）的硬姿态 → 见 SessionStart 注入的
> `templates/workflow.md` 第三节「HITL 原则」**（每次调用 brainstorming/grill 前过一遍，别走过场）。
> 核心一句：**任何 gap 都用 AskUserQuestion 批量问、答完重扫、迭代到清零，别自行假设、别问 2 个就收；硬取舍落 ADR、plan 只引用。** spec 无额外姿态条款（research-subagent 是 explore 专属）。

#### 📋 Track = pm（用户旅程 / 03 JOURNEY）

**立即执行**（按顺序）：

1. 使用本插件打包的 Skill `brainstorming`（**必做，但按上面「硬姿态」运行**，别走过场）。
   - ARGUMENTS 包含：`focus: user journey mapping; existing design_doc: <DESIGN_DOC 全文路径，让 skill 自读，勿压成摘要>`
   - 产出：`docs/superpowers/plans/<DATE>-<topic>-journey.md`（用户旅程图 + 关键动线）

   **用户旅程深度 rubric（HARD RULE，6 项全覆盖才算 spec-complete，缺项不许进 build）：**
   一条线性主动线表格 = 不合格(应付)。必须深入展开：
   1. **角色 / persona**：显式分段(不是笼统"用户")，每个角色的目标 / 痛点 / 使用场景 / MVP 优先级；
   2. **每角色一条旅程**：主要角色各自走一遍，不是所有人共用一条线；
   3. **每步落到具体页面 / 屏**：旅程每一步 → 实际页面，给出信息架构 / 页面清单；
   4. **每屏交互 + 状态**：主操作 + 空态 / 加载 / 错误 / 成功 / 边界态，逐一写明；
   5. **用户故事 + 验收**：As a <角色>, I want <X>, so that <Y> + 可验证的验收标准；
   6. **全流转图**：happy path + 替代路径 + 错误/恢复，画成流程 / 状态图(mermaid 或 ASCII)，不止主动线。
   术语遵守 CONTEXT.md 统一语言。写完按这 6 项自检，缺哪项补哪项。

2. 使用 Skill 工具加载 `grill-with-docs`。**禁止跳过此步骤**（禁止 agent 自判「无不对称」就跳——PM 旅程几乎必有内部事实不对称）。
   - 用于：拿用户的领域知识对照旅程找断点，一次一问、等用户答；并逐项核对上面 6 项 rubric 是否真覆盖

3. 使用 Skill 工具加载 `openspec-propose`。**禁止跳过此步骤**。
   - 用于：把已经确认的用户旅程转成可实施的 delta spec。
   - 产出：`openspec/changes/<name>/specs/<capability>/spec.md`。

4. 使用本插件打包的 Skill `writing-plans`。**禁止跳过此步骤**。
   - 用于：把旅程和 delta spec 拆成带验收条件的实施计划。
   - 产出：`docs/superpowers/plans/<DATE>-<feature>.md`，文件头包含 `change: <name>` 与
     `design-doc: <design_doc 路径>` 元数据。

**可选**：
- 使用 Skill 工具加载 `grill-with-docs` 二轮 — 旅程对照现有 spec/ADR 找盲点

#### 🎨 Track = frontend

**立即执行**（按顺序）：

1. 使用 Skill 工具加载 `openspec-propose`。**禁止跳过此步骤**。
   - 用于：生成 delta spec
   - 产出：`openspec/changes/<name>/specs/<capability>/spec.md`

2. 使用本插件打包的 Skill `writing-plans`。**禁止跳过此步骤**。
   - 用于：把 design_doc 拆为可执行计划
   - 产出：`docs/superpowers/plans/<DATE>-<feature>.md`
   - 文件头必须含 `change: <name>` 和 `design-doc: <design_doc 路径>` 元数据
   - **plan 结构遵守下面「fe/be plan 硬约束」三条（B1 tracer bullet / B2 子阶段切窗 / B3 原型决策点）**

**可选**：
- 使用 Skill 工具加载 `to-tickets` — 拆 plan 为 GitHub issues

#### ⚙️ Track = backend

**立即执行**（按顺序）：

1. 使用 Skill 工具加载 `openspec-propose`。**禁止跳过此步骤**。
2. 使用本插件打包的 Skill `writing-plans`。**禁止跳过此步骤**。
   - **plan 结构遵守下面「fe/be plan 硬约束」三条（B1 tracer bullet / B2 子阶段切窗 / B3 原型决策点）**

**可选**：
- 使用 Skill 工具加载 `to-tickets`

#### 🕊️ Track = free（中性规格与计划）

**立即执行**（按顺序）：

1. 使用 Skill 工具加载 `openspec-propose`。**禁止跳过此步骤**。
   - 根据中性 Explore design 生成所有受影响 capability 的 delta spec。
2. 使用本插件打包的 Skill `writing-plans`。**禁止跳过此步骤**。
   - 计划只按目标本身拆解，不补 PM、前端或后端模板任务。
   - 每项仍须给出文件/行为落点、验证方式和回滚边界。
3. 按 Step 3–5 登记 plan/delta/tasks，全文重读当前 digest，并走
   `spec-complete` 的 review receipt。

`free` 的 `coverageProfile=none` 跳过领域覆盖矩阵，但 OpenSpec delta、
Superpowers plan、tasks 唯一 Todo 源和 review 门全部保留。

#### 🧱 fe/be plan 硬约束（HARD RULE，仅 frontend/backend Track 适用；PM/free 不受此领域模板约束）

> 下面三条针对本插件 `writing-plans` 产出的 plan。写完 plan 按这三条自检，缺哪条补哪条。

1. **B1 · 首阶段必须是 tracer bullet（曳光弹 / 纵向切片）**
   plan 的**第一个阶段**必须纵向打通一条**端到端最小链路**——贯穿**当前 track 涉及的各层**、用最简单数据先跑通，别要求不存在的组件：全栈=service+路由+UI；纯后端=数据/schema→service→API endpoint（返回真实数据）；纯前端=组件→路由→状态/数据渲染。**禁止横向分层**（按层逐个做、到很晚才集成）。
   理由：尽早暴露集成风险与 unknown unknowns（出自《程序员修炼之道》Tracer Bullet）。横向分层会把反馈推到最后才到，集成爆炸现得太晚。

2. **B2 · build 按上下文窗口切多子阶段**
   plan 必须把 build **拆成多个子阶段，每个子阶段 ≈ 一个干净上下文窗口能装下**；在 plan 里**显式标注子阶段边界**，并在每个边界处标注 **「此处建议 /clear」**。
   理由：LLM 聪明区仅前 ~8 万–10 万 token（约 40%），大功能 build 不切会漂进「愚钝区」（幻觉 / 丢信息 / 推理退化）。多阶段计划 = 每子阶段独占一个干净窗口执行。

3. **B3 · 原型先行决策点（AskUserQuestion 拍板，可选但不许默认跳过）**
   当 fe/be 存在「跑不跑得通 / 数据模型 / 状态机 不确定」的未知时，在进入正式 build 前，用 **AskUserQuestion** 问用户：是否插入一次性 `prototype` 原型摸底（复用 `prototype` skill）。
   这是个**决策点**，由用户拍板——**别默认跳过**，也别擅自决定做或不做。
   理由：Prototyping 主张先用一次性原型排除「未知的未知」，再进 TDD 正式实现，避免直接 build 的返工成本。

### Step 3: 登记 plan 路径

```bash
tenon artifact register "$TENON_CHANGE_NAME" plan \
  "docs/superpowers/plans/$(date +%Y-%m-%d)-<feature>.md" --producer writing-plans
```

### Step 3.25: 登记 delta spec 与 Superpowers plan（受治理 workflow 强制）

default 各 track 必做；其它 workflow 只在当前 step 拥有 delta-spec/plan slot 时执行，
不得因为 step 名类似 spec 就自动补齐。default 在用户旅程之后
补跑 `openspec-propose` 与 `writing-plans`，生成可实施的 delta spec/plan。这让“新 workflow 遵守
OpenSpec”是机器可检查的事实，而不是标签。

```bash
PLAN_PATH="$(tenon get "$TENON_CHANGE_NAME" plan)"
# 若一个 change 影响多个 capability，逐个登记全部 delta spec。
find "openspec/changes/$TENON_CHANGE_NAME/specs" -type f -name spec.md -print 2>/dev/null \
  | while IFS= read -r delta; do
      tenon document record "$TENON_CHANGE_NAME" delta-spec "$delta" --producer openspec-propose
    done
tenon document record "$TENON_CHANGE_NAME" superpower-plan "$PLAN_PATH" --producer writing-plans
tenon document record "$TENON_CHANGE_NAME" plan "$PLAN_PATH" --producer writing-plans
```

### Step 4: 同步 tasks.md

将 plan 拆出的 todo 同步到 `openspec/changes/<name>/tasks.md`，每项为 `- [ ]`。

`tasks.md` 是活文档：它的内容一旦被 spec 更新，旧的 open-phase `openspec-propose` 哈希和 producer
都不能继续代表当前内容。必须由**本 phase 已实际调用的 `tenon-spec`**重新登记，严禁用
`--backfill` 借用旧 producer：

```bash
TASKS_PATH="openspec/changes/$TENON_CHANGE_NAME/tasks.md"
tenon document record "$TENON_CHANGE_NAME" tasks "$TASKS_PATH" --producer tenon-spec
```

若本轮是 `requirements-changed` 从 build 回退，或规格澄清实际改了 proposal/design 语义，还必须由
当前 phase driver 诚实重登记这两份修订文档；没有改动则不要制造无意义的新 record：

```bash
CHANGE_DIR="openspec/changes/$TENON_CHANGE_NAME"
tenon document record "$TENON_CHANGE_NAME" proposal "$CHANGE_DIR/proposal.md" --producer tenon-spec
tenon document record "$TENON_CHANGE_NAME" openspec-design "$CHANGE_DIR/design.md" --producer tenon-spec
```

### Step 4.5: 补全覆盖块 + 人确认

1. 在 design_doc 的 `coverage` 块补齐**形式层 L1/L2/L5/L6/L8**（每层 `filled -> 锚点` 或 `waived -> 理由`）。
2. 若改动触及 auth，在 `touches:` 写 `auth` → L6 安全层**不可 waive**（🔒，hotfix 也不豁免）。
3. **暂停，把 coverage 块整块念给用户确认**（骑在既有设计确认那一拍上，不另起签字仪式）。

design_doc 是 explore 生成的 Superpowers 设计文档；当 spec 更新其 coverage 块时，也必须以当前
`tenon-spec` evidence 重新绑定新 SHA。原始 brainstorming evidence 保留在 history，但不得再被
伪装成当前 digest 的 producer：

```bash
tenon document record "$TENON_CHANGE_NAME" superpower-design "$DESIGN_DOC" --producer tenon-spec
# 任一活文档重登记都会清掉旧 hash 的 read receipt；重新读取全部前序资料后再做出口校验。
tenon document read "$TENON_CHANGE_NAME" all
tenon document status "$TENON_CHANGE_NAME"
```

> ⏳ **待迁移（M1 #12 证据面）**：老仓在此 `set coverage_confirmed_by <user>` 留确认痕。
> lite 的 `.pipeline.yaml` 契约字段（CONTRACT §1）**无 `coverage_confirmed_by`**，`tenon set`
> 会拒写——确认动作照做（AskUserQuestion），留痕字段待证据面迁移后接回。

### Step 5: 验证（不自动推进）

```bash
tenon check "$TENON_CHANGE_NAME"     # spec 出口：0 过 / 2 不过
```

guard 通过条件（GUARD-RULES §3）：
- 非 PM Track：legacy `plan` 字段非空且文件存在；PM 不走该状态字段，但仍必须登记 `superpower-plan` 与 `plan` 文档证据
- `tasks.md` ≥ 3 个任务（防止只有 1-2 项的水任务）
- 全栈 Spec 覆盖块：适用层无 blank（填或 waive）、🔒 锁满足（hotfix/tweak 时 required 降级 WARN，锁仍硬拦）

guard **只校验、不自动 transition**。校验通过后：
1. 运行 `tenon review request "$TENON_CHANGE_NAME" --event spec-complete`，把 canonical exact-phase-and-event pending receipt 与 v2 marker
   落下；
2. 把 plan / 用户旅程 / delta spec 交用户过目、**逐项**收反馈（不能替用户拍板）；
3. 常规模式等待明确确认，由 hook 执行 `tenon review acknowledge "$TENON_CHANGE_NAME"`；已明确持续授权时，
   在真实产物与 guard 完成后执行 `tenon review acknowledge "$TENON_CHANGE_NAME" --delegated`；再推进：
   `tenon transition "$TENON_CHANGE_NAME" spec-complete`。

## 出口

- 事件：`spec-complete`
- 下一 phase：`build`（常规确认或已委托 review receipt 后进入）

## 打包 skill 依赖（随 tenon 插件安装）

- bundled-skill: brainstorming · 强制（pm）
- bundled-skill: writing-plans · 强制（所有 Track）
- bundled-skill: grill-with-docs · 强制（pm）
- bundled-skill: prototype · 条件（B3 原型摸底，用户拍板）
- bundled-skill: to-tickets · 可选
