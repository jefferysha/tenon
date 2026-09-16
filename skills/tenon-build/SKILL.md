---
name: tenon-build
description: "Pipeline Phase 4: Build · 实现。PM Track 生成原型，frontend/backend Track 跑 TDD + 多 build_mode 并发模式。出口冻结可复验 build_sha 基线（build→verify barrier）。"
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

# /tenon-build — Phase 4: Build

> **语言：** Build 新增或更新的任务、原型说明、REVIEW.md 和实现记录沿用 Change 固定 locale，
> 默认使用中文，显式固定为 `en` 的 Change 使用英文；命令、路径、测试名、phase/event、kind/producer 和协议字段保持原样。

> 移植来源：老仓 `skills/tenon-build/SKILL.md`；脚本面已改写为 `pipeline` CLI。
> build→verify barrier（冻结 build_sha）语义见 `docs/CONTRACT.md` §3 与
> packages/cli/src/commands/transition.ts 的 build-complete 副作用。

> **Codex 打包 Skill 身份：** 本文件提到的裸 skill id 是 DAG/ledger 的逻辑 id；在 Codex
> 必须实际加载 `tenon:<id>` 的当前插件副本，绝不以同名全局或项目 SKILL.md 替代。

## 输入

- `$TENON_TRACK` / `$TENON_CHANGE_NAME`

**上下文恢复（强制）**：优先读取 `<pipeline-dispatch>` 的 `change/track/phase`，再跑
`tenon list --json` 和 `tenon status <change> --json` 复核。环境变量只是兼容快捷方式；为空时
不得退出到普通对话。若有多个候选且 dispatch 未指定，才请用户选择。

## 前置条件

- `phase=build`
- `plan` 字段非空且文件存在
- `tasks.md` 至少有任务

## 步骤

### Step 0: 入口定位 + 决策节点（暂停等用户）

```bash
tenon status "$TENON_CHANGE_NAME"
```

> ⏳ **待迁移（M1 #12）**：老仓 guard `--preview`（只列本阶段待办/决策点，exit 0）未迁移。
> 出口校验在 build 末尾用 `tenon check` 跑，别在入口跑。

#### 🚀 并发执行模式（Subagent / 多 Builder）

**强烈建议**：根据任务复杂度选择合适的并发模式。

| Scale | 推荐 build_mode | 并发策略 |
|-------|---------------|---------|
| SIMPLE (≤3 任务) | `direct` | 主 agent 直接做 |
| STANDARD (3-10 任务) | `subagent-driven-development` | 主 agent 编排 + 拆给独立 sub-agent 并发实现（文件所有权隔离） |
| COMPLEX (>10 任务 / 多模块) | `parallel-team` | 多 `tenon-builder` 并行，每 Builder 独立模块 |

**HARD RULE**：
- 选 `subagent-driven-development` 时，**立即执行**：使用本插件打包的 Skill `subagent-driven-development`
- 选 `parallel-team` 时，使用本插件打包的 Skill `dispatching-parallel-agents`
- 多个独立任务**必须在同一条 Agent 消息**并行 dispatch，不允许串行

### Step 0.5: 按 Track 注入 stack 规范

> ⏳ **待迁移（M1 #18 manifest 全派生面 / M2 #20）**：老仓在此按 Track `cat` dotfiles 的
> `rules/pipeline/L0/L4-*.md`（React/Vue/Go/Python/Rust/Java/TS-backend 各 stack 硬约束）。
> 该 rules 资产尚未迁入本仓——当前替代：项目自身的 CLAUDE.md / lint 配置 / 既有测试约定
> 就是 stack 规范真相源，build 前先 Read 它们；对应 stack 的外部 patterns skill
> （react-patterns / python-patterns 等，见下方 Track 分支）承担同类约束注入。

**决策 build_mode 和 isolation**：默认先检查已记录的用户意图。普通交互且没有明确持续授权时，
必须暂停让用户选择；用户明确授权“后续无需询问 / 自主执行完成”时，按下面的保守策略自动落盘，
并在 Change 的 Build 记录中说明选择理由。

