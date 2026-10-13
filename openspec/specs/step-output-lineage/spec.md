# step-output-lineage Specification

## Purpose
运行时观察步骤产出与来源技能、直接上游交接、读取回执、按路径的必须产出守卫。

现行文档机制在工作流里预先写死每一步的输入、输出文档，并规定「哪个技能必须交哪份文档」，与技能的实际行为脱节。

## Requirements
### Requirement: Tenon SHALL 在离开步骤时记录本次步骤访问的产出

冻结计划里没有旧文档契约的任务，在经任一条边离开当前步骤时，系统 SHALL 把工作区与这次步骤访问开始时记下的检查点比较，把这次访问里内容发生变化的每个文件记为步骤产出，并标明新增、修改或删除。比较 SHALL 在转换持有的任务锁内、所有离开条件通过之后、转换提交之前进行，并按步骤访问身份幂等。被 git 忽略的文件、任何一段以 `.pipeline` 开头的路径、`.tenon/` 等 Tenon 与宿主集成目录、其他任务的目录以及本任务目录下直接的点文件 MUST NOT 被观察。访问期间 HEAD 移动时，只有不被上游引用包含的提交改动过的文件才是候选。项目不是 git 工作区、git 命令失败、这次访问没有检查点或改动超过上限时，系统 SHALL 把这次访问记为 `unavailable` 或 `truncated`，且 MUST NOT 因观察失败而拒绝转换。

#### Scenario: 离开调研步时记下写出的文档

- **GIVEN** 一个新建的后端轨道任务处在调研步，项目是 git 工作区
- **WHEN** 调研步写出 `docs/superpowers/specs/demo-design.md`、修改了 `CONTEXT.md`，然后离开调研步
- **THEN** 这次调研访问的产出包含新增的设计文档与修改的 `CONTEXT.md`
- **AND** 产出里没有任何 `.pipeline` 开头的状态文件

#### Scenario: rebase 带进来的上游改动不算本步产出

- **GIVEN** 实现步期间任务分支被 rebase 到一个改过 `README.md` 的上游提交
- **WHEN** 离开实现步
- **THEN** `README.md` 不在实现步的产出里，除非本任务自己也改了它

#### Scenario: 非 git 项目照常转换

- **WHEN** 一个不在 git 工作区里的任务离开某一步
- **THEN** 这次访问记为 `unavailable`、没有产出
- **AND** 转换照常完成

#### Scenario: 升级前创建、没有检查点的任务从下一步开始观察

- **GIVEN** 升级前创建、冻结计划里没有文档契约的任务，当前访问没有检查点
- **WHEN** 它离开当前步骤
- **THEN** 这次访问记为 `unavailable`，转换照常完成
- **AND** 下一次访问有检查点，离开时正常记录产出

### Requirement: 步骤产出 SHALL 带尽力推断的来源技能

每个新增或修改的产出 SHALL 记下来源技能：同一次步骤访问里加载时间不晚于该文件修改时间的最后一个技能，编排技能 `tenon` 除外，按秒比较。推断不出时以及删除的产出 SHALL 记为「未知」。hook SHALL 只记录技能加载时间，MUST NOT 登记产出。

#### Scenario: 两个技能先后写出的文件各自标注

- **GIVEN** 调研步先加载 brainstorming，之后写出设计文档，再加载 domain-modeling，之后写出 `docs/adr/0001-x.md`
- **WHEN** 离开调研步
- **THEN** 设计文档的来源是 brainstorming，ADR 的来源是 domain-modeling

#### Scenario: 先于任何技能加载写出的文件来源未知

- **WHEN** 一个文件在本次访问的任何技能加载之前就被修改
- **THEN** 它的来源记为「未知」

### Requirement: 下一步 SHALL 只收到直接上游的文档产出并全部读完

当前步骤访问的交接输入 SHALL 是转入它的那次步骤访问（同一 run、序号小 1）的产出里，新增或修改、扩展名为 `.md`、`.mdx` 或 `.markdown`、且现在仍存在的文件。`tenon document read <change> all` 或给出一个输入路径 SHALL 以文件当前内容的 sha256 写下读取回执。当前访问里有某个输入的回执，且回执摘要等于上游记下的摘要或文件当前的摘要时，该输入算读过。只要有输入没读，除放弃边以外的所有离开边 SHALL 被拒绝，阻断码为 `input-unread`；`tenon status`、`tenon check`、CLI 转换与 Dashboard 转换口径一致。

#### Scenario: 规格步只读调研步的产出

- **GIVEN** 立项步产出了 `proposal.md`，调研步产出了设计文档并修改了 `proposal.md`
- **WHEN** 任务进入规格步
- **THEN** `read-documents` 只列出调研步产出的设计文档与 `proposal.md`
- **AND** 不列出只在立项步产出、调研步没有改过的文件

