---
name: tenon-explore
description: "Pipeline Phase 2: Explore · 调研 + 深度设计。PM Track 做竞品调研+定需求（01+02 步），frontend/backend Track 做技术调研+brainstorming。产出 design_doc。"
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

# /tenon-explore — Phase 2: 调研 + 深度设计

> **语言：** 沿用 Change 在 `.pipeline-document-locale.json` 固定的 locale，新 Change 默认中文。研究报告、
> Superpowers design 与 ADR 的读者标题和正文沿用固定 locale（默认中文，显式 `en` 时使用英文）；路径、producer、phase/event、coverage key
> 与命令保持稳定英文。缺失结构先用 `tenon document scaffold` 创建，不能把 scaffold 当成
> brainstorming/grill 或 document record 的证据。

> 移植来源：老仓 `skills/tenon-explore/SKILL.md`；脚本面已改写为 `pipeline` CLI。

> **Codex 打包 Skill 身份：** 本文件提到的裸 skill id 是 DAG/ledger 的逻辑 id；在 Codex
> 必须实际加载 `tenon:<id>` 的当前插件副本，绝不以同名全局或项目 SKILL.md 替代。

## 输入

- `$TENON_TRACK` ∈ {pm, frontend, backend, free}
- `$TENON_CHANGE_NAME`

**上下文恢复（强制）**：优先读取 `<pipeline-dispatch>` 的 `change/track/phase`，再跑
`tenon list --json` 和 `tenon status <change> --json` 复核。环境变量只是兼容快捷方式；为空时
不得退出到普通对话。若有多个候选且 dispatch 未指定，才请用户选择。

## 前置条件

- `.pipeline.yaml` 含 `phase=explore`（`tenon get <name> phase`）
- `openspec/changes/<name>/proposal.md` 已有内容

## 步骤

### Step 0: 入口定位（看现状，不是出口校验）

```bash
tenon status "$TENON_CHANGE_NAME"    # 相位/字段摘要，绝不 FAIL
```

> ⏳ **待迁移（M1 #12）**：老仓 `pipeline-guard.sh <name> explore --preview`（只列本阶段
> 待产出/待用 skill/待问决策，exit 0）未迁移——`tenon check` 是**出口校验**，在入口跑
> 必然全红，**别在入口跑**。入口用上面 `tenon status` 定位即可。
>
> **review 门提示**：进入 explore 不会落 review marker，因此可以完整完成调研、brainstorming、ADR
> 和文档登记。只有出口 guard 通过后才运行 `tenon review request --event explore-complete`；它才会锁住后续写操作，直到
> 用户明确确认并产生 canonical approval receipt。

### Step 1: 读已有上下文

列出以下文件，让后续交互式 skill **全文自读**（不要喂摘要——摘要会把调研纹理压平，发散就乏力）：
- `openspec/changes/$TENON_CHANGE_NAME/proposal.md` — 立项核心
- `openspec/changes/$TENON_CHANGE_NAME/design.md`（若存在）— 高层架构
- `openspec/specs/<capability>/spec.md`（若有主 spec）— 已有能力

受治理 workflow 还必须按生效 document contract 留下当前 step 所要求的 hash 读取收据；default
在 Explore 读取 Open 产物，其它 workflow 只读取其 `reads` 声明。先全文读取真实文件再执行命令。

```bash
tenon document read "$TENON_CHANGE_NAME" all
```

### Step 2: Track 分支调用

> ⚠️ **交互式 skill（brainstorming / grill-with-docs）的硬姿态 → 见 SessionStart 注入的
> `templates/workflow.md` 第三节「HITL 原则（交互硬姿态）」**（每次调用 brainstorming/grill
> 前过一遍，别走过场）。核心一句：**任何 gap 都用 AskUserQuestion 批量问、答完重扫、迭代到清零，别自行假设、别问 2 个就收。**
>
> explore 专属补充（只在 explore 适用）：
> - **外部调研走隔离 sub-agent（结构性还原不对称）**：deep-research / market-research / search-first 的"拉取"部分，优先用 **Agent 工具** dispatch `tenon-researcher` 子 agent（本仓 agents/tenon-researcher.md）——产出落盘、只回传路径+摘要+开放问题，主线**当外部输入读**。这样研究不是主线的"自有产物"，brainstorming 才不会背书自己刚写的结论。PM track 见下方 step 1 完整写法。

