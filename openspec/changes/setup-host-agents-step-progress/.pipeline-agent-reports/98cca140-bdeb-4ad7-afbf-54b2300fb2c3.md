# spec-consistency 评审报告：setup-host-agents-step-progress（验证最后一轮）

候选：`workspace:sha256:805e51a8…0716`

结论：五个 delta spec 的全部 Requirement 与 Scenario 都找到了实现证据和测试证据。没有少做，也没有 `high` 或 `medium` 的偏差。

两条曾经的 medium 已在规格侧消除：`TENON_INIT_IN_PLACE` 静默，以及 `start_sha` 的时间条件。其余只剩 low 提示。

## 方法与限制

- 本轮没有运行任何测试，测试证据是读测试标题和断言得出的，不代表测试已通过。
- 覆盖表以两轮前的报告 `d9db9705` 为索引。我重新打开的有 `init-worktree.ts`、`change-start.ts` 和五个 delta spec 里的相关条款。`host-agent-install.ts`、`workflow-progress.ts`、`step-progress.sh`、`task-worktree.ts`、`agent-owned-skills.ts`、`statusStepFinish.ts` 只确认了文件仍在原路径。
- 表里引用的文件和行号沿用上一轮；本轮没有逐个重新读它们，行号可能有小幅漂移。
- 与上一个候选相比，本轮新增的改动只有 `tools/check-repository-hygiene.mjs` 和对应的 `node-test`。
- 文件路径省略 `packages/` 前缀。K 表示 kernel，C 表示 cli，S 表示 server。

## 一、覆盖表

### host-native-subagents（7 个 Requirement）

| 规格条目 | 实现证据 | 测试证据 | 判定 |
|---|---|---|---|
| R1 终端安装写用户级目录；`setup`/`update` 后同一安装；幂等；项目层不写 | K `infrastructure/host-agent-install.ts`（`hostAgentsDir`、`installHostAgents`）。C `commands/agent-install.ts`、`setupHost.ts`、`update.ts` 的 `installHostAgentsAfterSuccess`、`host-agent-install-step.ts` | `agent-install.test.ts`；`host-agent-install.test.ts`；`update.test.ts`；`task-host-agents.integration.test.ts` | 已实现 |
| S 配置目录由 `CLAUDE_CONFIG_DIR` 指定 | `hostAgentsDir`、`agentsDirOf` | `agent-install.test.ts`；`host-agent-install.test.ts` | 已实现 |
| S `CODEX_HOME` | 同上 | `agent-install.test.ts`；`agent-host.integration.test.ts` | 已实现 |
| S 环境变量非绝对路径不采用 | `absoluteDirectory`（K `instructions/hosts.ts`） | `agent-install.test.ts`；`host-agent-install.test.ts` | 已实现 |
| S 终端安装官方与自定义 agent | `cmdAgentInstall` | `agent-install.test.ts` | 已实现 |
| S 重复安装不改写 | `installOne` 内容相同返回 `unchanged` | `agent-install.test.ts`；`host-agent-install.test.ts`（核对 mtime） | 已实现 |
| S 已是最新版的 update 仍安装 | `update.ts` 的唯一成功出口 | `update.test.ts` | 已实现 |
| S 项目层同名不影响用户级 | 安装不传 `projectRoot` | `agent-install.test.ts` | 已实现 |
| S 项目层 agent 不写入宿主目录 | `entry.source !== 'project'` 过滤 | `agent-install.test.ts` | 已实现 |
| R2 只改动 Tenon 写入且未改的文件；所有权按目录分组；目标符号链接拒绝、父目录符号链接照常 | `installOne`、`reclaim`、`withManifest`；`host-agent-fs.ts` 的 `inspectFile` 用 `lstat` | `host-agent-install.test.ts` | 已实现 |
| S 不同配置目录互不影响 | 清单按目录分组 | `host-agent-install.test.ts`；`agent-install.test.ts` | 已实现 |
| S 用户自有同名文件不覆盖 | `installOne` 的 foreign 分支 | `host-agent-install.test.ts`；`agent-install.test.ts` | 已实现 |
| S 库中删除的 agent 被清掉 | `reclaim` | 同上 | 已实现 |
| S 用户目录经符号链接管理 | 只对目标文件用 `lstat` | `host-agent-install.test.ts` | 已实现 |
| S 卸载保留被修改的文件 | `uninstallHostAgents` | `host-agent-install.test.ts`；`agent-install.test.ts` | 已实现 |
| R3 会话内命令不写宿主文件；库命令只提示 | C `init.ts` 已删生成调用；`agent-context.ts` 已删 `prepare`；`agent-library.ts` 与 `agent-new.ts` 调 `hintAgentInstall` | `agent-install.test.ts`；`agent-host.integration.test.ts`；`local-excludes.integration.test.ts` | 已实现 |
| S 会话中建任务不产生宿主文件 | 同上 | `agent-host.integration.test.ts`；`task-host-agents.integration.test.ts` | 已实现 |
| S 新建自定义 agent 只提示安装 | `agent-new.ts` | `agent-install.test.ts` | 已实现 |
| R4 派发只在已装文件与冻结定义一致时用专属子代理 | K `host-subagent-resolve.ts` 的 `resolveHostSubagent`；C `agent.ts` | `host-subagent-resolve.test.ts`；`agent-host.integration.test.ts` | 已实现 |
| S 已安装且一致 | `resolveHostSubagent` | `host-subagent-resolve.test.ts` | 已实现 |
| S 未安装（台账记同值） | `fallback('not-installed')`；台账行写 `subagent_reason` | `agent-host.integration.test.ts` | 已实现 |
| S 会话配置目录与安装位置不同 | `agentsDirOf` 与提示带目录 | `agent-host.integration.test.ts`；`host-subagent-resolve.test.ts` | 已实现 |
| S 冻结版本与已装版本不同 | `definition-mismatch` | `agent-host.integration.test.ts` | 已实现 |
| S 被项目级旧文件遮住 | `shadowed` | `host-subagent-resolve.test.ts`；`agent-host.integration.test.ts` | 已实现 |
| S 项目层 agent | `project-agent` | 同上 | 已实现 |
| R5 `--subagent none` 如实登记 | C `agent.ts` 的 `usedSubagent` | `agent-host.integration.test.ts` | 已实现 |
| S 开始后未派发 | `reason: not-dispatched` | 同上 | 已实现 |
| R6 清理旧版本写入的项目级宿主文件 | K `host-agent-files.ts` 的 `cleanupLegacyHostAgents`。C `init.ts`、`task-lifecycle.ts`、`transition.ts`。S `hostAgentPrune.ts`、`serverTaskLifecycleRoutes.ts` | `agent-host.integration.test.ts`；`task-host-agents.integration.test.ts`；`init.test.ts`；`hostAgentPrune.test.ts` | 已实现 |
| S 建任务时清掉旧文件 | `init.ts` | `agent-host.integration.test.ts`；`init.test.ts` | 已实现 |
| S 清单条目丢失但内容一致 | `renderCurrent` 比对 | `agent-host.integration.test.ts`；`task-host-agents.integration.test.ts` | 已实现 |
| S 用户改过的旧文件保留并警告 | `preserved` 逐个 WARN，不抛错 | `agent-host.integration.test.ts`；`init.test.ts` | 已实现 |

