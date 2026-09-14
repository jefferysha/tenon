# F1：修复决策同步集成缺口

## Scope

只修复不依赖契约裁决的既有集成问题，不改 humanGateSatisfied、CLI revision/key 行为、幂等判定顺序、rejected 审计语义或任何 UI。

## Required fixes

1. GET/POST 共用 pending projection 输入；真实 receipt + run revision 流程必须 GET→POST 200→consumed。
2. 自定义 workflow 步骤先完成 interaction draft 编码校验，再提交 canonical，禁止部分写入。
3. 意外异常（如幂等文件损坏）返回 500 且零写入。
4. import-legacy 对 phase、review_gate_*（含 review_acknowledged_via）和 transition 字段 fail-closed 拒绝或保留 canonical；覆盖 CLI 与 server 两个入口；另附 hooks 是否拦截 yaml 直接编辑的只读报告。
5. review_acknowledged_via 追加到 FIELD_ORDER 末尾；同步 oracle 与窄解析器回写测试。
6. 删除未使用的 server decisionIdempotency、Dashboard invocation decision 公开导出及 createDecisionCommandAdapter（先确认无调用方）。
7. 补无 receipt 零写入、CLI/Dashboard 结果等价、ack→transition→consumed 测试。
8. 修正目录读取测试和 default review 并发覆盖；恢复本改动误删且与行为相关的注释。

## Acceptance

- [ ] 每项修复均有针对性测试；禁止事项保持未改。
- [ ] `npm run build` 后 CLI/server dist 与源码新鲜，目标 Vitest、`npm run check:architecture`、`bash tools/test-hooks.sh`、`npm run test:web` 和全量 `npm test` 通过或有基线差异说明。
