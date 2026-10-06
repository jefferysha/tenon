# 标准通道与减负
依据：../09-30-v03-production/product-audit.md §3、§4.3 bet 2；验收 135 分钟 / 18 次回复。
## 需求
- R1 新增内建 standard 工作流/通道：立项 → 实现 → 验证 → 完结，1 个必需评审者（spec-consistency 或 code-review），测试策略同 R2（test-flow-lite），无 explore/grilling。
- R2 实现阶段后按 diff 风险判定是否升级到 default（文件数、契约/鉴权/依赖路径、删测试）；升级走已有 scope-expanded 机制。
- R3 router：实现类请求默认进入 standard；无法匹配任何规则的实现型请求给出提示而非静默不治理。
- R4 批量命令：`tenon document record <c> --all`、`tenon step run <c>`（脚手架 + 登记 + 读回执一次完成）。
- R5 评审者按风险挂载：security 只在鉴权/依赖/契约路径变化时挂；其余按轨道默认。
- R6 Playwright 在 verify 不跑两遍（F12）。
## 验收
3 文件 bug 修复在 standard 通道 ≤25 次 CLI 调用、≤2 次用户回复（集成测试 + 真实宿主抽检）。
