---
name: tenon
description: "主编排 skill（Decision Core）。chat 纯对话；simple 走轻量图；free 显式绑定任意 Workflow 且不叠加领域 Track；其余任务识别 pm/frontend/backend。状态一律经 Tenon CLI 读写；支持断点恢复。"
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

# /tenon — 主编排入口（Decision Core）

## 文档语言契约

- 新 Change 的治理文档默认使用 `zh-CN`，并沿用创建时固定在
  `.pipeline-document-locale.json` 的 locale；不要从 Dashboard 语言或全局偏好覆盖它。
- 编写 proposal、design、tasks、spec、ADR、plan、research、verification report 或 applied spec 前，缺失结构先运行 `tenon document scaffold <change> <kind>`；模板只补缺失文件，不代表 Skill 已执行或文档已登记。
- 可见标题、说明、任务和场景叙述沿用固定 locale（默认中文，显式 `en` 时使用英文）；phase/event id、DocumentKind、producer、文件名、frontmatter/coverage key、命令和 OpenSpec 的 `ADDED/MODIFIED/REMOVED Requirements` 等机器 token 保持英文。
- 已有 Change 没有 locale metadata 时沿用现有文档语言；setup/update 不自动翻译或改写现有 Change/Archive。

> 移植来源：老仓 workflow-plugin `skills/pipeline/SKILL.md`。老仓 bash 脚本面
> （pipeline-state.sh / pipeline-guard.sh / tenon-archive.sh）已全部改写为本仓
> `tenon` CLI（命令契约见 `docs/CONTRACT.md` §3）。快速入口版见 `tenon`。

## Codex 打包 Skill 身份（硬规则）

本文件和后续 phase 文件中的裸 id（例如 `prototype`、`openspec-propose`）是 workflow/DAG 和
CLI `--producer` 使用的**逻辑 id**。在 Codex 中实际加载时，必须调用当前已安装插件的
`tenon:<id>`（例如 `tenon:prototype`），并让宿主读取该插件 cache 内的
`skills/<id>/SKILL.md`；不得因同名而改读 `~/.agents`、`~/.claude`、项目目录或其他插件的副本。
已激活 Change 时 hook 会拒绝这类 shadowed read。若该打包 skill 不可用，运行
`tenon setup --codex` 或 `tenon update --codex` 修复，不能用同名外部 skill 代替。

Codex 通过 custom tool-program 读取上述必需 Skill 时，必须把内部执行的完整结果转发给宿主，
使 `exit_code` 可审计：

```javascript
const result = await tools.exec_command({ cmd: "<读取 SKILL.md 的命令>", workdir: "<绝对项目目录>" });
text(result);
```

不得使用 `text(result.output)`：它会丢失内部退出码，即使外层 custom tool 显示完成，也不能
证明 Skill 读取成功，Tenon 会按失败关闭拒绝 receipt。原生 `function_call(exec_command)` ABI
继续由其结构化 output 提供退出码。

## 触发场景

用户输入以下任一情况触发本 skill：
- 含开发关键词（"加个功能 / 改 bug / 重构 / 实现 ..."）
- 含 PM 关键词（"调研 / 竞品 / PRD / 需求 ..."）
- 显式 `/tenon` 命令
- 显式 `/tenon 继续` 进行断点恢复
- 显式“自由模式 / free mode”，以不叠加领域 Track 的方式执行所选 Workflow

**Chat 类输入（"问 / 解释 / how / what"）不应触发本 skill** — 直接对话即可。

## Normal-chat dispatch contract（必须执行）

当正常开发对话的 hook 注入 `<pipeline-dispatch>` 时，它已经选择了路由模式：`default`、等待用户选择
`select`，或已绑定 Change 的自定义 workflow。**本 skill 就是该注入要求调用的入口**：不得把它降级为
普通建议、不得先生成脱离流程的通用 Todo、不得跳过到某个实现 skill。

1. 先读取 `<pipeline-dispatch>` / `<workflow-state>` 中的 `intent`、`track`、`change`、`phase`、
   `continuous_execution`、可选的 `host_session_id`；再用
   `tenon list --json` 与（仅 `intent: resume` 时的）`tenon status <name> --json` 复核状态。
2. `intent: new` 是最高优先级：依据用户原始需求生成 kebab-case change 名，按 default **独立创建**，
   严禁从 `tenon list`、`.pipeline-active`、旧 phase 或旧 `tasks.md` 推断/复用任何已有 change。
   `intent: resume` 只能恢复注入中点名的 change；`intent: select` 只列候选并让用户点名，严禁猜测。
   只有缺少 `intent` 的手动调用才使用本文件 Step 3 的旧式决策表。用户明确点名 custom workflow 时才偏离 default。
