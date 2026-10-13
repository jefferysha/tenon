# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: 工作流页 SHALL 展示轨道设置与离开条件

Dashboard 工作流页的轨道设置 SHALL 可修改该分支的规范（`openspec` / `none`）与路由关键词；排除词、优先级与自动化开关 MUST 只在 YAML 中修改。门禁段 SHALL 只读列出该步的离开条件，每条一行，`required-output` 守卫显示为「必须产出 <路径模式>」。工作流页 MUST NOT 显示或编辑每步的输入输出表与文档契约。技能 SHALL 只来自工作流 YAML，系统 MUST NOT 再把 manifest 技能矩阵叠加到步骤上。

#### Scenario: 在页面上让新工作流参与路由

- **WHEN** 用户在轨道设置里为分支填写关键词并保存
- **THEN** 工作流文件写入 `route.keywords`，路由在下一条消息生效

#### Scenario: 离开条件只读展示

- **WHEN** 用户查看 default 后端轨道的实现步
- **THEN** 门禁段列出「实现前评审通过」「本阶段任务已勾选」「依赖任务已结束」等离开条件，且没有编辑控件

#### Scenario: 必须产出列在门禁段

- **WHEN** 用户查看 default 后端轨道的调研步
- **THEN** 门禁段列出「必须产出 docs/superpowers/specs/*.md」
- **AND** 页面上没有输入表与输出表
