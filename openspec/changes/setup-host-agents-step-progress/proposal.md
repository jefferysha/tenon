# 提案

## Why

**子代理在会话中途生成，当前会话用不上。** 2026-10-07 会话 `4f9542da` 中：17:29:05 `tenon init unify-stage-skill-canvas`
写出 `.claude/agents/tenon-{builder,code-size,researcher,spec-consistency}.md`（`packages/cli/src/commands/init.ts:47`）；
17:31:16 `tenon agent prompt … researcher --host claude` 看到文件已在磁盘，返回 `subagent_type: tenon-researcher`。
Claude Code 只在会话启动时加载 `.claude/agents/`，派发报 `Agent type 'tenon-researcher' not found`，可用列表里没有任何
`tenon-*`。主线按 skill 的兜底改用 `general-purpose` 重跑，台账从 `native: true` 改记成 `native: false`，该 agent 的
`tools` 白名单与 `model: sonnet` 都没生效。`tenon agent prompt` 自己也会重新生成这些文件（`agent.ts` 的 `prepare`），
所以凡是在会话里建的第一个任务，都会先撞一次这个错。

另一款终端一次性安装式的开发工具不会遇到：它的初始化命令在终端一次性执行项目安装，写好固定的子代理与 hook；会话里建任务从不写
子代理文件，任务相关的上下文在派发时由 PreToolUse hook（`.claude/hooks/inject-subagent-context.py`）注入。

**终端看不到步骤进度。** `skills/tenon/SKILL.md` 第 5 步要求「用 `tenon workflow plan` 的步骤标签建 Todo」，但本机
Claude Code 2.1.292 的会话没有 Todo 工具（TodoWrite / TaskCreate 都不在工具列表里），本项目自 2026-09-08 以来 16 个会话
一次都没调用过；这条要求一直静默失效，也没有任何检查。上述开发工具的进度由代码保证（statusline + 每轮 hook 注入），不依赖模型。
Tenon 自带的 `hooks/statusline.sh` 没有接入（Claude Code 只允许一个 statusLine，项目级已被上述开发工具、用户级已被 claude-hud
占用），而且只显示当前相位，不显示步骤清单。

**同仓并行的任务互相污染。**（2026-10-10 规格第二轮由用户并入）本任务 10-07 在 main 上原地建立，起点按 `created_at` 推算为
`4967108`。之后 main 合入了 8 个提交（PR #80 等），进入实现步时 `next` 把 93 个测试文件判为「本任务新增或修改、未登记」，
`.tenon/tests/catalog.yaml` 的改动也要本任务评审批准——它们全部来自别的任务。原因：起点在建任务时不记录，原地开发时 base 分支
就是 HEAD 所在分支，`computeStart`（`packages/kernel/src/workspace/changed-files.ts:211-228`）总是退回按时间取起点，之后进入 HEAD
的提交都算本任务的。同时 `isolation=worktree` 只是一个可选值：没有任何代码为任务建 worktree，任务状态未提交前只存在于建它的检出里，
`worktree` 的构建版本又绑 git HEAD，而实现到交付步才提交，所以这个选项实际不可用。PR #80 的会话隔离只让不同会话在同一检出里互不
串单，没有解决代码与证据层面的并行。

**退回规格要先启动执行者。** 在实现步开头走 `requirements-changed` 时，退回边要求本步技能 `test-driven-development` 已加载，而该技能
归执行者 `builder`，只能在 agent 运行期间加载。主线只能先 `tenon agent prompt … builder` 开始一次不会执行的运行，台账还把它记成
`subagent: tenon-builder`（实际没有派发）。

