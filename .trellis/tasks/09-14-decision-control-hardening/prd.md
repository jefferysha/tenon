# 决策控制加固收尾

## Goal

修复独立评审在 `dae5d76`（+空闲 WIP）上发现的全部阻塞与 P1/P2 问题，使决策同步、human gate、自审批检测与 Dashboard 决策台与契约一致，并通过 CI 同等验证后交付。

## 约束

- 终端是唯一大模型交互面；Dashboard 不调用模型、不回答 Skill/AFK 问题、不新增 decline。
- 单一 canonical 状态；任何失败路径零写入；同 OS 用户的 token/receipt/sidecar/环境变量不是人类证据。
- 不做回放、diff、试运行、流程体检、npm 发布。

## Requirements

- R1 human gate：server 入口不能满足 loop human gate；CLI 的 `TENON_AFK` 仅作模式信号；补 server/CLI 测试与契约说明。
- R2 自审批检测：AFK 下仍记录；以 canonical pending receipt 为条件；覆盖 Read/Grep/Glob 与 Bash（含 `-XPOST`、`--json`、`$(cat token)` 等变体）；观测去重与大小上限；identity 加盐；无 token/Authorization/原始命令落盘；移除架构例外。
- R3 契约 E/D：所有拒绝零写入，缺 ref 返回 `review-approval-required`，只存成功重放；单一幂等实现；提交后写入失败不导致已批准却报错；500 无 code 与路径。
- R4 共享应用：marker 清理单一实现且重放也清；server 与 CLI 同样校验 phase 与出口 event；锁内顺序符合 D；history 格式一致；结果联合与 CLI 退出码稳定。
- R5 契约 F/G/I：锚点与 ref 稳定；G 未实现部分标 deferred 并删死代码；actor 不为 `human`/`user`。
- R6 import-legacy：受保护字段忽略时给出警告/字段清单；CLI phase 保留测试。
- R7 Dashboard：错误码映射、确定性 idempotency key、快照变化与 409 后刷新、409 后错误不丢、删死 i18n、补测试。
- R8 恢复被删注释，撤销压行过检，删除重复 JSDoc。
- R9 oracle shim 以实跑结果决定是否采用。
- R10 任务记录与 spec 同步。

## Acceptance Criteria

- [ ] server：loop active 且命中 human gate 时 transition 返回 409 `constraint-denied` 且零写入；CLI `TENON_AFK=1` 拒绝、未设置通过（测试）。
- [ ] hook：AFK 下 token 读取与本地控制 API 调用产生一条观测；Read 工具读 token 产生观测；非 pending 零观测；重复触发不重复；观测文件无 token/Authorization/原始命令（`bash tools/test-hooks.sh` + kernel/CLI 测试）。
- [ ] server/CLI：missing、late、not-pending、binding-mismatch、revision-conflict 均 409（CLI 对应退出码）且 canonical/interaction/idempotency/history 零写入；意外异常 500 无 code 且零写入（测试）。
- [ ] 真实 `TransitionRecordStore` 端到端：GET ref → POST 200 → transition → consumed，ref 全程不变（测试）。
- [ ] 同一 fixture 下 CLI 与 Dashboard 批准的 canonical fields、interaction 事件与 history 等价（via 除外）（测试）。
- [ ] 重复 acknowledge 清 marker；marker 清理失败返回 `marker-warning`（测试）。
- [ ] 仓库内幂等账本读写与 payload digest 只有一处实现（代码检查）。
- [ ] Dashboard：三种错误码有对应文案；重试复用 key；409 后刷新且错误保留（`npm run test:web`）；`npm run check:design-scale` 通过。
- [ ] `npm run build` 后两个 dist 与源码一致并已提交；CI 同等门禁全部通过，`npm test` 失败仅限已记录的基线/flaky 项（与 `f1635aa` 对比表）。
- [ ] oracle 实跑结果记录，shim 处理有依据。
- [ ] spec 与任务记录已更新；被取代任务归档。
