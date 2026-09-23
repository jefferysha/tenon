# 发布说明

Tenon 的发布说明用于回答三个问题：这一版改变了什么、用户需要做什么、如何确认升级成功。

本页只记录已经进入公开发行包的能力，不把规划、内部 ADR 或尚未合并的实验写成已交付事实。

## 阅读方式

每个版本条目都按“新增、变化、修复、升级动作、验证、兼容性”组织。

命令、事件名、phase id、配置 key 和文件路径保留英文，以便与 CLI 输出逐字对应。

面向用户的解释、影响与操作步骤默认使用中文。

## v0.1.1 · 2026-09-23

正确性修复版。在真实宿主上验收 v0.1.0 时发现：默认工作流五条轨道里有三条走不通，另有几处 Tenon 没有核实就把步骤报成了完成。

### 阻断修复：宿主拒绝执行的强制技能

- v0.1.0 的 `pm`、`frontend`、`backend` 三条轨道都出不了 `explore`，`pm` 还卡在 `spec`、`verify` 与 `ship`。
  这些步骤的强制技能里有上游技能在 `SKILL.md` 中声明了 `disable-model-invocation: true`：宿主拒绝代模型调用，
  留不下回执，每次流转都报 `step-skills-incomplete`。
- 替换：`grill-with-docs` 换成它自己委托的 `grilling` + `domain-modeling`；`improve-codebase-architecture` 换成
  `codebase-design`，内建 `architecture` agent 同步更换。`pm` 不再强制 `handoff`（改用
  `tenon handoff <change> [--bundle]`）、`to-spec` 与 `to-tickets`：applied-spec 文档与 spec 步骤的任务门禁已经覆盖
  它们原本的作用。被移出的技能仍随包分发，作为人工指引。
- 此类缺陷不会再发版：发布候选的技能校验以 `mandatory-skill-not-invocable` 失败；`tenon doctor` 新增
  `skills:invocable`，强制技能的全部备选都被证明不可调用时为红，读不到其 `SKILL.md` 时为黄；Dashboard 拒绝保存
  把这类技能设为强制的工作流。

### 不再误报通过

- `tenon check`、`tenon transition` 与 `tenon status` 对步骤技能与出口规则共用同一份判定。v0.1.0 中三者会对同一份
  状态给出不同结论：在 pm 的 `ship`，`check` 失败，`status` 却显示出口就绪，`transition` 也放行。现在任务不能在缺少
  交付物时完成，例如 `prd_path` 为空的 pm 任务。
- 任何轨道上，spec 预演都不再满足 applied-spec 义务。
- 被步骤文档契约点名为产出者的强制技能，只有在本次步骤访问中登记了它产出的文档才算完成，仅有调用回执不再算数。

### 只按 `next` 就能走完任务

`tenon status <change> --json` 的 `next` 现在只给出命令真正接受的动作，只按它执行的 runner 可以把默认任务从
`open` 走到 `tenon list --finished`：

- 已登记后又被修改的输入文档会重新登记，不再无限重复读取；
- 脚手架生成的文档在同一波里登记，脚手架步骤会收敛；
- 未登记的 `role: update` 槽是许可而非义务，不再索要任何动作；
- 评审门后的单条回退边与前进边一样先发起评审请求；
- 归档步骤先给出 `complete`（即 `archived` 流转），再给出带完整 `openspec archive` 命令的 `finish-change`；
- `build_sha` 由 Build 的出口流转写入，不再要求 runner 填写；
- 覆盖率门禁的修复提示与其解析器实际读取的内容一致。

### 负责人与已完结任务

- `tenon set`、`set-many` 与 `cas` 与其他写操作一样要求身份、拒绝非负责人，并拒绝已完结的任务。
- 完结就是流转 `tenon transition <change> archived`，它同时写入 `archived_at`；手动写 `archived` 或 `archived_at`
  会被拒绝。
