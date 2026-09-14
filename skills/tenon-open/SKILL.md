---
name: tenon-open
description: "Pipeline Phase 1: Open · 开启 Change。创建 proposal/design/tasks，用 tenon init 初始化 canonical state。default 的 pm/frontend/backend/free 都生成 OpenSpec design.md。"
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

# /tenon-open — Phase 1: 开启 Change

> 移植来源：老仓 `skills/tenon-open/SKILL.md`；`pipeline-state.sh init/set/get/transition`
> 与 `pipeline-guard.sh` 已改写为本仓 `pipeline` CLI（CONTRACT §3）。

> **Codex 打包 Skill 身份：** 本文件提到的裸 skill id 是 DAG/ledger 的逻辑 id；在 Codex
> 必须实际加载 `tenon:<id>` 的当前插件副本，绝不以同名全局或项目 SKILL.md 替代。

## 输入

从 /pipeline 主入口接收：
- `<pipeline-dispatch>` 的 `track` 与（新建时）由入口根据用户需求生成的 `change` 短名（kebab-case）
- 精确 `workflow`；未指定才是 `default`。`free` 可绑定任意已存在且 allowed 的 Workflow。
- 兼容快捷方式：`$TENON_TRACK`、`$TENON_CHANGE_NAME`

**上下文恢复（强制）**：Skill 工具调用不保证继承此前 Bash 的 export。环境变量为空时，读取本轮
`<pipeline-dispatch>` / `<workflow-state>`，运行 `tenon list --json` 复核；只有仍无法从用户需求
生成安全的 kebab-case name 时才询问用户。不得因变量为空直接降级成普通对话。

## 前置条件

- 无活跃 change 或用户明确创建新 change
- 无需预先安装或运行独立 OpenSpec CLI；本插件的 `tenon init` 会创建 default change 所需的
  `openspec/changes/<name>/`、文档骨架与 canonical state。

> **归档软提醒（前置）**：若主入口（`pipeline`）已检测到未归档活跃 change、弹过归档提醒并经用户确认「并行新建」，则直接继续。若**本 skill 被直接调用**（未经主入口），先按主入口同规则——`tenon list` 列活跃 change，非空则**用 AskUserQuestion** 列出（名 + phase + 陈旧度）软提醒 `[归档某个再建 / 并行新建 / 取消]`——再创建。**不硬拦**并行新建。

## 步骤

### Step 0: 入口验证

```bash
# 先以 dispatch 上下文/CLI 复核出的逻辑 track 与 change name 为准；环境变量仅作兼容别名。
tenon list --json

```

### Step 1: 创建 change 骨架（强制 Skill）

> **open 的目的 = 初始化 + 骨架，仅此而已。** 建 change 骨架（proposal/tasks，fe·be 加 design）+ init `.pipeline.yaml`，把"要做什么"立住即可。
> 实质内容（能力清单 / 竞品 / 定位 / 架构 / 详细 spec）**一律不在 open 写**——那是 explore 的 research→brainstorming→grill 之后才成形的东西（见下方"proposal 只写骨架"）。

按 Track 分支调用。

#### 🌐 需求归类：triage（条件，**非强制**）

triage 是面向 **issue tracker 的状态机**——只在「对**既有项目**的 bug / feature / refactor 立项、需并入既有 issue 流」时才加载它归类。

**greenfield 全新立项 / PM market-validation（无 issue tracker）→ 跳过 triage**，改在 proposal 里一句话内联归类（feature / bug / refactor / debt / market-validation）即可。**不要硬套 triage 状态机，也不要因为它"不适用"就停流程。**

#### 🌐 所有 Track 共用：内置 OpenSpec 结构（无需额外安装）

`tenon init` 负责创建 change 内的 proposal/design/tasks 初始骨架；spec phase 首次创建 capability 时
再建立 `openspec/specs/<capability>/spec.md`。不要调用或要求用户全局安装另一个 `openspec` 可执行文件。

#### 🌐 所有 Track 共用：openspec-propose（强制）

**严格顺序**：先完成 Step 2 的 `tenon init` 和 Step 2.1 的 `tenon session activate`，**再**
使用 Skill 工具加载 `openspec-propose`。**禁止跳过此步骤**，也不得在绑定目标前读取该 phase Skill；
这样每条 Codex/Claude 完成态证据都会归属当前 change，而不会借用旧 change。

按 Track 提示生成不同的产物模板：

| Track | proposal.md 重点 | design.md 重点 | tasks.md 重点 |
|-------|-----------------|---------------|--------------|
| pm | 目标/受众/动机 | 初始产品/交互假设（explore 会补足证据与决策） | PM 推进任务 |
| frontend | 用户痛点/UI 范围 | 组件结构/状态管理 | TDD 任务清单 |
| backend | 业务问题/API 范围 | 数据模型/架构决策 | 实现任务清单 |
| free | 目标/边界，不预设领域角色 | 所选 Workflow 所需的中性设计假设 | 按 Workflow step/phase 组织 |

