# 真实工作流编辑与运行 E2E 验证

## Goal

在真实 Dashboard 中验证 default workflow 编辑、新 workflow 创建重定义、点击拖拽保存及真实运行测试，并保留浏览器和测试证据

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
# 真实工作流编辑与运行 E2E 验证

## Goal

在真实 Dashboard 浏览器环境中验证 workflow 编辑器和运行时产物链路，而不是只依赖组件测试。

## In scope

- 打开真实 Dashboard，选择并编辑内建 `default` workflow。
- 通过真实点击、拖拽、输入和保存操作新建一个 workflow，并重新定义至少两个 stage 的顺序或依赖。
- 验证保存后重新加载仍保留定义，且工作流页面与阶段编辑 UI 一致。
- 对 default workflow 和新 workflow 各执行一次真实测试运行，记录运行状态、阶段变化和运行时产物面板。
- 保存浏览器截图、关键网络响应和测试输出，记录失败时的具体步骤。

## Out of scope

- 修改 workflow 产品代码或运行时协议。
- 修改用户现有 workflow、skill 文件或持久化数据；测试使用临时项目和临时 workflow 名称。
- 只用 mock API、组件 render 或静态截图代替真实交互。

## Acceptance criteria

1. Dashboard 能真实启动并打开工作流编辑页。
2. default workflow 至少一次真实拖拽/编辑/保存成功，刷新后定义一致。
3. 新 workflow 能通过 UI 创建、添加或调整 stage/skill、保存并重新打开。
4. 新 workflow 的阶段依赖或顺序在 UI 和保存后的定义接口中一致。
5. 两个 workflow 均完成真实运行测试；若运行受环境能力阻断，必须记录真实错误、阻断点和已验证部分。
6. 阶段详情显示真实运行状态和运行时产物查询结果，不伪造输出。
7. 交付浏览器截图、网络/终端日志和可复现步骤。

## Risks and evidence policy

- 当前工作区有大量并行未提交改动；测试必须使用临时项目，并不得清理或覆盖既有文件。
- 浏览器只能复用一个项目级浏览器实例，不得启动多个 owner 或操作用户日常 Chrome。
- 任何“通过”结论必须有真实点击结果、页面状态或命令输出支持；组件测试不能替代 E2E。

## Open questions

无。用户已明确要求真实点击拖拽、default workflow 和新 workflow 的端到端验证。