#### Scenario: 代码文件不是交接输入

- **WHEN** 实现步产出了源代码文件与一份修改过的 Markdown 文档
- **THEN** 验证步的交接输入只有那份 Markdown 文档

#### Scenario: 没读完不能离开

- **WHEN** 当前步骤还有未读的交接输入时执行前进或回退转换
- **THEN** 转换被拒绝，并点名未读的文件与修复命令
- **AND** 放弃边（`scope-expanded`）不受这条限制

#### Scenario: 读过后再修改不需要重读

- **WHEN** 当前步骤读过一个输入之后又修改了它
- **THEN** 该输入仍算读过
- **AND** 修改成为本步的产出

### Requirement: 工作流 SHALL 只用按路径的必须产出约束文档

步骤或出边 MAY 声明守卫 `{ type: required-output, path: <模式> }`，模式支持 `{change}` 占位与 `*`、`**`、`?` 通配。观察可用时，本 run 里这一步的任一次访问（含当前访问的实时比较）产出过匹配的新增或修改文件、且该文件现在存在，守卫 SHALL 通过；观察不可用时，存在匹配的文件即通过。空串、绝对路径、含 `..` 或未知占位符的模式 SHALL 在校验时被拒绝。

#### Scenario: 缺设计文档不能离开调研步

- **WHEN** 后端任务的调研步没有写出任何匹配 `docs/superpowers/specs/*.md` 的文件就尝试离开
- **THEN** 出口阻断说明本步须产出匹配该路径的文件

#### Scenario: 已有的旧文件不算本任务的产出

- **GIVEN** `docs/superpowers/specs/` 下已有其他任务留下的设计文档
- **WHEN** 本任务的调研步没有新增或修改其中任何文件
- **THEN** 必须产出守卫不通过

#### Scenario: 重回规格步不要求重写

- **GIVEN** 规格步第一次访问产出了计划文档
- **WHEN** 任务经 `requirements-changed` 回到规格步后再次离开
- **THEN** 计划文档的必须产出守卫通过

### Requirement: 文档机制 SHALL 与规范方法无关

产出观察、交接输入、读取回执与必须产出 SHALL 对 `spec: openspec`、`spec: none` 的轨道与没有分支的自定义工作流同样生效；`spec: openspec` SHALL 只决定 OpenSpec 自己的规格校验、应用与归档收尾。

#### Scenario: Spec Kit 风格的工作流

- **GIVEN** 一个平铺自定义工作流，步骤为 specify、plan、tasks、implement，`spec: none`，必须产出分别是 `specs/*/spec.md`、`specs/*/plan.md`、`specs/*/tasks.md`
- **WHEN** specify 步写出 `specs/001-demo/spec.md` 并离开
- **THEN** 该文件记为 specify 的产出，plan 步的交接输入就是它
- **AND** plan 步没写出 `specs/*/plan.md` 时不能离开

### Requirement: CLI SHALL 投影观察到的文档并不再下发预定义的文档动作

观察模式任务的 `tenon status --json` 中，`step.documents` SHALL 为 `{ mode: "observed", observation, inputs: [{ path, from_step, skill, status }], outputs: [{ path, change, skill }], required: [{ path, status }] }`；`next` SHALL 为未读输入下发 `read-documents`，MUST NOT 下发 `scaffold-document`、`record-document` 或 `register-field`。`tenon document scaffold`、`record`、`migrate-delta`、`init` 在观察模式 SHALL 以退出码 2 拒绝并说明产出由 Tenon 自动记录。测试报告动作 SHALL 从当前步骤前进边上唯一不含通配符的必须产出取得验证报告路径。走 OpenSpec 的任务 SHALL 在本步有指向 `openspec/changes/<change>/specs/` 的必须产出时下发规格校验，在本步离开条件含 `spec-migration-applied` 时下发规格应用。

#### Scenario: 新任务的规格步动作

- **WHEN** 新建后端任务进入规格步，交接输入已读完
- **THEN** `next` 不含 `scaffold-document`、`record-document` 与 `register-field`
- **AND** `step.documents.required` 列出 delta spec 与计划的路径模式及其满足状态

#### Scenario: 观察模式下旧命令被拒

- **WHEN** 对观察模式任务执行 `tenon document record <change> proposal <path> --producer openspec-propose`
- **THEN** 命令以退出码 2 结束，说明产出由 Tenon 在离开步骤时自动记录

#### Scenario: 交付步仍下发规格应用

- **WHEN** 新建后端任务进入交付步且 delta spec 尚未应用
- **THEN** `next` 下发 `apply-spec`