- 已完结的任务仍可用 `tenon status` 查看，并在标记完结的那一刻就出现在 `tenon list --finished`，不必等目录移动。
- 被「归档」隐藏的任务与已完结的任务给出不同提示：前者指向 `tenon task unarchive`，后者说明任务已完结、需要新建任务。

### 安装与升级

- `tenon spec apply` 会为尚不存在的能力创建主规格目录。
- `tenon doctor` 把检查结论归属到当前使用的宿主，只有加 `--verify-release` 时才访问远端。
- 上游技能 lock 与 v0.1.0 的格式逐字节一致：v0.1.0 的校验器能读 v0.1.1 写出的 lock，反之亦然。技能能否被调用
  改为从其 `SKILL.md` 字节读取，不再经过 lock。
- 安装文档说明如何放宽 `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS`：Claude Code clone 插件市场的默认超时为 120 秒，
  clone 超时会让该宿主处于未装插件状态。

### 升级动作

从 v0.1.0 升级：运行 `tenon update --codex`（或 `--claude`），然后新开宿主会话。N-1 兼容门禁在两个方向上用已发布的
v0.1.0 读写本版本的数据。

从 1.x 迁移：为使用的每个宿主各运行一次版本化安装命令：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.1/install.sh | /bin/bash -s -- --codex
```

### 兼容性

- 进行中的任务：产出型强制技能在更早一次步骤访问中登记的文档，不再计入当前访问；`next` 会以 `record-document`
  （带技能名）要求重新登记。
- 以下强制技能仍以调用即算完成，因为在该步骤没有文档槽把它们点名为产出者：`openspec-explore`、`grilling`、
  `domain-modeling`、`codebase-design`（explore）；`brainstorming`（pm 的 spec）；`test-driven-development`、
  `frontend-design`、`prototype`（build）；`browser-qa`、`web-design-guidelines`、`design-taste-frontend`、
  `e2e-testing`（verify）；`finishing-a-development-branch`（ship）。把它们绑定到产物，需要在后续版本中对文档契约
  另行决策。

### 验证

```bash
tenon doctor
tenon runtime status
```

`skills:invocable` 为绿；两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.1。

## v0.1.0 · 2026-09-22

版本号从 0.1.0 重新开始。Tenon 还不成熟，1.x 这个号码宣称了它并不具备的稳定度。
本版同时交付 v1.1.5 之后完成的能力。

### 版本号重置

- 版本号从 0.1.0 重新开始，之后按 0.1.x / 0.x 递增。已发布的 v1.0.0–v1.0.9 与 v1.1.0–v1.1.5 的 Release
  与标签已经删除，这 16 个号码永不复用：release candidate 会直接拒绝它们。
- 安装顺序把已退役的 1.x 排在其他所有正式版本之下：0.1.0 相对 1.1.5 是升级，而更新的 0.x 不会被更旧的
  0.x 静默覆盖。`tenon update` 会写明自己正在离开的已退役版本，迁移不会静默发生。

### 升级动作

为使用的每个宿主各运行一次版本化安装命令，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --codex
```

在 1.x 上运行 `tenon update` 只会报告降级到 0.1.0，并且不做任何改动：那段拒绝逻辑属于已经发布的 1.x，
无法事后修补，所以上面的一行命令才是迁移路径；1.x 机器上的每日自动更新记录的也是同一条拒绝。
迁移完成后，`tenon update --codex`（或 `--claude`）重新成为常规升级入口。

### 一个仓库多个用户

- Tenon 依次从 `TENON_USER`、`<config>/user.json`、仓库自身配置的用户邮箱解析声明式身份，不需要登录；
  新写入的记录都带上执行者。
- 每个任务都有创建者与负责人，其他用户通过「接手」成为负责人；推进不属于自己的任务会被拒绝。
- 每个用户的状态存放在 `.tenon/users/<slug>/`，同一仓库里的两个人不再互相覆盖当前任务与授权状态。
  Dashboard 顶栏显示当前用户，工作区列表可按负责人筛选。

### 任务归档与删除

