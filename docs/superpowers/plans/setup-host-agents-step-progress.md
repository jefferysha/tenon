# 宿主子代理终端安装与终端步骤清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话内的 Tenon 命令不再写宿主子代理文件，专属子代理只来自终端安装的用户级文件（目录跟随宿主配置目录）；关键命令后终端打印一行步骤清单；
同仓多个任务各在自己的 worktree 并行、证据互不污染（起点记录并跟随上游、新任务建 worktree、worktree 构建版本绑工作区指纹、
宿主为子代理与会话建的 `.claude/worktrees/` 不计入工作区指纹）；
退回边不再要求执行者的技能。

**Architecture:** kernel 新增深模块（用户级安装、派发判定、旧文件清理、步骤清单纯函数、任务 worktree、worktree 任务发现），
起点解析留在 `changed-files.ts` 的会话入口内改造；文件系统根目录与 git 执行器全部由调用方传入；CLI（`tenon agent install|uninstall`、
`tenon workflow progress`、prompt、init/归档、list）与 Dashboard 服务端只做薄适配；新 hook `step-progress.sh` 纯 bash 过滤后调用一次
CLI，用 `systemMessage` 输出。

**Tech Stack:** TypeScript（Node ≥ 20，ESM）、vitest、bash hook（`hooks/json-input.sh` 解析）、commander、git worktree。

**Spec:** `docs/superpowers/specs/setup-host-agents-step-progress-design.md`；delta spec
`openspec/changes/setup-host-agents-step-progress/specs/{host-native-subagents,effective-workflow-plan,change-start-point,task-worktree-isolation,workflow-skill-enforcement}/spec.md`；
ADR `docs/adr/setup-host-agents-step-progress.md`。

## Global Constraints

- 用户级路径：Claude `<Claude 配置目录>/agents/tenon-<name>.md`，Codex `<Codex 配置目录>/agents/tenon-<name>.toml`；Claude 配置目录取
  `CLAUDE_CONFIG_DIR`、Codex 取 `CODEX_HOME`（去掉首尾空白后是绝对路径才采用），否则 `~/.claude`、`~/.codex`（Task 16；Task 3–5 写成时
  还是写死 home，由 Task 16 改掉）。
- 用户级所有权清单：`<configRoot>/agents/host-owned.json`，结构 `{ "<子代理目录绝对路径>": { "<hostAgentPath 相对路径>": "<内容 hash>" } }`，
  hash 用 `computeContentHash`（Task 16；此前按宿主名分组）。
- 通用子代理类型沿用 `HOST_AGENT_FALLBACK`：Claude `general-purpose`、Codex `default`。
- 派发判定的退回原因只有四个值：`not-installed`、`definition-mismatch`、`shadowed`、`project-agent`；登记时另有 `not-dispatched`（Task 13）。
- 安装提示原文：`执行 tenon agent install --host <host> 后开新会话生效`。
- 步骤清单格式：标签与标记之间一个空格，步骤之间 ` → `；标记 `✓` / `●` / `○`；hook 消息首行 `Tenon · <change>`，第二行是清单。
- 测试不得读写真实 `$HOME`、`$CLAUDE_CONFIG_DIR`、`$CODEX_HOME` 或真实 `configRoot`：一律用 `mkdtemp` 临时目录作为用户目录根与
  `configRoot`，环境变量由用例注入；测试进程本身（vitest 全局 setup、shell 测试脚本）先清掉继承来的 `CLAUDE_CONFIG_DIR` 与 `CODEX_HOME`。
- hook 在不命中的路径上不得启动任何解释器；任何异常输出空、exit 0。
- `localExcludes.ts` 的 `HOST_AGENT_EXCLUDES`、`gitWorkspace.ts` 的 `HOST_AGENT_COMMIT_EXCLUDES` 与指纹排除保留不动。
- 代码注释与报错用中文，风格与所在文件一致；不新增依赖。
- 各任务不单独 `git commit`：提交只在 Tenon 交付步按 `step.next` 的 `commit` 统一进行。
- 新状态字段 `start_sha` 追加在 `FIELD_ORDER` 末尾（`max_rounds` 之后），并加入 `OMIT_WHEN_EMPTY_FIELDS`，旧任务逐字节不变。
- `start_sha`、`base_branch`、`created_at` 加入 `TRANSITION_MANAGED_FIELDS`，`tenon set|set-many|cas` 拒写。
- 任务 worktree 路径 `<主检出>/.worktrees/<change>`，分支 `tenon/<change>`；`.worktrees/` 已在 `.gitignore`。
- 起点候选取最新；分不出先后取共同祖先（宁可多算）；不读提交信息与作者。
- 构建版本：`kind = isolation === 'branch' ? 'git' : 'workspace'`。
- 测试里的 git 仓一律建在 `mkdtemp` 临时目录，不碰本仓与真实 `$HOME`；需要上游时在临时目录建 bare 仓作 `origin`。
- 现有在临时 git 仓里执行 init 的测试统一靠环境变量 `TENON_INIT_IN_PLACE=1` 原地建立：vitest 全局 setup
  `tools/vitest.isolate-runtime-home.mjs` 与 `tools/test-bundle.sh`、`tools/test-hooks.sh`、`tools/test-adapters.sh` 开头导出；
  专测 worktree 的用例在用例内删掉该变量。不逐处改参数、不改各测试断言。
- N-1 兼容：升级前发布的运行时必须仍读得了新任务。`start_sha` 存在按 revision 绑定的伴随文件（不进 wire 的字段闭集），台账 `reason`
  存在运行旁注（行仍是三键）；bundle 的 N-1 兼容门（`tools/lib/n-minus-one-compat.sh`）必须全过。
- 完整工作区指纹与可移植指纹一样跳过未被 git 跟踪的 `.claude/worktrees/`；宿主本地文件（`.claude/settings.local.json`、`CLAUDE.local.md`）
  在完整指纹里照算（Task 15）。

## Review Focus

1. **`~/.claude` 是符号链接**（dotfiles 管理器常见）：安装应正常写入；只拒绝「目标文件本身是符号链接」。→ Task 3 测试。
2. **链式命令**：`cd x && tenon transition demo explore-complete 2>&1 | tail -5`、`tenon step run demo --json > f` 都要识别出 `demo`；`tenon status demo` 不打印。→ Task 2 测试。
3. **用户级清单损坏**：不得删除或覆盖任何已存在文件，只写不存在的文件并 WARN。→ Task 3 测试。
4. **旧任务没有冻结计划或 projection**：`tenon workflow progress` 以 exit 1 结束且 stdout 为空，hook 不输出。→ Task 1、Task 2 测试。
5. **用户级 agents 目录不存在**（首次安装前派发）：prompt 返回 `not-installed`，不抛错、不创建目录。→ Task 5 测试。
6. **用户切了分支**（`start_sha` 不再是 HEAD 的祖先）：`start_sha` 不入选，按其余候选取起点，不报错。→ Task 8 测试。
7. **建 worktree 中途失败**（`initChange` 抛错）：worktree 目录与 `tenon/<c>` 分支都被回滚，主检出无残留。→ Task 9 测试。
8. **任务名在 `.worktrees/` 里已有同名目录但不是 worktree**：报冲突退出，不覆盖该目录。→ Task 9 测试。
9. **测试目录没有 `setup`**：老目录的信任摘要与改动前逐字相同，已有信任不失效。→ Task 10 测试。
10. **退回边与前进边判定不一致**：`requirements-changed` 放行的同时 `build-complete` 仍因缺 TDD 被拒，CLI 与 HTTP 结果一致。→ Task 13 测试。
11. **同仓另一个会话在 `.claude/worktrees/` 下工作**：主检出原地任务 build-complete 之后，那里新增或修改未跟踪文件，构建版本复核仍可信；
    该目录里有读不了的子目录也不影响算指纹（遍历不进入）。→ Task 15 测试。
12. **`CLAUDE_CONFIG_DIR` 写成相对路径、带首尾空白或末尾斜杠**：相对路径与空值不采用（回到 `~/.claude`），空白与末尾斜杠去掉后照常采用，
    安装与 prompt 解析出同一个目录。→ Task 16 测试。
13. **同一台机器先后在两个配置目录安装**（终端没有变量、会话里有）：在一个目录上安装或卸载，另一个目录里 Tenon 写的文件不被删除、
    不被当成「库里已删除」回收。→ Task 16 测试。
14. **测试进程继承了开发机的 `CLAUDE_CONFIG_DIR`**（在本机 Claude 会话里跑 `npm test`）：任何用例都不读写那个真实目录。→ Task 16 测试。

---

### Task 1: 步骤清单纯函数与 `tenon workflow progress`

**Files:**
- Create: `packages/kernel/src/workflow/step-progress.ts`、`packages/kernel/src/workflow/step-progress.test.ts`
- Modify: `packages/kernel/src/index.ts`（导出）、`packages/cli/src/program-workflows.ts`（注册子命令）
- Create: `packages/cli/src/commands/workflow-progress.ts`、`packages/cli/src/commands/workflow-progress.test.ts`

**Interfaces:**
- Produces: `stepProgressLine(steps: readonly { readonly id: string; readonly label: string }[], current: string, archived: boolean): string`；
  `cmdWorkflowProgress(deps: CliDeps, name: string): Promise<number>`（stdout 一行，成功 0；名字非法、读不到状态、计划为 null、projection 为空 → exit 1、stdout 为空）。

- [ ] **Step 1: 写失败测试** `step-progress.test.ts`：
  - 默认七步、current=`spec` → `'立项 ✓ → 调研 ✓ → 规格 ● → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○'`
  - 三步 `shape/implement/verify`、current=`implement` → `'shape ✓ → implement ● → verify ○'`（label 取步骤 label）
  - archived=true → 全部 `✓`
  - current 不在步骤里 → 全部 `○`
