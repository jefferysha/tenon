# Release notes

Tenon release notes explain what changed, what users need to do, and how to verify an upgrade.

Only capabilities included in a public distribution belong here. Plans, internal ADRs, and unmerged experiments are not presented as shipped work.

## v0.1.0 · 2026-09-22

Version numbering restarts at 0.1.0. Tenon is young, and a 1.x number claimed a maturity it did not have.
This release also delivers the capabilities built after v1.1.5.

### Version reset

- Numbering restarts at 0.1.0 and continues 0.1.x, 0.x. The retired v1.0.0–v1.0.9 and v1.1.0–v1.1.5 releases
  and tags are removed, and those 16 numbers are never published again: the release candidate rejects them.
- Install order ranks every retired 1.x number below every other stable version, so 0.1.0 is an upgrade from
  1.1.5, while a newer 0.x is never silently replaced by an older one. `tenon update` names the retired version
  it migrates away from, so the change is never silent.

### Upgrade from 1.x

Run the versioned installer once for each host you use, then open a new host session:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.0/install.sh | /bin/bash -s -- --codex
```

`tenon update` on a 1.x installation reports a downgrade to 0.1.0 and changes nothing. That refusal ships inside
the published 1.x code and cannot be fixed retroactively, so the one-liner above is the migration path. The daily
automatic update on a 1.x machine logs the same refusal. After migrating, `tenon update --codex` (or `--claude`)
is again the routine upgrade.

### More than one person per repository

- Tenon resolves a declared identity from `TENON_USER`, then `<config>/user.json`, then the repository's own
  configured user email, with no login. New records carry the actor who wrote them.
- Every task has a creator and an owner; another user takes over with 接手. Advancing a task you do not own is
  refused.
- Per-user state lives under `.tenon/users/<slug>/`, so two people in one repository no longer overwrite each
  other's active task or authority state. The Dashboard shows the current user and filters the workspace list by
  owner.

### Task archive and deletion

- 归档 / 取消归档 hides a task for one user only, and is reversible.
- 删除 removes a task from the working tree without committing, and the Dashboard says so before you confirm.
- `tenon task delete|archive|unarchive <name>` and `tenon list --archived`.

### Workflows are data

- `openspec: true` is the single OpenSpec switch in a workflow.
- Each track declares its own `document_contract`: which documents a step produces, updates or requires. The
  kernel's fixed per-phase document tables are gone, and the global default workflow spells the tables out.
- The Dashboard workflow page edits the inputs, skills, executors, outputs, reviewers and gate of every step, and
  a workflow's steps, tracks and gates (评审 or 自动) are stored globally rather than per project.

### One skill instead of seven

- A single `tenon` skill drives every step from `tenon status <change> --json`, whose `step` block names what to do
  next, including pending agent runs and required tests.
- `tenon spec apply` applies a delta spec to the main spec.

### Executors and reviewers per step

- A step declares executors and reviewers: `tenon agent next|prompt|record`. Nine builtin agents ship with the
  release (builder, researcher, architecture, frontend-quality, backend-quality, code-size, security,
  spec-consistency, e2e).
- Tenon computes a reviewer's verdict from its findings and the severity that blocks the step, records every run
  as evidence, and freezes the agent set for a task when the task is created.
- Agents run in the host (Claude Code's Agent tool, or a Codex subagent). The Dashboard never calls a model.

### Test evidence per step

- Steps declare tests with a command, inputs and outputs, run through `tenon test run <change> <test-id>`, and the
  transition gate refuses to advance while a required test record is missing or stale.
- Nine builtin test directions ship as a library: unit, integration, e2e, playwright, typecheck, regression,
  benchmark, code-size and design-system. Run logs, traces and screenshots are kept per run for the acting user.

### Instruction files, templates and projects

- Tenon writes project and user instruction files (AGENTS.md, CLAUDE.md, GEMINI.md) from 32 builtin template
  blocks, and reports a conflict instead of overwriting a file that changed outside Tenon.
- The library page collects agents, templates, the resource catalog and test directions; builtin items are
  read-only and can be copied before editing. A single 新建项目 button creates or adopts a project.

### Design system and resource catalog

- A project's design system lives in `DESIGN.md`, with `tenon design` and a design-system workflow to produce it.
  Creating a frontend task is refused until the design system is ready.
- The resource catalog ships 163 builtin entries (`tenon resources`), so a step can name the libraries and
  references it is allowed to use.

### Upstream skills

- Setup and update install 53 upstream skills, declared in `skills/sources.yaml`, into the plugin root. A lock
  file records each skill's commit, tree digest and license, and a failed fetch leaves the active release
  untouched.
- The installed payload therefore grows to roughly 48 MB. A digest cache keyed on file stat keeps the measured
  hook dispatch overhead within about 7 ms of v1.1.5.

### Compatibility

- v0.1.0 has no earlier 0.x release, so the N-1 compatibility gate is skipped for this release only, and reported
  rather than silent: the fixture names v0.1.0 and the tooling exits with a documented skip code. v0.1.1 pins
  v0.1.0 as its baseline.
- Because of that, v0.1.0 is not proven to read tasks created by 1.x. Finish or archive an in-flight 1.x task
  before migrating, or expect to recreate it.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventories, the active managed runtime and the Dashboard all report 0.1.0, and a repeated
`tenon update --codex` reports that the release is already in effect.

## v1.1.5 · 2026-09-15

Found while continuing the same real Codex task on v1.1.4.

### Specs

- A Chinese delta spec no longer reaches Verify before learning that OpenSpec strict validation needs the
  English `SHALL` or `MUST` in every requirement. The scaffold prompt (both locales) and the `tenon-spec` skill
  now state the rule, and the skill runs `openspec validate <change> --strict` before requesting the spec
  review when the official CLI is available. The Codex task wrote requirements with 「必须」, passed the spec
  review, and was sent back from Verify.

### Review gate

- A reply that does not confirm a pending review now says which reply does, the same as for interactions.
  At `verify-fail` the agent offered 「修复」 as an answer; the gate ignored it silently.
- `tenon-verify` tells the agent to name 「确认继续」 when it pauses at `verify-fail`.

### Upgrade

Install the new release for each host you use, then open a new host session:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.5/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.5/install.sh | /bin/bash -s -- --codex
```