**build_mode** 选项（枚举与 CLI 校验一致：direct | subagent-driven-development | parallel-team | prototype）：
- `subagent-driven-development`（默认推荐：拆 sub-agent 并行实现 —— 每个 task dispatch 一个 `tenon-builder` agent，同消息并行）
- `parallel-team`（COMPLEX 时：多 `tenon-builder` 并行 + 各自 worktree 隔离，互不污染）
- `direct`（PM Track 固定 `prototype`；frontend/backend 仅 hotfix/tweak 默认，full 需 `direct_override: true`）

**isolation** 选项：
- `branch`（**宿主已**切到专用 feature branch 时使用；agent 不得自行创建/切换 branch）
- `worktree`（**宿主已**提供独立 worktree 时使用；agent 不得自行 `git worktree add`）
- `in-place`（受限 Codex sandbox、unborn repository，或只有重叠文件的串行实现时使用；如实表示
  只在当前工作目录写入，并非 branch/worktree 的别名）

**自主执行的保守默认**：SIMPLE 或任务文件重叠时选 `direct + in-place`；独立文件且宿主已提供
隔离环境时才选对应 `subagent-driven-development/parallel-team + branch/worktree`。`full + direct`
仍必须记录 `direct_override=true`，它是明确的风险确认而不是隐式绕过。

**Git 权限边界**：Codex 常规 workspace sandbox 可以写项目文件，但可能拒绝 `.git/HEAD.lock`。
因此 agent 不得把 `git checkout -b`、`git worktree add`、`git commit` 当作 Build 前置条件，也不得把
失败的 Git 命令伪装成已隔离或已提交。由宿主预先提供 branch/worktree 时可消费它；否则使用
`in-place`，运行 `git diff --check` 与项目验证，把未能执行的 VCS 发布动作如实记为宿主后续动作。

写入决策：

```bash
tenon set "$TENON_CHANGE_NAME" build_mode <选择>
tenon set "$TENON_CHANGE_NAME" isolation <选择>
# full preset 选 direct 时必须显式豁免（否则 build 出口 guard B5 拦）：
# tenon set "$TENON_CHANGE_NAME" direct_override true
```

### Step 1: 读取上下文

```bash
PLAN=$(tenon get "$TENON_CHANGE_NAME" plan)
DESIGN_DOC=$(tenon get "$TENON_CHANGE_NAME" design_doc)
# 必读 plan + design_doc。design_doc 是业务规则/不变量/状态机（layer 3/4）的家，
# build Agent 必须读到它——只凭 plan 写代码会在第 3-10 层靠猜。
[ -f "$PLAN" ]       && { echo "=== PLAN ==="; cat "$PLAN"; }
[ -f "$DESIGN_DOC" ] && { echo "=== DESIGN_DOC（业务规则/状态机/不变量）==="; cat "$DESIGN_DOC"; }

# 受治理 workflow：对截至 spec 的全部文档生成本 phase 的 hash-bound read receipt。
tenon document read "$TENON_CHANGE_NAME" all

# 支持 Context Bundle v1 的 runtime 可额外编译本 phase 的确定性上下文包。
# 它从 ledger 派生，不替代 canonical 文档；任一源文件 digest 漂移都会失败并要求先重登记。
tenon handoff "$TENON_CHANGE_NAME" --bundle --target build --json
```

### Step 2: Track 分支调用

#### 📋 Track = pm（生成原型 / 04 PROTOTYPE）

**Step 0：设计方向决策（HARD RULE，禁止跳过、禁止自行默认）**

动手画任何原型**之前**，先用 **AskUserQuestion** 问用户三件事（**都别写死、别自行默认**"通用深色卡片网格"这种模板货）：

1. **原型引擎 / 设计驱动（同级三选一，默认推荐 `huashu-design`；`huashu-design` 与 `hallmark` 均为推荐项）**：
   - **`huashu-design`（推荐·默认）**：花叔 Design（HTML 设计师），20 种设计哲学 / 设计变体探索 / 专家评审，适合"更有设计感、跨流派"的视觉探索。
   - **`hallmark`（推荐）**：反 AI-slop 设计层 —— 22 套主题 / 设计审计 / 从 URL·截图提取设计语言，产出"拒绝 AI 生成味"的设计。
   - **`prototype`（备选）**：UI 变体机制（单路由 `?variant=` 切换 + 底部浮动栏），适合可点击的流程演示。
   - 三者都是交互式 skill：加载后会**停下跟 skill 交互**（守 HITL 原则，见 templates/workflow.md 三节）——别加载完就闷头生成。**禁止自行默认、禁止跳过这道三选一。**
