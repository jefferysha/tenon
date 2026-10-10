# 源码开发安装与源码仓库漂移检查 Implementation Plan（fix-hook-cross-session-isolation · B 部分）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `tenon setup --claude|--codex --from-source <repo>`：从 Tenon 源码仓库工作区构建并安装插件与托管运行时（记录 `channel: dev`、commit、dirty、worktreeDigest、skillsIndexDigest，不冒充版本标签），并在源码仓库里开会话时用纯 bash 的 SessionStart 提示把「已装」与「工作区」的漂移告诉用户。

**Architecture:** 开发安装复用现有的托管事务（`publishManagedRelease` + WAL + 稳定 launcher + Dashboard 就绪），只在三处分叉：候选根是仓库工作区本身而不是宿主缓存（`candidateRoot = repoRealpath`），宿主命令走「目录 marketplace」专用计划与专用 desired-state（经现成的 `managedHostReconciliation` 注入口，不碰稳定标签逻辑），release manifest 多一个互斥的可选字段 `devSource`。漂移判据是 `PAYLOAD_ENTRIES` 范围内的内容摘要（git blob id 口径，Node 与 bash 逐字一致），由 `hooks/source-drift.sh` 在 SessionStart 直接精确比较（实测 358 文件 / 10 MB 约 20 ms），`tenon doctor` 的 `source:drift` 用同一口径做完整比较。

**Tech Stack:** TypeScript（Node ≥ 22，ESM）、vitest、bash hook（`hooks/json-input.sh` 同风格）、commander、真实 `claude` / `codex` CLI（仅 Task 1 与验收脚本，隔离 HOME）。

**Spec:** `docs/superpowers/specs/fix-hook-cross-session-isolation-design.md`（背景与风险）；delta spec `openspec/changes/fix-hook-cross-session-isolation/specs/plugin-runtime/spec.md`（「源码开发安装」「源码仓库漂移检查」两条 requirement，主线正在写，本计划按下方「已定决定」实现，不等待它）；proposal `openspec/changes/fix-hook-cross-session-isolation/proposal.md` 的 What Changes 7、8、11。

## 已定决定（用户确认 / 按推荐确定，不得更改）

1. 新增正式的源码开发安装 `tenon setup --claude|--codex --from-source <repo>`：从仓库工作区构建并安装插件与托管运行时；记录 `channel: dev`、commit、dirty、worktreeDigest、skillsIndexDigest；不冒充版本标签；无 `--from-source` 时正式安装行为完全不变（仍只认稳定标签）。
2. 上游技能正文与本机拉取索引（`skills/skills.lock.json`）都不进仓库；执行 `--from-source` 安装时，缺技能或缺索引就按 `skills/sources.yaml` 自动拉取并写索引，两次初始化之间不自动重拉。拉取失败整体中止、不进入 WAL、不改宿主。
3. 漂移检查：在 Tenon 源码仓库（四项判据全满足：根 `package.json` 的 `name=tenon`；`.claude-plugin/marketplace.json` 的 `name=tenon` 且 `plugins[0].source="./"`；存在 `skills/sources.yaml`；存在 `runtime/tenon-bootstrap.mjs`）里，SessionStart 比较已装与工作区（commit、工作区摘要、技能索引摘要），不一致时在会话上下文给出同步命令；已装的是正式版时也提示并给出 `--from-source` 命令；fail-open、不阻断；hook 纯 bash（`tools/test-hooks.sh` §3 红线），完整比较放 `tenon doctor`（新 check `source:drift`）。
4. 开发安装下 `tenon update` 默认 fail-closed，并提示用 `--from-source` 重新同步或 `--to-stable` 切回正式版；开发安装写入本机 `install-channel` 标记并关闭 auto-update，`hooks/auto-update.sh` 见标记即退出。
5. Dashboard / health 增加 `channel` 字段与短 commit，版本徽标显示 `<version>+dev.<sha7>`，不改 `serverVersion` 本身；`identity:release` 对 dev 为 yellow。

## Global Constraints

- 用户入口原文：`tenon setup --claude --from-source <repo>`、`tenon setup --codex --from-source <repo>`；切回正式版：`tenon update --claude --to-stable` / `tenon update --codex --to-stable`；`--from-source` 只能与 `--claude` 或 `--codex` 之一同用，与 adapter 宿主、`--auto-update` 同用报错；附带 `--skip-build`（只与 `--from-source` 同用）。
- 源码仓库四项判据（Node 严格 JSON 判定，bash 用 grep 近似判定，两者都有测试）：根 `package.json` 的 `name=tenon`；`.claude-plugin/marketplace.json` 的 `name=tenon` 且 `plugins[0].source="./"`；存在 `skills/sources.yaml`；存在 `runtime/tenon-bootstrap.mjs`。
- `RuntimeDevSource` 字段与取值：`{ kind: 'dev', repoRealpath, commit(40 位小写十六进制), dirty(boolean), worktreeDigest(40 位十六进制), skillsIndexDigest(40 位十六进制或 'absent') }`；`install-channel` 标记里对应键 `channel=dev`、`host`、`release_id`、`installed_at`、`repo`、`commit`、`dirty`、`worktree_digest`、`skills_index_digest`。
- `worktreeDigest` 口径（Node 与 `hooks/source-drift.sh` 必须逐字一致）：路径集合 = `git ls-files -z --cached --others --exclude-standard -- <PAYLOAD_ENTRIES>` 去重、只留 `[ -f ]` 的、按 UTF-8 字节序排序；每行 `<blob40> <path>\n`，blob 取工作区文件原始字节（等价 `git hash-object --no-filters`，`.gitattributes` 里 `skills/** eol=lf` 会让带过滤器的哈希与原始字节不一致，所以必须 `--no-filters`）；整体摘要 = 该文本的 git blob id（SHA-1，等价 `git hash-object --stdin`）。`skillsIndexDigest` = `skills/skills.lock.json` 原始字节的 git blob id，文件不存在为 `absent`。`commit` 只做展示，不算漂移判据（提交文档类改动不应触发提示）。
- release id：无 `devSource` 时 `runtimeReleaseIdV2` 的结果必须与改动前逐字节相同（有测试钉死）；有 `devSource` 时把 `devSource` 全部字段按长度前缀帧并入摘要。manifest 的 `stableTarget` 与 `devSource` 互斥；`devSource` 只允许 `source.host` 为 `codex` / `claude`。
- 插件版本字符串不变（仍是 `plugin.json` 的 `x.y.z`）；开发安装的展示串是 `<version>+dev.<sha7>`，只出现在 `/api/health` 的 `displayVersion` 与 doctor 文案里，`serverVersion` / `version` 字段本身不改。
- hook 热路径红线：`hooks/session-start.sh` 内 `grep -c "node"` 必须为 0，且不得出现 `find` / `xargs` / `jq`；新 hook 文件 `hooks/source-drift.sh` 内无 node / python / jq；任何失败返回空、不阻断（fail-open）。
- 所有测试与验收一律在隔离 HOME / `TENON_RUNTIME_HOME` 下，不得读写真实 `$HOME`、真实 Claude / Codex 配置或真实 Tenon 状态；Task 17 是唯一碰真实 HOME 的任务，且只在交付步经用户确认后执行。
- 代码注释与报错用中文，风格与所在文件一致；不新增依赖；tracked 的 `packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`、`packages/dashboard-app/dist/**` 只能由 `npm run build` 生成，禁止手改。
- 提交信息结尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 共享文件：`hooks/session-start.sh`、`tools/test-hooks.sh` 与 A 部分（`docs/superpowers/plans/fix-hook-cross-session-isolation.md`）共用；Task 14 必须在 A 部分的 hook Task 合入之后再做，并在其基础上 rebase 编辑，不得覆盖 A 部分的改动。

## Review Focus

以下是 spec 隐含、但没有哪个 Task 的主线测试覆盖得到、又最可能咬到使用者的输入或失败形态；每条都在括号里写明了钉住它的测试位置。

1. **工作区在 `--from-source` 执行期间被改**（build 之后、激活之前改了 hook 或技能）：必须拒绝激活并让用户重跑，不能把「冻结时的身份」写进一个内容已变的 release。（Task 8 `revalidateCandidate` 用例）
2. **上游技能拉取失败**：整体中止，不创建 WAL、不执行任何宿主命令、不改 launcher；残留的半拉取目录只在被 git 忽略的 `skills/` 里，重跑幂等。（Task 7 `failed` 用例 + Task 8 「ensure 失败不进 publish」用例）
3. **仓库路径含空格或经符号链接进入**（macOS 的 `/tmp` 实为 `/private/tmp`，Codex 回报 realpath、Claude 回报原样）：身份一律用 realpath，宿主登记与仓库的比较也先 realpath；`install-channel` 里的 `repo=` 值允许空格（bash 端按整行取值）。（Task 3 符号链接与含空格标记用例、Task 6 `devMarketplaceIsRepo` 用例）
4. **开发安装之上再跑正式 `tenon setup --claude` / `tenon update --claude --to-stable`**：目录 marketplace 不能把正式路径卡死（`observeNativeHost` 曾在目录 marketplace 上抛「identity 不完整」），成功后 `install-channel` 标记必须被清掉，否则 hook 与 `auto-update.sh` 会按旧标记行事。（Task 2 的目录 marketplace 观察用例、Task 9 的清标记用例、Task 10 的 `--to-stable` 守卫用例；真实宿主上的 `--to-stable` 端到端只在 Task 17 Step 5 的回退里首次走一遍，验收脚本只覆盖开发安装一侧，这是已知的剩余风险）
5. **hook 的 fail-open 与陈旧标记**：没有 git、不在 git 仓库、标记缺失或损坏、`tenon runtime repair --rollback` 之后标记的 `release_id` 与 `TENON_ACTIVE_RELEASE_ID` 不一致，都必须零输出或退回「已装为正式版」文案，绝不报错、绝不阻断会话。（Task 14 `tools/test-hooks.sh` 新小节）

## 规划核实记录（与「规划子代理方案」的差异，执行者必读）

核实对象是 2026-10-07 的 `main` checkout（b0f92369）。下表每一项都带文件:行号，执行前先各自复核一遍再动手。

| # | 方案里的说法 | 核实结果 | 对本计划的影响 |
| --- | --- | --- | --- |
| 1 | 开发安装计划 `claude plugin remove tenon@tenon` | Claude 没有 `plugin remove`，现有稳定计划用 `claude plugin uninstall tenon@tenon --scope user`（`packages/cli/src/commands/plugin-host.ts:277-280`）；Codex 才是 `plugin remove` | Task 6 的 `devHostPlan` 照稳定计划的命令形态 |
| 2 | 「`plugin list --json` 版本与 installPath 形态要 spike，`parseHostPluginInventory` 能否解析」 | 能解析：真实输出多出 `readFromFolder` / `folderVersion` 字段被忽略，`installPath` 是绝对路径（见 Task 1 预检）。**真正会炸的是 `observeNativeHost`**：Claude 的目录 marketplace 条目是 `{name, source:'directory', path, installLocation}`，没有 `repo`，`managed-host-state.ts:173-182` 会抛「claude tenon marketplace identity 不完整」——它同时挡住开发安装与「开发安装之上的正式 setup/update」 | 新增 Task 2 先修；Task 6 的开发观察函数另写，不依赖它 |
| 3 | journal 加互斥的 `devIdentity` 与 `proveFrozenDev` | 不需要改 WAL schema：host step 的 desired 里已含 repo 与版本，换仓库重试会被 `desiredMatches` 拒绝（`packages/cli/src/runtime/managed-host-reconciliation.ts:60-62,109-114`）；身份在进程内冻结，由 `revalidateCandidate`（`release-activation-validation.ts:6-27`，candidate-resolved 阶段激活前调用）重算比对，激活后由 `assertManagedActivationIdentity` 比对 release 上的 `devSource`。只需在 `managed-release-journal-coordinator.ts` 加一条「开发安装拒绝接管正式 pending 事务」守卫 | 少改 `managed-release-journal.ts` 的严格 codec；Task 5 |
| 4 | `ReleaseSourceStrategy {kind, frozenIdentity(), hostPlan(), proveFrozen()}` 抽象 | 只有两种来源，抽象只会多出一层；稳定路径一行不动，开发路径是独立模块 `source-install.ts` | 不引入策略接口 |
| 5 | `skillsIndexDigest = 规范化 skills.lock.json 的 sha256` | bash 端无法规范化 JSON；`serializeUpstreamSkillLock` 已是确定性序列化，直接取原始字节的 git blob id，bash 端 `git hash-object --no-filters` 即可得到同一值 | Global Constraints 口径 |
| 6 | worktreeDigest 覆盖整个仓库（`git ls-files --cached --others --exclude-standard`） | 全仓库口径会让任何 docs / openspec 改动都报「漂移」，噪声大到会被用户忽略；安装物只有 `PAYLOAD_ENTRIES`（`release-store-codecs.ts:22-36`）。收窄到 `PAYLOAD_ENTRIES` 后被忽略的上游技能自然排除 | Global Constraints 口径；hook 与 Node 共用同一路径集合，有交叉测试 |
| 7 | hook 只比 commit + 读 doctor 缓存的 `source-drift.json` | 缓存会滞后（编辑后新开会话仍是旧结论），commit 单比对每次提交都报警。精确摘要在 hook 里实测 20 ms（358 文件 / 10 MB：`git ls-files … \| git hash-object --stdin-paths \| git hash-object --stdin`），所以 hook 直接精确比较，不需要缓存；commit 只展示 | **偏离已定决定 3 的「结果缓存到 stateRoot」一句**，见 Task 12 说明；主线若坚持缓存可另加 |
| 8 | `install-channel` 与 `dev-install.env` 两个文件 | 合并成一个 `<configRoot>/install-channel`（`channel=dev` 一行 + 身份键）；hook 用其中的 `release_id` 与 `TENON_ACTIVE_RELEASE_ID` 比对，回滚后标记陈旧时自动按正式版处理 | Task 3、Task 14 |
| 9 | 关闭 auto-update：`configureAutoUpdate(false)` | `setupEnvironment.ts:238-239` 的 `if (!enabled) return 0` 什么都不写，已启用的偏好不会被关；开发安装必须显式把 `auto-update.conf` 改写成 `enabled=false` | Task 8 `disableAutoUpdateForDev` |
| 10 | Dashboard 版本徽标 | Dashboard SPA 目前**没有**任何版本徽标（`packages/dashboard-app/src` 里没有读取 `snapshot.version` 的组件），proposal 的非目标也写了「不改 Dashboard 页面」。落点只有 `/api/health`（`channel`、`commit`、`displayVersion`） | Task 13 只改 server |
| 11 | `update-native.ts` 的 `compareReleaseOrder > 0` 拒绝降级处对 dev 跳过 | 位置准确（`update-native.ts:203`），且开发版本号来自仓库 `plugin.json`，可能高于最新正式版；`--to-stable` 是显式授权 | Task 10 |
| 12 | 稳定路径在 `hostExact` 里调 `nativeHostMatchesStableTarget`（`update-native.ts:208-210`） | 开发安装下版本号可能恰好等于最新正式版而进入该调用；它依赖 `observeNativeHost`，Task 2 修复后返回「非 canonical 远端」的不匹配而不是抛错 | Task 2 兜住 |
| 13 | legacy 插件冲突 receipt（`recordPendingHostPluginConflict`） | 整条链路绑定 `StableReleaseTarget`（`host-plugin-convergence.ts:36-47`）。开发安装不写、不收敛该 receipt；预检里遇到 `cleanup-pending` 直接拒绝并提示先完成正式 setup | Task 8 |
| 14 | Claude 的目录 marketplace 是否按版本号建缓存、同版本重装是否刷新 | 预检结果：`plugin install` 对已安装的同版本直接说「loads in place from <repo>」不刷新缓存；`uninstall` 后再 `install` 才刷新。开发计划本来就先 uninstall 再 install，所以总是刷新 | Task 6 沿用稳定计划的五步顺序 |
| 15 | `docs/usage/zh-CN/cli-reference.md` 里改 `tenon setup --<one-host> …` 那行 | zh-CN 参考页没有这两行（命令列表在第 8-12 行，是 `tenon setup --codex` 等逐行形式） | Task 16 分别写两页的编辑位置 |
| 16 | 「全部验收命令」 | `bash tools/test-hooks.sh` 的 section 3 红线只覆盖 `session-start.sh` 本体，`hooks/source-drift.sh` 是被 source 的新文件，红线要为它单独加断言 | Task 14 |

另：2026-10-07 规划核实时，一条只读验证命令（`node --input-type=module -e` 调 `observeNativeHost` 看 Claude 目录 marketplace 是否抛错）被 Tenon 的 PreToolUse gate 拦截，原文：`测试记录与基线只能由 tenon test run / tenon test baseline 写入；测试计划、已知失败清单与豁免只能经 tenon test plan|register|waive|known 与 tenon review 写入`。规划者没有绕过它，该结论（差异表第 2 项）依据 `managed-host-state.ts:168-182` 的代码阅读得出；Task 2 的失败测试会把它变成可执行的证据。

## 文件结构

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `packages/cli/src/commands/managed-host-state.ts` | 改（行 173-174） | 目录 marketplace 的身份取 `path`，不再抛错 |
| `packages/cli/src/runtime/types.ts` | 改 | `RuntimeDevSource`、manifest v2 的可选 `devSource` |
| `packages/cli/src/runtime/dev-source-identity.ts` | 新 | 四项判据、`worktreeDigest` / `skillsIndexDigest` / `computeDevSourceIdentity` / `compareDevSource` / `devVersionLabel` |
| `packages/cli/src/runtime/dev-install-marker.ts` | 新 | `install-channel` 标记的编码、解析、原子写、删除 |
| `packages/cli/src/runtime/release-store-codecs.ts` | 改（行 88-143） | `devSource` 解码、release id 并入 `devSource` |
| `packages/cli/src/runtime/release-store.ts` | 改（行 107-122、230-279） | `stageAndActivate` 接收 `devSource` 并写进 manifest |
| `packages/cli/src/runtime/installer-contract.ts`、`installer.ts` | 改 | `activate(…, devSource?)` 贯通 |
| `packages/cli/src/commands/release-coordinator-contract.ts`、`release-coordinator.ts`、`release-activation-validation.ts`、`managed-release-journal-coordinator.ts` | 改 | `devSource` 贯通激活、身份断言、pending 事务守卫 |
| `packages/cli/src/commands/dev-host.ts` | 新 | 开发宿主计划、观察、desired-state、匹配函数 |
| `packages/cli/src/upstream-skills/ensure.ts` | 新 | 缺技能 / 缺索引时按 `sources.yaml` 拉取 |
| `packages/cli/src/commands/source-install.ts` | 新 | `--from-source` 的编排（预检 → 拉取 → 构建 → 冻结身份 → 托管事务） |
| `packages/cli/src/program-install.ts`、`commands/setupEnvironment.ts`、`commands/setupHost.ts` | 改 | 选项、校验、dry-run、分发、清标记、关 auto-update |
| `packages/cli/src/commands/update-dev-guard.ts` | 新 | 开发安装下 `tenon update` 的裁决 |
| `packages/cli/src/commands/update.ts`、`update-native.ts`、`update-native-contract.ts` | 改 | `--to-stable`、守卫、跳过降级拒绝、成功后清标记 |
| `packages/cli/src/deps.ts`、`commands/doctor-product-identity.ts`、`commands/doctor.ts`、`commands/doctor-probes.ts`、`src/test-support.ts` | 改 | `identity:release` 的 dev 分支、`source:drift` 探针 |
| `packages/cli/src/commands/doctor-source-drift.ts` | 新 | `checkSourceDrift`、`collectSourceDriftFacts` |
| `packages/server/src/{version,types,server,serverGetRoutes,serverGetActivityRoutes,main}.ts` | 改 | `/api/health` 的 `channel` / `commit` / `displayVersion` |
| `hooks/source-drift.sh` | 新 | SessionStart 的纯 bash 漂移比较 |
| `hooks/session-start.sh`、`hooks/auto-update.sh`、`tools/test-hooks.sh` | 改（与 A 部分共享） | 接线、dev 标记守卫、测试 |
| `tools/source-install-acceptance.mjs`、`tools/source-install-acceptance.node-test.mjs`、`package.json` | 新 / 改 | 隔离 HOME 的真实 Claude / Codex 验收与 `test:source-install` |
| `docs/DIST-RELEASE.md`、`docs/usage/{cli-reference,contributor-development,dashboard-and-local-api}.md` 及 `zh-CN/`、`.agent-rules/COMMON.md` | 改 | 用户与贡献者文档、长期规则 |

## Spike 结论（Task 1 由执行者填写）

下表左两列是 2026-10-07 规划期预检（`claude` 2.1.292、`codex-cli` 0.154.0，一次性隔离 HOME，本机真实状态未触碰，**非权威**）；右列由 Task 1 的执行者在自己的隔离 HOME 里复测后填写，写 `confirmed` 或写明差异。任何一行不是 `confirmed`，先停下回报主线，不要自行改设计。

| # | 问题 | 规划期预检观察 | 执行者复核 |
| --- | --- | --- | --- |
| 1a | Claude 对本地目录 marketplace，`plugin install` 是否复制被 `.gitignore` 忽略的文件 | 复制：被忽略的 `skills/ignored-skill/`、`skills/skills.lock.json` 与未被忽略的文件一同进入 `~/.claude/plugins/cache/tenon/tenon/<version>/`；`.git` 不复制；`node_modules` 会复制 | confirmed（claude 复测：ignored-skill、skills.lock.json、sources.yaml 与 .agents / .codex-plugin 均进缓存，无 .git；node_modules 未复测） |
| 1b | Claude 缓存是否按版本号建、同版本重装是否刷新 | 目录名按 `plugin.json` 的 version；已安装时再 `install` 只回「loads in place from <repo>」不刷新；`uninstall` 后再 `install` 才刷新缓存内容 | confirmed（缓存目录按 version；已装再 install 回 already installed / loads in place，缓存仍是 body；uninstall 后再 install 刷新为 dirty / ign） |
| 1c | Codex 是否复制被忽略的文件、同版本 `plugin add` 是否刷新 | 复制（连 `.git`、`node_modules`）；`plugin add` 对已安装的同版本也会刷新缓存 | confirmed（缓存含 .git、被忽略的技能与索引；同版本再 add 刷新为 dirty2） |
| 2 | Codex 是否支持本地目录 marketplace 及语法 | 支持：`codex plugin marketplace add <dir> --json` → `{marketplaceName, installedRoot(realpath), alreadyAdded}`；`codex plugin add tenon@tenon --json` | confirmed（marketplace add 的 installedRoot 为 /private/var/... realpath；plugin add --json 返回 pluginId、version、installedPath） |
| 3a | Claude `plugin marketplace list --json` 的目录条目形态 | `[{"name":"tenon","source":"directory","path":"<repo>","installLocation":"<repo>"}]`，没有 `repo` 字段 | confirmed（claude 的 path / installLocation 为 TMPDIR 原样 /var/folders/...，无 repo 字段；codex 回报 /private/var realpath，两者需 realpath 比较） |
| 3b | Claude `plugin list --json` 的条目形态 | `{"id":"tenon@tenon","version":"0.3.2","scope":"user","enabled":true,"installPath":"<home>/.claude/plugins/cache/tenon/tenon/0.3.2","readFromFolder":"<repo>","folderVersion":"0.3.2",…}`；`parseHostPluginInventory` 解析得 `tenonRoot=installPath`、`tenonVersion=0.3.2` | confirmed（parseHostPluginInventory 得 tenonRoot=installPath、tenonVersion=0.3.2、tenonRegistered=true） |
| 3c | Codex 两个 list 的条目形态 | `marketplace list --json` → `{"marketplaces":[{"name":"tenon","root":"<realpath>","marketplaceSource":{"sourceType":"local","source":"<realpath>"}}]}`；`plugin list --json` → `installed[0].source.path = <realpath of repo>`，`version` 为 plugin.json 的 version | confirmed（parseHostPluginInventory 得 tenonRoot=仓库 realpath、tenonVersion=0.3.2、tenonRegistered=true；注意 codex 的 tenonRoot 是仓库而非缓存） |
| 4 | `host-plugin-convergence.ts`、`managed-host-observation.ts`、`native-candidate-revalidation.ts` 对稳定目标的硬依赖 | 代码阅读结论（已核实，不需要实测）：`desiredNativeHostPostcondition` 的 `plugin-remove` / `marketplace-remove` 缺 `StableReleaseTarget` 就抛错、`marketplace-register` 要求 canonical GitHub 源（`managed-host-observation.ts:205-283`）；`revalidateNativeStableCandidate` 重新向远端证明 tag（`native-candidate-revalidation.ts:26-80`）；`recordPendingHostPluginConflict` 要求 `stableTarget`。dev 等价匹配函数在 Task 6 | 代码阅读，Task 1 不需要填 |

---

### Task 1: Spike —— 本地目录 marketplace 在隔离 HOME 里的真实行为

**Files:**
- Modify: `docs/superpowers/plans/fix-hook-cross-session-isolation-part-b.md`（只填上面「Spike 结论」表的右列）
- 一次性夹具在 `mktemp -d` 目录里，不进仓库、不用真实 HOME。

**Interfaces:**
- Consumes: 本机 `claude`、`codex` CLI（缺哪个就跳过哪个，并在表里写「该宿主未安装，未复核」）。
- Produces: 「Spike 结论」表的复核列；后续 Task 6 / 8 / 9 / 15 的夹具与断言以它为准。

- [ ] **Step 1: 建夹具仓库与隔离环境**

```bash
set -euo pipefail
SP="$(mktemp -d "${TMPDIR:-/tmp}/tenon-spike-XXXXXX")"
mkdir -p "$SP/home" "$SP/repo"
cd "$SP/repo"
git init -q -b main . && git config user.email spike@example.invalid && git config user.name spike
mkdir -p .claude-plugin .codex-plugin .agents/plugins skills/tenon skills/ignored-skill hooks
cat > .claude-plugin/marketplace.json <<'EOF'
{"name":"tenon","owner":{"name":"x"},"metadata":{"description":"d","version":"0.3.2"},"plugins":[{"name":"tenon","source":"./","description":"d","category":"workflow"}]}
EOF
cat > .claude-plugin/plugin.json <<'EOF'
{"name":"tenon","description":"d","version":"0.3.2","skills":"./skills/"}
EOF
cp /Users/a1234/Documents/code-manager/projects/tenon-local/.agents/plugins/marketplace.json .agents/plugins/marketplace.json
cp /Users/a1234/Documents/code-manager/projects/tenon-local/.codex-plugin/plugin.json .codex-plugin/plugin.json
printf '/skills/*\n!/skills/tenon/\n!/skills/sources.yaml\n' > .gitignore
printf -- '---\nname: tenon\ndescription: x\n---\nbody\n' > skills/tenon/SKILL.md
printf -- '---\nname: ignored-skill\ndescription: x\n---\nbody\n' > skills/ignored-skill/SKILL.md
echo '{"version":1}' > skills/skills.lock.json
echo 'skills: []' > skills/sources.yaml
git add -A && git add -f .agents .codex-plugin && git commit -qm init
git status --short --ignored | head
echo "SP=$SP"
```

预期：`!! skills/ignored-skill/` 与 `!! skills/skills.lock.json` 被列为 ignored。把 `SP` 记下来，后面的命令都用它。

- [ ] **Step 2: Claude 复测（1a / 1b / 3a / 3b）**

```bash
SP=<上一步打印的目录>
export HOME="$SP/home" CLAUDE_CONFIG_DIR="$SP/home/.claude"
claude plugin marketplace add "$SP/repo" --json
claude plugin marketplace list --json
claude plugin install tenon@tenon
claude plugin list --json
IP="$SP/home/.claude/plugins/cache/tenon/tenon/0.3.2"
ls -a "$IP" "$IP/skills"                       # 1a：ignored-skill、skills.lock.json 是否在
echo "dirty" >> "$SP/repo/skills/tenon/SKILL.md"
echo "ign" >> "$SP/repo/skills/ignored-skill/SKILL.md"
claude plugin install tenon@tenon              # 1b：应回 already installed / loads in place
tail -1 "$IP/skills/tenon/SKILL.md" "$IP/skills/ignored-skill/SKILL.md"   # 仍是 body：未刷新
claude plugin uninstall tenon@tenon --scope user
claude plugin install tenon@tenon
tail -1 "$IP/skills/tenon/SKILL.md" "$IP/skills/ignored-skill/SKILL.md"   # 现在是 dirty / ign：已刷新
```

- [ ] **Step 3: Codex 复测（1c / 2 / 3c）**

```bash
SP=<同上>
export HOME="$SP/home" CODEX_HOME="$SP/home/.codex"
mkdir -p "$CODEX_HOME"
codex plugin marketplace add "$SP/repo" --json
codex plugin marketplace list --json
codex plugin add tenon@tenon --json
codex plugin list --json
IP="$(ls -d "$CODEX_HOME"/plugins/cache/tenon/tenon/*)"
ls -a "$IP" "$IP/skills"                       # 1c
echo "dirty2" >> "$SP/repo/skills/tenon/SKILL.md"
codex plugin add tenon@tenon --json            # 同版本再 add
tail -1 "$IP/skills/tenon/SKILL.md"            # dirty2：已刷新
```

- [ ] **Step 4: 用现有解析函数核对 3b / 3c**

在仓库根执行 `npm run build:packages` 后，写一个放在 `$SP`（不在仓库内）的小脚本 `$SP/check.mjs`，对 Step 2 / 3 保存下来的 `plugin list --json` 输出调用 `parseHostPluginInventory`（从 `packages/cli/dist/commands/plugin-host.js` 导入），打印 `tenonRoot`、`tenonVersion`、`tenonRegistered`。预期与表中 3b / 3c 一致。

- [ ] **Step 5: 填表、清理、提交**

把观察逐行写进「Spike 结论」表的「执行者复核」列（`confirmed` 或差异说明）。`rm -rf "$SP"`（先 `echo "$SP"` 确认它在 `${TMPDIR:-/tmp}` 下）。

```bash
git add docs/superpowers/plans/fix-hook-cross-session-isolation-part-b.md
git commit -m "docs(plan): record the local directory marketplace spike for the source install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**分支规则（执行者按表里的结论走，不要自行发挥）：**
- 1a 或 1c 为「不复制」：上游技能无法经宿主 CLI 进入宿主加载根，而往宿主缓存里补拷违反 `docs/DIST-RELEASE.md` 写明的「宿主 CLI 是自己缓存的唯一 writer」边界，所以**停下回报主线重新决策**，不要继续 Task 6 之后的任务（Task 8 的 `assertHostHasUpstreamSkills` 会在这种宿主上把安装中止，那是预期的 fail-closed）。
- 1b 与预检不一致（例如 Claude 同版本重装也不刷新而 uninstall 后也不刷新）：开发计划的「先 uninstall 再 install」不再保证缓存刷新，停下回报。
- 2 为「Codex 不支持目录 marketplace」：Task 8 的 `validateFromSourceOptions` 在「adapter 宿主」判断之后加 `if (host === 'codex') return '当前 Codex 版本不支持目录 marketplace，--from-source 暂只支持 --claude'`（并在 Task 8 的校验用例里加对应一行），Task 15 去掉 codex 场景。
- 3a / 3b / 3c 任一不能被 `parseHostPluginInventory` 或 Task 6 的 `observeDevNativeHost` 解析：停下回报，Task 6 的夹具与观察函数要先重设计。
- 其余全部 `confirmed`：按本计划原样执行。

---

### Task 2: `observeNativeHost` 容忍目录 marketplace

**Files:**
- Modify: `packages/cli/src/commands/managed-host-state.ts:173-174`
- Create: `packages/cli/src/commands/managed-host-state.test.ts`

**Interfaces:**
- Consumes: 现有 `observeNativeHost(env: SetupEnv, host: NativePipelineHost): string`、`decodeNativeHostObservation(value: string): NativeHostObservation`。
- Produces: 对 Claude 目录 marketplace 条目 `{name, source:'directory', path, installLocation}` 返回 `marketplace = { root: installLocation, source: path, sourceType: 'directory', head, ref, clean }`，不再抛错。Task 10 与「开发安装之上的正式 setup」依赖这一点。

- [ ] **Step 1: 写失败测试** `packages/cli/src/commands/managed-host-state.test.ts`

```ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { decodeNativeHostObservation, observeNativeHost } from './managed-host-state.js'
import type { SetupEnv } from './setupEnvironment.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repoDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-host-state-')))
  roots.push(root)
  return root
}

/** 只回答 observeNativeHost 会问的几类命令；其余视为未预期。 */
function fakeEnv(outputs: Record<string, string>): SetupEnv {
  const run = (cmd: string, args: string[]) => {
    if (cmd === 'git') {
      if (args.includes('rev-parse')) return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'main\n', stderr: '' }
      if (args.includes('diff')) return { code: 0, stdout: '', stderr: '' }
      if (args.includes('ls-files')) return { code: 0, stdout: '', stderr: '' }
    }
    const out = outputs[[cmd, ...args].join(' ')]
    return out === undefined
      ? { code: 127, stdout: '', stderr: `unexpected command: ${cmd} ${args.join(' ')}` }
      : { code: 0, stdout: out, stderr: '' }
  }
  return {
    homeDir: () => '/home/test',
    runtimeEnv: () => ({}),
    readText: () => undefined,
    runCommand: run,
  } as unknown as SetupEnv
}

