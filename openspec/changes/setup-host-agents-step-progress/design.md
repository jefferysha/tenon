# 设计

完整设计见 `docs/superpowers/specs/setup-host-agents-step-progress-design.md`，决策记录见
`docs/adr/setup-host-agents-step-progress.md`。本文件记录调研结论与已确定的要点。

## 调研结论

- **子代理加载时机**（实测，Claude Code 2.1.292）：会话中途写入的子代理文件，同一回合派发必然 not found；探针文件跨多个回合、
  数分钟后仍 not found；另一批文件约 10 分钟后才在某回合开头通过 `agent_listing_delta` 出现。官方文档称「within a few seconds」
  生效，与实测不符。只有会话启动前就存在的文件可靠。
- **优先级**：项目级 `.claude/agents/` 高于用户级 `~/.claude/agents/`，高于插件；插件 agent 名带 `plugin:` 前缀。
- **用户级目录的位置**（规格第四轮，2026-10-11 真机验收）：设了 `CLAUDE_CONFIG_DIR` 时 Claude Code 的用户级目录整体换到该目录，
  子代理只从 `$CLAUDE_CONFIG_DIR/agents` 读。本机会话的可用列表里有只在 `$CLAUDE_CONFIG_DIR/agents` 的 `impeccable-*`，没有只在
  `~/.claude/agents` 的 `tenon-*`；插件也装在 `$CLAUDE_CONFIG_DIR/plugins`（`claude plugin install` 自己认这个变量），所以 hook 照常
  生效。本机 shell 配置里没有这个变量，它由启动 Claude 的环境带入，会话里的 Bash 工具继承它。Codex 的 `CODEX_HOME` 同理；Tenon 写用户级
  `AGENTS.md` 时已认 `CODEX_HOME`（`instructions/hosts.ts` 的 `userInstructionPath`，只接受绝对路径），子代理安装与判定却写死 home。
  本仓主检出有旧版生成的项目级 `.claude/agents/tenon-*.md`，所以在本仓里开的会话没有暴露这个问题。
- **Todo 工具**：Claude Code 2.1.268 起只对 Claude 3.x、Opus 4.0–4.7、Sonnet 4.0–4.6、Haiku 4.5 默认提供，其余模型需
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。
- **hook 输出**：`systemMessage` 是「Warning message shown to the user」；PostToolUse 只在工具成功后触发；Bash 的
  `tool_response` 没有退出码；hook 条目支持 `if: "Bash(tenon *)"` 预过滤。Codex 有 PostToolUse 且支持 `systemMessage`，
  shell 命令按 `Bash` 匹配，与 Claude 共用 `hooks/hooks.json`。
- **仓库现状**：`setup` / `update` 是全局命令且从未写过 `~/.claude/agents/`；没有用户级所有权清单；agent 库三层存储
  （官方、自定义在 `<configRoot>/agents/`，项目层在 `.tenon/agents`）；宿主文件生成点 `init.ts:325`、`agent.ts:74`，回收点
  CLI `transition.ts:229`、`task-lifecycle.ts`，服务端 `transition.ts:301`、`serverTaskLifecycleRoutes.ts`；
  `localExcludes.ts` 还服务测试输出，不能整体删除；`plan.projection.steps` 只有 `id`/`label`，完成状态需按顺序推算。
- **任务起点**（规格第二轮，2026-10-10）：起点不落盘，每次由 `base_branch` 与 `created_at` 推算（`changed-files.ts:211-228`）；
  `base_branch` 是建任务时 HEAD 所在分支，原地开发时等于 HEAD，于是总走「`created_at` 之前最后一个提交」，之后进入 HEAD 的提交都算
  本任务。按起点比对的使用方有 12 类（测试登记与同步、运行选择与改动行覆盖率、受保护配置审批及其展示、目录未动判定、测试完整性、
  改动风险与评审者挂载、证据导出、CLI/HTTP 流转门、Dashboard 快照、`tenon verify --ci`），全部经 `changed-files.ts` 的会话入口。
  受保护配置的批准绑定的是文件内容摘要，不是起点，所以挪动起点不会让已有批准失效。现有测试 `changed-files.test.ts:65-76` 断言
  「建任务后在 base 上的提交算本任务」，新规则在没有 `start_sha` 与上游时保留这一行为。