3. **选择契约优先于创建**：若 dispatch 含 `selection_required: true` 或 `workflow: select`，它已
   证明当前项目存在 custom Track 或非 default workflow。必须将 `suggested_track` /
   `suggested_workflow` 作为推荐项，并逐条读取 `candidate: track=<id>;workflow=<id>`；在运行
   `tenon init`、创建 Todo、调用任何 phase skill **之前**用宿主交互能力让用户选择一个精确 pair。
   - 有 `AskUserQuestion` 时，提一个问题，首项标明“推荐”，选项只使用注入的合法 candidate pair；
     不得合成跨 Track/workflow 的非法组合。
   - Codex 等没有 `AskUserQuestion` 工具的宿主，直接用一条普通对话询问同一个问题并**停止本轮**；
     用户回答后才继续。不得把“未回答”当成默认同意。
   - 用户点名的 pair 仍须用 `tenon tracks show <track> --json`（或创建 API）复核 workflow
     allowed 关系；复核失败则重新询问，绝不猜测回退。
   - 选择完成后，以该 Track 与 workflow 创建**新的** Change；即使 `.pipeline-active` 指向其他
     Change，也不能把新目标绑回旧状态。
4. 无 selection 契约时，按注入的 workflow 身份分支：
   - `workflow: default` 的新目标按注入 Track/default workflow 创建独立 Change；随后才建立七相 Todo
     并分派当前 phase。
   - `track: free` 是显式可执行模式，不是 `chat` 的别名。先用
     `tenon tracks show free --json` 复核其 `allowed: '*'`，再以精确 Workflow 创建 Change。
     `free/default` 仍完整执行 default 七阶段、OpenSpec、Superpowers、ADR、review 与文档读取收据；
     `free/<custom>` 则只执行该 custom Workflow 声明的 DAG、Skill、Hook、gate 与
     `openspec_contract`。两者都不得叠加 PM/frontend/backend 的 coverage、AFK 或技能矩阵。
   - `workflow: simple` 的新目标必须按 `track=simple` 执行
     `tenon init <name> --track simple --preset tweak`。它从内建 `change` step 开始，不初始化
     OpenSpec/Superpowers/ADR 文档链；Todo 一级项来自内建图 `change → verify → done`，并保留
     `escalated` 终态。立即调用 `simple-task`，完成后仅按图调用
     `verification-before-completion`。边界扩大时必须走 `scope-expanded`，再创建新的 default
     Change，并立刻用 `tenon set <new-change> depends_on <simple-change>` 保留机器可读审计链；
     不得把 simple Change 原地改 workflow/track。
   - `intent: resume` 且 `workflow` 非 `default` 时，Change 的 workflow 是不可变身份。先用
     `tenon status <change> --json` 与 `tenon tracks show <track> --json` 复核；再运行
     `tenon workflow plan <change> --json` 读取该 WorkflowRun 初始化时冻结的完整运行计划，并从
     `plan.workflow.steps` 确认当前 step、Skill DAG、门禁与转换。**不得**直接读取后来可能被修改或删除的
     `.pipeline/workflows/<workflow>.yaml` 来编排在途 Change，也不得把 default 的 breadcrumb、
     recommended/mandatory skill matrix 或 Step 4 的默认技能表套到该 Change；先调用本入口并仅按
     冻结 DAG 分派已解锁 Skill。
   - `workflow: select` 必须停在第 3 条的用户选择，不能臆造 default 或任一 custom workflow。
