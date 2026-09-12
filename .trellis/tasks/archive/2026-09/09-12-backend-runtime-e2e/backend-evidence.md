# 真实后端任务运行证据

日期：2026-09-12

环境：构建后的 `packages/server/dist/dashboard.mjs` 监听 `127.0.0.1:18767`；临时项目 `/tmp/tenon-backend-e2e`；CLI 使用当前仓库 `packages/cli/dist/tenon.mjs`。

## 实际执行

1. 通过真实 HTTP `POST /api/projects` 注册临时项目。
2. 通过真实 CLI 初始化 `backend-task`，使用项目内 `backend-e2e` workflow。
3. `status` 读取到 `prepare (pending)`。
4. `check backend-task` 返回 `[PASS] 所有检查通过`。
5. `advance --through-gates backend-task` 真实推进：`prepare -> execute`，随后在 execute 终态停止。
6. `workflow plan backend-task --json` 返回 frozen snapshot、当前阶段 `execute` 和完整两阶段定义。
7. AFK 真实尝试：`enqueue` 因 workflow 未授权自动化而返回 exit 3；`run` 真实返回“就绪队列空”。这证明自动化门禁生效，没有伪造后台执行。

完整 CLI 输出见 `backend-run.log`，HTTP/API 输出见 `backend-api.log`。

## 产物结果

该临时 workflow 没有声明 skill 或 outputs，因此没有生成 stage attempt，也不能构造 artifact catalog。调用 artifact catalog 接口得到真实错误“缺少合法 stageAttemptId/stageId”，记录在 `backend-api.log`；这验证了系统不会伪造运行时产物。

## 清理与检查

- 后端服务已停止。
- 临时项目已删除。
- `npx tsc -b packages/kernel packages/automation packages/cli packages/server --pretty false`：通过。
- 原工作区其他未提交改动未清理或覆盖。
