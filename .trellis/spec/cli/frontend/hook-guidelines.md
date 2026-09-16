# Hook Guidelines

> How hooks are used in this project.

---

## Overview

<!--
Document your project's hook conventions here.

Questions to answer:
- What custom hooks do you have?
- How do you handle data fetching?
- What are the naming conventions?
- How do you share stateful logic?
-->

(To be filled by the team)

---

## Custom Hook Patterns

<!-- How to create and structure custom hooks -->

(To be filled by the team)

---

## Data Fetching

<!-- How data fetching is handled (React Query, SWR, etc.) -->

(To be filled by the team)

---

## Naming Conventions

<!-- Hook naming rules (use*, etc.) -->

(To be filled by the team)

---

## Common Mistakes

<!-- Hook-related mistakes your team has made -->

### Common Mistake: asserting shell structure through a fixed line window

**Symptom**: `tools/test-hooks.sh` fails with `assert_contains` on text that is still present in the file. Adding or
removing unrelated lines earlier in `install.sh` (or any asserted shell script) moves the asserted block out of the
window, so CI fails while the behaviour is unchanged.

**Cause**: the assertion sliced the script by line numbers, e.g. `sed -n '955,972p' "$ROOT/install.sh"`.

**Fix**: extract the block by its own name and fail loudly when the anchor is gone:

```bash
install_text="$(awk '/^run_release_verification\(\) \{/{inside=1} inside{print} inside && /^\}/{exit}' "$ROOT/install.sh")"
[ -n "$install_text" ] || bad "install.sh: run_release_verification 可定位" "未找到该函数"
```

**Prevention**: every structural assertion anchors on a function name, marker comment or unique literal, never on a line
number; when the anchor itself must exist, assert that first so a rename fails with the reason instead of an empty slice.

## Review and automation decisions

The terminal is the only model-interaction surface. CLI review acknowledgement
uses the shared review application and supplies `channel=terminal`; Dashboard
uses the same application with `channel=dashboard` and never starts a model or
Skill question.

HITL maps to `interactive` or the narrowly scoped
`recommended-defaults` policy (routine, hidden, frozen rule match). AFK maps to
`afk` and writes an independent decision/source record. Invocation
`adapter.kind`, decision mode, and review channel are orthogonal and must not be
collapsed into one enum.

A channel identifies the entry route, not the operator's identity. Bearer-token
requests and `actor` values must never be labelled `human` without an
independently trusted identity provider.

| User mode | Internal strategy | Adapter boundary |
|---|---|---|
| HITL | `interactive` | Terminal asks and records the answer; Dashboard may only invoke the review adapter for an existing exact pending receipt. |
| HITL | `recommended-defaults` | Frozen routine/hidden policy only; it cannot satisfy a hard gate. |
| AFK | `afk` | Attributed only through `invocation-started.adapter.kind=afk`; the independent AFK decision event is deferred (`decision-sync.md` G). |

### Self-approval detection (`gate.sh` → `internal-self-approval`)

- **Order.** Candidate detection and the recorder call run **before** the
  `TENON_AFK=1` exit. AFK skips blocking only; it never skips recording. Outside
  AFK, a token-file candidate with a fresh relevant v2 review marker still exits
  2 with the existing message, and loopback API calls fall through to the
  ordinary non-read-only block.
- **Hook = broad recall, pure bash.** A raw-input `case` pre-filter
  (`dashboard-token.json`, or a loopback host together with `/api/`) runs right
  after stdin is read; under `TENON_AFK=1` a non-candidate exits there, before
  any JSON parsing or project-root resolution. Non-candidates (including
  `src/api/…` paths and remote `/api/` URLs) never spawn node or parse the
  candidate. Candidates: Read/Grep/Glob/Search `file_path` / `path` / `pattern`
  / `glob` containing `dashboard-token.json`; command text containing
  `dashboard-token.json`, or a loopback host (`localhost`, `127.0.0.1`,
  `[::1]`) together with `/api/`. No curl argument parsing, no skipping of
  `$(` / `|` / wrappers, no runtime-root environment variable, no marker
  freshness condition.
- **CLI = precision.** `tenon internal-self-approval <payload> [change]` reads a
  closed 0600 temp payload (`candidate`, `tool_name`, `tool_use_id`,
  `process_or_host_identity`; the hook runs node in the background and `wait`s
  under a HUP/INT/TERM trap, so the file is deleted after the call and also when
  the host kills the hook during a lock wait; SIGKILL remains uncovered), classifies
  with kernel `classifySelfApprovalCandidate` against `resolveProductPaths()`,
  scans all Changes when no change is given, and re-reads the canonical pending
  receipt + binding under each Change lock. No pending receipt → zero writes
  (no lock artifact, no identity key).