### effective-workflow-plan（1 个 Requirement，5 个 Scenario）

| 规格条目 | 实现证据 | 测试证据 | 判定 |
|---|---|---|---|
| R `workflow progress` 与 `step-progress` hook | K `workflow/step-progress.ts`。C `commands/workflow-progress.ts`。`hooks/step-progress.sh`、`hooks/hooks.json`、`skills/tenon/SKILL.md` | `workflow-progress.test.ts`；`step-progress.test.ts`；`tools/test-hooks.sh` | 已实现 |
| S 流转后打印清单 | hook 输出 | `test-hooks.sh` | 已实现 |
| S 自定义短工作流 | 取 `plan.projection.steps` | `workflow-progress.test.ts` | 已实现 |
| S 归档后全部完成 | `archived` 时全部打勾 | 同上 | 已实现 |
| S 无关命令不打印 | bash 正则不匹配则 `exit 0` | `test-hooks.sh` | 已实现 |
| S 失败的流转不打印 | 依赖宿主 PostToolUse 只在成功时触发 | 无直接自动化测试 | 已实现，依赖宿主语义（见 L1） |

### change-start-point（3 个 Requirement）

| 规格条目 | 实现证据 | 测试证据 | 判定 |
|---|---|---|---|
| R1 记录并跟随上游前进；候选取最新 | K `workspace/change-start.ts` 的 `startFromCandidates`、`recordedStartIsPlausible`（行 83，入选条件行 102）。写入方 `init.ts`、`serverPostChangesRoutes.ts`、`workflow-run-create-repository.ts` | `change-start.test.ts`；`start-sha-store.test.ts`；`change-start-point.integration.test.ts`；`changed-files.test.ts` | 已实现。M2 已消除：delta spec 行 9 已写「提交者时间不晚于 `created_at` 加 60 秒」，与实现一致 |
| S 上游拉进来的提交不算 | 候选含上游 merge-base 与 `start_sha` | `change-start.test.ts` | 已实现 |
| S 建任务前已有的本地提交不算 | `start_sha` 即建任务时 HEAD | 同上 | 已实现 |
| S 本任务自己的本地提交仍算 | 起点不越过 `start_sha` | 同上 | 已实现 |
| S 推送到上游后的已知限制 | 起点前移到上游 | 同上 | 已实现 |
| S 旧任务没有 `start_sha` | 退回上游 merge-base 候选 | 同上 | 已实现 |
| S 既无记录也无上游 | 退回 `created_at` 之前最后一个提交 | 同上 | 已实现 |
| R2 所有使用方走同一入口 | 全部走 `changeStartOfFields` | `testEvidenceContext`；`snapshot.test.ts` | 已实现 |
| S CLI 与 Dashboard 看到同一份改动 | 同一入口 | `snapshot.test.ts` | 已实现（断言未逐条核对） |
| R3 起点字段只能由建任务写入 | C `field-values.ts` 的 `TRANSITION_MANAGED_FIELDS`；`fields.ts` 的 `rejectProtectedField` | `change-start-point.integration.test.ts`；`fields.test.ts` | 已实现 |
| S 改写起点被拒 | 同上，非零退出码 | 同上 | 已实现 |

