# 技术设计：子代理文件改为终端安装、终端打印步骤清单、同仓任务并行隔离

## 背景

**子代理在会话中途写入不可用。** `tenon init` 与 `tenon agent prompt` 在会话里写 `.claude/agents/tenon-<name>.md`
（`packages/cli/src/commands/init.ts:47`、`agent.ts:86-87` → `agent-host.ts` → kernel `host-agent-files.ts`）。
Claude Code 2.1.292 的实测：

- 会话 `4f9542da`：同一回合内 `tenon init` 写文件，约 2 分钟后派发 `tenon-researcher`，报 `Agent type ... not found`。
- 会话 `be80e77d`：写入一个探针子代理 `zz-probe-agent.md` 后，同一回合 6 秒、下一回合 15 秒、再下一回合约 2 分钟、再之后数分钟，
  四次派发全部 not found；而另一批由 `tenon agent prompt` 写入的文件在约 10 分钟后的某个回合开头才通过 `agent_listing_delta`
  出现。
- 官方文档（code.claude.com/docs/en/sub-agents）说会监听 `.claude/agents/` 并「within a few seconds」生效，与实测不符。

结论：只有会话启动前就存在的子代理文件是可靠的；会话中途写入什么时候生效不可预期。
另一款终端一次性安装式的开发工具做法与此一致：在终端执行一次初始化命令写好固定子代理，任务上下文在派发时注入。

**终端看不到步骤进度。** skill 要求模型用 `tenon workflow plan` 建 Todo，但 Claude Code 2.1.268 起 Sonnet 5、Opus 4.8
及更新的模型默认不提供 Todo 工具（CHANGELOG 2.1.268；`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 才有）。进度展示只靠模型自觉，
会静默失效。Tenon 自带的 `hooks/statusline.sh` 没有接入，且只显示当前相位。

调研报告：`openspec/changes/setup-host-agents-step-progress/.pipeline-agent-reports/10167049-5af1-4624-bd94-53b2548a9153.md`。

**同仓并行的任务互相污染**（规格第二轮由用户并入）。本任务原地建在 main，起点按 `created_at` 推算为 `4967108`；之后合入
main 的 8 个提交让实现步把 93 个测试文件和 `catalog.yaml` 的改动算成本任务的。起点不落盘（`changed-files.ts:211-228`），
`base_branch` 是建任务时 HEAD 所在分支，原地开发时 merge-base 等于 HEAD，于是总按时间推算。`isolation=worktree` 只是一个可选值：
没有代码建 worktree，任务状态只在建它的检出里，构建版本又绑 git HEAD。另外，退回边的技能门不分方向，实现步的 TDD 技能归
`builder`，想退回规格必须先开始一次 builder 运行。

## 决策

用户在调研步拍板三项：子代理文件由终端安装命令写用户级；skill 建 Todo 改为可选（并已在用户级 settings 打开
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`）；关键命令后打印一行步骤清单。规格第二轮又拍板四项：所有新任务一律建在 worktree；原地任务的
起点「记录 + 跟随上游」；worktree 任务的构建版本改绑工作区指纹；退回边技能门与未派发运行的登记一起修。具体设计如下。

### 1. 安装：`tenon agent install`

- 新子命令 `tenon agent install [--host claude|codex]`，只在终端执行有意义。渲染 agent 库**官方层与自定义层**中适用于该宿主的
  全部 agent（按定义的 `hosts` 过滤），写到宿主的用户级子代理目录：Claude `<Claude 配置目录>/agents/tenon-<name>.md`，Codex
  `<Codex 配置目录>/agents/tenon-<name>.toml`。渲染沿用 `renderHostAgent`。
- 目录解析（规格第四轮）：kernel 导出 `hostAgentsDir(host, { homeDir, env, platform })`——Claude 取 `env.CLAUDE_CONFIG_DIR`、Codex 取
  `env.CODEX_HOME`，值经 `absoluteDirectory`（`instructions/hosts.ts` 里 `userInstructionPath` 已用的判定：去掉首尾空白，必须是绝对路径，
  去掉末尾分隔符）通过才采用，否则 `<homeDir>/.claude`、`<homeDir>/.codex`；再接 `agents`。`installHostAgents`、`uninstallHostAgents`、
  `resolveHostSubagent` 都改为接收这个目录（不再自己从 home 拼），CLI 的 `agent install/uninstall` 与 `agent prompt` 用 `process.env`
  调它（经 `agentPaths()` 注入，测试桩不传就是空环境）；`setup` / `update` 经子进程执行 `agent install`，子进程继承调用者的环境。起因：本机 Claude 由启动环境设了 `CLAUDE_CONFIG_DIR`，宿主只读 `$CLAUDE_CONFIG_DIR/agents`，装在
  `~/.claude/agents` 的文件新会话看不到，而 `prompt` 按同一个写死的路径判定为已安装（验证步真机验收）。库只读官方层与自定义层（不传项目根），所以在哪个项目目录执行
  结果都一样，项目层同名覆盖既不会让官方 agent 被跳过，也不会触发「库里已没有就删除」。