- [ ] **Step 2:** `npx vitest run packages/kernel/src/workflow/step-progress.test.ts`，预期 FAIL（模块不存在）。
- [ ] **Step 3:** 实现 `stepProgressLine`，从 `index.ts` 导出。
- [ ] **Step 4:** 写 `workflow-progress.test.ts`（仿 `workflow-plan.test.ts` 的 `stateWithSnapshot` 与 `makeDeps`）：冻结默认计划、phase=`explore` → stdout 恰为一行 `立项 ✓ → 调研 ● → …`；`fields.archived='true'` → 全 ✓；`runMetadata` 无快照且 workflow 未知 → exit 1、stdout 空。
- [ ] **Step 5:** 实现 `cmdWorkflowProgress`：读状态与计划同 `cmdWorkflowPlan`（`effectiveWorkflowForState`），取 `plan.projection.steps`、`fields.phase`、`fields.archived === 'true'`；在 `registerWorkflowCommands` 注册 `progress <change>`，描述「输出一行步骤清单（✓ 已过 / ● 当前 / ○ 未到）」。
- [ ] **Step 6:** 两个测试文件都 PASS。

### Task 2: `step-progress` hook

**Files:**
- Create: `hooks/step-progress.sh`（可执行）
- Modify: `hooks/hooks.json`（PostToolUse 新条目）、`tools/test-hooks.sh`（新小节）
- Check: `packages/cli/src/runtime/release-payload.ts` 的 hooks 校验是否需要登记新文件名（需要就补，并跑其测试）

**Interfaces:**
- Consumes: Task 1 的 `tenon workflow progress <change>`。
- Produces: hook id `step-progress`。

- [ ] **Step 1: 写失败测试**（`tools/test-hooks.sh` 新小节，输入用 `printf '{"tool_name":"Bash","cwd":"%s","command":"…"}'`，并在 `PATH` 前置一个桩 `tenon` 脚本：收到 `workflow progress demo` 时输出 `立项 ✓ → 调研 ●`、其余 exit 1）：
  - `tenon transition demo explore-complete` → 输出含 `"systemMessage"`、`Tenon · demo`、`立项 ✓ → 调研 ●`，exit 0
  - `cd /x && tenon transition demo explore-complete 2>&1 | tail -5` → 同上
  - `tenon step run demo --json > /tmp/s.json`、`tenon init demo --workflow default --track backend --preset full`、`tenon session activate demo --host-session abc` → 都输出
  - `tenon status demo --json`、`git status`、`tenon transition`（无名字）→ 空输出
  - `tool_name` 为 `Read` → 空输出
  - 桩 `tenon` 对 `workflow progress` exit 1 → 空输出、exit 0
  - 输出整体能被 `node -e 'JSON.parse(...)'` 解析
- [ ] **Step 2:** `bash tools/test-hooks.sh`，新小节 FAIL（文件不存在）。
- [ ] **Step 3:** 实现 `step-progress.sh`：source `json-input.sh`；`pipeline_json_is_command_tool` 不过就 exit 0；`pipeline_json_get_command_bounded` 取命令；bash 正则 `(^|[;&|(][[:space:]]*|[[:space:]])tenon[[:space:]]+(init|session[[:space:]]+activate|transition|step[[:space:]]+run)[[:space:]]+([a-z0-9][a-z0-9-]*)` 取名字；命中后在 `pipeline_json_get_cwd` 目录下执行 `tenon workflow progress <name>`（`command -v tenon` 不在就退出），stdout 非空才用 `pipeline_json_escape` 输出 `{"systemMessage":"Tenon · <name>\n<line>"}`。
- [ ] **Step 4:** 在 `hooks/hooks.json` 的 `PostToolUse` 新增 `{"matcher":"Bash","hooks":[{"type":"command","command":"bash \"${HOME}/.local/bin/tenon-hook\" step-progress","timeout":5}]}`。
  不加 `if` 过滤：`Bash(tenon *)` 是前缀规则，会把 `cd x && tenon transition …`、`zsh -lc "tenon …"` 挡在脚本之外（Review Focus 2）；
  `tools/test-hooks.sh` 断言该条目没有 `if`。（实现时曾加过 `if`，验证前审查发现后去掉。）
- [ ] **Step 5: Codex 兼容实测**：用本机 Codex 加载该 hooks.json（`codex` 启动后看 `/hooks` 或日志是否报 schema 错误），确认新条目被接受。
- [ ] **Step 6:** `bash tools/test-hooks.sh` 全过；若改了 release-payload 校验，跑 `npx vitest run packages/cli/src/runtime/release-payload.test.ts`。

### Task 3: kernel 用户级安装与卸载

**Files:**
- Create: `packages/kernel/src/infrastructure/host-agent-install.ts`、`host-agent-install.test.ts`
- Modify: `packages/kernel/src/index.ts`（导出新接口）

**Interfaces:**
- Consumes: `renderHostAgent`、`hostAgentPath`、`hostAgentName`、`computeContentHash`、`withLock`（现有）。
- Produces:
  ```ts
  type HostInstallState = 'written' | 'unchanged' | 'foreign' | 'modified' | 'removed' | 'preserved' | 'failed'
  interface HostInstallOutcome { readonly agent: string; readonly path: string; readonly state: HostInstallState; readonly detail?: string }
  installHostAgents(input: { homeDir: string; configRoot: string; host: HostAgentHost;
    agents: readonly { name: string; definition: AgentDefinition }[] }): Promise<readonly HostInstallOutcome[]>
  uninstallHostAgents(input: { homeDir: string; configRoot: string; host: HostAgentHost }): Promise<readonly HostInstallOutcome[]>
  userHostAgentPath(homeDir: string, host: HostAgentHost, name: string): string   // 绝对路径
  ```

- [ ] **Step 1: 写失败测试**（临时目录作 homeDir 与 configRoot）：
  - 安装两个 agent → 两个文件内容等于 `renderHostAgent`，`host-owned.json` 记两条，结果 `written`
  - 再装一次 → 全 `unchanged`，mtime 不变
  - 目标已有用户自写同名文件 → 内容不变、`foreign`
  - 清单记着但被改过 → 不覆盖、`modified`
  - 第二次安装少一个 agent → 少的那个文件被删、`removed`；若它被改过 → 保留、`preserved`
  - `homeDir/.claude` 是指向另一临时目录的符号链接 → 正常写入（Review Focus 1）
  - 目标文件本身是符号链接 → `failed`，链接目标不被改写
  - `host-owned.json` 内容非法 JSON → 已有文件一律不改不删，只写不存在的文件，结果带 `detail` 说明清单损坏（Review Focus 3）
  - `uninstallHostAgents` → 未改动的删除（`removed`）、改过的保留（`preserved`），清单只剩保留项；`.claude/agents` 空了不删 `.claude`
  - `host: 'codex'` → 写 `~/.codex/agents/tenon-<name>.toml`
- [ ] **Step 2:** `npx vitest run packages/kernel/src/infrastructure/host-agent-install.test.ts`，FAIL。
- [ ] **Step 3:** 实现。锁目录 `<configRoot>/agents/.host-owned.lock`（`withLock`）；原子写沿用 tmp+rename；符号链接只检查目标文件（`lstat`）。
- [ ] **Step 4:** 测试 PASS。

### Task 4: `tenon agent install|uninstall` 与 setup/update 接入

**Files:**
- Modify: `packages/cli/src/deps.ts`（`agentPaths` 返回值加 `homeDir: string`）、`packages/cli/src/main.ts:232`（`homeDir: homedir()`）、`packages/cli/src/integration-harness-agents.ts:20`（临时 homeDir）
- Create: `packages/cli/src/commands/agent-install.ts`、`agent-install.test.ts`
- Modify: `packages/cli/src/program-agents.ts`（注册 `install` / `uninstall`，`--host <claude|codex>`）
- Modify: `packages/cli/src/commands/agent-library.ts`（`cmdAgentAdd/Copy/Rm` 成功后提示）、`agent-new.ts`（同）
- Modify: `packages/cli/src/commands/setupHost.ts`（native 分支 `configureAutoUpdate` 前）、`packages/cli/src/commands/update.ts`（`runNativeUpdate` 返回 0 后）

**Interfaces:**
- Consumes: Task 3 的 `installHostAgents` / `uninstallHostAgents`；`loadLibrary(deps)`。
- Produces: `cmdAgentInstall(deps, opts: { host?: string }): Promise<number>`、`cmdAgentUninstall(deps, opts: { host?: string }): Promise<number>`；
  `--host` 缺省时按 `hostAgentHostOf(deps)`，终端里缺省为 `claude`。

- [ ] **Step 1: 写失败测试** `agent-install.test.ts`（`makeDeps` + 临时 `agentPaths`）：
  - 库含官方 `researcher`、自定义 `my-reviewer`、项目层 `team-lint` → 只装前两个；输出每个文件一行与「开新会话后生效」
  - 定义 `hosts: ['codex']` 的 agent 在 `--host claude` 下不安装
  - 有 `foreign` / `modified` 结果时 exit 仍为 0，输出 WARN
  - `--host gemini` → exit 1
  - uninstall 输出删除与保留清单
  - `cmdAgentAdd` 与 `cmdAgentNew` 成功后 stderr 都含 `执行 tenon agent install --host`，宿主目录无新文件
  - 当前项目 `.tenon/agents` 有与官方 `researcher` 同名的覆盖：安装仍按官方定义写 `tenon-researcher.md`；之前装过的该文件不被删除
- [ ] **Step 2:** 跑测试，FAIL。
- [ ] **Step 3:** 实现命令与注册；库只加载官方层与自定义层（调用 `loadAgentLibrary` 时不传项目根，不用依赖当前项目的 `loadLibrary(deps)`），
  条目取 `entry.definition !== undefined`。
- [ ] **Step 4: setup/update 接入**：在新 runtime 激活后用子进程调用稳定启动器执行 `agent install --host <host>`（路径取 runtime paths 里的 `tenon` 启动器，与 `tenon-hook` 同目录），让新版本的官方定义参与渲染；失败只 WARN，不改变 setup/update 的退出码。先列出全部成功出口再逐个接入：`setupHost.ts` 的 native 分支（:297）与 adapter 分支（:322）、`update.ts` 的每个返回 0 的路径（含「已是最新版」）；能收敛到一个成功出口就只接一处。每个出口各一条测试（注入 `runCommand` 桩，断言参数为 `['agent','install','--host','claude']`），「已是最新版」再加一条用临时 HOME 的集成断言：结束后 `~/.claude/agents/tenon-builder.md` 存在。
- [ ] **Step 5:** 跑 `npx vitest run packages/cli/src/commands/agent-install.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/update.test.ts`，PASS。

### Task 5: 派发判定