### task-worktree-isolation（7 个 Requirement）

| 规格条目 | 实现证据 | 测试证据 | 判定 |
|---|---|---|---|
| R1 新任务建在自己的 worktree；原地情形输出原因 | K `workspace/task-worktree.ts`。C `init-worktree.ts`、`init.ts`、`program-init.ts` | `task-worktree.test.ts`；`init.test.ts` | 已实现。M1 已消除：delta spec 行 15–16 与新增场景「测试工装要求原地」明确环境变量触发时不输出原因，仅 `--in-place` 输出；`init-worktree.ts:51` 与之一致 |
| S 在主检出里建任务 | `base_branch`、`isolation=worktree`、`start_sha` | `init.test.ts` | 已实现 |
| S 测试工装要求原地 | `init-worktree.ts:51`，`plan.reason !== 'requested' \|\| inPlaceFlag` 才输出 | `init.test.ts`（静默断言） | 已实现 |
| S 已在 linked worktree 里 | `reason: linked-worktree` | `init.test.ts` | 已实现 |
| S 同名分支已存在 | `TaskWorktreeConflictError`，不留半成品 | `init.test.ts` | 已实现 |
| S 两个任务并行互不污染 | 各自 worktree 加起点 | `init.test.ts` | 已实现 |
| R2 新 worktree 准备与继承信任；`setup` 纳入信任摘要 | K `catalog.ts`。C `init-setup.ts`、`test-trust.ts`。仓库 `.tenon/tests/catalog.yaml` | `catalog.test.ts`；`init-setup.test.ts`；`test-trust.test.ts`；`init.test.ts` | 已实现 |
| S 未提交的目录改动 | HEAD 版本摘要不同，判未信任并提示 | `init.test.ts` | 已实现 |
| S 信任过的目录自动准备 | 执行 `setup` | 同上 | 已实现 |
| S 目录改动后要重新信任 | 摘要变化 | 同上 | 已实现 |
| S 准备命令失败 | 只 WARN 并给出重跑命令，退出码不变 | 同上 | 已实现 |
| R3 会话切进 worktree | `reportInitPlacement` 输出绝对路径；`SKILL.md` | `init.test.ts` | 已实现，会话绑定属真机项 |
| S Claude Code 同一会话继续 | skill 要求 `EnterWorktree` | 无自动化测试 | 未能判定：真机项 |
| R4 主检出能找到 worktree 任务 | K `task-worktree-list.ts`。C `status.ts`、`paths.ts`、`workflow-progress.ts`。`hooks/router.sh` | `task-worktree-lookup.integration.test.ts`；`workflow-progress.test.ts`；`task-worktree-list.test.ts`；`test-hooks.sh` | 已实现 |
| S 列出 worktree 任务 | `list --json` 带 `worktree` | `task-worktree-lookup.integration.test.ts` | 已实现 |
| S 在主检出说继续 | `router.sh` 输出 `worktree_path` | `test-hooks.sh` | 已实现（路由用例未逐条核对） |
| S 主检出新请求不受影响 | `WT_*` 与 `ACTIVE_CHANGE_*` 分开 | 同上 | 已实现（同上） |
| S 主检出建任务后打印清单 | `workflow progress` 回退读 worktree | `workflow-progress.test.ts` | 已实现 |
| R5 worktree 任务的构建版本绑工作区指纹 | K `build-revision.ts` 的 `expectedBuildRevisionKind`；`action-handlers.ts`、`buildRevisionAssessor.ts`、`server/transition.ts` | `build-revision.test.ts`；`build-revision.acceptance.test.ts`；`transition-build-revision.test.ts` | 已实现 |
| S 未提交的实现可以验证 | token 为 `build:v1:workspace:` | `build-revision.test.ts` | 已实现 |
| S 换检出验证被拒 | `worktree-mismatch` | 同上 | 已实现 |
| R6 不计入宿主为子代理建的检出 | K `fingerprint.ts`、`host-local.ts` 的 `skipUntrackedHostLocalDirs` | `fingerprint.test.ts` | 已实现 |
| S 另一个会话在 `.claude/worktrees/` 下工作 | 同上 | 同上 | 已实现 |
| S 被 git 跟踪的文件照算 | 同上 | 同上 | 已实现 |
| R7 归档后提示清理 | C `statusStepFinish.ts` 的 `worktreeCleanup`、`finishActions`；`SKILL.md` | `task-worktree-lookup.integration.test.ts` | 已实现 |
| S 完结提示 | `finish-change` 带 `cleanup`，不自动删除 | 同上 | 已实现 |