- **worktree**：CLI 的项目根就是 `process.cwd()`，任务目录是 `<cwd>/openspec/changes/<c>`；hook 按 cwd 向上找到最近的 `.git`
  （linked worktree 的 `.git` 是文件，也算根）。评审标记、会话绑定、活跃任务指针、本机测试封存都放在项目根下，所以一个 linked
  worktree 天然是独立的一套状态；任务只要从建立到归档都在同一个 worktree 里，现有机制就能工作。缺的是：没有代码为任务建
  worktree；`detectBaseBranch` 在 worktree 里会返回 worktree 自己的分支；`isolation=worktree` 的构建版本绑 git HEAD（`main.ts:290-297`、
  `docs/CONTRACT.md`「Build→Verify 可复验基线」一条）而实现到交付才提交；新 worktree 没有 `node_modules`，本机测试信任为空。AFK 的 worktree
  （`.sandcastle/worktrees/`）只放已提交内容，状态写回主检出，不能直接复用。`.worktrees/` 已在 `.gitignore`，且被工作区指纹排除。
  Claude Code 的 `EnterWorktree` 支持用 `path` 切进 `git worktree list` 里已有的 worktree。
- **退回边技能门**：`step-exit-report.ts` 注释写明技能门对退回边同样生效（`rejectOnStepGates` 不分方向），主规格
  `workflow-skill-enforcement` 也要求离开 phase 时检查 Skill receipt；实现步的 `test-driven-development` 归 `builder`，hook 只在该
  agent 运行期间放行加载，于是退回规格必须先开始一次 builder 运行。

## 已确定的设计

1. `tenon agent install [--host]` 写用户级宿主文件（官方 + 自定义层），用户级所有权清单 `<configRoot>/agents/host-owned.json`；
   `tenon setup` / `tenon update` 成功后调用（`update` 已是最新版也执行）；对称的 `tenon agent uninstall` 清除；库变更命令只提示。
2. 会话内命令不写宿主文件；`tenon agent prompt` 只在用户级文件与冻结定义逐字一致、且未被项目级同名文件遮住时返回
   `tenon-<name>`，否则返回通用子代理并记录 `reason`（`not-installed` / `definition-mismatch` / `shadowed` / `project-agent`）。
3. 旧项目级 `tenon-*` 文件在 `tenon init` 与归档/删除任务时清理（所有权清单记着且未改，或内容与当前渲染一致）。
4. `tenon workflow progress <change>` + PostToolUse hook `step-progress`，在 `init / session activate / transition / step run`
   成功后用 `systemMessage` 打印一行 ✓/●/○ 清单；Claude Code 与 Codex 都打印。
5. skill 第 5 步改为「有 Todo 工具才建」，`run-agent` 行同步改写；更新使用文档。
6. 任务起点：init（含 Dashboard 与 triage 建任务）记 `start_sha`；起点取 `start_sha`、上游 merge-base、base merge-base 中最新的
   一个，分不出先后取共同祖先，都没有才按时间推算；不按提交信息推断归属；`start_sha`、`base_branch`、`created_at` 经 CLI 不可改写。
   所有使用方经同一入口。
7. CLI 新任务一律建在 `.worktrees/<change>`（分支 `tenon/<change>`），在其中初始化；工作流与 track 按主检出解析后冻结进任务，
   目录自动发现、项目登记与状态写在 worktree；`base_branch` 记来源分支、`isolation=worktree`；测试目录新增可选 `setup`（纳入目录信任，
   没有时摘要不变），建好后继承本用户的信任条目并执行 `setup`；Claude Code 用 `EnterWorktree` 切入，Codex 开新会话；主检出的
   `tenon list`、按名读取的报错、`tenon workflow progress` 与路由能找到 worktree 里的任务，但 worktree 任务不计入主检出「新建还是选择」
   的判定；完结时 `finish-change` 附带清理命令。非 git、无提交、分离 HEAD、已在 linked worktree、`--in-place` 或
   `TENON_INIT_IN_PLACE=1` 时原地初始化（测试工装用环境变量，触发时不输出原地原因，其余情况都输出）；Dashboard 与 triage 建任务仍原地。
8. `isolation=worktree` 的构建版本改绑工作区指纹（身份含 worktree），`branch` 不变；现散在 CLI、kernel、服务端的 8 处类别判定统一到
   `expectedBuildRevisionKind`，同步改 CONTRACT。
9. 退回边不要求归属 agent 的技能（`missingStepSkills` 增加 `exclude`，kernel 在退回边传入 `agentOwnedSkills`）；
   `tenon agent record --subagent none` 记 `not-dispatched`，台账解码接受带 `reason` 的 `subagent`。
10. 旧项目级宿主文件的清理按 git common dir 找到主检出再清理；用户级安装只读官方层与自定义层。
11. 完整工作区指纹与可移植指纹一样跳过未被 git 跟踪的 `.claude/worktrees/`（`fingerprint.ts` 一次遍历里两个指纹都不进入该目录；
    目录下被 git 跟踪的文件照算，判定沿用 `hostLocalTracking`）；`.claude/settings.local.json`、`CLAUDE.local.md` 在完整指纹里不变。
    起因：验证第 1 轮里同仓库另一个会话在 `.claude/worktrees/` 下持续改文件，主检出原地任务的构建版本 `revision-stale`。