- 归档 / 取消归档 只对当前用户隐藏任务，随时可逆。
- 删除只动工作区、不自动提交，Dashboard 会在确认前说明这是「未提交删除」。
- 对应命令：`tenon task delete|archive|unarchive <name>` 与 `tenon list --archived`。

### 工作流即数据

- `openspec: true` 是工作流里唯一的 OpenSpec 开关。
- 每条轨道自己声明 `document_contract`：哪个步骤产出、更新或要求哪份文档。内核里固定的按阶段文档表已删除，
  全局默认工作流把这些表完整写出来。
- Dashboard 工作流页面可编辑每个步骤的输入、技能、执行者、输出、评审者与门禁（评审或自动）；工作流的步骤、
  轨道与门禁存在全局，不再绑定单个项目。

### 一个技能取代七个

- 单个 `tenon` 技能按 `tenon status <change> --json` 的 `step` 块驱动每一步，其中直接给出待执行的 agent
  与必需测试。
- `tenon spec apply` 把 delta spec 应用到主规格。

### 每步的执行者与评审者

- 步骤可声明执行者与评审者：`tenon agent next|prompt|record`。随包提供九个内建 agent（builder、researcher、
  architecture、frontend-quality、backend-quality、code-size、security、spec-consistency、e2e）。
- 评审结论由 Tenon 依据发现项与阻断级别计算，每次运行都留存证据；任务创建时冻结该任务的 agent 集合。
- agent 一律在宿主内运行（Claude Code 的 Agent 工具或 Codex 子 agent），Dashboard 从不调用模型。

### 每步的测试证据

- 步骤可声明测试的命令、输入与输出，统一通过 `tenon test run <change> <test-id>` 执行；必需测试记录缺失或
  过期时，流转门禁拒绝推进。
- 随包提供九个内建测试方向：unit、integration、e2e、playwright、typecheck、regression、benchmark、
  code-size、design-system。运行日志、trace 与截图按运行留存在当前用户的本地目录。

### 指令文件、模板与项目

- Tenon 依据 32 个内建模板块写项目级与用户级指令文件（AGENTS.md、CLAUDE.md、GEMINI.md）；文件在 Tenon 之外
  被改动时报告冲突，不覆盖。
- 库页面集中管理 agent、模板、资源目录与测试方向，内建条目只读、可复制后编辑；「新建项目」一个按钮完成新建或接入。

### 设计体系与资源目录

- 项目的设计体系写在 `DESIGN.md`，由 `tenon design` 与设计体系工作流产出；设计体系未就绪时，拒绝创建前端任务。
- 资源目录随包提供 163 条内建条目（`tenon resources`），供步骤声明可用的库与参考。

### 上游技能

- setup 与 update 按 `skills/sources.yaml` 安装 53 个上游技能到插件根目录；lock 文件记录每个技能的 commit、
  目录摘要与许可证，抓取失败不改变当前发行版。
- 因此安装后的 payload 增长到约 48 MB。以文件 stat 为键的摘要缓存把实测 hook 派发开销控制在相对 v1.1.5
  约 7 ms 以内。

### 兼容性

- v0.1.0 之前没有更早的 0.x 正式版本，因此本次发布显式跳过 N-1 兼容门禁，并且是可见的跳过：fixture 点名
  v0.1.0，工具以约定的退出码报告跳过。v0.1.1 起以 v0.1.0 为基线。
- 也因此，v0.1.0 没有验证过读取 1.x 创建的任务。迁移前请先完结或归档进行中的 1.x 任务，否则可能需要重建。

### 验证

```bash
tenon doctor
tenon runtime status
```

两个宿主的 inventory、active managed runtime 与 Dashboard 都报告 0.1.0；再次运行 `tenon update --codex`
会提示当前发行版已精确生效。

## v1.1.5 · 2026-09-15

在 v1.1.4 上继续同一个真实 Codex 任务时发现并修复的问题。

### 规格

