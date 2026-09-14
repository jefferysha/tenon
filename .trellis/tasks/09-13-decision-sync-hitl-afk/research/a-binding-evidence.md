# Research: A review bypass and server binding plan

- Query: Verify the child A plan for removing `humanReviewApproved`, enforcing review-gate binding in server transitions, correcting affected tests, and rebuilding tracked CLI/server bundles.
- Scope: internal
- Date: 2026-09-13

## Findings

### Binding implementation and reuse boundary

- The binding implementation is already kernel-owned and exported through the kernel barrel. `packages/kernel/src/state/review-gate-binding.ts:12-23` defines `ReviewGateBinding` and its sidecar contract; `:45-70` computes a digest that excludes only review receipt fields and includes `runMetadata`; `:99-121` strictly reads canonical JSON; `:135-148` checks phase, event, requested timestamp, digest, and run id. `packages/kernel/src/state/index.ts:95-103` and `packages/kernel/src/index.ts:7` export it for server and CLI use.
- CLI transition already injects the verifier without a server dependency on CLI. `packages/cli/src/commands/transition.ts:120-128` passes `readReviewGateBinding(changeDir)` to `reviewGateBindingMatches`. This is the reusable path: server should import these kernel exports directly and inject the same callback into `createTransitionApplication`; server must not import `packages/cli` (the architecture checker rejects reverse dependencies, `tools/check-architecture.mjs:236-240, 323-337`).
- `packages/kernel/src/workflow/transition-application.ts:373-391` currently accepts a receipt as sufficient when `deps.reviewGateBinding` is absent (`bindingApproved = receiptApproved`), and separately bypasses approval when `command.humanReviewApproved === true` at `:386-390`. A complete A change must remove both fallback paths: every review-gated caller must provide and pass binding; the command escape hatch and type must be deleted.
- The server currently injects neither `reviewGateBinding` nor a receipt verifier. `packages/server/src/transition.ts:287-313` constructs the application, and `:321-324` always supplies `humanReviewApproved: true`. The server injection should mirror the CLI callback, using `readReviewGateBinding` and `reviewGateBindingMatches` from `@tenon/kernel`.
- Review request creates the sidecar only after writing the canonical pending receipt. `packages/cli/src/commands/review.ts:247-254` writes `reviewGateRequestPatch` under the Change lock and then calls `refreshReviewGateBinding`; `packages/cli/src/commands/review-binding.ts:14-34` refreshes the sidecar from the current state. This guarantees the digest is tied to the post-request canonical state. A fixture that only sets `review_gate_status=approved` is incomplete once server binding is mandatory.

### Binding guarantees and limits

- Binding invalidates an approval when phase, event, `review_requested_at`, any non-receipt canonical field, run metadata, or run id changes (`review-gate-binding.ts:41-53, 135-148`). It also rejects malformed, non-canonical, oversized, BOM-prefixed, or unreadable sidecars (`:25-34, 73-121`).
- Binding does not establish human identity or channel. It proves that the sidecar matches the exact canonical decision state and outgoing event. It cannot distinguish a token-holding agent from a human in the same OS account; that belongs to the later attribution/self-approval task.
- `clearReviewGatePatch()` clears `review_gate_phase`, `review_gate_status`, `review_gate_event`, `review_requested_at`, and `review_acknowledged_at` (`packages/kernel/src/state/review-gate.ts:67-75`). After consumption, the canonical fields do not identify “consumed”; replay must use TransitionRecord/interaction evidence. The sidecar may remain as a stale artifact, but it will no longer match the cleared state.

### Test impact

Tests that should be removed from A's affected list:

- `packages/dashboard-app/src/api/serverIntegration.test.tsx:219-226` exercises missing-token authentication and fails at 401 before transition application. Its real transition call is `:193-199` (`open-complete`), which is not a review-gated exit.
- `packages/server/src/server.test.ts:1102-1187` (`:1129` verify-pass) asserts `verify-build-revision-untrusted`; this precondition is evaluated before review approval and should remain unchanged. Run it once as a non-regression check.