**子代理装到了宿主不读的目录。**（2026-10-11 验证步真机验收发现，规格第四轮并入）本机 Claude Code 由启动环境设了
`CLAUDE_CONFIG_DIR=/Users/a1234/.antigravity_cockpit/instances/claude/cli-d541ae322828`，宿主只从 `$CLAUDE_CONFIG_DIR/agents`
读用户级子代理：新会话能列出只在那里的 `impeccable-*`，却看不到 `tenon agent install` 写进 `~/.claude/agents` 的 `tenon-*`。
Tenon 的安装路径写死为 `~/.claude/agents`（`host-agent-install.ts` 的 `userHostAgentPath`），`tenon agent prompt` 也按同一路径
判定「已安装」，于是返回 `tenon-researcher`，派发报 `Agent type 'tenon-researcher' not found`。Codex 同理：Tenon 写 `~/.codex/agents`，
不看 `CODEX_HOME`（Tenon 写用户级 `AGENTS.md` 时已经认这个变量）。

## What Changes

（调研步已由用户拍板，细节见 `docs/superpowers/specs/setup-host-agents-step-progress-design.md` 与
`docs/adr/setup-host-agents-step-progress.md`。）

- **子代理文件改为终端安装、写用户级**：新增 `tenon agent install [--host claude|codex]`，把 agent 库官方层与自定义层中适用于该宿主的
  全部 agent 写到宿主的用户级子代理目录（`<Claude 配置目录>/agents/tenon-<name>.md` / `<Codex 配置目录>/agents/tenon-<name>.toml`），
  用新的用户级所有权清单 `<configRoot>/agents/host-owned.json` 只动 Tenon 写的未改动文件；`tenon setup` / `tenon update` 成功后也执行它（`update`
  已是最新版时同样执行）；对称的 `tenon agent uninstall [--host]` 清除这些文件。
  `tenon agent add/new/copy/rm` 不写宿主文件，只提示执行安装命令并开新会话。
- **用户级目录跟随宿主配置目录**：Claude 配置目录取 `CLAUDE_CONFIG_DIR`（绝对路径时），否则 `~/.claude`；Codex 取 `CODEX_HOME`
  （绝对路径时），否则 `~/.codex`。安装、卸载与 `tenon agent prompt` 的判定按各自进程环境用同一解析；所有权按目标目录分别记录，
  在一个目录上安装或卸载不碰另一个目录里的文件；`prompt` 退回通用子代理时，提示里给出它检查的目录。
- **会话内不写、派发前如实判定**：`tenon init` 与 `tenon agent prompt` 不再写任何宿主文件。`tenon agent prompt` 只在用户级文件与
  本任务冻结的定义逐字一致、且项目里没有内容不同的同名文件遮住时返回 `tenon-<name>`；否则返回通用子代理（Claude `general-purpose`、
  Codex `default`），台账 `subagent` 记 `native: false` 与原因（`not-installed` / `definition-mismatch` / `shadowed` /
  `project-agent`），并给出安装提示。项目层 agent 一律走通用子代理。
- **清理旧项目级文件**：`tenon init` 与归档/删除任务时（CLI 与 Dashboard 服务端），删除项目里由 Tenon 写入且未改动的
  `tenon-*` 宿主文件（按所有权清单或与当前渲染内容一致判定），不再按在途任务引用区分。
- **终端显示步骤清单**：新增 `tenon workflow progress <change>`（一行 ✓/●/○ 清单）与 PostToolUse hook `step-progress`，在
  `tenon init` / `tenon session activate` / `tenon transition` / `tenon step run` 成功后用 `systemMessage` 打印；Claude 与 Codex
  共用同一份 `hooks/hooks.json`。
- **skill 与文档**：第 5 步改为「宿主有 Todo 工具才建」；`run-agent` 行改为照用返回的类型与原因；更新 `docs/usage/agents.md`
  中英文版。
- **任务起点记录并跟随上游**：`tenon init` 记下建任务时的 HEAD（新字段 `start_sha`，追加在字段表末尾）。起点取以下候选中最新的
  一个：`start_sha`、`merge-base(HEAD, <base> 的上游跟踪分支)`、`merge-base(HEAD, <base>)`（不等于 HEAD 时）；分不出先后时取它们的
  共同祖先，宁可多算不漏算；都没有时才退回现有的按时间推算。从上游拉进来的提交、建任务前已有的提交不再算本任务的改动；本地尚未推送的
  他人提交仍会算进来（无法判断归属）。同一份起点供测试登记、受保护测试配置审批、测试完整性、改动风险探针、评审者挂载、覆盖率与
  `tenon verify --ci` 使用。
