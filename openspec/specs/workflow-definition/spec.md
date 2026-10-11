# workflow-definition Specification

## Purpose

定义 Workflow definition 的闭集 codec、版本化 EffectiveWorkflowPlan snapshot 兼容性与不污染 fingerprint 的动态权限 overlay。
## Requirements
### Requirement: Workflow definition 闭集 codec

Workflow definition 顶层闭集 MUST 增加 `decomposition` 与 `interaction`，并在 parse、serialize、validate、compile 与 deep-freeze 中使用同一规范化契约。轨道分支的闭集 MUST 为 `label`、`document_contract`、`steps`、`spec`、`route`、`automation`；`spec` 只接受 `openspec` 或 `none`，不写时继承顶层 `openspec`。没有 `tracks:` 的工作流 MUST 编译为只有一个隐式分支。`default` MUST NOT 再被要求恰好包含七个规范阶段；只有 `spec: openspec` 的分支需要满足 OpenSpec 文档与规格步骤所需的结构。

#### Scenario: legacy definition

- **WHEN** 旧 definition 不含新字段
- **THEN** 编译为 decomposition.mode=off 与 interaction.mode=interactive
- **AND** 各分支的 `spec` 取顶层 `openspec` 的值

#### Scenario: round-trip

- **WHEN** 合法 v1 policies 完成 serialize -> parse -> compile
- **THEN** 规范化 IR 深等价且只读冻结

#### Scenario: 分支新键 round-trip

- **WHEN** 一个分支声明 `spec: none`、`route.keywords` 与 `automation.eligible: false` 并完成 serialize -> parse -> compile
- **THEN** 规范化 IR 保留这三项且深等价
- **AND** 分支中出现闭集之外的键时解析失败并点名该键

#### Scenario: default 含非七步分支

- **WHEN** `default` 的 `lite` 分支只有 open、build、verify、done、escalated 五个步骤
- **THEN** 存储校验与加载通过，其余分支照常可用

### Requirement: EffectiveWorkflowPlan 版本兼容

新 plan MUST 使用包含 policy 的新 fingerprint tag 和 V3 snapshot；V1/V2 MUST 用历史算法校验原 hash，再只读投影安全默认，不得原地重写。

#### Scenario: 旧 snapshot

- **WHEN** 读取合法 V1/V2 snapshot
- **THEN** 原 fingerprint 验证通过并投影 off+interactive，文件内容与 hash 不变

#### Scenario: V3 篡改

- **WHEN** snapshot policy 内容与 fingerprint 不一致
- **THEN** run resolve/admission 失败关闭

### Requirement: Track overlay 不污染 Workflow fingerprint

项目/track/run grants MUST 在运行期参与权限交集，但不得伪装成 Workflow-owned policy 或改变 definition fingerprint。

#### Scenario: 仅 track grant 改变

- **WHEN** Workflow IR 不变而 track grant 更新
- **THEN** Workflow fingerprint 不变，新 evaluation 的 effective grant 可降低或提高到 ceiling 内

