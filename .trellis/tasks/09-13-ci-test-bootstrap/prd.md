# 接通 Playwright CI 与测试自举

## Goal
让完整 Playwright e2e 真正执行，并消除 npm test 对预生成 dist 的隐式依赖。

## Requirements
- 移除 browser e2e 的 macOS 绝对路径，统一 Playwright 浏览器发现。
- 对 `tests/e2e/orchestration-v2.spec.ts` 做接入或删除的明确决策，不保留假覆盖。
- CI 安装浏览器并执行 e2e。
- 测试自举与 npm/pnpm 契约明确；Node >=22 保持不变。

## Acceptance criteria
- [ ] CI 有真实 Playwright step。
- [ ] e2e 套件至少在 CI 或本机真实执行一次。
- [ ] 干净 checkout 按文档命令可运行测试。