2. **变体个数 N（用户定，禁止写死 4）**：问用户要几个变体（可建议合理默认如 3-4，但以用户答为准）。
3. **设计来源（决定 N 个变体怎么分配）**：
   - **hue 设计语言**：用 `hue` 据目标页/参考调性生成专属设计语言（落成设计语言 skill 或 `DESIGN.md`）。走 hue 就**不另写 design.md**，在该语言下出 N 个变体（结构/排版/层次各异、同一视觉语言）。
   - **design.md**：来自用户自有 `DESIGN.md`、Tenon 设计规范或本 Change 手写设计稿——严格按已登记版本实现。
   - **自由发挥**：不绑 design.md，由引擎给出结构/风格截然不同的方案。
   - **可混搭**：如 N=4 → 2 个基于 design.md + 2 个自由；huashu 路径可"跨 N 个不同流派各一个"。

> **本流程的原型是「交付级高保真」，不是 throwaway sketch。** 成品必须**高保真、覆盖关键屏与主要状态**——`prototype` skill 默认的"skip polish / 一次性"在本 PM build 流程**不适用，以本处为准**；`huashu-design` 同样要交付级（其 Junior 模式"先 show 假设再做"可走，但终态是 hi-fi）。N 个变体的浏览方式按引擎定（prototype=单路由 `?variant=` + 浮动栏；huashu=并排画廊 / 各自 HTML）。
> 反模板红线（必须满足，违反即返工；若装有 `~/.claude/rules/web/design-quality.md` 以其为准）：不准默认暗色模式、不准等距无层次的卡片网格、不准单一点缀色充当全部设计、不准 library 默认值直接交付。原型要有层次、节奏、depth、明确的排版策略。

**强制 Skill**（hard；全部服从 Step 0 选定的设计方向）：

1. 按 Step 0 三选一选定的加载 **`huashu-design` / `hallmark` / `prototype`**（**禁止跳过**；默认推荐 `huashu-design`；三者都是交互式 skill，加载后停下跟 skill 交互，别闷头生成）。
   - 生成 **N 个高保真变体**（N = Step 0 用户选定，**别写死 4**；按 Step 0 设计来源分配：hue=同语言 N 个；design.md/自由/混搭按用户选）。
   - 浏览机制按引擎：`prototype`=单路由 `?variant=` 切换 + 底部浮动栏；`huashu-design`=并排画廊（design_canvas）或各变体独立 HTML。
   - 产出：`openspec/changes/<name>/prototype/`（huashu 变体可放 `prototype/variants/`）。
   - **每个变体都覆盖深度旅程的关键屏 + 主要状态(空/加载/错误/成功)，不是只画 happy path 首页。**

2. **🛑 交付原型地址 + 停下等用户审查整体风格（HARD GATE，禁止跳过、禁止生成完直接进评估）**：
   - 把 N 个变体跑起来（本地静态服务或文件地址），**用 AskUserQuestion 把原型访问地址 + 各变体入口（prototype=`?variant=` / huashu=画廊或各 HTML）交给用户**，停下来等他审查。
   - 让用户确认**整体风格方向**并**选定一个最满意的变体作为 winner**（选定一个 / 各取所长则合并成一个 winner / 方向不对推倒重来）。
   - **只有用户确认风格方向 + 选定 winner 后**，才进入下一步精修评估；方向要改就回 step 1 重出——**别带着错方向去 frontend-design/taste 精修空耗**。
   - **后续只精修这个 winner，不再 review 其余 N-1 个变体**——选一个最满意的深做，别把 token 摊在全部变体上。