**Files:**
- Create: `packages/kernel/src/infrastructure/host-subagent-resolve.ts`、`host-subagent-resolve.test.ts`
- Modify: `packages/kernel/src/state/agent-runs.ts:51`（`AgentRunSubagent` 加可选 `reason`；`decodeSubagent`（:112）接受键集合 `host,native,type` 或 `host,native,reason,type`、`reason` 只取闭集值；编码端同步）、`packages/kernel/src/index.ts`
- Test: `packages/kernel/src/state/agent-runs.test.ts`（带 `reason` 的行可读写往返；未知 `reason` 值的行仍被拒；不带 `reason` 的旧行逐字不变）
- Modify: `packages/cli/src/commands/agent.ts:64-130`（删 `prepare` 里的 `ensureChangeHostAgents`，改用判定；JSON 加 `reason` 与 `hint`）
- Test: `packages/cli/src/agent-host.integration.test.ts`、`task-host-agents.integration.test.ts`（按新行为改写）

**Interfaces:**
- Consumes: Task 3 的 `userHostAgentPath`；`renderHostAgent`、`hostAgentPath`。
- Produces:
  ```ts
  type HostSubagentReason = 'not-installed' | 'definition-mismatch' | 'shadowed' | 'project-agent'
  resolveHostSubagent(input: { homeDir: string; projectRoot: string; host: HostAgentHost; agent: FrozenAgent }):
    Promise<{ type: string; native: boolean; reason?: HostSubagentReason }>
  ```
  `AgentRunSubagent` 变为 `{ host; type; native; reason?: HostSubagentReason }`。

- [ ] **Step 1: 写失败测试**（覆盖 delta spec「派发 SHALL 只在已装文件与冻结定义一致时使用专属子代理」五个场景）：一致 → `tenon-researcher`/native；用户目录不存在 → `not-installed` 且不创建目录（Review Focus 5）；内容不同 → `definition-mismatch`；项目级同名文件内容不同 → `shadowed`；项目级同名文件内容相同 → native；`agent.source === 'project'` → `project-agent`；在 linked worktree 里判定、内容不同的同名旧文件只在主检出的 `.claude/agents` 里 → `shadowed`（`resolveHostSubagent` 同时检查 `projectRoot` 与按 git common dir 找到的主检出）。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现 `resolveHostSubagent`（只读）。
- [ ] **Step 4:** 改 `cmdAgentPrompt`：`subagent = { host, ...await resolveHostSubagent({ homeDir: paths.homeDir, projectRoot: deps.cwd, host, agent: frozen }) }`；`agent.ts` 的 `usedSubagent`（:229）在 `--subagent <type>` 改写类型时保留 prompt 给出的 `reason`；JSON 输出增加 `reason`（无则 `null`）与 `hint`（native 时 `null`，否则安装提示原文）；`run_on` 非空时仍不记 subagent。改写两个集成测试：断言 prompt 后 `.claude/agents/` 与临时 homeDir 下都没有新文件；装好后 native；未装时台账 `subagent.reason === 'not-installed'`。
- [ ] **Step 5:** 跑 `npx vitest run packages/kernel/src/infrastructure/host-subagent-resolve.test.ts packages/cli/src/agent-host.integration.test.ts packages/cli/src/task-host-agents.integration.test.ts packages/cli/src/next-action-runner.integration.test.ts`，PASS。

### Task 6: 旧项目级文件清理，删除会话内生成

**Files:**
- Modify: `packages/kernel/src/infrastructure/host-agent-files.ts`（删 `ensureHostAgentFiles`、`ownedHostAgentNames`、`pruneHostAgentFiles` 的导出用途，改为 `cleanupLegacyHostAgents`）、`host-agent-prune.ts`（删除文件）、对应测试改写
- Modify: `packages/cli/src/commands/agent-host.ts`（删 `ensureChangeHostAgents`、`fallbackOutcome`、`pruneHostAgents` → 新 `cleanupLegacyHostAgentFiles(deps)`）、`init.ts:47-55,325`、`transition.ts:226-232`、`task-lifecycle.ts:34-43`
- Modify: `packages/server/src/hostAgentPrune.ts`、`transition.ts:301`、`serverTaskLifecycleRoutes.ts`（调用新清理，去掉 `isArchived` 回调依赖）及其测试

**Interfaces:**
- Produces: `cleanupLegacyHostAgents(input: { repoRoot: string; renderCurrent?: (host: HostAgentHost, name: string) => string | undefined }): Promise<{ removed: readonly string[]; preserved: readonly string[] }>`

- [ ] **Step 1: 写失败测试**（覆盖 delta spec「旧版本写入的项目级宿主子代理文件 SHALL 被清理」三个场景）：清单记着未改 → 删除并移除清单项、清单空则删 `.pipeline-owned.json`；不在清单但内容等于 `renderCurrent` → 删除；清单记着已改 → 保留进 `preserved`；不在清单且内容不同 → 保留；`renderCurrent` 缺省（服务端）只按清单删；在主检出的 linked worktree 里调用（`repoRoot` 为 worktree）→ 清理的是主检出的旧文件（实现里用 `git rev-parse --path-format=absolute --git-common-dir` 的上一级定位主检出）。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现并替换全部调用点：`tenon init` 冻结 agent 后调用（替代 `generateHostAgents`）；CLI 归档与删除、服务端归档与删除改调新函数；CLI 传入基于 `loadLibrary` 的 `renderCurrent`。失败只 WARN。
- [ ] **Step 4:** 改写 `host-agent-files.test.ts`、删除 `host-agent-prune.test.ts`、改写 `packages/server/src/hostAgentPrune.test.ts` 与 `serverTaskLifecycleRoutes.test.ts` 中的回收断言；新增断言：会话内 `tenon init` 后 `.claude/agents/` 无新增文件。
- [ ] **Step 5:** `npm test` 全量 PASS；`npx tsc -b`（或仓库既有类型检查脚本）无错。

### Task 7: skill 与文档

**Files:**
- Modify: `skills/tenon/SKILL.md`（「进入」第 5 步、动作表 `run-agent` 行）
- Modify: `docs/usage/agents.md`、`docs/usage/zh-CN/agents.md`

- [ ] **Step 1:** 第 5 步改为：「宿主提供 Todo 工具（TaskCreate / TodoWrite）时用 `tenon workflow plan <c> --json` 的步骤标签建 Todo，当前项取 `current_step`；没有就跳过——终端步骤清单由 hook 打印。」
- [ ] **Step 2:** `run-agent` 行把「宿主说找不到这个子代理（会话中途才生成的）…」改为「`subagent_type` 是通用类型时返回里带 `reason` 与 `hint`，照用即可并把 `hint` 转告用户；派发仍报找不到时改用通用子代理跑同一份提示词，登记时加 `--subagent <实际用的类型>`」。
- [ ] **Step 3:** 文档写明：安装命令与用户级位置、开新会话生效、四个退回原因、项目层 agent 走通用子代理、`tenon agent uninstall`。
- [ ] **Step 4:** 跑 `node tools/check-docs.mjs` 与 `bash tools/verify-skills.sh`（若存在对应 npm 脚本则用脚本），PASS。

### Task 8: 任务起点记录并跟随上游

**Files:**
- Modify: `packages/kernel/src/types.ts`（`FIELD_ORDER` 末尾追加 `'start_sha'`；`InitOptions` 增加 `startSha?: string`、`baseBranch?: string`、`isolation?: 'worktree'`）
- Modify: `packages/kernel/src/state/omit-when-empty-fields.ts`（`OMIT_WHEN_EMPTY_FIELDS = ['max_rounds', 'start_sha']`）
- Modify: `packages/kernel/src/state/state-init.ts`、`packages/kernel/src/state/store.ts`（`init` 用 `opts.baseBranch ?? detectBaseBranch()`，写 `start_sha = opts.startSha ?? ''`、`isolation = opts.isolation ?? 'null'`）
- Modify: `packages/kernel/src/workspace/changed-files.ts`（`ChangeStartInput.startSha?`、`changeStartOfFields`、`computeStart`、缓存键）
- Modify: `packages/cli/src/commands/field-values.ts`（`TRANSITION_MANAGED_FIELDS` 加 `start_sha`、`base_branch`、`created_at`）、`packages/cli/src/commands/fields.ts`（新消息 `field.managedByInit`）与 i18n 词条
- Modify: `packages/cli/src/commands/init.ts`（原地 init 也传 `startSha: await deps.gitHeadSha()`；仓库无提交时不传）
- Modify: `packages/server/src/serverPostChangesRoutes.ts:235`（Dashboard 建任务同样传 `startSha`，仍原地建立）
- Modify: `packages/automation/src/triage/workflow-run-create-repository.ts:376`（triage 物化调 `runRepository.initChange` 时同样传 `startSha`，取仓库 HEAD；
  测试在 `workflow-run-create-repository.test.ts` 加一条：物化出的任务带 `start_sha` 且等于临时仓 HEAD）
- Modify: `docs/CONTRACT.md`（字段说明加 `start_sha`：建任务写入、空值不落盘、`tenon set` 拒写；存储与 N-1 兼容见下方「实现修订」）
- 实现修订（build 中 bundle 的 N-1 兼容门发现）：`start_sha` 若写进 wire 的 `state.fields`，v0.3.1 按字段闭集读不了任何新任务。改为与
  `review_acknowledged_via` 同机制的伴随文件 `packages/kernel/src/state/start-sha-store.ts`（`.pipeline-run/start-sha/<rev6>-<revisionId>.json`，
  绑 revision、revisionId 与 `stateDigest`，先于 revision 发布，没有记录读作空），`COMPANION_BACKED_FIELDS` 加入 `start_sha`；
  `change-start.ts` 读取时另要求 `start_sha` 的提交者时间不晚于 `created_at` + 60 秒（伴随文件的值不在摘要里，改写或删除只会让改动范围变宽）。
  测试：`start-sha-store.test.ts`、`changed-files.test.ts` 的时间校验用例、bundle 的 N-1 兼容门。
- Test: `packages/kernel/src/workspace/changed-files.test.ts`、`packages/kernel/src/state/store.test.ts`、`packages/cli/src/commands/fields.test.ts`
- Test（同步改断言）：`packages/kernel/src/types.test.ts:60`（`FIELD_ORDER.at(-1)` 改为 `'start_sha'`）、`packages/kernel/src/state/parse.test.ts`、
  `packages/kernel/src/state/run-revision-store.test.ts`、oracle 夹具 `tools/oracle/fixtures/default-effects.sh`（按 `npm run oracle` 的失败点逐个更新）

