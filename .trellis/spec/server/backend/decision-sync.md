# Pending decision read/command adapter

## 1. Scope / Trigger

The Dashboard may read `GET /api/change/:name/pending-decisions` and submit a
review decision through `POST /api/change/:name/decisions`. These endpoints are
control/read adapters only: they never call a model, create a prompt, or start
a Skill.

## 2. Signatures

```ts
projectPendingDecisions(input): PendingDecisionView
acknowledgeReview(input): ReviewAcknowledgeApplicationResult
```

The server invokes the shared review application exported by `@tenon/kernel`;
it does not import CLI modules or duplicate receipt orchestration.

## 3. Contracts

- A decision reference is stable for `(kind, change, anchor, revision)`.
- Review approval requires an exact pending receipt and a matching review
  binding. A stale or mismatched binding returns a conflict.
- Every command supplies `expected_revision` and `idempotency_key`; stale
  revisions return HTTP 409 `revision-conflict`.
- The projection joins AFK provenance from `invocation-started.adapter.kind`,
  never from the decision payload.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/invalid change or root | 400/404; no write |
| Stale expected revision | 409 `revision-conflict`; no write |
| Unknown/stale decision ref | 409 `decision-not-pending`; no write |
| Binding mismatch or no pending receipt | 409 `review-approval-required`; no partial write |
| Repeated idempotency key | 200 with `idempotent=true` |

## 5. Good / Base / Bad Cases

- Good: Dashboard reads a pending review ref, then posts the same ref and
  revision once; the shared application patches the canonical receipt.
- Base: an invocation question has no decision yet; it remains pending and is
  safe to refresh through the read endpoint.
- Bad: a caller supplies a ref from a different revision or attempts to infer
  AFK from `decision.mode`; the adapter rejects or reports the canonical join.

## 6. Tests Required

- Projection stable refs, review consumed evidence, and AFK invocation join.
- Command adapter revision conflicts and idempotent retries.
- CLI review acknowledge characterization tests and server build/typecheck.

## 7. Wrong vs Correct

### Wrong

```ts
state.fields.review_gate_status = 'approved'
```

### Correct

```ts
await acknowledgeReview({ state, bindingMatches, writeState, ...ports })
```

The application validates the exact receipt and binding before writing. UI
layers only display the resulting view and submit commands.