5. **精确绑定再读 phase skill**：一旦 new / resume / select 得到精确 Change，必须先运行
   `tenon session activate "<change>"` 并确认成功。若 dispatch 带合法 `host_session_id`，先把其值
   写入本轮 shell 的 `TENON_HOST_SESSION_ID`，并在 activate 上追加
   `--host-session "$TENON_HOST_SESSION_ID"`；这是仅供 dashboard 判断正常会话是否仍在执行的精确
   session→Change 绑定，绝不能用 `.pipeline-active` 猜测或替代它。若 dispatch 明确含
   `continuous_execution: true`，同一条 activate 再追加 `--continuous`（两个 flag 可同时使用）：它会
   原子写入**仅绑定这个 Change**的互动 skill 连续执行授权与隐私最小化审计行。new 要在 `tenon init`
   成功后立刻执行；resume 要在 `tenon status <change> --json` 复核后执行。这个命令只把已明确选中的目标写为
   evidence/DAG 的当前绑定；绝不能从旧 `.pipeline-active` 反推新任务，也不得在它成功前创建
   Todo、读取 phase Skill 或登记文档。`--continuous` 记录该用户对这个 Change 的连续执行与 review
   委托：每个 review 出口仍须先完成真实 skill / OpenSpec / guard 证据，再用 `review acknowledge
   --delegated` 写带授权来源的 receipt；它不授权范围/安全/成本/外部状态的实质变更。

   ```bash
   # 仅当 dispatch 有 host_session_id 时设置该变量；没有时不要编造值。
   TENON_HOST_SESSION_ID="<pipeline-dispatch 的 host_session_id>"
   tenon session activate "$CHANGE_NAME" --host-session "$TENON_HOST_SESSION_ID"

   # 若同一 dispatch 还声明 continuous_execution: true，两个 flag 必须同时保留。
   tenon session activate "$CHANGE_NAME" --host-session "$TENON_HOST_SESSION_ID" --continuous
   ```
6. Todo 一级项必须来自所绑定 workflow 的真实 step 图：
   - default：`open → explore → spec → build → verify → ship → archive`，二级任务来自
     `tasks.md`；
   - simple：`change → verify → done`，并显示 `escalated` 分支，不创建或读取 `tasks.md`；
   - 项目 custom：从 `tenon workflow plan <change> --json` 返回的冻结计划投影。
   不得把原始提示词拆成脱离 phase/step 的一级 Todo。
7. 紧接着调用真实图中当前 step 声明的 skill。default 使用本文件 Step 4 表；
   simple 的 `change` 调用 `simple-task`，`verify` 调用 `verification-before-completion`。Hook 只能注入上下文，
   不能替宿主实际调用 Skill，因此此调用是入口的强制职责。

阶段 skill 若没有继承 shell 环境变量，必须继续使用本段注入的 `change/track/phase` 与 CLI 复核，不得
因 `$TENON_CHANGE_NAME` 为空而回退成普通对话。

---

## Governed OpenSpec document contract（default 的真实闭环）

默认 workflow 的**全部可执行 track（包括 PM 与 free）**、声明了 `openspec_contract: required` 的自定义 workflow，
以及声明了 `document_contract: v1` 的短 workflow，
都不是“有文件即可”的松散流程。它们必须在 `.pipeline-documents.json` 中留下：**真实 Skill 调用证据 →
文档内容 SHA-256 → 后续 phase 对该精确版本的读取收据**。PM 的 PRD、用户旅程和原型交付仍保留，但也必须
产出可实施的 OpenSpec delta spec / plan 并在 ship 应用主 spec。

对 default/legacy-full workflow，下表完整适用；对 `document_contract: v1`，只执行该 profile
为当前 step 声明的 outputs/reads，不得擅自扩成七阶段矩阵。`--producer` 必须等于本轮**实际调用且已有完成态 history
证据**的 Skill；不能为了通过检查伪造名字。原生 PostToolUse 是首选证据源；Codex 某些 exec
路径缺少该回调时，CLI 只会在同一宿主 transcript 已证明该精确 SKILL.md 读取完成后补写同一种
`CodexSkillRead` 证据。默认 workflow 一律使用本插件
打包的 bare 名称（`brainstorming` / `writing-plans` / `verification-before-completion`）；ledger 保留旧
namespace 仅用于读取历史 change，不把它作为新安装的前置条件。

未声明任一 document contract 的 workflow（包括内建 `simple`）明确不受本节文档契约治理：它的审计事实是 canonical Change、step transitions、
实际 skill 调用和聚焦验证，不生成 proposal/design/delta spec/Superpowers/ADR。