**Interfaces:**
- Produces: `ChangeStartInput = { baseBranch: string; createdAt: string; startSha?: string }`；`changeStartOfFields(fields)` 读 `start_sha`；
  `InitOptions.startSha / baseBranch / isolation`（Task 9 用）。

- [ ] **Step 1: 写失败测试**（`changed-files.test.ts`，临时目录建 bare 仓 `origin.git` 与工作仓，`main` 跟踪 `origin/main`）：
  - 快进拉取：建任务（`startSha=A`，有未提交改动 `src/mine.ts`）→ 另一个克隆推送提交 B（改 `src/other.test.ts`）→ 工作仓 `git pull --ff-only`
    → `changedFilesSinceChangeStart` 只含 `src/mine.ts`
  - 建任务前已有本地未推送提交 C → 建任务时 `startSha=C` → C 的文件不在结果里
  - 建任务后本地提交 D（未推送）→ D 的文件在结果里
  - 没有 `startSha`、有上游且 HEAD 与上游一致 → 只含未提交改动
  - `startSha` 不是 HEAD 的祖先（切到另一分支）→ 不报错，按其余候选取（Review Focus 6）
  - 两个候选不成链（构造 HEAD 为合并提交，`startSha` 在一侧、上游 merge-base 在另一侧）→ 起点为二者的 merge-base
  - 第 65-76 行原用例（无 `startSha`、无上游）保持通过
  - 已知限制（原地任务把自己的提交推到 base 上游后不再算）写成一条断言当前行为的用例，用例名写明「已知限制」
  - `statusStepParts` 的字段写入投影：三字段加入 `TRANSITION_MANAGED_FIELDS` 后，default 工作流各步的 `next` 输出不变（对一个 fixture 任务比对前后）
  - `store.test.ts`：`init({ ..., startSha: 'abc…', baseBranch: 'main', isolation: 'worktree' })` 写入三字段；不传时 `start_sha` 不出现在投影里
  - `fields.test.ts`：`tenon set demo start_sha x`、`set demo base_branch dev`、`set demo created_at 2030-…`、`set-many`、`cas` 均 exit 非零且值不变
  - `packages/server/src/snapshot.test.ts`（快照改动扫描用例旁）：同一个「快进拉取」临时仓，快照给出的改动文件与待批准受保护配置与 CLI 的
    `changedFilesForState` / `readProtectedChanges` 结果相同
- [ ] **Step 2:** `npx vitest run packages/kernel/src/workspace/changed-files.test.ts packages/kernel/src/state/store.test.ts packages/cli/src/commands/fields.test.ts`，新用例 FAIL。
- [ ] **Step 3: 实现 `computeStart`**（会话内已有 `gitText`；新增 `gitOk(args): Promise<boolean>` 按退出码判定）：

```ts
async function computeStart(input: ChangeStartInput): Promise<string> {
  const { head } = await repository()
  if (head === undefined) return EMPTY_TREE
  const candidates: string[] = []
  const recorded = usableSha(input.startSha)
  if (recorded !== undefined && await gitOk(['merge-base', '--is-ancestor', recorded, head])) candidates.push(recorded)
  const base = usableBase(input.baseBranch)
  if (base !== undefined) {
    const upstream = (await gitText(['rev-parse', '--verify', '--quiet', `${base}@{upstream}`]))?.trim()
    if (upstream) {
      const viaUpstream = (await gitText(['merge-base', 'HEAD', upstream]))?.trim()
      if (viaUpstream) candidates.push(viaUpstream)
    }
    const viaBase = (await gitText(['merge-base', 'HEAD', base]))?.trim()
    if (viaBase && viaBase !== head) candidates.push(viaBase)
  }
  if (candidates.length > 0) return newestOrCommonAncestor(candidates)
  // 以下为现有的按时间推算，逐字保留
  ...
}

async function newestOrCommonAncestor(candidates: readonly string[]): Promise<string> {
  let best = candidates[0]!
  for (const next of candidates.slice(1)) {
    if (next === best || await gitOk(['merge-base', '--is-ancestor', next, best])) continue
    if (await gitOk(['merge-base', '--is-ancestor', best, next])) { best = next; continue }
    best = (await gitText(['merge-base', best, next]))?.trim() || EMPTY_TREE
  }
  return best
}
```

  `usableSha` 只接受 `/^[0-9a-f]{40}([0-9a-f]{24})?$/`；`resolveStart` 缓存键改为 `` `${baseBranch}\0${createdAt}\0${startSha ?? ''}` ``。
- [ ] **Step 4:** 实现 store / state-init / init / Dashboard 路由 / 只读字段 / CONTRACT；跑 Step 2 的命令全 PASS；再跑 `npx vitest run packages/kernel/src/workspace packages/kernel/src/test-system packages/kernel/src/types.test.ts packages/kernel/src/state` 与 `npm run oracle`，无回归。

### Task 9: `tenon init` 建任务 worktree

**Files:**
- Create: `packages/kernel/src/workspace/task-worktree.ts`、`task-worktree.test.ts`；`packages/kernel/src/index.ts` 导出
- Modify: `packages/cli/src/commands/init.ts`（`cmdInit` 流程、`--in-place`、输出）、`packages/cli/src/program.ts`（注册 `--in-place`）
- Modify: `tools/vitest.isolate-runtime-home.mjs`（`process.env.TENON_INIT_IN_PLACE = '1'`）、`tools/test-bundle.sh`、`tools/test-hooks.sh`、`tools/test-adapters.sh`（开头 `export TENON_INIT_IN_PLACE=1`）
- Test: `packages/cli/src/commands/init.test.ts`（新增 worktree 用例）

**Interfaces:**
- Consumes: Task 8 的 `InitOptions.startSha / baseBranch / isolation`。
- Produces:
  ```ts
  type GitRunner = (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>
  type TaskWorktreePlan =
    | { kind: 'create'; repoRoot: string; path: string; branch: string; sourceBranch: string; head: string }
    | { kind: 'in-place'; reason: 'not-git' | 'no-commits' | 'detached-head' | 'linked-worktree' | 'requested' }
  planTaskWorktree(input: { repoRoot: string; change: string; inPlace: boolean; git: GitRunner }): Promise<TaskWorktreePlan>
  createTaskWorktree(plan: Extract<TaskWorktreePlan, { kind: 'create' }>, git: GitRunner): Promise<void>   // 冲突抛 TaskWorktreeConflictError
  rollbackTaskWorktree(plan: Extract<TaskWorktreePlan, { kind: 'create' }>, git: GitRunner): Promise<void>
  ```
  `cmdInit` 的 `--json` 输出增加 `worktree: string | null` 与 `worktree_reason: string | null`。

- [ ] **Step 1: 写失败测试**（`task-worktree.test.ts`，临时 git 仓）：
  - `main` 上有提交 → `kind:'create'`，`path=<repo>/.worktrees/demo`、`branch='tenon/demo'`、`sourceBranch='main'`、`head` 为 HEAD
  - 非 git 目录 → `not-git`；`git init` 无提交 → `no-commits`；`git checkout --detach` → `detached-head`；在 `git worktree add` 出的目录里 → `linked-worktree`；`inPlace:true` → `requested`
  - `createTaskWorktree` 后 `git worktree list --porcelain` 含该路径与 `refs/heads/tenon/demo`
  - 分支 `tenon/demo` 已存在 → 抛 `TaskWorktreeConflictError`，`.worktrees/demo` 不存在
  - `.worktrees/demo` 已是普通目录 → 抛冲突，目录内容不变（Review Focus 8）
  - 临时仓 `.gitignore` 不含 `.worktrees/` → 建完后 `.git/info/exclude` 含 `.worktrees/`，`git status --short` 为空
  - `init.test.ts`：主检出执行 `cmdInit(demo)` → `.worktrees/demo/openspec/changes/demo/.pipeline.yaml` 存在，`base_branch: main`、`isolation: worktree`、`start_sha` 为 HEAD；主检出无 `openspec/changes/demo`
  - 注入让 `initChange` 抛错 → worktree 与分支都不存在（Review Focus 7）
  - 主检出没有测试目录时（触发自动发现）建任务：目录写进 `.worktrees/demo/.tenon/tests/catalog.yaml`，主检出 `git status --short` 为空；
    项目登记的是 worktree 路径
  - 主检出 `.pipeline/workflows/` 里的自定义工作流 `lite`：`cmdInit(demo, --workflow lite)` 成功，worktree 里的任务冻结的是 `lite`
  - `TENON_INIT_IN_PLACE=1` 与 `--in-place` 各一条：原地建立，`isolation` 不预设
  - 并行互不污染：主检出先后 `cmdInit(a)`、`cmdInit(b)`，在 `.worktrees/a` 里新增并修改 `src/a.test.ts` → 以 b 的状态调
    `changedFilesForState(<.worktrees/b>, stateB)` 结果不含 `src/a.test.ts`
- [ ] **Step 2:** `npx vitest run packages/kernel/src/workspace/task-worktree.test.ts packages/cli/src/commands/init.test.ts`，FAIL。
- [ ] **Step 3:** 实现 `task-worktree.ts`：判定用 `rev-parse --is-inside-work-tree`、`rev-parse --verify -q HEAD`、`symbolic-ref -q --short HEAD`、
  比较 `rev-parse --path-format=absolute --git-dir` 与 `--git-common-dir`；创建用
  `git -c branch.autoSetupMerge=false worktree add -b tenon/<c> <path> HEAD`；回滚用 `worktree remove --force <path>` 与 `branch -D tenon/<c>`；
  排除用 `check-ignore -q .worktrees/` 判定后追加 `.git/info/exclude`（在主检出的 common-dir 下）。
- [ ] **Step 4:** 改 `cmdInit`：先 `planTaskWorktree`（`inPlace` 取 `--in-place` 或 `TENON_INIT_IN_PLACE === '1'`），`create` 时建好再以
  `plan.path` 为 `repoRoot` 调 `initChange`（传 `startSha/baseBranch/isolation`），失败回滚后原样抛出；`in-place` 时照旧并输出原因
  （只由 `TENON_INIT_IN_PLACE=1` 触发时不输出，测试工装约定；`--in-place` 与其余原因都输出）。
  工作流与 track 注册表、计划解析仍用主检出的 `deps`；`announceAutoDiscover`、`registerProject`、本机排除与其后读写状态的步骤改用
  `{ ...deps, cwd: plan.path }`。文本输出末尾两行：`worktree: <path>` 与「Claude Code：EnterWorktree path=<path> 后执行 tenon session activate；Codex：在该目录开新会话」。