- `tenon setup --<host>` 与 `tenon update --<host>` 成功后调用同一逻辑（`update` 在已是最新版时也执行，安装是幂等的），
  输出写了哪些文件，并提示「开新会话后生效」。
- 对称的卸载入口 `tenon agent uninstall [--host claude|codex]`：按用户级所有权清单删除 Tenon 写入且未改动的文件，改过的保留并列出。
- 所有权：新建用户级清单 `<configRoot>/agents/host-owned.json`，按目标子代理目录分组：
  `{ "<子代理目录绝对路径>": { "<hostAgentPath 相对路径>": "<内容 hash>" } }`。安装与卸载只读写当前目录那一组，回收（库里已没有的 agent、
  卸载）也只在这一组里进行，所以在 `CLAUDE_CONFIG_DIR` 指向的目录上操作不会删除或认领 `~/.claude/agents` 里的文件，反之亦然。组内沿用现有的键
  （如 `.claude/agents/tenon-x.md`），只认能被 `parseHostAgentPath` 反解且宿主相符的条目，文件路径由当前目录与 agent 名重新拼
  （`<子代理目录>/tenon-<name>.<ext>`），不信任清单里的键。键不是绝对路径的分组（本任务开发期间按宿主名分组写下的）不解释、原样保留：
  那些文件内容与渲染一致时，下次安装按「内容已相同」补记所有权，不一致就当用户自有文件不碰。写入规则沿用项目级的三种情况：
  文件不存在、内容已相同（补记所有权）、清单记着且未被改过；同名的用户自有文件或被改过的文件不碰，报告里列出。
  库里已不存在的 agent，对应文件在清单里记着且未改过就删除。目标文件本身是符号链接就拒绝写；父目录（如用 dotfiles 管理的
  `~/.claude`）是符号链接时照常写入。
- `tenon agent add/new/copy/rm` 不写宿主文件，只在输出里提示执行 `tenon agent install` 并开新会话。

### 2. 派发判定：`tenon agent prompt`

- 不再生成任何宿主文件（删除 `prepare` 中的 `ensureChangeHostAgents`）。
- 按冻结定义渲染期望内容，与 `hostAgentsDir(host, { homeDir, env: process.env })` 解析出的目录里的文件比较（会话里执行时就是会话的
  环境，宿主读哪个目录就查哪个）。返回 `tenon-<name>` 当且仅当：用户级文件存在且逐字一致，并且项目里不存在内容不同的同名
  `.claude/agents/tenon-<name>.md`（项目级优先级高于用户级，会遮住它）。在 linked worktree 里判定时，同时检查当前根与按 git common
  dir 找到的主检出（用户改过而被保留的旧文件在主检出；从主检出启动的会话会加载它们）。
- 否则返回 `HOST_AGENT_FALLBACK[host]`，台账 `subagent` 记 `native: false` 与 `reason`：`not-installed`、`definition-mismatch`、
  `shadowed`、`project-agent`。JSON 输出带一句提示：执行 `tenon agent install --host <host>` 后开新会话；提示里给出所检查的目录，
  并说明要在带同样 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 的环境里执行（例如会话里用 `!` 前缀），用户一眼能看出装错了位置。
- 项目层 agent（`<项目>/.tenon/agents`）一律走通用子代理（`project-agent`），不再为它们写任何宿主文件。
- 台账：行里的 `subagent` 仍是 `host,native,type` 三键（升级前的运行时按闭集校验）；`reason` 按 run_id 记在运行旁注
  `.pipeline-agent-run-meta.jsonl` 的 `subagent_reason`，读取时叠加回 `subagent.reason`，只取闭集值；读取仍接受本地开发版写过的
  四键行。`tenon agent record --subagent <type>` 改写类型时 `reason` 一并按实际情况写（通用类型写 prompt 给出的原因）。升级前的运行时仍读得了台账。

### 3. 旧项目级文件清理

- `tenon init` 不再生成宿主文件，改为执行一次旧文件清理；归档、删除任务时的回收（CLI `transition.ts:231`、`task-lifecycle.ts`，
  Dashboard 服务端 `transition.ts:319`、`serverTaskLifecycleRoutes.ts`/`hostAgentPrune.ts`）改为同一清理。
