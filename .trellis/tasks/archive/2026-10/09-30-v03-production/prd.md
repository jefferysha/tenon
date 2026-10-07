# v0.3 生产可用与差异化

来源：2026-09-30 全方位评估（design-audit.md、product-audit.md）与 Claude Code 真实验收（acceptance-claude-code.md），用户指令「按你推荐 全部执行」。UI 规则见 ui-prefs.md（含 2026-09-30 批准的 6 条变更）。

## 子任务与批次
| 批次 | 子任务 | 依赖 |
|---|---|---|
| 1 | v03-canvas-signal、v03-pages、v03-local-auth、v03-evidence-trust、v03-snapshot-scale、v03-test-flow-lite、v03-acceptance-fixes | 无 |
| 2 | v03-standard-lane、v03-ci-platform、v03-support-i18n | 批次 1 合入 |
| 3 | v03-differentiation | 批次 2 |
| 4 | v03-release | 全部 |

## 跨子任务验收（v0.3 生产可用的定义）
- 普通 JS 项目（只有 npm test）在默认流程下零豁免跑到归档；同类小改动用标准通道 ≤25 次 CLI 调用、≤2 次用户回复。
- 未带凭证的请求拿不到写 token 与快照；agent 无法经 API 确认人工评审。
- 伪造或绕过测试证据的 13 种写法全部被拦截或在转换时检出；改目录/基线/已知失败需人确认。
- 30 项目 × 30 任务快照重建 p95 < 1.5s。
- 画布与 Signal 动画按 ui-prefs 变更落地，浏览器走查通过（明暗两色、减少动态效果）。
- Claude Code 与 Codex 各一份真实验收记录；两身份协作；CI 覆盖 Node 20/22/24 与 WebKit。
- 全部门禁链、clean-install、oracle 通过，发布 v0.3.0。
