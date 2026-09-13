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

## Scenario: Review-gated transition approval

### 1. Scope / Trigger

Every transition leaving a review-gated phase must prove both the canonical exact-event receipt and its state binding. A receipt without a verifier is never sufficient.

### 2. Signatures

```ts
type ReviewGateBindingVerifier = (input: {
  changeDir: string
  state: PipelineState
  phase: string
  event: string
}) => Promise<boolean>

interface TransitionApplicationDeps {
  reviewGateBinding: ReviewGateBindingVerifier
}
```

### 3. Contracts

- `reviewGateBinding` is required at the Kernel application boundary.
- The verifier checks phase, event, requested-at value, state digest, and run identity.
- The application consumes the receipt only after the verifier returns `true`.
- Rejected approval returns `{ kind: 'review-approval-required', phase, event }` and does not commit state, transition history, or interaction effects.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| No approved exact receipt | `review-approval-required`; zero commit |
| Approved receipt but missing verifier | Type-level caller error; no valid production construction |
| Binding missing, malformed, or mismatched | `review-approval-required`; zero commit |
| Receipt and binding match | Transition may commit after normal guards pass |

### 5. Good / Base / Bad Cases

- Good: server and CLI pass the same sidecar-backed binding matcher.
- Base: a test injects a deterministic verifier while testing unrelated transition mechanics.
- Bad: a caller sets a boolean approval flag or treats an approved receipt as self-authenticating.

### 6. Tests Required

- Assert an approved receipt with a mismatched digest returns `review-approval-required` and leaves state/history unchanged.
- Assert matching receipt and binding allows CLI and server transitions.
- Assert all `TransitionApplicationDeps` constructions provide a verifier.

### 7. Wrong vs Correct

```ts
// Wrong: receipt-only or caller-controlled bypass
if (command.humanReviewApproved || receiptApproved) return apply()

// Correct: exact receipt plus required binding verifier
const bindingApproved = receiptApproved && await deps.reviewGateBinding(input)
if (!bindingApproved) return { kind: 'review-approval-required', phase, event }
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