> **持续自主执行例外（优先于本节的重复交互要求）**：若当前 dispatch / hook 已表明用户对这个
> exact Change 授予持续执行权，`brainstorming`、`grill-with-docs` 仍必须实际加载、实际产出和实际
> 留证，但不应再次为低风险细节停住。已有用户指定的调研维度必须照用；未指定时选择与 topic 最贴近的
> 三个可审计维度（例如直接竞品、技术/开源生态、目标用户/需求）并在 research/requirements 与 ADR
> 中写明理由。把 grill 的追问转换为 Assumptions / Decision Log 的自检与保守结论。**此例外不适用**
> 于范围、安全、成本或外部发布；explore 出口仍严格走 `check → review request → 真实 review 证据 →
> 常规确认/acknowledge 或已委托 Change 的 acknowledge --delegated → transition`。

#### 📋 Track = pm（调研 + 定需求）

**对应 PM 6 步法中的 01 RESEARCH + 02 DEFINE。**

**立即执行**（按顺序）：

1. **调研走隔离 sub-agent（关键：治 brainstorm 变浅的根）——先问维度、再并行多路**：
   - **1a. 常规模式先用 AskUserQuestion（`multiSelect: true` 多选）问用户：本次从哪些维度调研。** 按 topic 给 4~N 个相关维度选项（如：直接竞品 / 间接竞品·替代方案 / 技术架构与实现 / 商业模式与定价 / 目标用户与需求 / 开源生态与社区 / 合规与安全…，按主题定、别写死），让用户多选。持续自主执行模式则按上面的窄例外处理：尊重已给维度，或选择三项保守默认并记入产物，**不得**把“没有再问一次”伪造成用户选择。
   - **1b. 为用户选定的每个维度，并行 dispatch 一个 `tenon-researcher` 子 agent**——**同一条 Agent 消息内并行 dispatch（一维度一个），不许一个子 agent 串行包揽所有维度**。每个 dispatch prompt 必含：该维度的调研焦点 + 产出路径 `docs/superpowers/specs/<DATE>-<topic>-<维度>-research.md` + `track=pm`。
   - 各子 agent 在隔离上下文里（可自行加载 deep-research / market-research 取方法论）拉真实源、写报告到盘，**各自只回传 路径 + ≤10 行摘要 + 3-5 个待用户决断的开放问题**。
   - 主线**不**把全文吸进来污染上下文，也**不**在主线直接加载 deep-research / market-research——下一步 brainstorming 才把各份报告当**外部输入**读。

2. 使用本插件打包的 Skill `brainstorming`（**必做，按上面「硬姿态」运行**）。
   - **先读** sub-agent 写的调研报告（当外部输入质疑，不是你的定论），带它回传的开放问题**逼用户在硬取舍上决断**（尤其目标用户，不许「双边 / 都要」收场）。
   - 产出：`docs/superpowers/specs/<DATE>-<topic>-requirements.md`

3. 使用 Skill 工具加载 `grill-with-docs`。**禁止跳过此步骤**（禁止 agent 自判「无不对称」就跳——PM 立项几乎必有内部事实不对称）。
   - 用于：拿用户的领域知识压测计划，一次一问、等用户答；真和用户做完多轮，不是 solo 写完给摘要

**推荐**（默认调用，按需取消）：
- 使用 Skill 工具加载 `search-first` — GitHub / 包注册表查竞品/现成方案