- [ ] **Step 5:** 全局 setup 与 shell 测试导出 `TENON_INIT_IN_PLACE=1`（本任务新增的 worktree 用例在用例内删掉它）；跑 Step 2 命令 PASS，
  再跑 `npm test`、`npm run test:hooks`、`TENON_TAP_OUT=test-results/bundle.tap bash tools/test-bundle.sh` 确认既有测试与 N-1 兼容检查无回归。

### Task 10: 信任继承与工作区准备

**Files:**
- Modify: `packages/kernel/src/test-system/catalog.ts`（schema 增加可选顶层 `setup: string`；`catalogExecDigest` 仅在 `setup` 存在时纳入）及目录解析与校验处
- Modify: `packages/cli/src/commands/init.ts`（建 worktree 后：复制信任条目、执行 `setup`）
- Modify: `.tenon/tests/catalog.yaml`（本仓 `setup: npm ci`；先在临时 worktree 手动验证 `npm ci` 后 `npm test` 能跑，若还需构建产物则写成 `npm ci && npm run build`）
- Test: `packages/kernel/src/test-system/catalog.test.ts`、`packages/cli/src/commands/init.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `TaskWorktreePlan`；`readTestSeal(repoRoot, slug)`、`updateTestSeal(repoRoot, slug, mutate)`、`isTrusted(seal, digest)`、`catalogExecDigest(catalog)`。
- Produces: `inheritTrust(input: { from: string; to: string; slug: string }): Promise<number>`（返回复制的条目数，只复制 `trusted`）。

- [ ] **Step 1: 写失败测试**：
  - `catalog.test.ts`：没有 `setup` 的目录，`catalogExecDigest` 与改动前的固定值逐字相同（Review Focus 9，用现有 fixture 先算出期望值写死）；加 `setup` 后摘要变化；`setup` 非字符串 → 校验报错
  - `init.test.ts`：主检出 seal 有信任条目 → 新 worktree 的 seal `trusted` 含同一摘要、`approvals` 与 `writes` 为空
  - 目录受信任且 `setup: 'node -e "require(\'fs\').writeFileSync(\'setup-ran\',\'1\')"'` → `.worktrees/demo/setup-ran` 存在
  - 目录未受信任 → 不执行，输出含「未受信任」与 `tenon test trust` 提示
  - `setup` 退出码 1 → `cmdInit` 返回 0，输出含 WARN 与 `cd <path> && <setup>`
  - 在 `.worktrees/demo` 里改了某套件命令 → 该 worktree 里 `ensureTrusted` 判为未信任；主检出的 seal 不变
  - 主检出目录有未提交改动并已在主检出信任 → 新 worktree 的目录为 HEAD 版本、判为未信任，`setup` 不执行，输出提示
- [ ] **Step 2:** 跑上面两个测试文件，FAIL。
- [ ] **Step 3:** 实现 schema、摘要、`inheritTrust`、`setup` 执行（`spawn(setup, { shell: true, cwd: plan.path, stdio: 'inherit' })`，经 deps 注入以便测试替换）。
- [ ] **Step 4:** 改本仓 `catalog.yaml`；PASS 后跑 `npm test`。提醒用户：目录摘要变化后需要本人在终端重新执行 `tenon test trust`。

### Task 11: 从主检出找到 worktree 任务；skill 与完结清理

**Files:**
- Create: `packages/kernel/src/workspace/task-worktree-list.ts`、`task-worktree-list.test.ts`（`listTaskWorktrees`）
- Modify: `packages/cli/src/commands/status.ts`（`cmdList` 加 `WORKTREE` 列与 JSON `worktree`；按名读取的 `change.notFound` 报错附路径，经 `packages/cli/src/paths.ts` 的共用解析）
- Modify: `hooks/router.sh`（候选再遍历 `$PROOT/.worktrees/*/openspec/changes/*`；点名任务只在 worktree 时 dispatch 输出 `worktree_path: <abs>`）、`tools/test-hooks.sh`（新小节）
- Modify: `packages/cli/src/commands/statusStepFinish.ts`（`StepFinishFacts` 增加 `worktree?: { path: string; branch: string }`，由读取状态处按
  `isolation=worktree` 与当前根填入；`finish-change` 动作与工作区干净时的 `finishedStop` 都带 `cleanup`）
- Modify: `packages/cli/src/commands/workflow-progress.ts`（当前根找不到任务时查 `listTaskWorktrees`，读该 worktree 里的任务）
- Modify: `skills/tenon/SKILL.md`（「进入」第 3 步、恢复、`finish-change` 行、删「不要为了隔离自己建分支或 worktree」改为「worktree 由 `tenon init` 建，不要自己另建；用户明确要求原地时传 `--in-place`」）

**Interfaces:**
- Produces: `listTaskWorktrees(input: { repoRoot: string; git: GitRunner }): Promise<readonly { path: string; branch: string; changes: readonly string[] }[]>`（只取 `<repoRoot>/.worktrees/` 下、`openspec/changes/<c>/.pipeline.yaml` 存在且未归档的）。

- [ ] **Step 1: 写失败测试**：
  - `task-worktree-list.test.ts`：两个 worktree（一个含任务 `demo`，一个只是普通 worktree）与一个 `.worktrees/` 外的 worktree → 只返回含 `demo` 的那个
  - `status.test.ts`：主检出 `cmdList --json` 含 `{ name: 'demo', worktree: '<abs>' }`；主检出自己的任务行 `worktree: null`（键放在每行末尾，
    更新锁定键序的既有断言）；`tenon status demo` 在主检出 exit 1，stderr 含该路径
  - `test-hooks.sh`：桩出 `$PROOT/.worktrees/demo/openspec/changes/demo/.pipeline.yaml`，输入「继续 demo」→ 输出含 `worktree_path:` 与该路径；`.worktrees` 不存在时输出与改动前相同
  - `test-hooks.sh` 路由：主检出无活跃任务、`.worktrees/demo` 有任务时，新需求 → 按新任务（不出现 `selection_required`）；泛泛「继续」→
    `selection_required` 且候选含 `demo` 与路径；主检出另有一个活跃任务 `main-task` 时，泛泛「继续」仍按现有规则把 `main-task` 当唯一候选
  - `test-hooks.sh` 项目根：`.git` 是文件的 worktree 根下，gate 的评审标记、会话绑定与活跃任务指针都落在该 worktree 根
  - `statusStepFinish` 用例：`isolation=worktree` 时 `finish-change` 与 `finishedStop` 的 `cleanup` 都含 `git worktree remove '<path>'`；`in-place` 时为 `null`；
    按 `cleanup` 之外的动作执行完后 `.worktrees/demo` 仍存在
  - `workflow-progress` 用例：在主检出执行 `tenon workflow progress demo`（任务在 `.worktrees/demo`）输出该任务的一行清单；`step-progress`
    hook 对 `cd .worktrees/demo && tenon transition demo explore-complete` 与主检出的 `tenon init demo …` 都输出清单
- [ ] **Step 2:** `npx vitest run packages/kernel/src/workspace/task-worktree-list.test.ts packages/cli/src/commands/status.test.ts` 与 `npm run test:hooks`，FAIL。
- [ ] **Step 3:** 实现；改 skill 文本（照上面 Files 的要点，动作表 `finish-change` 行加「`cleanup` 非空时把它转告用户，不要自己执行」）。
- [ ] **Step 4:** 跑 Step 2 全 PASS；`bash tools/verify-skills.sh`（或对应 npm 脚本）PASS。

### Task 12: worktree 任务的构建版本绑工作区指纹

**Files:**
- Modify（8 处类别判定）：CLI `packages/cli/src/main.ts:293`、`packages/cli/src/commands/buildRevisionAssessor.ts:28`、`packages/cli/src/integration-harness.ts:292`；
  kernel `packages/kernel/src/workflow/build-revision.ts:217`、`packages/kernel/src/workflow/action-handlers.ts:48`；服务端 `packages/server/src/transition.ts:160`、`:170`、
  `packages/server/src/workflowSnapshot.ts:282`
- Modify: `docs/CONTRACT.md`（「Build→Verify 可复验基线」一条：`branch` 绑 git object，`worktree` 与 `in-place` 绑工作区内容指纹）
- Test: `packages/kernel/src/workflow/build-revision.test.ts`、`build-revision.acceptance.test.ts`、`packages/server/src/transition-rounds.test.ts` 旁新建 `transition-build-revision.test.ts`

- [ ] **Step 1: 写失败测试**：`isolation='worktree'` 的 `workspace` 令牌 → `trusted: true`；`worktree` 配 `git` 令牌 → `isolation-mismatch`；`branch` 配 `git` 仍可信；
  `worktree` 令牌在另一 worktree 身份下复核 → `worktree-mismatch`；完整往返：临时仓建 worktree、写入未提交改动、捕获令牌（以 `build:v1:workspace:`
  开头）→ 同一 worktree 复核可信；HTTP 流转对 `isolation=worktree` 的任务执行 `build-complete` 写入 `workspace` 令牌，与 CLI 一致。
- [ ] **Step 2:** `npx vitest run packages/kernel/src/workflow/build-revision.test.ts packages/kernel/src/workflow/build-revision.acceptance.test.ts packages/server/src/transition-build-revision.test.ts`，FAIL。
- [ ] **Step 3:** 在 `build-revision.ts` 导出 `expectedBuildRevisionKind(isolation: string): 'git' | 'workspace'`（`branch` → `git`，其余 → `workspace`），8 处全部改为调用它；改 CONTRACT。
- [ ] **Step 4:** PASS；`node tools/check-docs.mjs` PASS。

### Task 13: 退回边不要求执行者的技能；未派发运行如实登记

**Files:**
- Modify: `packages/kernel/src/workflow/transition-step-gates.ts`（back 边过滤归属 agent 的技能）、`packages/kernel/src/workflow/step-exit-report.ts`（同口径）
- Create: `packages/kernel/src/workflow/agent-owned-skills.ts`（`agentOwnedSkills`），`packages/cli/src/agentSkillGate.ts` 改用它
- Modify: `missingStepSkills` 入参增加 `exclude?: ReadonlySet<string>`，生成消息前按槽位技能 id 剔除；`transition-step-gates.ts` 与
  `step-exit-report.ts` 在 `!isForwardExit(...)` 时传入 `agentOwnedSkills` 的结果。适配方全部改：`packages/kernel/src/workflow/transition-application-types.ts:39`
  （类型）、`packages/cli/src/stepSkillGate.ts`、`packages/cli/src/commands/check-skills.ts`、`packages/cli/src/commands/internalSkillGate.ts`、`packages/server/src/transition.ts:257`
- Modify: `packages/cli/src/commands/agent.ts`（`cmdAgentRecord` 接受 `--subagent none`）、`packages/kernel/src/state/agent-runs.ts`（`reason` 加 `'not-dispatched'`）、`packages/cli/src/program-agents.ts`（选项说明）
- Test: `packages/kernel/src/workflow/transition-application.test.ts`、`packages/server/src/transition-rounds.test.ts`（或同目录新建 `transition-back-edge.test.ts`）、`packages/cli/src/commands/agent-prompt.test.ts`

**Interfaces:**
- Produces: `agentOwnedSkills(input: { plan: EffectiveWorkflowPlan; stepId: string; frozen: ReadonlyMap<string, FrozenAgent> }): ReadonlySet<string>`。

- [ ] **Step 1: 写失败测试**：
  - default 工作流任务在 build、本 visit 无任何 builder 运行与 TDD 回执：CLI `requirements-changed` 成功回到 spec；`build-complete` 报 `step-skills-incomplete` 且列出 `test-driven-development`（Review Focus 10）
  - 同一场景走 HTTP transition，结果一致
  - 主线技能（不归属任何 agent）在 back 边上仍被要求：构造 verify 步主线技能缺失时 `verify-fail` 被拒
  - `tenon status --json` 的 `requirements-changed` 出口 `ready: true`、无 `skill-incomplete`
  - `tenon agent record <c> <run> --subagent none` → 台账 `subagent` 为 `{ host:'claude', type:'none', native:false, reason:'not-dispatched' }`
- [ ] **Step 2:** 跑上述测试文件，FAIL。
- [ ] **Step 3:** 实现 `agentOwnedSkills`（逻辑取自 `agentSkillGate.ts` 的 `owners` 计算）；两处 gate 在 `!isForwardExit(...)` 时从缺失列表剔除其返回的技能；`agent record` 处理 `none`。
- [ ] **Step 4:** PASS；跑 `npx vitest run packages/kernel/src/workflow packages/server/src/transition*.test.ts` 无回归。

### Task 14: 使用文档与术语

**Files:**
- Modify: `docs/usage/agents.md`、`docs/usage/zh-CN/agents.md`（或任务相关的使用文档页，按 `docs/usage` 现有结构放）：新任务建在 `.worktrees/<change>`、`--in-place`、`setup`、Codex 开新会话、完结后的清理命令、起点规则
- Modify: `docs/usage/cli-reference.md`、`docs/usage/zh-CN/cli-reference.md`：`tenon agent install|uninstall`、`tenon workflow progress`、`tenon init --in-place`
  与 worktree 输出、`tenon list` 的 `worktree` 字段、`tenon agent record --subagent none`
- Modify: `CONTEXT.md`：新增「Host subagents and step progress」「Change start point」「Task worktree」术语

- [ ] **Step 1:** 写文档与术语。
- [ ] **Step 2:** `node tools/check-docs.mjs` 与 `npm run check:repository-hygiene` PASS。

### Task 15: 完整工作区指纹跳过未被 git 跟踪的 `.claude/worktrees/`

起因：验证第 1 轮里同仓库另一个 Claude Code 会话与子代理在 `.claude/worktrees/` 下持续改文件，主检出原地任务的构建版本 `revision-stale`；
该目录约 42 万个文件，每算一次指纹十几秒。delta spec：`task-worktree-isolation`「宿主为子代理与会话建的检出 SHALL NOT 计入工作区指纹」。

**Files:**
- Modify: `packages/kernel/src/workspace/host-local.ts`（新增 `skipUntrackedHostLocalDirs`；文件头说明里写清完整指纹也跳过未跟踪的 `.claude/worktrees/`）
- Modify: `packages/kernel/src/workspace/fingerprint.ts:389`（完整指纹 sink 的 `skip`）、`fingerprint.ts:377-383` 的注释
- Modify: `docs/CONTRACT.md`（工作区指纹条目，约第 610–616 行：完整指纹不再「逐字节等于 0.3.0」于含未跟踪 `.claude/worktrees/` 的树，后果是过期重跑、不判损坏）
- Test: `packages/kernel/src/workspace/fingerprint.test.ts`、`packages/kernel/src/workspace/host-local.test.ts`、
  `packages/cli/src/commands/buildRevisionAssessor.test.ts`（或 `packages/cli/src/transition-effects.integration.test.ts`）

**Interfaces:**
- Consumes: `HOST_LOCAL_DIRS`、`isHostLocalPath`、`foldAsciiCase`、`HostLocalSkip`、`hostLocalTracking`（`host-local.ts` 现有）。
- Produces: `skipUntrackedHostLocalDirs(tracked: ReadonlySet<string>, caseInsensitive?: boolean): HostLocalSkip`——对 `HOST_LOCAL_DIRS`
  下（含目录本身）未被 git 跟踪、且不是被跟踪路径祖先的路径返回 `true`；对 `HOST_LOCAL_FILES` 与其它路径返回 `false`。

- [ ] **Step 1: 写失败测试**（`fingerprint.test.ts`，沿用 `freshWorkspace` 与 `host-local files tracked by git` 小节的 `repo()` / `track()`）：
  - 非 git 树：加入、修改、删除 `.claude/worktrees/x/y.js`、新增 `.claude/worktrees/z/new.js`，`fingerprintWorkspaceTwins(root).full` 与 `.portable` 都不变（Review Focus 11）。
  - 同上的树里改 `.claude/settings.local.json` 或 `CLAUDE.local.md`：`.full` 变、`.portable` 不变（现有语义保持）。
  - git 仓：`track(root, '.claude/worktrees/x.js')` 后改它，`.full` 与 `.portable` 都变；同目录未跟踪的 `scratch.js` 改动两者都不变。
  - `.claude/worktrees/locked/` 建一个子目录后 `chmod 000`，`fingerprintWorkspaceTwins(root)` 不抛错（遍历不进入；`process.getuid?.() === 0` 时跳过）。
  - 改写「完整指纹与 0.3.0 逐位相同」：现有钉死值 `plain:with`、`settings:with` 是在含 `.claude/worktrees/x/y.js` 的夹具上算的，新规则下不再相等。
    夹具增加一种「只含宿主本地文件（`.claude/settings.local.json`、`CLAUDE.local.md`）、不含 `.claude/worktrees/`、不含符号链接」的形态，
    用 `v0.3.0` tag 的实现在同一夹具上算出钉死值（`git show v0.3.0:packages/kernel/src/workspace/fingerprint.ts` 及其依赖导出到 scratchpad，
    esbuild 打包后运行；不含符号链接时值与平台无关，一个常量覆盖 darwin 与 linux），替换 `plain:with`、`settings:with` 两项并在注释里写明算法；
    `plain:without`、`settings:without` 两项不动。
  - `host-local.test.ts`：`skipUntrackedHostLocalDirs(new Set())` 对 `.claude/worktrees`、`.claude/worktrees/a/b.js` 为 `true`，对
    `.claude/settings.local.json`、`CLAUDE.local.md`、`src/a.js` 为 `false`；`tracked` 含 `.claude/worktrees/x.js` 时对它与 `.claude/worktrees` 为 `false`；
    `tracked` 里拼成 `.Claude/Worktrees/X.js`、`caseInsensitive=true` 时，`.claude/worktrees/x.js` 返回 `false`（按跟踪处理）。
  - CLI：in-place 任务在临时 git 仓里 `build-complete` 捕获 `workspace` 令牌后，在 `.claude/worktrees/agent-x/` 下新建未跟踪文件，构建版本复核仍可信；
    改 `src/` 下被跟踪的文件则 `revision-stale`。
- [ ] **Step 2:** `npx vitest run packages/kernel/src/workspace/fingerprint.test.ts packages/kernel/src/workspace/host-local.test.ts`，新用例 FAIL
  （`.full` 随 `.claude/worktrees/` 变化；`skipUntrackedHostLocalDirs is not a function`）。
- [ ] **Step 3: 实现**：

```ts
// host-local.ts
/** 完整指纹只跳过宿主本地「目录」里未被 git 跟踪的路径；宿主本地文件在完整指纹里照算（保持它记原始内容与权限位的语义）。 */
export function skipUntrackedHostLocalDirs(tracked: ReadonlySet<string>, caseInsensitive = false): HostLocalSkip {
  const untracked = skipUntrackedHostLocal(tracked, caseInsensitive)
  return (relativePath) => HOST_LOCAL_DIRS.some((dir) => relativePath === dir || relativePath.startsWith(`${dir}/`)) && untracked(relativePath)
}
```

```ts
// fingerprint.ts（fingerprintWorkspaceTwins 内，tracking 先算出来，两个 sink 共用）
const tracking = await hasHostLocalFiles(root) ? await hostLocalTracking(root) : undefined
const full: Sink = {
  id: 'full', gitModes: false,
  skip: tracking === undefined ? SKIP_NOTHING : skipUntrackedHostLocalDirs(tracking.tracked, tracking.caseInsensitive),
}
```

  两个 sink 都跳过 `.claude/worktrees` 时 `fingerprintEntry` 的 `live` 为空直接返回，不再 `readdir`。git 回答不了（`tracking === undefined`）
  时两者都不跳过，与现在一致。
- [ ] **Step 4:** Step 2 的命令全过；`npx vitest run packages/kernel/src/workspace packages/kernel/src/test-system packages/cli/src/commands/buildRevisionAssessor.test.ts`；
  全量 `npx vitest run`；`npm run oracle`；`npx tsc -b packages/kernel packages/cli packages/server packages/automation`；
  `node tools/check-architecture.mjs`、`node tools/check-docs.mjs`、`npm run check:comments`；`npm run bundle`、`npm run build:server`。
  bundle 套件（含 N-1 完整指纹一致性检查）由主线经 `tenon test run --suite bundle` 跑。
- [ ] **Step 5:** 改 `docs/CONTRACT.md` 指纹条目与 `host-local.ts`、`fingerprint.ts` 的说明注释；`docs/usage` 里如有「完整指纹包含 `.claude/worktrees/`」
  的表述一并改（grep `claude/worktrees`）。

### Task 16: 用户级子代理目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`