3. **winner 实现精修与一次自检（HARD：不是正式 Review）**——只针对 Step 2 选定的 winner：
   - 使用 `frontend-design` + `design-taste-frontend` 作为实现指导，逐项检查设计 token、层次、排版、
     组件态、反模板红线与可访问性，并在本次 Build 内修正已发现的问题。
   - 这一步不得派发 reviewer agent，不产生 severity verdict 或 `REVIEW.md`，也不创建或消耗
     Review attempt；它只是实现反馈。正式视觉、浏览器与规范复核统一在 Verify 中，作为同一 frozen
     candidate、同一个有限 Review attempt 的 lanes 执行。
   - 自检只执行一次；若实现仍未达到已批准的 acceptance criteria，则继续完成对应 task 和测试，
     不启动“评 → 修 → 复评”自动循环。

**条件性 Skill**（按 Step 0 选定的 DESIGN.md / 技术选型决定，用得上才加载）：
- 使用 Skill 工具加载 `shadcn` — **仅当**选 shadcn 风格的组件库

**推荐**（默认调用）：
- 使用 Skill 工具加载 `hue` — 配色 / 视觉风格生成（Step 0 设计来源选 hue 设计语言时为必走）
- `hallmark` — **已并入 Step 0 原型引擎三选一（与 huashu-design 同为推荐项）**，此处不再重复软推荐，按 Step 0 三选一走。

**可选**：
- 使用 Skill 工具加载 `web-artifacts-builder` — 复杂多组件原型

**PM 不需要 builder Agent。** build_mode 自动设为 `prototype`（`tenon set <name> build_mode prototype`）。

#### 🎨 Track = frontend

**强制 Skill**（hard）：

1. 使用本插件打包的 Skill `test-driven-development`。**禁止跳过此步骤**。
   - **完整红-绿-重构（顺序不可省）**：
     - **红**：先写测试，**然后立即运行它、确认它按预期失败**——这步是 TDD 的命门，跳过它就可能写出"永远通过的假测试"（测了个寂寞），后面的绿毫无意义。
     - **绿**：写**最小**实现让测试通过。
     - **重构**：测试保持绿的前提下重构代码。

2. 使用 Skill 工具加载 `frontend-design`。**禁止跳过此步骤**。

3. 使用 Skill 工具加载 `web-design-guidelines`。**禁止跳过此步骤**。

4. **含 UI 改动时：frontend-design + `design-taste-frontend` 一次实现自检（HARD：不是正式 Review）**：
   - 对新增/改动组件逐项核对设计 token、层次、排版、组件态、反模板红线与可访问性，并在 Build
     内修正已发现的问题。
   - 这里只执行一次实现自检，不派发 reviewer、不产生放行 verdict、不写 Review 报告，也不消耗
     Review attempt。正式 frontend/visual/browser 复核统一由 Verify 的同一个有限 attempt 聚合。
   - 遵循项目既有设计系统（design token / 既有组件风格 / 既有动效库），不套 baseline 重构既有页面。

**条件性 Skill**（按框架/选型决定，用得上才加载——Vue 项目不该被 React skill 卡）：
- 使用 Skill 工具加载 `react-patterns` — **仅当** React 项目
- 使用 Skill 工具加载 `vercel-react-best-practices` — **仅当** React（Vercel 性能最佳实践）
- 使用 Skill 工具加载 `shadcn` — **仅当** 用 shadcn 组件库

**推荐**：
- 使用 Skill 工具加载 `writing-plans` — 复用上一步 plan
- 使用 Skill 工具加载 `hallmark` — 反 AI-slop 设计层，做有视觉品质的 UI 时叠加（与 frontend-design / web-design-guidelines 同向）

**可选**：
- 使用 Skill 工具加载 `frontend-patterns`

**Agent**：
- build_mode = subagent-driven / parallel-team 时：**每个 task/组件 dispatch 一个 `tenon-builder` agent**（本仓 agents/tenon-builder.md，隔离 worktree，同消息并行实现），只回传 diff 摘要+测试结果；主线汇总、不内联逐个实现。
- TDD 监督由本插件 `test-driven-development` 的红绿重构纪律承担；不要把未打包 agent 当作默认前置。

#### ⚙️ Track = backend

**强制 Skill**（禁止跳过）：

1. 使用本插件打包的 Skill `writing-plans`。**禁止跳过此步骤**。
2. 使用本插件打包的 Skill `test-driven-development`。**禁止跳过此步骤**。
   - **完整红-绿-重构（顺序不可省）**：
     - **红**：先写测试，**然后立即运行它、确认它按预期失败**——这步是 TDD 的命门，跳过它就可能写出"永远通过的假测试"，后面的绿毫无意义。
     - **绿**：写**最小**实现让测试通过。
     - **重构**：测试保持绿的前提下重构代码。