> ⛔ 调研阶段**不要**调用 `triage` / `to-tickets`：explore 只做竞品/需求调研与定需求，
> 拆 issue / 二次分类是后续 spec/build 的事，提前 triage 会把发散性调研打断。

#### 🎨 Track = frontend（技术调研 + 深度设计）

**立即执行**（按顺序）：

1. 使用 Skill 工具加载 `search-first`。**默认执行**——确无外部库/现成方案可搜时方可跳过（recommended，缺=WARN 不阻断）。
   - 用于：GitHub / Context7 / 包注册表查现成实现
   - 输出：候选库列表 + 优劣分析
   - **「读很多」的活走隔离 sub-agent（同 PM track）**：凡需查库 / 比较方案 / 读外部库文档全文等"拉取量大"的调研，优先用 **Agent 工具** dispatch `tenon-researcher` 子 agent（`track=frontend`）——产出落盘 `docs/superpowers/specs/<DATE>-<topic>-<维度>-research.md`，**只回传 路径 + ≤10 行摘要 + 3-5 个开放问题**。主线**不**把库文档全文吸进主上下文（保护主窗口的聪明区），下一步 brainstorming 把报告当**外部输入**读。多维度时同一条 Agent 消息内并行 dispatch（一维度一个）。

2. 使用 Skill 工具加载 `openspec-explore`。**禁止跳过此步骤**。
   - 用于：探索现有 `openspec/specs/` 已有能力
   - 防重复造轮子

3. 使用本插件打包的 Skill `brainstorming`。**禁止跳过此步骤**。
   - 用于：深度技术设计对话
   - 产出：`docs/superpowers/specs/<DATE>-<topic>-design.md`（技术 RFC）

4. 使用 Skill 工具加载 `grill-with-docs`。**禁止跳过此步骤**。
   - 用于：对照已有文档/ADR 找盲区

**推荐**：
- 使用 Skill 工具加载 `deep-research` — 复杂决策时多源调研

**可选**：
- 使用 Skill 工具加载 `find-skills` — 找可复用 skill
- 无需运行独立 OpenSpec CLI；读取本插件 `tenon init` 创建的 change 骨架和已有 main specs。

#### ⚙️ Track = backend

**立即执行**（按顺序）：

1. 使用 Skill 工具加载 `search-first`。**默认执行**——确无外部库/现成方案可搜时方可跳过（recommended，缺=WARN 不阻断）。
   - **「读很多」的活走隔离 sub-agent（同 PM track）**：凡需查库 / 比较方案 / 读外部库文档全文等"拉取量大"的调研，优先用 **Agent 工具** dispatch `tenon-researcher` 子 agent（`track=backend`）——产出落盘 `docs/superpowers/specs/<DATE>-<topic>-<维度>-research.md`，**只回传 路径 + ≤10 行摘要 + 3-5 个开放问题**。主线**不**把库文档全文吸进主上下文，下一步 brainstorming 把报告当**外部输入**读。多维度时同一条 Agent 消息内并行 dispatch（一维度一个）。
2. 使用 Skill 工具加载 `openspec-explore`。**禁止跳过此步骤**。
3. 使用本插件打包的 Skill `brainstorming`。**禁止跳过此步骤**。
4. 使用 Skill 工具加载 `grill-with-docs`。**禁止跳过此步骤**。
5. 使用 Skill 工具加载 `improve-codebase-architecture`。**禁止跳过此步骤**。
   - 用于：架构机会扫描、识别耦合/重复

**推荐**：
- 使用 Skill 工具加载 `deep-research`

**可选**：
- 使用 Skill 工具加载 `find-skills`
- OpenSpec 目录结构由本插件创建和维护，不需要外部 CLI。

#### 🕊️ Track = free（中性探索）

`free` 不猜测前端、后端或 PM 领域，也不继承它们的技能矩阵。它仍完整执行
default Workflow 的 Explore 治理：

