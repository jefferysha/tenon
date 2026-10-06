# 零豁免默认测试流程
依据：../09-30-v03-production/product-audit.md §3 与验收 F6/F13。
## 需求
- R1 目录支持项目级 `not_applicable: [kind...]`（附原因，经一次人确认后生效），策略对这些种类不再要求。
- R2 默认策略：只强制 unit（spec 登记、build/verify 运行）；typecheck/integration/regression/e2e/playwright/benchmark 改为 run_if_registered；前端 playwright 仅在目录声明时要求；覆盖率门槛仅在目录声明覆盖率时生效。
- R3 `tenon init` 在没有目录时自动运行 discover 并写入（提示用户审阅）；`tenon test register <c> --auto` = seed + 登记全部未认领测试文件 + 扩展 glob。
- R4 discover 修复：unit 文件 glob 同时覆盖 src/**、test/**、tests/**、__tests__/**、根目录 *.test.*（discover-js.ts:64）；其他语言同理检查。
- R5 可选任务显示为「可选」而不是「未覆盖」（F13）；种子不再生成占位任务行。
- R6 regression 不再要求单独套件：同一套件 scope=full 即满足 regression。
## 验收
只有 `npm test` 的新 JS 项目：init → 默认后端/前端流程跑到 verify 零豁免；discover 认 test/ 目录；集成测试覆盖。