**推荐 Skill**（按项目 stack 启用）：
- 使用 Skill 工具加载 `nestjs-patterns` — 若项目用 NestJS
- 使用 Skill 工具加载 `postgres-patterns` — 若涉及 Postgres
- 使用 Skill 工具加载 `python-patterns` — 若 Python 项目
- 使用 Skill 工具加载 `python-testing` — 若 Python 项目
- 使用 Skill 工具加载 `docker-patterns` — 若项目用 Docker

**可选**：
- 使用 Skill 工具加载 `deployment-patterns`

**Agent**：
- build_mode = subagent-driven / parallel-team 时：**每个 task/端点/服务 dispatch 一个 `tenon-builder` agent**（隔离 worktree，同消息并行实现），只回传 diff 摘要+测试结果；主线汇总、不内联逐个实现。
- 构建失败时保留同一任务的测试输出和最小复现，按 `test-driven-development` 与对应打包 pattern skill 修复；不依赖未打包 agent。

#### 🕊️ Track = free（中性实现）

**强制 Skill**（禁止跳过）：

1. 使用本插件打包的 Skill `writing-plans`，全文恢复已批准的中性 plan。
2. 使用本插件打包的 Skill `test-driven-development`，对每个行为变更完整执行
   红→绿→重构。

只根据 Change 自己的 plan、OpenSpec delta 和仓库规则选择实现手段；不得因为
`free` 猜测或注入 PM、前端、后端 pattern skill。若任务本身明确涉及某项技术，
可以按 plan 加载对应条件 skill，但这属于 Workflow 任务需要，不是 Track 覆盖。

`build_mode`、`isolation`、full/direct override、逐任务测试、tasks 勾选、文档重读
和 `build-complete` 冻结基线全部照常执行。

### Step 3: 按子阶段执行 + 紧反馈循环 + 增量勾选/提交（frontend/backend/free；PM Track 走上方原型流程，不适用）

#### Step 3.0: 按 plan 标注的「子阶段」逐个执行

plan 已把 build 切成若干**子阶段（每个 ≈ 一个干净上下文窗口）**——**逐个执行，不要一口气把所有子阶段塞进同一会话**：

1. 取 plan 里**下一个未完成子阶段**，只做该子阶段内的 task。
2. 子阶段内每个 task 走 Step 3.1 的紧反馈循环；完成后走 Step 3.2 勾选+提交。
3. **一个子阶段完成、且当前上下文接近 ~40%（聪明区上限 ~8万-10万 token）时**：**提示用户 `/clear`**，靠 `.pipeline.yaml` + SessionStart 三注入在干净会话重建上下文后再做下一子阶段——**别让整条 build 漂进"愚钝区"**（幻觉 / 丢信息 / 推理退化）。重建后无需重读对话历史，状态全在 `.pipeline.yaml`（`tenon status <name>` 一把捞回）。

#### Step 3.1: 每个 task 的紧反馈循环（必做）

每完成一个 task 的实现，**立即在 build 内自跑机器可验证的检查、读输出、失败当场自纠，绿了才算该 task 完成**：

1. 跑**类型检查 + 测试 + lint**（用项目对应命令，如 `tsc --noEmit` / `pytest` / `eslint` / `go vet` 等）。
2. **读输出**：有失败就**当场自纠**（改实现，必要时回看 design_doc / stack 规范），重跑直到三者全绿。
3. 三者全绿，该 task 才算完成，方可进入 Step 3.2。

> **离开 build 前 `tenon test status` 必须通过**：本步骤声明的必需测试只认 `tenon test run` 的记录；
> 上面的自跑循环是快速反馈，不产生证据。

> **分工（不许整体甩给 verify）**：build 内做的是**机器可验证的紧反馈自纠**（type/test/lint 当场修绿）；P5 verify 是**独立、对抗式的二次把关**（reviewer / codex / e2e）。把验证整体推后到 verify＝bug 留到那时才现、返工更贵——build 自己必须先收敛到绿。

