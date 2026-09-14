# 修复工作流组合语义与失败集

## Goal
落实跨 workflow 禁止换轨、同 workflow 换轨保留，并在证据分类后修复 fields/artifact/internal-skill-gate/orchestration/stable-hook 失败。

## Requirements
- 同 workflow 内换轨成功并重解析冻结 plan；跨 workflow 无同名 branch 时 fail-closed。
- `simple.escalated` 保持终态。
- 7 fields、5 artifact、3 internal-skill-gate、2 orchestration、stable-hook 失败先分类再处理。
- artifact fixture 只有在 policy/required_when 证据确认后才能更新。

## Acceptance criteria
- [ ] 失败集定向测试通过且结果可重复。
- [ ] 同 workflow 换轨、跨 workflow 拒绝、escalated 终态均有回归。
- [ ] 未经诊断不修改 stable-hook/internal-skill-gate 断言。
