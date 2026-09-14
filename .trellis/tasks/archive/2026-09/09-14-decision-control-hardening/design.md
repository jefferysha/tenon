# 技术设计

基线：`codex/decision-control-hardening` 从 `dae5d76` 切出，并带入空闲集成 worktree 的 WIP（oracle shim 除外，见 O）。
契约真相：`.trellis/spec/server/backend/decision-sync.md`（A–K）。本任务把代码拉回契约；契约本身只做下列明确修订。

## G. Human gate（P0）

- `automationPolicy` 只绑定在受治理 loop run 上；`evaluateConstraintPolicy` 在 transition 命中 `human_gates` 时要求 `humanGateSatisfied === true`。
- **server** `resolveConstraintContext` 固定返回 `humanGateSatisfied: false`：Dashboard/本地 HTTP 入口不能满足 loop human gate（持 token 的调用方不是人类证据，server 进程环境也不代表调用方模式）。删除 server 对 `TENON_AFK` 的读取。
- **CLI** 维持 `TENON_AFK !== '1'`：它是调用方运行模式信号（AFK 必拒），不是人类证据；注释与 spec 必须写明这一点及同 OS 用户限制。
- 契约“Modes and security observation”增加 human gate 规则。

## S. 自审批检测（P0）

- `hooks/gate.sh` 的观测逻辑移到 AFK 放行（`TENON_AFK=1 exit 0`）**之前**；AFK 下只记录、不拦截；非 AFK 保持现有拦截提示。
- hook 只做**宽召回候选**：Read/Grep/Glob 的 `file_path`/`path`/`pattern` 含 `dashboard-token.json`；Bash 命令含 `dashboard-token.json`，或同时含 `localhost|127.0.0.1|[::1]` 与 `/api/`。不再解析 curl 参数、不再依赖 `TENON_RUNTIME_STATE_ROOT`、不跳过含 `$(`/`|` 的命令。
- 精确判定在 CLI `internal-self-approval`：解析 product paths 得到真实 token 路径；在每个 Change lock 内读取 **canonical** pending receipt（不看 hook marker 新鲜度）；分类 `token-file-read` / `local-control-api-call`；无 pending receipt 则零写入。
- 观测 key = sha256(change + anchor + signalKind + tool_use_id 或命令 digest)，锁内去重；观测文件设大小上限（超限后只追加一次 overflow 标记）。
- identity 摘要改为 HMAC(本机 0600 随机密钥, pid/host/session)，密钥位于 product state root；密钥缺失时创建。
- 事件 `channel` 取契约枚举值 `terminal`；不引入 `hook`。
- 移除 `tools/check-architecture.mjs` 为 `gate.sh` 增加的 runtime-root 例外。

## D. 决策核心（P0/P1）

1. **E 零写入**：missing / late / not-pending / binding-mismatch / revision-conflict / invalid-command 全部零写入（canonical、interaction、idempotency、history）。删除 server `recordRejected` 与 CLI rejected 追加（`recordRejectedAcknowledgement` 整体移除，顺带解除 `CliDeps` 绑定）。缺 ref → `review-approval-required`。
2. **D 修订**：只持久化成功结果；同 key 重放返回存储的成功码；失败不存储，重试按当前状态确定性地重新判定。同步修订契约 D 与 K（superseded 仅来自既有历史 rejected 事件或被新 request 替代的未消费 request）。
3. **单一幂等实现**：账本读写、`reviewDecisionPayloadDigest` 收敛到 kernel 共享应用（fs 经端口注入），CLI 与 server 共用；删除 server 30-51 行与 `packages/cli/src/.../review-idempotency.ts` 重复实现。锁内顺序严格按 D(1)–(5)；server 的投影与 key 查找移入锁内。
4. **提交语义**：canonical + idempotency 在锁内先落；interaction/history 属于提交后的尽力写入，失败记为 deferred 并返回成功（`marker-warning` 语义同类），不得出现“已批准但 500”。
5. **marker**：重放与已批准分支同样清 marker（端口 `clearMarker`），失败返回 `marker-warning`。CLI、server 只保留一套 marker 清理。
6. **出口一致性**：phase == `review_gate_phase`、event 仍是有效 workflow 出口的校验移入共享应用；server 传入有效 workflow。
7. **HTTP**：500 响应无 `code`、message 固定为通用文本（不含路径）；日志可记录详情。
8. **结果联合**：`DecisionCommandResult` 对齐契约 H；CLI 退出码稳定：成功/`marker-warning`=0，`review-approval-required`=2，`revision-conflict`=3，`idempotency-conflict`=4，`invalid-command`=1；写入 spec 与 CLI 参考文档。
9. **锚点 F**：anchor = `requestedAt + decisionStateDigest + runId`（digest 取 binding sidecar）；`ref.id` = change + kind + phase/event + anchor，pending→approved→consumed 不变；GET/POST 共用投影输入构造。
10. **history 一致**：CLI 与 server 同一格式，均带 `via=<channel>`。
11. **actor**：`reviewAcknowledgedInteractionDraft` 类型去掉 `'human'`；CLI `review.requested`/`resume.validated` 的 `actor:'human'` 改为 schema 允许的非身份值（若 schema 仅允许 `human`，最小改 schema 并同步 codec）。
12. **G 契约**：`afk-decision-recorded` 与 `mode-switched` 未实现 → 契约标 deferred；删除无调用方的 `modeSwitchEvent`、`pendingAccessAlert` 及 WIP principal 类型（`DecisionStatus.expired` 按 I 保留）。
13. **import-legacy**：被忽略的受保护字段在 CLI 输出警告、server operations 响应返回 `ignored_protected_fields`；补 CLI phase 保留测试。
14. **注释与格式**：恢复被删注释（`run-revision-codec.ts` 截断句、`types.ts` review_gate_event exact outgoing edge 说明、`serverPostExecutionRoutes.ts` 相对 `f1635aa` 丢失的说明段）；撤销 d446eda 为过体量检查而压成超长单行的写法，改为拆分函数/文件；删除 `review-application.ts` 重复 JSDoc。

## C. Dashboard 决策台（P2）

- 按 `ApiError.code` 映射错误文案（`review-approval-required` / `revision-conflict` / `idempotency-conflict` / 通用失败），只在错误处出现文字。
- idempotency key 由 `ref.id + revision` 确定性生成，网络重试复用。
- 快照（SSE）变化与 409 后刷新 pending 列表；409 后 review 消失时错误仍保留显示。
- 删除无引用 i18n key（`description`、`boundary`）；补 409 映射、key 复用、刷新测试；满足 design-scale、不换行。

## O. Oracle shim

WIP 的 `bootstrap_new_initial_explore` 未带入。以实跑 oracle 为准：若 fixture 在 init 后已显式 `open-complete`，shim 会掩盖差异，不采用；若确有旧实现 init 直达 explore 的差异，记录为已知差异并以显式、可见的方式处理。

## 并发与合入

G、S、D、C 在 4 个独立 worktree 并行实施（均基于本任务基线提交），实施 agent 不提交、不提交 dist。主线程逐包检查→提交→合入本分支→统一 `npm run build` 重建 dist→CI 同等全量验证。

## 回滚

整分支回滚；未通过完整验证不合入集成分支、不发布。