| phase | 进入时先读 | 退出前必须登记的真实产物 |
|---|---|---|
| open | 无 | `proposal`、`openspec-design`、`tasks`（`openspec-propose`） |
| explore | open 的三份文档 | `superpower-design`、`adr`（`brainstorming`）；若以调研结论更新 `proposal.md` / `design.md`，由 `tenon-explore` 重登记当前 SHA，并重新读取上游文档 |
| spec | 前两阶段全部文档 | `delta-spec`（`openspec-propose`）、`superpower-plan` + `plan`（`writing-plans`）；若因 `requirements-changed` 回退或更新 coverage，由 `tenon-spec` 重登记 proposal/design/tasks 当前 SHA |
| build | 截止 spec 的全部文档 | 每次勾选/改写 `tasks.md` 后以 `tenon-build` 重登记当前 SHA，再补本 phase read receipt |
| verify | 截止 spec 的全部文档 | `verification-report`（`verification-before-completion`）；完成验证任务后由 `tenon-verify` 重登记 tasks |
| ship | 再加 verification report | `applied-spec`（`openspec-apply-change`）；完成交付任务后由 `tenon-ship` 重登记 tasks |
| archive | 截止 ship 的全部文档 | 读取后完成归档任务，并由 `tenon-archive` 重登记最终 tasks |

除 open 外，phase 开始时先执行：

```bash
tenon document read "$TENON_CHANGE_NAME" all
```

在每个 phase 的输出登记后、现有 `tenon check` 之前，必须执行：

```bash
tenon document status "$TENON_CHANGE_NAME"
```

`tenon transition` 与 `tenon check` 都会重算内容 hash 和读取收据；文件后来被改、没有读取、或
producer 没有真实 Skill evidence 都会拒绝推进。这正是“后续步骤会读取前面生成的 spec/Superpowers/ADR”
的可验证实现，而非提示词承诺。

`--backfill` 只用于升级旧 Change 时首次收纳**尚未登记**的历史文档；它绝不能覆盖已有 record 或把旧
skill 冒充为活文档当前 hash 的 producer。活文档更新只能由当前 phase 实际调用的 skill 重登记。

---

## Decision Core（决策核心）

执行任何动作前先完成以下 4 步定型。

### Step 0: CLI 可用性预检（必做）

老仓的"定位脚本 + 握手文件"整段已废——本仓状态操作只有一个入口：`tenon` CLI。

```bash
# Tenon CLI 可用性检查（插件随包的单文件 bundle）
if ! command -v tenon >/dev/null 2>&1; then
  echo "[HARD STOP] Tenon CLI 未找到。" >&2
  echo "  修复：重新从本插件发布包运行 ./install.sh --codex（或 --claude）；它会验证并发布托管 runtime，再安装稳定 ~/.local/bin/tenon 启动器。" >&2
  exit 1
fi
```

> ⏳ **待迁移（M3 #26b）**：老仓 Step 0 的 `pipeline-doctor.sh` 依赖预检（分级报告 + 缺失
> skill token 清单 + AskUserQuestion 三选一自动安装编排）迁移为 `tenon doctor` 统一健康面
> 后在此接回。当前安装期由 `bash tools/verify-skills.sh` 校验整个打包 skill inventory；default
> workflow 不下载或要求任何外部 skill。

### Step 1: L1 Track 路由（必做）

根据用户输入识别 Track。**关键词优先匹配**，模糊时询问用户。

| Track | 关键词（命中任一） | 后续动作 |
|-------|------------------|---------|
| **chat** | 问 / 解释 / how / what / why / 怎么用 / 是什么 / 区别 | **跳过 pipeline**，直接对话 |
| **simple** | typo / 文案 / 注释 / 单行或单文件值调整 / unused import；且不含高风险否决项 | 进入内建轻量流程 |
| **free** | 用户显式说“自由模式 / free mode / track=free” | 不参与关键词评分；复核精确 Workflow 后执行，不叠加领域 Track |
| **pm** | 调研 / 竞品 / PRD / 需求 / 用户旅程 / 原型 / market / 立项 | 进入 PM 流程 |
| **frontend** | 前端 / UI / 页面 / 组件 / React / Vue / Next / Tailwind / 样式 / .tsx / .jsx / .vue | 进入 Frontend 流程 |
| **backend** | 后端 / API / 接口 / 数据库 / Go / Python / Java / Rust / NestJS / Postgres / endpoint | 进入 Backend 流程 |

**判定规则**：
1. 先评估 simple 否决项：API/公共契约、schema/migration、auth/security、跨模块、多文件、
   新功能/重构/架构、依赖/部署/发布/生产数据任一命中，simple 必须归零。
2. simple 有明确正向信号且无否决项 → 直接选择 simple。
3. free 只能由用户显式选择，永远不能成为评分兜底或自动 winner。
4. 其余任务再按 pm/frontend/backend 匹配；通用“实现/修复/修改”至少进入 backend 完整轨，
   不得因缺少领域词静默绕过。
5. 真正领域冲突且会改变执行范围时才询问。

