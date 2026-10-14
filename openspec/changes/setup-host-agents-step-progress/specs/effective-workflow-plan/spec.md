# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 终端步骤清单 SHALL 由 hook 按 effective plan 打印，不依赖宿主 Todo 工具

CLI SHALL 提供 `tenon workflow progress <change>`，输出一行步骤清单：按任务冻结计划 `projection.steps` 的顺序列出步骤标签，
当前步之前标 `✓`、当前步标 `●`、之后标 `○`，任务已归档时全部标 `✓`，步骤之间以 ` → ` 连接。PostToolUse hook `step-progress`
SHALL 在 Bash 类工具成功执行包含 `tenon init`、`tenon session activate`、`tenon transition` 或 `tenon step run` 且带任务名的
命令后，用 hook 输出的 `systemMessage` 打印 `Tenon · <change>` 与该清单；其余工具调用与命令 SHALL 不产生输出。hook 在任何异常
下 SHALL 以退出码 0 结束且不产生输出。Claude Code 与 Codex SHALL 使用同一份 `hooks/hooks.json` 注册。skill SHALL 只在宿主提供
Todo 工具时要求模型建立 Todo。

#### Scenario: 流转后打印清单

- **WHEN** 默认工作流的任务 `demo` 从调研流转到规格，`tenon transition demo explore-complete` 成功
- **THEN** 终端出现 `Tenon · demo` 与 `立项 ✓ → 调研 ✓ → 规格 ● → 实现 ○ → 验证 ○ → 交付 ○ → 完结 ○`

#### Scenario: 自定义短工作流

- **WHEN** 任务使用只有 `shape`、`implement`、`verify` 三步的工作流，当前步为 `implement`
- **THEN** `tenon workflow progress <change>` 只列出这三步，`shape` 为 `✓`、`implement` 为 `●`、`verify` 为 `○`

#### Scenario: 归档后全部完成

- **WHEN** 任务已归档
- **THEN** `tenon workflow progress <change>` 中每一步都标 `✓`

#### Scenario: 无关命令不打印

- **WHEN** Bash 工具执行 `git status` 或 `tenon status demo --json`
- **THEN** `step-progress` hook 不输出任何内容

#### Scenario: 失败的流转不打印

- **WHEN** `tenon transition demo bad-event` 以非零退出码失败
- **THEN** 终端不出现步骤清单