#### Step 3.2: 增量勾选 + 提交

每完成一个 task（已过 Step 3.1 全绿）：
1. **宿主 VCS 可写时**：首个 commit 前，若目标项目尚无 pre-commit，建议为其配置 pre-commit（`husky` + `lint-staged`，或对应 stack 等价物如 Python 的 `pre-commit` 框架、Go 的 `pre-commit` 钩子等）**自动修格式**，避免脏格式噪音淹没后续 review。受限 agent 不能写 `.git` 时，不得因此阻塞 Build 或声称已提交。
2. 更新 `openspec/changes/<name>/tasks.md` 把 `- [ ]` 改为 `- [x]`，然后立即由本 phase 已实际调用的
   `tenon-build` 重新登记该活文档并重建本 phase 的读取收据；不得用 `--backfill` 沿用 open/spec
   的 producer，否则当前 SHA 与证据会失真：

   ```bash
   TASKS_PATH="openspec/changes/$TENON_CHANGE_NAME/tasks.md"
   tenon document record "$TENON_CHANGE_NAME" tasks "$TASKS_PATH" --producer tenon-build
   tenon document read "$TENON_CHANGE_NAME" tasks
   ```

3. 宿主 VCS 可写且项目已有可提交 HEAD 时，可执行 `git commit -m "<task description>"`（message 体现设计意图）；否则保留真实 diff、完成 task/ledger 记录并继续验证。

### Step 3.5: pre-Verify Build readiness（HARD RULE）

Build 这里只完成实现紧反馈与冻结准备，**不得**派发 code/spec/security reviewer、E2E/browser/visual
acceptance，也不得创建 Review attempt；这些对抗式活动统一在 Verify 对同一 frozen candidate 聚合为
一次有限 Review。这样问题发现标准在 Spec 固定、实现期间靠 TDD 快速收敛，避免 Build 与 Verify
重复全量 Review。

1. 枚举全部 changed / untracked implementation、configuration、migration、generated artifact 与
   release asset，建立“文件 → capability / requirement”覆盖表，确认没有漏做 plan task。
2. 跑完适用的 build、type、unit/integration test、lint、静态检查、迁移兼容与 release gate；失败在
   Build 当场修复并重跑。这里的检查是实现反馈，不产生放行 verdict，也不消耗 Review 次数。
3. 对 `in-place`，所有会重建 tracked 产物的命令（例如 build、bundle、codegen、release asset
   生成）必须在这里完成并稳定落盘；确认没有仍在运行的 writer 后才冻结。
4. readiness 门通过后，写入兼容字段（字段历史名保留；其语义仅为 Build readiness，不是 Review）：

   ```bash
   tenon set "$TENON_CHANGE_NAME" pre_verify_review_result pass
   ```

5. `pass` 后若任何 implementation、configuration、migration、generated artifact 或 release asset
   再变化，必须立即重置为 `pending` 并从第 1 项重跑。
6. 把 Verify 所需的 repo-zero-output 约束一并交接：冻结后不得在真实工作区重跑会写 tracked
   产物的命令；这些命令若需二次对抗验证，只能在保留权限/软链的隔离副本运行。浏览器截图、
   snapshot、trace 与日志必须写入仓库外的临时目录。
7. Review attempt 只能在进入 Verify、取得冻结 `build_sha` 后 begin；不得在 Build 预占或拆成多次。

### Step 4: 验证（不自动推进）

```bash
tenon document status "$TENON_CHANGE_NAME"
tenon check "$TENON_CHANGE_NAME"     # build 出口：0 过 / 2 不过
```

guard 通过条件（GUARD-RULES §4）：
- `tasks.md` 所有 `- [ ]` 已变为 `- [x]`
- `build_mode` 已设
- `isolation` 已设
- `pre_verify_review_result=pass`（兼容字段；表示 Build readiness，不表示自动 Review 已通过）
- full preset 且 `build_mode=direct` 时必须 `direct_override=true`
- `depends_on` 声明的依赖 change 均已归档（活跃依赖 → FAIL）