- 清理对象是项目主检出：旧文件只在主检出的 `.claude/agents`、`.codex/agents` 与 `.pipeline-owned.json` 里。命令在 linked worktree
  里执行时（新任务默认如此），按 `git rev-parse --path-format=absolute --git-common-dir` 的上一级找到主检出再清理。
- 清理规则：项目里的 `.claude/agents/tenon-*.md`、`.codex/agents/tenon-*.toml`，在项目级清单 `.pipeline-owned.json` 里记着且未改过，
  或内容与当前库的渲染结果一致（覆盖清单条目已被 `sync --migrate` 剪掉的情况），就删除并移除清单条目；其余保留并 WARN。
  不再按「在途任务是否引用」区分。
- `HOST_AGENT_EXCLUDES`（`.git/info/exclude`）与 `HOST_AGENT_COMMIT_EXCLUDES`、指纹排除暂时保留，覆盖尚未清理的旧项目；
  `ensureLocalExcludes` 不再为宿主文件调用。

### 4. 终端步骤清单

- 新 CLI：`tenon workflow progress <change>`，输出一行：按 `plan.projection.steps` 顺序，当前步之前 `✓`、当前步 `●`、之后 `○`，
  归档后全部 `✓`，用 ` → ` 连接标签，例如 `立项 ✓ → 调研 ● → 规格 ○ → …`。
- 新 hook：`hooks/step-progress.sh`，在 `hooks/hooks.json` 注册为 PostToolUse、`matcher: "Bash"`，不加 `if` 过滤（前缀规则会挡掉
  `cd x && tenon transition …`、`zsh -lc "tenon …"` 这类链式命令），只靠脚本过滤。脚本纯 bash：非命令工具或命令里没有
  `tenon init|session activate|transition|step run <name>` 就 exit 0；命中才调用一次 `tenon workflow progress <name>`，输出
  `{"systemMessage":"Tenon · <name>\n<清单>"}`。PostToolUse 只在命令成功时触发，失败不打印——这一点依赖宿主语义（Bash 的
  `tool_response` 没有退出码，hook 自己判断不了），hook 测试覆盖不到，在验证步真机确认。任何异常都输出空并 exit 0。
  Claude Code 与 Codex 都打印（共用同一份 hooks.json），两边的显示样式在验证步真机确认。

### 5. skill 与文档

- `skills/tenon/SKILL.md` 第 5 步：宿主提供 Todo 工具（TaskCreate / TodoWrite）时按步骤标签建，没有就跳过，终端清单由 hook 打印。
- `run-agent` 行：照用返回的 `subagent_type`；通用类型会带 `reason` 与安装提示；派发仍报找不到时改用通用子代理并 `--subagent`。
- 更新 `docs/usage/agents.md`、`docs/usage/zh-CN/agents.md`：安装命令、用户级位置、项目层 agent 的行为。

### 6. 任务起点：记录 + 跟随上游

- `tenon init` 把当时的 HEAD 写入新字段 `start_sha`（`types.ts` 的 `FIELD_ORDER` 末尾追加，加入 `OMIT_WHEN_EMPTY_FIELDS`；仓库无
  提交时留空，键不出现）。Dashboard 建任务（`serverPostChangesRoutes.ts` 经 `runRepo.initChange`）与 triage 物化同样传入 `startSha`，
  它们仍原地建立。`base_branch` 的探测在 `store.ts:422`（`detectBaseBranch`），改为调用方可传入覆盖值。
- 存储：`start_sha` 是逻辑状态字段，但不写进 wire 的 `state.fields`（升级前发布的运行时按字段闭集校验），而是与
  `review_acknowledged_via` 一样存在按 revision 绑定的伴随文件 `.pipeline-run/start-sha/`（先于 revision 发布、绑 `stateDigest`、篡改失败关闭）；
  没有记录读作空。伴随文件的值不在摘要里，所以读取时还要求它的提交者时间不晚于 `created_at` + 60 秒，否则不作候选——改写或删除只会让
  改动范围变宽。v0.3.1 续写之后当前版本读到的 `start_sha` 为空，退回其余候选。写进 `docs/CONTRACT.md` 的字段说明。
