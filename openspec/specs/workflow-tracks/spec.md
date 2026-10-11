# workflow-tracks Specification

## Purpose
一个工作流内用轨道表达轻重与领域；轨道级规范、路由与自动化设置；default 按 YAML 执行；评估与升级；任务结束与归档；工作台「已结束」。

## Requirements
### Requirement: 轨道 SHALL 只作为工作流的分支存在

系统 SHALL 把轨道定义为工作流 YAML 中 `tracks.<id>` 的分支，轨道身份 MUST 是「工作流 + 轨道 id」。分支 SHALL 可选声明 `spec`（`openspec` 或 `none`，不写时继承工作流顶层 `openspec`）、`route`（`keywords`、`exclude`、`priority`、`fallback`）与 `automation`（`eligible`、`enqueue_after_spec`）。没有 `tracks:` 的平铺工作流 SHALL 被视为只有一个隐式轨道。系统 MUST NOT 再读取内建轨道登记表或项目 `.pipeline/tracks.yaml`；`tenon tracks` SHALL 列出所有可用工作流的分支。

#### Scenario: 按工作流与轨道解析分支

- **WHEN** `tenon init` 以 `--workflow default --track backend` 建任务
- **THEN** 任务冻结 `default` 工作流 `backend` 分支的步骤、规范与自动化设置
- **AND** 不查询任何独立的轨道登记表

#### Scenario: 平铺工作流不需要指定轨道

- **WHEN** 用户以 `--workflow design-system` 建任务且不传 `--track`
- **THEN** 任务使用该工作流的唯一隐式轨道创建成功

#### Scenario: 轨道不存在时列出可选轨道

- **WHEN** 用户以 `--workflow default --track chat` 建任务
- **THEN** 命令失败并列出 `default` 的可选轨道（轻量、产品、前端、后端）
- **AND** 不创建任务目录

#### Scenario: 旧轨道文件被忽略并提示迁移

- **WHEN** 项目存在 `.pipeline/tracks.yaml`
- **THEN** 路由与建任务都不读取它
- **AND** 系统输出一行提示，说明把轨道写进工作流分支的迁移方法

### Requirement: 内建工作流 SHALL 只有 default 与 design-system

系统 SHALL 只内建 `default` 与 `design-system` 两个工作流。`default` SHALL 提供轻量（`lite`）、产品（`pm`）、前端（`frontend`）、后端（`backend`）四个轨道，MUST NOT 再提供「对话」「自由」轨道，也 MUST NOT 再内建 `standard`、`simple` 工作流。

#### Scenario: 旧工作流名给出替代命令

- **WHEN** 用户执行 `tenon init <c> --workflow standard` 或 `--workflow simple`
- **THEN** 命令失败，并提示改用 `--workflow default --track lite`

#### Scenario: 工作流列表

- **WHEN** Dashboard 或 CLI 列出内建工作流
- **THEN** 只出现 `default` 与 `design-system`

### Requirement: default 工作流 SHALL 按 YAML 执行

新建的 `default` 任务 SHALL 与其他工作流一样按工作流 YAML 的步骤、出边、离开条件与动作执行，MUST NOT 依赖按工作流名或阶段名写死在代码里的转换表、事件策略或阶段出口规则。工作流 SHALL 提供三个通用离开条件：截至本步的 tasks.md 任务已勾选、任务未在 AFK 队列中、`depends_on` 的任务已结束。离开条件不满足时，转换 SHALL 一次列出全部未满足的条件并以退出码 2 拒绝。

#### Scenario: 实现前评审未通过时离开实现步

- **WHEN** 后端轨道任务在实现步执行 `build-complete`，而 `pre_verify_review_result` 不是 `pass` 且仍有未勾选任务
- **THEN** 转换被拒绝，退出码 2
- **AND** 输出同时列出这两条未满足的离开条件

#### Scenario: AFK 排队中的任务不能被手动推进

- **WHEN** 任务处于 AFK 排队状态时，有人在 AFK 运行器之外执行 `build-complete`
- **THEN** 转换被拒绝，并指出任务正在排队

#### Scenario: 依赖任务未结束

- **WHEN** 任务的 `depends_on` 指向一个仍在进行中的任务时执行 `build-complete`
- **THEN** 转换被拒绝，并点名该依赖任务

#### Scenario: advance 只走唯一的前进边