**Track=chat 时**：直接回答用户问题，不进入后续步骤。**禁止**为 chat 类输入创建 change。

> Track 评分与 default 分发由 UserPromptSubmit router 注入；当注入已有 track 时以它为准，只有
> 没有注入上下文的手动 `/tenon` 调用才按本表重新判定。

### Step 2: 扫描活跃 change

```bash
tenon list          # 活跃 change 表（名字 / track / phase）
# 机器可读：tenon list --json
```

### Step 3: 决策表（必读）

| Track | 活跃 change | 用户输入 | 行为 |
|-------|-------------|---------|------|
| chat | 任意 | 任意 | 跳过 pipeline，直接对话 |
| simple | 任意 | 明确局部新目标 | → 创建独立 simple Change，从 `change` 开始 |
| free | 任意 | 显式新目标 + 精确 Workflow | → 校验 `free/Workflow` 后创建独立 Change |
| free | 任意 | 明确恢复已绑定 Change | → 按 canonical Workflow 当前 step 恢复，不套标准 Track |
| pm/frontend/backend | 0 | 有描述 | → **tenon-open**（创建新 change） |
| pm/frontend/backend | 1 | "继续" / 无描述 | 自动恢复（`tenon status <name>` 判定 phase） |
| pm/frontend/backend | 1 | 有描述（与该 change 无关） | → **tenon-open**（独立新建；不复用旧 change） |
| pm/frontend/backend | ≥2 | 明确“继续”但未点名 | 列出活跃 change 让用户选 |
| pm/frontend/backend | ≥2 | 有描述的新目标 | → **tenon-open**（独立新建；不按 mtime 猜测） |

> Hook 已提供 `intent` 时，上表不得覆盖它：`new` 必建新、`resume` 必只恢复指定项、`select` 必等待选择。

#### 建新 change 前的归档软提醒（提醒强制、不阻断并行）

当 Track∈{free,pm,frontend,backend} 且**手动调用的决策结果是「新建 change」**（用户有新描述）且活跃 change **非空**时——在调 `tenon-open` **之前**，**先用 AskUserQuestion** 列出每个未归档活跃 change（`名 + phase + updated_at 陈旧度`，数据来自 `tenon status <name>`），三选项：

| 选项 | 行为 |
|------|------|
| 归档某个再建 | 先走 `tenon-archive` 归档所选 change，再 `tenon-open` |
| 并行新建（默认放行） | 照常 `tenon-open`，**不阻断**——多 change 并存是合法的 |
| 取消 | 不创建，回到对话 |

> **强制**：只要满足上述条件就**必须**弹这个提醒，**禁止**跳过直接 `tenon-open`。但它是**软提醒**——用户选「并行新建」即正常放行，不硬拦。`<pipeline-dispatch intent: new>` 是例外：路由器已根据本轮新目标做出会话隔离决定，必须立即创建独立 change；只在输出中告知存在并行候选，不能让旧 change 劫持本轮。陈旧度用 `updated_at` 与当前时间差估算（如「3 天前」），帮用户判断哪个 change 该先收尾。

**断点恢复关键原则**：
- 每次本 skill 调用都从 Step 0 开始，**不依赖对话历史**
- 当前 phase 由 `.pipeline.yaml` 的 `phase` 字段决定（`tenon get <name> phase`）
- 若 yaml 不存在或损坏，以文件系统状态为准（proposal/design/tasks 等存在性），用 `tenon set` 修正后继续

---

## Step 4: Phase 分发（自动）

确定 Track + change 名 + phase 后，先区分 workflow：下表只定义 **default** workflow 的 phase
入口。已绑定的 custom workflow 必须以 `tenon workflow plan <change> --json` 返回的冻结运行计划和
`tenon internal-skill-gate <change> <skill>` 的实际解锁结果为准：只有图中声明且已解锁的 skill
可调用，不能从此表补出图外 skill、默认 skill 矩阵或默认依赖。

<!-- 分发表按相位名约定派生（pipeline-<phase>）；相位与合法转换的单一真相源 =
     templates/manifest.yaml（引擎真读，零硬编码）。新增相位改 manifest 一处即可。-->
| phase 字段值 | 调用子 skill |
|-------------|------------|
| `open` | `tenon-open` |
| `explore` | `tenon-explore` |
| `spec` | `tenon-spec` |
| `build` | `tenon-build` |
| `verify` | `tenon-verify` |
| `ship` | `tenon-ship` |
| `archive` | `tenon-archive` |