12. 用户级子代理目录跟随宿主配置目录：Claude 取 `CLAUDE_CONFIG_DIR`、Codex 取 `CODEX_HOME`，值为绝对路径才采用（与
    `userInstructionPath` 同一判定），否则 `~/.claude`、`~/.codex`；目录由一个 kernel 函数按传入的 home 与环境解析，安装、卸载、
    `tenon agent prompt` 的判定都用它，CLI 传入自己的进程环境。用户级所有权清单改为按目标子代理目录（绝对路径）分组，安装与卸载只读写
    当前目录那一组，回收也只在这一组里进行；不认识的旧分组（本任务开发期间按宿主名分组写下的）忽略，其中内容与渲染一致的文件在下次安装时
    按「内容已相同」补记所有权。`prompt` 返回通用子代理时，JSON 与文本提示带上所检查的目录。

## 风险

- 用户在会话开着时执行安装，新增 agent 在当前会话仍可能找不到：保留 skill 的通用子代理兜底与「开新会话」提示。
- 终端与会话的环境不一致（例如只有启动 Claude 的环境带 `CLAUDE_CONFIG_DIR`）：在普通终端安装会写到 `~/.claude/agents`，会话仍找不到。
  `prompt` 判定按会话环境解析，会退回通用子代理并给出它检查的目录；使用文档写明在带同样变量的环境里执行（例如会话里用 `!` 前缀）。
- 库升级后冻结旧版本的在途任务退回通用子代理（`definition-mismatch`），不悄悄替换版本。
- 用户自有的同名用户级文件不覆盖，该 agent 退回通用子代理并在安装报告列出。
- PostToolUse 每次 Bash 调用都起一次 `tenon-hook`（纯 bash）：不用 hooks.json 的 `if` 前缀过滤（它会挡掉 `cd x && tenon …` 这类链式命令），
  只靠脚本内的纯 bash 窄过滤，命中才起 Node。
- `systemMessage` 在两个宿主终端里的具体样式需真机确认。
- 项目层 agent 失去专属类型，工具白名单只靠正文约束。
- 兼容：`start_sha` 不写进 wire 的字段闭集，存在按 revision 绑定的伴随文件，读取时还校验它的提交时间不晚于 `created_at` + 60 秒；
  台账的 `reason` 存在运行旁注。升级前发布的运行时（字段与键闭集校验）因此仍读得了新任务；v0.3.1 续写后当前版本读到的 `start_sha` 为空，
  退回上游候选。完整指纹不再计入未跟踪的 `.claude/worktrees/` 后，只在有这个目录的机器上：0.3.0 写下的测试记录升级后判过期，
  回滚到 v0.3.1 后当前版本的评审结论与构建版本判过期，都需要重跑（不判损坏）；`fingerprint.test.ts` 的 0.3.0 钉死值相应改在不含
  该目录的夹具上重算。
- 原地任务把自己的提交推到 base 分支的上游后，起点会前移过这些提交（已知限制；worktree 任务不受影响）。
- 主检出未提交的测试目录改动不会进入新 worktree，此时目录按未受信任处理、不执行 `setup`。
- 起点跟随上游依赖本地的上游跟踪引用：引用没更新时起点偏旧，只会多算；有人刻意改写本地远端引用可以把提交排除出去，这需要 git
  底层命令，不在本任务防护范围，写进风险。本地未推送的他人提交仍会算进来。
- 新任务默认进 worktree 是行为变化：每个任务一个 worktree 与分支、一次依赖安装（本仓 `npm ci`），磁盘与时间成本随并行任务数增长；
  Codex 用户需要开新会话。项目没声明 `setup` 时新 worktree 里测试跑不起来，Tenon 只提示。
- 每个 worktree 在 Dashboard 里登记为单独的项目。

## 待验证问题

1. ~~Codex 的 hooks.json 是否接受条目上的 `if` 字段~~——已不再使用 `if`（见风险一节），问题关闭。
2. `systemMessage` 在 Claude Code 与 Codex 终端的显示样式——验证步真机截图。
3. `tenon update` 已是最新版时的代码路径——实现步确认安装逻辑在该路径上也会执行，并补测试。
4. `EnterWorktree` 切入后，Claude Code 传给 hook 的 `cwd` 是否为 worktree 路径（决定评审确认与会话绑定落在哪个根）——验证步真机确认。
5. 本任务自身在主检出原地推进：实现了起点修正并同步源码开发安装后，本任务的起点会变为上游 merge-base，那 93 个继承文件不再算本任务的；
   同步前它们仍会出现——实现步开头按 `next` 处理，同步安装的时机在实现步与用户确认。