- `computeStart` 改为收集候选再取最新：
  1. `start_sha`：存在且是 HEAD 的祖先（`merge-base --is-ancestor`）时入选；
  2. 上游：`<base_branch>@{upstream}` 能解析时取 `merge-base(HEAD, 上游)`；
  3. base：`merge-base(HEAD, <base_branch>)` 不等于 HEAD 时入选（任务分支 / worktree 分支有自己的提交时就是分叉点）。
  候选依次两两比较：一方是另一方的祖先就取后代，不成链就取二者的 `merge-base`（共同祖先），宁可多算。没有候选才走现有的
  `lastCommitBefore(created_at)`。
- 不读提交信息、不读作者：起点只能前移到 Tenon 自己记下的 HEAD 或本地上游引用可达的提交，改提交信息藏不住改动。三个决定起点的字段
  只能由建任务写入，`tenon set|set-many|cas` 拒写（其他直接写状态的内部路径如 automation 不在此列）。
- 已知限制：原地任务把自己的提交推到 base 分支的上游后，起点会前移过这些提交；worktree 任务的 `base_branch` 是来源分支，任务分支的
  提交在合并前不在来源分支的上游里，不受影响。
- 入口不变：`ChangeStartInput` 增加可选 `startSha`，`changeStartOfFields` 从状态取它；所有使用方已经都经 `createChangedFilesSession`，
  缓存键加上 `startSha`。CI 的 `tenon verify --ci` 里受保护配置与测试策略两处（`verify-ci-change.ts`、`verify-ci-policy.ts`）经
  `changeStartOfFields` 走同一入口（base 由 `resolveBaseRef` 解析为 `origin/<base>`）；`--since` 的任务选择（`verify-ci-select.ts`）是另一套
  按提交范围选任务的机制，不受影响。
- 兼容：没有 `start_sha` 且没有上游时行为与现在相同（`changed-files.test.ts:65-76` 保持通过）。

### 7. 新任务建在自己的 worktree

- 新 kernel 模块 `workspace/task-worktree.ts`：`planTaskWorktree(repoRoot, change)` 判定能否建（git 仓、有提交、命名分支、不是
  linked worktree：`git rev-parse --git-dir` 与 `--git-common-dir` 相同），给出路径 `<repoRoot>/.worktrees/<change>`、分支
  `tenon/<change>`、来源分支与 HEAD；`createTaskWorktree(plan)` 先检查路径与分支都不存在，再
  `git -c branch.autoSetupMerge=false worktree add -b tenon/<change> <path> HEAD`；`.worktrees/` 未被忽略时写入 `.git/info/exclude`。
- `cmdInit`：能建就先建 worktree，再以 worktree 为 `repoRoot` 调 `initChange`，并把 `base_branch=<来源分支>`、`start_sha=<HEAD>`、
  `isolation=worktree` 作为初始字段传入（`store.init` 接受覆盖值，不再在 worktree 里探测分支）。`cmdInit` 现在多处直接用 `deps.cwd`：
  工作流与 track 注册表、计划解析继续按主检出解析（`.pipeline/` 被 git 忽略，项目自定义工作流只在主检出），结果冻结进任务；测试目录
  自动发现（`announceAutoDiscover`）、项目登记（`registerProject`）、本机排除与状态写入改用 `cwd=worktree` 的 deps 副本，保证主检出
  `git status --short` 不变。初始化失败时
  `git worktree remove --force` 并删分支，不留半成品。不能建时原地初始化，输出原因。新增 `--in-place` 与环境变量
  `TENON_INIT_IN_PLACE=1` 显式原地初始化：现有约 529 处测试在临时 git 仓里执行 init（TS 工装与 `tools/test-bundle.sh`、
  `tools/test-hooks.sh`、`tools/test-adapters.sh`），统一由 vitest 全局 setup 与各 shell 测试导出该变量，不逐处改参数；`test-bundle.sh`
  里的 N-1 CLI 不认识这个变量，按原样原地建立，不受影响。skill 只在用户明确要求时传 `--in-place`。`--in-place` 与其余原地原因都输出
  `[INIT] 原地建立任务…` 一行；环境变量触发时不输出，免得每个测试建任务都多一行。
- 只读字段：`start_sha`、`base_branch`、`created_at` 决定起点，加入 `TRANSITION_MANAGED_FIELDS`，`tenon set` / `set-many` / `cas`
  一律拒写（现在 `base_branch` 与 `created_at` 可以被改写，等于能挪动起点藏起改动，一并堵上）。
- 信任继承：读主检出 `<user-dir>/local/test-seal.json` 的全部 `trusted` 条目（信任按命令摘要生效，摘要不同的条目不起作用），写进新
  worktree 的本机封存；审批与写入记录不复制。目录已提交时新 worktree 里的摘要与主检出相同，直接受信任；主检出有未提交的目录改动时
  摘要不同，按未受信任处理并提示；之后在 worktree 里改了命令也要重新信任。
