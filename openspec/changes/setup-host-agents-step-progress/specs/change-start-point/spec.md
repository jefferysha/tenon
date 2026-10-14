# OpenSpec 增量规格

## ADDED Requirements

### Requirement: 任务起点 SHALL 在建任务时记录并跟随上游前进

`tenon init` 以及 Dashboard 与 triage 的建任务路径 SHALL 把建任务时检出的 HEAD 提交写入状态字段 `start_sha`（字段追加在字段表
末尾；仓库还没有提交时不写，该键不出现）。
任务起点 SHALL 从以下候选中取最新的一个：`start_sha`（是 HEAD 的祖先、且该提交的提交者时间不晚于 `created_at` 加 60 秒时；
不满足时不作候选，只会让改动范围变宽）、`merge-base(HEAD, <base_branch> 的上游跟踪分支)`
（上游存在时）、`merge-base(HEAD, <base_branch>)`（不等于 HEAD 时）。候选之间互为祖先时取后代；分不出先后时 SHALL 取它们的
共同祖先，只允许多算、不允许漏算。没有任何候选时 SHALL 退回「`created_at` 之前最后一个提交」的现有规则。起点 SHALL NOT 依据
提交信息或作者推断归属。

#### Scenario: 上游拉进来的提交不算本任务的

- **WHEN** 任务在 `main` 上原地建立并有未提交的改动，之后 `git pull` 快进拉入另一个任务已合并的提交（其中改了测试文件与
  `.tenon/tests/catalog.yaml`）
- **THEN** 本任务的改动文件列表只含本任务未提交的改动
- **AND** `catalog.yaml` 不出现在本任务待批准的受保护测试配置里

#### Scenario: 建任务前已有的本地提交不算

- **WHEN** 本地 `main` 比上游多一个提交 C，之后在该检出建任务
- **THEN** 起点不早于 C，C 的改动不出现在本任务的改动里

#### Scenario: 本任务自己的本地提交仍算

- **WHEN** 任务建立后在当前分支上提交了自己的改动，尚未推送
- **THEN** 这些提交改动的文件仍在本任务的改动里

#### Scenario: 原地任务推送到 base 上游后的已知限制

- **WHEN** 原地任务在 base 分支上提交了自己的改动，并把它们推送到该分支的上游
- **THEN** 这些提交不再算本任务的改动（起点前移到上游）
- **AND** worktree 任务不受此影响：其 `base_branch` 是来源分支，任务分支的提交在合并前不在来源分支的上游里

#### Scenario: 旧任务没有 start_sha

- **WHEN** 任务状态里没有 `start_sha`，HEAD 所在分支有上游且与上游一致
- **THEN** 起点为上游的 merge-base，建任务后拉进来的提交不算本任务的

#### Scenario: 既无记录也无上游

- **WHEN** 任务没有 `start_sha`，仓库没有上游跟踪分支，HEAD 就在 base 分支上
- **THEN** 起点仍是 `created_at` 之前的最后一个提交，建任务后在该分支上的提交算本任务的

### Requirement: 所有按起点比对改动的地方 SHALL 使用同一份起点

测试文件登记与同步、受保护测试配置审批与其展示、测试完整性、改动风险探针、评审者按路径挂载、改动行覆盖率、证据导出、CLI 与
HTTP 流转门、Dashboard 快照与 `tenon verify --ci` SHALL 通过同一个起点解析入口取得起点，SHALL NOT 各自另算。起点解析失败时 SHALL 沿用现有的失败关闭
语义。

#### Scenario: CLI 与 Dashboard 看到同一份改动

- **WHEN** 同一任务分别由 `tenon status --json` 与 Dashboard 快照读取改动文件与待批准的受保护配置
- **THEN** 两者列出的文件集合相同

### Requirement: 决定起点的字段 SHALL 只能由建任务写入

`start_sha`、`base_branch` 与 `created_at` SHALL 只由 `tenon init` 写入；`tenon set`、`tenon set-many` 与 `tenon cas` SHALL 拒绝写这三个
字段并说明它们由建任务管理，状态保持不变。

#### Scenario: 改写起点被拒

- **WHEN** 执行 `tenon set demo start_sha <当前 HEAD>` 或 `tenon set demo created_at 2030-01-01T00:00:00Z`
- **THEN** 命令以非零退出码结束，`start_sha` 与 `created_at` 保持原值