```bash
# 读当前 track / phase（CLI 是唯一状态入口，勿手改 .pipeline.yaml）
TRACK=$(tenon get "$CHANGE_NAME" track)
PHASE=$(tenon get "$CHANGE_NAME" phase)
echo "[tenon] 当前 change=$CHANGE_NAME / track=$TRACK / phase=$PHASE"

# 每进入一个 phase，先重建上下文：状态摘要 + 关键产物路径（design_doc / plan /
# verification_report），把产物文件本体 Read 进上下文——禁止凭印象进行。
tenon status "$CHANGE_NAME"
for f in design_doc plan verification_report; do
  p=$(tenon get "$CHANGE_NAME" "$f"); [ -n "$p" ] && [ "$p" != "null" ] && echo "产物[$f]: $p"
done
```

> ⏳ **待迁移（M2 #20 深化）**：老仓 `pipeline-context.sh` 的"至今全部产出 + 产物索引 +
> 领域词典"全量重注入尚未迁移。当前 lite 面：SessionStart（hooks/session-start.sh）已做
> 三注入（工作流宪法 templates/workflow.md + 活跃 change 上下文 + openspec 提示），phase 内
> 用上面 `tenon status` + Read 产物文件重建。语义缺口只在"领域词典/产物全索引"。

**立即执行**：先按上面重建上下文（读产物文件本体）。default workflow 再使用表中对应的
`tenon-<phase>` 子 skill；custom workflow 则先读取冻结 DAG，只调用其中已解锁的 phase entry
skill（若图未声明 `tenon-<phase>`，不得擅自补调用）。**禁止跳过此步骤**。

default 的七个 `tenon-<phase>` 是 Workflow-owned hard requirements，随 Workflow snapshot
冻结；`free`/`matrix=false` 也不能跳过当前 phase。manifest 的 Track
`mandatory_skills`/`recommended_skills` 仅在 matrix-enabled 时自动叠加。artifact producer 与
AFK 的显式 named profile 可以使用既有 allowlist，但 explicit resolver 仍以冻结 phase Skill
为首位，不能反向把 profile 变成 Hook/transition 自动要求。

内建 `simple` 也是非 default workflow，但不读取项目 `.pipeline/workflows/simple.yaml`；其定义随插件
版本由 kernel 只读提供，项目同名文件不能覆盖。`change` 只允许 `simple-task`，`verify` 只允许
`verification-before-completion`，`done` / `escalated` 是终态。

`free` 不是另一张 workflow 图：它只是中性的执行 Track。若绑定 default，仍使用上表七阶段子 skill，
同时有效 profile 是 `free` 的 named allowlist 仅用于显式 artifact/AFK 投影；它不会削减冻结的
phase Skill，也不会自动开启 Track overlay。若绑定 custom，则完全按 custom 图解析，既不补 default
skill，也不跳过该图自己的 gate/Hook/OpenSpec contract。

子 skill 的上下文优先级：`<pipeline-dispatch>` 注入 → 已激活 Change / `tenon status` →
`TENON_TRACK` 与 `TENON_CHANGE_NAME` 环境变量。环境变量只是兼容快捷方式，不能是唯一真相源：
Codex 的 Skill 工具调用不承诺继承前一个 Bash 命令的 export。

```bash
export TENON_TRACK="$TRACK"
export TENON_CHANGE_NAME="$CHANGE_NAME"
```

### Todo 同步纪律

`openspec/changes/<name>/tasks.md` 是任务的唯一可编辑来源；dashboard 会把它投影到 default 的七个
phase。推荐用 `## Open` / `## Explore` / `## Spec` / `## Build` / `## Verify` / `## Ship` / `## Archive`
（也接受对应中文标签）组织任务。没有明确阶段标题的 checkbox 只属于当前 phase，绝不扩散成泛化
Todo。进入 build 前，spec skill 必须将实际实现任务同步到 `## Build`；build 完成后再按现有 guard
将全部实现 checkbox 勾完。

---

## 阶段衔接规则