- 准备命令：测试目录 schema 增加可选顶层 `setup`（字符串），纳入 `catalogExecDigest`。受信任时在 worktree 里执行并把输出转给用户；
  未受信任或没有 `setup` 时跳过并提示；失败只 WARN 并给出重跑命令，`init` 退出码为 0。本仓配置 `setup: npm ci`（实现步确认是否还需
  构建步骤）。
- 输出：文本与 `--json` 都给出 `worktree` 绝对路径与下一步（Claude Code：`EnterWorktree` path；Codex：在该目录开新会话）。
- 恢复与列出：`cmdList` 在主检出额外读 `git worktree list --porcelain`，对 `.worktrees/` 下的每个 worktree 读其中
  `openspec/changes/*` 的未归档任务，加 `worktree` 列；`hooks/router.sh` 现在直接遍历 `$PROOT/openspec/changes/*`，再多遍历一层
  `$PROOT/.worktrees/*/openspec/changes/*`（纯 bash，不起 git），用户点名的任务只在 worktree 里时 dispatch 带 `worktree_path`；
  worktree 任务不计入 `ACTIVE_CHANGE_COUNT` / `SOLE_CHANGE_*` 等「新建还是选择」的判定；主检出没有自己的活跃任务、用户泛泛说「继续」
  时，把 worktree 任务连同路径列为候选（`selection_required`）；
  `tenon workflow progress <change>` 在当前根找不到任务时同样查这份清单，`step-progress` hook 在主检出执行 `tenon init`、
  `cd <worktree> && tenon transition …` 后照常打印；
  `status` / `get` 等按名读取找不到任务时，查同一份清单，报错里给出路径。
- skill：「进入」第 3 步改为 init 后按输出切进 worktree 再 activate；删掉「不要为了隔离自己建分支或 worktree」，改为「worktree 由
  `tenon init` 建，不要自己另建」；恢复时 dispatch 带 `worktree_path` 就先切进去。
- 交付与完结在 worktree 的分支上进行；`finish-change` 动作附带 `cleanup`（`git worktree remove <path>`，以及合并后删除分支的命令），
  skill 转告用户，不自动删除。`statusStepFinish.ts` 的 `finishActions` 是纯函数、拿不到隔离方式与路径：`StepFinishFacts` 增加
  `worktree?: { path: string; branch: string }`，`finish-change` 与工作区已干净时的 `finishedStop` 都带 `cleanup`。

### 8. worktree 任务的构建版本

- 类别判定现在散在 8 处，同为 `isolation === 'in-place' ? 'workspace' : 'git'`：CLI `main.ts:293`、`commands/buildRevisionAssessor.ts:28`、
  `integration-harness.ts:292`，kernel `workflow/build-revision.ts:217`、`workflow/action-handlers.ts:48`，服务端 `transition.ts:160`、
  `transition.ts:170`、`workflowSnapshot.ts:282`。在 `build-revision.ts` 导出 `expectedBuildRevisionKind(isolation)`（`branch` → `git`，
  其余 → `workspace`），8 处全部改为调用它，CLI 与 HTTP 流转、Dashboard 快照一致。身份仍由 `probeBuildRevisionIdentity` 给出（含
  worktree），在别的检出验证会得到 `worktree-mismatch`。
- `docs/CONTRACT.md` 的「Build→Verify 可复验基线」一条改为：`branch` 绑 git object，`worktree` 与 `in-place` 绑工作区内容指纹。

### 8b. 宿主为子代理与会话建的检出不计入工作区指纹

- 起因（验证第 1 轮）：同仓库另一个 Claude Code 会话与它的子代理在 `.claude/worktrees/` 下持续改文件，本任务（主检出原地）的构建版本
  `revision-stale`，评审候选也随之变化；该目录约 42 万个文件，每算一次指纹十几秒，一次 `tenon status` 要算好几次。
- 现状：`fingerprintWorkspaceTwins`（`fingerprint.ts:384`）一次遍历同时产出两个指纹。完整指纹的 `skip` 是 `SKIP_NOTHING`，可移植指纹的
  `skip` 是 `skipUntrackedHostLocal(tracked)`（跳过未被 git 跟踪的宿主本地路径：`.claude/settings.local.json`、`CLAUDE.local.md`、
  `.claude/worktrees/`）。构建版本的 `workspace` 令牌（CLI `main.ts:291` 的 `candidateFingerprint`）与评审候选绑完整指纹，测试记录绑可移植指纹。
