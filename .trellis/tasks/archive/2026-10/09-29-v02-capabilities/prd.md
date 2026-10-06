# v0.2 能力补齐

来源：2026-09-29 全面评估（智能体、测试、编排、表单、需求对照四份审计 + 页面走查），用户指令「全部做推荐」，并要求测试体系做到「每次开发登记全部测试脚本（基准、回归、e2e、Playwright、浏览器测试等）」。

## 子任务

| 子任务 | 内容 | 依赖 |
|---|---|---|
| v02-fixes | 已核实的错误与工程债 | 无 |
| v02-agent-registry | 智能体终端生成与注册、官方来源、宿主原生文件、默认工作流挂执行者 | 无 |
| v02-orchestration | runner 顺序真相、编排投影接口、总览画布、右栏收敛 | 无 |
| v02-test-system | 测试体系（设计见其 design.md），分 T1–T4 | T1 先行 |
| v02-forms-ui | 新建类表单、技能引用、设计资源落地 | 无 |
| v02-dogfood-e2e | Tenon 自身测试登记与 Dashboard Playwright e2e | test-system T2 |
| v02-acceptance-release | 真实宿主验收、1.x 删除、截图、账面、发布 | 全部 |

## 跨子任务约束

- Dashboard 不调模型；登记类动作（智能体、测试）在终端经 CLI 完成，页面只展示与编辑配置。
- UI 规则见 `.trellis/tasks/09-29-v02-capabilities/ui-prefs.md`（零废话、一词一概念、名称只显示一个、任何地方不换行、动作放对象旁、工作流两栏、IO 表、React Flow、GSAP 持续脉冲、不堆卡片、不用药丸、字号刻度、深绿单强调色）。
- 状态只经 tenon CLI；不删 marker、不手改 canonical state。

## 跨子任务验收

- 一个新项目：新建项目 → 终端生成一个自定义评审者并注册 → 工作流挂上执行者与评审者 → 总览画布看得到每阶段的执行者/技能/测试/评审者与真实顺序 → 任务按策略登记全部测试并运行 → 工作台看到用例级结果与产物 → 跑到归档。Claude Code 与 Codex 各一遍，记录在 docs/acceptance/。
- 全部门禁链与 clean-install 通过，发布 v0.2.0。