<IMPORTANT>
单次 `/tenon` 调用从检测到的 phase 开始。**常规模式**每个 phase 产出后必须停下、把刚产出的
文档/产物交用户过目并收反馈，用户说"继续"才手动 `tenon transition`。**持续授权模式**可在同一
Change 连续处理无 confirm/外部副作用的出边，但绝不跳过检查或伪造证据。
（双重保障：① `tenon check <name>` **只校验、绝不自动 transition**；② 决策 phase
（explore/spec/verify，单一真相源 = templates/manifest.yaml 的 review_phases）在**产物完成且 check
通过后**必须运行 `tenon review request <name> --event <event>`。该命令写入 canonical pending receipt，并投影一个
含 Change identity 与 exact event 的 v2 `.pipeline-pending-review` marker；这时才由 hooks/gate.sh 拦截写类工具。
先展示产物并让用户确认；常规 Codex 用户下一条明确“确认继续/继续执行”会调用
`tenon review acknowledge <name>` 写入 exact phase-and-event approval receipt。若当前 Change 有用户明确
写入的持续授权，只能在这些真实前置已完成后调用 `tenon review acknowledge <name> --delegated`，并在
history 记录委托授权时间；随后才能重发同一 event 的 transition。进入 review
相位本身绝不落 marker，因此 explore/spec/verify 的实际工作不会自锁。档 C 必须保留确认事实并显式
acknowledge，**不得**删除 marker 绕过。被拦的那次操作已丢弃，解封后须重新发起。）
</IMPORTANT>

> ⏳ **待迁移（M1 #13）**：门 marker TTL 当前统一 15 分钟（CONTRACT §3 白名单②）；
> 老仓 confirm=300s / review·interaction=1800s 的分级 TTL 恢复后按 #13 收口。

### 必须暂停等用户的节点

**0. 阶段产出复核（HARD RULE，每个 phase 边界都要，最重要）**
   每当一个 phase 产出文档/产物并前向 transition 后（open→explore→spec→build→verify→ship），
   进入下一 phase 前**必须**用 AskUserQuestion 把刚产出的东西拿给用户：
   - **明确呈现**：这一步生成了什么（文档路径 + 要点摘要 / 原型截图），请用户过目；
   - **主动问反馈**：「方向对不对？要改哪里？还是继续？」——该问的都要问，不能替用户决定；
   - 用户给了修改意见 → 先改、再复核；用户确认 → 才进入下一 phase。
   绝不允许"全部生成一遍丢给用户"。每一步的文档和技能产出，反馈都不能省略。

其余决策节点（默认必须暂停）：
1. **brainstorming 确认设计方案**（explore phase 内）
2. **build_mode / isolation 选择**（build phase 入口）
3. **设计方向选择**（build phase，PM/前端原型）：使用用户自有 `DESIGN.md`、Tenon 设计规范或 hue 自定义 —— 见 `tenon-build`
4. **verify-fail 决策**（修复 vs 接受偏差）
5. **finishing-branch 分支处理方式**（ship phase 内）
6. **preset 升级条件触发**（hotfix/tweak → full）

**已授权自主执行例外**：当当前用户明确给出“后续无需询问 / 自主执行完成”这类持续授权时，
不得为了重复确认而停住。Agent 必须采用该 skill 已定义的保守、可审计默认值，把选择与理由
写入 Change 文档/状态；不得伪造 review receipt，也不得跨过 Explore、Spec、Verify 的真实 review
证据与 guard。正常对话的新任务由 router 透传 `continuous_execution: true`，并在精确 Change 创建后以
`tenon session activate <change> --continuous --host-session <id>` 落该授权；已有 Change 的同类确认由带
同一 host session id 的 hook 绑定。
Build 的具体默认与 Git 受限环境处理见 `tenon-build`。

phase **内部**步骤可连续做（产物靠 Edit/Write 落盘）；常规模式在 phase 边界停下复核，持续授权模式在
无 confirm/外部副作用边界时可继续。对 review phase 的准确出口顺序是：`tenon check` → `tenon review request --event <event>` → 展示产物 → 常规用户确认 / `tenon review acknowledge`，或已委托 Change 的 `tenon review acknowledge --delegated` → 重发同一 `tenon transition`。单出口可省略 `--event`，但 default 的 verify 与任何多出口 custom step 必须显式指定，避免把一种决定借给另一条边。

**Custom workflow 绝不套 default 门**：先读取 `tenon workflow plan <change> --json` 的当前 step。`gate: null`
在 check/文档证据通过后直接走该 step 的 transition；`gate: review` 走上面的 receipt 协议；`gate: confirm`
仍等待人类。不得因 default 的 Explore/Spec/Verify 文本而给 custom Build 或 Ship 凭空补 review，也不得因
持续授权把 `confirm` 或外部发布动作自动化。

