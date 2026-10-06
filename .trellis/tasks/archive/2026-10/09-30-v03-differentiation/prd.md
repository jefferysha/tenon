# 差异化能力
依据：product-audit.md §4.3 bets 1、3、4、6、7。
## 需求
- `tenon verify --ci`：在 CI 重放记录链、计划、用例结论与门禁，输出 SARIF/摘要；GitHub Action（composite）发布到仓库；PR 上伪造记录必失败。
- 跨厂商评审：评审者可指定执行宿主（Claude 写、Codex 审），裁决绑定 diff 哈希，diff 变化即失效。
- 测试完整性报告：用例数下降、删除/弱化测试、快照改写、基线变更、跳过数上升，在 verify 给出提示或阻塞（策略可配）。
- 证据导出：Agent Trace、OTel GenAI span、git notes、提交尾注（Tenon-Change / Tenon-Evidence）。
- 记录链加密钥：HMAC（用户本地密钥）+ 可选 sigstore 签名，锚定到 git notes。
## 验收
各项集成测试；Action 在示例仓库跑通。