> **proposal 只写骨架，别写满。** open 的 proposal = 目标/受众/动机 + 一句话意图 +（可选）一句话需求归类。
> **禁止前置实质**：能力清单 / 竞品对标 / 定位 / 差异点 / 详细范围——这些留给 explore 的 research→brainstorming→grill 之后回填。
> 任何工作假设标成「**待 explore 验证**」，别写满了再求用户盖章（HITL 原则③，见 SessionStart 注入的 templates/workflow.md）。
> proposal 是**活文档**：open 立骨架、explore 充实——openspec 的 `proposal→design→specs→tasks` 是**文档依赖**、不是写作时序，proposal 节点先存在即可。

若 `openspec-propose` 不可用：只可手动补齐骨架以保留需求，**不得**把 open 视为完成；document ledger 会因
缺少真实完成态 Skill evidence 拒绝登记/transition。修复 skill 可用性后必须重新实际调用它。

### Step 1.5: 选 preset 规模（强制 AskUserQuestion，决定 guard 强度）

> preset 决定本 change 的 guard 强度，是**用户决策点**，**禁止 agent 替用户默认拍板**。
> **默认严**：用户拿不准 / 未明确选 → 落 `full`（最重护栏）。小任务想减摩擦必须**显式**降档，而不是默认就松。

用 **AskUserQuestion** 问用户三选一（推荐项 `full` 放**第一项**、标「(推荐)」+ 真实备选 + Other）：

| 选项 | 适用 | guard 行为 |
|------|------|-----------|
| **full（推荐·默认严）** | 大需求 / 高风险 / 涉 auth·支付·数据 | 覆盖块 required-blank 硬卡；🔒 auth 锁硬拦 |
| **tweak** | 小功能 / 低风险内部改动 | required-blank 降级 **WARN**（不阻断）；🔒 auth 锁仍硬拦 |
| **hotfix** | 单点 / 一行 / typo | 同 tweak 放宽（🔒 锁不豁免） |

把答案映射到 `$TENON_PRESET`（缺省 / 非法值一律回落 `full`，保证"忘了问"也默认严）：

```bash
TENON_PRESET="${TENON_PRESET:-full}"          # full | tweak | hotfix
case "$TENON_PRESET" in full|tweak|hotfix) ;; *) TENON_PRESET=full ;; esac
```

> ⏳ **待迁移（M1 #12 留痕面 / M2 #21）**：老仓 full preset 的「mandatory skill 缺 → HARD 阻断」
> 「三轨 review 留痕硬卡」依赖 PostToolUse skill-tracker 的 tools_history 证据链，尚未迁移——
> 当前 guard 的 preset 差异只体现在覆盖块豁免（GUARD-RULES §3 S5）。

### Step 1.6: 选 pipeline_mode 全程模式（AFK↔human 分派）

> ⏳ **待迁移（M5 #29 automation）**：老仓在此用 AskUserQuestion 三选一
> （hybrid 推荐默认 / human 全程人工拒绝 AFK / afk 尽早自动跑），并
> `set pipeline_mode` 供看板 AFK 分派。AFK 调度子系统未迁移，且 lite 的
> `.pipeline.yaml` 契约字段（CONTRACT §1，37 字段）**无 `pipeline_mode`**——
> `tenon set` 会拒写未知字段。M5 收编前**跳过此步**（等价于老仓全程 human 语义），
> 结构立此存照。

### Step 2: 初始化 .pipeline.yaml

```bash
TENON_WORKFLOW="${TENON_WORKFLOW:-default}"
if [ "$TENON_WORKFLOW" = "default" ]; then
  tenon init "$TENON_CHANGE_NAME" --track "$TENON_TRACK" --preset "$TENON_PRESET"
else
  tenon init "$TENON_CHANGE_NAME" --track "$TENON_TRACK" \
    --workflow "$TENON_WORKFLOW" --preset "$TENON_PRESET"
fi
```

注册表 Track 创建前必须先用 `tenon tracks show "$TENON_TRACK" --json` 复核 Workflow allowed 关系；
`free` 的 `allowed: '*'` 只代表可绑定任意存在的 Workflow，不代表可以跳过该 Workflow。
Workflow 内声明的分支轨道（例如 Dashboard 新建的轨道）不在注册表中，`tracks show` 会报未注册；
此时由上面的 `tenon init --workflow` 校验该 Workflow 确有此分支，失败即停下重新确认。

### Step 2.1: 明确激活本次选中的 Change（强制）