1. 使用本插件打包的 Skill `brainstorming`。**禁止跳过此步骤**。
   - 全文读取 proposal、已有 main specs 和用户明确指定的目标。
   - 产出 `docs/superpowers/specs/<DATE>-<topic>-design.md`，明确范围、约束、
     可选方案、风险和 Decision Log。
2. 仅当目标本身需要外部事实时，使用 `search-first` / `deep-research`；不因
   `free` 而自动叠加领域调研。
3. 产出 ADR；没有架构变化时也记录“不引入新架构”的理由与后果。
4. 按 Step 3–4 登记 `design_doc`、回填 OpenSpec 活文档、登记
   Superpowers design/ADR、完成文档读取和 review 出口。

`coverageProfile=none` 表示不套 PM/前端/后端覆盖矩阵，不表示跳过设计、
OpenSpec、文档证据或 review phase。

### Step 3: 记录 design_doc 路径

产出文件后立即经 artifact contract 写入状态（路径相对项目根）。不要用 `tenon set` 绕过
当前 phase 的 producer 校验：

```bash
tenon artifact register "$TENON_CHANGE_NAME" design_doc \
  "docs/superpowers/specs/$(date +%Y-%m-%d)-<topic>-design.md" --producer brainstorming
```

### Step 3.25: 回填 OpenSpec 活文档并登记当前 digest（受治理 workflow 强制）

Open phase 只创建 proposal / initial design 骨架；Explore 的调研、brainstorming 与 grill 结论必须由
**当前 phase driver `tenon-explore`** 汇总回这两份 OpenSpec 活文档。不要把交互式 `brainstorming`
的产出者身份借给它们：它负责 Superpowers design / ADR，而本步骤负责被验证过的立项与初始设计。

若没有改变文件，不重复登记；一旦回填或修正了任一文件，必须在本 phase 以 `tenon-explore`
重新登记。新 digest 会刻意清掉旧 read receipt，因此随后必须重新读取全部上游文档，不能拿进入
Explore 时的旧读取冒充新内容已经被消费。

```bash
CHANGE_DIR="openspec/changes/$TENON_CHANGE_NAME"
# 先用 Edit/Write 将调研结论回填 proposal.md / design.md，再按实际变更逐个执行：
tenon document record "$TENON_CHANGE_NAME" proposal "$CHANGE_DIR/proposal.md" --producer tenon-explore
tenon document record "$TENON_CHANGE_NAME" openspec-design "$CHANGE_DIR/design.md" --producer tenon-explore
```

Explore 不得把尚未形成的实施计划提前写入 `tasks.md`；但本文件已经是七阶段 Todo 的唯一来源，
所以完成 Explore 自己的 checkbox 后必须由 `tenon-explore` 重登记当前 digest：

```bash
tenon document record "$TENON_CHANGE_NAME" tasks "$CHANGE_DIR/tasks.md" --producer tenon-explore
```

### Step 3.5: 登记 Superpowers 设计与 ADR（受治理 workflow 强制）

`brainstorming` 必须产出技术设计文档，且至少落一份 ADR：即使结论是“不引入新架构决策”，也要把该结论、
替代方案和后果写成 ADR，避免后续 spec/build 只能猜测。默认统一调用本插件打包的 bare
`brainstorming`；`--producer` 写实际调用的名字。

```bash
DESIGN_DOC="$(tenon get "$TENON_CHANGE_NAME" design_doc)"
ADR_PATH="docs/adr/$(date +%Y-%m-%d)-${TENON_CHANGE_NAME}-explore.md"
# 用 Edit/Write 写 ADR（背景 / 决策 / 备选方案 / 后果），再登记；不可登记空文件。
tenon document record "$TENON_CHANGE_NAME" superpower-design "$DESIGN_DOC" --producer brainstorming
tenon document record "$TENON_CHANGE_NAME" adr "$ADR_PATH" --producer brainstorming
# proposal / design / tasks 若在 Step 3.25 更新，先完成对应 record；此处重新消费所有当前 digest。
tenon document read "$TENON_CHANGE_NAME" all
tenon document status "$TENON_CHANGE_NAME"
```