- 改为：完整指纹的 `skip` 换成只针对宿主本地**目录**的同一判定——新增 `skipUntrackedHostLocalDirs(tracked, caseInsensitive)`
  （`host-local.ts`），对 `HOST_LOCAL_DIRS` 下未被 git 跟踪的路径返回真，被跟踪的路径及其祖先目录返回假；宿主本地**文件**在完整指纹里照算，
  保持完整指纹「记原始内容与权限位」的其余语义。git 回答不了（`tracking === undefined`）时两个指纹都不跳过，与现在一致。
- 两个 sink 都跳过时 `fingerprintEntry` 的 `live` 为空，直接返回，不再 `readdir` 进入 `.claude/worktrees/`：正确性与性能一起解决。
- 兼容：0.3.0 与 v0.3.1 的完整指纹仍计入该目录。只在存在未跟踪的 `.claude/worktrees/` 的机器上：0.3.0 写下、绑完整指纹的测试记录
  升级后判为过期要重跑；回滚到 v0.3.1 时，当前版本记下的评审结论与构建版本被它判为过期要重跑。都不会判为损坏。bundle 的 N-1 完整指纹
  一致性检查用的树里没有这个目录，不受影响。`fingerprint.test.ts` 里「完整指纹与 0.3.0 逐位相同」的钉死值有两个（`plain:with`、
  `settings:with`）是在含 `.claude/worktrees/` 的夹具上算的，改为在只含宿主本地**文件**、不含符号链接的夹具上，用 `v0.3.0` tag 里的
  实现重新算出钉死（无符号链接时值与平台无关）；另加「未跟踪的 `.claude/worktrees/` 不动完整指纹」的断言。CONTRACT 的指纹条目同步改写。

### 9. 退回边技能门与未派发运行

- `step-exit-report.ts` 与 `transition-step-gates.ts`：方向为 back 的边，从「未完成技能」里去掉归属某个 agent 的技能（冻结 agent 定义
  的 `skills` 列表即归属关系，逻辑取自 `agentSkillGate.ts` 的 `owners`，下沉为 kernel `agentOwnedSkills`）；主线技能照旧。
- 接口：`missingStepSkills` 现在返回消息字符串，按技能 id 过滤不了。改为入参增加 `exclude?: ReadonlySet<string>`，在生成消息前按
  槽位的技能 id 剔除；kernel 在 `!isForwardExit(...)` 时传入 `agentOwnedSkills` 的结果。所有适配方一起改：CLI `stepSkillGate.ts`、
  `commands/check-skills.ts`、`commands/internalSkillGate.ts`，服务端 `transition.ts:257`。
- `tenon agent record --subagent none`：台账 `subagent` 写 `{ host, type: 'none', native: false, reason: 'not-dispatched' }`；
  `HostSubagentReason` 增加 `not-dispatched`。

### 10. 模块与接缝

| 模块（kernel 为主） | 接口 | 藏在里面的行为 | 调用方 |
| --- | --- | --- | --- |
| 子代理目录 `hostAgentsDir` | 入参：宿主、`{ homeDir, env, platform }`；返回用户级子代理目录绝对路径，纯函数 | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 的绝对路径判定与默认目录 | 下面两项的调用方 |
| 用户级安装 `installHostAgents` / `uninstallHostAgents` | 入参：宿主、子代理目录、`configRoot`、要安装的 agent 定义；返回逐文件结果（written / unchanged / foreign / modified / removed / preserved） | 渲染、按目录分组的用户级所有权清单读写与加锁、符号链接拒绝、原子写、过期文件删除 | `tenon agent install/uninstall`、`tenon setup`、`tenon update` |
| 派发判定 `resolveHostSubagent` | 入参：宿主、子代理目录、项目根、冻结 agent（含所在层）；返回 `{ type, native, reason? }`，只读 | 渲染期望内容、读用户级与项目级同名文件、遮挡判断、项目层判断 | `tenon agent prompt`（提示里给出该目录） |
| 旧文件清理 `cleanupLegacyHostAgents` | 入参：项目根、按名渲染当前定义的函数；返回 `{ removed, preserved }` | 读项目级所有权清单、内容比对、删除与清单更新、加锁 | `tenon init`、CLI 归档/删除任务、Dashboard 服务端归档/删除任务 |
| 步骤清单 `stepProgressLine` | 入参：projection 步骤、当前步、是否归档；返回一行文本，纯函数 | 顺序推算 ✓/●/○、拼接 | `tenon workflow progress` |
| 起点解析 `resolveStart`（`changed-files.ts` 会话内） | 入参：`{ baseBranch, createdAt, startSha? }`；返回起点提交 | 候选收集、祖先判定、共同祖先兜底、按时间推算 | 全部 12 类按起点比对的使用方（签名不变） |
| 任务 worktree `planTaskWorktree` / `createTaskWorktree` | 入参：仓库根、任务名；返回计划（能否建与原因、路径、分支、来源分支、HEAD）或创建结果 | git 判定、路径与分支冲突检查、`worktree add`、本机排除、失败回滚 | `tenon init` |
| worktree 任务发现 `listTaskWorktrees` | 入参：主检出根；返回 `{ path, branch, changes[] }[]` | `git worktree list --porcelain` 解析、只取 `.worktrees/` 下、读未归档任务 | `tenon list`、按名读取的报错、`tenon workflow progress`（`hooks/router.sh` 用自己的纯 bash 遍历，不经它） |