## v1.1.4 · 2026-09-15

Found while running a real Codex task on v1.1.3.

### Codex skill evidence

- A complete `SKILL.md` read now counts as skill evidence in both exec program forms Codex writes.
  Tenon recognised only `const r = await tools.exec_command({...}); text(r);`, so a read written as
  `text(await tools.exec_command({...}));` produced no evidence: the first `tenon document record` after
  it failed with `current StepVisit lacks exact host confirmation`, and the agent had to read the skill
  again. Both forms must still forward the complete result of exactly one awaited call; `.output`,
  unawaited calls, wrapped results and extra statements are rejected as before.
- That error now says how to recover: invoke the producer skill again in the current step (Claude Code:
  the Skill tool; Codex: one standalone `cat` of its `SKILL.md` with a `max_output_tokens` large enough
  for the whole file, because a truncated read is not evidence), then retry the record. A Codex agent
  read the 20 KB `tenon-explore` skill with a 1,000–2,000 token budget twice before guessing a larger one.

### Upgrade

Install the new release for each host you use, then open a new host session:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.4/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.4/install.sh | /bin/bash -s -- --codex
```

## v1.1.3 · 2026-09-15

Found while installing v1.1.2 for Codex on a slow proxy connection.

### Installer

- A dropped or slow connection to GitHub no longer aborts the install. The stable release proof ran
  `git ls-remote` and a shallow `git fetch` once, so a single `ETIMEDOUT` or TLS reset
  (`SSL_ERROR_SYSCALL`) failed `install.sh`. Both calls now retry transport failures up to three times
  with a short backoff. A missing tag or ref still fails immediately, and every result is validated
  exactly as before.

### Interaction gate

- An approval that releases a pending interaction now says so in the conversation. A Codex agent that
  had been blocked earlier assumed the gate still held after the user replied 「确认继续」 and stopped
  without retrying the blocked action.

### Upgrade

Install the new release for each host you use, then open a new host session:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.3/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.3/install.sh | /bin/bash -s -- --codex
```

