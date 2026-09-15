# Current test evidence (evidence)

Nothing in the interactive flow runs a test and records its exit code. Test evidence is self-reported strings,
one report document and SKILL.md prose.

## What exists

- State fields (`packages/kernel/src/types.ts:20-24`): `verification_report`, `build_sha`, `agent_review_result`,
  `codex_review_result`, `verify_result`, `pre_verify_review_result` — flat strings, no test fields.
- Guards: `build-complete` needs `pre_verify_review_result=pass` then freezes `build_sha`
  (`flow/default-event-policy.ts:71-83`); `verify-pass` needs report file, `branch_status=handled`, agent/codex pass,
  unchanged baseline (86-97). No rule checks tests (`flow/guard.ts:96-105`).
- Coverage profiles check a spec coverage block (L1–L10) in `design_doc` (`guard.ts:124-150,221-265`) — spec coverage,
  not test coverage.
- Frozen baseline token `build:v1:<git|workspace>:…` (`workflow/build-revision.ts:1-40`); workspace fingerprint
  (`workspace/fingerprint.ts:1-30,143`).
- Structured result exists only for automation loops: `VerificationResult` with `command-result`
  `{command_id, exit_code, stdout_sha256}` and issuer trust (`kernel/src/verification/types.ts:60-127`), attached to
  loop run records (`kernel/src/loops/ledger-types.ts:224,316`), filled by host verifiers
  (`automation/src/verifier/git-revision-verifier.ts:71-73`).
- Evidence composer (`kernel/src/verification/evidence-composer.ts:1-30,372`) + `POST /api/verification-evidence/compose`;
  Dashboard client exists (`dashboard-app/src/api/verificationEvidenceClient.ts:23`) but nothing calls it.
- `verification-report` document sections scope/commands/results/failures/risks (`templates/documents/registry.v1.yaml:15`).

## Why a separate ledger

- Document record `{kind, path, sha256, producer, recordedAt, producerInvocation{…stepVisit}, reads, subjectRef}`
  (`state/document-ledger.ts:53-63`): fixed kinds, re-record replaces the slot (358-364), 256 cap, no command/exit code.
- Fields are `string|file_path|boolean` (`workflow/types.ts:16`); cannot hold structured results.
- `hooks/terminal-activity.sh` records only liveness `{protocol, change, session_id, heartbeat_at, turn_id}` (:78);
  hook capture of commands would be untrusted by design (`workspace/terminal-activity.ts:1-8`).

## Track differences today

- Skills only (`templates/workflows/default.yaml`): pm verify adds `browser-qa` (222-232); frontend adds `browser-qa` +
  `e2e-testing` (370-381); backend/free only `tenon-verify` + `verification-before-completion`.
- TDD red→green, "type/test/lint green before build-complete", Playwright lane are instructions only
  (`skills/tenon-build/SKILL.md:201-205,240-244,287-293`, `skills/tenon-verify/SKILL.md:104-110,197-225,357-365,466`).

## Extension points

- Step declaration in `workflow/types.ts`, parse next to `review_lanes` (`workflow/parse.ts:258`), compile, effective plan.
- New `state/test-run-ledger.ts` modelled on `document-ledger.ts` / `review-attempt-budget-io.ts`, bound to stepVisit
  (`document-step-visit.ts`) and build token.
- CLI-owned runner so the exit code is observed, not reported; guard in `workflow/guard-handlers.ts`, `compile-guards.ts`,
  `flow/default-event-policy.ts`.
- Snapshot `server/src/changeSnapshot.ts:338`; UI `workspace/stageIo.ts`, `StageIoPanel.tsx`, `model/evidence.ts`.