### Step 3.75: 在 design_doc 写入全栈 Spec 覆盖块

design_doc **必须**包含一个 `coverage` 围栏块（spec 出口 guard 的 S5 覆盖 gate 会校验它，
见 packages/kernel/src/flow/GUARD-RULES.md §3）。本 phase 至少填齐**领域层 L3/L4/L10**，形式层留给 spec phase：

`````text
```coverage
touches:                              # 触及的受保护域（如 auth）驱动 🔒 锁；无则留空
L1_api:      blank                    # spec phase 填
L2_data:     blank                    # spec phase 填
L3_rules:    filled -> #关键业务规则    # ← explore 现在填（业务规则/不变量）
L4_state:    filled -> #状态机          # ← explore 现在填（状态机/生命周期）
L5_errors:   blank                    # spec phase 填
L6_security: blank                    # spec phase 填
L7_perf:     blank
L8_deps:     blank
L10_terms:   filled -> CONTEXT.md      # 领域术语沉到 CONTEXT.md
```
`````

每层填 `filled -> <design_doc 内 section 锚点 / 文件>` 或 `waived -> <理由>`；适用层留 blank 会被 spec 出口 gate 拦截（hotfix/tweak 降级 WARN，🔒 auth 锁任何 preset 都硬拦）。L9（编码/架构约束）是常驻层（CLAUDE.md/rules 自动注入），不入块。

### Step 4: 验证（不自动推进）

```bash
tenon check "$TENON_CHANGE_NAME"     # explore 出口：0 过 / 2 不过
```

guard 通过条件（GUARD-RULES §2）：
- `design_doc` 字段非空
- `design_doc` 指向的文件存在（路径相对项目根）

guard **只校验、不自动 transition**。校验通过后：
1. **常规模式下 brainstorming / grill 必须是真和用户做完的多轮对话**（按上面「硬姿态」），不是 solo 写完 design 给个摘要；持续自主执行模式可将低风险追问改为有理由的 Assumptions / Decision Log 与红队自检，但不得省略真实 skill、真实调研、ADR 或出口 review；
2. 运行 `tenon review request "$TENON_CHANGE_NAME" --event explore-complete`，把 exact-phase-and-event pending receipt 与 v2 hook
   投影写入；随后把 design_doc（含关键决策 / 调研结论 / 落的 ADR）交用户过目、**逐项**收反馈；
3. 常规模式等待用户确认，由 hook 运行 `tenon review acknowledge "$TENON_CHANGE_NAME"`；已明确持续授权时，
   在上列证据均真实完成后运行 `tenon review acknowledge "$TENON_CHANGE_NAME" --delegated`。确认 receipt 已写入后，
   推进：`tenon transition "$TENON_CHANGE_NAME" explore-complete`。

## 出口

- 事件：`explore-complete`
- 下一 phase：`spec`（常规模式确认后进入；已授权模式在委托 review receipt 后进入）

> 决策节点（HARD）：explore 是 review 相位（templates/manifest.yaml `review_phases` 单一真相源）——
> **出口**必须 `check → review request --event explore-complete → 展示产物 → 用户确认 / acknowledge → transition`。marker 不会
> 在入口阻断调研，但 canonical receipt 会拒绝任何未经确认的 explore-complete。
> 别为过 phase 草草收尾：终态是**用户在硬取舍上做了承诺**，不是"文档写出来了"。

## 打包 skill 依赖（随 tenon 插件安装）

- bundled-skill: brainstorming · 强制
- bundled-skill: grill-with-docs · 强制
- bundled-skill: improve-codebase-architecture · 强制（backend）
- bundled-skill: search-first · 推荐
- bundled-skill: deep-research · 推荐
- bundled-skill: market-research · 推荐（researcher 子 agent 内按需加载）
- bundled-skill: find-skills · 可选