- **Record.** `channel=terminal`, `kind`, `observation_key` dedupe,
  `hmac-sha256` identity digest keyed by the per-install
  `decisionObservationKeyPath` (created exclusively, 0600, symlink refused),
  1 MiB cap with a single overflow marker. Never token text, Authorization
  values, raw command, tool ids or raw identity. The record is a detection
  signal and never proof of human identity.

## Scenario: Interactive Skill confirmation in hosts without a question tool

### 1. Scope / Trigger

- Hooks: `interactive-skill-gate.sh` (PostToolUse after a Skill / `SKILL.md` read), `gate.sh` (PreToolUse block while
  `.pipeline-pending-interaction` exists), `confirm-clear-prompt.sh` (UserPromptSubmit).
- Trigger: headless Claude Code (`claude -p`) and Codex `exec` have no AskUserQuestion. In v1.1.1 Codex re-read a
  confirmed producer skill to record its document, the gate re-armed on every read, and a user reply that was not a
  recognised approval changed nothing silently — the task could not leave the step.

### 2. Signatures

```text
<root>/.pipeline-pending-interaction          # skill display names joined by 、
<change>/.pipeline-history.jsonl row          {"ts":"<utc>","kind":"tool","raw":"InteractionConfirmed: <skill>"}
pipeline_prompt_approval_intent "$PROMPT"     # prompt-intent.sh → confirm | contextual-confirm | reject | modify | authorize | revoke | ''
```

### 3. Contracts

- Approval phrases are the classifier's confirm set (「确认继续」「继续执行」「同意继续」…). A bare 「继续」 is
  `contextual-confirm` and counts only while a pending marker exists in this project.
- **Unrecognised reply** (empty intent, `reject`, `modify`) while an interaction, confirm or review marker is
  pending: no mutation, no `tenon review acknowledge`; stdout
  `<tenon-pending-confirmation>…用户回复「确认继续」即解封；带条件的回复请先说明条件并重新提问。</tenon-pending-confirmation>`.
  Nothing pending → no output.
- **Approval** with `.pipeline-pending-interaction` present: append one `InteractionConfirmed: <skill>` row per
  marker entry (split on `、`; entries outside `[A-Za-z0-9_:-]` skipped) to the active Change history, then remove the
  interaction and confirm markers and print
  `<tenon-interaction-confirmed>…请重试刚才被拦截的操作。</tenon-interaction-confirmed>`. The review marker is never
  removed here (the CLI owns it).
- **Once per step visit** (`interactive-skill-gate.sh`, non-autonomous only): scan history in order; a `transition`
  row whose `"to"` equals the current phase resets the confirmed set; `InteractionConfirmed` rows add the base name
  (namespace after the last `:` stripped). Matched skills already confirmed are dropped; if none remain the hook
  exits 0 without writing the marker. A new visit to the step (another transition into it) asks again.
- Pure bash on this hot path: no node, no jq. Missing state/phase keeps the gate (fail closed).
- `gate.sh` block message names the unlock reply: `没有提问工具时，用户回复「确认继续」（或「继续执行」「同意继续」）即解封，
  带条件或不含这些词的回复不会解封`.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Pending interaction, reply 「好的」 | Marker kept, `<tenon-pending-confirmation>` hint |
| Pending interaction, reply 「确认继续，但先改标题」 (`modify`) | Marker kept, hint |
| Pending interaction, reply 「确认继续」 | History rows written, markers removed, `<tenon-interaction-confirmed>` |
| No pending marker, reply 「继续」 | No output, no mutation |
| Confirmed skill read again in the same visit | No marker |
| Another skill read in the same visit | Marker for that skill only |
| Step re-entered after a transition | Marker again for the confirmed skill |
| Active phase unreadable | Gate armed as before |

### 5. Good / Base / Bad Cases

- Good: Codex reads `openspec-propose/SKILL.md` → blocked → user 「确认继续」 → agent retries, re-reads the skill to record
  the document → no second block.
- Base: Claude Code with AskUserQuestion — the interaction clears through the normal question flow.
- Bad: clearing the marker for any reply containing 「继续」 when nothing is pending; or keeping the confirmation
  across step visits.

