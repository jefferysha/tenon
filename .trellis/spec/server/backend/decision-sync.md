# Pending decision read/command adapter

## 1. Scope / Trigger

The Dashboard may read `GET /api/change/:name/pending-decisions` and
`GET /api/change/:name/decision-audit`, then submit review, Skill-question, or
AFK decisions through `POST /api/change/:name/decisions`. It may also switch
HITL/AFK mode and report redacted self-approval observations through dedicated
POST endpoints. These endpoints are control/read adapters only: they never call
a model, create a prompt, or start a Skill.

## 2. Signatures

```ts
projectPendingDecisions(input): PendingDecisionView
acknowledgeReview(input): ReviewAcknowledgeApplicationResult
applyInvocationDecision(input): DecisionCommandResult
```

The server invokes the shared review application exported by `@tenon/kernel`
and the kernel invocation writer; it does not import CLI modules or duplicate
receipt orchestration. Invocation decisions append a decision event and publish
the canonical run revision under the same Change lock.

## 3. Contracts

- A decision reference is stable for `(kind, change, anchor, revision)`.
- Review approval requires an exact pending receipt and a matching review
  binding. A stale or mismatched binding returns a conflict.
- Every command supplies `expected_revision` and `idempotency_key`; stale
  revisions return HTTP 409 `revision-conflict`.
- The projection joins AFK provenance from `invocation-started.adapter.kind`,
  never from the decision payload.

## 3.1 Implemented command endpoints

| Endpoint | Purpose | Durable record |
|---|---|---|
| `GET /pending-decisions` | Read-only projection | canonical state + interaction/invocation/transition evidence |
| `POST /decisions` | Review, Skill-question, or AFK answer | review receipt or invocation decision event, plus transport idempotency |
| `GET /decision-audit` | Read-only security/mode audit projection | append-only `.pipeline-decision-audit.jsonl` |
| `POST /decision-mode` | HITL ↔ AFK switch | `decision-mode-switched` audit record |
| `POST /pending-decision-security` | Redacted token/local-API observation | `pending-decision-self-approval-suspected` audit record |

The audit JSONL is an append-only audit projection, not a second canonical
decision state and not an `InteractionEventV1`. Its writes occur under the
Change lock, are idempotent, and never contain token material; hooks always
write `tokenDigest: null`.

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

## 8. Current implementation boundary

Review, Skill-question, and AFK Dashboard commands are implemented with
expected-revision checks and persistent idempotency records. AFK attribution is
still derived from the invocation-started adapter join; the decision payload's
`mode` is never used as a substitute for that provenance. The canonical
`review_acknowledged_via` field records terminal, dashboard, or automation
channel, while the audit projection records mode switches and redacted
self-approval signals. `expired` remains deferred because the existing marker
TTL is not canonical evidence. The hard-coded `humanGateSatisfied` constraint
remains a separately tracked follow-up.