- **每个新任务建在自己的 worktree**：`tenon init` 在主检出里执行时，为新任务建 `.worktrees/<change>`（分支 `tenon/<change>`，
  从当前 HEAD 分出），任务状态、文档、实现、提交从立项到归档都在里面；`base_branch` 记分出它的分支，`isolation` 预设为 `worktree`。
  建好后执行测试目录里声明的工作区准备命令（本仓 `npm ci`，受测试目录信任约束），并把主检出里本用户已信任的命令摘要带进新 worktree。
  工作流与 track 按主检出解析后冻结进任务，主检出的工作区不因建任务而变化。Claude Code 用 `EnterWorktree` 的 `path` 把当前会话切进去
  继续；Codex 在该目录开新会话。不是 git 仓、还没有提交、处于分离 HEAD、本身已在 linked worktree，或显式 `--in-place`
  时原地建立并提示原因；环境变量 `TENON_INIT_IN_PLACE=1`（测试工装用）同样原地建立但不提示；Dashboard 建任务仍原地（同样记录 `start_sha`）。主检出里说「继续 <change>」
  时，路由能找到建在 `.worktrees/` 下的任务并给出路径，但这些任务不影响主检出「新建还是选择」的判定；`tenon list` 与
  `tenon workflow progress` 一并能找到。
- **worktree 任务的构建版本绑工作区指纹**：`isolation=worktree` 与 `in-place` 一样用工作区内容指纹作为 `build_sha`，身份里仍带该
  worktree，换一个检出验证会被拒；`branch` 不变。同步修改 `docs/CONTRACT.md` 的对应条文。
- **宿主的子代理与会话检出不计入工作区指纹**：完整工作区指纹（构建版本与评审候选都绑它）与可移植指纹一样，不再计入未被 git 跟踪的
  `.claude/worktrees/`。起因是本任务验证第 1 轮：同仓库另一个 Claude Code 会话及其子代理一直在 `.claude/worktrees/` 下改文件，主检出里
  本任务的构建版本因此过期，评审结论也随之失效；该目录约 42 万个文件，还让每次算指纹要十几秒、一条 `tenon status` 要一到十几分钟。
  被 git 跟踪的文件照算。
- **退回边不再要求执行者的技能**：离开步骤的退回边（如 `requirements-changed`）不再要求本步里归属执行者或评审者的技能（这些技能只能
  在 agent 运行期间加载）；主线技能仍按原规则要求。`tenon agent record --subagent none` 把没有派发的运行如实记为
  `native: false`、`reason: not-dispatched`。