- **WHEN** 当前步骤有一条前进边与一条回退边，且前进边的离开条件全部满足时执行 `tenon advance`
- **THEN** 系统走前进边，不走回退边

#### Scenario: 已删除的检查不再阻断

- **WHEN** 任务进入实现步
- **THEN** 系统不要求设置 `build_mode`、`isolation`、`direct_override`
- **AND** 验证步不要求设置 `branch_status`，规格步不要求设计文档中的 coverage 块

### Requirement: 旧执行模型的在途任务 SHALL 按快照走完

工作流快照记录旧执行模型（phase-manifest）的任务 SHALL 继续按旧规则执行直到结束；只有新建任务使用按 YAML 执行的计划。系统 MUST 在唯一的接缝处按快照的执行模型选择执行方式，MUST NOT 改写已冻结的快照。

#### Scenario: 升级后在途的 default 任务继续推进

- **GIVEN** 一个在升级前创建的 default 任务停在验证步
- **WHEN** 升级后执行 `verify-pass`
- **THEN** 转换按该任务快照里的旧规则判定
- **AND** 快照文件与工作流指纹保持不变

#### Scenario: 在途的 standard 任务走完

- **GIVEN** 一个升级前创建的 `standard` 任务停在实现步
- **WHEN** 升级后继续执行到 `done`
- **THEN** 每一步都按其快照执行，不因 `standard` 模板已删除而失败

### Requirement: 轻量轨道 SHALL 只有一道人工确认并在超限时升级

`default` 的轻量轨道 SHALL 由立项、实现、验证、完结与已升级组成，`spec` 为 `none`。实现步 SHALL 运行改动风险探针；探针超限时 MUST 只允许 `scope-expanded` 转到已升级。验证步 SHALL 是唯一的评审门。完结时 SHALL 只在当前分支本地提交，不推送、不开 PR。升级时，系统 SHALL 给出新建任务的命令，轨道沿用轻量任务创建时路由判定的领域；没有领域时 SHALL 列出前端、后端、产品让用户选择。

#### Scenario: 轻量任务完整走完

- **WHEN** 一个三文件缺陷修复在轻量轨道上完成实现与验证
- **THEN** 全程不超过 25 次 tenon 调用、2 次用户回复
- **AND** 完结后任务目录被归档，工作区改动以 `chore(tenon): finish <c>` 提交

#### Scenario: 探针超限后升级

- **WHEN** 轻量任务的实际改动触及鉴权路径
- **THEN** `next` 只给出 `scope-expanded`，任务结束为「已升级」并归档、不提交
- **AND** `escalate.then` 给出新建后端轨道任务并 `depends_on` 本任务的命令

### Requirement: 开发请求 SHALL 在建任务前评估轻重

系统 SHALL 提供 `tenon assess --files <paths…> [--workflow <w> --track <t>] --json`，用与该轨道改动风险探针完全相同的分类规则与阈值评估一组预计改动的文件，输出是否超限与理由。所选轨道没有改动风险阈值时 MUST 报错，不得猜测阈值。路由对既无点名、也无重型信号的开发请求 SHALL 在 dispatch 中标注需要评估，并给出「轻量 + 领域重型轨道」两个候选；agent SHALL 在 `tenon init` 前完成评估并由用户确认轨道，持续执行模式下采用评估的推荐。

#### Scenario: 评估与探针结论一致

- **WHEN** 对同一组文件分别运行 `tenon assess` 与实现后的改动风险探针
- **THEN** 两者给出相同的指标与是否超限的结论

#### Scenario: 点名轨道不评估

- **WHEN** 用户在消息里点名「用后端轨道」
- **THEN** dispatch 直接给出后端轨道，不要求评估

#### Scenario: 重型信号直接进重型轨道

- **WHEN** 请求包含数据库迁移
- **THEN** dispatch 直接给出领域重型轨道，不把轻量列为候选

### Requirement: 路由数据 SHALL 来自工作流分支

路由数据 SHALL 由所有可用工作流（项目、全局存储、插件模板）中带 `route` 的分支生成；工作流文件内容变化 MUST 使路由缓存失效，保存工作流后的下一条消息即按新数据路由。最高分并列、或最高分落在非内建工作流的分支时，dispatch SHALL 标注需要用户选择并列出候选「工作流 + 轨道」。被排除词挡掉且没有其他分支认领的开发请求 SHALL 落到声明了 `route.fallback: true` 的分支。

