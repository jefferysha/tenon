# Design

Playwright config 是浏览器和 testDir 单一入口；CI job 显式安装浏览器。测试前置生成所需 dist 或改源码入口，避免依赖开发者本地构建残留。npm/pnpm 只保留一个受支持安装路径，Node engines 与 CI 均为 22+。

## E2E 套件决策

删除 `tests/e2e/orchestration-v2.spec.ts` 及其孤立的 Playwright 配置。该套件依赖已退役的视图与测试标记，继续保留会制造假覆盖；当前浏览器级运行时验证由 `packages/server/src/workflowRuntime.browser.e2e.test.ts` 保留并在浏览器可用时执行。
