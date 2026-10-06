# Tenon 自身测试登记与浏览器 e2e

## 需求
- R1 用 v02-test-system 的目录为 Tenon 仓库登记全部套件：vitest（kernel/cli/server/automation/tap）、test:web、hooks 测试、adapters 测试、bundle 测试、migration-cas、oracle、clean-install、docs smoke、typecheck、架构/注释/身份等检查（kind lint）、Dashboard Playwright e2e、基准（快照生成耗时、status 耗时）。
- R2 Dashboard Playwright e2e（chromium + webkit）：新建项目向导（打桩文件夹选择接口）、项目页客户端启停、工作流页编辑与总览画布（脉冲在动）、工作台任务状态与下一步、测试页签与运行抽屉（截图/trace 可打开）、库模板复制、断线重连。服务由目录 services 启动 dashboard。
- R3 CI 接入：ci.yml 的 Chromium 步骤跑 e2e；失败上传 playwright-report。
- R4 基准：`tenon status` 与快照生成的基线（CI 画像），退化 >15% 挡。

## 验收
CI 绿；本仓库一个真实 change 按新策略登记并跑通。
