# 贡献者开发指南

Tenon 是 npm workspace 项目，包含 Kernel、CLI、Server、Dashboard、hooks、skills、templates 和发布工具。修改前先读 `AGENTS.md` 与任务范围对应的 `.agent-rules`。

## 目标

在不破坏状态、证据、兼容和发行包的前提下完成一个可审查贡献，并提供从定向测试到全量构建、bundle、hooks、文档和真实浏览器的风险匹配证据。

## 前置条件

- Node.js 22；
- npm 与仓库 `package-lock.json`；
- Git；
- 修改 UI 时可用真实浏览器；
- 修改 AFK/sandcastle 时可用 Docker；
- 已明确本次是前端、后端、共享契约、文档还是发布流程变更。

## 步骤

### 1. 安装与构建

```bash
npm ci
npm run build
npm run test:all
```

不要用全局依赖掩盖 lockfile 缺失，也不要混用 pnpm、yarn 或 bun。

### 2. 遵守包边界

- Kernel：纯领域规则、状态、Workflow、document contract 和持久化原语；
- CLI：参数、I/O 和应用编排；
- Server：本地 API/SSE；
- Dashboard：React 本地控制面；
- templates/skills/hooks：随 release 分发的行为资产；
- docs-site：纯静态公共文档。

前端不得直接导入后端内部实现；跨包能力从提供方公开出口导出。持久化写入复用锁、CAS 和原子发布，不用普通覆盖写模拟事务。

### 3. 红—绿—重构

行为修改先增加会因目标缺陷失败的测试，运行确认红，再做最小实现使其绿，最后在测试保持绿色时重构。不得削弱断言来“修复”失败。

### 4. 同步分发资产

Workflow 改动必须更新 schema、codegen/freshness 和集成测试。文档模板以 `templates/documents` 为单一事实源，通过生成器产出 runtime registry；必须保持 `zh-CN`/`en` key parity、稳定 token、simple/custom 边界和历史不变。

### 5. 构建公共文档

```bash
npm run docs:sync
npm run docs:check
npm run docs:build
npm run docs:smoke
```

公开页面必须进入 manifest。内部 ADR、计划和 Change evidence 不得通过宽泛 glob 发布。

### 6. 做真实验收

UI 变更必须在当前构建的 fresh server 上检查桌面、320/375px、明暗主题、键盘、可访问名称、控制台和 404。端口已有服务时先核对身份，不使用 stale preview。

## 预期结果

- 代码位于正确限界上下文，没有反向依赖或循环；
- 状态 schema、旧 fixture、rollback 和发行 bundle 兼容；
- 源码、generated artifact、templates 和 docs 没有漂移；
- 测试、构建、hook、adapter、bundle 和 oracle 按风险通过；
- 未运行的外部验收在报告中明确列出。

## 验证

准备交付时至少运行：

```bash
npm run check:comments
npm run check:architecture
npm run check:default-workflow-freshness
npm run test:all
npm run build
bash tools/test-hooks.sh
bash tools/test-adapters.sh
bash tools/verify-skills.sh
bash tools/test-bundle.sh
npm run oracle
git diff --check
```

`npm test` 的 Vitest 最多用 `min(8, 核数)` 个 worker（`vitest.config.ts`）：真实文件系统、子进程和 Docker 的集成套件在多核机器上按默认每核一个 worker 跑时会超时，上限让本地与 CI 用同一条并发规则；单次运行可用 `--maxWorkers=N` 覆盖。Vitest 的 setup（`tools/vitest.isolate-runtime-home.mjs`）还会给每个测试文件独立的声明身份与运行时 home，并清掉 `TENON_RUNTIME_ROOTS`、`TENON_BASE_BRANCH`、`TENON_CHANGE_NAME`，不论宿主进程声明了什么，所以在 Tenon 会话里或经 `tenon test run` 跑，结果与手敲 `npm test` 一致。删除临时目录的测试清理走带重试的 `rm`（CLI harness 的 `rm`、tap 测试基座的 `rmDir`），避免晚到的异步写变成盖住真实失败的 `ENOTEMPTY`。

修改文档模板时还要运行 `npm run check:document-templates`；修改文档站时运行完整 docs 命令和浏览器验收。

Dashboard 浏览器 e2e 用 `npm run test:e2e`（`e2e/dashboard/`，Chromium 与 WebKit 两个项目；WebKit 用 `npx playwright install webkit` 安装），只碰隔离的 `HOME` 与 `TENON_RUNTIME_HOME`。CI 在三处阻塞地跑它，失败时上传 `playwright-report/` 与 `test-results/`：`verify` 作业（Node 22，Chromium）、`node-matrix` 作业（Node 20、22、24 上的 Chromium，同时跑测试体系、reporter、解析器套件和 `tools/` 下的 `node:test` 脚本）、独立的 `dashboard-e2e-webkit` 作业（WebKit 项目，加 `TENON_E2E_WEBKIT=1` 的 Playwright 工程集成测试）。CI 任何步骤都没有 `continue-on-error`，出现了 `npm run check:release-workflows` 会失败。`verify` 里的 `npm test` 带 `TENON_E2E=1`：缺 Chromium 时真实 Playwright 集成测试失败，而不是被悄悄跳过。Linux 上的 WebKit 只能在 GitHub 的运行器上验证，本机 WebKit 绿不能替代；改动相关页面前仍要在本机跑两个项目。

基准的退化（`max_regression_pct: 15`）只与同机器画像的基线比。仓库目录设了 `profile: coarse`，画像由 OS、架构、核数、Node 主版本（加 `CI` 变量）组成，形如 `linux-x64-4c-node22-<哈希>`；CPU 型号与内存档位不参与，所以同规格的托管运行器即使落在不同代的 CPU 上也共用一份基线。基线不从开发机提交，CI 也从不自己提交：绿的一次运行把「这次运行作为基线」的文件写到 `.tenon/tests/baselines/<套件>/<画像>.json` 并上传成 `bench-baseline-candidate` artifact，由维护者从一次绿的 `main` 运行下载并原样提交。某个套件还没有 CI 画像的基线时，运行只报 `baseline-missing`（不挡），基准步骤另打一条 GitHub `::notice` 注解指出套件和要提交的文件，让缺口在运行页上可见。目前还没有提交粗口径 CI 画像的基线。

## 常见失败

- 只改 `dist`：生成物会被下一次 build 覆盖，应修改源码并重建；
- 只改 runtime catalog：发行模板会漂移，应修改单一事实源并生成；
- Kernel 深度导入 CLI：违反依赖方向；
- 单元测试绿但 bundle 旧：执行完整 build 和 bundle smoke；
- 本地预览交互失效：重启 fresh preview，检查哈希资源；
- 把条件性 skip 写成通过：保留 skip 原因和剩余风险。

## 下一步

提交前运行 `git diff --check`，确认没有 secrets、生成漂移或未说明失败。贡献说明应解释设计意图和验证证据，而不只罗列文件。