- 中文 delta spec 不再拖到 Verify 才发现 OpenSpec strict validate 要求每条 requirement 含英文 `SHALL` 或 `MUST`。
  两种语言的 scaffold 提示与 `tenon-spec` 技能现在都写明这条规则；官方 CLI 可用时，技能在请求 spec 评审前先运行
  `openspec validate <change> --strict`。此前 Codex 任务用「必须」写 requirement，通过了 spec 评审，却在 Verify 被退回。

### 评审门

- 待确认评审时，未被识别为确认的回复会提示应当如何回复，与交互门一致。此前在 `verify-fail`，agent 给出的选项
  「修复」被门静默忽略。
- `tenon-verify` 要求 agent 在 `verify-fail` 暂停时写明回复「确认继续」。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.5/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.5/install.sh | /bin/bash -s -- --codex
```

## v1.1.4 · 2026-09-15

在 v1.1.3 上用 Codex 执行真实任务时发现并修复的问题。

### Codex 技能证据

- Codex 生成的两种 exec 程序写法中，完整读取 `SKILL.md` 都会被认作技能证据。此前 Tenon 只识别
  `const r = await tools.exec_command({...}); text(r);`，写成 `text(await tools.exec_command({...}));` 的读取
  不产生证据：之后第一次 `tenon document record` 必然报 `current StepVisit lacks exact host confirmation`，
  agent 只能重新读取技能。两种写法都必须完整转发恰好一个 awaited 调用的结果；`.output`、未 await、
  包裹转换和附加语句仍然拒绝。
- 该错误现在会说明恢复方法：在当前阶段重新调用产出技能（Claude Code 用 Skill 工具；Codex 用单独一条
  `cat` 读取其 `SKILL.md`，`max_output_tokens` 要足够容纳整个文件，被截断的读取不算证据），再重试登记。
  此前 Codex agent 两次用 1000–2000 token 的输出上限读取 20 KB 的 `tenon-explore` 技能，之后才猜到要调大。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.4/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.4/install.sh | /bin/bash -s -- --codex
```

## v1.1.3 · 2026-09-15

在慢速代理网络上为 Codex 安装 v1.1.2 时发现并修复的问题。

### 安装器

- 与 GitHub 的连接中断或变慢不再导致安装失败。稳定版本证明原本只执行一次 `git ls-remote` 与浅克隆
  `git fetch`，一次 `ETIMEDOUT` 或 TLS 重置（`SSL_ERROR_SYSCALL`）就会让 `install.sh` 失败。现在两个调用在
  传输失败时最多重试三次并短暂退避；标签或引用不存在时仍立即失败，每个结果的校验与之前完全相同。

### 交互门

- 用户确认解封待确认的交互后，会在对话中明确告知。此前在 Codex 中，先被拦截过的 agent 在用户回复「确认继续」
  后仍以为门禁未解，没有重试被拦截的操作就停下。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.3/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.3/install.sh | /bin/bash -s -- --codex
```

## v1.1.2 · 2026-09-15

在 v1.1.1 上继续用 Claude Code 与 Codex 执行真实任务时发现并修复的问题。

### 交互门

- 交互式技能（`brainstorming`、`grilling`、`grill-with-docs`、`prototype`、`huashu-design`）在每次进入阶段后只向用户
  确认一次。Codex 需要重新读取产出技能才能登记文档；对交互式产出技能，这次重读会再次锁住同一个问题，
  导致 Codex 中 explore 无法登记设计文档与 ADR。现在用户确认后会写入 `InteractionConfirmed` 历史行，
  在重新进入该阶段之前，门禁不再为同一技能加锁。
- 门禁提示会写明可解封的回复（「确认继续」「继续执行」或「同意继续」）。有待确认的问题时，未被识别为确认的
  回复会明确告知 agent，不再被静默忽略。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.2/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.2/install.sh | /bin/bash -s -- --codex
```

## v1.1.1 · 2026-09-15

在 Claude Code 与 Codex 中用已发布的 v1.1.0 真实执行任务时发现并修复的问题。

### 宿主兼容

