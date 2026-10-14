# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Pending-interaction enforcement SHALL classify action effects

The interaction gate SHALL classify a requested tool action as `read-only`,
`human-question`, `reversible-local-write`, `canonical-state-transition`,
`external-side-effect`, `destructive-or-costly`, or `unknown`.

Known read-only inspection and human-question actions SHALL remain available
while a pending interaction or review exists. State transitions, external
effects, destructive or costly actions SHALL retain their exact authorization
requirements. Unknown actions SHALL fail closed.

一条 shell 命令 SHALL 只在以下条件全部满足时算只读：

- 按引号感知的方式，用引号外的 `|`、`||`、`&&`、`;` 切成若干段后，每一段都是 `cd`，或在严格只读名单内。
- 引号外没有重定向、后台执行 `&`、换行；任何位置（单引号内除外）没有命令替换 `$(…)` 或反引号。丢弃输出的 `>/dev/null`、`2>/dev/null`、`&>/dev/null` 与 `2>&1` 不算重定向。
- 引号都已闭合，且命令长度不超过 2048 个字符。
- 名单内的命令带上会写文件或执行程序的参数时，该段 MUST NOT 算只读：`git diff` / `git log` / `git show` 带 `--output`，`rg` 带 `--pre`，`sed -n` 的脚本不是单纯的行号区间打印（如 `1,80p`、`$p`），`file` 带 `-C` / `--compile`。

评审待处理标记存在时，访问本机 Dashboard 控制面或其凭据的命令 SHALL 在只读判定之前被拦截，组合成只读形态也一样。

评审待处理标记存在时，形如 `tenon transition <change> <event>` 的单条命令（不含任何 shell 元字符）SHALL 交给 CLI 判定：CLI 照旧拒绝缺少已批准回执的前进边与上限用完后的回退边，只放行轮次内的回退边。

#### Scenario: Repository inspection continues while a decision is pending

- **GIVEN** a fresh pending interaction marker
- **WHEN** the agent runs `rg`, `git diff`, `tenon status`, or another
  declared read-only inspection
- **THEN** the gate allows the inspection without clearing the marker.

#### Scenario: 只读组合命令在待处理期间放行

- **GIVEN** 一个新鲜的评审或交互待处理标记
- **WHEN** agent 执行 `git status --short | grep -v "^M  \|^A  "`、`cd sub && ls`、`rg x . 2>/dev/null | head -5`
- **THEN** 门禁放行，标记保持不变

#### Scenario: A write disguised in a shell chain is blocked

- **GIVEN** a fresh pending interaction marker
- **WHEN** a shell action combines a read command with redirection, command
  substitution, or an unclassified command
- **THEN** the whole action is classified non-read-only and remains blocked.

#### Scenario: 名单内命令的写入形态被拦

- **GIVEN** 一个新鲜的待处理标记
- **WHEN** agent 执行 `git diff --output=x`、`rg --pre ./run.sh x .`、`sed -n 'w out' f`、`file -C -m magic`，或 `cat a | sh`、`ls; touch y`、`echo "$(id)"`
- **THEN** 整条命令判为非只读并被拦截

#### Scenario: Canonical transition still requires its receipt

- **GIVEN** a pending review for one exact forward event
- **WHEN** a caller attempts that forward transition
- **THEN** the CLI refuses it until the matching approval receipt exists
- **AND** read-only inspection remains available.

#### Scenario: 待处理的前进评审期间直接回退

- **GIVEN** `verify-pass` 的评审请求待确认，verify 步轮次未用完
- **WHEN** 用户要求回去修改，agent 执行 `tenon transition <change> verify-fail`
- **THEN** 门禁放行这条命令，CLI 完成回退
- **AND** 本任务的评审待处理标记被清除

## ADDED Requirements

### Requirement: 成功转换 SHALL 清除本任务的评审待处理标记

任何一次成功的转换都会消费并清空本任务的评审回执，所以转换提交之后，绑定本任务的评审待处理标记 SHALL 被删除。

- 删除 SHALL 发生在 CLI 与 Dashboard 共用的转换用例里，提交之后执行；删除失败 MUST NOT 回滚转换，只输出一行警告，说明标记会在有效期过后失效。
- 只删除绑定本任务的标记，MUST NOT 删除其他任务的标记。

#### Scenario: 升级前遗留的回退边评审请求

- **GIVEN** 升级前已经对 `verify-fail` 发起评审请求，标记仍在，轮次未用完
- **WHEN** 用户确认后执行 `tenon transition <change> verify-fail`，或直接执行它
- **THEN** 转换成功，标记被删除，之后的写类工具不再被它拦截

#### Scenario: 不碰其他任务的标记

- **GIVEN** 项目根上的评审标记绑定的是另一个任务
- **WHEN** 本任务完成一次转换
- **THEN** 那个标记保持不变

### Requirement: 拦截提示 SHALL 按待处理标记的种类说明解封方式

门禁拦下一个动作时，提示 SHALL 按拦住它的标记种类说明怎样解封：

- 评审标记的提示 SHALL 写明任务与事件，要求把产出与结论摆给用户，并列出 hook 实际接受的放行语与 Dashboard 确认；MUST NOT 声称 AskUserQuestion 完成即可解封，MUST NOT 暗示 agent 可以自己确认。
- 确认与交互标记的提示 SHALL 继续说明用 AskUserQuestion 提问（Claude Code 先用 ToolSearch 载入）与放行语。
- 每条提示 SHALL 说明只读工具与只读组合命令在等待期间不受拦截。
- 提示里列出的放行语 SHALL 与 hook 实际接受的完全一致。

#### Scenario: 评审标记拦下写操作

- **GIVEN** 本任务 `explore-complete` 的评审待确认
- **WHEN** agent 调用 Write
- **THEN** 提示写明任务名与 `explore-complete`，列出放行语与 Dashboard 确认
- **AND** 提示不含「AskUserQuestion」解封的说法

#### Scenario: 交互标记拦下写操作

- **GIVEN** 本会话有待处理的交互标记
- **WHEN** agent 调用 Write
- **THEN** 提示说明调用 AskUserQuestion 提问，以及没有提问工具时的放行语