- 接缝取在「文件系统根目录由调用方传入」：子代理目录（由 home 与环境解析）、`configRoot`、项目根都作为参数，测试用临时目录与注入的
  环境变量替换，不读真实 `$HOME`、`$CLAUDE_CONFIG_DIR`、`$CODEX_HOME`。
- 旧的 `ensureHostAgentFiles` / `pruneHostAgentFiles` 中可复用的内部件（原子写、符号链接检查、清单解析与序列化）留作内部，
  不再作为接口导出；`pruneUnusedHostAgentFiles` 的 `isFinished` 回调随「按在途任务引用回收」一起删除，清理接口变得更小。
- CLI 与 hook 是薄适配层：`tenon workflow progress` 只读冻结计划并调用 `stepProgressLine`；`step-progress.sh` 只做命令匹配与
  JSON 包装，它的行为用 hook 测试脚本覆盖。

### 11. 覆盖

```coverage
touches: host-agents, hooks, cli, server, workspace, workflow-gates
L1_api:      filled -> §1 tenon agent install/uninstall、§2 tenon agent prompt JSON 的 reason/hint、§4 tenon workflow progress 与 hook 输出格式、§7 tenon init 输出 worktree 与 tenon list 的 worktree 字段、§9 agent record --subagent none、§10 kernel 接口表
L2_data:     filled -> §1 用户级所有权清单 host-owned.json 结构（按子代理目录分组）、§2 台账 subagent.reason、§3 项目级清单条目移除、§6 start_sha 字段、§7 catalog setup 与本机封存信任条目、§8 build_sha 令牌类别
L3_rules:    filled -> §1 子代理目录跟随 CLAUDE_CONFIG_DIR / CODEX_HOME（只认绝对路径）、只写三种情况与项目层不写、§2 一致性判定与四种退回原因、§3 清理判定、§4 ✓/●/○ 顺序推算、§6 起点候选与取最新、§7 能否建 worktree 的判定、§9 退回边只免归属 agent 的技能
L4_state:    filled -> §1 首次安装/重复安装/update 已是最新版/卸载、§3 init 与归档删除时的清理、§4 归档后全 ✓、§6 旧任务无 start_sha、§7 建 worktree 失败回滚与完结后保留 worktree
L5_errors:   filled -> §1 foreign/modified/failed 与清单损坏只写缺失文件、§2 用户目录不存在返回 not-installed、§3 清理失败只 WARN、§4 hook 异常静默 exit 0、§6 起点解析失败沿用失败关闭、§7 路径或分支已存在报错、setup 失败只 WARN
L6_security: filled -> §1 目标文件为符号链接拒绝写、只动清单记着且未改的文件、不覆盖用户自有同名文件、清单只按当前目录取组且路径由名字重拼、不同目录互不回收；§4 hook 纯 bash 过滤不执行命令内容，只以匹配出的任务名调用 tenon；§6 起点不按提交信息推断、只前移到可达的上游或自记的 HEAD，决定起点的字段经 CLI 不可改写；§7 setup 受目录信任约束，信任按命令摘要生效；§8 构建版本绑 worktree 身份
L7_perf:     filled -> §4 脚本纯 bash 过滤，不命中路径零解释器，命中时一次 CLI 调用；§6 候选判定每次至多数次 git 调用并按会话缓存；§7 setup 的时间与磁盘成本随并行任务数增长；§8b 指纹遍历不再进入未跟踪的 .claude/worktrees/
L8_deps:     filled -> 无新 npm 依赖；依赖 Claude Code 子代理目录、hook systemMessage/if 与 EnterWorktree path 契约，Codex agents 目录与 PostToolUse 契约，git worktree
L10_terms:   filled -> CONTEXT.md「Host subagents and step progress」「Change start point」「Task worktree」
```