- Claude Code 能重新加载插件。Claude Code 2.1 会自动加载标准 `hooks/hooks.json`，清单再次引用同一文件
  会被拒绝，导致 Tenon 的技能与 hook 全部不可用。Claude 清单不再声明 `hooks`。
- Claude Code 中可以登记文档。Claude Code 以 `tenon:<skill>` 报告插件技能，Skill 回执拒绝了这种名字，
  所有 `tenon document record` 都报 `current StepVisit lacks exact host confirmation`，default 工作流
  无法离开 `open`。
- Tenon 可以在 Codex 沙箱内运行。Codex 的 `workspace-write` 沙箱禁止执行 `/bin/ps`；状态锁改为只记录
  pid 的持有者，不再报 `withLock: current process start identity is unavailable`。
- 宿主报告 Tenon 插件加载失败时，`tenon doctor` 显示红灯。

### 工作流与 Dashboard

- Dashboard 新建的轨道可以完整执行。技能不再用只认识项目轨道注册表的 `tenon tracks show` 校验工作流
  分支轨道；轨道 id 未注册时，`tenon tracks show` 会说明分支轨道的查看方式。
- 已归档的运行不再显示进行中的阶段。
- 没有运行时产物的阶段返回空目录，不再在每次刷新时请求失败。

### 升级动作

为使用的每个宿主安装新版本，然后新开宿主会话：

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.1/install.sh | /bin/bash -s -- --codex
```

用 `claude plugin list`（Tenon 已启用且无错误）与 `tenon doctor` 验证。

## v1.1.0 · 2026-09-15

### 工作流编辑器与工作台

- Dashboard 收敛为两个视图：工作台（项目、Change、阶段轨、带运行状态的阶段技能流、输入/输出文件、
  运行时产物）与工作流编辑器。
- 工作流按用户全局存储，不再绑定项目。每个工作流包含自己的轨道分支；阶段可拖拽排序，门禁只有
  `review` 与 `auto`，并可声明退回到哪个阶段。技能在画布上编排：落在同一列为并行，落在右侧为串行。
- 运行时产物保留产出者、版本与血缘；文档与字段产出走同一提交路径。

### 评审决策与门禁安全

- 待决 review 可以在终端或工作台右栏批准。两端共用同一个确认应用，除入口渠道
  （`review_acknowledged_via`）外，canonical 状态、交互记录与 history 完全一致。
- 所有被拒绝的确认都不写入任何数据。Dashboard 请求携带 expected revision 与幂等 key；过期或冲突
  请求返回带稳定 code 的 409，意外错误返回不含内部细节的 500。`tenon review acknowledge` 对缺少复核
  请求、revision 冲突、幂等冲突、无效命令分别以 `2`、`3`、`4`、`1` 退出。
- 所有入口离开 review 阶段都必须具备精确 receipt 与匹配 binding。`tenon set/set-many/cas` 不能再修改
  `phase`；`tenon state import-legacy` 保留受 transition 控制的字段并报告被忽略的字段。
- 本地 HTTP transition 入口永远不能满足 loop human gate。review 待决期间，读取 Dashboard token 与调用
  本机 API 会被记录为脱敏的自审批观测，AFK 模式下同样记录。

### 安全

- `fast-uri` 升级到不含高危公告的版本。

### 升级动作

安装不可变的 `v1.1.0` 入口，或运行 `tenon update --codex`（或 `--claude`）。完成后新开宿主会话以加载
更新后的 Skills 与 hooks。`v1.0.9` 保持不可变，可用于回滚。

## v1.0.9 · 2026-09-02

### Dashboard 稳定性与 Pipeline 可见性

- 适配器安装的有限事件流会在完成后确定性关闭；malformed、传输不可用会明确报错，安装按钮
  不会永久停留在忙碌状态。切换项目时会解绑旧流，旧项目的迟到事件不会串到新项目。
- Definition catalog 的 SSE 在浏览器于初始加载期间离开时也会清理；慢速投影会串行化，避免
  revision 乱序到达或回退页面上已经看到的定义。
- Change 创建会等待 catalog 对账，并明确展示 loading、unavailable、empty 状态。创建前会预览
  选定 Pipeline 的每个 Stage、串行/并行模式、Skill 顺序和声明的依赖关系。
- 适配器请求的布尔字段现在严格校验类型，不再把字符串隐式当作值，保证 dry-run 与确认语义
  对 API 客户端保持明确。

### 兼容性与范围

- 已有 Change 继续使用冻结的 Workflow/Track/Pipeline 身份；GUI 当前展示由 Workflow/Track 派生的
  canonical Pipeline。独立命名的 Pipeline blueprint 仍通过 planner-v2 使用，待持久化 Pipeline
  Registry 契约落地后再进入编辑器。

### 升级动作

安装不可变的 `v1.0.9` 入口，日常更新继续运行 `tenon update --codex`（或 `--claude`）。之前的
`v1.0.8` 发布保持不可变，可作为回滚版本。

## v1.0.8 · 2026-09-02

### 编排输入与 Pipeline Runtime

- Skill 依赖会在执行前物化为版本化的 `skill-input-manifest/v2` 和受限输入包；Executor
  与 Validator 接收同一个经过摘要校验的输入。输入投递被拒绝时会 fail-closed，绝不会调用 Skill。
- Skill 的规范化产物会原子写入 `.tenon-artifacts/`，并登记 `artifact://` 引用、Schema、字节数
  和 SHA-256 摘要；下游 Skill 通过 Manifest 契约读取，而不是依赖模型自行寻找文件。