起因：验证步真机验收，本机 Claude 由启动环境设了 `CLAUDE_CONFIG_DIR`，宿主只读 `$CLAUDE_CONFIG_DIR/agents`；Tenon 装在 `~/.claude/agents`，
`prompt` 也按这个写死的路径判定为已安装，派发报 `Agent type 'tenon-researcher' not found`。delta spec：`host-native-subagents`
「宿主子代理文件 SHALL 只由终端安装命令写入用户级目录」「用户级安装 SHALL 只改动 Tenon 写入且未被修改的文件」「派发 SHALL 只在已装文件与
冻结定义一致时使用专属子代理」的第四轮修改。

**Files:**
- Modify: `packages/kernel/src/instructions/hosts.ts`（导出现有的 `absoluteDirectory`，行为不变）
- Modify: `packages/kernel/src/infrastructure/host-agent-install.ts`（新增 `hostAgentsDir`；`userHostAgentPath`、`installHostAgents`、
  `uninstallHostAgents`、`reclaim`、`installOne` 改收子代理目录；清单按目录分组；文件头说明）
- Modify: `packages/kernel/src/infrastructure/host-subagent-resolve.ts`（入参 `homeDir` 换成 `agentsDir`；文件头说明）
- Modify: `packages/kernel/src/index.ts`（导出 `hostAgentsDir`）
- Modify: `packages/cli/src/deps.ts:277`（`agentPaths` 返回值加可选 `hostEnv`）、`packages/cli/src/main.ts:233`（`hostEnv: process.env`）
- Modify: `packages/cli/src/commands/agent-install.ts`（按 `hostAgentsDir` 取目录；输出首行给出目标目录；`agentInstallHint` 带目录）、
  `packages/cli/src/commands/agent.ts:80-86`、`:207`（判定传目录；`hint` 带所检查的目录）