guard **只校验、不自动 transition**。校验通过后按当前 workflow 的真实 step gate 推进：
- `gate: null`：直接 `tenon transition "$TENON_CHANGE_NAME" build-complete`；不得凭 default 流程虚构 review request。
- `gate: review`：先 `tenon review request`，常规模式等待确认；已明确持续授权的 exact Change 在真实证据
  完成后用 `tenon review acknowledge "$TENON_CHANGE_NAME" --delegated`，再 transition。
- `gate: confirm`：保留人为确认，不自动跨越。
（build→verify 是 barrier：build 全 task 自测绿后 `build-complete` 由可信 capture capability
写入 canonical `build_sha` token：`build:v1:<git|workspace>:<revision_hash>:<repository_hash>:<worktree_hash>`。
token 只携带 domain-separated hash，不携带 raw path、prompt、credential 或裸 SHA；能力缺失、身份/来源
不可信、异常或格式非法均 fail-closed，必须重新 build/capture，**禁止 backfill 或把旧裸 SHA/workspace
baseline 补写成 token**，之后才进 verify，见下方 HARD RULE；
真正"停下等用户复核"在 verify 跑完、进 ship 前的 verify-pass。）

若 build 期间发现需求或设计语义已经变化，不能在本 phase 直接重登记 proposal/design 来掩盖
stale evidence。先运行：

```bash
tenon transition "$TENON_CHANGE_NAME" requirements-changed
```

回到 spec 后调用 `tenon-spec`，由它重登记修订后的 proposal/design/tasks，补齐 read receipts 并
重新通过 spec review；之后才可再次进入 build。纯实现修复、未改变已批准需求/设计时无需回退。

## 出口

- 事件：`build-complete`（CLI 副作用自动冻结 `build_sha`，见下）
- 下一 phase：`verify`（barrier 之后；不自动 chaining）

## Build→Verify barrier（HARD RULE）

并发是 **build 内部**（多 builder / 多 task 同消息并行），**不是 build⇄verify 跨阶段**。

交接顺序（不可颠倒）：
1. build 全 task 完成、每个 task 自测绿（类型 + 测试 + lint）。
2. 完成 Step 3.5 的 Build readiness 与全部适用机器门禁，写入兼容字段
   `pre_verify_review_result=pass`；之后的交付面变更会令它失效并要求重跑。
3. 若当前已由宿主提供 branch/worktree，确保该隔离目标的 Git HEAD 就是待验收版本；**不得**为满足流程自行建分支或伪造 commit。`in-place` 则保留真实未提交工作区，不要求 commit。
4. `tenon transition <name> build-complete` —— CLI 通过可信 capture 冻结 `build_sha` token（见上方 grammar），并绑定当前 Git repository/worktree identity 或 workspace content identity；任何 capture rejection 都保持 canonical state 不变。
5. **之后**才进 verify；verify 必须读取这个冻结 token，并在 Verify 前重新评估当前 HEAD/workspace、identity、provenance 与 state digest。审查期间发生漂移会以 stable `verify-build-revision-untrusted` blocker 拒绝。

不要在 build 还没自测绿 / 还没冻结基线时就发起 verify——评审移动靶在因果上不成立。
（verify-fail 回退时 CLI 自动置 `verify_result=fail`、清空 `build_sha` 并把
`pre_verify_review_result` 重置为 `pending`——返工后重新走 1→5。）

## 打包 skill 依赖（随 tenon 插件安装）

- bundled-skill: test-driven-development · 强制（frontend/backend）
- bundled-skill: writing-plans · 强制（backend）/ 推荐（frontend）
- bundled-skill: code-review · 仅 Verify 的 standards lane 使用，不在 Build 重复派发
- bundled-skill: subagent-driven-development · 条件（build_mode）
- bundled-skill: dispatching-parallel-agents · 条件（build_mode）
- bundled-skill: frontend-design / web-design-guidelines / design-taste-frontend · UI 评修
- bundled-skill: huashu-design / hallmark / prototype / hue · PM 原型与视觉方向
- bundled-skill: shadcn / web-artifacts-builder · 条件或可选
- bundled-skill: react-patterns / vercel-react-best-practices / frontend-patterns · 前端条件或可选
- bundled-skill: nestjs-patterns / postgres-patterns / python-patterns / python-testing · 后端条件
- bundled-skill: docker-patterns / deployment-patterns · 条件或可选