describe('observeNativeHost on a directory marketplace (tenon setup --from-source)', () => {
  test('Claude: a directory marketplace has no repo field; its identity is the path', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'claude plugin marketplace list --json': JSON.stringify([
        { name: 'tenon', source: 'directory', path: repo, installLocation: repo },
      ]),
      'claude plugin list --json': JSON.stringify([
        {
          id: 'tenon@tenon',
          version: '0.3.2',
          scope: 'user',
          enabled: true,
          installPath: '/home/test/.claude/plugins/cache/tenon/tenon/0.3.2',
          readFromFolder: repo,
          folderVersion: '0.3.2',
        },
      ]),
    })
    const observation = decodeNativeHostObservation(observeNativeHost(env, 'claude'))
    expect(observation.marketplace).toMatchObject({ root: repo, source: repo, sourceType: 'directory' })
    expect(observation.plugin).toMatchObject({ id: 'tenon@tenon', version: '0.3.2', enabled: true })
  })

  test('Claude: a github marketplace keeps reporting repo as its source', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'claude plugin marketplace list --json': JSON.stringify([
        { name: 'tenon', source: 'github', repo: 'jefferysha/tenon', installLocation: repo },
      ]),
      'claude plugin list --json': '[]',
    })
    const observation = decodeNativeHostObservation(observeNativeHost(env, 'claude'))
    expect(observation.marketplace).toMatchObject({ source: 'jefferysha/tenon', sourceType: 'github' })
    expect(observation.plugin).toBeNull()
  })

  test('Codex: a local marketplace reports its source path and sourceType local', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'codex plugin marketplace list --json': JSON.stringify({
        marketplaces: [{
          name: 'tenon',
          root: repo,
          marketplaceSource: { sourceType: 'local', source: repo },
        }],
      }),
      'codex plugin list --json': JSON.stringify({ installed: [] }),
    })
    const observation = decodeNativeHostObservation(observeNativeHost(env, 'codex'))
    expect(observation.marketplace).toMatchObject({ root: repo, source: repo, sourceType: 'local' })
  })

  test('Claude: an entry that is neither github nor directory still fails closed', () => {
    const repo = repoDir()
    const env = fakeEnv({
      'claude plugin marketplace list --json': JSON.stringify([
        { name: 'tenon', source: 'url', installLocation: repo },
      ]),
      'claude plugin list --json': '[]',
    })
    expect(() => observeNativeHost(env, 'claude')).toThrow('claude tenon marketplace identity 不完整')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/managed-host-state.test.ts`
Expected: 第一个用例 FAIL，报 `claude tenon marketplace identity 不完整`；Codex 与 github 用例 PASS，第四个用例 PASS（回归保护）。

- [ ] **Step 3: 最小实现** 把 `managed-host-state.ts:173-174` 改成

```ts
    const source = host === 'codex'
      ? sourceRecord?.source
      // 目录 marketplace（tenon setup --from-source）没有 repo 字段，身份就是它登记的 path。
      : item.repo ?? (item.source === 'directory' ? item.path : undefined)
    const sourceType = host === 'codex' ? sourceRecord?.sourceType : item.source
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/managed-host-state.test.ts packages/cli/src/commands/managed-host-observation.test.ts packages/cli/src/commands/managed-host-command.test.ts`
Expected: 全部 PASS（后两个文件是对稳定路径的回归保护）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/managed-host-state.ts packages/cli/src/commands/managed-host-state.test.ts
git commit -m "fix(cli): observe a directory marketplace instead of throwing on its missing repo field

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 开发源码身份与 `install-channel` 标记

**Files:**
- Modify: `packages/cli/src/runtime/types.ts`（在 `RuntimeStableReleaseTarget`（行 30-34）之后加 `RuntimeDevSource`；`RuntimeReleaseManifestV2`（行 44-52）加 `devSource?`）
- Create: `packages/cli/src/runtime/dev-source-identity.ts`、`packages/cli/src/runtime/dev-source-identity.test.ts`
- Create: `packages/cli/src/runtime/dev-install-marker.ts`、`packages/cli/src/runtime/dev-install-marker.test.ts`
- Create（测试支撑，Task 12、Task 14 的测试也用它）: `packages/cli/src/runtime/dev-source-test-support.ts`

**Interfaces:**
- Consumes: `PAYLOAD_ENTRIES`（`release-store-codecs.ts:22-36`）。
- Produces（后续 Task 原样使用这些名字与签名）：
  ```ts
  // types.ts
  export interface RuntimeDevSource {
    readonly kind: 'dev'; readonly repoRealpath: string; readonly commit: string
    readonly dirty: boolean; readonly worktreeDigest: string; readonly skillsIndexDigest: string
  }
  // dev-source-identity.ts
  export const DEV_PAYLOAD_PATHSPECS: readonly string[]
  export type GitRun = (repo: string, args: readonly string[]) => string          // 非零退出抛错
  export const realGitRun: GitRun
  export function gitBlobId(bytes: Uint8Array): string
  export type SourceRepoVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }
  export function checkTenonSourceRepo(repo: string): SourceRepoVerdict
  export type SourceRepoResolution = { readonly ok: true; readonly repo: string } | { readonly ok: false; readonly reason: string }
  export function resolveSourceRepo(input: string, git?: GitRun): SourceRepoResolution
  export function computeWorktreeDigest(repo: string, git?: GitRun): string
  export function computeSkillsIndexDigest(repo: string): string
  export function computeDevSourceIdentity(repoInput: string, git?: GitRun): RuntimeDevSource
  export function devSourceEquals(left: RuntimeDevSource, right: RuntimeDevSource): boolean
  export function compareDevSource(installed: RuntimeDevSource, live: RuntimeDevSource): readonly string[]   // 空数组 = 一致
  export function devVersionLabel(version: string, commit: string): string        // `${version}+dev.${commit.slice(0, 7)}`
  // dev-install-marker.ts
  export interface DevInstallMarker { readonly host: 'codex' | 'claude'; readonly releaseId: string; readonly installedAt: string; readonly devSource: RuntimeDevSource }
  export function installChannelPath(configRoot: string): string
  export function encodeInstallChannel(marker: DevInstallMarker): string
  export function parseInstallChannel(text: string): DevInstallMarker | null
  export function writeInstallChannelMarker(configRoot: string, marker: DevInstallMarker): void
  export function removeInstallChannelMarker(configRoot: string): void
  ```

- [ ] **Step 1: 先建测试支撑，再写失败测试**

`packages/cli/src/runtime/dev-source-test-support.ts`（不是 `*.test.ts`，vitest 不会收录；只供测试 import）：

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const roots: string[] = []

/** 测试的 afterEach 里调用：删掉本文件登记过的全部临时目录。 */
export function cleanupSourceRepoFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export function trackFixtureRoot(root: string): string {
  roots.push(root)
  return root
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

/** 在 cwd 里跑 git（隔离用户的全局 git 配置），返回 stdout。 */
export function gitIn(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    ...(input === undefined ? {} : { input }),
  })
}

export function writeFixtureFile(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

/** 满足四项判据、有安装内容文件、有一个被忽略的上游技能与本机索引的最小源码仓库（返回 realpath）。 */
export function makeSourceRepo(options: { commit?: boolean } = {}): string {
  const root = trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-dev-source-'))))
  const write = (rel: string, text: string): void => writeFixtureFile(root, rel, text)
  write('package.json', JSON.stringify({ name: 'tenon', version: '0.3.2' }))
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon', source: './' }] }))
  write('.claude-plugin/plugin.json', JSON.stringify({ name: 'tenon', version: '0.3.2' }))
  write('.codex-plugin/plugin.json', JSON.stringify({ name: 'tenon', version: '0.3.2' }))
  write('.agents/plugins/marketplace.json', '{}\n')
  write('skills/sources.yaml', 'version: 1\nskills: {}\n')
  write('skills/tenon/SKILL.md', 'tenon\n')
  write('runtime/tenon-bootstrap.mjs', '// bootstrap\n')
  write('hooks/gate.sh', '#!/usr/bin/env bash\n')
  write('templates/workflow.md', 'workflow\n')
  write('docs/readme.md', 'docs\n')
  write('.gitignore', '/skills/*\n!/skills/tenon/\n!/skills/sources.yaml\n')
  write('skills/ignored-skill/SKILL.md', 'ignored upstream skill\n')
  write('skills/skills.lock.json', '{"version":1}\n')
  gitIn(root, ['init', '-q', '-b', 'main'])
  gitIn(root, ['config', 'user.email', 'test@example.invalid'])
  gitIn(root, ['config', 'user.name', 'test'])
  if (options.commit !== false) {
    gitIn(root, ['add', '-A'])
    gitIn(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  }
  return root
}
```

`packages/cli/src/runtime/dev-source-identity.test.ts`：

```ts
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  checkTenonSourceRepo, compareDevSource, computeDevSourceIdentity, computeSkillsIndexDigest,
  computeWorktreeDigest, DEV_PAYLOAD_PATHSPECS, devSourceEquals, devVersionLabel, gitBlobId,
  resolveSourceRepo,
} from './dev-source-identity.js'
import {
  cleanupSourceRepoFixtures, gitIn as git, makeSourceRepo, trackFixtureRoot, writeFixtureFile as write,
} from './dev-source-test-support.js'

afterEach(cleanupSourceRepoFixtures)

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

describe('checkTenonSourceRepo', () => {
  test('accepts a repository that meets the four criteria', () => {
    expect(checkTenonSourceRepo(makeSourceRepo())).toEqual({ ok: true })
  })

  test.each([
    ['root package.json name', (root: string) => write(root, 'package.json', JSON.stringify({ name: 'other' }))],
    ['marketplace name', (root: string) => write(root, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'other', plugins: [{ source: './' }] }))],
    ['marketplace plugins[0].source', (root: string) => write(root, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'tenon', plugins: [{ source: './sub' }] }))],
    ['skills/sources.yaml', (root: string) => rmSync(join(root, 'skills', 'sources.yaml'))],
    ['runtime/tenon-bootstrap.mjs', (root: string) => rmSync(join(root, 'runtime', 'tenon-bootstrap.mjs'))],
  ])('rejects when %s is wrong or missing', (_label, damage) => {
    const root = makeSourceRepo()
    damage(root)
    const verdict = checkTenonSourceRepo(root)
    expect(verdict.ok).toBe(false)
  })
})

describe('resolveSourceRepo', () => {
  test('resolves a symlinked path to the repository realpath', () => {
    const root = makeSourceRepo()
    const link = join(trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-dev-link-')))), 'link')
    symlinkSync(root, link)
    expect(resolveSourceRepo(link)).toEqual({ ok: true, repo: root })
  })

  test('rejects a sub directory, a missing path, an empty value, and a non-git tree', () => {
    const root = makeSourceRepo()
    expect(resolveSourceRepo(join(root, 'hooks')).ok).toBe(false)
    expect(resolveSourceRepo(join(root, 'does-not-exist')).ok).toBe(false)
    expect(resolveSourceRepo('  ').ok).toBe(false)
    const bare = trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-dev-nogit-'))))
    expect(resolveSourceRepo(bare).ok).toBe(false)
  })
})

describe('gitBlobId', () => {
  test('equals what git hash-object prints for the same bytes', () => {
    const bytes = Buffer.from('hello\nworld\n', 'utf8')
    const expected = execFileSync('git', ['hash-object', '--stdin'], { input: bytes, encoding: 'utf8', env: GIT_ENV }).trim()
    expect(gitBlobId(bytes)).toBe(expected)
  })
})

describe('computeWorktreeDigest', () => {
  test('follows the documented git recipe exactly', () => {
    const root = makeSourceRepo()
    const files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...DEV_PAYLOAD_PATHSPECS])
      .split('\n').filter((line) => line !== '').sort()
    const ids = git(root, ['hash-object', '--no-filters', '--stdin-paths'], `${files.join('\n')}\n`).trim().split('\n')
    const manifest = files.map((file, index) => `${ids[index]} ${file}\n`).join('')
    const expected = git(root, ['hash-object', '--stdin'], manifest).trim()
    expect(computeWorktreeDigest(root)).toBe(expected)
  })

  test('changes when installed content changes, is added, or is deleted', () => {
    const root = makeSourceRepo()
    const base = computeWorktreeDigest(root)
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edit\n')
    const edited = computeWorktreeDigest(root)
    expect(edited).not.toBe(base)
    write(root, 'templates/new.md', 'new\n')
    const added = computeWorktreeDigest(root)
    expect(added).not.toBe(edited)
    rmSync(join(root, 'templates', 'new.md'))
    rmSync(join(root, 'hooks', 'gate.sh'))
    expect(computeWorktreeDigest(root)).not.toBe(base)
  })

  test('ignores ignored upstream skills and files outside the payload', () => {
    const root = makeSourceRepo()
    const base = computeWorktreeDigest(root)
    appendFileSync(join(root, 'skills', 'ignored-skill', 'SKILL.md'), 'more\n')
    appendFileSync(join(root, 'skills', 'skills.lock.json'), '\n')
    appendFileSync(join(root, 'docs', 'readme.md'), 'more docs\n')
    expect(computeWorktreeDigest(root)).toBe(base)
  })

  test('is the same before and after staging and committing the same content', () => {
    const root = makeSourceRepo()
    write(root, 'hooks/new.sh', '#!/usr/bin/env bash\n')
    const untracked = computeWorktreeDigest(root)
    git(root, ['add', 'hooks/new.sh'])
    expect(computeWorktreeDigest(root)).toBe(untracked)
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'add new hook'])
    expect(computeWorktreeDigest(root)).toBe(untracked)
  })
})

describe('computeSkillsIndexDigest', () => {
  test('is the git blob id of the raw lock bytes, and absent without a lock', () => {
    const root = makeSourceRepo()
    const expected = git(root, ['hash-object', '--no-filters', 'skills/skills.lock.json']).trim()
    expect(computeSkillsIndexDigest(root)).toBe(expected)
    rmSync(join(root, 'skills', 'skills.lock.json'))
    expect(computeSkillsIndexDigest(root)).toBe('absent')
  })
})

describe('computeDevSourceIdentity', () => {
  test('freezes realpath, HEAD commit, dirty flag and both digests', () => {
    const root = makeSourceRepo()
    const identity = computeDevSourceIdentity(root)
    expect(identity).toMatchObject({
      kind: 'dev',
      repoRealpath: root,
      commit: git(root, ['rev-parse', 'HEAD']).trim(),
      dirty: false,
    })
    expect(identity.worktreeDigest).toMatch(/^[0-9a-f]{40}$/)
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edit\n')
    expect(computeDevSourceIdentity(root).dirty).toBe(true)
  })

  test('a docs-only change is not dirty for the installed payload', () => {
    const root = makeSourceRepo()
    appendFileSync(join(root, 'docs', 'readme.md'), 'x\n')
    expect(computeDevSourceIdentity(root).dirty).toBe(false)
  })

  test('refuses a repository without any commit and one that is not a Tenon source repository', () => {
    expect(() => computeDevSourceIdentity(makeSourceRepo({ commit: false }))).toThrow('还没有任何提交')
    const root = makeSourceRepo()
    rmSync(join(root, 'runtime', 'tenon-bootstrap.mjs'))
    expect(() => computeDevSourceIdentity(root)).toThrow('不是 Tenon 源码仓库')
  })
})

describe('compareDevSource', () => {
  const installed = {
    kind: 'dev' as const, repoRealpath: '/work/tenon', commit: 'a'.repeat(40), dirty: false,
    worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
  }

  test('commit and dirty are informational, not drift', () => {
    const live = { ...installed, commit: 'd'.repeat(40), dirty: true }
    expect(compareDevSource(installed, live)).toEqual([])
    expect(devSourceEquals(installed, live)).toBe(false)
  })

  test('reports repo, worktree and skills-index separately', () => {
    const reasons = compareDevSource(installed, {
      ...installed, repoRealpath: '/other/tenon', worktreeDigest: '1'.repeat(40), skillsIndexDigest: 'absent',
    })
    expect(reasons).toHaveLength(3)
    expect(reasons.join('\n')).toContain('/other/tenon')
  })
})

describe('devVersionLabel', () => {
  test('appends +dev and the short commit without touching the version', () => {
    expect(devVersionLabel('0.3.2', 'abcdef0123456789abcdef0123456789abcdef01')).toBe('0.3.2+dev.abcdef0')
  })
})
```

`packages/cli/src/runtime/dev-install-marker.test.ts`：

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  encodeInstallChannel, installChannelPath, parseInstallChannel,
  removeInstallChannelMarker, writeInstallChannelMarker, type DevInstallMarker,
} from './dev-install-marker.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const MARKER: DevInstallMarker = {
  host: 'claude',
  releaseId: `sha256-${'a'.repeat(64)}`,
  installedAt: '2026-10-07T12:00:00Z',
  devSource: {
    kind: 'dev', repoRealpath: '/work/tenon repo', commit: 'b'.repeat(40), dirty: true,
    worktreeDigest: 'c'.repeat(40), skillsIndexDigest: 'absent',
  },
}

describe('install-channel marker', () => {
  test('round-trips, one key per line, channel=dev first', () => {
    const text = encodeInstallChannel(MARKER)
    expect(text.split('\n')[0]).toBe('channel=dev')
    expect(text).toContain('repo=/work/tenon repo\n')
    expect(parseInstallChannel(text)).toEqual(MARKER)
  })

  test('rejects control characters when encoding and incomplete or unknown content when parsing', () => {
    expect(() => encodeInstallChannel({
      ...MARKER, devSource: { ...MARKER.devSource, repoRealpath: '/work/te\nnon' },
    })).toThrow('控制字符')
    expect(parseInstallChannel('channel=dev\nhost=claude\n')).toBeNull()
    expect(parseInstallChannel(`${encodeInstallChannel(MARKER)}surprise=1\n`)).toBeNull()
    expect(parseInstallChannel(encodeInstallChannel(MARKER).replace('channel=dev', 'channel=stable'))).toBeNull()
  })

  test('writes atomically under the config root and removes idempotently', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'tenon-marker-'))
    roots.push(configRoot)
    const nested = join(configRoot, 'config')
    writeInstallChannelMarker(nested, MARKER)
    expect(readFileSync(installChannelPath(nested), 'utf8')).toBe(encodeInstallChannel(MARKER))
    removeInstallChannelMarker(nested)
    expect(existsSync(installChannelPath(nested))).toBe(false)
    expect(() => removeInstallChannelMarker(nested)).not.toThrow()
    mkdirSync(join(configRoot, 'empty'))
    expect(() => removeInstallChannelMarker(join(configRoot, 'empty'))).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/runtime/dev-source-identity.test.ts packages/cli/src/runtime/dev-install-marker.test.ts`
Expected: FAIL（`Cannot find module './dev-source-identity.js'` / `./dev-install-marker.js`）。

- [ ] **Step 3: 最小实现**

`types.ts`：在 `RuntimeStableReleaseTarget` 之后加

```ts
/** 源码开发安装的身份：安装时冻结并写进 release manifest；漂移比较与展示都以它为准。 */
export interface RuntimeDevSource {
  readonly kind: 'dev'
  /** 仓库工作区根的 realpath；同时是托管 payload 的候选根。 */
  readonly repoRealpath: string
  readonly commit: string
  /** 安装时 PAYLOAD_ENTRIES 范围内是否有未提交改动；只用于展示。 */
  readonly dirty: boolean
  readonly worktreeDigest: string
  readonly skillsIndexDigest: string
}
```

并在 `RuntimeReleaseManifestV2` 的 `stableTarget?` 之后加

```ts
  /** 源码开发安装的身份；与 stableTarget 互斥，只允许原生宿主。 */
  readonly devSource?: RuntimeDevSource
```

`packages/cli/src/runtime/dev-source-identity.ts`：

```ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PAYLOAD_ENTRIES } from './release-store-codecs.js'
import type { RuntimeDevSource } from './types.js'

/**
 * 托管 release 真正发布的路径集合。安装时的摘要与 hooks/source-drift.sh 必须枚举同一份，
 * 否则 SessionStart 会把没装进去的文件当成漂移；两边由 source-drift-hook.test.ts 交叉验证。
 */
export const DEV_PAYLOAD_PATHSPECS: readonly string[] = PAYLOAD_ENTRIES

const GIT_OID = /^[0-9a-f]{40}$/
const CONTROL = /[\u0000-\u001f\u007f]/u

export type GitRun = (repo: string, args: readonly string[]) => string

/** 在 repo 里跑 git，非零退出会抛（调用方决定怎么降级）。 */
export const realGitRun: GitRun = (repo, args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/** `git hash-object` 对同样字节打印的值：SHA-1("blob <长度>\0" + 字节)。 */
export function gitBlobId(bytes: Uint8Array): string {
  const hash = createHash('sha1')
  hash.update(`blob ${bytes.byteLength}\0`, 'utf8')
  hash.update(bytes)
  return hash.digest('hex')
}

export type SourceRepoVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

function readJson(repo: string, rel: string): unknown {
  try {
    return JSON.parse(readFileSync(join(repo, rel), 'utf8'))
  } catch {
    return null
  }
}

/** 四项判据：缺任何一项都不是 Tenon 源码仓库。 */
export function checkTenonSourceRepo(repo: string): SourceRepoVerdict {
  const pkg = readJson(repo, 'package.json')
  if (!isRecord(pkg) || pkg.name !== 'tenon') {
    return { ok: false, reason: '根 package.json 的 name 不是 tenon' }
  }
  const marketplace = readJson(repo, '.claude-plugin/marketplace.json')
  const first = isRecord(marketplace) && Array.isArray(marketplace.plugins) ? marketplace.plugins[0] : undefined
  if (!isRecord(marketplace) || marketplace.name !== 'tenon' || !isRecord(first) || first.source !== './') {
    return { ok: false, reason: '.claude-plugin/marketplace.json 不是 name=tenon 且 plugins[0].source="./"' }
  }
  if (!existsSync(join(repo, 'skills', 'sources.yaml'))) return { ok: false, reason: '缺少 skills/sources.yaml' }
  if (!existsSync(join(repo, 'runtime', 'tenon-bootstrap.mjs'))) {
    return { ok: false, reason: '缺少 runtime/tenon-bootstrap.mjs' }
  }
  return { ok: true }
}

export type SourceRepoResolution =
  | { readonly ok: true; readonly repo: string }
  | { readonly ok: false; readonly reason: string }

/** 把用户传入的路径解析成仓库根的 realpath，并确认它是 Tenon 源码仓库的 git 工作区根。 */
export function resolveSourceRepo(input: string, git: GitRun = realGitRun): SourceRepoResolution {
  if (input.trim() === '') return { ok: false, reason: '--from-source 需要一个 Tenon 源码仓库路径' }
  let repo: string
  try {
    repo = realpathSync(input)
  } catch {
    return { ok: false, reason: `源码仓库路径不存在或不可读：${input}` }
  }
  if (CONTROL.test(repo)) return { ok: false, reason: '源码仓库路径含控制字符，无法写入 install-channel 标记' }
  const verdict = checkTenonSourceRepo(repo)
  if (!verdict.ok) return { ok: false, reason: `${repo} 不是 Tenon 源码仓库：${verdict.reason}` }
  let top: string
  try {
    top = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return { ok: false, reason: `${repo} 不是 git 工作区（需要 git 记录 commit 与工作区摘要）` }
  }
  if (top !== repo) return { ok: false, reason: `请传仓库根目录 ${top}（收到的是它的子目录 ${repo}）` }
  return { ok: true, repo }
}

/**
 * 安装内容的工作区摘要。口径（hooks/source-drift.sh 逐字一致）：
 * `git ls-files -z --cached --others --exclude-standard -- <PAYLOAD_ENTRIES>` 去重、只留普通文件、按字节序排序，
 * 每行 `<blob40> <path>\n`（blob 取工作区原始字节），整体再取 git blob id。
 * 被忽略的上游技能因 --exclude-standard 自然排除；它们由 skillsIndexDigest 覆盖。
 */
export function computeWorktreeDigest(repo: string, git: GitRun = realGitRun): string {
  const listed = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...DEV_PAYLOAD_PATHSPECS])
  const files = [...new Set(listed.split('\0').filter((path) => path !== ''))]
    .filter((path) => isRegularFile(join(repo, path)))
    .sort(byteOrder)
  if (files.length === 0) throw new Error('仓库里没有任何安装内容文件（PAYLOAD_ENTRIES 全空）')
  for (const path of files) {
    if (path.includes('\n')) throw new Error(`路径含换行，无法稳定摘要：${JSON.stringify(path)}`)
  }
  const manifest = files.map((path) => `${gitBlobId(readFileSync(join(repo, path)))} ${path}\n`).join('')
  return gitBlobId(Buffer.from(manifest, 'utf8'))
}

/** 本机拉取索引（skills/skills.lock.json，被 git 忽略）的原始字节摘要；没有索引记为 absent。 */
export function computeSkillsIndexDigest(repo: string): string {
  const file = join(repo, 'skills', 'skills.lock.json')
  return isRegularFile(file) ? gitBlobId(readFileSync(file)) : 'absent'
}

export function computeDevSourceIdentity(repoInput: string, git: GitRun = realGitRun): RuntimeDevSource {
  const repoRealpath = realpathSync(repoInput)
  const verdict = checkTenonSourceRepo(repoRealpath)
  if (!verdict.ok) throw new Error(`${repoRealpath} 不是 Tenon 源码仓库：${verdict.reason}`)
  let commit: string
  try {
    commit = git(repoRealpath, ['rev-parse', 'HEAD']).trim()
  } catch {
    throw new Error(`${repoRealpath} 还没有任何提交；先提交一次再做开发安装`)
  }
  if (!GIT_OID.test(commit)) throw new Error(`${repoRealpath} 的 HEAD 不是合法的 commit：${commit}`)
  const status = git(repoRealpath, ['status', '--porcelain', '--', ...DEV_PAYLOAD_PATHSPECS])
  return {
    kind: 'dev',
    repoRealpath,
    commit,
    dirty: status.trim() !== '',
    worktreeDigest: computeWorktreeDigest(repoRealpath, git),
    skillsIndexDigest: computeSkillsIndexDigest(repoRealpath),
  }
}

export function devSourceEquals(left: RuntimeDevSource, right: RuntimeDevSource): boolean {
  return left.repoRealpath === right.repoRealpath
    && left.commit === right.commit
    && left.dirty === right.dirty
    && left.worktreeDigest === right.worktreeDigest
    && left.skillsIndexDigest === right.skillsIndexDigest
}

/** 漂移原因；commit 与 dirty 只是展示，不在其中。空数组表示已装内容与工作区一致。 */
export function compareDevSource(installed: RuntimeDevSource, live: RuntimeDevSource): readonly string[] {
  const reasons: string[] = []
  if (installed.repoRealpath !== live.repoRealpath) {
    reasons.push(`仓库不同（已装 ${installed.repoRealpath}，当前 ${live.repoRealpath}）`)
  }
  if (installed.worktreeDigest !== live.worktreeDigest) {
    reasons.push(`安装内容已变（已装 ${installed.worktreeDigest.slice(0, 7)}，工作区 ${live.worktreeDigest.slice(0, 7)}）`)
  }
  if (installed.skillsIndexDigest !== live.skillsIndexDigest) {
    reasons.push(`技能索引已变（已装 ${installed.skillsIndexDigest.slice(0, 7)}，当前 ${live.skillsIndexDigest.slice(0, 7)}）`)
  }
  return reasons
}

export function devVersionLabel(version: string, commit: string): string {
  return `${version}+dev.${commit.slice(0, 7)}`
}
```

`packages/cli/src/runtime/dev-install-marker.ts`：

```ts
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeDevSource } from './types.js'

const MARKER_FILE = 'install-channel'
const OID = /^[0-9a-f]{40}$/
const RELEASE_ID = /^sha256-[0-9a-f]{64}$/
const CONTROL = /[\u0000-\u001f\u007f]/u
const KEYS = [
  'channel', 'host', 'release_id', 'installed_at', 'repo', 'commit', 'dirty', 'worktree_digest', 'skills_index_digest',
] as const

export interface DevInstallMarker {
  readonly host: 'codex' | 'claude'
  readonly releaseId: string
  readonly installedAt: string
  readonly devSource: RuntimeDevSource
}

export function installChannelPath(configRoot: string): string {
  return join(configRoot, MARKER_FILE)
}

/**
 * 一行一个 key=value，hooks/auto-update.sh 与 hooks/source-drift.sh 用 `IFS='=' read -r key value` 读它。
 * 值里不许有控制字符（含换行），否则 bash 端会读错。
 */
export function encodeInstallChannel(marker: DevInstallMarker): string {
  const source = marker.devSource
  const values: Record<(typeof KEYS)[number], string> = {
    channel: 'dev',
    host: marker.host,
    release_id: marker.releaseId,
    installed_at: marker.installedAt,
    repo: source.repoRealpath,
    commit: source.commit,
    dirty: String(source.dirty),
    worktree_digest: source.worktreeDigest,
    skills_index_digest: source.skillsIndexDigest,
  }
  for (const key of KEYS) {
    if (CONTROL.test(values[key])) throw new Error(`install-channel 字段 ${key} 含控制字符`)
  }
  return `${KEYS.map((key) => `${key}=${values[key]}`).join('\n')}\n`
}

export function parseInstallChannel(text: string): DevInstallMarker | null {
  const found = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const index = line.indexOf('=')
    if (index <= 0) return null
    const key = line.slice(0, index)
    if (found.has(key) || !(KEYS as readonly string[]).includes(key)) return null
    found.set(key, line.slice(index + 1))
  }
  if (found.size !== KEYS.length) return null
  const get = (key: (typeof KEYS)[number]): string => found.get(key) ?? ''
  const host = get('host')
  const dirty = get('dirty')
  const skills = get('skills_index_digest')
  if (get('channel') !== 'dev'
    || (host !== 'codex' && host !== 'claude')
    || !RELEASE_ID.test(get('release_id'))
    || get('installed_at') === ''
    || get('repo') === ''
    || !OID.test(get('commit'))
    || (dirty !== 'true' && dirty !== 'false')
    || !OID.test(get('worktree_digest'))
    || (skills !== 'absent' && !OID.test(skills))) return null
  return {
    host,
    releaseId: get('release_id'),
    installedAt: get('installed_at'),
    devSource: {
      kind: 'dev',
      repoRealpath: get('repo'),
      commit: get('commit'),
      dirty: dirty === 'true',
      worktreeDigest: get('worktree_digest'),
      skillsIndexDigest: skills,
    },
  }
}

/** 原子写：同目录临时文件再 rename，hook 永远读不到半截内容。 */
export function writeInstallChannelMarker(configRoot: string, marker: DevInstallMarker): void {
  mkdirSync(configRoot, { recursive: true })
  const target = installChannelPath(configRoot)
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, encodeInstallChannel(marker), { encoding: 'utf8', mode: 0o644 })
  renameSync(temp, target)
}

