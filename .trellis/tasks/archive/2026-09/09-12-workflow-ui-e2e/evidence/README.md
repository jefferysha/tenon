# 真实 UI E2E 验收证据

日期：2026-09-12

环境：`TENON_DASHBOARD_PORT=18766 node packages/server/dist/dashboard.mjs`，临时项目 `/tmp/tenon-e2e-VaqPb5`（测试完成后已删除）。浏览器使用 Codex In-app Browser 单一实例。

## 浏览器验收

- `default`：真实打开 Workflows 页面，拖拽“调研”到“立项”之前。界面显示“有未解决的问题，不能保存”，保存按钮保持禁用；这是治理规则对非法顺序的真实阻断，证据见 `default-drag-invalid.png`。
- `default`：真实编辑首阶段名称 `立项` → `立项验证`，点击保存，刷新页面后再次打开 `default`，名称和 7 个阶段顺序保持一致，证据见 `default-saved.png` 与 `default-saved.md`。
- 新 workflow：通过“更多 → 新建工作流 → 空白”创建 `new-e2e-ui`；真实点击添加阶段，输入并保存两个阶段名称 `准备`、`验证`；真实拖拽 `验证` 到 `准备` 之前；点击保存后状态显示“已保存”，证据见 `new-workflow-saved.png`。
- 保存后的定义接口确认顺序为 `verify(验证) → stage-1(准备)`，见 `api-new-e2e-ui.json`。清理后接口确认测试 workflow 已删除且 default 恢复内建来源，见 `api-after-cleanup.json`。

## 真实运行

`workflow-runs.log` 保存了 CLI 对两个临时 change 的真实输出：

- `e2e-default`（track `chat`）：状态可读取；`check` 被真实治理门禁阻断，原因是 tasks.md 未勾选以及 proposal、openspec-design、tasks 三份 canonical document 未登记。没有伪造通过结果。
- `e2e-new`（track `free`，workflow `new-e2e-ui`）：`check` 返回 `[PASS] 所有检查通过`；`advance --through-gates` 从 `verify` 走到 `stage-1`，随后真实停在终态“无后继事件”。

## 补充测试

- `npx tsc --noEmit -p packages/dashboard-app --pretty false`：通过。
- `npm run test:web`：47 个测试文件通过，`651/652` 个测试通过；唯一失败是既有 `workflowModel.test.tsx` 对 `step-no-output` 诊断的旧期望与当前 lint 行为不一致。此次 UI E2E 相关的 App 深链和 i18n 失败已修复。
