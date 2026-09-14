# Implement

1. 评估并接入/删除 orchestration-v2。
2. 改 browser e2e 配置并安装 CI 浏览器。
3. 修 npm test 自举和包管理器文档/门禁。
4. 运行 clean checkout、Playwright、test:web。

## 实际收口

- 旧 `tests/e2e/orchestration-v2.spec.ts` 依赖已退役视图和选择器，真实执行失败后删除该孤立配置与套件；当前 `workflowRuntime.browser.e2e.test.ts` 使用 Playwright 自带 Chromium，并由 CI 显式安装。
- `npm test` 通过 `pretest` 先构建 packages；CI 继续校验 CLI/server bundle，并新增 dashboard dist 引用/未跟踪资产检查。