/** 正式安装 / 切回正式版成功后清标记；没有标记也不是错误。 */
export function removeInstallChannelMarker(configRoot: string): void {
  rmSync(installChannelPath(configRoot), { force: true })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/runtime/dev-source-identity.test.ts packages/cli/src/runtime/dev-install-marker.test.ts && npm run build:packages`
Expected: 全部 PASS；`tsc -b` 无类型错误（`RuntimeDevSource` 此时只被 types.ts 与新文件使用）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/types.ts packages/cli/src/runtime/dev-source-identity.ts packages/cli/src/runtime/dev-source-identity.test.ts packages/cli/src/runtime/dev-source-test-support.ts packages/cli/src/runtime/dev-install-marker.ts packages/cli/src/runtime/dev-install-marker.test.ts
git commit -m "feat(cli): freeze a development source identity and the install-channel marker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: release manifest 的 `devSource`、release id 与 store / installer 贯通

**Files:**
- Modify: `packages/cli/src/runtime/release-store-codecs.ts:1-12,59-143`（导入、`devSourceFromUnknown`、`runtimeReleaseIdV2`、`parseManifest`）
- Modify: `packages/cli/src/runtime/release-store.ts:13-22,107-122,230-279`
- Modify: `packages/cli/src/runtime/installer-contract.ts:17-32`（`activate` 签名）
- Modify: `packages/cli/src/runtime/installer.ts:40-61,340-353`
- Create: `packages/cli/src/runtime/release-store-codecs.dev.test.ts`、`packages/cli/src/runtime/release-store.dev.integration.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `RuntimeDevSource`。
- Produces：
  ```ts
  runtimeReleaseIdV2(payloadDigest: string, source: RuntimeReleaseSource, stableTarget?: RuntimeStableReleaseTarget, devSource?: RuntimeDevSource): string
  RuntimeReleaseStore.stageAndActivate(candidateRoot: string, host: RuntimeReleaseSource['host'], expectedPluginVersion?: string, stableTarget?: RuntimeStableReleaseTarget, devSource?: RuntimeDevSource): Promise<RuntimeActivation>
  ManagedRuntimeTransaction.activate(candidateRoot: string, host: RuntimeReleaseSource['host'], expectedPluginVersion?: string, stableTarget?: RuntimeStableReleaseTarget, devSource?: RuntimeDevSource): Promise<RuntimeActivation>
  ```

- [ ] **Step 1: 写失败测试**

`packages/cli/src/runtime/release-store-codecs.dev.test.ts`：

```ts
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { parseManifest, runtimeReleaseIdV2, stableJson } from './release-store-codecs.js'
import type { RuntimeDevSource, RuntimeReleaseSource } from './types.js'

const DIGEST = 'a'.repeat(64)
const SOURCE: RuntimeReleaseSource = { host: 'claude', pluginVersion: '0.3.2' }
const STABLE = { version: '0.3.2', tag: 'v0.3.2', commit: 'e'.repeat(40) }
const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'b'.repeat(40), dirty: true,
  worktreeDigest: 'c'.repeat(40), skillsIndexDigest: 'd'.repeat(40),
}

/** 改动前 runtimeReleaseIdV2 的逐字复刻：没有 devSource 的 release id 不得有任何变化。 */
function legacyReleaseIdV2(
  payloadDigest: string,
  source: RuntimeReleaseSource,
  stable?: { version: string; tag: string; commit: string },
): string {
  const hash = createHash('sha256')
  for (const field of [
    'tenon-runtime-release-v2', payloadDigest, source.host, source.pluginVersion,
    stable === undefined ? 'no-stable-target' : 'stable-target',
    stable?.version ?? '', stable?.tag ?? '', stable?.commit ?? '',
  ]) {
    const bytes = Buffer.from(field, 'utf8')
    hash.update(`${bytes.byteLength}:`, 'utf8')
    hash.update(bytes)
  }
  return `sha256-${hash.digest('hex')}`
}

function manifestJson(extra: Record<string, unknown>, devSource?: RuntimeDevSource, stable?: typeof STABLE): string {
  return stableJson({
    version: 2,
    releaseId: runtimeReleaseIdV2(DIGEST, SOURCE, stable, devSource),
    payloadDigest: DIGEST,
    createdAt: '2026-10-07T00:00:00Z',
    source: SOURCE,
    ...extra,
  })
}

describe('runtimeReleaseIdV2 with a development source', () => {
  test('is byte-identical to the previous algorithm when there is no development source', () => {
    expect(runtimeReleaseIdV2(DIGEST, SOURCE)).toBe(legacyReleaseIdV2(DIGEST, SOURCE))
    expect(runtimeReleaseIdV2(DIGEST, SOURCE, STABLE)).toBe(legacyReleaseIdV2(DIGEST, SOURCE, STABLE))
  })

  test('every development field is part of the identity', () => {
    const base = runtimeReleaseIdV2(DIGEST, SOURCE, undefined, DEV)
    expect(base).not.toBe(runtimeReleaseIdV2(DIGEST, SOURCE))
    for (const changed of [
      { ...DEV, repoRealpath: '/other' }, { ...DEV, commit: 'f'.repeat(40) }, { ...DEV, dirty: false },
      { ...DEV, worktreeDigest: '1'.repeat(40) }, { ...DEV, skillsIndexDigest: 'absent' },
    ]) {
      expect(runtimeReleaseIdV2(DIGEST, SOURCE, undefined, changed)).not.toBe(base)
    }
  })
})

describe('parseManifest with a development source', () => {
  test('round-trips a development manifest', () => {
    const raw = manifestJson({ devSource: DEV }, DEV)
    expect(parseManifest(raw)).toMatchObject({ version: 2, source: SOURCE, devSource: DEV })
  })

  test('a manifest without devSource still parses and carries none', () => {
    expect(parseManifest(manifestJson({}))).not.toHaveProperty('devSource')
  })

  test.each([
    ['stableTarget together with devSource', () => manifestJson({ devSource: DEV, stableTarget: STABLE }, DEV, STABLE)],
    ['an extra key inside devSource', () => manifestJson({ devSource: { ...DEV, extra: 1 } }, DEV)],
    ['a malformed digest', () => manifestJson({ devSource: { ...DEV, worktreeDigest: 'xyz' } }, { ...DEV, worktreeDigest: 'xyz' })],
    ['a relative repo path', () => manifestJson({ devSource: { ...DEV, repoRealpath: 'tenon' } }, { ...DEV, repoRealpath: 'tenon' })],
    ['a release id that does not cover devSource', () => manifestJson({ devSource: DEV, releaseId: runtimeReleaseIdV2(DIGEST, SOURCE) }, DEV)],
    ['an adapter host', () => {
      const adapter = { host: 'adapter' as const, pluginVersion: '0.3.2' }
      return stableJson({
        version: 2, releaseId: runtimeReleaseIdV2(DIGEST, adapter, undefined, DEV), payloadDigest: DIGEST,
        createdAt: '2026-10-07T00:00:00Z', source: adapter, devSource: DEV,
      })
    }],
  ])('rejects %s', (_label, build) => {
    expect(parseManifest(build())).toBeNull()
  })
})
```

`packages/cli/src/runtime/release-store.dev.integration.test.ts`（照 `release-store.integration.test.ts` 的 `candidateCopy` 做法，候选就是本 checkout 的安装内容）：

```ts
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TENON_RELEASE_VERSION } from '../commands/plugin-host.js'
import { resolveRuntimePaths } from './paths.js'
import { parseManifest, readReleaseManifest } from './release-store-codecs.js'
import { RuntimeReleaseStore } from './release-store.js'
import type { RuntimeDevSource } from './types.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'a'.repeat(40), dirty: true,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}

async function candidate(): Promise<{ root: string; candidate: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-dev-store-'))
  roots.push(root)
  const target = join(root, 'candidate')
  for (const entry of [
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json', 'adapters', 'hooks', 'packages/cli/dist/tenon.mjs',
    'packages/dashboard-app/dist', 'packages/server/dist/dashboard.mjs', 'runtime/tenon-bootstrap.mjs',
    'skills', 'templates', 'tools/verify-skills.sh',
  ]) await cp(join(repoRoot, entry), join(target, entry), { recursive: true, preserveTimestamps: false })
  return { root, candidate: target }
}

function storeFor(root: string): RuntimeReleaseStore {
  return new RuntimeReleaseStore({
    paths: resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: root, platform: 'linux' }),
    now: () => '2026-10-07T00:00:00Z',
    retainedReleases: 3,
  })
}

describe('RuntimeReleaseStore development releases', () => {
  it('publishes a development release whose manifest carries devSource and a distinct release id', async () => {
    const { root, candidate: payload } = await candidate()
    const store = storeFor(root)
    const stable = await store.stageAndActivate(payload, 'claude', TENON_RELEASE_VERSION)
    const dev = await store.stageAndActivate(payload, 'claude', TENON_RELEASE_VERSION, undefined, DEV)
    expect(dev.release.releaseId).not.toBe(stable.release.releaseId)
    expect(dev.release).toMatchObject({ version: 2, devSource: DEV })
    expect(dev.release).not.toHaveProperty('stableTarget')
    expect(await readReleaseManifest(dev.releaseRoot)).toMatchObject({ devSource: DEV })
    expect(dev.selection.previousRelease).toBe(stable.release.releaseId)
    const inspected = await store.inspect()
    expect(inspected.activeValid).toBe(true)
    expect(inspected.active).toMatchObject({ devSource: DEV })
  })

  it('refuses a development source together with a stable target', async () => {
    const { root, candidate: payload } = await candidate()
    await expect(storeFor(root).stageAndActivate(
      payload, 'claude', TENON_RELEASE_VERSION,
      { version: TENON_RELEASE_VERSION, tag: `v${TENON_RELEASE_VERSION}`, commit: 'd'.repeat(40) },
      DEV,
    )).rejects.toThrow('互斥')
  })

  it('refuses a development source for an adapter host', async () => {
    const { root, candidate: payload } = await candidate()
    await expect(storeFor(root).stageAndActivate(payload, 'adapter', TENON_RELEASE_VERSION, undefined, DEV))
      .rejects.toThrow('原生宿主')
  })

  it('stored manifests of earlier development releases stay parseable', async () => {
    const { root, candidate: payload } = await candidate()
    const dev = await storeFor(root).stageAndActivate(payload, 'codex', TENON_RELEASE_VERSION, undefined, DEV)
    expect(parseManifest(JSON.stringify(dev.release))).toMatchObject({ devSource: DEV })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/runtime/release-store-codecs.dev.test.ts packages/cli/src/runtime/release-store.dev.integration.test.ts`
Expected: FAIL（`runtimeReleaseIdV2` 只收 3 个参数、`parseManifest` 拒绝 `devSource` 键；`stageAndActivate` 不收第 5 个参数导致类型 / 行为不符）。

- [ ] **Step 3: 最小实现**

`release-store-codecs.ts`：把顶部 `import { join } from 'node:path'` 改为 `import { isAbsolute, join, normalize } from 'node:path'`，类型导入加 `RuntimeDevSource`；在 `stableTargetFromUnknown`（行 69-80）之后加

```ts
const DEV_OID = /^[a-f0-9]{40}$/

function devSourceFromUnknown(value: unknown): RuntimeDevSource | null {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'commit,dirty,kind,repoRealpath,skillsIndexDigest,worktreeDigest') {
    return null
  }
  const { kind, repoRealpath, commit, dirty, worktreeDigest, skillsIndexDigest } = value
  if (kind !== 'dev'
    || typeof repoRealpath !== 'string'
    || !isAbsolute(repoRealpath)
    || normalize(repoRealpath) !== repoRealpath
    || /[\u0000-\u001f\u007f]/u.test(repoRealpath)
    || typeof commit !== 'string' || !DEV_OID.test(commit)
    || typeof dirty !== 'boolean'
    || typeof worktreeDigest !== 'string' || !DEV_OID.test(worktreeDigest)
    || typeof skillsIndexDigest !== 'string'
    || (skillsIndexDigest !== 'absent' && !DEV_OID.test(skillsIndexDigest))) return null
  return { kind: 'dev', repoRealpath, commit, dirty, worktreeDigest, skillsIndexDigest }
}
```

把 `runtimeReleaseIdV2`（行 88-105）改成

```ts
export function runtimeReleaseIdV2(
  payloadDigest: string,
  source: RuntimeReleaseSource,
  stableTarget?: RuntimeStableReleaseTarget,
  devSource?: RuntimeDevSource,
): string {
  const hash = createHash('sha256')
  for (const field of [
    'tenon-runtime-release-v2',
    payloadDigest,
    source.host,
    source.pluginVersion,
    stableTarget === undefined ? 'no-stable-target' : 'stable-target',
    stableTarget?.version ?? '',
    stableTarget?.tag ?? '',
    stableTarget?.commit ?? '',
  ]) identityFrame(hash, field)
  // 只有开发安装才追加帧：没有 devSource 的 release id 必须与历史算法逐字节相同。
  if (devSource !== undefined) {
    for (const field of [
      'dev-source',
      devSource.repoRealpath,
      devSource.commit,
      String(devSource.dirty),
      devSource.worktreeDigest,
      devSource.skillsIndexDigest,
    ]) identityFrame(hash, field)
  }
  return `sha256-${hash.digest('hex')}`
}
```

把 `parseManifest` 里 `if (value.version !== 2) return null` 之后到 `return {…}` 的 v2 段（行 124-142）改成

```ts
  if (value.version !== 2) return null
  const expectedKeys = ['createdAt', 'payloadDigest', 'releaseId', 'source', 'version']
  if (value.stableTarget !== undefined) expectedKeys.push('stableTarget')
  if (value.devSource !== undefined) expectedKeys.push('devSource')
  if (Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',')) return null
  const stableTarget = value.stableTarget === undefined
    ? undefined
    : stableTargetFromUnknown(value.stableTarget)
  const devSource = value.devSource === undefined
    ? undefined
    : devSourceFromUnknown(value.devSource)
  if (stableTarget === null || devSource === null) return null
  // 开发安装与正式标签互斥；开发安装只属于原生宿主。
  if (stableTarget !== undefined && devSource !== undefined) return null
  if (devSource !== undefined && source.host !== 'codex' && source.host !== 'claude') return null
  if ((stableTarget !== undefined && stableTarget.version !== source.pluginVersion)
    || value.releaseId !== runtimeReleaseIdV2(payloadDigest, source, stableTarget, devSource)) return null
  return {
    version: 2,
    releaseId: value.releaseId,
    payloadDigest,
    createdAt,
    source,
    ...(stableTarget === undefined ? {} : { stableTarget }),
    ...(devSource === undefined ? {} : { devSource }),
  }
```

`release-store.ts`：类型导入（行 13-22）加 `RuntimeDevSource`；`stageAndActivate`（行 107-122）与 `stageAndActivateUnderLock`（行 230-235）各加第 5 个参数 `devSource?: RuntimeDevSource` 并向下传；在 `stableTarget` 版本一致性检查（行 264-269）之后、`releaseId = …`（行 270）之前加

```ts
      if (devSource !== undefined && stableTarget !== undefined) {
        throw new RuntimeFailure('candidate-invalid', '开发源码身份与稳定标签目标互斥')
      }
      if (devSource !== undefined && host !== 'codex' && host !== 'claude') {
        throw new RuntimeFailure('candidate-invalid', '开发源码身份只允许原生宿主（codex / claude）')
      }
```

并把行 270-278 改成

```ts
      releaseId = runtimeReleaseIdV2(payloadDigest, source, stableTarget, devSource)
      const manifest: RuntimeReleaseManifest = {
        version: 2,
        releaseId,
        payloadDigest,
        createdAt: this.now(),
        source,
        ...(stableTarget === undefined ? {} : { stableTarget }),
        ...(devSource === undefined ? {} : { devSource }),
      }
```

`installer-contract.ts`：`ManagedRuntimeTransaction.activate` 末尾加 `devSource?: RuntimeDevSource,`，类型导入加 `RuntimeDevSource`。

`installer.ts`：`activateWithinTransaction`（行 40-61）加最后一个参数 `devSource?: RuntimeDevSource` 并调用 `store.stageAndActivate(candidateRoot, host, expectedPluginVersion, stableTarget, devSource)`；行 340-353 的 `activate: (candidateRoot, host, expectedPluginVersion, stableTarget, devSource) => activateWithinTransaction(…, stableTarget, devSource)`；类型导入加 `RuntimeDevSource`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/runtime/release-store-codecs.dev.test.ts packages/cli/src/runtime/release-store.dev.integration.test.ts packages/cli/src/runtime/release-store.integration.test.ts packages/cli/src/runtime/managed-release-journal.test.ts`
Expected: 全部 PASS（后两个是稳定路径与 journal codec 的回归保护；journal 的 activation 解码走 `parseManifest`，开发 release 因此自动可持久化）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/release-store-codecs.ts packages/cli/src/runtime/release-store.ts packages/cli/src/runtime/installer-contract.ts packages/cli/src/runtime/installer.ts packages/cli/src/runtime/release-store-codecs.dev.test.ts packages/cli/src/runtime/release-store.dev.integration.test.ts
git commit -m "feat(cli): carry a development source in the release manifest and its release id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 协调器贯通 `devSource`、激活身份断言、pending 事务守卫

**Files:**
- Modify: `packages/cli/src/commands/release-coordinator-contract.ts:1-9,35-60`（`ManagedReleaseRequest.devSource`）
- Modify: `packages/cli/src/commands/release-coordinator.ts:201-207`（`transaction.activate` 多传 `request.devSource`）
- Modify: `packages/cli/src/commands/release-activation-validation.ts:29-70`（`assertManagedActivationIdentity` 加 dev 断言）
- Modify: `packages/cli/src/commands/managed-release-journal-coordinator.ts:12-24,69-92`（`JournalRequest.devSource` + 守卫）
- Modify（测试）: `packages/cli/src/commands/release-coordinator.test.ts`（导入、`serializedInstaller` 的 `activate` 转发第 5 个参数、末尾追加 `describe`）

**Interfaces:**
- Consumes: Task 3 的 `RuntimeDevSource`、`devSourceEquals`；Task 4 的 `activate(…, devSource?)`。
- Produces: `ManagedReleaseRequest.devSource?: RuntimeDevSource`（与 `requiresStableTarget` 互斥；`expectedPluginVersion` 仍用，取仓库 plugin.json 的版本）。

- [ ] **Step 1: 写失败测试**

在 `release-coordinator.test.ts` 顶部类型导入处加 `RuntimeDevSource`（`import type { NativeRuntimeHost, RuntimeActivation, RuntimeDevSource, RuntimeStableReleaseTarget } from '../runtime/types.js'`）。把 `serializedInstaller` 的 `activate` 参数类型（行 100-106）改成

```ts
  activate: (
    candidateRoot: string,
    host: NativeRuntimeHost | 'adapter',
    expectedPluginVersion?: string,
    stableTarget?: RuntimeStableReleaseTarget,
    devSource?: RuntimeDevSource,
  ) => RuntimeActivation = activationFor,
```

并把 fake transaction 的 `activate`（行 160-168）改成

```ts
          activate: async (candidateRoot, host, expectedPluginVersion, stableTarget, devSource) => {
            events.push(`activate:${candidateRoot}`)
            currentActivation = activate(
              candidateRoot,
              host,
              expectedPluginVersion,
              stableTarget,
              devSource,
            )
            return currentActivation
          },
```

在文件末尾追加：

```ts
const DEV_SOURCE: RuntimeDevSource = {
  kind: 'dev',
  repoRealpath: '/work/tenon',
  commit: 'a'.repeat(40),
  dirty: true,
  worktreeDigest: 'b'.repeat(40),
  skillsIndexDigest: 'c'.repeat(40),
}

function devActivation(candidateRoot: string, devSource: RuntimeDevSource | undefined): RuntimeActivation {
  const base = activationFor(candidateRoot, 'claude', '0.3.2')
  return {
    ...base,
    release: {
      version: 2,
      releaseId: base.release.releaseId,
      payloadDigest: base.release.payloadDigest,
      createdAt: base.release.createdAt,
      source: base.release.source,
      ...(devSource === undefined ? {} : { devSource }),
    },
  }
}

function devRequest(candidateRoot: string) {
  return {
    operation: 'setup' as const,
    source: 'claude' as const,
    runtime: { homeDir: '/home/test', env: {} },
    openBrowser: false,
    expectedPluginVersion: '0.3.2',
    devSource: DEV_SOURCE,
    prepareCandidate: () => ({ candidateRoot }),
  }
}

const devStarter: ReleasedDashboardStarter = {
  inspect: async () => null,
  adopt: async () => null,
  start: async (_deps, _payloadRoot, opts) =>
    readyDashboard(`sha256-${'a'.repeat(64)}`, opts.transactionId, opts.port),
}

describe('managed release coordinator: development source install', () => {
  test('forwards the frozen development source to activation and accepts the matching release', async () => {
    let received: RuntimeDevSource | undefined
    const outcome = await publishManagedRelease(
      makeDeps(),
      devRequest('/candidate/one'),
      serializedInstaller([], (root, _host, _version, _stable, dev) => {
        received = dev
        return devActivation(root, dev)
      }),
      devStarter,
    )
    expect(outcome).toMatchObject({ ok: true, state: 'ready' })
    expect(received).toEqual(DEV_SOURCE)
  })

  test('rejects an activation whose release does not carry the frozen development source', async () => {
    const outcome = await publishManagedRelease(
      makeDeps(),
      devRequest('/candidate/one'),
      serializedInstaller([], (root) => devActivation(root, undefined)),
      devStarter,
    )
    expect(outcome).toMatchObject({
      ok: false,
      state: 'indeterminate',
      detail: expect.stringContaining('devSource'),
    })
  })

  test('rejects an activation that carries a different development source', async () => {
    const outcome = await publishManagedRelease(
      makeDeps(),
      devRequest('/candidate/one'),
      serializedInstaller([], (root) => devActivation(root, { ...DEV_SOURCE, worktreeDigest: 'f'.repeat(40) })),
      devStarter,
    )
    expect(outcome).toMatchObject({ ok: false, state: 'indeterminate', detail: expect.stringContaining('devSource') })
  })

  test('refuses to adopt a pending stable transaction', async () => {
    const outcome = await publishManagedRelease(
      makeDeps(),
      devRequest('/candidate/one'),
      serializedInstaller([], (root, _host, _version, _stable, dev) => devActivation(root, dev), {
        initialJournal: {
          version: 1,
          transactionId: 'pending-stable',
          operation: 'setup',
          source: 'claude',
          phase: 'preparing-host',
          startedAt: '2026-10-07T00:00:00Z',
          updatedAt: '2026-10-07T00:00:00Z',
          dashboardPort: 18_765,
          stableTarget: FROZEN_STABLE_TARGET,
        },
      }),
      devStarter,
    )
    expect(outcome).toMatchObject({
      ok: false,
      state: 'indeterminate',
      detail: expect.stringContaining('未完成的正式'),
    })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/release-coordinator.test.ts -t "development source install"`
Expected: FAIL（`devSource` 不在 `ManagedReleaseRequest` 里：类型错误 / `received` 为 `undefined`；后三个用例没有对应的断言与守卫）。

- [ ] **Step 3: 最小实现**

`release-coordinator-contract.ts`：从 `'../runtime/types.js'` 的导入里加 `RuntimeDevSource`，在 `requiresStableTarget` 之后加

```ts
  /**
   * tenon setup --from-source 在事务开始前冻结的源码身份；与 requiresStableTarget 互斥。
   * activate 把它写进 release manifest，assertManagedActivationIdentity 在激活后逐字段比对。
   */
  readonly devSource?: RuntimeDevSource
```

`release-coordinator.ts` 的 `transaction.activate(...)` 调用（行 202-207）改成

```ts
        activation = await transaction.activate(
          candidate.candidateRoot,
          request.source,
          request.expectedPluginVersion ?? journal.stableTarget?.version,
          journal.stableTarget,
          request.devSource,
        )
```

`release-activation-validation.ts`：顶部加 `import { devSourceEquals } from '../runtime/dev-source-identity.js'`，在 `assertManagedActivationIdentity` 里 `const expectedVersion = …`（行 60）之前加

```ts
  const releaseDev = activation.release.version === 2 ? activation.release.devSource : undefined
  if (request.devSource !== undefined) {
    if (releaseDev === undefined || !devSourceEquals(releaseDev, request.devSource)) {
      throw new ManagedRuntimeIndeterminateError(
        `activation ${activation.release.releaseId} 的 devSource 与本次冻结的源码身份不一致；`
        + '若工作区在上一次未完成的开发安装后改过，先还原到当时的状态再重试，'
        + '或运行 tenon runtime repair --rollback 放弃那次事务',
      )
    }
  } else if (releaseDev !== undefined) {
    throw new ManagedRuntimeIndeterminateError(
      `activation ${activation.release.releaseId} 带有 devSource，但本事务不是开发安装`,
    )
  }
```

`managed-release-journal-coordinator.ts`：`JournalRequest` 加 `readonly devSource?: object`；在 `pending` 非空分支的 `try {` 之后第一行加

```ts
    if (request.devSource !== undefined && pending.stableTarget !== undefined) {
      throw new ManagedRuntimeIndeterminateError(
        `存在未完成的正式 ${pending.operation} 事务 ${pending.transactionId}`
        + `（已冻结稳定目标 ${pending.stableTarget.tag}）；先运行 `
        + `tenon ${pending.operation === 'update' ? 'update' : 'setup'} --${request.source} 完成或恢复它，再做开发安装`,
      )
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/release-coordinator.test.ts`
Expected: 全部 PASS（含原有用例，说明稳定路径未变）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/release-coordinator-contract.ts packages/cli/src/commands/release-coordinator.ts packages/cli/src/commands/release-activation-validation.ts packages/cli/src/commands/managed-release-journal-coordinator.ts packages/cli/src/commands/release-coordinator.test.ts
git commit -m "feat(cli): thread the development source through the managed release coordinator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 开发宿主计划、观察与 desired-state（`dev-host.ts`）

**Files:**
- Create: `packages/cli/src/commands/dev-host.ts`、`packages/cli/src/commands/dev-host.test.ts`

**Interfaces:**
- Consumes: `parseHostPluginInventory`、`TENON_MARKETPLACE_NAME`、`TENON_PLUGIN_NAME`、`HostCommandPlanItem`、`NativePipelineHost`（`plugin-host.ts`）；`NativeHostCommandEnvironment['managedHostReconciliation']`（`native-host-command-binding.ts:53-65`）；`ManagedRuntimeIndeterminateError`（`runtime/installer.ts`）。
- Produces：
  ```ts
  export function devHostPlan(host: NativePipelineHost, repoRealpath: string): readonly HostCommandPlanItem[]   // 与 NATIVE_HOST_UPDATE_STEP_IDS 同位置、同长度 5
  export interface DevHostObservation {
    readonly version: 1; readonly host: NativePipelineHost
    readonly marketplace: { readonly sourceType: string; readonly path: string } | null
    readonly plugin: { readonly enabled: boolean; readonly version: string | null; readonly root: string | null } | null
  }
  export function observeDevNativeHost(env: Pick<NativeHostCommandEnvironment, 'runCommand'>, host: NativePipelineHost): string   // JSON.stringify(DevHostObservation)
  export function decodeDevObservation(text: string): DevHostObservation
  export function devMarketplaceIsRepo(observation: DevHostObservation, repoRealpath: string): boolean
  export function devHostMatches(observation: DevHostObservation, repoRealpath: string, pluginVersion: string): boolean
  export function devHostReconciliation(env: Pick<NativeHostCommandEnvironment, 'runCommand'>, repoRealpath: string, pluginVersion: string): NonNullable<NativeHostCommandEnvironment['managedHostReconciliation']>
  ```

- [ ] **Step 1: 写失败测试** `packages/cli/src/commands/dev-host.test.ts`

```ts
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  decodeDevObservation, devHostMatches, devHostPlan, devHostReconciliation, devMarketplaceIsRepo,
  observeDevNativeHost,
} from './dev-host.js'
import { NATIVE_HOST_UPDATE_STEP_IDS } from './native-host-convergence-sequence.js'
import { parseHostPluginInventory, type NativePipelineHost } from './plugin-host.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function realDir(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `tenon-dev-host-${label}-`)))
  roots.push(root)
  return root
}

const VERSION = '0.3.2'

/** 按 2026-10-07 在隔离 HOME 里抓到的真实输出形态模拟宿主（Task 1 复核后若有差异，改这里的形态）。 */
function simulator(host: NativePipelineHost) {
  const state: { marketplacePath: string | null; plugin: { version: string } | null } = {
    marketplacePath: null,
    plugin: null,
  }
  const calls: string[] = []
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const runCommand = (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (host === 'claude') {
      if (line === 'claude plugin marketplace list --json') {
        return ok(JSON.stringify(state.marketplacePath === null ? [] : [{
          name: 'tenon', source: 'directory', path: state.marketplacePath, installLocation: state.marketplacePath,
        }]))
      }
      if (line === 'claude plugin list --json') {
        return ok(JSON.stringify(state.plugin === null ? [] : [{
          id: 'tenon@tenon', version: state.plugin.version, scope: 'user', enabled: true,
          installPath: `/home/test/.claude/plugins/cache/tenon/tenon/${state.plugin.version}`,
          readFromFolder: state.marketplacePath, folderVersion: state.plugin.version,
        }]))
      }
      if (line === 'claude plugin uninstall tenon@tenon --scope user') { state.plugin = null; return ok() }
      if (line === 'claude plugin marketplace remove tenon') { state.marketplacePath = null; state.plugin = null; return ok() }
      if (line.startsWith('claude plugin marketplace add ')) { state.marketplacePath = realpathSync(args[3] ?? ''); return ok() }
      if (line === 'claude plugin install tenon@tenon') { state.plugin = { version: VERSION }; return ok() }
    } else {
      if (line === 'codex plugin marketplace list --json') {
        return ok(JSON.stringify({
          marketplaces: state.marketplacePath === null ? [] : [{
            name: 'tenon', root: state.marketplacePath,
            marketplaceSource: { sourceType: 'local', source: state.marketplacePath },
          }],
        }))
      }
      if (line === 'codex plugin list --json') {
        return ok(JSON.stringify({
          installed: state.plugin === null ? [] : [{
            pluginId: 'tenon@tenon', name: 'tenon', marketplaceName: 'tenon', version: state.plugin.version,
            installed: true, enabled: true, source: { source: 'local', path: state.marketplacePath },
          }],
          available: [],
        }))
      }
      if (line === 'codex plugin remove tenon@tenon --json') { state.plugin = null; return ok('{}') }
      if (line === 'codex plugin marketplace remove tenon --json') { state.marketplacePath = null; state.plugin = null; return ok('{}') }
      if (line.startsWith('codex plugin marketplace add ')) { state.marketplacePath = realpathSync(args[3] ?? ''); return ok('{}') }
      if (line === 'codex plugin add tenon@tenon --json') { state.plugin = { version: VERSION }; return ok('{}') }
    }
    return { code: 127, stdout: '', stderr: `unexpected command: ${line}` }
  }
  return { state, calls, runCommand }
}

describe('devHostPlan', () => {
  test('claude: uninstall, marketplace remove, add the directory, install, list', () => {
    expect(devHostPlan('claude', '/work/tenon')).toEqual([
      { cmd: 'claude', args: ['plugin', 'uninstall', 'tenon@tenon', '--scope', 'user'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', 'tenon'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'add', '/work/tenon'] },
      { cmd: 'claude', args: ['plugin', 'install', 'tenon@tenon'] },
      { cmd: 'claude', args: ['plugin', 'list', '--json'] },
    ])
  })

  test('codex: the same five positions with --json', () => {
    const plan = devHostPlan('codex', '/work/tenon')
    expect(plan).toHaveLength(NATIVE_HOST_UPDATE_STEP_IDS.length)
    expect(plan[2]).toEqual({ cmd: 'codex', args: ['plugin', 'marketplace', 'add', '/work/tenon', '--json'] })
    expect(plan[4]).toEqual({ cmd: 'codex', args: ['plugin', 'list', '--json'] })
  })
})

describe('observeDevNativeHost', () => {
  test.each(['claude', 'codex'] as const)('%s: reports the directory marketplace and the enabled plugin', (host) => {
    const repo = realDir(host)
    const sim = simulator(host)
    sim.state.marketplacePath = repo
    sim.state.plugin = { version: VERSION }
    const observation = decodeDevObservation(observeDevNativeHost({ runCommand: sim.runCommand }, host))
    expect(observation.marketplace).toEqual({ sourceType: host === 'claude' ? 'directory' : 'local', path: repo })
    expect(observation.plugin).toMatchObject({ enabled: true, version: VERSION })
    expect(devHostMatches(observation, repo, VERSION)).toBe(true)
    expect(devHostMatches(observation, repo, '9.9.9')).toBe(false)
  })

  test('the real plugin list output still parses with the existing inventory parser', () => {
    const repo = realDir('inventory')
    const sim = simulator('claude')
    sim.state.marketplacePath = repo
    sim.state.plugin = { version: VERSION }
    const parsed = parseHostPluginInventory('claude', sim.runCommand('claude', ['plugin', 'list', '--json']).stdout)
    expect(parsed).toMatchObject({ tenonVersion: VERSION, tenonRegistered: true })
    expect(parsed?.tenonRoot).toBe(`/home/test/.claude/plugins/cache/tenon/tenon/${VERSION}`)
  })

  test('absent registrations are null; garbage output fails closed', () => {
    const sim = simulator('claude')
    const observation = decodeDevObservation(observeDevNativeHost({ runCommand: sim.runCommand }, 'claude'))
    expect(observation).toMatchObject({ marketplace: null, plugin: null })
    expect(() => observeDevNativeHost({ runCommand: () => ({ code: 0, stdout: 'not json', stderr: '' }) }, 'claude'))
      .toThrow('不是合法 JSON')
    expect(() => observeDevNativeHost({ runCommand: () => ({ code: 1, stdout: '', stderr: 'boom' }) }, 'claude'))
      .toThrow('读取失败')
  })
})

describe('devMarketplaceIsRepo', () => {
  test('compares realpaths, so a symlinked repo path still matches what the host reports', () => {
    const repo = realDir('real')
    const link = join(realDir('link'), 'repo-link')
    symlinkSync(repo, link)
    const observation = { version: 1 as const, host: 'codex' as const, marketplace: { sourceType: 'local', path: repo }, plugin: null }
    expect(devMarketplaceIsRepo(observation, link)).toBe(true)
    expect(devMarketplaceIsRepo(observation, join(repo, 'other'))).toBe(false)
  })

  test('a github marketplace is never the repository', () => {
    const observation = { version: 1 as const, host: 'claude' as const, marketplace: { sourceType: 'github', path: '/tmp/x' }, plugin: null }
    expect(devMarketplaceIsRepo(observation, '/tmp/x')).toBe(false)
  })
})

describe('devHostReconciliation', () => {
  test.each(['claude', 'codex'] as const)('%s: the five-step plan converges through the managed-step contract', (host) => {
    const repo = realDir(`walk-${host}`)
    const sim = simulator(host)
    // 先有一份正式版登记，开发安装要把它换掉。
    sim.state.marketplacePath = '/some/stable/checkout'
    sim.state.plugin = { version: '0.3.1' }
    const reconcile = devHostReconciliation({ runCommand: sim.runCommand }, repo, VERSION)
    const plan = devHostPlan(host, repo)
    for (const [index, id] of ['plugin-remove', 'marketplace-remove', 'marketplace-register', 'plugin-install'].entries()) {
      const item = plan[index]
      if (item === undefined) throw new Error('plan too short')
      const step = reconcile(host, id, item)
      const before = step.observe()
      if (!step.isDesired(before)) {
        const result = sim.runCommand(item.cmd, [...item.args])
        expect(result.code).toBe(0)
      }
      expect(step.isDesired(step.observe())).toBe(true)
    }
    const final = decodeDevObservation(observeDevNativeHost({ runCommand: sim.runCommand }, host))
    expect(devHostMatches(final, repo, VERSION)).toBe(true)
  })

  test('a step already at its postcondition is recognised before any mutation', () => {
    const repo = realDir('noop')
    const sim = simulator('claude')
    const reconcile = devHostReconciliation({ runCommand: sim.runCommand }, repo, VERSION)
    const step = reconcile('claude', 'plugin-remove', { cmd: 'claude', args: [] })
    expect(step.isDesired(step.observe())).toBe(true)
    expect(sim.calls.every((call) => call.endsWith('list --json'))).toBe(true)
  })

  test('completed removal checkpoints stay valid once a later step re-registers the repository', () => {
    const repo = realDir('compat')
    const sim = simulator('claude')
    sim.state.marketplacePath = repo
    sim.state.plugin = { version: VERSION }
    const reconcile = devHostReconciliation({ runCommand: sim.runCommand }, repo, VERSION)
    const afterInstall = observeDevNativeHost({ runCommand: sim.runCommand }, 'claude')
    expect(reconcile('claude', 'plugin-remove', { cmd: 'claude', args: [] }).isCompletedCompatible?.(afterInstall)).toBe(true)
    expect(reconcile('claude', 'marketplace-remove', { cmd: 'claude', args: [] }).isCompletedCompatible?.(afterInstall)).toBe(true)
    sim.state.marketplacePath = '/some/other/checkout'
    const drifted = observeDevNativeHost({ runCommand: sim.runCommand }, 'claude')
    expect(reconcile('claude', 'marketplace-remove', { cmd: 'claude', args: [] }).isCompletedCompatible?.(drifted)).toBe(false)
  })

  test('the desired state names the repository and version, so another repository cannot resume the WAL', () => {
    const sim = simulator('claude')
    const first = devHostReconciliation({ runCommand: sim.runCommand }, '/work/a', VERSION)('claude', 'marketplace-register', { cmd: 'claude', args: [] })
    const second = devHostReconciliation({ runCommand: sim.runCommand }, '/work/b', VERSION)('claude', 'marketplace-register', { cmd: 'claude', args: [] })
    expect(first.desired).not.toBe(second.desired)
  })

  test('an unknown step id fails closed', () => {
    const sim = simulator('claude')
    expect(() => devHostReconciliation({ runCommand: sim.runCommand }, '/work/a', VERSION)('claude', 'surprise', { cmd: 'claude', args: [] }))
      .toThrow('没有对应的 desired-state')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/dev-host.test.ts`
Expected: FAIL（`Cannot find module './dev-host.js'`）。

- [ ] **Step 3: 最小实现** `packages/cli/src/commands/dev-host.ts`

```ts
import { realpathSync } from 'node:fs'
import { ManagedRuntimeIndeterminateError } from '../runtime/installer.js'
import type { NativeHostCommandEnvironment } from './native-host-command-binding.js'
import {
  parseHostPluginInventory,
  TENON_MARKETPLACE_NAME,
  TENON_PLUGIN_NAME,
  type HostCommandPlanItem,
  type NativePipelineHost,
} from './plugin-host.js'

const PLUGIN_ID = `${TENON_PLUGIN_NAME}@${TENON_MARKETPLACE_NAME}`
/** Claude 回 `directory`，Codex 回 `local`。 */
const DIRECTORY_SOURCE_TYPES: ReadonlySet<string> = new Set(['directory', 'local'])

type CommandRunner = Pick<NativeHostCommandEnvironment, 'runCommand'>

/**
 * 与 nativeUpdatePlan 同位置同长度（plugin-remove / marketplace-remove / marketplace-register /
 * plugin-install / inventory-after），所以 nativeHostConvergenceSequence 与 WAL 的 step id 可以原样复用。
 * 区别只在于 register 的来源是仓库目录而不是 GitHub 标签。
 */
export function devHostPlan(host: NativePipelineHost, repoRealpath: string): readonly HostCommandPlanItem[] {
  if (host === 'codex') {
    return [
      { cmd: 'codex', args: ['plugin', 'remove', PLUGIN_ID, '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', TENON_MARKETPLACE_NAME, '--json'] },
      { cmd: 'codex', args: ['plugin', 'marketplace', 'add', repoRealpath, '--json'] },
      { cmd: 'codex', args: ['plugin', 'add', PLUGIN_ID, '--json'] },
      { cmd: 'codex', args: ['plugin', 'list', '--json'] },
    ]
  }
  return [
    { cmd: 'claude', args: ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'] },
    { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', TENON_MARKETPLACE_NAME] },
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', repoRealpath] },
    { cmd: 'claude', args: ['plugin', 'install', PLUGIN_ID] },
    { cmd: 'claude', args: ['plugin', 'list', '--json'] },
  ]
}

export interface DevHostObservation {
  readonly version: 1
  readonly host: NativePipelineHost
  readonly marketplace: { readonly sourceType: string; readonly path: string } | null
  readonly plugin: {
    readonly enabled: boolean
    readonly version: string | null
    readonly root: string | null
  } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function readJson(env: CommandRunner, cmd: string, args: string[], label: string): unknown {
  const result = env.runCommand(cmd, args)
  if (result.code !== 0) {
    throw new ManagedRuntimeIndeterminateError(`${label} 读取失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new ManagedRuntimeIndeterminateError(`${label} 不是合法 JSON`)
  }
}

function marketplaceOf(host: NativePipelineHost, value: unknown): DevHostObservation['marketplace'] {
  const entries = host === 'codex'
    ? (isRecord(value) && Array.isArray(value.marketplaces) ? value.marketplaces : null)
    : (Array.isArray(value) ? value : null)
  if (entries === null) throw new ManagedRuntimeIndeterminateError(`${host} marketplace inventory schema 非法`)
  const matches = entries.filter((entry) => isRecord(entry) && entry.name === TENON_MARKETPLACE_NAME)
  if (matches.length > 1) throw new ManagedRuntimeIndeterminateError(`${host} tenon marketplace identity 重复`)
  const item = matches[0]
  if (item === undefined) return null
  if (!isRecord(item)) throw new ManagedRuntimeIndeterminateError(`${host} marketplace inventory entry 非法`)
  if (host === 'codex') {
    const source = isRecord(item.marketplaceSource) ? item.marketplaceSource : null
    const sourceType = typeof source?.sourceType === 'string' ? source.sourceType : ''
    const path = typeof source?.source === 'string' ? source.source : typeof item.root === 'string' ? item.root : ''
    return { sourceType, path: realOrSame(path) }
  }
  const sourceType = typeof item.source === 'string' ? item.source : ''
  const path = typeof item.path === 'string'
    ? item.path
    : typeof item.installLocation === 'string' ? item.installLocation : ''
  return { sourceType, path: realOrSame(path) }
}

/**
 * 开发安装专用的宿主观察：不依赖 observeNativeHost 对 canonical GitHub 源的假设，
 * 也不去 git 里读 marketplace 的 HEAD/ref/clean（目录 marketplace 就是工作区本身，脏是常态）。
 */
export function observeDevNativeHost(env: CommandRunner, host: NativePipelineHost): string {
  const marketplace = marketplaceOf(
    host,
    readJson(env, host, ['plugin', 'marketplace', 'list', '--json'], `${host} marketplace inventory`),
  )
  const listing = env.runCommand(host, ['plugin', 'list', '--json'])
  if (listing.code !== 0) {
    throw new ManagedRuntimeIndeterminateError(`${host} plugin inventory 读取失败：${listing.stderr.trim() || `退出码 ${listing.code}`}`)
  }
  const inventory = parseHostPluginInventory(host, listing.stdout)
  if (inventory === null) throw new ManagedRuntimeIndeterminateError(`${host} plugin inventory 响应畸形`)
  const plugin = inventory.tenonRegistered
    ? { enabled: inventory.tenonRoot !== null, version: inventory.tenonVersion, root: inventory.tenonRoot }
    : null
  return JSON.stringify({ version: 1, host, marketplace, plugin } satisfies DevHostObservation)
}

export function decodeDevObservation(text: string): DevHostObservation {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ManagedRuntimeIndeterminateError('开发安装的宿主 observation 不是合法 JSON')
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new ManagedRuntimeIndeterminateError('开发安装的宿主 observation schema 非法')
  }
  return value as unknown as DevHostObservation
}

export function devMarketplaceIsRepo(observation: DevHostObservation, repoRealpath: string): boolean {
  return observation.marketplace !== null
    && DIRECTORY_SOURCE_TYPES.has(observation.marketplace.sourceType)
    && observation.marketplace.path === realOrSame(repoRealpath)
}

export function devHostMatches(
  observation: DevHostObservation,
  repoRealpath: string,
  pluginVersion: string,
): boolean {
  return devMarketplaceIsRepo(observation, repoRealpath)
    && observation.plugin?.enabled === true
    && observation.plugin.version === pluginVersion
}

/**
 * managed-host-command.ts 会在 env.managedHostReconciliation 存在时用它代替稳定标签的
 * desiredNativeHostPostcondition。desired 里带着仓库与版本，换仓库重试 WAL 会被 desiredMatches 拒绝。
 */
export function devHostReconciliation(
  env: CommandRunner,
  repoRealpath: string,
  pluginVersion: string,
): NonNullable<NativeHostCommandEnvironment['managedHostReconciliation']> {
  const repo = realOrSame(repoRealpath)
  return (host, stepId) => {
    const observe = (): string => observeDevNativeHost(env, host)
    const at = (observation: string): DevHostObservation => decodeDevObservation(observation)
    switch (stepId) {
      case 'plugin-remove':
        return {
          desired: JSON.stringify({ version: 1, kind: 'plugin-absent', host }),
          observe,
          isDesired: (observation) => at(observation).plugin === null,
          // 后续 step 合法地把插件装回来；只认「回到本仓库」这一种后继状态。
          isCompletedCompatible: (observation) => {
            const current = at(observation)
            return current.plugin === null || devHostMatches(current, repo, pluginVersion)
          },
        }
      case 'marketplace-remove':
        return {
          desired: JSON.stringify({ version: 1, kind: 'marketplace-absent', host }),
          observe,
          isDesired: (observation) => {
            const current = at(observation)
            return current.marketplace === null && current.plugin === null
          },
          isCompletedCompatible: (observation) => {
            const current = at(observation)
            return (current.marketplace === null && current.plugin === null)
              || (devMarketplaceIsRepo(current, repo)
                && (current.plugin === null || devHostMatches(current, repo, pluginVersion)))
          },
        }
      case 'marketplace-register':
        return {
          desired: JSON.stringify({ version: 1, kind: 'marketplace-present', host, repo }),
          observe,
          isDesired: (observation) => devMarketplaceIsRepo(at(observation), repo),
        }
      case 'plugin-install':
        return {
          desired: JSON.stringify({ version: 1, kind: 'plugin-installed', host, repo, pluginVersion }),
          observe,
          isDesired: (observation) => devHostMatches(at(observation), repo, pluginVersion),
        }
      default:
        throw new ManagedRuntimeIndeterminateError(`开发安装的宿主 step '${stepId}' 没有对应的 desired-state`)
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/dev-host.test.ts && npm run build:packages`
Expected: 全部 PASS；`tsc -b` 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/dev-host.ts packages/cli/src/commands/dev-host.test.ts
git commit -m "feat(cli): plan, observe and reconcile a directory marketplace for the development install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 缺上游技能 / 缺索引时自动拉取（`ensure.ts`）

**Files:**
- Create: `packages/cli/src/upstream-skills/ensure.ts`、`packages/cli/src/upstream-skills/ensure.test.ts`

**Interfaces:**
- Consumes: `installUpstreamSkills`、`UpstreamSkillInstallInput`、`UpstreamSkillInstallResult`（`install.ts:22-36,238`）；`parseUpstreamSkillSources`（`@tenon/kernel`，`packages/kernel/src/skills/upstream-sources.ts:207`，来源清单是严格的逐行 flow 格式）；`writeUpstreamSkillRunReport(stateRoot, report)`（`report.ts`）。
- Produces：
  ```ts
  export function upstreamSkillIds(repo: string): readonly string[]                     // 解析失败抛错
  export function upstreamSkillGap(repo: string): { readonly missingIds: readonly string[]; readonly indexMissing: boolean }
  export type EnsureUpstreamSkillsOutcome =
    | { readonly state: 'present' } | { readonly state: 'fetched' } | { readonly state: 'failed'; readonly detail: string }
  export async function ensureUpstreamSkillsForSource(input: {
    readonly repo: string; readonly env: UpstreamSkillInstallInput['env']
    readonly workRoot: string; readonly stateRoot: string
    readonly now: () => string; readonly log: (line: string) => void
    readonly install?: (input: UpstreamSkillInstallInput) => Promise<UpstreamSkillInstallResult>
  }): Promise<EnsureUpstreamSkillsOutcome>
  ```

- [ ] **Step 1: 写失败测试** `packages/cli/src/upstream-skills/ensure.test.ts`

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { UpstreamSkillInstallInput, UpstreamSkillInstallResult } from './install.js'
import { ensureUpstreamSkillsForSource, upstreamSkillGap, upstreamSkillIds } from './ensure.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const SOURCES = [
  'version: 1',
  'skills:',
  '  alpha: { repo: owner/alpha, path: skills/alpha, ref: default-branch, license_expected: MIT }',
  '  beta: { repo: owner/beta, path: skills/beta, ref: default-branch, license_expected: MIT }',
  '',
].join('\n')

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

function repoWith(options: { alpha?: boolean; beta?: boolean; index?: boolean; sources?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'tenon-ensure-'))
  roots.push(root)
  write(root, 'skills/sources.yaml', options.sources ?? SOURCES)
  if (options.alpha !== false) write(root, 'skills/alpha/SKILL.md', 'alpha\n')
  if (options.beta !== false) write(root, 'skills/beta/SKILL.md', 'beta\n')
  if (options.index !== false) write(root, 'skills/skills.lock.json', '{"version":1}\n')
  return root
}

function result(outcomes: Array<{ id: string; outcome: 'updated' | 'unchanged' | 'missing' }>): UpstreamSkillInstallResult {
  return {
    lockWritten: true,
    report: {
      version: 1,
      at: '2026-10-07T00:00:00.000Z',
      host: 'dev',
      results: outcomes.map((entry) => entry.outcome === 'missing'
        ? { id: entry.id, outcome: 'missing' as const, reason: 'unreachable' as const, detail: 'offline' }
        : { id: entry.id, outcome: entry.outcome }),
    },
  } as UpstreamSkillInstallResult
}

function base(repo: string, install: (input: UpstreamSkillInstallInput) => Promise<UpstreamSkillInstallResult>) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'tenon-ensure-state-'))
  roots.push(stateRoot)
  const lines: string[] = []
  return {
    lines,
    input: {
      repo,
      env: { runCommand: () => ({ code: 1, stdout: '', stderr: 'no git in unit tests' }) },
      workRoot: join(stateRoot, 'staging'),
      stateRoot,
      now: () => '2026-10-07T00:00:00.000Z',
      log: (line: string) => lines.push(line),
      install,
    },
  }
}

describe('upstreamSkillGap', () => {
  test('lists missing ids and a missing index', () => {
    const repo = repoWith({ beta: false, index: false })
    expect(upstreamSkillIds(repo)).toEqual(['alpha', 'beta'])
    expect(upstreamSkillGap(repo)).toEqual({ missingIds: ['beta'], indexMissing: true })
  })

  test('an empty sources file never reports a missing index', () => {
    const repo = repoWith({ sources: 'version: 1\nskills:\n', index: false })
    expect(upstreamSkillGap(repo)).toEqual({ missingIds: [], indexMissing: false })
  })
})

describe('ensureUpstreamSkillsForSource', () => {
  test('does nothing, and never touches the network, when every skill and the index exist', async () => {
    let calls = 0
    const { input } = base(repoWith(), async () => { calls += 1; return result([]) })
    expect(await ensureUpstreamSkillsForSource(input)).toEqual({ state: 'present' })
    expect(calls).toBe(0)
  })

  test('fetches into the repository itself when a skill is missing, treating the checkout as its own previous state', async () => {
    const repo = repoWith({ beta: false })
    let received: UpstreamSkillInstallInput | undefined
    const { input, lines } = base(repo, async (installInput) => {
      received = installInput
      write(repo, 'skills/beta/SKILL.md', 'beta\n')
      return result([{ id: 'alpha', outcome: 'unchanged' }, { id: 'beta', outcome: 'updated' }])
    })
    expect(await ensureUpstreamSkillsForSource(input)).toEqual({ state: 'fetched' })
    expect(received).toMatchObject({ pluginRoot: repo, previousRoot: repo, host: 'dev' })
    expect(lines.join('\n')).toContain('缺 1 个上游技能')
  })

  test('a missing index alone also triggers the fetch', async () => {
    const repo = repoWith({ index: false })
    let calls = 0
    const { input } = base(repo, async () => {
      calls += 1
      write(repo, 'skills/skills.lock.json', '{"version":1}\n')
      return result([{ id: 'alpha', outcome: 'unchanged' }, { id: 'beta', outcome: 'unchanged' }])
    })
    expect(await ensureUpstreamSkillsForSource(input)).toEqual({ state: 'fetched' })
    expect(calls).toBe(1)
  })

  test('any skill the fetch reports missing aborts as a whole', async () => {
    const { input } = base(repoWith({ alpha: false, beta: false }), async () => result([
      { id: 'alpha', outcome: 'missing' },
      { id: 'beta', outcome: 'updated' },
    ]))
    const outcome = await ensureUpstreamSkillsForSource(input)
    expect(outcome.state).toBe('failed')
    expect(outcome.state === 'failed' ? outcome.detail : '').toContain('alpha')
  })

  test('a fetch that throws, and a fetch that leaves the gap open, both abort', async () => {
    const thrown = base(repoWith({ beta: false }), async () => { throw new Error('git clone failed') })
    const thrownOutcome = await ensureUpstreamSkillsForSource(thrown.input)
    expect(thrownOutcome).toMatchObject({ state: 'failed' })
    expect(thrownOutcome.state === 'failed' ? thrownOutcome.detail : '').toContain('git clone failed')

    const stillOpen = base(repoWith({ beta: false }), async () => result([{ id: 'alpha', outcome: 'unchanged' }]))
    expect(await ensureUpstreamSkillsForSource(stillOpen.input)).toMatchObject({ state: 'failed' })
  })

  test('an invalid sources file aborts before any fetch', async () => {
    let calls = 0
    const { input } = base(repoWith({ sources: 'version: 1\nskills: {}\n' }), async () => { calls += 1; return result([]) })
    const outcome = await ensureUpstreamSkillsForSource(input)
    expect(outcome.state).toBe('failed')
    expect(calls).toBe(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/upstream-skills/ensure.test.ts`
Expected: FAIL（`Cannot find module './ensure.js'`）。

- [ ] **Step 3: 最小实现** `packages/cli/src/upstream-skills/ensure.ts`

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUpstreamSkillSources } from '@tenon/kernel'
import {
  installUpstreamSkills,
  type UpstreamSkillInstallInput,
  type UpstreamSkillInstallResult,
} from './install.js'
import { writeUpstreamSkillRunReport } from './report.js'

/** `skills/sources.yaml` 声明的全部上游技能 id；清单无效时抛错（调用方折算成失败）。 */
export function upstreamSkillIds(repo: string): readonly string[] {
  const text = readFileSync(join(repo, 'skills', 'sources.yaml'), 'utf8')
  return parseUpstreamSkillSources(text).skills.map((source) => source.id)
}

/** 仓库工作区里还缺哪些上游技能目录，以及本机拉取索引（被 git 忽略）是否缺失。 */
export function upstreamSkillGap(repo: string): {
  readonly missingIds: readonly string[]
  readonly indexMissing: boolean
} {
  const ids = upstreamSkillIds(repo)
  return {
    missingIds: ids.filter((id) => !existsSync(join(repo, 'skills', id, 'SKILL.md'))),
    indexMissing: ids.length > 0 && !existsSync(join(repo, 'skills', 'skills.lock.json')),
  }
}

export type EnsureUpstreamSkillsOutcome =
  | { readonly state: 'present' }
  | { readonly state: 'fetched' }
  | { readonly state: 'failed'; readonly detail: string }

export interface EnsureUpstreamSkillsInput {
  readonly repo: string
  readonly env: UpstreamSkillInstallInput['env']
  readonly workRoot: string
  readonly stateRoot: string
  readonly now: () => string
  readonly log: (line: string) => void
  /** 测试注入口；缺省走真实的 installUpstreamSkills（git clone）。 */
  readonly install?: (input: UpstreamSkillInstallInput) => Promise<UpstreamSkillInstallResult>
}

/**
 * 开发安装的初始化步骤：上游技能与本机索引都不进仓库，所以新 checkout / 新 worktree 里它们是缺的。
 * 缺才拉（等价 `npm run skills:fetch`，把仓库自己当作 previousRoot），都在位就一次网络都不碰——
 * 两次初始化之间不会自动重拉。任何失败整体中止，调用方据此不创建事务、不改宿主。
 */
export async function ensureUpstreamSkillsForSource(
  input: EnsureUpstreamSkillsInput,
): Promise<EnsureUpstreamSkillsOutcome> {
  let gap: ReturnType<typeof upstreamSkillGap>
  try {
    gap = upstreamSkillGap(input.repo)
  } catch (error) {
    return { state: 'failed', detail: `skills/sources.yaml 无效：${error instanceof Error ? error.message : String(error)}` }
  }
  if (gap.missingIds.length === 0 && !gap.indexMissing) return { state: 'present' }
  input.log(
    `[setup] 开发安装：缺 ${gap.missingIds.length} 个上游技能${gap.indexMissing ? '与本机拉取索引' : ''}，`
    + '按 skills/sources.yaml 获取（两次初始化之间不会自动重拉）',
  )
  const install = input.install ?? installUpstreamSkills
  let fetched: UpstreamSkillInstallResult
  try {
    fetched = await install({
      env: input.env,
      pluginRoot: input.repo,
      previousRoot: input.repo,
      host: 'dev',
      workRoot: input.workRoot,
      now: input.now,
      log: input.log,
    })
  } catch (error) {
    return { state: 'failed', detail: `上游技能获取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    await writeUpstreamSkillRunReport(input.stateRoot, fetched.report)
  } catch {
    // 报告只是 doctor 的诊断输入，写不下不改变安装结论。
  }
  const missing = fetched.report.results.filter((entry) => entry.outcome === 'missing')
  if (missing.length > 0) {
    return {
      state: 'failed',
      detail: `上游技能获取失败，已中止且未改动宿主：${missing.map((entry) => `${entry.id}（${entry.reason ?? 'unknown'}）`).join('、')}`,
    }
  }
  try {
    const after = upstreamSkillGap(input.repo)
    if (after.missingIds.length > 0 || after.indexMissing) {
      return {
        state: 'failed',
        detail: `获取结束后仍缺：${after.missingIds.join('、')}${after.indexMissing ? ' 与拉取索引' : ''}`,
      }
    }
  } catch (error) {
    return { state: 'failed', detail: `获取后复核失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { state: 'fetched' }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/upstream-skills/ensure.test.ts packages/cli/src/upstream-skills/install.test.ts packages/cli/src/commands/internal-skill-upstream.test.ts`
Expected: 全部 PASS（后两个是同源逻辑的回归保护）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upstream-skills/ensure.ts packages/cli/src/upstream-skills/ensure.test.ts
git commit -m "feat(cli): fetch missing upstream skills and the local index for a source install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `--from-source` 编排（`source-install.ts`）与 auto-update 关闭

**Files:**
- Create: `packages/cli/src/commands/source-install.ts`、`packages/cli/src/commands/source-install.test.ts`
- Modify: `packages/cli/src/commands/setupEnvironment.ts:230`（导出 `autoUpdateConfigPath`）并在 `configureAutoUpdate`（行 238-254）之后加 `disableAutoUpdateForDev`

**Interfaces:**
- Consumes: Task 3 的 `resolveSourceRepo`、`computeDevSourceIdentity`、`compareDevSource`、`devSourceEquals`、`devVersionLabel`、`writeInstallChannelMarker`；Task 5 的 `ManagedReleaseRequest.devSource`；Task 6 的 `devHostPlan`、`devHostReconciliation`、`observeDevNativeHost`、`decodeDevObservation`、`devHostMatches`；Task 7 的 `ensureUpstreamSkillsForSource`、`upstreamSkillIds`；现有 `runManagedHostCommand`（`managed-host-command.ts:47`）、`nativeHostConvergenceSequence`（`native-host-convergence-sequence.ts`）、`verifyPackagedAssets`（`packaged-assets.ts`）、`readHostPluginConvergenceReceipt`、`publishManagedRelease`、`printCodexHookTrust`。
- Produces：
  ```ts
  export interface SourceInstallPorts {
    readonly resolveRepo: (input: string) => SourceRepoResolution
    readonly ensureSkills: (repo: string) => Promise<EnsureUpstreamSkillsOutcome>
    readonly build: (repo: string) => { readonly code: number; readonly detail: string }
    readonly identity: (repo: string) => RuntimeDevSource
    readonly pluginVersion: (repo: string) => Promise<string>
    readonly publish: (request: ManagedReleaseRequest) => Promise<ManagedReleaseOutcome>
  }
  export interface SourceInstallInput {
    readonly deps: CliDeps; readonly host: NativePipelineHost; readonly repoInput: string
    readonly skipBuild: boolean; readonly env: SetupEnv; readonly runtimeScope: RuntimeInstallerScope; readonly openBrowser: boolean
  }
  export function validateFromSourceOptions(host: PipelineHost, opts: { fromSource?: string; skipBuild?: boolean; autoUpdate?: boolean }): string | null
  export function describeSourceInstallPlan(deps: CliDeps, host: NativePipelineHost, repoInput: string, skipBuild: boolean, ports?: Pick<SourceInstallPorts, 'resolveRepo' | 'identity'>): number
  export function createSourceInstallPorts(context: { deps: CliDeps; env: SetupEnv; installer: RuntimeInstaller; dashboardStarter: ReleasedDashboardStarter | undefined }): SourceInstallPorts
  export async function cmdSetupFromSource(input: SourceInstallInput, ports: SourceInstallPorts): Promise<number>
  export function clearDevInstallMarker(env: Pick<SetupEnv, 'homeDir' | 'runtimeEnv'>): void
  // setupEnvironment.ts
  export function autoUpdateConfigPath(env: SetupEnv): string
  export function disableAutoUpdateForDev(deps: CliDeps, env: SetupEnv, host: PipelineHost): void
  ```

- [ ] **Step 1: 写失败测试** `packages/cli/src/commands/source-install.test.ts`

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { installChannelPath, parseInstallChannel } from '../runtime/dev-install-marker.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import type { RuntimeActivation, RuntimeDevSource } from '../runtime/types.js'
import { makeDeps } from '../test-support.js'
import type { ManagedReleaseRequest } from './release-coordinator.js'
import {
  cmdSetupFromSource, describeSourceInstallPlan, validateFromSourceOptions,
  type SourceInstallPorts,
} from './source-install.js'
import type { SetupEnv } from './setupEnvironment.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const REPO = '/work/tenon'
const RELEASE_ID = `sha256-${'e'.repeat(64)}`
const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: REPO, commit: 'a'.repeat(40), dirty: true,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}
const ACTIVATION: RuntimeActivation = {
  selection: { version: 1, revision: 1, activeRelease: RELEASE_ID, previousRelease: null, updatedAt: '2026-10-07T00:00:00Z' },
  release: {
    version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
    source: { host: 'claude', pluginVersion: '0.3.2' }, devSource: DEV,
  },
  releaseRoot: `/runtime/releases/${RELEASE_ID}`,
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tenon-source-install-'))
  roots.push(root)
  return root
}

function fakeEnv(root: string, overrides: Partial<SetupEnv> = {}): SetupEnv {
  return {
    homeDir: () => root,
    runtimeEnv: () => ({ TENON_RUNTIME_HOME: join(root, 'runtime') }),
    readTextState: () => ({ state: 'missing' }),
    readText: (path: string) => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    pathExists: (path: string) => existsSync(path),
    mkdirp: (dir: string) => { mkdirSync(dir, { recursive: true }) },
    writeText: (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) },
    runCommand: () => ({ code: 127, stdout: '', stderr: 'no host commands expected in this test' }),
    ...overrides,
  } as unknown as SetupEnv
}

function fakePorts(overrides: Partial<SourceInstallPorts> = {}) {
  const events: string[] = []
  const captured: { request?: ManagedReleaseRequest } = {}
  const ports: SourceInstallPorts = {
    resolveRepo: (input) => { events.push('resolve'); return { ok: true, repo: input } },
    ensureSkills: async () => { events.push('ensure'); return { state: 'present' } },
    build: () => { events.push('build'); return { code: 0, detail: '' } },
    identity: () => { events.push('identity'); return DEV },
    pluginVersion: async () => '0.3.2',
    publish: async (request) => {
      events.push('publish')
      captured.request = request
      return { ok: true, state: 'ready', activation: ACTIVATION }
    },
    ...overrides,
  }
  return { ports, events, captured }
}

function input(root: string, deps = makeDeps(), extra: { skipBuild?: boolean; env?: SetupEnv } = {}) {
  return {
    deps,
    host: 'claude' as const,
    repoInput: REPO,
    skipBuild: extra.skipBuild ?? false,
    env: extra.env ?? fakeEnv(root),
    runtimeScope: { homeDir: root, env: {} },
    openBrowser: false,
  }
}

describe('cmdSetupFromSource', () => {
  test('resolves, ensures skills, builds, freezes the identity, then publishes a dev release request', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events, captured } = fakePorts()
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(0)
    expect(events).toEqual(['resolve', 'ensure', 'build', 'identity', 'publish'])
    expect(captured.request).toMatchObject({
      operation: 'setup', source: 'claude', expectedPluginVersion: '0.3.2', devSource: DEV, openBrowser: false,
    })
    expect(captured.request).not.toHaveProperty('requiresStableTarget')
    expect(captured.request).not.toHaveProperty('resolveStableTargetBeforeRecovery')
    expect(deps.outLines.join('\n')).toContain('0.3.2+dev.aaaaaaa')
    expect(deps.outLines.join('\n')).toContain('--to-stable')
  })

  test('--skip-build skips only the build', async () => {
    const root = tempRoot()
    const { ports, events } = fakePorts()
    expect(await cmdSetupFromSource(input(root, makeDeps(), { skipBuild: true }), ports)).toBe(0)
    expect(events).toEqual(['resolve', 'ensure', 'identity', 'publish'])
  })

  test('an unusable repository stops everything', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events } = fakePorts({ resolveRepo: () => ({ ok: false, reason: '不是 Tenon 源码仓库' }) })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(events).toEqual([])
    expect(deps.errLines.join('\n')).toContain('不是 Tenon 源码仓库')
  })

  test('a failed upstream skill fetch aborts before the build, the transaction and any host command', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events } = fakePorts({
      ensureSkills: async () => ({ state: 'failed', detail: '上游技能获取失败：alpha（unreachable）' }),
    })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(events).not.toContain('build')
    expect(events).not.toContain('publish')
    expect(deps.errLines.join('\n')).toContain('alpha')
    expect(deps.errLines.join('\n')).toContain('未创建事务')
  })

  test('a failed build aborts before the transaction', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports, events } = fakePorts({ build: () => ({ code: 2, detail: '' }) })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(events).not.toContain('publish')
    expect(deps.errLines.join('\n')).toContain('构建失败')
  })

  test('an identity that cannot be frozen aborts before the transaction', async () => {
    const root = tempRoot()
    const { ports, events } = fakePorts({ identity: () => { throw new Error('还没有任何提交') } })
    expect(await cmdSetupFromSource(input(root), ports)).toBe(1)
    expect(events).not.toContain('publish')
  })

  test('an unreadable convergence receipt refuses before any work', async () => {
    const root = tempRoot()
    const env = fakeEnv(root, { readTextState: () => ({ state: 'ok', text: 'not json' }) })
    const { ports, events } = fakePorts()
    expect(await cmdSetupFromSource(input(root, makeDeps(), { env }), ports)).toBe(1)
    expect(events).toEqual(['resolve'])
  })

  test('a failed managed transaction is reported with the resume command', async () => {
    const root = tempRoot()
    const deps = makeDeps()
    const { ports } = fakePorts({
      publish: async () => ({ ok: false, state: 'unchanged', detail: '宿主候选准备失败' }),
    })
    expect(await cmdSetupFromSource(input(root, deps), ports)).toBe(1)
    expect(deps.errLines.join('\n')).toContain('宿主候选准备失败')
    expect(deps.errLines.join('\n')).toContain('--from-source')
  })

  test('revalidation refuses a candidate whose workspace changed after the identity was frozen', async () => {
    const root = tempRoot()
    const changed = { ...DEV, worktreeDigest: 'f'.repeat(40) }
    let calls = 0
    // 第一次调用冻结身份；之后的调用代表激活前重算——工作区已经变了。
    const { ports, captured } = fakePorts({ identity: () => (calls++ === 0 ? DEV : changed) })
    await cmdSetupFromSource(input(root), ports)
    const request = captured.request
    if (request?.revalidateCandidate === undefined) throw new Error('request has no revalidateCandidate')
    await expect(Promise.resolve().then(() => request.revalidateCandidate?.(
      { candidateRoot: REPO }, { transactionId: 't1' },
    ))).rejects.toThrow('工作区在安装期间发生变化')
  })

  test('revalidation refuses a candidate root that is not the frozen repository', async () => {
    const root = tempRoot()
    const { ports, captured } = fakePorts()
    await cmdSetupFromSource(input(root), ports)
    const request = captured.request
    if (request?.revalidateCandidate === undefined) throw new Error('request has no revalidateCandidate')
    await expect(Promise.resolve().then(() => request.revalidateCandidate?.(
      { candidateRoot: '/somewhere/else' }, { transactionId: 't1' },
    ))).rejects.toThrow('不是冻结的源码仓库')
  })

  test('ready evidence writes the install-channel marker and turns an existing auto-update preference off', async () => {
    const root = tempRoot()
    const env = fakeEnv(root)
    const paths = resolveRuntimePaths({ homeDir: root, env: env.runtimeEnv() })
    mkdirSync(paths.configRoot, { recursive: true })
    writeFileSync(join(paths.configRoot, 'auto-update.conf'), 'host=claude\nenabled=true\n')
    const { ports, captured } = fakePorts()
    await cmdSetupFromSource(input(root, makeDeps(), { env }), ports)
    const request = captured.request
    if (request?.commitReadyEvidence === undefined) throw new Error('request has no commitReadyEvidence')
    await request.commitReadyEvidence(ACTIVATION, { candidateRoot: REPO }, 't1', {})
    const marker = parseInstallChannel(readFileSync(installChannelPath(paths.configRoot), 'utf8'))
    expect(marker).toMatchObject({ host: 'claude', releaseId: RELEASE_ID, devSource: DEV })
    expect(readFileSync(join(paths.configRoot, 'auto-update.conf'), 'utf8')).toBe('host=claude\nenabled=false\n')
  })

  test('ready evidence refuses a release that does not carry the frozen development source', async () => {
    const root = tempRoot()
    const { ports, captured } = fakePorts()
    await cmdSetupFromSource(input(root), ports)
    const request = captured.request
    if (request?.commitReadyEvidence === undefined) throw new Error('request has no commitReadyEvidence')
    const withoutDev: RuntimeActivation = {
      ...ACTIVATION,
      release: { version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z', source: { host: 'claude', pluginVersion: '0.3.2' } },
    }
    await expect(Promise.resolve().then(() => request.commitReadyEvidence?.(withoutDev, { candidateRoot: REPO }, 't1', {})))
      .rejects.toThrow('devSource')
  })
})

describe('validateFromSourceOptions', () => {
  test('accepts a native host with a repository path', () => {
    expect(validateFromSourceOptions('claude', { fromSource: '.' })).toBeNull()
    expect(validateFromSourceOptions('codex', { fromSource: '/work/tenon', skipBuild: true })).toBeNull()
  })

  test.each([
    ['an adapter host', 'cursor' as const, { fromSource: '.' }, 'adapter'],
    ['--auto-update', 'claude' as const, { fromSource: '.', autoUpdate: true }, '--auto-update'],
    ['an empty path', 'claude' as const, { fromSource: '  ' }, '源码仓库路径'],
    ['--skip-build alone', 'claude' as const, { skipBuild: true }, '--from-source'],
  ])('rejects %s', (_label, host, opts, fragment) => {
    expect(validateFromSourceOptions(host, opts)).toContain(fragment)
  })

  test('no source options means nothing to validate', () => {
    expect(validateFromSourceOptions('claude', {})).toBeNull()
  })
})

describe('describeSourceInstallPlan', () => {
  test('prints the dry-run plan with the exact host commands and changes nothing', () => {
    const deps = makeDeps()
    const { ports, events } = fakePorts()
    expect(describeSourceInstallPlan(deps, 'claude', REPO, false, ports)).toBe(0)
    const text = deps.outLines.join('\n')
    expect(text).toContain('claude plugin marketplace add /work/tenon')
    expect(text).toContain('npm --prefix /work/tenon run build')
    expect(text).toContain('--dry-run')
    expect(events).toEqual(['resolve', 'identity'])
  })

  test('--skip-build is reflected, and an invalid repository exits 1', () => {
    const deps = makeDeps()
    expect(describeSourceInstallPlan(deps, 'codex', REPO, true, fakePorts().ports)).toBe(0)
    expect(deps.outLines.join('\n')).toContain('--skip-build')
    const bad = makeDeps()
    expect(describeSourceInstallPlan(bad, 'codex', REPO, false, fakePorts({ resolveRepo: () => ({ ok: false, reason: 'nope' }) }).ports)).toBe(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/source-install.test.ts`
Expected: FAIL（`Cannot find module './source-install.js'`）。

- [ ] **Step 3: 最小实现**

`setupEnvironment.ts`：把行 230 的 `function autoUpdateConfigPath` 改成 `export function autoUpdateConfigPath`，并在 `configureAutoUpdate` 函数结束之后（行 254 之后）加

```ts
/**
 * 开发安装不参与自动更新。configureAutoUpdate(…, false) 什么都不写，已有的 opt-in 偏好不会被关，
 * 所以这里显式把它改写成 enabled=false；hooks/auto-update.sh 另外还会因 install-channel 标记直接退出。
 */
export function disableAutoUpdateForDev(deps: CliDeps, env: SetupEnv, host: PipelineHost): void {
  const config = autoUpdateConfigPath(env)
  if (!env.pathExists(config)) return
  try {
    env.writeText(config, `host=${host}\nenabled=false\n`)
    deps.io.out('[setup] 开发安装不参与自动更新：已关闭既有的自动更新偏好。')
  } catch (error) {
    deps.io.err(`WARN: 无法关闭自动更新偏好（auto-update.sh 仍会因 install-channel 标记而跳过）：${errMsg(error)}`)
  }
}
```

`packages/cli/src/commands/source-install.ts`：

```ts
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { errMsg, type CliDeps } from '../deps.js'
import { removeInstallChannelMarker, writeInstallChannelMarker } from '../runtime/dev-install-marker.js'
import {
  compareDevSource, computeDevSourceIdentity, devSourceEquals, devVersionLabel, resolveSourceRepo,
  type SourceRepoResolution,
} from '../runtime/dev-source-identity.js'
import type { RuntimeInstaller, RuntimeInstallerScope } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { releaseCandidateVersion } from '../runtime/release-payload.js'
import type { RuntimeActivation, RuntimeDevSource } from '../runtime/types.js'
import {
  ensureUpstreamSkillsForSource, upstreamSkillIds, type EnsureUpstreamSkillsOutcome,
} from '../upstream-skills/ensure.js'
import { parseDashboardPort } from './dashboard-launch-options.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import {
  decodeDevObservation, devHostMatches, devHostPlan, devHostReconciliation, observeDevNativeHost,
} from './dev-host.js'
import { readHostPluginConvergenceReceipt } from './host-plugin-convergence.js'
import { runManagedHostCommand } from './managed-host-command.js'
import { nativeHostConvergenceSequence } from './native-host-convergence-sequence.js'
import { verifyPackagedAssets } from './packaged-assets.js'
import {
  hostFlag, isNativePipelineHost, parseHostPluginInventory,
  type NativePipelineHost, type PipelineHost,
} from './plugin-host.js'
import {
  publishManagedRelease,
  type ManagedHostPreparationContext, type ManagedReleaseOutcome, type ManagedReleaseRequest,
} from './release-coordinator.js'
import { disableAutoUpdateForDev, printCodexHookTrust, type SetupEnv } from './setupEnvironment.js'

export interface SourceInstallPorts {
  readonly resolveRepo: (input: string) => SourceRepoResolution
  readonly ensureSkills: (repo: string) => Promise<EnsureUpstreamSkillsOutcome>
  readonly build: (repo: string) => { readonly code: number; readonly detail: string }
  readonly identity: (repo: string) => RuntimeDevSource
  readonly pluginVersion: (repo: string) => Promise<string>
  readonly publish: (request: ManagedReleaseRequest) => Promise<ManagedReleaseOutcome>
}

export interface SourceInstallInput {
  readonly deps: CliDeps
  readonly host: NativePipelineHost
  readonly repoInput: string
  readonly skipBuild: boolean
  /** 已绑定可信宿主命令的生命周期 env（cmdSetupHost 里的 lifecycleEnv）。 */
  readonly env: SetupEnv
  readonly runtimeScope: RuntimeInstallerScope
  readonly openBrowser: boolean
}

function commandText(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ')
}

/** `--from-source` 的选项组合校验；返回错误文案或 null。 */
export function validateFromSourceOptions(
  host: PipelineHost,
  opts: { readonly fromSource?: string; readonly skipBuild?: boolean; readonly autoUpdate?: boolean },
): string | null {
  if (opts.fromSource === undefined) {
    return opts.skipBuild === true ? '--skip-build 只能与 --from-source 同用' : null
  }
  if (!isNativePipelineHost(host)) {
    return `--from-source 只能与 --claude 或 --codex 之一同用（${hostFlag(host)} 是 adapter）`
  }
  if (opts.autoUpdate === true) return '开发安装不参与自动更新；--from-source 不能与 --auto-update 同用'
  if (opts.fromSource.trim() === '') return '--from-source 需要一个 Tenon 源码仓库路径'
  return null
}

/** `tenon setup --claude --from-source <repo> --dry-run`：只读，打印计划。 */
export function describeSourceInstallPlan(
  deps: CliDeps,
  host: NativePipelineHost,
  repoInput: string,
  skipBuild: boolean,
  ports: Pick<SourceInstallPorts, 'resolveRepo' | 'identity'> = {
    resolveRepo: (input) => resolveSourceRepo(input),
    identity: (repo) => computeDevSourceIdentity(repo),
  },
): number {
  const resolved = ports.resolveRepo(repoInput)
  if (!resolved.ok) {
    deps.io.err(`ERROR: ${resolved.reason}`)
    return 1
  }
  const repo = resolved.repo
  let identity: RuntimeDevSource
  try {
    identity = ports.identity(repo)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  deps.io.out(`[setup] ${hostFlag(host)} 源码开发安装（--dry-run：不拉取、不构建、不改宿主、不写 runtime）：`)
  deps.io.out(
    `[setup] 仓库 ${repo}；当前身份 commit ${identity.commit.slice(0, 7)}、`
    + `${identity.dirty ? '工作区有未提交改动' : '工作区干净'}、`
    + `worktree ${identity.worktreeDigest.slice(0, 7)}、skills-index ${identity.skillsIndexDigest.slice(0, 7)}`,
  )
  deps.io.out('[setup] 1. 缺上游技能或缺 skills/skills.lock.json 时按 skills/sources.yaml 获取；失败整体中止，不改宿主')
  deps.io.out(skipBuild
    ? '[setup] 2. 已按 --skip-build 跳过构建'
    : `[setup] 2. 构建：npm --prefix ${repo} run build`)
  deps.io.out('[setup] 3. 移除既有 tenon 登记，再把该目录登记为 marketplace 并安装：')
  for (const item of devHostPlan(host, repo)) deps.io.out(`[setup] $ ${commandText(item.cmd, item.args)}`)
  deps.io.out('[setup] 4. 以仓库工作区为候选根校验并原子发布 managed runtime（release 记录 channel=dev、commit、dirty、worktreeDigest、skillsIndexDigest）')
  deps.io.out(`[setup] 5. 写入 install-channel 标记并关闭 auto-update；之后 tenon update 默认拒绝，切回正式版：tenon update ${hostFlag(host)} --to-stable`)
  return 0
}

export function createSourceInstallPorts(context: {
  readonly deps: CliDeps
  readonly env: SetupEnv
  readonly installer: RuntimeInstaller
  readonly dashboardStarter: ReleasedDashboardStarter | undefined
}): SourceInstallPorts {
  const { deps, env } = context
  const paths = resolveRuntimePaths({ homeDir: env.homeDir(), env: env.runtimeEnv() })
  return {
    resolveRepo: (input) => resolveSourceRepo(input),
    ensureSkills: (repo) => ensureUpstreamSkillsForSource({
      repo,
      env,
      workRoot: paths.stagingRoot,
      stateRoot: paths.stateRoot,
      now: () => new Date().toISOString(),
      log: (line) => deps.io.out(line),
      ...(env.installUpstreamSkills === undefined ? {} : { install: env.installUpstreamSkills }),
    }),
    // 构建输出直接流到终端（几分钟的 tsc / vite 不该被缓冲吞掉），退出码是唯一的判据。
    build: (repo) => {
      const result = spawnSync('npm', ['--prefix', repo, 'run', 'build'], { stdio: 'inherit' })
      return { code: result.status ?? 1, detail: result.error === undefined ? '' : errMsg(result.error) }
    },
    identity: (repo) => computeDevSourceIdentity(repo),
    pluginVersion: (repo) => releaseCandidateVersion(repo),
    publish: (request) => publishManagedRelease(deps, request, context.installer, context.dashboardStarter),
  }
}

/** 正式安装 / 切回正式版成功之后清掉开发标记，让 hook 与 auto-update.sh 回到正式版行为。 */
export function clearDevInstallMarker(env: Pick<SetupEnv, 'homeDir' | 'runtimeEnv'>): void {
  removeInstallChannelMarker(resolveRuntimePaths({ homeDir: env.homeDir(), env: env.runtimeEnv() }).configRoot)
}

interface DevCandidateContext {
  readonly deps: CliDeps
  readonly env: SetupEnv
  readonly host: NativePipelineHost
  readonly repo: string
  readonly version: string
}

/**
 * 宿主加载根必须带着 sources.yaml 里的全部上游技能；宿主 CLI 是自己缓存的唯一 writer，
 * Tenon 不去改它，缺就中止（Task 1 实测两个宿主都会复制被忽略的文件）。
 */
function assertHostHasUpstreamSkills(env: SetupEnv, repo: string, hostRoot: string): void {
  if (hostRoot === repo) return
  const missing = upstreamSkillIds(repo).filter((id) => !env.pathExists(join(hostRoot, 'skills', id, 'SKILL.md')))
  if (missing.length > 0) {
    throw new Error(
      `宿主加载根 ${hostRoot} 缺少上游技能 ${missing.slice(0, 5).join('、')}`
      + `${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}；宿主没有复制被 git 忽略的文件`,
    )
  }
}

async function prepareDevCandidate(
  ctx: DevCandidateContext,
  transaction: ManagedHostPreparationContext,
): Promise<{ readonly candidateRoot: string; readonly evidence: string }> {
  const { deps, env, host, repo, version } = ctx
  const plan = devHostPlan(host, repo)
  const listItem = plan.at(-1)
  if (listItem === undefined) throw new Error('开发安装宿主计划缺少 inventory 命令')
  const before = await runManagedHostCommand(transaction, 'inventory-before', env, listItem)
  if (before.code !== 0) {
    throw new Error(`宿主 plugin inventory 读取失败：${before.stderr.trim() || before.stdout.trim() || `退出码 ${before.code}`}`)
  }
  const parsedBefore = parseHostPluginInventory(host, before.stdout)
  if (parsedBefore === null) throw new Error('宿主 plugin inventory 响应畸形')
  const steps = nativeHostConvergenceSequence(plan, { plugin: parsedBefore.tenonRegistered })
  let inventory = ''
  for (const step of steps) {
    deps.io.out(`[setup] $ ${commandText(step.item.cmd, step.item.args)}`)
    const result = await runManagedHostCommand(transaction, step.id, env, step.item)
    if (step.id === 'inventory-after') {
      if (result.code !== 0) throw new Error(`宿主 plugin inventory 读取失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
      inventory = result.stdout
    }
  }
  const parsed = parseHostPluginInventory(host, inventory)
  if (parsed === null || parsed.tenonRoot === null) throw new Error(`${hostFlag(host)} 插件清单中没有启用的 tenon`)
  if (parsed.tenonVersion !== version) {
    throw new Error(`${hostFlag(host)} 插件版本 ${parsed.tenonVersion ?? 'unknown'} 不等于源码仓库的 ${version}`)
  }
  assertHostHasUpstreamSkills(env, repo, parsed.tenonRoot)
  if (verifyPackagedAssets(deps, env, repo, false) !== 0) throw new Error('源码仓库未通过插件资产校验')
  return { candidateRoot: repo, evidence: inventory }
}

function revalidateDevCandidate(
  ctx: DevCandidateContext & { readonly devSource: RuntimeDevSource; readonly identity: (repo: string) => RuntimeDevSource },
  candidate: { readonly candidateRoot: string },
): void {
  const { deps, env, host, repo, version } = ctx
  if (candidate.candidateRoot !== repo) {
    throw new Error(`候选根 ${candidate.candidateRoot} 不是冻结的源码仓库 ${repo}`)
  }
  const drift = compareDevSource(ctx.devSource, ctx.identity(repo))
  if (drift.length > 0) {
    throw new Error(
      `工作区在安装期间发生变化（${drift.join('；')}）；请重新运行 `
      + `tenon setup ${hostFlag(host)} --from-source ${repo}`,
    )
  }
  const observation = decodeDevObservation(observeDevNativeHost(env, host))
  if (!devHostMatches(observation, repo, version)) {
    throw new Error('宿主登记不再绑定冻结的源码仓库与版本')
  }
  if (verifyPackagedAssets(deps, env, repo, false, true) !== 0) throw new Error('候选打包资产重证失败')
}

function commitDevEvidence(
  ctx: { readonly deps: CliDeps; readonly env: SetupEnv; readonly host: NativePipelineHost; readonly devSource: RuntimeDevSource },
  activation: RuntimeActivation,
): void {
  const { release } = activation
  if (release.version !== 2 || release.devSource === undefined || !devSourceEquals(release.devSource, ctx.devSource)) {
    throw new Error('ready evidence 的 release 没有携带冻结的 devSource')
  }
  const configRoot = resolveRuntimePaths({ homeDir: ctx.env.homeDir(), env: ctx.env.runtimeEnv() }).configRoot
  writeInstallChannelMarker(configRoot, {
    host: ctx.host,
    releaseId: release.releaseId,
    installedAt: ctx.deps.clock(),
    devSource: ctx.devSource,
  })
  disableAutoUpdateForDev(ctx.deps, ctx.env, ctx.host)
}

export async function cmdSetupFromSource(input: SourceInstallInput, ports: SourceInstallPorts): Promise<number> {
  const { deps, host, env } = input
  const resolved = ports.resolveRepo(input.repoInput)
  if (!resolved.ok) {
    deps.io.err(`ERROR: ${resolved.reason}`)
    return 1
  }
  const repo = resolved.repo

  // 旧 pipeline 插件的迁移收敛绑定正式稳定标签，开发安装不接管它。
  const convergence = readHostPluginConvergenceReceipt(env, host)
  if (convergence.state === 'invalid') {
    deps.io.err(`ERROR: ${convergence.detail}；未执行任何变更。`)
    return 1
  }
  if (convergence.state === 'receipt' && convergence.receipt.state === 'cleanup-pending') {
    deps.io.err(`ERROR: 旧 Tenon 插件的迁移清理仍在等待（cleanup-pending）；请先完成正式 setup：tenon setup ${hostFlag(host)}。未执行任何变更。`)
    return 1
  }

  const skills = await ports.ensureSkills(repo)
  if (skills.state === 'failed') {
    deps.io.err(`ERROR: ${skills.detail}`)
    deps.io.err('[setup] 未创建事务、未改动宿主与 runtime；网络恢复后重跑同一命令即可（幂等）。')
    return 1
  }

  if (input.skipBuild) {
    deps.io.out('[setup] 已按 --skip-build 跳过构建；请确认 packages/*/dist 与源码一致。')
  } else {
    deps.io.out(`[setup] 构建源码：npm --prefix ${repo} run build（几分钟，输出直接显示）`)
    const built = ports.build(repo)
    if (built.code !== 0) {
      deps.io.err(`ERROR: 源码构建失败（退出码 ${built.code}）${built.detail === '' ? '' : `：${built.detail}`}；未改动宿主与 runtime。`)
      return 1
    }
  }

  let devSource: RuntimeDevSource
  let version: string
  try {
    devSource = ports.identity(repo)
    version = await ports.pluginVersion(repo)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  deps.io.out(
    `[setup] 冻结源码身份：${repo} @ ${devSource.commit.slice(0, 7)}`
    + `${devSource.dirty ? '（工作区有未提交改动）' : ''}，版本展示 ${devVersionLabel(version, devSource.commit)}`,
  )

  const devEnv: SetupEnv = { ...env, managedHostReconciliation: devHostReconciliation(env, repo, version) }
  const dashboardPort = parseDashboardPort(env.runtimeEnv().TENON_DASHBOARD_PORT)
  const context: DevCandidateContext = { deps, env: devEnv, host, repo, version }
  const request: ManagedReleaseRequest = {
    operation: 'setup',
    source: host,
    expectedPluginVersion: version,
    devSource,
    runtime: input.runtimeScope,
    openBrowser: input.openBrowser,
    ...(dashboardPort === null ? {} : { dashboardPort }),
    prepareCandidate: (transaction) => prepareDevCandidate(context, transaction),
    revalidateCandidate: (candidate) => {
      revalidateDevCandidate({ ...context, devSource, identity: ports.identity }, candidate)
    },
    commitReadyEvidence: (activation) => {
      commitDevEvidence({ deps, env, host, devSource }, activation)
    },
  }
  const outcome = await ports.publish(request)
  if (!outcome.ok) {
    deps.io.err(`ERROR: ${outcome.detail}`)
    deps.io.err(
      `[setup] ${hostFlag(host)} 宿主登记由宿主 CLI 独立管理；Tenon 只补偿自己的 managed transaction。`
      + `重跑 tenon setup ${hostFlag(host)} --from-source ${repo} 会从 WAL 幂等恢复。`,
    )
    return 1
  }
  if (outcome.state === 'current') {
    deps.io.out('[setup] 宿主、managed runtime 与 Dashboard 已精确就绪；未重复发布。')
    return 0
  }
  deps.io.out(`[setup] 已发布开发 runtime：${outcome.activation.release.releaseId}（revision ${outcome.activation.selection.revision}）。`)
  deps.io.out(
    `[setup] 这是源码开发安装（${devVersionLabel(version, devSource.commit)}），不是正式版：`
    + `同步源码改动请重跑 tenon setup ${hostFlag(host)} --from-source ${repo}；`
    + `切回正式版：tenon update ${hostFlag(host)} --to-stable。新开会话加载技能与 hooks。`,
  )
  if (host === 'codex') printCodexHookTrust(deps)
  return 0
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/source-install.test.ts packages/cli/src/commands/setupEnvironment.test.ts && npm run build:packages`
Expected: 全部 PASS；`tsc -b` 无错误（`CliDeps.clock` 存在；`ManagedReleaseRequest` 的 `revalidateCandidate` / `commitReadyEvidence` 回调签名比本实现多的参数被忽略）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/source-install.ts packages/cli/src/commands/source-install.test.ts packages/cli/src/commands/setupEnvironment.ts
git commit -m "feat(cli): orchestrate tenon setup --from-source over the managed release transaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 把 `--from-source` 接进 `tenon setup`

**Files:**
- Modify: `packages/cli/src/program-install.ts:34-52`（setup 的两个新选项）
- Modify: `packages/cli/src/commands/setupEnvironment.ts`（`SetupOpts` 加 `fromSource?`、`skipBuild?`；文件里 `export interface SetupOpts` 处）
- Modify: `packages/cli/src/commands/setupHost.ts`（导入；`cmdSetupHost` 开头校验；dry-run 分支；在 `return (async () => {`（行 136）之前分发；`if (runtimeCode !== 0) return runtimeCode`（行 249）之后清标记）
- Create: `packages/cli/src/commands/setup-from-source.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `validateFromSourceOptions`、`describeSourceInstallPlan`、`cmdSetupFromSource`、`createSourceInstallPorts`、`clearDevInstallMarker`。
- Produces: `tenon setup --claude|--codex --from-source <repo> [--skip-build] [--dry-run]`；无 `--from-source` 时 `cmdSetupHost` 的行为与改动前一致，唯一差别是正式 setup 成功后多一次「清标记」（没有标记就是空操作）。

- [ ] **Step 1: 写失败测试** `packages/cli/src/commands/setup-from-source.test.ts`

```ts
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { buildProgram, CliExit } from '../program.js'
import { installChannelPath, writeInstallChannelMarker, type DevInstallMarker } from '../runtime/dev-install-marker.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { makeDeps } from '../test-support.js'
import { clearDevInstallMarker } from './source-install.js'

/** 本 checkout 自己就是满足四项判据的 Tenon 源码仓库；dry-run 只读，用它省掉造夹具。 */
const checkout = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function run(args: string[]) {
  const deps = makeDeps()
  let code = 0
  try {
    await buildProgram(deps).parseAsync(args, { from: 'user' })
  } catch (error) {
    if (error instanceof CliExit) code = error.code
    else throw error
  }
  return { code, out: deps.outLines.join('\n'), err: deps.errLines.join('\n') }
}

describe('tenon setup --from-source option wiring', () => {
  test('--dry-run prints the development plan for this checkout and changes nothing', async () => {
    const result = await run(['setup', '--claude', '--from-source', checkout, '--skip-build', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.out).toContain(`claude plugin marketplace add ${checkout}`)
    expect(result.out).toContain('--skip-build')
    expect(result.out).toContain('commit ')
  })

  test.each([
    ['an adapter host', ['setup', '--cursor', '--from-source', checkout, '--dry-run'], 'adapter'],
    ['--auto-update', ['setup', '--claude', '--from-source', checkout, '--auto-update', '--dry-run'], '--auto-update'],
    ['--skip-build without --from-source', ['setup', '--claude', '--skip-build', '--dry-run'], '--from-source'],
  ])('rejects %s before any work', async (_label, args, fragment) => {
    const result = await run(args)
    expect(result.code).toBe(1)
    expect(result.err).toContain(fragment)
  })

  test('a path that is not a Tenon source repository is refused in dry-run too', async () => {
    const result = await run(['setup', '--claude', '--from-source', tmpdir(), '--dry-run'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('不是 Tenon 源码仓库')
  })
})

describe('clearDevInstallMarker', () => {
  const MARKER: DevInstallMarker = {
    host: 'claude',
    releaseId: `sha256-${'a'.repeat(64)}`,
    installedAt: '2026-10-07T12:00:00Z',
    devSource: {
      kind: 'dev', repoRealpath: '/work/tenon', commit: 'b'.repeat(40), dirty: false,
      worktreeDigest: 'c'.repeat(40), skillsIndexDigest: 'd'.repeat(40),
    },
  }

  test('removes the marker under the config root and is a no-op without one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-clear-marker-'))
    roots.push(root)
    const env = { homeDir: () => root, runtimeEnv: () => ({ TENON_RUNTIME_HOME: join(root, 'runtime') }) }
    const configRoot = resolveRuntimePaths({ homeDir: root, env: env.runtimeEnv() }).configRoot
    writeInstallChannelMarker(configRoot, MARKER)
    expect(existsSync(installChannelPath(configRoot))).toBe(true)
    clearDevInstallMarker(env)
    expect(existsSync(installChannelPath(configRoot))).toBe(false)
    expect(() => clearDevInstallMarker(env)).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/setup-from-source.test.ts`
Expected: FAIL（commander 报 `unknown option '--from-source'`，退出码非预期）。

- [ ] **Step 3: 最小实现**

`program-install.ts`：在 setup 命令的 `.option('--auto-update', …)` 之后加

```ts
    .option('--from-source <repo>', '源码开发安装：从 Tenon 源码仓库工作区构建并安装（只能与 --claude 或 --codex 之一同用；不冒充版本标签）')
    .option('--skip-build', '--from-source 时跳过 npm run build（仅在 packages/*/dist 已与源码一致时使用）')
```

`setupEnvironment.ts` 的 `SetupOpts` 里加

```ts
  /** 源码开发安装：Tenon 源码仓库路径（tenon setup --from-source）。 */
  fromSource?: string
  /** 仅与 fromSource 同用：跳过 npm run build。 */
  skipBuild?: boolean
```

`setupHost.ts`：导入处加

```ts
import {
  clearDevInstallMarker,
  cmdSetupFromSource,
  createSourceInstallPorts,
  describeSourceInstallPlan,
  validateFromSourceOptions,
} from './source-install.js'
```

`cmdSetupHost` 的函数体第一行（`if (opts.autoUpdate && !isNativePipelineHost(host))` 之前）加

```ts
  const invalidSource = validateFromSourceOptions(host, opts)
  if (invalidSource !== null) {
    deps.io.err(`ERROR: ${invalidSource}`)
    return 1
  }
```

dry-run 的原生分支开头（`if (isNativePipelineHost(host)) {` 之后第一行，行 81 附近）加

```ts
      if (opts.fromSource !== undefined) {
        return describeSourceInstallPlan(deps, host, opts.fromSource, opts.skipBuild === true)
      }
```

在 `return (async () => {`（行 136）之前加

```ts
    if (opts.fromSource !== undefined) {
      return cmdSetupFromSource(
        {
          deps,
          host,
          repoInput: opts.fromSource,
          skipBuild: opts.skipBuild === true,
          env: lifecycleEnv,
          runtimeScope,
          openBrowser: openDashboard,
        },
        createSourceInstallPorts({ deps, env: lifecycleEnv, installer, dashboardStarter }),
      )
    }
```

在 `if (runtimeCode !== 0) return runtimeCode`（行 249）之后加

```ts
      // 正式安装成功：开发标记不再代表现状，清掉它，hook 与 auto-update.sh 回到正式版行为。
      clearDevInstallMarker(lifecycleEnv)
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/setup-from-source.test.ts packages/cli/src/commands/setup.test.ts packages/cli/src/commands/setupEnvironment.test.ts && npm run build:packages`
Expected: 全部 PASS（`setup.test.ts` 是对正式路径的回归保护，它们的临时 HOME 里没有标记，清标记是空操作）；`tsc -b` 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/program-install.ts packages/cli/src/commands/setupEnvironment.ts packages/cli/src/commands/setupHost.ts packages/cli/src/commands/setup-from-source.test.ts
git commit -m "feat(cli): wire tenon setup --from-source into the setup command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 开发安装下 `tenon update` 默认 fail-closed，`--to-stable` 切回正式版

**Files:**
- Create: `packages/cli/src/commands/update-dev-guard.ts`、`packages/cli/src/commands/update-dev-guard.test.ts`
- Modify: `packages/cli/src/commands/update.ts:23-28,31-110`（`UpdateOpts.toStable`；原生路径末尾改成先裁决再 `runNativeUpdate`）
- Modify: `packages/cli/src/commands/update-native-contract.ts`（`NativeUpdateInput.fromDev?`）
- Modify: `packages/cli/src/commands/update-native.ts:33-48,192-207,369-373`（解构 `fromDev`、跳过降级拒绝、成功后清标记）
- Modify: `packages/cli/src/program-install.ts`（update 的 `--to-stable` 选项）

**Interfaces:**
- Consumes: Task 3 的 `devVersionLabel`；Task 8 的 `clearDevInstallMarker`；`RuntimeReleaseManifest`（`runtime/types.ts`）。
- Produces：
  ```ts
  export type DevUpdateDecision =
    | { readonly action: 'proceed'; readonly fromDev: boolean }
    | { readonly action: 'refuse'; readonly message: readonly string[] }
  export function decideDevUpdate(active: RuntimeReleaseManifest | null, host: NativePipelineHost, toStable: boolean): DevUpdateDecision
  ```

- [ ] **Step 1: 写失败测试** `packages/cli/src/commands/update-dev-guard.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { RuntimeInstaller } from '../runtime/installer.js'
import type { RuntimeDevSource, RuntimeReleaseManifest } from '../runtime/types.js'
import { makeDeps } from '../test-support.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import type { SetupEnv } from './setupEnvironment.js'
import { decideDevUpdate } from './update-dev-guard.js'
import { cmdUpdate } from './update.js'

const RELEASE_ID = `sha256-${'e'.repeat(64)}`
const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: false,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}
const DEV_RELEASE: RuntimeReleaseManifest = {
  version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
  source: { host: 'claude', pluginVersion: '0.3.2' }, devSource: DEV,
}
const STABLE_RELEASE: RuntimeReleaseManifest = {
  version: 2, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
  source: { host: 'claude', pluginVersion: '0.3.2' },
  stableTarget: { version: '0.3.2', tag: 'v0.3.2', commit: 'a'.repeat(40) },
}

describe('decideDevUpdate', () => {
  test('a development install refuses a plain update and names both ways out', () => {
    const decision = decideDevUpdate(DEV_RELEASE, 'claude', false)
    expect(decision.action).toBe('refuse')
    const text = decision.action === 'refuse' ? decision.message.join('\n') : ''
    expect(text).toContain('0.3.2+dev.abcdef0')
    expect(text).toContain('/work/tenon')
    expect(text).toContain('tenon setup --claude --from-source /work/tenon')
    expect(text).toContain('tenon update --claude --to-stable')
  })

  test('--to-stable proceeds and marks the downgrade check as authorised', () => {
    expect(decideDevUpdate(DEV_RELEASE, 'claude', true)).toEqual({ action: 'proceed', fromDev: true })
  })

  test('a stable install, a missing runtime and a manifest v1 all proceed unchanged', () => {
    expect(decideDevUpdate(STABLE_RELEASE, 'claude', false)).toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate(STABLE_RELEASE, 'claude', true)).toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate(null, 'codex', false)).toEqual({ action: 'proceed', fromDev: false })
    expect(decideDevUpdate({
      version: 1, releaseId: RELEASE_ID, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
      source: { host: 'claude', pluginVersion: '0.3.2' },
    }, 'claude', false)).toEqual({ action: 'proceed', fromDev: false })
  })
})

function fixtures(active: RuntimeReleaseManifest) {
  const binding = {
    executable: '/usr/bin/claude',
    verify: () => true,
    invocation: (args: readonly string[]) => ({ file: '/usr/bin/claude', args: [...args] }),
  }
  const env = {
    homeDir: () => '/home/test',
    runtimeEnv: () => ({}),
    resolveHostCommand: () => binding,
  } as unknown as SetupEnv
  const installer = {
    inspect: async () => ({
      selection: { version: 1, revision: 1, activeRelease: active.releaseId, previousRelease: null, updatedAt: '2026-10-07T00:00:00Z' },
      active, previous: null, activeValid: true, previousValid: false, lastAudit: null,
    }),
    // runNativeUpdate 的第一步：让它在这里失败，证明守卫已经放行而没有真的去更新。
    peekManagedJournal: async () => { throw new Error('probe stops here') },
    withManagedTransaction: async () => { throw new Error('no transaction expected') },
    rollback: async () => { throw new Error('unused') },
  } as unknown as RuntimeInstaller
  const starter = {
    inspect: async () => null, adopt: async () => null,
    start: async () => { throw new Error('no dashboard expected') },
  } as unknown as ReleasedDashboardStarter
  const resolver = { resolve: async () => { throw new Error('the release must not be resolved') } }
  return { env, installer, starter, resolver }
}

describe('cmdUpdate with a development install', () => {
  test('refuses before resolving any release or touching the host', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(DEV_RELEASE)
    expect(await cmdUpdate(deps, { claude: true }, env, installer, starter, resolver)).toBe(1)
    const err = deps.errLines.join('\n')
    expect(err).toContain('源码开发安装')
    expect(err).toContain('--to-stable')
    expect(err).not.toContain('must not be resolved')
  })

  test('--to-stable passes the guard and continues into the stable update path', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(DEV_RELEASE)
    expect(await cmdUpdate(deps, { claude: true, toStable: true }, env, installer, starter, resolver)).toBe(1)
    const err = deps.errLines.join('\n')
    expect(err).not.toContain('源码开发安装')
    expect(err).toContain('probe stops here')
  })

  test('a stable install never sees the guard', async () => {
    const deps = makeDeps()
    const { env, installer, starter, resolver } = fixtures(STABLE_RELEASE)
    expect(await cmdUpdate(deps, { claude: true }, env, installer, starter, resolver)).toBe(1)
    expect(deps.errLines.join('\n')).not.toContain('源码开发安装')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/update-dev-guard.test.ts`
Expected: FAIL（`Cannot find module './update-dev-guard.js'`）。

- [ ] **Step 3: 最小实现**

`packages/cli/src/commands/update-dev-guard.ts`：

```ts
import { devVersionLabel } from '../runtime/dev-source-identity.js'
import type { RuntimeReleaseManifest } from '../runtime/types.js'
import { hostFlag, type NativePipelineHost } from './plugin-host.js'

export type DevUpdateDecision =
  | { readonly action: 'proceed'; readonly fromDev: boolean }
  | { readonly action: 'refuse'; readonly message: readonly string[] }

/**
 * 开发安装之上的 `tenon update`：默认拒绝，免得一次后台或手滑的 update 把源码安装换回正式版；
 * `--to-stable` 是显式授权的切回，此时稳定路径要跳过「拒绝降级」（开发版本号来自仓库，可能高于最新正式版）。
 */
export function decideDevUpdate(
  active: RuntimeReleaseManifest | null,
  host: NativePipelineHost,
  toStable: boolean,
): DevUpdateDecision {
  if (active === null || active.version !== 2 || active.devSource === undefined) {
    return { action: 'proceed', fromDev: false }
  }
  if (toStable) return { action: 'proceed', fromDev: true }
  const dev = active.devSource
  const flag = hostFlag(host)
  return {
    action: 'refuse',
    message: [
      `ERROR: 当前是源码开发安装（${devVersionLabel(active.source.pluginVersion, dev.commit)}，仓库 ${dev.repoRealpath}）；`
      + 'tenon update 只认正式稳定版，默认拒绝，以免覆盖开发安装。',
      `[update] 重新同步源码：tenon setup ${flag} --from-source ${dev.repoRealpath}`,
      `[update] 切回正式版：tenon update ${flag} --to-stable`,
    ],
  }
}
```

`update.ts`：`UpdateOpts` 加 `toStable?: boolean`；顶部加 `import type { RuntimeReleaseManifest } from '../runtime/types.js'` 与 `import { decideDevUpdate } from './update-dev-guard.js'`；把函数末尾的 `return runNativeUpdate({…})`（行 91-109）改成

```ts
  const runtimeScope = {
    homeDir: lifecycleEnv.homeDir(),
    env: lifecycleEnv.runtimeEnv(),
    ...(trustedCommands.bash === undefined ? {} : { trustedBashPath: trustedCommands.bash }),
    ...(trustedBash === undefined ? {} : { verifyTrustedBash: trustedBash.assert }),
    ...(trustedCommands.node === undefined ? {} : { trustedNodePath: trustedCommands.node }),
    ...(trustedNode === undefined ? {} : {
      trustedNodeProof: trustedNode.proof,
      verifyTrustedNode: trustedNode.assert,
    }),
  }
  return (async () => {
    let active: RuntimeReleaseManifest | null = null
    try {
      const inspection = await installer.inspect(runtimeScope)
      active = inspection.activeValid ? inspection.active : null
    } catch {
      // runtime 状态读不出来时交给稳定路径自己的检查去 fail-closed，这里不替它下结论。
      active = null
    }
    const decision = decideDevUpdate(active, host, opts.toStable === true)
    if (decision.action === 'refuse') {
      for (const line of decision.message) deps.io.err(line)
      return 1
    }
    return runNativeUpdate({
      deps,
      env: lifecycleEnv,
      installer,
      dashboardStarter,
      releaseResolver,
      inspectCandidate,
      host,
      hostExecutable: hostBinding.executable,
      trustedBashPath: trustedCommands.bash,
      verifyTrustedBash: trustedBash?.assert,
      trustedNodePath: trustedCommands.node,
      trustedNodeProof: trustedNode?.proof,
      verifyTrustedNode: trustedNode?.assert,
      auto: opts.auto === true,
      fromDev: decision.fromDev,
    })
  })()
```

`update-native-contract.ts`：`NativeUpdateInput` 末尾加 `/** 从开发安装经 --to-stable 切回：开发版本号可能高于最新正式版，跳过「拒绝降级」。 */ readonly fromDev?: boolean`。

`update-native.ts`：解构里（行 33-48）加 `fromDev,`；把 `for (const [label, version] of [...] as const) { if (version === null) continue` 的 `continue` 之后加

```ts
          // 开发安装的版本号来自源码仓库；切回正式版是 --to-stable 显式授权的「降级」。
          if (fromDev === true) continue
```

在 `if (!outcome.ok) {…return rejectUpdate(…)}` 块（行 369-373）之后、`if (outcome.state === 'current')` 之前加

```ts
  // 正式版已就绪（含 --to-stable 从开发安装切回）：开发标记不再代表现状。
  clearDevInstallMarker(env)
```

并在导入处加 `import { clearDevInstallMarker } from './source-install.js'`。

`program-install.ts`：update 命令的 `.option('--auto', …)` 之后加

```ts
    .option('--to-stable', '开发安装（tenon setup --from-source）切回最新正式稳定版；对正式安装是空操作')
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/update-dev-guard.test.ts packages/cli/src/commands/update.test.ts && npm run build:packages`
Expected: 全部 PASS（`update.test.ts` 2087 行是稳定路径的回归保护；其 fake env 没有标记，清标记是空操作）；`tsc -b` 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/update-dev-guard.ts packages/cli/src/commands/update-dev-guard.test.ts packages/cli/src/commands/update.ts packages/cli/src/commands/update-native-contract.ts packages/cli/src/commands/update-native.ts packages/cli/src/program-install.ts
git commit -m "feat(cli): refuse tenon update on a development install unless --to-stable is given

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `identity:release` 对开发安装给 yellow

**Files:**
- Modify: `packages/cli/src/deps.ts:44`（`DoctorProductIdentity` 加 `dev` 变体）
- Modify: `packages/cli/src/commands/doctor-product-identity.ts:129-133,254-266`（`checkProductIdentity` 的 dev 分支；探针在 `active.stableTarget` 要求之前返回 dev）
- Create: `packages/cli/src/commands/doctor-dev-source.test.ts`（本 Task 与 Task 12 共用）

**Interfaces:**
- Consumes: Task 3 的 `devVersionLabel`、`RuntimeDevSource`；`runtimeReleaseIdV2`（Task 4 的 4 参数版）。
- Produces：`DoctorProductIdentity` 新变体
  ```ts
  { readonly state: 'dev'; readonly host: 'codex' | 'claude'; readonly runtimePluginVersion: string
    readonly runtimeReleaseId: string; readonly repoRealpath: string; readonly commit: string; readonly dirty: boolean }
  ```

- [ ] **Step 1: 写失败测试** `packages/cli/src/commands/doctor-dev-source.test.ts`（先写 identity 两条，Task 12 往同一文件追加）

```ts
import { describe, expect, test } from 'vitest'
import type { RuntimeInstaller } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { runtimeReleaseIdV2 } from '../runtime/release-store-codecs.js'
import type { RuntimeDevSource, RuntimeReleaseManifest } from '../runtime/types.js'
import { mockDoctorProbes } from '../test-support.js'
import { checkProductIdentity, createDoctorProductIdentityProbe } from './doctor-product-identity.js'

const DEV: RuntimeDevSource = {
  kind: 'dev', repoRealpath: '/work/tenon', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: true,
  worktreeDigest: 'b'.repeat(40), skillsIndexDigest: 'c'.repeat(40),
}
const SOURCE = { host: 'claude' as const, pluginVersion: '0.3.2' }
const DEV_MANIFEST: RuntimeReleaseManifest = {
  version: 2,
  releaseId: runtimeReleaseIdV2('d'.repeat(64), SOURCE, undefined, DEV),
  payloadDigest: 'd'.repeat(64),
  createdAt: '2026-10-07T00:00:00Z',
  source: SOURCE,
  devSource: DEV,
}

describe('identity:release for a development install', () => {
  test('is yellow, shows the +dev label and names both ways out', async () => {
    const check = await checkProductIdentity(mockDoctorProbes({
      productIdentity: async () => ({
        state: 'dev', host: 'claude', runtimePluginVersion: '0.3.2', runtimeReleaseId: DEV_MANIFEST.releaseId,
        repoRealpath: DEV.repoRealpath, commit: DEV.commit, dirty: true,
      }),
    }))
    expect(check.id).toBe('identity:release')
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('0.3.2+dev.abcdef0')
    expect(check.detail).toContain('/work/tenon')
    expect(check.hint).toContain('tenon setup --claude --from-source /work/tenon')
    expect(check.hint).toContain('tenon update --claude --to-stable')
  })

  test('the real probe reports dev from a development manifest without needing a stable target or the host', async () => {
    const homeDir = '/home/doctor-dev-test'
    const env = { PATH: '/trusted/bin' }
    const scope = { homeDir, env, paths: resolveRuntimePaths({ homeDir, env }) }
    const trusted = { executable: '/trusted/bin/x', requestedPath: '/trusted/bin/x', verify: () => true, assert: () => {}, proof: {} }
    const installer = {
      inspect: async () => ({
        selection: { version: 1, revision: 1, activeRelease: DEV_MANIFEST.releaseId, previousRelease: null, updatedAt: '2026-10-07T00:00:00Z' },
        active: DEV_MANIFEST, previous: null, activeValid: true, previousValid: false, lastAudit: null,
      }),
    } as unknown as RuntimeInstaller
    const unreachable = (): never => { throw new Error('the development branch must not touch the host, the payload or the dashboard') }
    const probe = createDoctorProductIdentityProbe(() => scope, installer, {
      resolveTrustedCommand: () => trusted,
      resolveHostCommand: unreachable,
      readText: unreachable,
      run: unreachable,
      inspectCandidate: unreachable,
      probeDashboard: unreachable,
    } as never)
    expect(await probe()).toEqual({
      state: 'dev', host: 'claude', runtimePluginVersion: '0.3.2', runtimeReleaseId: DEV_MANIFEST.releaseId,
      repoRealpath: '/work/tenon', commit: DEV.commit, dirty: true,
    })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/doctor-dev-source.test.ts`
Expected: FAIL（`state: 'dev'` 不在联合类型里；探针对没有 `stableTarget` 的 manifest 返回 `unavailable`）。

- [ ] **Step 3: 最小实现**

`deps.ts`：在 `DoctorProductIdentity` 联合的 `native` 与 `unavailable` 变体之间加

```ts
  | {
      readonly state: 'dev'
      readonly host: 'codex' | 'claude'
      readonly runtimePluginVersion: string
      readonly runtimeReleaseId: string
      /** 源码开发安装（tenon setup --from-source）绑定的仓库工作区与安装时的 HEAD。 */
      readonly repoRealpath: string
      readonly commit: string
      readonly dirty: boolean
    }
```

`doctor-product-identity.ts`：顶部导入加 `import { devVersionLabel } from '../runtime/dev-source-identity.js'`；在 `checkProductIdentity` 里 `const identity = await p.productIdentity({ verifyRemote })` 之后、`if (identity.state === 'unavailable')` 之前加

```ts
  if (identity.state === 'dev') {
    return yellow(
      'identity:release',
      `开发安装 ${devVersionLabel(identity.runtimePluginVersion, identity.commit)}（${identity.repoRealpath}`
        + `${identity.dirty ? '，安装时工作区有未提交改动' : ''}）；不是正式发布，没有稳定 tag 可核对`,
      `源码改动后重新同步：tenon setup --${identity.host} --from-source ${identity.repoRealpath}；`
        + `切回正式版：tenon update --${identity.host} --to-stable`,
    )
  }
```

在 `createDoctorProductIdentityProbe` 里 `if (active === null || (host !== 'codex' && host !== 'claude')) { return unavailableLocal(…) }` 之后、`if (active.version !== 2 || active.stableTarget === undefined)` 之前加

```ts
      if (active.version === 2 && active.devSource !== undefined) {
        return {
          state: 'dev',
          host,
          runtimePluginVersion: active.source.pluginVersion,
          runtimeReleaseId: active.releaseId,
          repoRealpath: active.devSource.repoRealpath,
          commit: active.devSource.commit,
          dirty: active.devSource.dirty,
        }
      }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/doctor-dev-source.test.ts packages/cli/src/commands/doctor-product-identity.test.ts packages/cli/src/commands/doctor.test.ts && npm run build:packages`
Expected: 全部 PASS（后两个文件回归保护）；`tsc -b` 无错误（若有对 `DoctorProductIdentity.state` 的穷举 switch，编译会指出，补上 dev 分支即可）。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deps.ts packages/cli/src/commands/doctor-product-identity.ts packages/cli/src/commands/doctor-dev-source.test.ts
git commit -m "feat(cli): report a development install as yellow in identity:release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `tenon doctor` 的 `source:drift`

**Files:**
- Create: `packages/cli/src/commands/doctor-source-drift.ts`
- Modify: `packages/cli/src/commands/doctor-dev-source.test.ts`（追加）
- Modify: `packages/cli/src/deps.ts`（`SourceDriftFacts`、`DoctorProbes.sourceDrift?`）
- Modify: `packages/cli/src/commands/doctor.ts:34`（导入）与 `:339-343` 之后（追加检查，「只增不改」放在 `runtime:launcher` 之后）
- Modify: `packages/cli/src/commands/doctor-probes.ts`（`stableLauncherFormat:` 之后装配真探针）
- Modify: `packages/cli/src/test-support.ts:429-440`（`mockDoctorProbes` 缺省 `sourceDrift`）
- Modify: `packages/cli/src/commands/doctor.test.ts`（`EXPECTED_IDS` 末尾加 `'source:drift'`；行 148、154、183、874 的 27 → 28）

**Interfaces:**
- Consumes: Task 3 的 `compareDevSource`、`computeDevSourceIdentity`、`checkTenonSourceRepo`、`realGitRun`、`GitRun`、`devVersionLabel`；测试支撑 `makeSourceRepo`。
- Produces：
  ```ts
  export type SourceDriftFacts =
    | { readonly state: 'not-source-repo' }
    | { readonly state: 'source-repo'; readonly repo: string
        readonly installed:
          | { readonly channel: 'dev'; readonly host: 'codex' | 'claude'; readonly releaseId: string; readonly devSource: RuntimeDevSource }
          | { readonly channel: 'stable'; readonly host: 'codex' | 'claude' | 'adapter' | 'manual'; readonly version: string }
          | null
        readonly live: RuntimeDevSource | { readonly error: string } }
  DoctorProbes.sourceDrift?: () => Promise<SourceDriftFacts>
  export async function checkSourceDrift(p: DoctorProbes): Promise<DoctorCheck>         // id 'source:drift'
  export async function collectSourceDriftFacts(input: { readonly cwd: string; readonly inspectActive: () => Promise<RuntimeReleaseManifest | null>; readonly git?: GitRun }): Promise<SourceDriftFacts>
  ```
- 与已定决定 3 的差异（规划核实记录第 7 项）：hook 直接精确比较，所以这里**不写 stateRoot 缓存**；doctor 是同一口径的完整比较与人读解释。

- [ ] **Step 1: 写失败测试**（追加到 `doctor-dev-source.test.ts`；文件顶部已有的 `vitest` 导入补上 `afterEach`，再加下面这些导入）

```ts
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeDevSourceIdentity } from '../runtime/dev-source-identity.js'
import {
  cleanupSourceRepoFixtures, makeSourceRepo, trackFixtureRoot,
} from '../runtime/dev-source-test-support.js'
import type { SourceDriftFacts } from '../deps.js'
import { checkSourceDrift, collectSourceDriftFacts } from './doctor-source-drift.js'

afterEach(cleanupSourceRepoFixtures)

function drift(facts: SourceDriftFacts) {
  return checkSourceDrift(mockDoctorProbes({ sourceDrift: async () => facts }))
}

describe('source:drift check', () => {
  test('outside a Tenon source repository it is green and says so', async () => {
    const check = await drift({ state: 'not-source-repo' })
    expect(check).toMatchObject({ id: 'source:drift', status: 'green' })
    expect(check.detail).toContain('不适用')
  })

  test('a source repository with no verified runtime is yellow and offers the install command', async () => {
    const check = await drift({ state: 'source-repo', repo: '/work/tenon', installed: null, live: DEV })
    expect(check.status).toBe('yellow')
    expect(check.hint).toContain('tenon setup --claude --from-source /work/tenon')
  })

  test('a stable install inside the source repository is yellow and uses the installed host in the command', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon', live: DEV,
      installed: { channel: 'stable', host: 'codex', version: '0.3.2' },
    })
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('正式版 0.3.2')
    expect(check.hint).toContain('tenon setup --codex --from-source /work/tenon')
  })

  test('an in-sync development install is green; commit and dirty alone are not drift', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon',
      installed: { channel: 'dev', host: 'claude', releaseId: DEV_MANIFEST.releaseId, devSource: DEV },
      live: { ...DEV, commit: 'f'.repeat(40), dirty: false },
    })
    expect(check.status).toBe('green')
  })

  test('a drifted development install is yellow, lists the reasons and offers the sync command', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon',
      installed: { channel: 'dev', host: 'claude', releaseId: DEV_MANIFEST.releaseId, devSource: DEV },
      live: { ...DEV, worktreeDigest: '1'.repeat(40) },
    })
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('安装内容已变')
    expect(check.hint).toContain('tenon setup --claude --from-source /work/tenon')
  })

  test('a live identity that cannot be computed is yellow, not red', async () => {
    const check = await drift({
      state: 'source-repo', repo: '/work/tenon',
      installed: { channel: 'dev', host: 'claude', releaseId: DEV_MANIFEST.releaseId, devSource: DEV },
      live: { error: 'git 不可用' },
    })
    expect(check.status).toBe('yellow')
    expect(check.detail).toContain('git 不可用')
  })

  test('a probe that was never wired is visible as yellow', async () => {
    const probes = mockDoctorProbes()
    const check = await checkSourceDrift({ ...probes, sourceDrift: undefined })
    expect(check.status).toBe('yellow')
  })
})

describe('collectSourceDriftFacts', () => {
  test('outside any git repository, and inside a git repository that is not a Tenon source repository, there is nothing to compare', async () => {
    const bare = trackFixtureRoot(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-drift-bare-'))))
    expect(await collectSourceDriftFacts({ cwd: bare, inspectActive: async () => null })).toEqual({ state: 'not-source-repo' })
    const notTenon = makeSourceRepo()
    rmSync(join(notTenon, 'runtime', 'tenon-bootstrap.mjs'))
    expect(await collectSourceDriftFacts({ cwd: notTenon, inspectActive: async () => null })).toEqual({ state: 'not-source-repo' })
  })

  test('from a sub directory of the source repository it resolves the repository root', async () => {
    const root = makeSourceRepo()
    const facts = await collectSourceDriftFacts({ cwd: join(root, 'hooks'), inspectActive: async () => null })
    expect(facts).toMatchObject({ state: 'source-repo', repo: root, installed: null })
    expect(facts.state === 'source-repo' && 'error' in facts.live).toBe(false)
  })

  test('an installed development source equal to the workspace is green, and goes yellow after an installed-content edit', async () => {
    const root = makeSourceRepo()
    const installedSource = computeDevSourceIdentity(root)
    const manifest: RuntimeReleaseManifest = {
      version: 2,
      releaseId: runtimeReleaseIdV2('d'.repeat(64), SOURCE, undefined, installedSource),
      payloadDigest: 'd'.repeat(64),
      createdAt: '2026-10-07T00:00:00Z',
      source: SOURCE,
      devSource: installedSource,
    }
    const check = async () => checkSourceDrift(mockDoctorProbes({
      sourceDrift: () => collectSourceDriftFacts({ cwd: root, inspectActive: async () => manifest }),
    }))
    expect((await check()).status).toBe('green')
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edited after install\n')
    const after = await check()
    expect(after.status).toBe('yellow')
    expect(after.detail).toContain('安装内容已变')
  })

  test('a stable manifest is reported as stable with its host and version', async () => {
    const root = makeSourceRepo()
    const stable: RuntimeReleaseManifest = {
      version: 2, releaseId: `sha256-${'e'.repeat(64)}`, payloadDigest: 'd'.repeat(64), createdAt: '2026-10-07T00:00:00Z',
      source: SOURCE, stableTarget: { version: '0.3.2', tag: 'v0.3.2', commit: 'a'.repeat(40) },
    }
    const facts = await collectSourceDriftFacts({ cwd: root, inspectActive: async () => stable })
    expect(facts).toMatchObject({ installed: { channel: 'stable', host: 'claude', version: '0.3.2' } })
  })
})
```

`doctor.test.ts`：`EXPECTED_IDS` 末尾（`'runtime:launcher'` 之后）加 `'source:drift'`；第 148 行标题与第 154 行 `绿 27`、第 183 行与第 874 行的 `green: 27` 都改成 28（先 `npx vitest run packages/cli/src/commands/doctor.test.ts` 看哪些断言报错，按报错逐处改，不要凭记忆改）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/commands/doctor-dev-source.test.ts packages/cli/src/commands/doctor.test.ts`
Expected: FAIL（`Cannot find module './doctor-source-drift.js'`；`doctor.test.ts` 的 `EXPECTED_IDS` 比实际多一项）。

- [ ] **Step 3: 最小实现**

`deps.ts`：在 `DoctorProductIdentity` 之后加 `SourceDriftFacts`（见 Interfaces；用 `import('./runtime/types.js').RuntimeDevSource` 的内联类型导入，与文件里 `import('@tenon/kernel')` 的写法一致），并在 `DoctorProbes` 里 `stableLauncherFormat?` 之后加

```ts
  /**
   * 源码仓库漂移事实：cwd 是否在 Tenon 源码仓库、已装 runtime 的渠道、仓库工作区的当前身份。
   * 缺省 undefined = 未装配 → source:drift 折算 yellow（探针缺口可见）。
   */
  sourceDrift?: () => Promise<SourceDriftFacts>
```

`packages/cli/src/commands/doctor-source-drift.ts`：

```ts
import { realpathSync } from 'node:fs'
import type { DoctorProbes, SourceDriftFacts } from '../deps.js'
import {
  checkTenonSourceRepo, compareDevSource, computeDevSourceIdentity, realGitRun, type GitRun,
} from '../runtime/dev-source-identity.js'
import type { RuntimeReleaseManifest } from '../runtime/types.js'
import { green, yellow, type DoctorCheck } from './doctor-check.js'

const ID = 'source:drift'

/** 收集事实：不在 Tenon 源码仓库就什么都不算；在的话读 active release 的渠道并重算工作区身份。 */
export async function collectSourceDriftFacts(input: {
  readonly cwd: string
  readonly inspectActive: () => Promise<RuntimeReleaseManifest | null>
  readonly git?: GitRun
}): Promise<SourceDriftFacts> {
  const git = input.git ?? realGitRun
  let top: string
  try {
    top = realpathSync(git(input.cwd, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return { state: 'not-source-repo' }
  }
  if (!checkTenonSourceRepo(top).ok) return { state: 'not-source-repo' }
  const active = await input.inspectActive()
  let live: ReturnType<typeof computeDevSourceIdentity> | { readonly error: string }
  try {
    live = computeDevSourceIdentity(top, git)
  } catch (error) {
    live = { error: error instanceof Error ? error.message : String(error) }
  }
  if (active === null) return { state: 'source-repo', repo: top, installed: null, live }
  if (active.version === 2 && active.devSource !== undefined) {
    return {
      state: 'source-repo',
      repo: top,
      installed: {
        channel: 'dev',
        host: active.source.host === 'codex' ? 'codex' : 'claude',
        releaseId: active.releaseId,
        devSource: active.devSource,
      },
      live,
    }
  }
  return {
    state: 'source-repo',
    repo: top,
    installed: { channel: 'stable', host: active.source.host, version: active.source.pluginVersion },
    live,
  }
}

export async function checkSourceDrift(p: DoctorProbes): Promise<DoctorCheck> {
  if (p.sourceDrift === undefined) {
    return yellow(ID, '源码漂移探针未装配', '这是 main.ts 集成缺口：无法判断已装版本与源码仓库是否一致')
  }
  const facts = await p.sourceDrift()
  if (facts.state === 'not-source-repo') return green(ID, '当前目录不在 Tenon 源码仓库，不适用')
  const command = (host: string): string => `tenon setup --${host === 'codex' ? 'codex' : 'claude'} --from-source ${facts.repo}`
  if (facts.installed === null) {
    return yellow(
      ID,
      `在 Tenon 源码仓库 ${facts.repo} 里，但没有可验证的 managed runtime`,
      `${command('claude')}（用 Codex 时把 --claude 换成 --codex）`,
    )
  }
  if (facts.installed.channel === 'stable') {
    return yellow(
      ID,
      `在 Tenon 源码仓库 ${facts.repo} 里，已装的是正式版 ${facts.installed.version}：技能、hooks 与 CLI 不是仓库源码`,
      command(facts.installed.host),
    )
  }
  if ('error' in facts.live) {
    return yellow(ID, `无法计算仓库当前身份：${facts.live.error}`, '检查 git 与仓库状态后重跑 tenon doctor')
  }
  const reasons = compareDevSource(facts.installed.devSource, facts.live)
  if (reasons.length === 0) {
    return green(
      ID,
      `开发安装与仓库工作区一致（commit ${facts.installed.devSource.commit.slice(0, 7)}`
        + `${facts.installed.devSource.dirty ? '，安装时工作区有未提交改动' : ''}）`,
    )
  }
  return yellow(
    ID,
    `已装的开发安装与仓库工作区不一致：${reasons.join('；')}`,
    command(facts.installed.host),
  )
}
```

`doctor.ts`：导入加 `import { checkSourceDrift } from './doctor-source-drift.js'`；在 `checkStableLauncher` 的 try 块（行 339-343）之后加

```ts
  try {
    checks.push(await checkSourceDrift(p))
  } catch (e) {
    checks.push(red('source:drift', `检查自身异常: ${errMsg(e)}`, '排除探针环境问题后重跑 tenon doctor'))
  }
```

`doctor-probes.ts`：在 `stableLauncherFormat: () => inspectStableLauncherFormat(runtimeScope().homeDir),` 之后加

```ts
    sourceDrift: () => collectSourceDriftFacts({
      cwd: process.cwd(),
      inspectActive: async () => {
        const inspection = await REAL_RUNTIME_INSTALLER.inspect(runtimeInstallerScope())
        return inspection.activeValid ? inspection.active : null
      },
    }),
```

并导入 `import { collectSourceDriftFacts } from './doctor-source-drift.js'`。

`test-support.ts` 的 `mockDoctorProbes`（`stableLauncherFormat: async () => 'current' as const,` 之后）加

```ts
    // 缺省不在 Tenon 源码仓库：source:drift 为绿（不适用），全绿基线不受影响。
    sourceDrift: async () => ({ state: 'not-source-repo' as const }),
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/commands/doctor-dev-source.test.ts packages/cli/src/commands/doctor.test.ts packages/cli/src/commands/doctor-probes.test.ts && npm run build:packages`
Expected: 全部 PASS；`tsc -b` 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor-source-drift.ts packages/cli/src/commands/doctor-dev-source.test.ts packages/cli/src/deps.ts packages/cli/src/commands/doctor.ts packages/cli/src/commands/doctor-probes.ts packages/cli/src/test-support.ts packages/cli/src/commands/doctor.test.ts
git commit -m "feat(cli): add the source:drift doctor check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `/api/health` 的 `channel`、短 commit 与版本徽标串

**Files:**
- Modify: `packages/server/src/version.ts`（加 `ReleaseChannel`、`resolveReleaseChannel`、`displayVersion`）
- Modify: `packages/server/src/types.ts:249-262`（`HealthInfo` 加三个可选字段）与 `DashboardServerOptions`（`releaseId?: string` 之后，行 275-277 附近加 `channel?`）
- Modify: `packages/server/src/serverGetActivityRoutes.ts:15-34`（health 路由从 `deps.options.channel` 读渠道；`GetRouteDeps` 本来就带着整份 `options: DashboardServerOptions`（`serverGetRoutes.ts:110`），所以 `server.ts` 与 `serverGetRoutes.ts` 都不用动）、`packages/server/src/main.ts:85,139`（解析渠道并传给 `createDashboardServer`）
- Modify（测试）: `packages/server/src/version.test.ts`、`packages/server/src/server.test.ts`（`start` 的选项类型与 `createTestDashboardServer` 调用；`GET /api/health` 的 `describe` 里追加用例）

**Interfaces:**
- Consumes: 托管 payload 的兄弟文件 `<releaseRoot>/release.json`（Task 4 写入的 manifest，`devSource.commit`）。
- Produces：
  ```ts
  export interface ReleaseChannel { readonly kind: 'dev'; readonly commit: string }
  export function resolveReleaseChannel(pluginRoot: string): ReleaseChannel | undefined
  export function displayVersion(version: string, channel: ReleaseChannel | undefined): string
  // /api/health 新字段
  { channel: 'stable' | 'dev'; commit?: string /* 7 位，仅 dev */; displayVersion?: string /* `<version>+dev.<sha7>`，仅 dev */ }
  ```
  `version` 字段（即 `serverVersion`）不变；Dashboard SPA 不改（规划核实记录第 10 项）。

- [ ] **Step 1: 写失败测试**

`version.test.ts` 追加（导入补 `resolveReleaseChannel, displayVersion`）：

```ts
describe('resolveReleaseChannel', () => {
  const releaseId = `sha256-${'a'.repeat(64)}`

  async function payloadWithManifest(manifest: unknown): Promise<string> {
    const release = await mkdtemp(join(tmpdir(), 'pipeline-release-channel-'))
    const payload = join(release, 'payload')
    await mkdir(payload, { recursive: true })
    await writeFile(join(release, 'release.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
    return payload
  }

  test('a managed payload whose release.json carries devSource is a dev channel with its commit', async () => {
    const payload = await payloadWithManifest({
      version: 2, releaseId, devSource: { kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' },
    })
    expect(resolveReleaseChannel(payload)).toEqual({ kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' })
  })

  test('a stable manifest, a damaged one, a bad commit and a non-payload root are all just stable', async () => {
    expect(resolveReleaseChannel(await payloadWithManifest({ version: 2, releaseId }))).toBeUndefined()
    expect(resolveReleaseChannel(await payloadWithManifest('{ bad json'))).toBeUndefined()
    expect(resolveReleaseChannel(await payloadWithManifest({ devSource: { kind: 'dev', commit: 'xyz' } }))).toBeUndefined()
    expect(resolveReleaseChannel('/workspace/tenon')).toBeUndefined()
  })
})

describe('displayVersion', () => {
  test('appends +dev.<sha7> for a dev channel and leaves a stable version alone', () => {
    expect(displayVersion('0.3.2', { kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' })).toBe('0.3.2+dev.abcdef0')
    expect(displayVersion('0.3.2', undefined)).toBe('0.3.2')
  })
})
```

`server.test.ts`：给 `start(opts?: {…})` 的选项类型加 `channel?: DashboardServerOptions['channel']`，并在 `createTestDashboardServer({…})` 调用里（`transactionId: opts?.transactionId,` 之后）加 `...(opts?.channel === undefined ? {} : { channel: opts.channel }),`；在 `describe('GET /api/health —— 存活探针 + 本 server 版本（B4）')` 里追加：

```ts
  it('开发安装回显 channel=dev、7 位 commit 与 +dev 版本徽标，version 字段本身不变', async () => {
    const h = await start({ version: '3.1.4', channel: { kind: 'dev', commit: 'abcdef0123456789abcdef0123456789abcdef01' } })
    const body = (await reqGet(h.port, '/api/health')).json<{
      version: string; channel?: string; commit?: string; displayVersion?: string
    }>()
    expect(body.version).toBe('3.1.4')
    expect(body.channel).toBe('dev')
    expect(body.commit).toBe('abcdef0')
    expect(body.displayVersion).toBe('3.1.4+dev.abcdef0')
  })

  it('正式安装回显 channel=stable，不带 commit 与徽标串', async () => {
    const h = await start({ version: '3.1.4' })
    const body = (await reqGet(h.port, '/api/health')).json<{ channel?: string; commit?: string; displayVersion?: string }>()
    expect(body.channel).toBe('stable')
    expect(body.commit).toBeUndefined()
    expect(body.displayVersion).toBeUndefined()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/server/src/version.test.ts packages/server/src/server.test.ts -t "resolveReleaseChannel|displayVersion|GET /api/health"`
Expected: FAIL（导出不存在；health 没有 `channel`）。

- [ ] **Step 3: 最小实现**

`version.ts` 末尾加：

```ts
const DEV_COMMIT = /^[0-9a-f]{40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ReleaseChannel {
  readonly kind: 'dev'
  readonly commit: string
}

/**
 * 托管 payload 的兄弟文件 release.json 带 devSource 时，这是一份源码开发安装（tenon setup --from-source）。
 * 读不到或不合规一律按正式版处理：channel 只是 health 上的标注，不参与版本抢占。
 */
export function resolveReleaseChannel(pluginRoot: string): ReleaseChannel | undefined {
  if (basename(pluginRoot) !== 'payload') return undefined
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(pluginRoot), 'release.json'), 'utf8'))
    if (!isRecord(manifest) || !isRecord(manifest.devSource)) return undefined
    const { kind, commit } = manifest.devSource
    return kind === 'dev' && typeof commit === 'string' && DEV_COMMIT.test(commit)
      ? { kind: 'dev', commit }
      : undefined
  } catch {
    return undefined
  }
}

/** 版本徽标：开发安装是 `<version>+dev.<sha7>`，正式版就是 version 本身。 */
export function displayVersion(version: string, channel: ReleaseChannel | undefined): string {
  return channel === undefined ? version : `${version}+dev.${channel.commit.slice(0, 7)}`
}
```

`types.ts`：`HealthInfo` 的 `transactionId?` 之后加

```ts
  /** 发布渠道：正式发布为 stable；tenon setup --from-source 的源码开发安装为 dev。 */
  channel?: 'stable' | 'dev'
  /** 开发安装的 7 位 commit。 */
  commit?: string
  /** 版本徽标：开发安装为 `<version>+dev.<sha7>`；`version` 字段本身不变。 */
  displayVersion?: string
```

`DashboardServerOptions` 的 `releaseId?: string` 之后加 `channel?: import('./version.js').ReleaseChannel`。

`serverGetActivityRoutes.ts`：导入 `import { displayVersion } from './version.js'`；health 路由（`if (path === '/api/health') {`，行 25-34）里先取 `const channel = deps.options.channel`，响应改成

```ts
      const channel = deps.options.channel
      return sendJson(res, 200, {
        ok: true,
        scope: 'global',
        version,
        ...(releaseId === undefined ? {} : { releaseId }),
        ...(transactionId === undefined ? {} : { transactionId }),
        channel: channel === undefined ? 'stable' : 'dev',
        ...(channel === undefined
          ? {}
          : { commit: channel.commit.slice(0, 7), displayVersion: displayVersion(version, channel) }),
        stateScopeId,
        pid: process.pid,
      })
```

`main.ts`：导入加 `resolveReleaseChannel`；行 85 之后加 `const channel = resolveReleaseChannel(root)`；传给 `createDashboardServer` 的选项里 `releaseId,`（行 139）之后加 `...(channel === undefined ? {} : { channel }),`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/server && npm run build:packages`
Expected: 全部 PASS（整个 server 包回归；若有测试对 health 响应体做整体 `toEqual`，按报错把 `channel: 'stable'` 补进期望）；`tsc -b` 无错误。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/version.ts packages/server/src/version.test.ts packages/server/src/types.ts packages/server/src/server.test.ts packages/server/src/serverGetActivityRoutes.ts packages/server/src/main.ts
git commit -m "feat(server): report the release channel, short commit and +dev version label on /api/health

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: SessionStart 的纯 bash 漂移提示（`hooks/source-drift.sh`）与 `auto-update.sh` 守卫

> **顺序约束：** 本 Task 改 `hooks/session-start.sh` 与 `tools/test-hooks.sh`，两者与 A 部分（`docs/superpowers/plans/fix-hook-cross-session-isolation.md`）共用。必须等 A 部分的 hook Task 合入当前分支之后再做；开工前先 `git log -- hooks/session-start.sh tools/test-hooks.sh` 与 `git status` 确认 A 部分已落地，在它的基础上编辑，不得覆盖 A 部分的改动。`hooks/source-drift.sh` 是新文件，不受此限，但它的集成测试要等 session-start 接线之后才完整。

**Files:**
- Create: `hooks/source-drift.sh`
- Modify: `hooks/session-start.sh`（在「简短引导」之后、「注入①」之前接线；约行 171-176 之间）
- Modify: `hooks/auto-update.sh`（`CONFIG_BASE` 算出之后、读 `auto-update.conf` 之前加 dev 标记守卫；行 25-26 之间）
- Modify: `tools/test-hooks.sh`（在 `§13 打包插件自动更新` 小节末尾之后、`# ── 13. 多用户` 小节之前插入新的 `§14`；复用 §13 里的 `AU`、`AU_BIN`、`AU_ROOT`、`AU_TRACE` 变量）
- Create: `packages/cli/src/runtime/source-drift-hook.test.ts`（Node 与 bash 口径的交叉验证）

**Interfaces:**
- Consumes: Task 3 的口径（`worktreeDigest`、`skillsIndexDigest`、`install-channel` 键名）；`TENON_RUNTIME_CONFIG_ROOT`、`TENON_ACTIVE_RELEASE_ID`（稳定 launcher / bootstrap 导出，`session-start.sh` 已在读后者）。
- Produces（bash，被 `session-start.sh` source）：
  ```bash
  PIPELINE_SOURCE_DRIFT_PATHSPECS=( … )                 # 与 PAYLOAD_ENTRIES 相同
  pipeline_source_is_tenon_repo <repo-root>             # 0 = 四项判据满足
  pipeline_source_worktree_digest <repo-root>           # stdout: 40 位十六进制；失败返回非 0
  pipeline_source_skills_digest <repo-root>             # stdout: 40 位十六进制或 absent
  pipeline_source_drift_message <cwd> <active-release-id>   # stdout: 提示文本，无提示则为空；恒 return 0
  ```

- [ ] **Step 1: 写失败测试**

`packages/cli/src/runtime/source-drift-hook.test.ts`：

```ts
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { checkTenonSourceRepo, computeDevSourceIdentity, DEV_PAYLOAD_PATHSPECS } from './dev-source-identity.js'
import { cleanupSourceRepoFixtures, gitIn, makeSourceRepo, writeFixtureFile } from './dev-source-test-support.js'

afterEach(cleanupSourceRepoFixtures)

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'hooks', 'source-drift.sh')

/** source 钩子文件后调用其中一个函数；参数以位置参数传入，免去引号转义。 */
function bashFunction(fn: string, ...args: string[]): string {
  const result = spawnSync('bash', ['-c', `. "$1"; shift; ${fn} "$@"`, 'bash', hook, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

describe('hooks/source-drift.sh stays in lock step with the Node identity', () => {
  test('it enumerates exactly the managed payload entries', () => {
    const block = /PIPELINE_SOURCE_DRIFT_PATHSPECS=\(\n([\s\S]*?)\n\)/u.exec(readFileSync(hook, 'utf8'))
    expect(block).not.toBeNull()
    const listed = (block?.[1] ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
    expect(listed).toEqual([...DEV_PAYLOAD_PATHSPECS])
  })

  test('bash and Node compute identical digests through edits, new files, staging, commits and deletions', () => {
    const root = makeSourceRepo()
    const compare = (label: string): void => {
      const node = computeDevSourceIdentity(root)
      expect({ label, worktree: bashFunction('pipeline_source_worktree_digest', root) })
        .toEqual({ label, worktree: node.worktreeDigest })
      expect({ label, skills: bashFunction('pipeline_source_skills_digest', root) })
        .toEqual({ label, skills: node.skillsIndexDigest })
    }
    compare('clean')
    appendFileSync(join(root, 'hooks', 'gate.sh'), '# edit\n')
    compare('edited')
    writeFixtureFile(root, 'templates/new.md', 'new\n')
    compare('untracked file')
    gitIn(root, ['add', '-A'])
    compare('staged')
    gitIn(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'more'])
    compare('committed')
    rmSync(join(root, 'hooks', 'gate.sh'))
    compare('deleted tracked file')
    appendFileSync(join(root, 'skills', 'skills.lock.json'), '\n')
    appendFileSync(join(root, 'skills', 'ignored-skill', 'SKILL.md'), 'x\n')
    appendFileSync(join(root, 'docs', 'readme.md'), 'x\n')
    compare('changes outside the digest scope')
    rmSync(join(root, 'skills', 'skills.lock.json'))
    compare('index removed')
  })

  test('bash and Node agree on the four source-repository criteria', () => {
    const damages: Array<[string, (root: string) => void]> = [
      ['intact', () => undefined],
      ['package name', (root) => writeFixtureFile(root, 'package.json', JSON.stringify({ name: 'other' }))],
      ['marketplace name', (root) => writeFixtureFile(root, '.claude-plugin/marketplace.json',
        JSON.stringify({ name: 'other', plugins: [{ name: 'tenon', source: './' }] }))],
      ['plugin source', (root) => writeFixtureFile(root, '.claude-plugin/marketplace.json',
        JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon', source: './sub' }] }))],
      ['sources.yaml', (root) => rmSync(join(root, 'skills', 'sources.yaml'))],
      ['bootstrap', (root) => rmSync(join(root, 'runtime', 'tenon-bootstrap.mjs'))],
    ]
    for (const [label, damage] of damages) {
      const root = makeSourceRepo({ commit: false })
      damage(root)
      const bash = spawnSync('bash', ['-c', '. "$1"; pipeline_source_is_tenon_repo "$2"', 'bash', hook, root]).status === 0
      expect({ label, bash }).toEqual({ label, bash: checkTenonSourceRepo(root).ok })
    }
  })
})
```

`tools/test-hooks.sh` 新 §14（插入位置见 Files）：

```bash
# ═════════════════════════════ 14. 源码仓库漂移提示（hooks/source-drift.sh） ═════════════════════════════
# 真实 git 夹具 + 隔离的配置目录，不碰真实 HOME。提示函数在子 shell 里 source，stdout 即提示文本。
SD="$ROOT/hooks/source-drift.sh"
SD_DIR="$TMP/source-drift"
SD_REPO="$SD_DIR/repo"
SD_CFG="$SD_DIR/cfg"
SD_REL="sha256-$(printf 'a%.0s' {1..64})"
SD_REL_OTHER="sha256-$(printf 'b%.0s' {1..64})"
sd_git() { env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$SD_REPO" "$@"; }
sd_make_repo() { # 满足四项判据 + 安装内容 + 被忽略的上游技能与本机索引
  rm -rf "$SD_REPO" "$SD_CFG"
  mkdir -p "$SD_REPO/.claude-plugin" "$SD_REPO/skills/tenon" "$SD_REPO/skills/ignored-skill" \
    "$SD_REPO/runtime" "$SD_REPO/hooks" "$SD_REPO/templates" "$SD_REPO/docs" "$SD_CFG"
  printf '{"name":"tenon","version":"0.3.2"}\n' > "$SD_REPO/package.json"
  printf '{"name":"tenon","plugins":[{"name":"tenon","source":"./"}]}\n' > "$SD_REPO/.claude-plugin/marketplace.json"
  printf '{"name":"tenon","version":"0.3.2"}\n' > "$SD_REPO/.claude-plugin/plugin.json"
  printf 'version: 1\nskills:\n' > "$SD_REPO/skills/sources.yaml"
  printf 'tenon\n' > "$SD_REPO/skills/tenon/SKILL.md"
  printf 'ignored\n' > "$SD_REPO/skills/ignored-skill/SKILL.md"
  printf '{"version":1}\n' > "$SD_REPO/skills/skills.lock.json"
  printf '// bootstrap\n' > "$SD_REPO/runtime/tenon-bootstrap.mjs"
  printf '#!/usr/bin/env bash\n' > "$SD_REPO/hooks/gate.sh"
  printf 'workflow\n' > "$SD_REPO/templates/workflow.md"
  printf 'docs\n' > "$SD_REPO/docs/readme.md"
  printf '/skills/*\n!/skills/tenon/\n!/skills/sources.yaml\n' > "$SD_REPO/.gitignore"
  sd_git init -q -b main
  sd_git config user.email t@example.invalid
  sd_git config user.name t
  sd_git add -A
  sd_git -c commit.gpgsign=false commit -qm init
}
sd_digest() { ( . "$SD"; pipeline_source_worktree_digest "$SD_REPO" ); }
sd_skills() { ( . "$SD"; pipeline_source_skills_digest "$SD_REPO" ); }
sd_write_marker() { # $1=host $2=release id $3=repo（缺省 $SD_REPO）：按当前工作区写一份开发标记
  printf 'channel=dev\nhost=%s\nrelease_id=%s\ninstalled_at=2026-10-07T00:00:00Z\nrepo=%s\ncommit=%s\ndirty=false\nworktree_digest=%s\nskills_index_digest=%s\n' \
    "$1" "$2" "${3:-$SD_REPO}" "$(sd_git rev-parse HEAD)" "$(sd_digest)" "$(sd_skills)" > "$SD_CFG/install-channel"
}
sd_message() { # $1=cwd $2=当前 active release id
  ( export TENON_RUNTIME_CONFIG_ROOT="$SD_CFG"; . "$SD"; pipeline_source_drift_message "$1" "$2" )
}

sd_make_repo
out="$(sd_message "$SD_REPO" "$SD_REL")"
assert_contains "source-drift: 没有标记 → 给出 --from-source 同步命令" "$out" "tenon setup --claude --from-source $SD_REPO"
assert_contains "source-drift: 没有标记 → 说明已装的是正式版" "$out" "正式版"

sd_write_marker claude "$SD_REL"
assert_empty "source-drift: 标记与工作区一致 → 零输出" "$(sd_message "$SD_REPO" "$SD_REL")"
assert_empty "source-drift: 在仓库子目录里同样一致" "$(sd_message "$SD_REPO/hooks" "$SD_REL")"

printf '# edit\n' >> "$SD_REPO/hooks/gate.sh"
out="$(sd_message "$SD_REPO" "$SD_REL")"
assert_contains "source-drift: 安装内容改了 → 提示并给出同步命令" "$out" "tenon setup --claude --from-source $SD_REPO"
assert_contains "source-drift: 说明是安装内容变了" "$out" "安装内容已变"

sd_write_marker claude "$SD_REL"
sd_git add -A
sd_git -c commit.gpgsign=false commit -qm "commit the installed edit"
assert_empty "source-drift: 提交已装的改动后零输出（commit 变了但安装内容没变）" "$(sd_message "$SD_REPO" "$SD_REL")"

printf 'more docs\n' >> "$SD_REPO/docs/readme.md"
assert_empty "source-drift: 只改了安装范围外的文档 → 零输出" "$(sd_message "$SD_REPO" "$SD_REL")"

printf 'new\n' > "$SD_REPO/templates/new.md"
assert_contains "source-drift: 安装范围里新增未跟踪文件 → 提示" "$(sd_message "$SD_REPO" "$SD_REL")" "安装内容已变"
rm -f "$SD_REPO/templates/new.md"
assert_empty "source-drift: 删掉新增文件后恢复零输出" "$(sd_message "$SD_REPO" "$SD_REL")"

printf '\n' >> "$SD_REPO/skills/skills.lock.json"
assert_contains "source-drift: 本机技能索引变了 → 提示" "$(sd_message "$SD_REPO" "$SD_REL")" "技能索引已变"
printf '{"version":1}\n' > "$SD_REPO/skills/skills.lock.json"
assert_empty "source-drift: 技能索引还原后零输出" "$(sd_message "$SD_REPO" "$SD_REL")"

out="$(sd_message "$SD_REPO" "$SD_REL_OTHER")"
assert_contains "source-drift: 标记的 release 与当前 active 不一致（回滚/重装后陈旧）→ 按正式版提示" "$out" "正式版"

sd_write_marker claude "$SD_REL" /elsewhere/tenon
assert_contains "source-drift: 标记绑定的是另一个仓库 → 提示" "$(sd_message "$SD_REPO" "$SD_REL")" "另一个仓库"

printf 'garbage\n' > "$SD_CFG/install-channel"
out="$(sd_message "$SD_REPO" "$SD_REL")"
assert_contains "source-drift: 标记损坏 → 按没有标记处理，不报错" "$out" "--from-source"

sd_write_marker claude "$SD_REL"
printf '{"name":"other"}\n' > "$SD_REPO/package.json"
assert_empty "source-drift: 根 package.json 不是 tenon → 不是源码仓库，零输出" "$(sd_message "$SD_REPO" "$SD_REL")"
printf '{"name":"tenon","version":"0.3.2"}\n' > "$SD_REPO/package.json"

out="$( export PATH=/nonexistent; /bin/bash -c '. "$1"; pipeline_source_drift_message "$2" ""' x "$SD" "$SD_REPO" )"
rc=$?
assert_exit "source-drift: 没有 git → exit 0" 0 "$rc"
assert_empty "source-drift: 没有 git → 零输出（fail-open）" "$out"
assert_empty "source-drift: 不在任何 git 仓库里 → 零输出" "$(sd_message "$TMP" "$SD_REL")"

# session-start 端到端：漂移提示进入会话上下文；非源码仓库的会话不出现它。
printf '# drift again\n' >> "$SD_REPO/hooks/gate.sh"
out="$(printf '{"cwd":"%s"}' "$SD_REPO" | TENON_SESSION_START_FORMAT=plain TENON_RUNTIME_CONFIG_ROOT="$SD_CFG" TENON_ACTIVE_RELEASE_ID="$SD_REL" bash "$SS" 2>/dev/null)"
assert_contains "source-drift: session-start 把漂移提示放进会话上下文" "$out" "tenon setup --claude --from-source $SD_REPO"
out="$(printf '{"cwd":"%s"}' "$TMP" | TENON_SESSION_START_FORMAT=plain TENON_RUNTIME_CONFIG_ROOT="$SD_CFG" TENON_ACTIVE_RELEASE_ID="$SD_REL" bash "$SS" 2>/dev/null)"
assert_not_contains "source-drift: 非 Tenon 源码仓库的会话不出现源码仓库提示" "$out" "--from-source"

# 红线：新 hook 文件不引入任何解释器 / jq（session-start.sh 本体由 §3、§12h 覆盖）。
for tool in node python jq; do
  n="$(grep -c "$tool" "$SD" || true)"
  [ "$n" = "0" ] && ok "红线: source-drift.sh 内无 ${tool}" || bad "红线: source-drift.sh 内无 ${tool}" "实得 ${n} 行"
done

# auto-update.sh：开发安装的标记让它直接退出，标记陈旧（release 对不上）时照常更新。
sd_make_repo
sd_write_marker claude "$SD_REL"
printf 'host=claude\nenabled=true\n' > "$SD_CFG/auto-update.conf"
rm -f "$AU_TRACE"
PATH="$AU_BIN:$PATH" TENON_STABLE_BIN="$AU_BIN/tenon" TENON_RUNTIME_CONFIG_ROOT="$SD_CFG" TENON_ACTIVE_RELEASE_ID="$SD_REL" AUTO_UPDATE_TRACE="$AU_TRACE" bash "$AU" "$AU_ROOT" >/dev/null 2>&1
assert_exit "auto-update: 开发标记 + 同一 release → exit 0" 0 "$?"
sleep 0.3
[ ! -f "$AU_TRACE" ] && ok "auto-update: 开发安装不启动后台更新" || bad "auto-update: 开发安装不启动后台更新" "意外调用了 nohup"
PATH="$AU_BIN:$PATH" TENON_STABLE_BIN="$AU_BIN/tenon" TENON_RUNTIME_CONFIG_ROOT="$SD_CFG" TENON_ACTIVE_RELEASE_ID="$SD_REL_OTHER" AUTO_UPDATE_TRACE="$AU_TRACE" bash "$AU" "$AU_ROOT" >/dev/null 2>&1
for _i in {1..40}; do [ -f "$AU_TRACE" ] && break; sleep 0.05; done
assert_contains "auto-update: 标记陈旧（active release 已不是开发那份）→ 照常后台更新" "$(cat "$AU_TRACE" 2>/dev/null || true)" "update --claude --yes --auto"
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/cli/src/runtime/source-drift-hook.test.ts && bash tools/test-hooks.sh 2>&1 | tail -40`
Expected: vitest FAIL（`hooks/source-drift.sh` 不存在：`readFileSync` ENOENT）；`test-hooks.sh` 的 §14 各用例 FAIL（`. "$SD"` 失败、函数不存在），其余小节仍 PASS。

- [ ] **Step 3: 最小实现**

`hooks/source-drift.sh`（644 即可，同 `json-input.sh`；只被 source，不直接执行）：

```bash
#!/usr/bin/env bash
# source-drift.sh — SessionStart 助手：在 Tenon 源码仓库里比较「已装」与「仓库工作区」，
# 不一致时给出同步命令。
#
# 被 session-start.sh source，只定义函数，不产生副作用、不 exit。纯 bash + git：不 spawn 任何解释器
# （tools/test-hooks.sh §3 红线）；任何失败一律返回空（fail-open，绝不阻断会话）。
#
# 比较口径与 packages/cli/src/runtime/dev-source-identity.ts 逐字一致（source-drift-hook.test.ts 交叉验证）：
#   worktree_digest：路径集合 = git ls-files -z --cached --others --exclude-standard -- <PATHSPECS> 去重、
#     只留普通文件、按字节序排序；每行 "<blob> <path>\n"，blob = 工作区原始字节的 git blob id
#     （git hash-object --no-filters：.gitattributes 的 skills/** eol=lf 会让带过滤器的哈希与原始字节不一致）；
#     整体再取 git blob id（git hash-object --stdin）。
#   skills_index_digest：skills/skills.lock.json 原始字节的 git blob id，缺文件为 absent。
#   commit 只在提示里展示，不是判据：提交文档类改动不应触发提示。
# 标记文件：<config 根>/install-channel（tenon setup --from-source 写入；正式安装 / --to-stable 删除）。

# 必须与 packages/cli/src/runtime/release-store-codecs.ts 的 PAYLOAD_ENTRIES 相同（逐行，顺序一致）。
PIPELINE_SOURCE_DRIFT_PATHSPECS=(
  .agents/plugins/marketplace.json
  .claude-plugin/marketplace.json
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  adapters
  hooks
  packages/cli/dist/tenon.mjs
  packages/dashboard-app/dist
  packages/server/dist/dashboard.mjs
  runtime/tenon-bootstrap.mjs
  skills
  templates
  tools/verify-skills.sh
)

_pipeline_source_first_name() { # $1=JSON 文件 → 第一个 "name" 的值
  grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -n 1 \
    | sed -e 's/^"name"[[:space:]]*:[[:space:]]*"//' -e 's/"$//'
}

# 四项判据（Node 端是严格 JSON 判定，这里是 grep 近似；两者在 source-drift-hook.test.ts 里对拍）。
pipeline_source_is_tenon_repo() { # $1=仓库根
  local root="$1"
  [ -f "$root/package.json" ] && [ -f "$root/.claude-plugin/marketplace.json" ] || return 1
  [ -f "$root/skills/sources.yaml" ] && [ -f "$root/runtime/tenon-bootstrap.mjs" ] || return 1
  [ "$(_pipeline_source_first_name "$root/package.json")" = "tenon" ] || return 1
  [ "$(_pipeline_source_first_name "$root/.claude-plugin/marketplace.json")" = "tenon" ] || return 1
  grep -Eq '"source"[[:space:]]*:[[:space:]]*"\./"' "$root/.claude-plugin/marketplace.json" 2>/dev/null || return 1
  return 0
}

pipeline_source_worktree_digest() { # $1=仓库根 → stdout 摘要；失败返回非 0
  local root="$1" path ids id sorted manifest="" index=0
  local -a listed=() files=() id_list=()
  while IFS= read -r path; do
    [ -n "$path" ] && [ -f "$root/$path" ] && listed+=("$path")
  done < <(git -C "$root" ls-files -z --cached --others --exclude-standard -- "${PIPELINE_SOURCE_DRIFT_PATHSPECS[@]}" 2>/dev/null | tr '\0' '\n')
  [ "${#listed[@]}" -gt 0 ] || return 1
  sorted="$(printf '%s\n' "${listed[@]}" | LC_ALL=C sort -u)"
  while IFS= read -r path; do files+=("$path"); done <<< "$sorted"
  ids="$(printf '%s\n' "${files[@]}" | git -C "$root" hash-object --no-filters --stdin-paths 2>/dev/null)" || return 1
  while IFS= read -r id; do id_list+=("$id"); done <<< "$ids"
  [ "${#id_list[@]}" -eq "${#files[@]}" ] || return 1
  while [ "$index" -lt "${#files[@]}" ]; do
    manifest+="${id_list[$index]} ${files[$index]}"$'\n'
    index=$((index + 1))
  done
  printf '%s' "$manifest" | git -C "$root" hash-object --stdin 2>/dev/null
}

pipeline_source_skills_digest() { # $1=仓库根 → stdout 摘要或 absent
  local file="$1/skills/skills.lock.json"
  if [ -f "$file" ]; then
    git -C "$1" hash-object --no-filters -- "$file" 2>/dev/null || return 1
  else
    printf 'absent'
  fi
}

# 与 hooks/auto-update.sh 同一套 config 根解析。
_pipeline_source_config_base() {
  if [ -n "${TENON_RUNTIME_CONFIG_ROOT:-}" ]; then
    printf '%s' "$TENON_RUNTIME_CONFIG_ROOT"
  elif [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
    printf '%s' "${HOME:-}/Library/Application Support/tenon/config"
  else
    printf '%s' "${XDG_CONFIG_HOME:-${HOME:-}/.config}/tenon"
  fi
}

# 读 install-channel；只有 channel=dev 的标记才算开发安装。结果放在 PSD_* 变量里。
_pipeline_source_read_marker() { # $1=config 根
  local file="$1/install-channel" key value
  PSD_HOST=""; PSD_RELEASE=""; PSD_REPO=""; PSD_WORKTREE=""; PSD_SKILLS=""
  local channel=""
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      channel) channel="$value" ;;
      host) PSD_HOST="$value" ;;
      release_id) PSD_RELEASE="$value" ;;
      repo) PSD_REPO="$value" ;;
      worktree_digest) PSD_WORKTREE="$value" ;;
      skills_index_digest) PSD_SKILLS="$value" ;;
    esac
  done < "$file"
  [ "$channel" = "dev" ]
}

# stdout：提示文本（空 = 没有提示）。恒 return 0。
pipeline_source_drift_message() { # $1=cwd $2=当前 active release id（可空）
  local cwd="$1" active="${2:-}" top base live_worktree live_skills reasons="" cmd
  command -v git >/dev/null 2>&1 || return 0
  top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ -n "$top" ] || return 0
  pipeline_source_is_tenon_repo "$top" || return 0
  base="$(_pipeline_source_config_base)"
  # 标记里的 release_id 与当前 active 对不上（回滚、重装之后）= 标记陈旧，等同没有标记。
  if _pipeline_source_read_marker "$base" && { [ -z "$active" ] || [ "$active" = "$PSD_RELEASE" ]; }; then
    cmd="tenon setup --${PSD_HOST:-claude} --from-source ${top}"
    if [ "$PSD_REPO" != "$top" ]; then
      printf '[tenon] 已装的开发安装绑定的是另一个仓库（%s），当前仓库 %s 的技能、hooks 与 CLI 不是它的源码。同步：%s' \
        "$PSD_REPO" "$top" "$cmd"
      return 0
    fi
    live_worktree="$(pipeline_source_worktree_digest "$top")" || return 0
    live_skills="$(pipeline_source_skills_digest "$top")" || return 0
    [ "$live_worktree" = "$PSD_WORKTREE" ] || reasons="安装内容已变"
    [ "$live_skills" = "$PSD_SKILLS" ] || reasons="${reasons:+${reasons}、}技能索引已变"
    [ -n "$reasons" ] || return 0
    printf '[tenon] 源码仓库与已装的开发安装不一致（%s）：本会话加载的技能、hooks 与 CLI 不是当前工作区的源码。同步：%s' \
      "$reasons" "$cmd"
    return 0
  fi
  printf '[tenon] 当前目录是 Tenon 源码仓库（%s），但已装的是正式版：技能、hooks 与 CLI 不是仓库源码。同步为源码开发安装：tenon setup --claude --from-source %s（用 Codex 时把 --claude 换成 --codex）。' \
    "$top" "$top"
  return 0
}
```

`hooks/session-start.sh`：在「简短引导」块（`if [ -f "$CWD/GOAL.md" ]; then append_file "$CWD/GOAL.md" 2; fi`，行 171-174）之后、`# ── 注入①：工作流宪法` 之前加

```bash
# ── 源码仓库漂移提示：只在 Tenon 源码仓库里出现；比较在 source-drift.sh（纯 bash + git，fail-open）──
SOURCE_DRIFT_HELPER="$HOOK_DIR/source-drift.sh"
if [ -r "$SOURCE_DRIFT_HELPER" ]; then
  # shellcheck source=source-drift.sh
  . "$SOURCE_DRIFT_HELPER"
  SS_DRIFT="$(pipeline_source_drift_message "$CWD" "${TENON_ACTIVE_RELEASE_ID:-}" 2>/dev/null || true)"
  [ -z "$SS_DRIFT" ] || append_context $'\n'"$SS_DRIFT"$'\n'
fi
```

`hooks/auto-update.sh`：在 `CONFIG="$CONFIG_BASE/auto-update.conf"` 之前（行 25 之后）加

```bash
# 源码开发安装（tenon setup --from-source）写下 install-channel 标记：后台 update 会把它换回正式版，所以见标记就退出。
# 标记里的 release_id 与当前 active release 对不上（回滚、重装之后）说明标记陈旧，照常更新。
CHANNEL_FILE="$CONFIG_BASE/install-channel"
if [ -f "$CHANNEL_FILE" ] && [ ! -L "$CHANNEL_FILE" ]; then
  DEV_CHANNEL=""
  DEV_RELEASE=""
  while IFS='=' read -r key value; do
    case "$key" in
      channel) DEV_CHANNEL="$value" ;;
      release_id) DEV_RELEASE="$value" ;;
    esac
  done < "$CHANNEL_FILE"
  if [ "$DEV_CHANNEL" = "dev" ] && { [ -z "${TENON_ACTIVE_RELEASE_ID:-}" ] || [ "${TENON_ACTIVE_RELEASE_ID}" = "$DEV_RELEASE" ]; }; then
    exit 0
  fi
fi
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/cli/src/runtime/source-drift-hook.test.ts && bash tools/test-hooks.sh 2>&1 | tail -15`
Expected: vitest 全 PASS；`test-hooks.sh` 末行 `N passed, 0 failed`（含 A 部分与本 Task 的全部小节；§3 与 §12h 的红线仍为 0）。

- [ ] **Step 5: Commit**

```bash
git add hooks/source-drift.sh hooks/session-start.sh hooks/auto-update.sh tools/test-hooks.sh packages/cli/src/runtime/source-drift-hook.test.ts
git commit -m "feat(hooks): warn at SessionStart when a Tenon source checkout drifts from the installed plugin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: 隔离 HOME 的真实宿主验收脚本与 `test:source-install`

**Files:**
- Create: `tools/source-install-acceptance.mjs`、`tools/source-install-acceptance.node-test.mjs`
- Modify: `package.json`（scripts，`test:update-rollback`（行 54）之后加 `test:source-install`）
- Modify: `.tenon/tests/catalog.yaml`（`update-rollback` 条目（行 581-590）之后加 `source-install` 条目）

**Interfaces:**
- Consumes: `tools/clean-codex-install-acceptance.mjs` 导出的 `LOCAL_RELEASE_ENTRIES`、`FORCED_RELEASE_ENTRIES`、`runCommand`、`reservePort`、`waitForHealth`、`parseJson`、`requireJsonObject`、`installFakeBrowserOpener`、`cleanupIsolatedDashboardAfterFailure`、`snapshotExternalTenonState`、`assertExternalStateUnchanged`、`assertSupportedAcceptancePlatform`；Task 3–14 的全部产物；本机真实 `claude` / `codex` CLI（缺哪个跳过哪个；CI 或显式 `--host` 时缺失即失败）。
- Produces: `node tools/source-install-acceptance.mjs [--host claude|codex|all] [--evidence <file>]`，导出 `FIXTURE_ENTRIES`、`parseAcceptanceArgs`、`hostAvailable` 供 node-test 使用。
- 需要先 `npm run build`（脚本直接用本 checkout 的 `packages/cli/dist/tenon.mjs` 与已构建的 dist 产物，`--skip-build` 安装）。夹具仓库来自 `LOCAL_RELEASE_ENTRIES` 加根 `package.json`，是本地 git 仓库，不需要 `url.insteadOf`，也不联网（本 checkout 的 `skills/` 里已有上游技能与索引时；缺则 Task 7 的自动拉取会联网）。

- [ ] **Step 1: 写失败测试** `tools/source-install-acceptance.node-test.mjs`

```js
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIXTURE_ENTRIES, parseAcceptanceArgs } from './source-install-acceptance.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('parseAcceptanceArgs defaults to every host and validates --host', () => {
  assert.deepEqual(parseAcceptanceArgs([]), { hosts: ['claude', 'codex'], explicitHost: false, evidence: undefined })
  assert.deepEqual(parseAcceptanceArgs(['--host', 'codex', '--evidence', 'out.json']),
    { hosts: ['codex'], explicitHost: true, evidence: 'out.json' })
  assert.throws(() => parseAcceptanceArgs(['--host', 'cursor']), /unknown --host/u)
})

test('every fixture entry exists in this checkout, so the copy cannot silently drop one', () => {
  for (const entry of FIXTURE_ENTRIES) assert.ok(existsSync(join(repoRoot, entry)), `${entry} is missing from the checkout`)
})

test('the fixture carries the four source-repository criteria', () => {
  assert.ok(FIXTURE_ENTRIES.includes('package.json'))
  assert.ok(FIXTURE_ENTRIES.includes('.claude-plugin/marketplace.json'))
  assert.ok(FIXTURE_ENTRIES.includes('skills'))
  assert.ok(FIXTURE_ENTRIES.includes('runtime/tenon-bootstrap.mjs'))
  assert.ok(existsSync(join(repoRoot, 'skills', 'sources.yaml')))
})

test('package.json wires test:source-install to this script and its unit test', () => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts
  assert.match(scripts['test:source-install'], /source-install-acceptance\.node-test\.mjs/u)
  assert.match(scripts['test:source-install'], /source-install-acceptance\.mjs/u)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tools/source-install-acceptance.node-test.mjs`
Expected: FAIL（`Cannot find module './source-install-acceptance.mjs'`）。

- [ ] **Step 3: 最小实现**

`package.json` scripts：

```json
    "test:source-install": "node --test tools/source-install-acceptance.node-test.mjs && node tools/source-install-acceptance.mjs",
```

`.tenon/tests/catalog.yaml`（缩进与相邻条目一致）：

```yaml
  - id: source-install
    label: 源码开发安装与漂移检查验收
    kind: custom
    runner: custom
    command: npm run test:source-install
    timeout_s: 3600
    report:
      format: exit-code
    tags:
      - slow
```

`tools/source-install-acceptance.mjs`：

```js
#!/usr/bin/env node
/**
 * `tenon setup --from-source` 的端到端验收：真实 claude / codex CLI，隔离 HOME、宿主配置目录、
 * TENON_RUNTIME_HOME、Dashboard 端口。夹具仓库是本 checkout 的发布内容拷出来的一个本地 git 仓库
 * （满足四项判据，被忽略的上游技能随 skills/ 一起带过去，所以默认不联网）。
 *
 * 每个宿主的步骤：
 *   1. tenon setup --<host> --from-source <fixture> --skip-build   -> exit 0
 *   2. tenon runtime status --json：active 带 devSource（realpath、commit），没有 stableTarget，runtime 有效
 *   3. <config>/install-channel 标记：channel=dev、repo、release_id 与 active 一致
 *   4. /api/health：channel=dev、7 位 commit、displayVersion=<version>+dev.<sha7>，version 字段不变
 *   5. tenon doctor --json（cwd=夹具）：identity:release 为 yellow 且写明开发安装，source:drift 为 green
 *   6. 经已装的稳定 tenon-hook 跑 session-start：工作区一致时没有 --from-source 提示
 *   7. 改夹具里的 hooks/gate.sh：session-start 出现 --from-source 提示，doctor 的 source:drift 变 yellow
 *   8. 重跑 setup（同一命令）：release 换新，提示消失，source:drift 回到 green
 *   9. tenon update --<host>：exit 1 并提示 --to-stable，active release 不变
 *  10. setup --from-source 与 --auto-update 同用：exit 1
 *
 * 切回正式版（update --to-stable、正式 setup 清标记）依赖本地 release 夹具与 GitHub API 桩，由
 * tools/runtime-update-rollback-acceptance.mjs 的同一套夹具负责；这里只验证开发安装一侧。
 * 本机没有的宿主跳过；CI 或显式 --host 时缺失即失败。TENON_ACCEPTANCE_KEEP=1 保留夹具。
 *
 *   node tools/source-install-acceptance.mjs [--host claude|codex|all] [--evidence <file>]
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FORCED_RELEASE_ENTRIES,
  LOCAL_RELEASE_ENTRIES,
  assertExternalStateUnchanged,
  assertSupportedAcceptancePlatform,
  cleanupIsolatedDashboardAfterFailure,
  installFakeBrowserOpener,
  parseJson,
  requireJsonObject,
  reservePort,
  runCommand,
  snapshotExternalTenonState,
  waitForHealth,
} from './clean-codex-install-acceptance.mjs'

const HOSTS = ['claude', 'codex']
/** 夹具 = 发布内容 + 根 package.json（四项判据之一）。 */
export const FIXTURE_ENTRIES = [...LOCAL_RELEASE_ENTRIES, 'package.json']

function must(condition, message) {
  if (!condition) throw new Error(message)
}

export function parseAcceptanceArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  const host = value('--host') ?? 'all'
  if (host !== 'all' && !HOSTS.includes(host)) throw new Error(`unknown --host ${host}; expected all, claude or codex`)
  return { hosts: host === 'all' ? [...HOSTS] : [host], explicitHost: host !== 'all', evidence: value('--evidence') }
}

export async function hostAvailable(host) {
  const found = await runCommand('which', [host], { cwd: tmpdir(), env: process.env, timeoutMs: 10_000, allowFailure: true })
  return found.code === 0
}

/** 夹具仓库：拷出发布内容，git init + 提交（被忽略的上游技能随 skills/ 拷过去但不进提交）。返回 HEAD。 */
async function createSourceFixture(repoRoot, repo, env) {
  await mkdir(repo, { recursive: true })
  for (const entry of FIXTURE_ENTRIES) {
    await cp(join(repoRoot, entry), join(repo, entry), { recursive: true, preserveTimestamps: false })
  }
  const git = (args) => runCommand('git', args, { cwd: repo, env, timeoutMs: 60_000 })
  await git(['init', '--quiet', '-b', 'main'])
  await git(['config', 'user.name', 'Tenon source-install acceptance'])
  await git(['config', 'user.email', 'acceptance@invalid.example'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['add', '--all'])
  for (const entry of FORCED_RELEASE_ENTRIES) await git(['add', '--force', entry])
  await git(['commit', '--quiet', '-m', 'source install acceptance fixture'])
  return (await git(['rev-parse', 'HEAD'])).stdout.trim()
}

function hostEnv(host, fixture, port) {
  const home = join(fixture, 'home')
  const base = {
    HOME: home,
    TENON_RUNTIME_HOME: join(fixture, 'runtime'),
    TENON_DASHBOARD_PORT: String(port),
    PATH: `${join(fixture, 'fake-browser')}:${join(home, '.local/bin')}:${process.env.PATH}`,
    TENON_ACCEPTANCE_OPENED_URL: join(fixture, 'opened-url.txt'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CI: '1',
  }
  return host === 'claude'
    ? { ...base, CLAUDE_CONFIG_DIR: join(home, '.claude') }
    : { ...base, CODEX_HOME: join(home, '.codex') }
}

/** 一个宿主一份隔离夹具；无论成败都停掉本场景起的 Dashboard，并确认真实 Tenon 状态没动。 */
async function inFixture(host, body) {
  const externalBefore = await snapshotExternalTenonState(process.env)
  const track = { fixture: null, port: null, owned: null, started: false }
  let cleanupComplete = false
  let result = null
  try {
    const fixture = await mkdtemp(join(tmpdir(), 'tenon-source-install-'))
    track.fixture = fixture
    await Promise.all(['home', 'runtime', 'work'].map((name) => mkdir(join(fixture, name))))
    const port = await reservePort()
    track.port = port
    await installFakeBrowserOpener(join(fixture, 'fake-browser'))
    const env = hostEnv(host, fixture, port)
    result = await body({
      fixture, env, port, work: join(fixture, 'work'), runtimeHome: join(fixture, 'runtime'),
      launcher: join(fixture, 'home', '.local', 'bin', 'tenon'),
      hook: join(fixture, 'home', '.local', 'bin', 'tenon-hook'),
      startInstallation: () => { track.started = true },
      ownDashboard: (health) => { track.owned = health },
    })
    cleanupComplete = true
  } finally {
    if (!track.started && track.owned === null) cleanupComplete = true
    if (track.port !== null && track.fixture !== null) {
      try {
        await cleanupIsolatedDashboardAfterFailure({ TENON_RUNTIME_HOME: join(track.fixture, 'runtime') }, track.port, track.owned)
        cleanupComplete = true
      } catch (error) {
        process.stderr.write(`[source-install] ${error.message}\n`)
      }
    }
    let externalError = null
    try {
      assertExternalStateUnchanged(externalBefore, await snapshotExternalTenonState(process.env))
    } catch (error) {
      externalError = error
    }
    const safePrefix = join(tmpdir(), 'tenon-source-install-')
    if (track.fixture !== null && cleanupComplete && externalError === null
      && track.fixture.startsWith(safePrefix) && process.env.TENON_ACCEPTANCE_KEEP !== '1') {
      await rm(track.fixture, { recursive: true, force: true })
    } else if (track.fixture !== null) {
      process.stderr.write(`[source-install] retained isolated fixture (${host}): ${track.fixture}\n`)
    }
    if (externalError !== null) throw externalError
  }
  if (result === null) throw new Error(`${host} produced no result`)
  return result
}

async function hostScenario(host, repoRoot, steps) {
  const cli = join(repoRoot, 'packages', 'cli', 'dist', 'tenon.mjs')
  return inFixture(host, async (ctx) => {
    const { env, work, fixture, port, runtimeHome } = ctx
    const record = (step) => { steps.push(step); process.stdout.write(`${JSON.stringify(step)}\n`) }
    const fixtureRepo = join(fixture, 'source-repo')
    const commit = await createSourceFixture(repoRoot, fixtureRepo, env)
    const repoReal = await realpath(fixtureRepo)
    const status = async () => requireJsonObject(parseJson(
      (await runCommand(ctx.launcher, ['runtime', 'status', '--json'], { cwd: work, env, timeoutMs: 60_000 })).stdout,
      'tenon runtime status',
    ), 'tenon runtime status')
    const doctor = async () => {
      const run = await runCommand(ctx.launcher, ['doctor', '--json'], { cwd: fixtureRepo, env, timeoutMs: 180_000, allowFailure: true })
      const checks = requireJsonObject(parseJson(run.stdout, 'tenon doctor'), 'tenon doctor').checks ?? []
      return (id) => checks.find((check) => check.id === id)
    }
    const sessionStart = async () => {
      const run = await runCommand('bash', [ctx.hook, 'session-start'], {
        cwd: fixtureRepo,
        env: { ...env, TENON_SESSION_START_FORMAT: 'plain' },
        input: JSON.stringify({ cwd: fixtureRepo }),
        timeoutMs: 120_000,
        allowFailure: true,
      })
      return `${run.stdout}\n${run.stderr}`
    }

    ctx.startInstallation()
    // 1. 安装
    const install = await runCommand('node', [cli, 'setup', `--${host}`, '--from-source', fixtureRepo, '--skip-build'], {
      cwd: work, env, timeoutMs: 900_000,
    })
    must(/源码开发安装/u.test(install.stdout), `the install did not announce a development install:\n${install.stdout}`)
    const health = await waitForHealth(port)
    ctx.ownDashboard(health)

    // 2. runtime 身份
    const first = await status()
    must(first.activeValid === true, 'the active runtime must verify after a source install')
    must(first.active?.devSource?.repoRealpath === repoReal, `devSource.repoRealpath ${first.active?.devSource?.repoRealpath} != ${repoReal}`)
    must(first.active.devSource.commit === commit, 'devSource.commit is not the fixture HEAD')
    must(first.active.stableTarget === undefined, 'a development release must not claim a stable target')
    record({ step: `${host} 1-2 install + runtime identity`, release: first.selection.activeRelease })

    // 3. 标记
    const marker = await readFile(join(runtimeHome, 'config', 'install-channel'), 'utf8')
    must(marker.includes('channel=dev') && marker.includes(`repo=${repoReal}`) && marker.includes(`release_id=${first.selection.activeRelease}`),
      `install-channel marker does not match the active release:\n${marker}`)

    // 4. health
    const body = requireJsonObject(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), 'health')
    must(body.channel === 'dev' && body.commit === commit.slice(0, 7), `health channel/commit wrong: ${JSON.stringify(body)}`)
    must(body.displayVersion === `${body.version}+dev.${commit.slice(0, 7)}`, `health displayVersion wrong: ${JSON.stringify(body)}`)

    // 5. doctor
    const checkOf = await doctor()
    must(checkOf('identity:release')?.status === 'yellow' && /开发安装/u.test(checkOf('identity:release').detail),
      `identity:release must be a yellow development-install warning, got ${JSON.stringify(checkOf('identity:release'))}`)
    must(checkOf('source:drift')?.status === 'green', `source:drift must start green, got ${JSON.stringify(checkOf('source:drift'))}`)

    // 6. 同步时 hook 沉默
    must(!(await sessionStart()).includes('--from-source'), 'session-start warned although the checkout is in sync')

    // 7. 改了安装内容之后 hook 与 doctor 都发现漂移
    const gate = join(fixtureRepo, 'hooks', 'gate.sh')
    await writeFile(gate, `${await readFile(gate, 'utf8')}\n# drift introduced by the acceptance\n`, 'utf8')
    const warned = await sessionStart()
    must(warned.includes(`tenon setup --${host} --from-source ${repoReal}`), `session-start did not report the drift:\n${warned}`)
    must((await doctor())('source:drift')?.status === 'yellow', 'source:drift must be yellow after editing installed content')
    record({ step: `${host} 3-7 marker, health, doctor, hook before and after a drift` })

    // 8. 重新同步
    await runCommand('node', [cli, 'setup', `--${host}`, '--from-source', fixtureRepo, '--skip-build'], { cwd: work, env, timeoutMs: 900_000 })
    // 新 release 起了新的 Dashboard 进程：清理要认这一份，不能拿第一次安装的身份去停它。
    ctx.ownDashboard(await waitForHealth(port))
    const second = await status()
    must(second.selection.activeRelease !== first.selection.activeRelease, 'the re-sync must activate a new release')
    must(!(await sessionStart()).includes('--from-source'), 'session-start still warns after the re-sync')
    must((await doctor())('source:drift')?.status === 'green', 'source:drift must be green again after the re-sync')

    // 9. update 默认拒绝
    const update = await runCommand(ctx.launcher, ['update', `--${host}`], { cwd: work, env, timeoutMs: 120_000, allowFailure: true })
    must(update.code === 1 && /--to-stable/u.test(update.stderr), `tenon update must refuse a development install:\n${update.stdout}\n${update.stderr}`)
    must((await status()).selection.activeRelease === second.selection.activeRelease, 'the refused update changed the active release')

    // 10. 选项冲突
    const conflict = await runCommand('node', [cli, 'setup', `--${host}`, '--from-source', fixtureRepo, '--auto-update'], {
      cwd: work, env, timeoutMs: 60_000, allowFailure: true,
    })
    must(conflict.code === 1 && /--auto-update/u.test(conflict.stderr), 'setup --from-source --auto-update must be refused')
    record({ step: `${host} 8-10 re-sync, update refusal, option conflict`, release: second.selection.activeRelease })
    return { ok: true }
  })
}

async function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  assertSupportedAcceptancePlatform()
  const { hosts, explicitHost, evidence } = parseAcceptanceArgs(argv)
  const steps = []
  const ran = []
  for (const host of hosts) {
    if (!await hostAvailable(host)) {
      must(!explicitHost && process.env.CI === undefined, `${host} CLI is required (--host ${host} or CI) but is not on PATH`)
      process.stderr.write(`[source-install] SKIP ${host}: CLI not on PATH\n`)
      continue
    }
    await hostScenario(host, repoRoot, steps)
    ran.push(host)
  }
  must(ran.length > 0 || process.env.CI === undefined, 'no host CLI available in CI')
  const result = { ok: true, hosts: ran, steps }
  if (evidence !== undefined) await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, hosts: ran, steps: steps.length })}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[source-install] FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tools/source-install-acceptance.node-test.mjs && node packages/cli/dist/tenon.mjs test catalog validate`
Expected: node-test 全 PASS；`catalog validate` 无报错（新条目被接受）。

然后做一次真实验收（需要 `npm run build` 已完成、本机有 `claude` 或 `codex`）：

Run: `npm run build && npm run test:source-install`
Expected: 每个可用宿主逐步打印 JSON 步骤行，最后一行 `{"ok":true,"hosts":[…],"steps":N}`，退出码 0；隔离夹具被清理，`assertExternalStateUnchanged` 不抛错。若某一步失败，保留夹具（`TENON_ACCEPTANCE_KEEP=1`）并按报错定位到 Task 6 / 8 / 14 的对应实现。

- [ ] **Step 5: Commit**

```bash
git add tools/source-install-acceptance.mjs tools/source-install-acceptance.node-test.mjs package.json .tenon/tests/catalog.yaml
git commit -m "test(tools): add the isolated-host acceptance for the source install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: 文档、长期规则、全量构建与验收

**Files:**
- Modify: `docs/usage/cli-reference.md:32-33` 及其后的段落；`docs/usage/zh-CN/cli-reference.md:8-21`
- Modify: `docs/usage/contributor-development.md`（`## Setup` 末段之后）；`docs/usage/zh-CN/contributor-development.md`（`### 1. 安装与构建` 末段之后）
- Modify: `docs/DIST-RELEASE.md`（「用户侧入口固定为 `tenon setup --codex` 或 `tenon setup --claude`。升级时：」那个代码块之后）
- Modify: `docs/usage/dashboard-and-local-api.md`（`Health is the only API read …` 段末）；`docs/usage/zh-CN/dashboard-and-local-api.md`（`/api/health 是唯一不需要会话的 API 读…` 段末）
- Modify: `README.md`（`## 从源码开发` 代码块之后）；`README.en.md`（`## Develop from source` 代码块之后）
- Modify: `.agent-rules/COMMON.md`（`packages/cli/` 行 23、`hooks/` 行 27、测试表 `更新 / 回滚验收` 行 100 之后，以及新增「在 Tenon 源码仓库里工作」一节）
- Regenerate and commit: `packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`、`packages/dashboard-app/dist/**`（只能 `npm run build` 生成）

**Interfaces:**
- Consumes: Task 3–15 的全部行为；`tools/check-docs.mjs`（`CANONICAL_USAGE_FILES`、`TRUTH_SOURCES` 含 `program-install.ts`，它校验 setup / update 都暴露 `--codex`，并要求文档不夸大；先跑一遍基线再改）。
- Produces: 用户与贡献者文档、一条长期规则、重新生成并通过 freshness 的 tracked bundle。

- [ ] **Step 1: 失败检查（文档目前没有这些内容）**

Run:
```bash
npm run check:docs
grep -c -- '--from-source' docs/usage/cli-reference.md docs/usage/zh-CN/cli-reference.md docs/usage/contributor-development.md docs/DIST-RELEASE.md README.md README.en.md .agent-rules/COMMON.md
```
Expected: `check:docs` 当前 PASS（基线）；`grep -c` 每个文件都是 `0`（这就是要补的缺口）。

- [ ] **Step 2: 写文档**

**`docs/usage/cli-reference.md`**：把行 32-33 的两行换成四行，并在 `` `tenon dashboard --open` signs you in `` 那段之前加一段。

````text
tenon setup --<one-host> [--target <dir>] [--auto-update] [--dry-run] [-y]
tenon setup --claude|--codex --from-source <repo> [--skip-build] [--dry-run]
tenon update --<one-host> [--target <dir>] [--dry-run] [-y] [--auto]
tenon update --claude|--codex --to-stable [--dry-run] [-y]
````

````markdown
`tenon setup --claude|--codex --from-source <repo>` is the source development install, for working inside a Tenon
checkout. It builds the checkout (`npm --prefix <repo> run build`, skipped by `--skip-build`), fetches any missing
upstream skills and the local `skills/skills.lock.json` index from `skills/sources.yaml` (the whole command aborts
before any host change if that fetch fails), registers the checkout directory as the `tenon` marketplace, and
publishes a managed runtime whose manifest records `devSource` (commit, `dirty`, a content digest of the installed
files, a digest of the skills index) instead of a stable tag. It never poses as a release: the plugin version stays
the checkout's `plugin.json` version and only `/api/health` shows `<version>+dev.<sha7>`. A development install turns
auto-update off, `tenon update` refuses it, and `tenon update --claude|--codex --to-stable` switches back to the
latest stable release. Without `--from-source`, setup and update behave exactly as before and accept only stable
tags. `tenon doctor` reports `identity:release` as a warning for a development install and `source:drift` when the
checkout no longer matches what is installed. `--from-source` combines with exactly one of `--claude` / `--codex`,
not with adapter hosts or `--auto-update`.
````

**`docs/usage/zh-CN/cli-reference.md`**：在行 10 `tenon update --codex` 之后加两行命令，并在 `tenon --version` 那段之后加一段。

````text
tenon setup --claude --from-source <repo>
tenon update --claude --to-stable
````

````markdown
`tenon setup --claude|--codex --from-source <repo>` 是源码开发安装，用于在 Tenon 源码仓库里工作：它构建该仓库（`npm --prefix <repo> run build`，`--skip-build` 可跳过）、按 `skills/sources.yaml` 获取缺失的上游技能与本机 `skills/skills.lock.json` 索引（获取失败则整条命令在改动宿主之前中止）、把仓库目录登记成 `tenon` marketplace，并发布一份在 manifest 里记录 `devSource`（commit、`dirty`、安装内容摘要、技能索引摘要）而不是稳定标签的受管 runtime。它不冒充发布版本：插件版本仍是仓库 `plugin.json` 的版本，只有 `/api/health` 显示 `<version>+dev.<sha7>`。开发安装会关闭自动更新，`tenon update` 对它默认拒绝，`tenon update --claude|--codex --to-stable` 切回最新正式版。不带 `--from-source` 时 setup / update 与以前完全一致，只认稳定标签。`tenon doctor` 对开发安装给出 `identity:release` 警告，仓库与已装内容不一致时给出 `source:drift`。`--from-source` 只能与 `--claude` 或 `--codex` 之一同用，不能与 adapter 宿主或 `--auto-update` 同用。
````

**`docs/usage/contributor-development.md`**：在 `The root package is private. This source workflow is not a published global npm installation path.` 之后加

````markdown
### Run your checkout as the installed plugin

Inside this repository the skills, hooks and CLI your agent loads should be the checkout's, not a release's:

```bash
tenon setup --claude --from-source . --dry-run   # preview; use --codex for Codex
tenon setup --claude --from-source .             # add --skip-build when packages/*/dist is already current
tenon doctor                                     # identity:release warns (development install); source:drift is green when in sync
```

Edit the checkout, then run the same setup command to sync. A new session started in the checkout warns when the
installed files no longer match it (SessionStart, pure bash, never blocks). Go back to the release with
`tenon update --claude --to-stable`. Upstream skills and the local `skills/skills.lock.json` are not committed; a fresh
checkout or worktree fetches them during its first source install.
````

**`docs/usage/zh-CN/contributor-development.md`**：在 `### 1. 安装与构建` 的 `不要用全局依赖掩盖 lockfile 缺失，也不要混用 pnpm、yarn 或 bun。` 之后加

````markdown
在本仓库里工作时，让本机加载的技能、hooks 与 CLI 都来自仓库工作区，而不是已发布版本：

```bash
tenon setup --claude --from-source . --dry-run   # 先预览；Codex 用 --codex
tenon setup --claude --from-source .             # packages/*/dist 已是最新时可加 --skip-build
tenon doctor                                     # identity:release 为警告（开发安装），source:drift 同步时为绿
```

改完仓库后重跑同一条 setup 命令即可同步。在仓库里新开会话时，若已装内容与工作区不一致，会话开头会有提示（SessionStart，纯 bash，不阻断）。切回正式版：`tenon update --claude --to-stable`。上游技能与本机 `skills/skills.lock.json` 不进仓库；新 checkout 或新 worktree 在第一次源码安装时自动获取。
````

**`docs/DIST-RELEASE.md`**：在 `tenon setup --codex --auto-update` 那个代码块的结尾 ``` 之后、`更新实现先让宿主刷新 marketplace/插件` 之前加

````markdown
开发例外：在 Tenon 源码仓库里可以用 `tenon setup --claude|--codex --from-source <repo>` 把本机装成仓库工作区的构建（开发安装）。它走同一个 `release-coordinator` 事务，候选根是仓库工作区而不是宿主缓存，宿主命令仍只改宿主登记（宿主缓存仍由宿主 CLI 写）；release manifest 记录 `devSource`（commit、dirty、安装内容摘要、技能索引摘要）而不是 `stableTarget`，不冒充版本标签。发布流程、正式 `tenon setup` 与 `tenon update` 仍只认稳定标签；开发安装之上 `tenon update` 默认拒绝，`--to-stable` 切回。上游技能与本机索引不进仓库，开发安装在缺失时按 `skills/sources.yaml` 获取，获取失败整体中止、不改宿主。
````

**`docs/usage/dashboard-and-local-api.md`**：在 `Health is the only API read that needs no session. …` 那段末尾加一句

````markdown
It also reports `channel`: `stable` for a release install, `dev` for a source development install, in which case
`commit` is the 7-character commit and `displayVersion` is `<version>+dev.<sha7>`; `version` itself never changes.
````

**`docs/usage/zh-CN/dashboard-and-local-api.md`**：在 `/api/health 是唯一不需要会话的 API 读…` 那段末尾加一句

````markdown
它还带 `channel`：正式安装为 `stable`，源码开发安装为 `dev`，此时 `commit` 是 7 位 commit，`displayVersion` 是 `<version>+dev.<sha7>`；`version` 字段本身不变。
````

**`README.md`**（`## 从源码开发` 的代码块之后、`### Upstream Skills` 之前）：

````markdown
想让本机的技能、hooks 与 CLI 都用仓库工作区而不是已发布版本：`tenon setup --claude --from-source .`（Codex 用 `--codex`，先加 `--dry-run` 预览）；改完仓库后重跑同一条命令即可同步，切回正式版用 `tenon update --claude --to-stable`。详见[贡献者开发](docs/usage/zh-CN/contributor-development.md)。
````

**`README.en.md`**（`## Develop from source` 的代码块之后）：

````markdown
To make the skills, hooks and CLI on your machine come from the checkout instead of a release, run
`tenon setup --claude --from-source .` (`--codex` for Codex, `--dry-run` to preview); rerun it after editing the
checkout to sync, and `tenon update --claude --to-stable` to go back. See
[Contributor development](docs/usage/contributor-development.md).
````

**`.agent-rules/COMMON.md`**：

- 行 23 `packages/cli/` 的「修改注意事项」单元格末尾追加下面这段（含开头的分号）：

````text
；源码开发安装（commands/source-install.ts、runtime/dev-source-identity.ts）的摘要口径必须与 hooks/source-drift.sh 逐字一致，改任一侧先跑 packages/cli/src/runtime/source-drift-hook.test.ts
````

- 行 27 `hooks/` 的「修改注意事项」单元格末尾追加下面这段（含开头的分号）：

````text
；source-drift.sh 是被 session-start.sh source 的纯 bash 助手，同样守零解释器红线
````
- 测试表 `更新 / 回滚验收` 行（行 100）之后加一行：

````text
| 源码开发安装验收 | `npm run test:source-install`（隔离 HOME 里真实 claude / codex，缺哪个跳过哪个，CI 或显式 `--host` 时缺失即失败；夹具是本 checkout 拷出的本地 git 仓库，不联网；改 `commands/source-install.ts`、`commands/dev-host.ts`、`hooks/source-drift.sh` 时本地跑） |
````

- 在 `## 根路径结构与职责` 的表之后、`## 指令优先级` 之前加一节：

````markdown
## 在 Tenon 源码仓库里工作

- 触发条件：当前目录在 Tenon 源码仓库内（根 `package.json` 的 `name=tenon`；`.claude-plugin/marketplace.json` 的 `name=tenon` 且 `plugins[0].source="./"`；存在 `skills/sources.yaml` 与 `runtime/tenon-bootstrap.mjs`）。
- 必须：用源码开发安装让本机的技能、hooks、CLI 都来自仓库工作区——`tenon setup --claude --from-source .`（Codex 用 `--codex`，先 `--dry-run`）；改了 `hooks/`、`skills/` 下自有技能、`templates/`、`adapters/` 或需要重新构建的 `packages/*` 之后重跑同一条命令；新会话开头出现「源码仓库与已装的开发安装不一致」提示时，先同步再继续。
- 不得：在源码仓库里长期用已发布的正式版做开发；把上游技能正文或 `skills/skills.lock.json` 提交进仓库；手改 `~/.claude/plugins`、`~/.codex/plugins` 缓存或 `install-channel` 标记。
- 验证证据：`tenon doctor --json` 里 `identity:release` 为 yellow（开发安装）且 `source:drift` 为 green；`tenon runtime status --json` 的 `active.devSource.commit` 与 `git rev-parse HEAD` 对得上（工作区有未提交改动时以 `dirty` 与 `source:drift` 为准）。
- 失败处理：拉取上游技能失败则整体中止、宿主未改，网络恢复后重跑；切回正式版用 `tenon update --claude --to-stable`（`tenon update` 对开发安装默认拒绝）。
````

- [ ] **Step 3: 重新生成 tracked bundle 并跑全量验收**

Run（全部在隔离环境或只读；`test:update-rollback`、`test:clean-install` 需要网络与可信 Codex，按 `COMMON.md` 的说明本地跑，跑不了就在回报里写明原因与剩余风险）：

```bash
npm run build
git status --short packages/cli/dist packages/server/dist packages/dashboard-app/dist
npm run check:dashboard-dist-freshness
npx vitest run packages/cli packages/server
bash tools/test-hooks.sh
bash tools/test-bundle.sh
bash tools/verify-skills.sh
npm run check:docs
npm run check:comments
npm run check:architecture
node packages/cli/dist/tenon.mjs test catalog validate
npm run test:source-install
npm run test:update-rollback
npm run test:clean-install
```
Expected: 每条退出码 0；`git status` 只显示预期的 dist 产物与本任务改动；`test-hooks.sh` 末行 `N passed, 0 failed`；`test:source-install` 末行 `{"ok":true,…}`。`check:docs` 若因 docs-site 镜像报差异，按它的提示运行 `npm run docs:sync` 后再看一遍（同步产物属于本 Task）。

- [ ] **Step 4: 文档检查转绿**

Run: `grep -c -- '--from-source' docs/usage/cli-reference.md docs/usage/zh-CN/cli-reference.md docs/usage/contributor-development.md docs/usage/zh-CN/contributor-development.md docs/DIST-RELEASE.md README.md README.en.md .agent-rules/COMMON.md`
Expected: 每个文件 ≥ 1。

- [ ] **Step 5: Commit**

```bash
git add docs/usage/cli-reference.md docs/usage/zh-CN/cli-reference.md docs/usage/contributor-development.md docs/usage/zh-CN/contributor-development.md docs/DIST-RELEASE.md docs/usage/dashboard-and-local-api.md docs/usage/zh-CN/dashboard-and-local-api.md README.md README.en.md .agent-rules/COMMON.md packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs packages/dashboard-app/dist
git commit -m "docs: document the source development install and regenerate the tracked bundles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: 本机切换到源码开发安装（交付步，用户确认后执行）

> **这一 Task 碰真实 HOME、真实 Claude / Codex 配置与真实 Tenon 状态。** 它属于 Tenon 工作流的交付步，只在 Task 1–16 全部合入且验证绿之后执行，并且**必须先得到用户的明确确认**（说明将要执行的命令、会改动什么、怎么回退）；没有确认就不要运行下面任何一条会写状态的命令。Part A 的「提交交付物并重新安装本地运行时」就是靠这一步完成的。

**Files:**
- 无源码改动。只改本机状态：`~/.local/bin/tenon`、`~/.local/bin/tenon-hook`、`~/Library/Application Support/tenon/…`（macOS 的 managed runtime / config）、`claude plugin` 的 marketplace 与插件登记。

**Interfaces:**
- Consumes: Task 3–16 全部；本仓库当前 checkout（含 A 部分的 hook 修复）。
- Produces: 本机 active runtime 是 `channel: dev` 的本仓库构建；`install-channel` 标记在 config 根；本仓库里新开会话没有漂移提示。

- [ ] **Step 1: 记录回退锚点（只读）**

```bash
tenon runtime status --json > /tmp/tenon-before-source-install.json
tenon doctor --json > /tmp/tenon-doctor-before.json || true
git rev-parse HEAD
```
把 `selection.activeRelease`（回退时要认的正式 release）记在交付说明里。

- [ ] **Step 2: dry-run 并请用户确认**

```bash
tenon setup --claude --from-source . --dry-run
```
Expected：打印仓库路径、当前身份（commit / dirty / 摘要）、构建命令、五步宿主命令（`claude plugin uninstall …`、`marketplace remove tenon`、`marketplace add <repo>`、`plugin install tenon@tenon`、`plugin list --json`）与「写入 install-channel 并关闭 auto-update」。把这份输出贴给用户，等明确确认（「确认继续」之类，且是对这一步的确认）。

- [ ] **Step 3: 执行**

```bash
tenon setup --claude --from-source .
```
Expected：构建输出、`[setup] 冻结源码身份：… 版本展示 0.3.2+dev.<sha7>`、`已发布开发 runtime：sha256-…`，退出码 0。若中途失败：不要手动删宿主缓存，先看报错；WAL 会保留，重跑同一条命令幂等恢复；确认无法恢复再 `tenon runtime repair --rollback`。

- [ ] **Step 4: 验证**

```bash
tenon runtime status --json
git rev-parse HEAD
tenon doctor --json | grep -o '"id":"\(identity:release\|source:drift\)"[^}]*}'
curl -fsS http://127.0.0.1:18765/api/health
```
Expected：`runtime status` 里 `activeValid` 为 `true`、`active.devSource.commit` 等于 `git rev-parse HEAD`（工作区有未提交改动时 `dirty` 为 `true`）、`active` 里没有 `stableTarget`；`identity:release` 为 yellow 且写明开发安装；`source:drift` 为 green；health 里 `channel` 为 `dev`、`displayVersion` 为 `0.3.2+dev.<sha7>`、`version` 仍是 `0.3.2`。然后**新开一个 Claude 会话**，确认会话开头没有「源码仓库与已装的开发安装不一致」提示；再改一个 hook 文件、新开会话，确认提示出现并带 `tenon setup --claude --from-source <repo>`；改回去。

- [ ] **Step 5: 回退方式（写进交付说明，不要现在执行）**

- 切回最新正式版：`tenon update --claude --to-stable`（需要网络；成功后 `install-channel` 标记被清，`tenon doctor` 的 `identity:release` 回到绿）。
- 只回到上一份已验证的 runtime（宿主登记仍是目录 marketplace）：`tenon runtime repair --rollback`；此后 `tenon doctor` 会按「回滚后的预期状态」报警，随后用上一条命令完整切回。
- 重新同步源码：重跑 `tenon setup --claude --from-source .`。

- [ ] **Step 6: 记录**

不产生 commit。把 Step 1 的回退锚点、Step 4 的验证输出摘要写进交付说明（`tenon` 交付步的证据）。

