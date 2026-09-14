# Implement

1. 建立 35 条违规的逐条清单和每个文件的公开导出/测试依赖。
2. 第一批收敛 workflow identity：kernel helper、automation、server、dashboard、CLI 统一入口，逐条删除无理由比较。
3. 第二批移除 7 个生产非空断言，并为 `undefined`、损坏输入和缺失记录保留稳定错误语义。
4. 第三批拆分 automation、dashboard、kernel 超长文件；每拆一个文件先跑其旁边的测试和 typecheck。
5. 第四批把 `global-store` 的 Node I/O 移到 infrastructure adapter，验证全局/项目 workflow 回退和 symlink 防线。
6. 第五批复核 CLI `get`、OpenSpec/Trellis 记录、公开导出和构建产物。
7. 运行 architecture、全量测试、web typecheck、bundle/server build 及相关 hooks/adapters 门禁。

## Required manifests

`implement.jsonl` 记录跨层拆分与导出边界规范；`check.jsonl` 记录复用、架构门禁和跨层验证规范。两份 manifest 必须在 `task.py start` 前保留真实条目。

## Rollback points

每一批以独立文件集合回滚；不修改 architecture checker 的阈值或 allowlist 以获得假绿，不回滚本轮已通过的 PM artifact、stable-hook、CI 和文档修复。

## 验收记录（2026-09-13）

- `node tools/check-architecture.mjs`：通过；扫描 854 个生产文件，runtime edges 626、runtime SCC 0，type-only SCC 1，保留的 5 个 size-only exception 均为既有配置/协议文件。未增加无期限 baseline，也未降低阈值。
- workflow identity 已统一走 kernel `isDefaultWorkflowName`；7 个生产非空断言已改为显式收窄/错误路径；planner/runtime/parse 与 dashboard SkillFlow 已按职责拆分，global-store Node I/O 已下沉到 infrastructure adapter。
- Dashboard 的工作流身份谓词通过显式 `@tenon/kernel/workflow/identifier` 公共子路径导出，避免浏览器包加载 Node 专用根 barrel；`npm run build:web` 成功。
- `npm run build:packages`、`npm run build:server`、`npm run bundle`、`npm run typecheck:web`、`npm run test:web`（48 files / 653 tests）和 `npm run check:dashboard-dist-freshness` 均通过。
- 根级 `npm test -- --reporter=dot`：438 files / 7131 tests passed，15 个 honest-skip，0 失败；前端测试并发运行时仅有既有 React `act(...)` stderr 警告，无失败。