- Modify: `packages/cli/src/i18n/help-en-flow.ts:30` 与 `program-agents.ts` 里 `agent install` 的中文描述（写明目录跟随 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`）
- Modify: `tools/vitest.isolate-runtime-home.mjs`（`ISOLATED_ENV` 加 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`）；`tools/test-hooks.sh`、`tools/test-adapters.sh`、
  `tools/test-bundle.sh` 开头 `unset CLAUDE_CONFIG_DIR CODEX_HOME`（已有 `CODEX_HOME` 处理的照原样保留，不重复）
- Modify: `docs/usage/agents.md`、`docs/usage/zh-CN/agents.md`（表格里的路径、在带同样变量的环境里安装、会话里可用 `!` 前缀）
- Test: `packages/kernel/src/infrastructure/host-agent-install.test.ts`、`host-subagent-resolve.test.ts`、
  `packages/cli/src/commands/agent-install.test.ts`、`packages/cli/src/agent-host.integration.test.ts`

**Interfaces:**
- Consumes: `absoluteDirectory(value: string | undefined, platform: NodeJS.Platform): string | null`（`instructions/hosts.ts`，改为导出）；
  `hostAgentPath`、`parseHostAgentPath`、`hostAgentName`（`agents/host-native.ts`）。
- Produces:
  ```ts
  // host-agent-install.ts
  export function hostAgentsDir(host: HostAgentHost, context: {
    readonly homeDir: string; readonly env: Readonly<Record<string, string | undefined>>; readonly platform: NodeJS.Platform
  }): string   // claude: <absoluteDirectory(env.CLAUDE_CONFIG_DIR) ?? homeDir/.claude>/agents；codex: <absoluteDirectory(env.CODEX_HOME) ?? homeDir/.codex>/agents
  export function userHostAgentPath(agentsDir: string, host: HostAgentHost, name: string): string   // join(agentsDir, posix.basename(hostAgentPath(host, name)))
  installHostAgents(input: { agentsDir: string; configRoot: string; host: HostAgentHost; agents; keep?; reclaim? })
  uninstallHostAgents(input: { agentsDir: string; configRoot: string; host: HostAgentHost })
  // host-subagent-resolve.ts
  resolveHostSubagent(input: { agentsDir: string; projectRoot: string; host: HostAgentHost; agent: FrozenAgent })
  // deps.ts
  agentPaths?: () => { payloadRoot: string; configRoot: string; homeDir: string; hostEnv?: Readonly<Record<string, string | undefined>> }
  ```
  `hostEnv` 缺省按 `{}`（不读任何环境变量）：现有测试桩不传它，天然不碰开发机的 `CLAUDE_CONFIG_DIR`。CLI 里统一经一个小函数
  `agentsDirOf(paths, host) = hostAgentsDir(host, { homeDir: paths.homeDir, env: paths.hostEnv ?? {}, platform: process.platform })` 取目录。
  清单：`OwnedByHost` 改名 `OwnedByDir`，结构 `{ "<子代理目录绝对路径>": { "<hostAgentPath 相对路径>": hash } }`；安装、卸载只取
  `owned[agentsDir]` 一组，写回 `{ ...owned, [agentsDir]: map }`，其余分组（含开发期按宿主名写下的 `claude` / `codex` 组）原样保留、不解释。
  `reclaim` 仍只认 `parseHostAgentPath` 反解得出、宿主相符的条目，路径用 `userHostAgentPath(agentsDir, host, name)` 重拼。
  `agentInstallHint(host, dir?)`：有 `dir` 时为 `执行 tenon agent install --host <host> 后开新会话生效（目标目录 <dir>；设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行，例如会话里用 ! 前缀）`，
  没有 `dir` 时保持原文（库命令的提示不变）。

- [ ] **Step 1: 写失败测试**（全部用 `mkdtemp` 临时目录；环境变量只经参数注入，不改 `process.env`）：
  - `host-agent-install.test.ts`：
    - `hostAgentsDir('claude', { homeDir: H, env: {}, platform })` → `H/.claude/agents`；`env: { CLAUDE_CONFIG_DIR: C }`（C 为临时目录）→ `C/agents`；
      `CLAUDE_CONFIG_DIR` 为 `'cc-config'`、`''`、`'   '` → `H/.claude/agents`；为 `` `  ${C}/  ` ``（前后空白加末尾斜杠）→ `C/agents`（Review Focus 12）；
      `hostAgentsDir('codex', { env: { CODEX_HOME: X } })` → `X/agents`；`CODEX_HOME` 只影响 codex、`CLAUDE_CONFIG_DIR` 只影响 claude。
    - 在 `agentsDir=C/agents` 安装 → 文件写在 `C/agents/tenon-*.md`，`H/.claude` 不存在；清单顶层键恰为 `C/agents`。
    - 两个目录互不影响（Review Focus 13）：先在 `H/.claude/agents` 装 `researcher`、`builder`，再在 `C/agents` 只装 `researcher`（`builder` 不在传入列表）
      → `H/.claude/agents/tenon-builder.md` 仍在且内容不变；再对 `C/agents` 执行 `uninstallHostAgents` → `C/agents` 里的被删，`H/.claude/agents` 两个文件都在，
      清单里 `H/.claude/agents` 组不变。
    - 清单里已有 `{ "claude": { ".claude/agents/tenon-researcher.md": "<hash>" } }`（开发期旧分组）、`H/.claude/agents/tenon-researcher.md` 内容与渲染一致
      → 在 `H/.claude/agents` 安装结果 `unchanged` 并在 `H/.claude/agents` 组补记；`claude` 组原样保留；对 `H/.claude/agents` 卸载不读 `claude` 组。
    - 现有用例改为传 `agentsDir: hostAgentsDir(host, { homeDir: H, env: {}, platform: process.platform })`，断言不变（含符号链接、清单损坏两项）。
  - `host-subagent-resolve.test.ts`：现有用例改传 `agentsDir`；新增：文件只装在 `H/.claude/agents`、判定用 `agentsDir=C/agents` → `not-installed`。
  - `agent-install.test.ts`：`agentPaths` 返回 `hostEnv: { CLAUDE_CONFIG_DIR: C }` → 文件写在 `C/agents`、输出首行含 `C/agents`、`H/.claude/agents` 无文件；
    不传 `hostEnv` → 写在 `H/.claude/agents`（且即使测试进程的 `process.env.CLAUDE_CONFIG_DIR` 被设成另一个临时目录 D，D 下也没有文件——用例内临时设置、用完还原，
    钉住「CLI 只从 `agentPaths().hostEnv` 取环境」，Review Focus 14）。
  - `agent-host.integration.test.ts`：装在 `H/.claude/agents`、`agentPaths().hostEnv = { CLAUDE_CONFIG_DIR: C }` 时 `agent prompt --json` 返回
    `subagent_type: general-purpose`、`reason: not-installed`，`hint` 含 `C/agents`；装在 `C/agents` 时返回 `tenon-researcher`、`native: true`、`hint: null`。
- [ ] **Step 2:** `npx vitest run packages/kernel/src/infrastructure/host-agent-install.test.ts packages/kernel/src/infrastructure/host-subagent-resolve.test.ts`，
  新用例 FAIL（`hostAgentsDir is not a function`、清单键仍是 `claude`）。
- [ ] **Step 3: 实现 kernel**：

```ts
// host-agent-install.ts
import { posix } from 'node:path'
import { absoluteDirectory } from '../instructions/hosts.js'

/** 宿主配置目录的环境变量与默认目录（相对 home）。 */
const CONFIG_DIR: Readonly<Record<HostAgentHost, { readonly env: string; readonly fallback: string }>> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', fallback: '.claude' },
  codex: { env: 'CODEX_HOME', fallback: '.codex' },
}

/** 宿主读用户级子代理的目录：配置目录取环境变量（绝对路径才采用，与用户级 AGENTS.md 同一判定），否则 home 下的默认目录。 */
export function hostAgentsDir(host: HostAgentHost, context: {
  readonly homeDir: string; readonly env: Readonly<Record<string, string | undefined>>; readonly platform: NodeJS.Platform
}): string {
  const { env, fallback } = CONFIG_DIR[host]
  return join(absoluteDirectory(context.env[env], context.platform) ?? join(context.homeDir, fallback), 'agents')
}

/** 用户级宿主 agent 文件的绝对路径：子代理目录 + `tenon-<name>.<ext>`。 */
export function userHostAgentPath(agentsDir: string, host: HostAgentHost, name: string): string {
  return join(agentsDir, posix.basename(hostAgentPath(host, name)))
}
```

  `installOne` / `reclaim` / 两个入口把 `homeDir` 换成 `agentsDir`，`agentsDirOf` 删掉（`reclaim` 里 `rmdir(agentsDir)`）；`hostMap` 取 `owned[agentsDir]`，
  写回 `{ ...owned, [agentsDir]: hostMap }`。`resolveHostSubagent` 用 `userHostAgentPath(agentsDir, host, agent.name)`。两个文件头注释改写路径说明。