#### Scenario: 新保存的工作流参与路由

- **WHEN** 用户在全局存储保存一个分支带关键词的自定义工作流
- **THEN** 不修改任何技能文本，下一条命中这些关键词的消息就把该分支列为候选，并要求用户选择

#### Scenario: 兜底分支

- **WHEN** 一个开发请求只命中轻量轨道的排除词且没有其他分支得分
- **THEN** dispatch 给出 `default` 中声明 `fallback` 的后端轨道

### Requirement: 任务结束 SHALL 一律归档并记录任务结果

任务结束 SHALL 只经 `tenon task finish <c>` 或 `tenon task terminate <c>` 完成，任务结果 MUST 是完结、已升级或已终止之一，并在移动前写入任务状态。所有结果 SHALL 把任务目录移进 `openspec/changes/archive/<YYYY-MM-DD>-<name>/`：`spec: openspec` 的轨道由 Tenon 调用 `openspec archive <c> --skip-specs --yes --json`；`spec: none` 的轨道由 Tenon 在锁内原子移动目录。`next` 的 `finish-change` SHALL 对所有轨道给出 `tenon task finish <c>`。`terminate` SHALL 只提交被归档的任务目录（`chore(tenon): terminate <c>`），不提交任务改过的代码。系统 MUST NOT 再提供按用户隐藏任务的能力；`tenon task archive`、`tenon task unarchive` SHALL 报错并提示改用 `terminate`。

#### Scenario: 终止一个未完成的任务

- **WHEN** 用户对一个停在调研步的任务执行 `tenon task terminate`
- **THEN** 任务结果记为「已终止」，目录移进 `openspec/changes/archive/`
- **AND** 只有该任务目录被提交，工作区里的其他改动保持未提交

#### Scenario: 不走 OpenSpec 的任务结束后通过 OpenSpec 校验

- **WHEN** 轻量任务完结并提交
- **THEN** 在提交后的树上运行 `check:openspec` 通过

### Requirement: 工作台 SHALL 在「已结束」中列出全部归档任务

工作台的任务分类 SHALL 为 全部、需要你、进行中、已结束。「已结束」SHALL 列出 `openspec/changes/archive/` 下的全部任务，卡片标出任务结果，按结束时间倒序；列表 MUST 只读取摘要字段并按归档目录缓存，点开时才加载只读详情。

#### Scenario: 已结束列表的性能

- **WHEN** 快照基准中的项目各带 60 个归档任务
- **THEN** 快照重建 p95 仍低于 1.5 秒

#### Scenario: 已终止任务出现在已结束中

- **WHEN** 一个任务被终止
- **THEN** 它从「进行中」消失，出现在「已结束」并标为「已终止」

### Requirement: 工作流页 SHALL 展示轨道设置与离开条件

Dashboard 工作流页的轨道设置 SHALL 可修改该分支的规范（`openspec` / `none`）与路由关键词；排除词、优先级与自动化开关 MUST 只在 YAML 中修改。门禁段 SHALL 只读列出该步的离开条件，每条一行。技能 SHALL 只来自工作流 YAML，系统 MUST NOT 再把 manifest 技能矩阵叠加到步骤上。

#### Scenario: 在页面上让新工作流参与路由

- **WHEN** 用户在轨道设置里为分支填写关键词并保存
- **THEN** 工作流文件写入 `route.keywords`，路由在下一条消息生效

#### Scenario: 离开条件只读展示

- **WHEN** 用户查看 default 后端轨道的实现步
- **THEN** 门禁段列出「实现前评审通过」「本阶段任务已勾选」「依赖任务已结束」等离开条件，且没有编辑控件

### Requirement: AFK 设置 SHALL 写在分支上

能否进入 AFK 与规格完成后是否自动入队 SHALL 由分支的 `automation.eligible` 与 `automation.enqueue_after_spec` 决定；`default` 的产品、前端、后端 SHALL 可进入 AFK，产品 SHALL 在规格完成后自动入队，轻量 MUST NOT 进入 AFK。AFK 自动修复建任务时 SHALL 按其所选轨道解析工作流计划。

#### Scenario: 自动修复任务的计划与轨道一致

- **WHEN** AFK triage 以 default 后端轨道创建自动修复任务
- **THEN** 任务冻结的计划来自 `backend` 分支，而不是工作流的第一条分支