**Custom step 在计划 JSON 中带 `completion_event: "archived"` 时**（例如 Dashboard 编辑器生成的末阶段，只有退回边或
零出边）：进入该 step 不等于任务完成。先完成该 step 声明的 Skill 与 guard，再用保留事件 `archived` 完成运行——
`gate: review` 走 `tenon check` → `tenon review request <change> --event archived` → 展示产物并等待用户确认
（`tenon review acknowledge`）→ `tenon transition <change> archived`；`gate: null` 或 `gate: auto` 走 `tenon check` →
`tenon transition <change> archived`。成功后 `archived: true`、WorkflowRun 关闭。没有 `completion_event` 的 step
（有前进出边，或只在循环中退回的中间步骤）不接受 `archived`，按计划中的出边继续。

### Preset 升级条件

当前 preset 为 `hotfix` 或 `tweak`，发现以下任一情况时**必须停止当前 preset 流程**，提示用户升级到 full（`tenon set <name> preset full`）：

**hotfix → full** 触发条件（任一）：
- 改动涉及 **≥3 个文件**
- 涉及架构变更（新模块/新接口/新依赖）
- 涉及数据库 schema 变更
- 修复引入新的 public API

**tweak → full** 触发条件（任一）：
- 改动涉及 **≥5 个文件**
- 涉及多模块协调修改
- 需要 ≥5 个新测试用例
- 涉及配置项新增/删除（非值修改）

---

## 错误处理速查

| 场景 | 处理 |
|------|------|
| `tenon` CLI 未找到 | Step 0 的 HARD STOP 提示（从本插件发布包运行 `./install.sh --codex` 或 `--claude`，不安装外部 CLI） |
| `openspec/` 尚不存在 | 用本插件 `tenon init <name> --track <t> --preset <p>` 创建 default change 骨架 |
| `.pipeline.yaml` 格式异常 | 以文件状态为准，用 `tenon set <name> <field> <value>` 修正后继续 |
| 子 skill 不可用 | 停止流程，运行 `tenon setup --<host>` 或 `tenon update --<host>` 修复同一个打包插件；**不要用普通对话替代** |
| 构建/测试失败 | 返回 build phase 修复，不进入 verify |
| change 目录结构不完整 | 按 `tenon-open` 产物要求补齐 |
| 同时有多个活跃 change | 列出让用户选，**不要默认选第一个** |
| transition 报非法转换（exit 1） | `tenon status <name>` 核对当前相位；合法边见 templates/manifest.yaml |

---

## 与本仓系统的关系

- **hooks 全自动挂载**（hooks/hooks.json）：SessionStart 三注入（宪法/上下文/openspec 提示）、
  UserPromptSubmit breadcrumb 每轮重提、PreToolUse 三门拦截——本 skill 不需要手工触发它们。
- **状态唯一入口 = Tenon CLI**：`init / get / set / set-many / cas / transition / check /
  status / list / inbox / import`（CONTRACT §3）。禁止直接 Edit `.pipeline.yaml`。
- **收件箱**：`tenon inbox`（`--html` 出静态单页）回答"现在哪个 change 在等我做什么决定"。
- **不依赖 tenon npm 包**：本 skill 完全独立。

---

## 速查：所有子 skill

| 命令 | Phase | 主要产物 |
|------|-------|---------|
| `tenon-open` | 1. open | proposal.md / design.md / tasks.md / .pipeline.yaml |
| `tenon-explore` | 2. explore | docs/superpowers/specs/...-design.md (技术 RFC) |
| `tenon-spec` | 3. spec | docs/superpowers/plans/... / delta spec |
| `tenon-build` | 4. build | 代码 + commit |
| `tenon-verify` | 5. verify | 验证报告 + 三轨 review 通过 |
| `tenon-ship` | 6. ship | PR + main spec 同步 |
| `tenon-archive` | 7. archive | 归档 + (可选) learn-record |

### 正交持久 worker 层（与 7-phase 解耦）

> ⏳ **待迁移（M4 #27 channel / #28 mem）**：老仓 `/channel`（event-sourced 消息/事件总线 +
> worker 生命周期 spawn/send/wait/interrupt/kill）与 mem（跨 runtime 会话检索）子系统尚未迁移。
> 语义要点先立此存照：channel 与 build→verify barrier **正交**——只读地为 barrier 提供
> worker/事件事实，绝不触 barrier/三门/build_sha，主线仍 owns commits；channel 事件绝不驱动
> 阶段跳转。迁移落地前，本仓**没有** `/channel` 入口，勿引用。
