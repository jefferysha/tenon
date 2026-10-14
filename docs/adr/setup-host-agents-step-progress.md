# 架构决策记录：宿主子代理文件只在终端安装时写入；步骤进度由 hook 打印；新任务建在独立 worktree

## 背景

Tenon 曾在会话里执行的 `tenon init` 与 `tenon agent prompt` 中写 `.claude/agents/tenon-<name>.md`，并立即让主线按
`tenon-<name>` 派发。Claude Code 2.1.292 上，会话中途写入的子代理文件在同一回合必然 not found，跨多个回合、数分钟后也可能仍不可用
（会话 `4f9542da`、`be80e77d` 实测，见调研报告），官方文档声称的文件监听与实测不符。于是每个项目第一次建任务的会话都会先撞一次
not found，专属子代理的工具白名单与 model 也随之失效。

同时，skill 要求模型用 Todo 工具展示步骤，但较新的 Claude 模型默认不提供 Todo 工具（Claude Code 2.1.268 起），进度展示静默失效。

规格第二轮又暴露了同仓并行的问题：任务起点不落盘、原地开发时按 `created_at` 推算，别的任务合进 main 的提交（本任务遇到 93 个
测试文件和 `catalog.yaml`）都算成本任务的改动；`isolation=worktree` 没有实现，任务状态只在建它的检出里，构建版本绑 git HEAD 而实现
到交付才提交。退回边的技能门不分方向，归执行者的技能只能在 agent 运行期间加载，导致退回规格要先启动一次执行者。

## 决策

1. 宿主子代理文件只由终端执行的 `tenon agent install`（`tenon setup` / `tenon update` 也会调用）写到宿主的用户级子代理目录
   （`$CLAUDE_CONFIG_DIR/agents` 或 `~/.claude/agents/`、`$CODEX_HOME/agents` 或 `~/.codex/agents/`，环境变量只认绝对路径），
   覆盖 agent 库的官方层与自定义层，用户级所有权清单按目标目录分组，保证只动 Tenon 在该目录写的未改动文件；
   `tenon update` 在已是最新版时也执行；对称的 `tenon agent uninstall` 负责清除。`tenon agent prompt` 按自己进程的环境解析同一目录来判定。
2. 会话内的任何 Tenon 命令都不写宿主子代理文件。`tenon agent prompt` 只在已装文件与冻结定义逐字一致且未被项目级同名文件遮住时
   返回 `tenon-<name>`，否则返回通用子代理并在台账记录原因。
3. 项目层 agent 不再有专属宿主类型，一律走通用子代理。
4. 旧逻辑留下的项目级 `tenon-*` 文件在 `tenon init` 与归档时按所有权或内容一致性清理。
5. 终端步骤进度由 PostToolUse hook `step-progress` 在 `tenon init / session activate / transition / step run` 成功后，
   用 `systemMessage` 打印一行清单（数据来自新命令 `tenon workflow progress`）。skill 中建 Todo 改为宿主有工具时才做。
6. 任务起点在建任务时记录（`start_sha`），起点取 `start_sha`、上游 merge-base、base merge-base 中最新的一个，分不出先后取共同
   祖先，都没有才按时间推算；不按提交信息推断归属。所有按起点比对的地方共用这一入口。
7. 所有新任务由 `tenon init` 建在 `<主检出>/.worktrees/<change>`（分支 `tenon/<change>`），从立项到归档都在里面；按测试目录的
   `setup` 准备、继承本用户已信任的命令摘要；Claude Code 用 `EnterWorktree` 切入，Codex 开新会话；主检出能列出并恢复这些任务。
   非 git、无提交、分离 HEAD、已在 linked worktree、显式 `--in-place` / `TENON_INIT_IN_PLACE=1`（测试工装，不输出原因）时原地建；
   Dashboard 建任务仍原地。
8. `isolation=worktree` 的构建版本改绑工作区内容指纹（身份含 worktree），`branch` 不变。
9. 退回边不要求归属执行者或评审者的技能；没有派发的运行可如实登记为 `not-dispatched`。

## 备选方案

- 会话内生成并按新鲜度判断：依赖不可预期的宿主刷新时机，否决。
- 终端命令写项目级：每个项目都要执行一次，保留本机排除与项目级所有权，复杂度最高；用户选择用户级。
- 插件自带 agents：名字带插件前缀，无法覆盖用户自定义层，否决。
- statusLine 显示进度：宿主只允许一个 statusLine，已被占用，否决。
- 按提交信息判断起点归属：提交信息可伪造，能把改动藏到起点之前，否决。
- 显式命令挪起点：要人记得执行；用户选自动跟随上游。
- 实现步才建 worktree：要迁移主检出里未提交的任务状态，否决。
- worktree 构建版本保持 git HEAD：要求提前提交，与「只在 next 点名时提交」冲突，否决。

## 后果

- 专属子代理在安装后开的新会话里稳定可用，会话中不再出现由 Tenon 引起的 not found。
- 用户升级后需要在终端执行一次 `tenon update`（或 `tenon agent install`）并开新会话；新建或修改自定义 agent 后同样需要。
- 项目层 agent 失去专属类型（工具白名单只靠正文约束）。
- 冻结旧版本 agent 的在途任务在库升级后退回通用子代理。
- Tenon 第一次在用户级子代理目录写文件，需要新的用户级所有权清单与卸载路径。
- 设了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 的用户要在带同样变量的环境里安装；环境不一致时 `prompt` 退回通用子代理并指出它检查的目录
  （规格第四轮由验证步真机验收发现：最初写死 home 目录，设了 `CLAUDE_CONFIG_DIR` 的会话看不到已装的子代理）。
- 终端在关键命令后出现一行步骤清单，不再依赖模型是否有 Todo 工具；Claude 与 Codex 共用同一份 hooks.json。
- 同仓多个任务可以各在自己的 worktree 并行推进，证据互不污染；原地任务拉取上游后不再继承别人的提交。
- 每个新任务多一个 worktree、一个分支与一次依赖安装；Codex 用户要开新会话；Dashboard 把每个 worktree 当作单独项目。
- 构建版本契约变化：`worktree` 与 `in-place` 绑工作区指纹，只有 `branch` 绑 git object。
- 在实现步开头可以直接退回规格，不再需要启动执行者。
- `start_sha` 存在按 revision 绑定的伴随文件、台账 `reason` 存在运行旁注，升级前发布的运行时仍读得了新任务（实现中由 bundle 的
  N-1 兼容门发现并改正：最初写进 wire 的字段闭集，v0.3.1 读不了）。
- 工作区指纹契约变化：完整指纹也不计未被 git 跟踪的 `.claude/worktrees/`，同仓库其它 Claude Code 会话与子代理不再让主检出任务的
  构建版本与评审结论过期，算指纹也不再遍历那些检出；代价是有该目录的机器上，0.3.0 的测试记录升级后、当前版本的评审结论回滚到
  v0.3.1 后会被判过期重跑（不判损坏）。
- 原地任务把自己的提交推到 base 分支的上游后，起点会前移过这些提交；worktree 任务不受影响。