Tests that must be added or updated:

- `packages/server/src/transition-concurrency.test.ts:30-98` currently runs `open-complete` then `explore-complete` and expects both 200. The second transition is review-gated (`:81`) and will require an approved receipt plus matching binding. Do not write a receipt while the first breadcrumb callback still holds the Change lock (`:52-61`); that would deadlock. Either use a custom workflow with two non-review edges for the lock-order test, or split the review-approved server success into a separate fixture and preserve concurrency coverage independently.
- `packages/server/src/transition-concurrency.test.ts:100-130` (`:126` verify-fail) already seeds an approved receipt at `:110-114`, but it does not seed `.pipeline-review-gate-binding.json`. Add a binding generated from the exact post-seed state (or use a shared fixture helper) before calling `performTransition`; this is the server-route approved-with-binding 200 regression sample.
- Add a server-route negative regression: approved receipt with a changed canonical field or mismatched sidecar digest returns `{ code: 'review-approval-required' }` and HTTP 409 through `mapTransitionResult` (`packages/server/src/transition.ts:205-213`). Verify no canonical/history mutation.
- Kernel transition tests with manually seeded approved fields, such as `packages/kernel/src/workflow/transition-application.test.ts:269-300` and `:302-338`, will need a binding verifier or fixture sidecar when the fallback is removed. Tests specifically exercising missing receipt should remain and continue to return `review-approval-required`.
- Existing CLI transition tests use a `reviewGateBinding` dependency in their test deps (`packages/cli/src/commands/transition.test.ts:29-31, 80+`); preserve those tests and add/retain a mismatched-binding case. They demonstrate the CLI path and should not be weakened to receipt-only approval.

### HTTP and build/freshness contract

- `mapTransitionResult` already maps `review-approval-required` to HTTP 409 with stable body `{ ok:false, error:<phase message>, code:'review-approval-required' }` at `packages/server/src/transition.ts:205-213`. A must preserve this exact machine code and add assertions for status/body.
- New worktree setup must run `npm ci` before tests/build. The repository is npm-based (`package.json:4, 45-50`) and uses Node >=22.
- `npm run build` is required: it compiles kernel, CLI, and server and then runs `build:web`, `build:server`, and `bundle` (`package.json:19-22`). This regenerates both tracked runtime assets that can contain the old bypass: `packages/cli/dist/tenon.mjs` and `packages/server/dist/dashboard.mjs`.
- The exact tracked-bundle freshness gate is the CI command at `.github/workflows/ci.yml:96-99`:

  ```sh
  git diff --exit-code -- packages/cli/dist/tenon.mjs packages/server/dist/dashboard.mjs
  npm run check:dashboard-dist-freshness
  ```

  Run it after `npm run build`, not before. `check:default-workflow-freshness` is unrelated to this change and need not be in A's validation list.
- A focused validation sequence is: `npm ci` → targeted Vitest files (including `server.test.ts` and `transition-concurrency.test.ts`) → `npm run build` → exact dist freshness commands → `git grep humanReviewApproved -- packages/cli packages/server packages/kernel` must return no source/dist hits. Historical specs under `docs/superpowers/specs/2026-07-30-review-handshake-*.md` may retain the term only with an explicit deprecated/removed note; they are not runtime proof of deletion.

## Caveats / Not Found

- There is no shared application-level acknowledge function today. Full acknowledge orchestration (receipt write, binding check, marker cleanup, interaction projection, rejected-acknowledgement recording) lives in `packages/cli/src/commands/review.ts` and `review-binding.ts`; server cannot import CLI. That extraction is a prerequisite for child B/C, not part of child A's bypass removal.
- Existing server tests seed canonical fields directly and do not consistently create the binding sidecar. A shared test-only helper may reduce fixture drift, but it must generate the binding from the exact post-seed state and must not become production logic.
- `humanGateSatisfied: true` in `packages/server/src/transition.ts:307-312` is an automation-constraint context and is separate from the review receipt bypass. A should not silently fold it into the review fix; keep it as the explicitly tracked follow-up task.