### 6. Tests Required

- `tools/test-hooks.sh` section 10a''': unrecognised reply prints the hint and keeps the marker; 「确认继续」 prints the
  announcement, clears the marker and writes `InteractionConfirmed`; re-read in the same visit writes no marker; an
  unconfirmed skill still gets one; re-entry after a transition re-arms; no hint when nothing is pending.
- Hot-path red line: the gate hook must not spawn node (existing performance assertions in the same script).

### 7. Wrong vs Correct

#### Wrong

```bash
[ -n "$INTENT" ] || exit 0          # silent: the user never learns which reply unlocks
rm -f "$ROOT/.pipeline-pending-interaction"   # unlocked, but the blocked agent is never told to retry
```

#### Correct

```bash
[ -n "$INTENT" ] || pending_unlock_hint_and_exit
# … record InteractionConfirmed rows, remove markers …
[ "$RELEASED_LOCK" -eq 1 ] && printf '<tenon-interaction-confirmed>\n用户已确认，待确认的交互已解封；请重试刚才被拦截的操作。\n</tenon-interaction-confirmed>\n'
```

## Scenario: Per-user active Change and the bash identity mirror

### 1. Scope / Trigger

- Hooks: `active-change.sh` (sourced by gate, skill-tracker, skill-start, decision-recorder, codex-skill-receipt,
  review-ack, confirm-clear-prompt, interactive-skill-gate), `interaction-authority.sh`, `router.sh`, `breadcrumb.sh`.
- Trigger: several developers on one repository. The retired repository-wide `.pipeline-active` and
  `.pipeline-interaction-authority` files let one user's selection and delegated authority steer another user's hooks.

### 2. Signatures

```text
hooks/tenon-user.sh (source-only)   pipeline_user_id <root> · pipeline_user_slug <root> · pipeline_user_local_dir <root>
                                    pipeline_ensure_user_local_dir <root>
<root>/.tenon/users/<slug>/local/active-change   "<change>\n"
<root>/.tenon/users/<slug>/local/authority       pipeline-interaction-authority-v2 lines (grammar unchanged)
```

### 3. Contracts

- Identity order mirrors kernel `resolveTenonUser`: `TENON_USER` → `<configRoot>/user.json` (regular file ≤ 4096 bytes)
  → `git config user.email`. An invalid higher source is missing; it never falls through. The config root follows
  `TENON_RUNTIME_ROOTS.configRoot` → `TENON_RUNTIME_CONFIG_ROOT` → `$TENON_RUNTIME_HOME/config` → Darwin Application
  Support → `${XDG_CONFIG_HOME:-$HOME/.config}/tenon`.
- The slug is computed in pure bash (`LC_ALL=C`, lookup-table lowercase, `@` → `-at-`, other characters → `-`, no `-`
  after `-`) and must equal kernel `userSlug`.
- Missing identity means no selected Change and no authority: evidence hooks do nothing and exit 0. Hooks never block
  on the owner rule; the CLI does.
- Hot path: no node, python or jq; `git` is spawned only when env and the config file do not decide.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `TENON_USER=a@x.io`, pointer `alpha` | breadcrumb / evidence use `alpha` |
| Another user's pointer names `beta` | ignored for this user |
| No identity anywhere | no selected Change, exit 0 |
| `TENON_USER=not-an-email` with a valid git email | missing (no fall-through) |
| User A's authority for Change + host session | unlocks A only; B's interaction gate still arms |
| Symlinked `local/` | readers ignore it; the authority writer refuses |

### 5. Good / Base / Bad Cases

- Good: two terminals with different `TENON_USER` values resume their own tasks in the same repository.
- Base: one developer with only `git config user.email`.
- Bad: reading a repository-wide pointer, or mixing sources (an env id with a git name).

### 6. Tests Required

- `tools/test-hooks.sh` section 13 (two users, missing identity, config and git sources, authority isolation);
  fixtures select Changes through `set_active` under `TENON_USER=hooks@tenon.test`.
- `packages/cli/src/user-hook-parity.integration.test.ts`: bash slug equals TypeScript slug for env, config and git cases.

### 7. Wrong vs Correct

#### Wrong

```bash
name="$(<"$root/.pipeline-active")"   # shared by every user of the repository
```

#### Correct

```bash
dir="$(pipeline_active_change_dir "$root" || true)"   # the current user's own local/active-change
```