- [ ] **Step 4:** Step 2 的命令全过。
- [ ] **Step 5: 接 CLI**：`deps.ts` 加 `hostEnv?`；`main.ts:233` 传 `hostEnv: process.env`；`agent-install.ts` 与 `agent.ts` 经 `agentsDirOf` 取目录；
  `cmdAgentInstall` / `cmdAgentUninstall` 输出首行 `目标目录：<dir>`；`agent.ts` 的 `hint` 改为 `agentInstallHint(used.host, dir)`；帮助文本两处。
  `tools/vitest.isolate-runtime-home.mjs` 与三个 shell 测试脚本清掉 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`。
  `setupHost.ts` / `update.ts` 不用改：`installHostAgentsAfterSuccess` 经 `runCommand`（`execFileSync`，不传 `env`）起子进程，子进程继承调用者的
  环境，按调用者的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 安装；`setup.test.ts`、`update.test.ts` 不新增断言。
- [ ] **Step 6:** `npx vitest run packages/cli/src/commands/agent-install.test.ts packages/cli/src/agent-host.integration.test.ts packages/cli/src/task-host-agents.integration.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/update.test.ts`；
  全量 `npx vitest run`；`npm run test:hooks`；`npx tsc -b packages/kernel packages/cli packages/server packages/automation`；`node tools/check-architecture.mjs`、
  `node tools/check-docs.mjs`、`npm run check:comments`；`npm run bundle`、`npm run build:server`（dist 入库且计入指纹，build-complete 前重建）。
- [ ] **Step 7:** 改 `docs/usage/agents.md` 与中文版：路径表写 `<配置目录>/agents/…`（默认 `~/.claude`、`~/.codex`，设了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 时是它们），
  说明要在带同样变量的环境里执行安装（会话里 `! tenon agent install --host claude`），`prompt` 退回时提示里会给出它检查的目录。

### Task 17: 拆分 `init.test.ts` 的 worktree 与 setup 用例

起因：验证步代码规模评审者（medium）：`packages/cli/src/commands/init.test.ts` 从 341 行涨到 864 行，「新任务建在 worktree 里」（约第 351–659 行）
与其中嵌套的「信任继承与 setup」（约第 660–864 行）两组用例都堆在这一个文件里，而源码早已拆成 `init-worktree.ts` 与 `init-setup.ts`。
纯测试搬家：**用例名、断言、夹具行为一律不变**，不新增、不删除用例，不改任何源码。

**Files:**
- Create: `packages/cli/src/commands/init-worktree-test-support.ts`（两组用例共用的夹具：环境变量保存/恢复、临时目录登记与清理、`repoWithCommit`、`realIn`、`status`、`branches`、`BACKEND`）
- Create: `packages/cli/src/commands/init-worktree.test.ts`（原 `describe('init —— 新任务建在 worktree 里')` 下除嵌套 describe 之外的全部 `test`）
- Create: `packages/cli/src/commands/init-worktree-setup.test.ts`（原嵌套 `describe('信任继承与 setup')` 的全部内容，外层 describe 名改为 `'init —— 新 worktree 的信任继承与 setup'`，内部用例名不变）
- Modify: `packages/cli/src/commands/init.test.ts`（删掉第 351 行注释起到文件末尾的整块；删掉随之不再使用的 import）
- Modify: `packages/cli/tsconfig.json`（`exclude` 追加 `"src/commands/init-worktree-test-support.ts"`：它引入 `integration-harness`，不排除会被 `tsc -b`
  编进 `packages/cli/dist`，`tools/check-architecture.mjs` 禁止测试专用入口出现在 CLI dist；做法与已排除的 `src/integration-harness*.ts` 一致）

**Interfaces:**
- Produces（`init-worktree-test-support.ts`）：
  ```ts
  export const BACKEND = { track: 'backend', preset: 'full' } as const
  /** 在调用它的 describe 里注册 beforeEach/afterEach：删掉 TENON_INIT_IN_PLACE、用完恢复，restoreAllMocks，清理 temps。 */
  export function useWorktreeInitFixture(): {
    repoWithCommit(files?: Record<string, string>): Promise<{ cwd: string; head: string }>
    realIn(cwd: string, env?: NodeJS.ProcessEnv): { deps: CliDeps; out: string[]; err: string[] }
    status(cwd: string): string
    branches(cwd: string): string
  }
  ```
  实现照搬原 `describe` 体里的 `savedInPlace` / `temps` / `beforeEach` / `afterEach` / 四个函数，逐字保留注释（含「全局 setup 给所有测试设了
  TENON_INIT_IN_PLACE=1…」那段说明，挪到函数注释里）。

- [ ] **Step 1: 记下搬家前的用例清单**：`env -u CLAUDE_CONFIG_DIR -u CODEX_HOME npx vitest run packages/cli/src/commands/init.test.ts --reporter=verbose`，
  把输出里「新任务建在 worktree 里」与「信任继承与 setup」下的每条用例名与总数抄进报告（预期全过）。
- [ ] **Step 2: 建 `init-worktree-test-support.ts`**，内容按上面的 Interfaces；`git`、`commitAll`、`writeFiles` 从 `../integration-harness-tests.js` 引入，
  `realDeps` 从 `../integration-harness.js` 引入。
- [ ] **Step 3: 建两个测试文件**：各自顶层 `describe(...)` 里先 `const fx = useWorktreeInitFixture()`，原用例体里的 `repoWithCommit(...)`、`realIn(...)`、
  `status(...)`、`branches(...)` 改为 `fx.repoWithCommit(...)` 等，其余逐字照搬；`init-worktree-setup.test.ts` 同时搬入
  `SLUG`、`CATALOG`、`MARKER_SETUP`、`TRUSTED`、`catalogYaml`、`execDigest`、`trustInMain`、`fakeRunner`。
- [ ] **Step 4: 从 `init.test.ts` 删掉整块**，并删掉只被这两组用例用到的 import（`existsSync`、`realpath`、`catalogExecDigest`、`changedFilesForState`、
  `computeContentHash`、`parseTestCatalog`、`readTestSeal`、`sealSharedWrite`、`updateTestSeal`、`userSlug`、`TestCatalog`、`catalogTrustTarget`、
  `ensureTrusted`、`realDeps`、`VITEST_FILES`、`commitAll`、`git`、`writeFiles` 等——以 `tsc` 报的未使用为准，前半段还在用的保留）。
- [ ] **Step 5: 核对用例清单不变**：`env -u CLAUDE_CONFIG_DIR -u CODEX_HOME npx vitest run packages/cli/src/commands/init.test.ts packages/cli/src/commands/init-worktree.test.ts packages/cli/src/commands/init-worktree-setup.test.ts --reporter=verbose`，
  三个文件合计的用例名集合与 Step 1 抄下的完全相同、总数相同、全部通过；`npx tsc -b packages/cli` 无错，且之后
  `packages/cli/dist/commands/init-worktree-test-support.js` 与 `packages/cli/dist/integration-harness.js` 都不存在；`node tools/check-architecture.mjs`、
  `npm run check:comments` 通过；`npm run bundle` 前后 `shasum -a 256 packages/cli/dist/tenon.mjs` 相同（入库的 CLI 包不变）。
- [ ] **Step 6: 新测试文件登记进测试计划**：主线照 `next` 的 `test-register-files` 执行 `tenon test register … --file <path> --suite unit`（执行者不写测试计划）。

## 依赖与并行

- Task 1 → Task 2；Task 3 → Task 4、Task 5 → Task 6；Task 6 → Task 9（都改 `init.ts`，Task 9 假定 `generateHostAgents` 已删）；
  Task 8 → Task 9 → Task 10 → Task 11；Task 12 独立；Task 13 在 Task 4、5 之后
  （改同一批 `agent.ts`、`agent-runs.ts`、`program-agents.ts`）；Task 7、Task 14 最后。Task 15 是验证第 1 轮退回后新增的，独立于其余任务，
  在 Task 1–14 全部完成之后做。Task 16 是验证步真机验收退回规格（第四轮）后新增的，改 Task 3–5 的接口，在 Task 15 之后做。Task 17 是验证步评审退回（规格第五轮）后新增的
纯测试搬家，在 Task 16 之后做；它不动源码与 dist，不需要重新同步本机安装。
- 本任务原地推进，写类子代理一律串行（用户规则），不并行开 worktree；`packages/kernel/src/index.ts`、`init.ts`、`status.ts` 被多个任务改动，
  按上面的顺序串行即可避免冲突。
- Task 8 完成并同步源码开发安装后，本任务自己的起点会改为上游 merge-base；同步时机先与用户确认。

## 验收命令

- `npm test`、`npm run test:hooks`、类型检查与 lint（仓库既有脚本）全过；开 PR 前本地跑齐 `package.json` 的 `check:*`。
- 真机：在带着本机 `CLAUDE_CONFIG_DIR` 的环境里执行 `tenon agent install --host claude`（例如 Claude 会话里 `! tenon agent install --host claude`），
  输出的目标目录是 `$CLAUDE_CONFIG_DIR/agents` → 开新 Claude Code 会话 → 会话里 `tenon init` 新任务 → 派发 `tenon-researcher` 成功；`tenon transition` 后终端出现 `Tenon · <change>` 与步骤清单；Codex 同样确认清单显示。
- 真机：主检出会话里 `tenon init demo …` → 任务落在 `.worktrees/demo` → `EnterWorktree path=<abs>` → `tenon session activate demo --host-session <id>` → 评审确认生效（同时记录 hook 收到的 `cwd`）；主检出 `tenon list` 能看到 `demo`；完结后按 `cleanup` 清理。
