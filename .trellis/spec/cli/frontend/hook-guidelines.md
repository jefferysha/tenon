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

### Common Mistake: quadratic string handling on hook input

**Symptom**: every PostToolUse hook is reported as `hook_cancelled` after a long heredoc command or a command with a
large output. Measured on macOS `/bin/bash` 3.2 (the shell the stable bootstrap spawns): a 21 KB heredoc took 67 s in
test-nudge, 18 s in skill-tracker; a 1.3 MB tool output took ~15 s in gate/test-nudge. The host limit is 5 s.

**Cause**: per-character loops that copy the rest of the buffer (`rest="${rest:1}"`), `while … "${s//  / }"` collapse
loops, repeated `value+=` on a growing string, and — on bash 3.2 — any `${var//pattern/repl}` with many matches.

**Fix**: split with `read -r -d '' -a` (one linear pass per delimiter) and join arrays once; take a no-escape fast path
(`${rest%%\"*}`) before any split; never append empty strings to an array you later join with `${arr[*]}` (bash 3.2
leaks its `\177` null marker). Prefilter the raw payload before decoding (skill evidence needs `SKILL.md`), and let
consumers that only act on short commands use `pipeline_json_get_command_bounded` (over-long = not allowlisted).

**Prevention**: `tools/test-hooks.sh` feeds a 166 KB heredoc and a 1.3 MB output to every PostToolUse hook and gate and
requires each to finish within 3 s.

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
- While any marker is pending, `gate.sh` passes `AskUserQuestion`, `request_user_input` and `ToolSearch` (Claude Code
  defers AskUserQuestion behind ToolSearch; blocking the loader deadlocks the question) plus read-only tools; the block
  message tells the model to load the question tool with `ToolSearch` `select:AskUserQuestion`.
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

## Scenario: Tasks archived for the current user

### 1. Scope / Trigger

- Hooks: `task-archive.sh` (new, source-only), applied in `active-change.sh`, `host-session-binding.sh`,
  `router.sh`, `breadcrumb.sh`, `session-start.sh`, `statusline.sh`.
- Trigger: 归档 hides a task for one user only. Every hook that already skips a 完结 Change
  (`archived=true`) must skip an archived-for-me Change identically: no resume, no evidence, no statusline
  entry — while the same Change stays visible to everybody else in the repository.

### 2. Signatures

```text
hooks/task-archive.sh (source-only)  pipeline_task_archive_store <root>            # resolve once per hook run
                                     pipeline_change_archived_for_user <store> <change>
<root>/.tenon/users/<slug>/local/archived.json   canonical two-space JSON written by the kernel
```

### 3. Contracts

- **ABI**: the kernel serializer (`kernel/src/workspace/task-archive.ts`) writes
  `JSON.stringify(value, null, 2)` with `changes` at depth one, so a Change key is always the exact line
  `    "<name>": {`. The hook greps that anchored line. Changing the serializer's indentation breaks every
  hook, so the two must change together.
- **One resolution per run**: `pipeline_task_archive_store` is called once before a scan loop and its result
  is passed to each `pipeline_change_archived_for_user` call — the scan stays one grep per Change.
- **Fail-open**: absent, non-regular, symlinked, unreadable, oversized (> 1 MiB) or malformed store hides
  nothing. 归档 is a display preference and must never block progress.
- **Per user**: another user's `archived.json` is never consulted; a missing identity hides nothing.
- Hot path: pure bash 3.2 plus one `grep`; no node, python or jq. The check runs after the
  `archived=true` check, never instead of it.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Current user's store names the sole Change | router injects nothing, `active-change.sh` returns 1, session-start omits it, statusline empty |
| Another user's store names it | visible to this user |
| Symlinked or malformed store | visible (fail-open) |
| Key differs only by prefix (`sole-extra` vs `sole`) | not archived (the grep is line-anchored) |
| No identity | nothing hidden |
| `archived=true` (完结) | already skipped by the existing check |

### 5. Good / Base / Bad Cases

- Good: A archives a task; A's router stops resuming it while B's router still does.
- Base: no archive store at all — every hook behaves exactly as before the feature.
- Bad: parsing `archived.json` with node or jq in the hot path, re-resolving the store per Change, or
  replacing the `archived=true` check instead of adding to it.

### 6. Tests Required

- `tools/test-hooks.sh` section 14: before / after archiving for router, breadcrumb, statusline,
  session-start and `active-change.sh`; another user's store, a symlinked store, a prefix-only key and a
  malformed store all fail open; red line greps the comment-stripped hook for node / jq / python.
- `packages/kernel/src/workspace/task-archive.test.ts` pins the serializer bytes that form this ABI.

### 7. Wrong vs Correct

#### Wrong

```bash
node -e "…JSON.parse(require('fs').readFileSync(store))…"   # spawns a runtime in the hot path
```

#### Correct

```bash
store="$(pipeline_task_archive_store "$root" || true)"       # once per hook run
pipeline_change_archived_for_user "$store" "$change" && continue
```