- 自定义 Workflow、Track、Pipeline、Stage 和 Skill 依赖遵守声明的串行/并行模式及资源声明；
  重叠的写入资源不会并发执行。

### 安全与依赖维护

- Browserslist 通过仓库 override 和锁文件固定到首个修复版本 `4.28.7`，消除高危公告，未放宽审计门禁。

### 升级动作

安装不可变的 `v1.0.8` 入口，日常更新继续运行 `tenon update --codex`（或 `--claude`）。已存在的
Change 会继续使用冻结的 Workflow/Track/Pipeline，只有显式 replan 才会切换定义。

## v1.0.7 · 2026-08-11

### 跨版本 installer bridge 恢复

- 公开 installer 只有在旧稳定版本的 durable WAL 已精确到达宿主阶段 `plugin-installed`，并且当前插件与 Marketplace 仍逐项匹配旧版本的 plugin version、稳定 tag、commit、官方 source/type/origin、ref 与 clean checkout 时，才会接管它。
- 任何其他 phase、malformed/unknown 数据、同版但 tag/commit 不等于当前已证明 target 的 WAL、更高目标版本，或任意宿主 inventory drift，都会在 host mutation 前 fail-closed，并保留原 WAL 供诊断或恢复；精确匹配当前 target 的同版 WAL 仍沿用既有恢复路径。
- 旧事务会被原子替换为 current-target 事务，并以已验证的宿主状态作为 before 快照；现有 exact provenance、trusted host、锁、原子性与 packaged setup 校验保持不变。不增加 retry/fallback，也不弱化 stable Release/object proof。

### 升级动作

当前公开入口使用不可变 `v1.0.7`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.6 · 2026-08-11

### Stable Git proof 网络预算

- 慢链路实测显示公开 stable tag/object proof 可能超过此前 30 秒 Git 预算：proxy `ls-remote`/fetch 为 6.9 秒/11.3 秒，直连 fetch 达到 22.9 秒，而正式事务中仍偶发更长阶段。
- Git 远端 `ls-remote` 与 fetch 现在采用有界 60 秒预算；GitHub Release API metadata 和 npm bootstrap raw installer 下载仍为 30 秒；本地 init/rev-parse/cat-file proof 仍为 10 秒，宿主 observation 默认仍为 5 秒。
- exact stable tag/object/commit、digest、trusted executable、官方 HTTPS host、大小限制与原子性校验保持不变；不重试、不使用 source/branch/cache fallback，失败继续在 mutation 前 fail-closed。

### 升级动作

