# A 设计：关闭 review transition 旁路

## 变更面

- `packages/kernel/src/workflow/transition-application-types.ts`：删除 `humanReviewApproved?: boolean`。
- `packages/kernel/src/workflow/transition-application.ts`：删除 command flag 分支、receipt-only fallback 及 Dashboard host-bound approval 注释；review 只接受 canonical exact receipt 与 binding。
- `packages/server/src/transition.ts`：删除 server adapter 的字段传值和相关注释；注入 kernel 导出的 `readReviewGateBinding`/`reviewGateBindingMatches`，使 server 与 CLI 使用同一 binding 校验；保留 `mapTransitionResult` 的既有 409 映射。
- 受影响测试：按 PRD inventory 更新 fixture/断言，不删除 route。

## HTTP 合同

沿用现有 `mapTransitionResult`：

```text
HTTP 409
Content-Type: application/json
```

```json
{
  "ok": false,
  "error": "phase 'verify' 的产物尚未取得人工确认",
  "code": "review-approval-required"
}
```

该结果不得追加 history、transition record 或 review projection。调用方可通过 `code` 区分 review 缺 receipt/binding 与一般 guard 失败。

## 安全语义

删除 flag 后，token 仍是本地 bearer capability，但不再足以直接绕过 review gate；receipt 还必须绑定当前 phase/event、state revision 和产物 digest。渠道归因、Dashboard review adapter 和 canonical review field 属于父任务 B/C，不在 A 中实现。

## 删除和回滚范围

生产源码与生成 dist 不得再出现 `humanReviewApproved`。历史 review-handshake spec 保留，并加 deprecated 注记；不得把历史文档命中误报为当前实现命中。只允许回滚整个 A 提交并停止发布，不恢复该旁路参数。