## v1.1.2 · 2026-09-15

Fixes found by continuing real Claude Code and Codex tasks on v1.1.1.

### Interaction gate

- An interactive skill (`brainstorming`, `grilling`, `grill-with-docs`, `prototype`, `huashu-design`) asks the user
  once per step visit. Codex records a document only after re-reading its producer skill; for an
  interactive producer that re-read locked the same question again, so Explore could not record its
  design or ADR in Codex. An approval now leaves an `InteractionConfirmed` history row, and the gate
  does not lock that skill again until the step is entered again.
- The gate names the reply that unlocks it (「确认继续」, 「继续执行」 or 「同意继续」). A reply that is not
  recognized as approval while a question is pending now tells the agent so instead of being ignored.

### Upgrade

Install the new release for each host you use, then open a new host session:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.2/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.2/install.sh | /bin/bash -s -- --codex
```

## v1.1.1 · 2026-09-15

Fixes found by running real tasks on the published v1.1.0 in Claude Code and Codex.

### Host compatibility

- Claude Code loads the plugin again. Claude Code 2.1 loads the standard `hooks/hooks.json`
  automatically and refused a manifest that referenced it a second time, so no Tenon skill or hook
  was available. The Claude manifest no longer declares `hooks`.
- Documents can be recorded from Claude Code. Claude Code reports plugin skills as
  `tenon:<skill>`; the Skill receipt rejected that name, so every `tenon document record` failed with
  `current StepVisit lacks exact host confirmation` and the default workflow could not leave `open`.
- Tenon runs inside the Codex sandbox. Codex's `workspace-write` sandbox denies `/bin/ps`; the state
  lock now records a pid-only owner instead of failing with
  `withLock: current process start identity is unavailable`.
- `tenon doctor` turns red when the host reports that the Tenon plugin failed to load.

### Workflows and Dashboard

- Tracks created in the Dashboard work end to end. Skills no longer check a workflow branch track
  with `tenon tracks show`, which only knows the project Track registry; `tenon tracks show` explains
  branch tracks when an id is not registered.
- An archived run shows no current stage.
- A stage without runtime artifacts returns an empty catalog instead of a failed request on every
  refresh.

### Upgrade

Install the new release for each host you use, then open a new host session:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v1.1.1/install.sh | /bin/bash -s -- --codex
```

Verify with `claude plugin list` (Tenon enabled, no errors) and `tenon doctor`.

## v1.1.0 · 2026-09-15

### Workflow editor and workspace

- The Dashboard is reduced to two views: the workspace (projects, Changes, stage rail, per-stage
  Skill flow with run status, input/output files, runtime artifacts) and the workflow editor.
- Workflows are stored per user and are not bound to a project. Each workflow owns Track branches;
  stages are reordered by drag, gates are `review` or `auto`, and a stage may declare where it
  returns to. Skills are composed on a canvas where dropping on a column runs them in parallel and
  dropping to the right runs them serially.
- Runtime artifacts keep producer, version and lineage; document and field outputs share one
  submission path.

### Review decisions and gate safety

- A pending review can be approved from the terminal or from the workspace right column. Both use
  one shared acknowledgement application, so the canonical state, interaction record and history
  line are identical apart from the entry channel (`review_acknowledged_via`).
