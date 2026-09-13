# Error Handling

> How errors are handled in this project.

---

## Overview

<!--
Document your project's error handling conventions here.

Questions to answer:
- What error types do you define?
- How are errors propagated?
- How are errors logged?
- How are errors returned to clients?
-->

(To be filled by the team)

## Scenario: HTTP review approval mapping

### 1. Scope / Trigger

The server transition adapter must preserve Kernel fail-closed review semantics while exposing a stable HTTP response. The Dashboard has no model or Skill interaction surface.

### 2. Signatures

```ts
POST /api/change/:name/transition
// request: { root: string, event: string }
// review failure: HTTP 409
```

### 3. Contracts

For a missing, malformed, or mismatched exact receipt/binding, return:

```json
{
  "ok": false,
  "error": "phase '<phase>' 的产物尚未取得人工确认",
  "code": "review-approval-required"
}
```

The server reads the binding through Kernel exports (`readReviewGateBinding` + `reviewGateBindingMatches`) and never imports CLI code or sets a transition approval flag. Binding read/parse errors are caught and treated as `false`. A rejected request must not write state, transition history, or projection data.
The bearer token authenticates the local capability only; because the sidecar and token are readable by the same OS user as the agent, this is not strong human identity proof. Channel attribution (`dashboard` versus `cli` versus automation) is deferred to the decision-sync contract.

### 4. Validation & Error Matrix

| Condition | HTTP result |
|---|---|
| No exact approved receipt | 409 / `review-approval-required` |
| Receipt binding mismatch | 409 / `review-approval-required` |
| Non-review guard failure | Existing typed 409 mapping |
| Matching receipt and binding | Existing 200 transition response |

### 5. Good / Base / Bad Cases

- Good: Dashboard/server uses the same Kernel binding matcher as CLI.
- Base: an authenticated request is still only a bearer capability; it is not human identity proof.
- Bad: treating a token-authenticated transition as implicit human approval.

### 6. Tests Required

- HTTP 409 with stable `code` for missing and mismatched binding.
- HTTP 200 for approved receipt plus matching binding.
- No state/history mutation after a rejected request.
- Non-review transitions and unrelated 401/409 routes retain their existing assertions.

### 7. Wrong vs Correct

```ts
// Wrong: authenticated Dashboard click bypasses the receipt
humanReviewApproved: true

// Correct: server injects the Kernel binding verifier
reviewGateBinding: ({ changeDir, state, phase, event }) =>
  readReviewGateBinding(changeDir)
    .then((binding) => reviewGateBindingMatches(binding, state, phase, event))
    .catch(() => false)
```

---

## Error Types

<!-- Custom error classes/types -->

(To be filled by the team)

---

## Error Handling Patterns

<!-- Try-catch patterns, error propagation -->

(To be filled by the team)

---

## API Error Responses

<!-- Standard error response format -->

(To be filled by the team)

---

## Common Mistakes

<!-- Error handling mistakes your team has made -->

(To be filled by the team)

## Shared application boundary

The server adapter calls the same shared review-acknowledge application as the
CLI, in-process, with `channel=dashboard`. It may not import `@tenon/cli`,
invoke a CLI command, or copy the receipt/binding/interaction orchestration.
The application receives an exact pending receipt, expected revision,
idempotency key, and Kernel binding verifier; it cannot create an approval when
no pending receipt exists.

The application returns structured outcomes. The server owns only HTTP mapping:

| Application outcome | HTTP |
|---|---|
| missing/late/mismatched receipt or binding | 409, `review-approval-required` |
| expected revision conflict | 409, `revision-conflict` |
| matching idempotent approval | existing 200 response |

Rejected requests do not write canonical state, TransitionRecord, history, or
projection data. Bearer-token authentication identifies a caller capability,
not a human approver; channel attribution and binding remain separate fields.
