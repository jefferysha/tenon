# Decision Synchronization Adapter Contract

## Scope

The local server exposes read/control adapters for the Dashboard. It never
calls a model, creates a prompt, starts a Skill, or invents a review receipt.
The terminal remains the only model interaction surface.

## Read and write surfaces

`GET /api/change/:name/pending-decisions` is a read-only projection over
canonical state and append-only evidence. `POST /api/change/:name/decisions`
accepts review, Skill-question, and AFK commands only when their exact pending
request and binding are valid. Dashboard review calls the shared review
application with `channel=dashboard`; it does not import CLI or duplicate its
orchestration. A review command without an existing pending receipt is
rejected.

## Synchronization order

Under the Change lock, adapters process commands in this order:

1. Look up the durable idempotency record.
2. Return its stored result for the same full payload, or
   `idempotency-conflict` for a different payload using the same key.
3. For a new key, read the exact pending receipt and verify its binding.
4. Compare `expected_revision` with canonical state.
5. Commit canonical evidence and idempotency in one transaction.

The idempotency record is Change-owned durable data, not process memory. Hook
observations without a revision or idempotency key cannot acknowledge a
decision. Legacy requests without an id are anchored by
`requestedAt + decisionStateDigest + runId`.

## Errors and audit

Missing, late, not-pending, or binding-mismatched review commands return HTTP
409 with `code=review-approval-required`; stale `expected_revision` returns
409 with `code=revision-conflict`; key reuse with a different payload returns
409 with `code=idempotency-conflict`. CLI maps the same outcomes to stable
non-zero exits. Every rejected attempt appends one redacted rejected-audit
event idempotently and writes no canonical approval, transition, or successful
history.

The `channel` field describes the entry route (`terminal`, `dashboard`,
`automation`, or `delegated`), not the operator. A bearer token is only local
capability proof; `actor` must not be set to `human` without an independent
trusted identity provider. Host resume is capability-gated. If the host API is
unverified or unavailable, the adapter records durable state and the next
reconciliation/read refresh observes it instead of claiming a wake-up.

## Mode and AFK boundaries

HITL maps to `interactive` or frozen `recommended-defaults`; AFK maps to the
separate `afk` strategy and is attributed by joining decision invocation id to
the durable invocation's `adapter.kind`. `SkillInvocationDecisionMode` does
not gain an `afk-answer` value, and Dashboard cannot answer hard-gate Skill
questions. `mode-switched` is an append-only event affecting future requests;
it is not a decision and cannot silently rewrite existing pending requests.

## Terminal answer evidence

`confirm-clear-prompt.sh` invokes `review-ack.sh manual` or `delegated`.
`decision-recorder.sh` records `host-skill-interaction-receipt/v1` via
`hostInteraction.ts`, including `host_session_id` and an HMAC-derived host
identity. The receipt joins the question/invocation projection with
`channel=terminal` or `delegated` and `source=host`; HMAC proves session
continuity, not a human operator. Hosts that write a question only after an
answer provide no earlier pending visibility; the projection returns
`absent/unknown` rather than fabricating one.