- Every rejected acknowledgement writes nothing. Dashboard requests carry an expected revision and
  an idempotency key; stale or conflicting requests return 409 with a stable code, and unexpected
  errors return 500 without internal details. `tenon review acknowledge` exits `2`, `3`, `4` or `1`
  for review-required, revision, idempotency and invalid-command failures.
- Transitions out of a review step require an exact receipt plus a matching binding on every entry
  point. `tenon set/set-many/cas` can no longer move `phase`, and `tenon state import-legacy` keeps
  transition-controlled fields and reports any it ignored.
- The local HTTP transition route can never satisfy a loop human gate. While a review is pending,
  reads of the Dashboard token and loopback API calls are recorded as redacted self-approval
  observations, including in AFK mode.

### Security

- `fast-uri` is updated to a release without the high-severity advisories.

### Upgrade

Install the immutable `v1.1.0` entrypoint, or run `tenon update --codex` (or `--claude`). Open a
new host session afterwards so the updated Skills and hooks are loaded. `v1.0.9` remains immutable
for rollback.

## v1.0.9 · 2026-09-02

### Dashboard reliability and Pipeline clarity

- Finite adapter-install event streams now close deterministically after completion, surface
  malformed or unavailable transport errors, and never leave the install action stuck in a busy
  state. Switching projects detaches the previous stream so late events cannot leak into the new
  project.
- Definition-catalog SSE requests clean up even when the browser closes during the initial load;
  slow catalog projections are serialized so revisions cannot arrive out of order or regress the
  visible definition.
- Change creation waits for catalog reconciliation and explains loading, unavailable, and empty
  states. The selected Pipeline now previews every Stage's serial/parallel mode, Skill order, and
  declared dependencies before the first run.
- Adapter request booleans are type-checked instead of coercing string values, keeping dry-run and
  confirmation semantics explicit for API clients.

### Compatibility and scope

- Existing Changes keep their frozen Workflow/Track/Pipeline identity; the GUI continues to expose
  the canonical Workflow/Track-derived Pipeline. Independent named Pipeline blueprints remain
  available through planner-v2 until a persisted Pipeline Registry is introduced.

### Upgrade

Install the immutable `v1.0.9` entrypoint, then use `tenon update --codex` (or `--claude`) for
routine upgrades. The previous `v1.0.8` release remains immutable and can be used for rollback.

## v1.0.8 · 2026-09-02

### Orchestration input and execution runtime

- Skill dependencies are materialized into a versioned `skill-input-manifest/v2` and
  bounded input bundle before execution. Executors and validators receive the same
  digest-checked inputs, while rejected input delivery fails closed without invoking
  the Skill.
- Canonical Skill output is atomically persisted under `.tenon-artifacts/`, registered
  with an `artifact://` reference, schema, byte count, and SHA-256 digest, and resolved
  by downstream Skills through the manifest contract.
- Custom Workflow, Track, Pipeline, Stage, and Skill dependencies honor declared
  serial/parallel modes and resource claims; overlapping write claims are never run
  concurrently.

### Security and dependency maintenance

- The Browserslist dependency is pinned to the first patched release (`4.28.7`) through
  the repository override and lockfile, removing the high-severity advisory without
  weakening the audit gate.

### Upgrade

Install the immutable `v1.0.8` entrypoint, then use `tenon update --codex` (or `--claude`)
for routine upgrades. Existing Changes retain their frozen Workflow/Track/Pipeline
identity until an explicit replan.

## v1.0.7 · 2026-08-11

### Cross-version installer bridge recovery

- The public installer can take over a durable WAL from an older stable release only after that transaction reached the completed host phase `plugin-installed` and the installed plugin plus Marketplace still exactly match the older stable version, tag, commit, official origin, ref, and clean checkout.
- WALs in any other phase, with malformed or unknown data, a same-version target whose tag/commit is not the exact current proven target, any newer target, or any host inventory drift fail closed before host mutation and remain available for diagnosis or recovery.
- An exact same-target WAL keeps the existing same-target recovery semantics.
- The old transaction is atomically replaced by a current-target transaction whose before-snapshot is the verified host state; existing exact provenance, trusted-host, lock, atomicity, and packaged setup checks remain unchanged. There are no retries, fallbacks, or weakened stable Release/object proof checks.