## 备选方案

- **会话内生成 + 判新鲜度**：仍在 init 写项目级文件，prompt 遇到刚写的文件退回通用子代理。依赖 Claude Code 未写进文档、实测也不稳定的
  刷新时机，判定阈值无从确定。否决。
- **终端命令写项目级**：每个项目都要执行一次，还要保留本机排除、所有权清单与 `sync --migrate` 剪枝的交互。项目层 agent 能获得专属类型，
  但复杂度最高。用户选了用户级。
- **插件自带 agents**：插件 agent 名带 `tenon:` 前缀，且无法包含用户自定义层。否决。
- **只靠 statusLine 显示进度**：Claude Code 只允许一个 statusLine，项目级与用户级已分别被另一款开发工具、claude-hud 占用。否决。
- **按提交信息判断起点归属**：Tenon 生成的提交信息带任务名，可据此识别「本任务的提交」。提交信息可以随意写，代理能借此把自己的
  改动藏到起点之前。否决。
- **显式命令挪起点**（`tenon task rebase`）：可控但要人记得执行；用户选了自动跟随上游。
- **到实现步设 `isolation=worktree` 时才建 worktree**：要把主检出里未提交的任务状态搬进去，迁移风险高。否决，改为建任务时就建。
- **只在主检出已有在途任务时才进 worktree**：用户选了一律进 worktree。
- **worktree 构建版本保持 git HEAD**：要求实现步结束前提交，与「只在 `next` 点名时提交」冲突。否决。

## 风险

- **会话中执行安装**：用户在会话开着时执行 `tenon agent install`，新增的 agent 在当前会话仍可能找不到；skill 保留「找不到就改用通用
  子代理」的兜底，提示开新会话。
- **冻结版本与库版本不一致**：库升级后，冻结旧版本的在途任务会退回通用子代理（`definition-mismatch`），不会悄悄用新版本代替。
- **用户级同名冲突**：用户自己放的 `~/.claude/agents/tenon-<name>.md` 不归 Tenon，不覆盖；该 agent 退回通用子代理并在安装报告里列出。
- **终端与会话环境不一致**：`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 只在启动宿主的环境里设、普通终端没有时，在终端安装会写到默认目录，
  会话仍找不到。`prompt` 按会话环境判定，退回通用子代理并给出所检查的目录；使用文档写明在带同样变量的环境里安装。
- **hook 成本**：PostToolUse 每次 Bash 调用都起一次 `tenon-hook`（纯 bash，不起 Node）；脚本内 bash 过滤，命中才调用一次 CLI。
- **`systemMessage` 显示样式**：文档只写「shown to the user」，真机验收时截图确认；Codex 侧同样真机确认。
- **非线性工作流**：按顺序推算的 ✓/●/○ 在回退（如 verify-fail 回到 build）时会把后续步显示为未到，这是预期行为。
- **本地上游引用**：起点跟随 `<base>@{upstream}`；没 fetch 时偏旧（只多算）；刻意改写本地远端引用能排除提交，需要 git 底层命令，
  不在本任务防护范围。本地未推送的他人提交仍算进来。
- **worktree 成本与体验**：每个新任务一个 worktree、一个分支、一次依赖安装；Codex 要开新会话。`EnterWorktree` 之后 hook 收到的 `cwd`
  是否为 worktree 要真机确认。
- **兼容**：`start_sha` 存在伴随文件、台账 `reason` 存在运行旁注，升级前发布的运行时仍读得了新任务；完整指纹不计未跟踪的
  `.claude/worktrees/` 后，有该目录的机器回滚到 v0.3.1 时评审结论与构建版本会被判过期、需要重跑。写进 CONTRACT。
- **伪造提交时间**：`start_sha` 的读取校验挡不住刻意把提交时间写早于 `created_at` 的提交（同用户同机器的信任模型内），写进 CONTRACT。
- **其余宿主本地文件**：完整指纹仍计入 `.claude/settings.local.json`（用户回答权限提示时 Claude Code 会改写它），这会让原地任务的
  构建版本过期；本轮只处理 `.claude/worktrees/`，这一项保持现状。
- **未提交的配置**：主检出里未提交的测试目录改动不进新 worktree，按未受信任处理。
- **Dashboard**：每个 worktree 登记为单独项目，没有跨 worktree 的统一视图（非目标）。
- **本任务自身**：仍在主检出原地推进；起点修正要等源码开发安装同步后才对本任务生效，之前那 93 个继承文件仍会出现。
