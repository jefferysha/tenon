# Document recording defects found before v1.1.0

Source: the real golden-oracle run (126 mismatches after the harness stopped counting
unbound ledger rows), then reproduced with unit and CLI integration tests.

## Defects

| # | Symptom | Root cause | Real-user impact |
| --- | --- | --- | --- |
| 1 | `tenon document record <c> superpower-design docs/superpowers/specs/<c>-design.md` fails `submission path outside change scope` | `openArtifactSubmissionService` checked every path against the Change directory, while documents are repository-rooted | Explore/Spec/Verify cannot record `superpower-design`, `adr`, `superpower-plan`, `plan`, `verification-report` |
| 2 | Re-recording an edited document fails `document '<kind>' subjectRef 与当前内容不匹配` | Reusing a registered subject returned its old `content_digest` | Build cannot re-record `tasks.md` after ticking tasks |
| 3 | Recording unchanged bytes again leaves the gate blocked with `producer invocation/artifact 尚未原子完成` | Binding idempotency matched path + digest only; the ledger row carried the new `recordedAt` the gate requires | Any retry of `document record` blocks the step |
| 4 | Skill PostToolUse auto-registration wrote rows that never pass the gate | Skill PostToolUse fires when the skill loads, before it writes anything; the rows were unbound, and binding them would claim `tenon init` scaffolds as output and close the invocation before its questions | Misleading `[auto-register] recorded=…` and blocked gates |

## Decisions

- 1: document and field locators are repository-scoped (`repoRoot`); runtime locators stay
  Change-scoped. The Kernel ledger still owns the `openspec/`/`docs/` rule.
- 2: a reused subject keeps `subject_id` and carries the digest of the bytes being committed.
- 3: binding idempotency matches path, digest, kind and `recorded_at`.
- 4: auto-registration removed (`documents/auto-register.ts`, `documents/document-paths.ts`, the receipt
  call). Binding the rows was tried first; it broke the native question/answer provenance test and would
  let scaffolds pass the gate. Every skill already runs `tenon document record` after writing.
- The CLI integration harness now wires `artifactSubmission` like `main.ts`; its absence is why
  defects 1 and 2 never showed up in tests.
- The gate blocker for an unbound row now names the `tenon document record` command to run.

## Proof

- Defect 3 test fails without the fix (`keeps the gate open when unchanged bytes are recorded again`).
- `npm run oracle`: 0 mismatches across backend-full, default-effects, default-guard-errors,
  frontend-quotegate, pm-history.