### Upgrade

Install the immutable `v1.0.7` entrypoint, then use `tenon update --codex` (or `--claude`) for routine upgrades.

## v1.0.6 · 2026-08-11

### Stable Git proof budget

- Real slow-link measurements showed that the public stable tag/object proof can exceed the previous 30-second Git budget: proxy `ls-remote`/fetch took 6.9s/11.3s, while direct fetch reached 22.9s and formal transactions still observed occasional longer phases.
- Git remote `ls-remote` and fetch now use a bounded 60-second budget. GitHub Release API metadata and the npm bootstrap raw installer download remain bounded at 30 seconds; local init/rev-parse/cat-file proof remains 10 seconds, and host observation keeps its default 5 seconds.
- Exact stable tag/object/commit, digest, trusted executable, official HTTPS host, size, and atomicity checks are unchanged. There are no retries or source/branch/cache fallbacks, and failures remain closed before mutation.

### Upgrade

Install the immutable `v1.0.6` entrypoint, then use `tenon update --codex` (or `--claude`) for routine upgrades.

## v1.0.5 · 2026-08-11

### Doctor release identity proof

- The `tenon doctor` release-identity probe now propagates the bounded 30-second budget for remote Git tag/object proof and the 10-second budget for local proof commands.
- Host observation commands retain their default 5-second timeout; no retry, source/branch/cache fallback, or trusted-executable/security validation is weakened.

### Upgrade

Install the immutable `v1.0.5` entrypoint, then use `tenon update --codex` (or `--claude`) for routine upgrades.

## v1.0.4 · 2026-08-11

### Public installation and update network budget

- The shell installer’s GitHub Release metadata/tag proof, `tenon update` Release metadata fetch, and the npm bootstrap installer download now share a bounded 30-second network budget.
- Exact stable Release, tag/object, digest, host trust, HTTPS host, size, and atomicity checks are unchanged.
- There are still no retries or source/branch/cache fallbacks; failures remain closed before mutation.

### Upgrade

Install the immutable `v1.0.4` entrypoint, then use `tenon update --codex` (or `--claude`) for routine upgrades.

## v1.0.3 · 2026-08-11

### Stable Release proof diagnostics

- Remote tag and object proof now keeps a bounded 30-second network budget instead of the previous 10-second budget; local proof commands remain on a 10-second budget.
- Timeout failures now preserve actionable stderr diagnostics such as `ETIMEDOUT` instead of returning an empty error detail.
- Security validation, atomic publication, and the no-retry/no-fallback behavior are unchanged.

### Upgrade

Routine upgrades still use `tenon update --codex` (or `--claude`) and remain bound to the verified stable Release tag.

## v1.0.2 · 2026-08-08

### Versioned installation and updates

- The public one-line installer is pinned to immutable `v1.0.2` prebuilt assets; it never installs from `main` or compiles source.
- `tenon update --codex` resolves the official latest stable GitHub Release, freezes its tag and commit, and rebinds the Codex Marketplace through host-owned commands.
- Exact same-version host/runtime/Dashboard state is a zero-mutation no-op; downgrade attempts and unverifiable Release metadata fail before mutation.
- Setup always waits for Dashboard readiness. Piped/CI installs and all updates keep the browser closed and print the verified URL plus `tenon dashboard --open`.

### Upgrade

Existing v1.0.1 users run the immutable `v1.0.2/install.sh` one-liner once; the
v1.0.1 launcher cannot safely self-rebind the new tag in one old-updater
invocation. From v1.0.2 onward, run one `tenon update --codex`. Open a new Codex
session to load the released Skills and hooks, then run `tenon doctor --json`.