### workflow-skill-enforcement（1 个 MODIFIED Requirement，3 个 Scenario）

| 规格条目 | 实现证据 | 测试证据 | 判定 |
|---|---|---|---|
| R 退回边不要求归属 agent 的 skill；status/check 与 transition 一致 | K `workflow/agent-owned-skills.ts`、`transition-step-gates.ts`、`step-exit-report.ts`。C `stepSkillGate.ts`、`check-skills.ts`、`transition.ts`。S `transition.ts` | `agent-owned-skills.test.ts`；`step-exit-report.test.ts`；`back-edge-skills.integration.test.ts`；`server/transition-back-edge.test.ts` | 已实现 |
| S Hook 负例不能由可选 Skill 绕过 | 原有逻辑 | 既有测试 | 已实现（未改） |
| S CLI 与 HTTP transition 同时失败关闭 | 原有逻辑 | 既有测试 | 已实现（未改） |
| S 退回边不要求执行者的 Skill | `requirements-changed` 豁免；`build-complete` 仍拒 | `back-edge-skills.integration.test.ts`；`transition-back-edge.test.ts` | 已实现 |

## 二、本轮新增改动

`tools/check-repository-hygiene.mjs` 新增了 `allowedSetupHostAgentsResearchReference`。它只放行本任务（在途或归档路径）下 researcher 报告 `10167049-…md` 里的第一个参考身份，其余文件和身份仍然禁止。`node-test` 加了对应的正反用例。

这是让本任务自己的交付物通过仓库门禁的支撑设施，不改变任何规格声明的产品行为。按支撑设施处理，不算多做，只报 low，提示 tasks.md 已记录、规格可不必改（L4）。

## 三、发现清单

- **L1（low）**：「失败的流转不打印」依赖宿主 PostToolUse 只在命令成功时触发。hook 拿不到退出码，也没有自动化用例，属真机验收范围。
- **L2（low）**：`stop` 动作 `code: finished` 也带 `cleanup`，规格只写了 `finish-change`。`SKILL.md` 已同步，建议规格补一句。
- **L3（low，支撑性改动）**：`legacy-import.ts` 保护 `start_sha`。`agentSkillGate.ts` 复用 `agentOwnedSkills`。`check.ts` 和 `check-skills.ts` 传递 `event`。`test-trust.ts` 展示 `setup`。CI 与 `tools/*` 的 `--in-place` 或 `TENON_INIT_IN_PLACE`。这些是实现 Requirement 所必需的，或是测试工装，不按多做处理。
- **L4（low，支撑性改动）**：仓库卫生检查为 researcher 报告加的窄豁免见上文第二节，规格未提及。

## 四、未能判定

- tasks.md 的两条「真机验收」（会话派发 `tenon-researcher`、`EnterWorktree` 后 activate 与评审确认）：未能判定：真机项。已由主线在验证报告中记录。
- `test-hooks.sh` 里 `router.sh` 的 worktree 路由用例、`snapshot.test.ts` 的 CLI 与 Dashboard 改动文件集合一致性：只核对了标题，没有逐条核对断言。
- 入库的 dist 产物按要求未逐行审。

```tenon-result
{"findings":[{"severity":"low","location":"specs/effective-workflow-plan 场景「失败的流转不打印」/ hooks/step-progress.sh","message":"失败不打印依赖宿主 PostToolUse 仅在成功时触发，hook 自身无退出码、无自动化用例，需真机验证"},{"severity":"low","location":"specs/task-worktree-isolation R7 / packages/cli/src/commands/statusStepFinish.ts:finishedStop","message":"stop code=finished 也附带 cleanup，规格只写了 finish-change 动作，SKILL.md 已同步，建议规格补一句"},{"severity":"low","location":"tools/check-repository-hygiene.mjs:allowedSetupHostAgentsResearchReference","message":"为台账绑定摘要的 researcher 报告加的窄豁免是支撑设施，规格未提及，不改变产品行为；tasks.md 已记录，可选在规格补一句"},{"severity":"low","location":"tasks.md 验证节两条真机验收","message":"EnterWorktree 切入后 activate 与评审确认生效、会话派发 tenon-researcher 成功属真机项，未能判定"}]}
```