## Scenario: GSAP motion gate (`gate.sh` → `internal-motion-gate`)

### 1. Scope / Trigger

- Trigger: any change to the animation rule, its markers, or the file-edit tools it watches.
- Writing GSAP code without having loaded the matching official GSAP skill is refused. Unlike the skill DAG gate
  this rule is not workflow-specific: `default` is covered too.

### 2. Signatures

```bash
pipeline_enforce_motion_gate()            # hooks/gate.sh; 0 = allow, 2 = block
```
```ts
requiredGsapSkills(toolInput: string): readonly string[]
cmdInternalMotionGate(deps, change, stdin): Promise<0 | 2>
```

### 3. Contracts

- Candidate detection is pure bash on the already-read `$INPUT`: only `Write|Edit|MultiEdit|NotebookEdit|apply_patch`
  whose input contains `gsap`, `GSAP`, `ScrollTrigger` or `useGSAP` reaches the CLI. A non-candidate call forks
  nothing, which keeps the hot path's zero-spawn promise intact (`tools/test-hooks.sh` asserts it with a fake
  `node` that would exit 2 if it were ever spawned).
- No project root or no active Change → allow. The delegation runs `node <bundle> internal-motion-gate <change>`
  from the project root with the tool input on stdin, exactly like the skill gate, and only exit 2 blocks.
- Required skills: every candidate needs `gsap-core`; `@gsap/react` / `useGSAP` add `gsap-react`; `ScrollTrigger` /
  `ScrollSmoother` add `gsap-scrolltrigger`; `.timeline(` adds `gsap-timeline`; the plugin names add `gsap-plugins`;
  a `.vue` / `.svelte` path adds `gsap-frameworks`.
- Evidence is the shared step-scoped scan (`commands/stepSkillEvidence.ts`): skills completed since the latest
  entry into the current step, from `Skill:` and `CodexSkillRead:` rows, compared namespace-insensitively.
- Any internal error is a `WARN` and an allow. The gate never blocks because of its own failure.
- Codex hook coverage of file edits is host-defined; whether `apply_patch` reaches `gate.sh` is verified in the
  wave-5 real-host acceptance. Where it does not, the reviewer's motion checklist is the enforcement.

## Scenario: agent skill gate (`gate.sh` → `internal-skill-gate`)

### 1. Trigger

A step's agent declares `skills:`. Those skills are not part of the step's own `skills[]`, so the
progressive gate would block them — while the agent that needs them is running.

### 2. Contracts

- The bash side is unchanged: `gate.sh` still delegates to `internal-skill-gate`, and only exit 2 blocks.
- The CLI answers `allow` for a skill that belongs to an agent of the current step **only while that agent
  has a `running` row in `.pipeline-agent-runs.jsonl` for the current step visit**. Otherwise the answer is
  `not-agent-skill` and the existing progressive rules decide.
- The decision reads the frozen agents of this run (`readFrozenAgents`), never the live library: the library
  may have moved on; this Change did not.
- Cost: the workspace fingerprint (the reviewer candidate) is computed only when such a `running` row
  exists. A Change created before agents existed restores a pre-agents frozen plan, so the step declares no
  agent and the gate returns `not-agent-skill` before any freeze read.
- A corrupt ledger fails closed like every other agent read: the skill stays blocked and the message names
  the damaged line.

## Scenario: User-named Track in the router (`router.sh`)

### 1. Scope / Trigger

- Hook: `router.sh` (UserPromptSubmit), new-task dispatch only (`intent: new`). A resumed Change keeps the Track
  from its state; a selection turn keeps `unresolved`.
- Trigger: v0.1.2 real session — 「……走 free 轨道即可」 was routed as `疑似 track=simple（评分 1）`.

### 2. Signatures

```text
<tenon-dispatch> … track: <id> · track_basis: user-named | score | state | none
router header    track=<id>（用户点名） | 疑似 track=<id>（评分 N）
```

### 3. Contracts

- Named forms (pure bash `=~`, at most 8 matches per pattern, no process spawn): Chinese verb + id + 轨道/赛道/track
  (「走 free 轨道」「用 backend 轨道」); `track=<id>` / `track: <id>` / `轨道：<id>` / `--track <id>`;
  English `use|using|choose|pick|select|go with|switch to [the] <id> track`. Id comparison is ASCII
  case-insensitive against the effective registry ids (builtins including non-routable chat/free, and project Tracks).
- Exactly one known id → bind it (`track_basis: user-named`), its profile and workflow default; the scorer is ignored.
- Negated naming (不/别/勿/不要/不用/无需/没/don't/do not/not/never right before the verb) is ignored.
- Two different known ids → fall back to scoring and tell the agent to confirm with the user.
- Unknown id only → fall back to scoring with a hint naming it. When scoring also finds nothing, the router stays
  silent as before.
- The older free-mode phrases (「用自由模式」…) still bind free and still bypass the discussion filter.

### 4. Tests Required

- `tools/test-hooks.sh` section 9: named free/backend/pm/English/simple, not named, unknown id, negated, two ids, and a
  project custom Track.
