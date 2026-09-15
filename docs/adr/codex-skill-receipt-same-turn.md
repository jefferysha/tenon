# 架构决策记录

## 背景

Codex custom exec transcript 已包含执行目标 `workdir`，但 Tenon 只提取 `cmd`。当 session
从原工作树启动、命令执行于 sibling worktree 时，fallback receipt 无法证明项目身份。

## 决策

把 custom tool-program 解码结果从 command 字符串提升为受限的 invocation
`{ command, workdir? }`，并复用现有 `explicitSiblingWorktreeTarget`。只有字面对象、
单个 awaited exec、同一变量的完整 result 转发、绝对 workdir、目标物理目录相等且 Git
common directory 相同才接受。只转发 stdout 会丢失 nested `exit_code`，因此
`text(result.output)` 明确拒绝，规范 wrapper 为 `text(result)`。JSON 旁路字段作为纯数据
忽略，只验证 `cmd`/`command`/`workdir`。

Codex 也会生成等价的单表达式 `text(await tools.exec_command({...}));`：同样是单个 awaited
exec、完整 result 直接转发，整段程序锚定匹配，因此一并接受（v1.1.3 真实 Codex 任务中，
这种写法的完整 SKILL.md 读取曾被判为无证据，首次 `document record` 必然失败）。
`.output`、未 await、包裹转换和任何附加语句仍拒绝。

Verify 后进一步固定：当前 custom ABI 的成功 output 必须是包含 `chunk_id`、
`wall_time_seconds`、`exit_code`、`original_token_count` 与 `output` 的完整结果信封；
任意未标型对象和形似结果的 stdout JSON 都拒绝。旧 ABI 仅保留明确标型的
`execution_result`。session fallback 只匹配 `session_meta.payload.id`，不能使用 fork
继承的 `payload.session_id`。最新 transcript 一旦出现 malformed JSON 或读取 I/O 错误，
整次 discovery 失败关闭且不回退旧文件。字面 `workdir` 必须是普通目录，符号链接即使
解析到目标也拒绝。

调用与输出的 host ABI 也是身份的一部分：`custom_tool_call` 只匹配
`custom_tool_call_output`，`function_call` 只匹配 `function_call_output`，不能仅凭
`call_id` 跨型配对。失败关闭从 transcript 流式读取前移到枚举阶段；目录读取、候选
`lstat`/`realpath`、单文件预算或总预算无法证明最新候选完整时，不得回退旧文件。
项目路径检查同时要求字面路径等于其物理路径，从而拒绝最终组件或任一祖先为 symlink 的别名。

transcript 完整性不再分为 exact 与 fallback 两套强度：两者都捕获
device/inode/size/mtime/ctime，以 `O_NOFOLLOW` 打开并按捕获大小读取；完成后同时复核原 fd
和 candidate path 当前打开结果。host 在打开后 rename/unlink 旧 inode、在原路径创建新
transcript，或增长/改写候选时均失败关闭。

## 备选方案

- 放弃 worktree 隔离：违反自动化并发安全要求。
- 按同仓任意目录放行：扩大证据信任边界。
- 等待下一用户轮次：不能满足无人值守调度。

## 后果

定时任务可在首次调度的同一轮完成 Skill evidence 登记；function/custom 两种 ABI 的项目
身份规则保持一致。解析失败和缺少显式 `workdir` 继续失败关闭。无需迁移状态或回填 ledger。
外层 custom tool 完成状态不再替代内部执行成功；只有可见的 nested `exit_code=0` 能产生 receipt。
更严格的完整信封、精确 session id 与损坏 transcript 处理会拒绝先前模糊接受的边缘格式；
读取期间路径轮换或元数据漂移也会被拒绝。这些是有意的安全收紧，不改变持久化格式。