```bash
tenon session activate "$TENON_CHANGE_NAME"
```

若 root dispatch 明确含 `continuous_execution: true`，改为：

```bash
tenon session activate "$TENON_CHANGE_NAME" --continuous --host-session "$TENON_HOST_SESSION_ID"
```

这只绑定当前 Change 的交互式 skill 连续执行授权；不得把它当作 review approval 或 phase transition。

只有此命令成功后才加载 `openspec-propose` 或任何 phase skill。它是当前会话的显式工作目标，
不是从 `.pipeline-active` 猜回的旧任务；后续 Skill evidence、文档账本和 custom workflow DAG 都只
消费这个确切目标。

可选入参：

```bash
# --user：显式开发者身份（写 created_by）。缺省由 CLI 解析。
tenon init "$TENON_CHANGE_NAME" --track "$TENON_TRACK" --preset "$TENON_PRESET" \
  ${TENON_USER:+--user "$TENON_USER"}

# 声明本 change 依赖另一个 change（老仓 init --depends-on 的等价改写；
# depends_on 是列表字段，逗号分隔多值。目标不存在时只是声明意图——
# build 出口 guard 会校验依赖已归档，见 GUARD-RULES B6）
[ -n "${TENON_DEPENDS_ON:-}" ] && tenon set "$TENON_CHANGE_NAME" depends_on "$TENON_DEPENDS_ON"
```

> ⏳ **待迁移（M1 #15/#17）**：老仓 init 内的 ROUND-12 三分支 dispatch
> （creator 首建 / joiner 入职引导 `00-join-<slug>/` / no-task 续接）依赖 task lifecycle
> 与 session 子系统，lite init 为单分支直建。

验证：

```bash
tenon get "$TENON_CHANGE_NAME" track          # 应返回 $TENON_TRACK
tenon get "$TENON_CHANGE_NAME" phase          # 应返回 "open"
tenon get "$TENON_CHANGE_NAME" preset         # 应返回 $TENON_PRESET
```

### Step 2.5: 登记 OpenSpec 初始文档证据（受治理 workflow 强制）

default 的全部可执行 track（含 free）和 `openspec_contract: required` 的自定义 workflow，必须把本 phase
真实由 `openspec-propose` 生成的三份文档登记进 ledger。先确认该 Skill 调用已有完成态 evidence，
再运行；不能用手工写文档或伪造 `--producer` 替代。

`document_contract: v1` 的短 workflow 不套用这三份固定清单；它只登记当前 owner step 声明的
slot，并使用 slot 的 producer 白名单。未声明文档契约的自由 workflow 跳过本节。

```bash
CHANGE_DIR="openspec/changes/$TENON_CHANGE_NAME"
tenon document record "$TENON_CHANGE_NAME" proposal "$CHANGE_DIR/proposal.md" --producer openspec-propose
tenon document record "$TENON_CHANGE_NAME" openspec-design "$CHANGE_DIR/design.md" --producer openspec-propose
tenon document record "$TENON_CHANGE_NAME" tasks "$CHANGE_DIR/tasks.md" --producer openspec-propose
tenon document status "$TENON_CHANGE_NAME"
```

### Step 3: 验证产物（不自动推进）

```bash
tenon check "$TENON_CHANGE_NAME"     # 相位出口 guard 报告：0 过 / 2 不过 / 1 错误
```

guard 通过条件（open 出口，GUARD-RULES §1）：
- `openspec/changes/<name>/.pipeline.yaml` 存在且非空
- `openspec/changes/<name>/proposal.md` 存在且非空
- `openspec/changes/<name>/tasks.md` 存在且至少 1 个 `- [ ]` 任务
- 所有 Track：`design.md` 存在且非空（PM 是初始产品/交互假设）

guard **只校验、不自动 transition**（本 pipeline 永不自动推进）。校验通过后：
1. 把 proposal.md + tasks.md 交用户过目、收反馈（"立项范围 / 任务对不对？"）；
2. 用户说"继续"后，手动推进：
   `tenon transition "$TENON_CHANGE_NAME" open-complete`

## 出口

- 事件：`open-complete`
- 下一 phase：`explore`（**用户确认后手动进入**，不自动 chaining、不"同一会话立即继续"）

## 错误处理

| 现象 | 处理 |
|------|------|
| check 报 proposal 为空 | 提示用户填写后重试 |
| check 报缺 design.md | 用 openspec-propose 补全或手动创建 |
| .pipeline.yaml 已存在但 track 不一致 | 询问是否覆盖；若覆盖则 `tenon set <name> track <new>` |
| 用户中途取消 | 删除 change 目录（含 .pipeline.yaml） |

## 打包 skill 依赖（随 tenon 插件安装）

- bundled-skill: triage · 条件（既有项目并入 issue 流时才加载）