当前公开入口使用不可变 `v1.0.6`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.5 · 2026-08-11

### Doctor 发布身份证明

- `tenon doctor` 的发布身份探针现在会传递远端 Git tag/object proof 的有界 30 秒预算，以及本地证明命令的 10 秒预算。
- 宿主 observation 命令仍保留默认 5 秒超时；不增加 retry、不使用 source/branch/cache fallback，也不弱化 trusted-executable 或其他安全校验。

### 升级动作

当前公开入口使用不可变 `v1.0.5`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.4 · 2026-08-11

### 公开安装与更新网络预算

- shell installer 的 GitHub Release metadata/tag proof、`tenon update` 的 Release metadata 请求，以及 npm bootstrap 的 installer 下载，统一采用有界 30 秒网络预算。
- exact stable Release、tag/object、digest、host trust、官方 HTTPS host、大小限制与原子性校验保持不变。
- 仍然不重试、不使用 source/branch/cache fallback；失败继续在 mutation 前 fail-closed。

### 升级动作

当前公开入口使用不可变 `v1.0.4`；日常升级仍运行 `tenon update --codex`（或 `--claude`）。

## v1.0.3 · 2026-08-11

### Stable Release 证明诊断

- 远端 tag/object proof 的网络预算从 10 秒提升为有界 30 秒；本地证明命令仍保持 10 秒预算。
- timeout 失败现在保留 `ETIMEDOUT` 等可诊断的 stderr 信息，不再返回空错误详情。
- 安全验证、原子发布以及无 retry、无 fallback 语义保持不变。

### 升级动作

日常升级仍使用 `tenon update --codex`（或 `--claude`），并继续绑定经过验证的稳定 Release tag。

## v1.0.2 · 2026-08-08

### 版本化安装与更新

- 公开一键安装固定使用不可变 `v1.0.2` 预构建资产，不从 `main` 安装，也不编译源码。
- `tenon update --codex` 解析官方最新稳定 GitHub Release，冻结 tag 与 commit，再通过宿主官方命令重绑定 Codex Marketplace。
- 宿主、managed runtime 与 Dashboard 精确同版时零 mutation；降级或无法验证 Release 身份时在 mutation 前失败。
- setup 始终等待 Dashboard readiness；curl/CI 安装和所有更新不自动打开浏览器，并打印已验证 URL 与 `tenon dashboard --open`。

### 升级动作

v1.0.1 用户先一次性运行不可变的 `v1.0.2/install.sh` 一行命令；旧 launcher 无法在一次旧 updater
调用中安全自重绑新 tag。从 v1.0.2 起，每次只运行一条 `tenon update --codex`。新开 Codex 会话
加载已发布 Skills/hooks 后，运行 `tenon doctor --json`。

## v1.0.1 · 2026-07-26

### 正常对话入口契约

- `product/identity.json` 新增 `entrySkill: "tenon"`，它是唯一公开入口。
- Codex 正常对话统一调用 `tenon:tenon`，不保留第二入口别名。
- 根 `AGENTS.md` 与 Codex 静态 adapter 消费同一份生成 managed block。
- `tenon doctor` 会验证入口 Skill，并把仍启用的冲突工作流插件报告为红灯。
- `tenon setup --codex -y` 会先通过 Codex 官方插件管理器移除该精确旧登记，再激活 Tenon。

### 仓库与发布卫生

- CI 与 Release 对所有受版本控制路径和文本执行外部参考项目身份扫描。
- 扫描不区分大小写、没有豁免，诊断信息也不会回显受限名称。
- Release payload 构建前执行同一门禁，避免源码干净但发行包污染。

### 升级动作

运行 `tenon update --codex`，随后运行 `tenon setup --codex --auto-update -y`。新开 Codex 会话后执行
`tenon doctor --json`。

## v1.0.0 · 2026-07-26

### 中文治理文档

