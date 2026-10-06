# CI 与平台
依据：product-audit.md §1（CI 真相）、§2.1（平台）、P0-6/P0-7。
## 需求
- Node 20/22/24 矩阵（至少 reporter/parser/测试体系与 e2e）；WebKit e2e 作业（非 continue-on-error，独立 job）；`npm test` 步骤设置 TENON_E2E=1 跑真实 Playwright 集成测试。
- 基准：机器画像增加粗粒度模式（os-arch-cores-node-major），CI 基线入库并在 CI 比较。
- doctor：平台支持检查（原生 Windows 明确红/黄并指向 WSL）、PATH 上 tenon 可用性；安装文档加支持矩阵。
- 测试运行环境前置正在运行的 launcher 目录到 PATH（与 v03-acceptance-fixes F17 协调：本任务负责 CI/doctor/文档，F17 负责运行时注入，以先合入者为准，避免重复）。
## 验收
CI 全绿含新矩阵；doctor 在缺 PATH 与 Windows 模拟下给出正确结论。