**非目标**：不改任何 statusLine 配置；不做上述开发工具那种「派发时由 hook 注入任务上下文」；不改 agent 库三层存储与冻结机制；
不为项目层 agent 生成任何宿主文件；不改 Claude Code 的 Todo 工具行为（原因已查明：2.1.268 起较新模型默认不提供，用户级 settings
已另行打开 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`，不属于本仓改动）；不修复调研中顺带发现的 `test-nudge.sh` / `interactive-skill-gate.sh`
顶层 `additionalContext` 问题（另立任务）。不把已在主检出里的在途任务（含本任务）迁进 worktree；不做 Dashboard 跨 worktree 的统一视图
（每个 worktree 仍登记为一个项目）；不自动删除已归档任务的 worktree（只提示命令）；`isolation=branch` 的语义不变；不改 AFK 自动化
自己的 worktree 机制。

**可验证结果**：
- 执行 `tenon agent install --host claude` 后开新会话，在会话里新建任务并派发 `tenon-researcher` 成功，不出现 not found；
  会话中途 `.claude/agents/` 与 `~/.claude/agents/` 都不被 Tenon 改动。
- 未安装、定义不一致、被遮住或项目层 agent 时，`tenon agent prompt --json` 直接给出通用子代理、原因与安装提示，台账 `native: false`。
- 设了 `CLAUDE_CONFIG_DIR` 的环境里执行 `tenon agent install --host claude`，文件写进 `$CLAUDE_CONFIG_DIR/agents`，同一环境启动的
  新会话能派发 `tenon-researcher`；会话环境与安装位置不一致时，`prompt` 退回通用子代理并给出它检查的目录。
- 执行 `tenon transition` 后，终端出现与 `tenon workflow plan` 顺序一致的一行步骤清单。
- 在 main 上原地开发的任务，`git pull` 拉进上游提交后，这些提交不再出现在本任务的改动文件、受保护配置审批与改动风险里；本任务自己的
  未提交改动与本地提交仍在。
- 在主检出的会话里新建任务，任务落在 `.worktrees/<change>`，会话切进去后能走完整个工作流；同时在另一个 worktree 推进的任务，
  其改动不出现在本任务的证据里；在主检出说「继续 <change>」能找到它。
- 在实现步开头走 `requirements-changed` 不需要先启动 builder。

## Capabilities

### New Capabilities

- `host-native-subagents`：宿主原生子代理文件的安装时机与位置（跟随宿主配置目录）、与冻结定义的一致性判定、缺失或不一致时的退回与提示，
  以及未派发运行的如实登记。
- `change-start-point`：任务起点的记录与解析，以及所有按起点比对改动的地方共用这一份起点。
- `task-worktree-isolation`：新任务建在自己的 worktree、工作区准备、信任继承、会话切换、从主检出恢复与列出、worktree 任务的构建版本、
  宿主为子代理与会话建的检出不计入工作区指纹。

### Modified Capabilities

- `effective-workflow-plan`：新增一条要求——终端步骤清单由 hook 按 effective plan 打印，不依赖宿主的 Todo 工具。
- `workflow-skill-enforcement`：「Hook and transitions SHALL reject a missing current-visit phase Skill」改为退回边不要求归属
  执行者或评审者的技能。

## Impact

- **代码**：`packages/cli/src/commands/{init,agent,agent-host,agent-library,agent-new,setupHost,update,transition,task-lifecycle}.ts`、
  新建 `commands/{agent-install,workflow-progress}.ts`，`program*.ts` 注册；Dashboard 服务端
  `packages/server/src/{transition,serverTaskLifecycleRoutes,hostAgentPrune}.ts`；kernel
  `infrastructure/{host-agent-files,host-agent-prune}.ts`、`agents/host-native.ts`、`index.ts` 导出，新建
  `infrastructure/{host-agent-install,host-subagent-resolve}.ts`、`workflow/{step-progress,agent-owned-skills}.ts`、
  `workspace/{task-worktree,task-worktree-list}.ts`；
  `packages/cli/src/{localExcludes,gitWorkspace}.ts` 中宿主文件相关的调用（排除规则保留）。
- **hook**：`hooks/hooks.json` 新增 PostToolUse 注册与 `hooks/step-progress.sh`（经 `tenon-hook` 分发，需通过
  `release-payload.ts` 的打包校验）。
- **skill**：`skills/tenon/SKILL.md` 第 5 步与 `run-agent` 行。
- **文档**：`docs/usage/agents.md`、`docs/usage/zh-CN/agents.md`。
- **测试**：kernel `host-native.test.ts`、`host-agent-files.test.ts`、`host-agent-prune.test.ts`；cli
  `agent-host.integration.test.ts`、`task-host-agents.integration.test.ts`、`next-action-runner.integration.test.ts`；server
  `hostAgentPrune.test.ts`、`serverTaskLifecycleRoutes.test.ts`，按新行为改写；新增用户级安装、`workflow progress`、`step-progress`
  hook 的测试。
- **任务起点**：kernel `workspace/changed-files.ts`（`computeStart` 与 `changeStartOfFields`）、`state/state-init.ts` 与
  `types.ts`（`start_sha` 追加在 `FIELD_ORDER` 末尾）、`state/store.ts`（init 时取 HEAD）；所有调用方经同一入口取起点，签名不变；
  `changed-files.test.ts` 新增场景（第 65-76 行「建任务后在 base 上的提交算本任务」在没有 `start_sha` 与上游时行为不变）。
- **worktree**：cli `commands/init.ts`（建 worktree、在其中初始化、准备命令、信任继承、输出路径）、新 kernel 模块
  `workspace/task-worktree.ts`；kernel `state/state-init.ts`（`base_branch` 记来源分支、`isolation` 预设）；测试目录 schema 新增可选
  `setup` 命令（纳入目录信任摘要）与本仓 `.tenon/tests/catalog.yaml` 配置；`hooks/router.sh`、`commands/status.ts` 的 `cmdList` 列出
  worktree 任务；`skills/tenon/SKILL.md`「进入」一节（切进 worktree、Codex 开新会话、不再写「不要自己建 worktree」）；`main.ts` 的
  `captureBuildRevision` 与 `commands/buildRevisionAssessor.ts`（worktree 用工作区指纹）；`docs/CONTRACT.md` 与使用文档中英文版。
- **工作区指纹**：kernel `workspace/fingerprint.ts`（完整指纹也跳过未被 git 跟踪的 `.claude/worktrees/`，一次遍历不再进入该目录）、
  `workspace/host-local.ts` 的说明；`fingerprint` 相关单测与 bundle 的 N-1 指纹一致性检查。
- **退回边**：kernel `workflow/step-exit-report.ts` 与 `transition-step-gates.ts`（退回边跳过归属 agent 的技能），CLI 与 HTTP
  transition 共用；`program-agents.ts` / agent record（`--subagent none`）。
- **用户级目录解析**：kernel `infrastructure/host-agent-install.ts`（目标目录解析、按目录分组的所有权清单）与
  `infrastructure/host-subagent-resolve.ts`（同一解析、返回所检查的目录）；cli `commands/agent-install.ts`、`setupHost.ts`、`update.ts`、
  `agent.ts`（传入进程环境、提示里给出目录）；对应单测与集成测试（只用临时目录与注入的环境变量）；`docs/usage/agents.md` 中英文版。
- **兼容**：已有项目里旧逻辑生成的 `.claude/agents/tenon-*.md` 与 `.pipeline-owned.json` 条目由清理路径处理；用户升级后需要在终端
  执行一次 `tenon update`（或 `tenon agent install`）并开新会话，专属子代理才生效；设了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 的用户
  要在带着同样变量的环境里执行（例如在会话里用 `!` 前缀执行）。Tenon 首次写用户级子代理目录。没有 `start_sha` 的旧任务按「上游 merge-base 或按时间推算」取起点，有上游时同样不再带入拉进来的提交；
  旧任务一律留在原检出。新任务默认进 worktree 后，项目需要在测试目录里声明准备命令，否则新 worktree 里没有依赖、测试跑不起来
  （Tenon 会提示）。新任务的 `start_sha` 存在按 revision 绑定的伴随文件、台账的 `reason` 存在运行旁注，升级前发布的 Tenon 运行时
  仍读得了这些任务（v0.3.1 续写之后当前版本读到的 `start_sha` 为空，退回上游候选）。完整指纹不再计入未跟踪的 `.claude/worktrees/` 后，
  在有这个目录的机器上，0.3.0 写下的测试记录升级后、当前版本记下的评审结论与构建版本回滚到 v0.3.1 后，都会被判为过期、需要重跑，
  不会判为损坏。
  原地任务把自己的提交推到 base 分支的上游后，这些提交不再算本任务的（已知限制，worktree 任务不受影响）。
  现有测试在临时 git 仓里执行 init 的，统一由测试环境导出 `TENON_INIT_IN_PLACE=1`。