- 新 Change 的治理文档默认固定为 `zh-CN`。
- `tenon init`、`tenon document scaffold` 与 default OpenSpec fallback 使用同一 Document Presentation Registry。
- 用户可以在创建时显式选择 `--document-locale en`。
- 已固定 locale 的 Change 不允许在中途静默切换语言。
- 历史 Change 会从现有 H1 文字信号推断语言。
- 语言信号混合或不足时命令失败并要求显式选择，不会猜测覆盖。

### 执行模式

- Discussion 用于不需要状态机的普通问答。
- Simple 使用 `change → verify → done`，不生成完整 OpenSpec 文档链。
- Default 使用 `open → explore → spec ⇄ build ⇄ verify → ship → archive`。
- Free 显式绑定 workflow，不叠加 PM、前端或后端 Track。
- Custom 完全遵守自身声明的 DAG、Skill、gate 与 document contract。

### 文档站

- 仓库首页 README 默认中文，并提供 `README.en.md`。
- 文档站提供中文根路由与 `/en/` 英文镜像。
- 本地搜索基于公开 content manifest 构建。
- GitHub Pages 只从 `main` 分支部署。
- Pull Request 只构建和检查，不执行生产部署。
- 发布 artifact 经过闭集 allowlist、敏感信息扫描和 project base 检查。
- `llms.txt` 只索引公开页面。
- 内部 ADR、Superpowers 计划、review receipt 与本地控制面状态不会进入公开站点。

### 安装与更新

- Codex 使用 `tenon setup --codex`。
- Claude 使用 `tenon setup --claude`。
- 更新使用对应宿主的 `tenon update --codex` 或 `tenon update --claude`。
- 托管 runtime 以内容摘要发布，稳定 launcher 指向已验证版本。
- 更新失败时保留上一版，可用 `tenon runtime repair --rollback` 恢复。
- Dashboard 默认监听 `127.0.0.1:18765`。

## 升级动作

1. 在现有仓库确认工作区状态。
2. 运行对应宿主的 `tenon update` 命令。
3. 运行 `tenon runtime status` 查看活动版本。
4. 运行 `tenon doctor` 检查安装、Skill 与宿主适配。
5. 在项目中运行 `tenon list --json` 验证 CLI 可读状态。
6. 打开 Dashboard 时确认地址为 `127.0.0.1:18765`。

## 验证

- `tenon --help` 能显示命令族。
- `tenon runtime status` 能显示活动 runtime。
- `tenon doctor` 不报告缺失的内建 Skill。
- `tenon setup --codex` 重复运行保持幂等。
- `tenon update --codex` 不修改项目的 canonical Change 状态。
- 新建测试 Change 时 proposal、design 与 tasks 默认中文。
- 显式英文 Change 的新文档保持英文。

## 兼容性

canonical Change codec 不因文档 locale 增加新字段。

locale 固定信息保存在 `.pipeline-document-locale.json` sidecar，因此旧版 runtime 仍可读取 canonical state。

发行资产继续包含 default、simple、free 与 custom workflow 所需的模板和 Skill。

## 已知边界

GitHub Pages 的真实公开 URL 只有在 `main` workflow 成功部署后才能确认。

本地预览通过不等于远程部署成功；应以 Actions 的 deploy job 和 Pages environment 为准。

Dashboard 的界面语言与治理文档 locale 是两个独立边界，不互相覆盖。

## 回滚

如果升级后的 runtime 无法启动，先运行 `tenon runtime status` 收集版本信息。

随后运行 `tenon runtime repair --rollback` 切回上一份已验证内容摘要。

回滚 runtime 不会删除项目中的 Change、OpenSpec 文档或证据账本。

## 版本记录规范

未来发布必须在本页增加中文条目，并同步英文镜像。

条目必须对应真实提交、构建和验证证据。

未验证的规划只能写入 roadmap，不得提前进入发布说明。

每次发布还应检查安装命令、更新命令、Dashboard 端口和 Pages 路径是否与源码真相一致。

## 下一步

继续阅读[更新、恢复与卸载](./updates-recovery-and-uninstall.md)，了解完整的运行时维护与恢复流程。