## v1.0.1 · 2026-07-26

### Normal-chat entry contract

- `product/identity.json` now declares `entrySkill: "tenon"` as the only public entry.
- Codex normal chat invokes `tenon:tenon`; no secondary entry alias is retained.
- Root `AGENTS.md` and the Codex static adapter consume one generated managed block.
- `tenon doctor` verifies the entry Skill and reports an enabled conflicting workflow plugin as a red finding.
- `tenon setup --codex -y` removes that exact retired registration through the official Codex plugin manager before activating Tenon.

### Repository and release hygiene

- CI and Release scan every tracked path and text file for restricted external reference identities.
- Matching is case-insensitive, has no exemptions, and diagnostics never echo a restricted identity.
- The same checks run before the release payload is built.

### Upgrade

Run `tenon update --codex`, then `tenon setup --codex --auto-update -y`. Open a new Codex session and run `tenon doctor --json`.

## v1.0.0 · 2026-07-26

### Governed document locale

- New Changes pin governed documents to `zh-CN` by default.
- `tenon init`, `tenon document scaffold`, and the default OpenSpec fallback share one Document Presentation Registry.
- Users can explicitly select `--document-locale en`.
- A pinned Change cannot silently switch locale.
- Historical Changes infer locale from the writing system used by existing H1 headings.
- Mixed or ambiguous signals fail loudly and require an explicit locale.

### Execution modes

- Discussion handles ordinary conversation without a state machine.
- Simple uses `change → verify → done` and does not create the full OpenSpec chain.
- Default uses `open → explore → spec ⇄ build ⇄ verify → ship → archive`.
- Free binds an explicit workflow without adding a domain Track.
- Custom follows only its declared DAG, Skills, gates, and document contract.

### Documentation site

- The repository README defaults to Chinese and links to `README.en.md`.
- The site exposes Chinese at the root and the English mirror under `/en/`.
- Local search is built from the public content manifest.
- GitHub Pages deploys only from `main`.
- Pull requests build and verify but do not deploy.
- The artifact is checked against a closed allowlist and scanned for sensitive material.
- `llms.txt` indexes only public pages.
- Internal ADRs, Superpowers plans, review receipts, and local control-plane state are excluded.

### Installation and updates

- Install for Codex with `tenon setup --codex`.
- Install for Claude with `tenon setup --claude`.
- Update with the matching `tenon update --codex` or `tenon update --claude`.
- The managed runtime is content-addressed and the stable launcher targets a verified release.
- A failed update preserves the previous release for `tenon runtime repair --rollback`.
- Dashboard listens on `127.0.0.1:18765` by default.

## Upgrade checklist

1. Inspect the repository working tree.
2. Run the update command for the selected host.
3. Run `tenon runtime status`.
4. Run `tenon doctor`.
5. Run `tenon list --json` in the project.
6. Confirm Dashboard uses `127.0.0.1:18765`.

## Verification

- `tenon --help` lists the command families.
- `tenon runtime status` reports the active runtime.
- `tenon doctor` reports no missing bundled Skills.
- Repeated `tenon setup --codex` remains idempotent.
- Updating does not rewrite canonical Change state.
- A new test Change creates Chinese proposal, design, and tasks files.
- An explicitly English Change keeps newly scaffolded documents in English.

## Compatibility

The canonical Change codec does not gain a locale field. Locale lives in the rollback-compatible `.pipeline-document-locale.json` sidecar.

## Rollback

Run `tenon runtime status`, then use `tenon runtime repair --rollback` to return to the previous verified content-addressed release.

Runtime rollback does not remove project Changes, OpenSpec documents, or evidence ledgers.

## Next action

Read [Updates, recovery, and uninstall](./updates-recovery-and-uninstall.md) for the complete maintenance and recovery workflow.
