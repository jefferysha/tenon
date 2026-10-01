# Release notes

Tenon release notes explain what changed, what users need to do, and how to verify an upgrade.

Only capabilities included in a public distribution belong here. Plans, internal ADRs, and unmerged experiments are not presented as shipped work.

## v0.2.1 · 2026-10-01

A hotfix for v0.2.0. After a restart of macOS every `tenon` command and every hook failed with
`tenon runtime Node identity changed; rerun tenon setup --codex or tenon setup --claude`, and the command that message
named was refused by the same check, so the install could not repair itself.

### Fixed

- The stable launchers (`~/.local/bin/tenon` and `tenon-hook`) pinned the device number (`st_dev`) of the Node binary
  and of each parent directory. macOS gives the same volume a new device number at every restart, so the pin never
  survived one. Launchers no longer store it. They still refuse a symlink on the Node path, pin the inode, mode, owner
  and size of the binary and the inode, mode and owner of its parent directories, and compare the Node's SHA-256 with
  the digest taken at setup. Linux gets the same change.
- A launcher that fails its Node check no longer locks you out. If the Node bytes are unchanged and only their identity
  moved, `tenon setup`, `update`, `doctor` and `runtime` still run, so `tenon setup --claude` (or `--codex`) re-pins;
  any other command prints one line naming that repair. If the Node was replaced or removed, the line is a complete
  command that runs the bootstrap with the Node on your `PATH`:
  `env TENON_RUNTIME_ROOTS=… node …/bootstrap/active.mjs cli setup --claude` (`--codex` for Codex).
- Hooks print that message at most once every 30 minutes and otherwise exit 0 without output. They never block the host.
- The release repairs v0.2.0-format launchers itself. `tenon update` run by v0.2.0 writes the old format again, so the
  first Tenon command or session start afterwards rewrites both launchers with the writer `setup` uses, but only when
  they are Tenon's own files (not symlinks), export the same roots, and pin the Node that is running with its recorded
  SHA-256. A command prints one line when it did so, or one line naming `tenon setup --claude` / `--codex` if it could
  not. Hooks stay silent and never wait for it. Anything else is left untouched.
- `tenon doctor` has a new check, `runtime:launcher`: WARN while a launcher still pins a device number, PASS otherwise.
- The payload digest cache no longer keys on the device number, so the first dispatch after a restart does not re-hash
  the whole payload.

### What you need to do

If every command already fails with `Node identity changed`, run the versioned installer once for each host you use. It
does not go through the broken launcher:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.1/install.sh | /bin/bash -s -- --codex
```

If v0.2.0 still works for you, run `tenon update --codex` (or `--claude`). The updater that runs is still v0.2.0 and
writes the old launchers once more; the first Tenon command or new session after it switches them to the restart-safe
format automatically. `tenon setup --codex` (or `--claude`) does the same by hand. A fresh install of v0.2.1 needs
nothing.

### Compatibility

No public command, option, project file or Dashboard API changed. The additions are the `runtime:launcher` doctor check
and an internal repair command; the launcher text changes (no device number, new failure messages). Projects and
runtime state are untouched.

### Verify

```bash
tenon runtime status
tenon doctor
grep -c '%d' ~/.local/bin/tenon
```

The runtime reports the active release and doctor is green, including `runtime:launcher`. The `grep` prints `0`. After
the next restart `tenon runtime status` still works.

## v0.2.0 · 2026-09-30

A capability release. Agents are now written and registered in the terminal, the whole workflow can be seen as one
canvas, and every task registers and runs all of its tests. The default workflow changes with it: agents are
attached to its steps and tests are required, so read "What you need to do" before you upgrade a project.

### Agents

- Agents are registered in the terminal with `tenon agent list`, `show`, `new`, `add`, `validate`, `copy`, `rm` and
  `export`. Every agent declares a `role` (`executor` or `reviewer`) and an optional semver `version`. `new` asks for
  what is missing in an interactive terminal and runs non-interactively when all flags are given. `rm` refuses an
  agent that a workflow step still uses and lists the steps. The Dashboard no longer creates agents; it displays them.
- Agents come from three sources. Official agents ship with the plugin (`builder`, `researcher`, `architecture`,
  `backend-quality`, `code-size`, `e2e`, `frontend-quality`, `security`, `spec-consistency`; name, version, role and
  digest are recorded in `templates/agents/manifest.json`) and are read-only. Custom agents live in the user config.
  Project agents live in `.tenon/agents/`, are committed, and are shared with the team. A project agent wins over a
  custom one of the same name; no source can reuse an official name, and such a conflict is listed and never used.
- The `tenon:agent-author` skill drafts an agent in Claude Code or Codex from your description (responsibility, what
  it does and does not do, method, self-check, report ending in a `tenon-result` block), validates it and registers it
  with `tenon agent add`. It writes no Tenon state.
- When a task freezes its agents, Tenon generates the host's native subagent files: `.claude/agents/tenon-<name>.md`
  or `.codex/agents/tenon-<name>.toml`. `tenon agent prompt` then returns `subagent_type: tenon-<name>`, so the host
  runs the agent as its own subagent and the tool allowlist is enforced by the host. If a file cannot be generated,
  the host falls back to a general subagent and the run record says so. The files are listed in `.pipeline-owned.json`,
  are removed when no running task uses them (also when the task is archived from the Dashboard), and `tenon
  uninstall` removes only files it generated and you did not edit.
- The default workflow now attaches executors: every Explore runs `researcher`, every Build runs `builder` (one
  subagent per independent task, merged into one report) before its reviewers, and every Verify declares the
  `code-size` test (`tenon test code-size --json`, passing while `lines_added` stays within 2000) and the required
  `code-size` reviewer. Chat and free also run `security` as an advisory Verify reviewer.
- The Library page lists agents grouped by role with source and version, shows the fields, the rendered body, the steps
  that use the agent and its recent runs, edits the body of custom and project agents, and copies an official agent as
  a custom one.

### Orchestration

- Skills run in waves. A skill that declares `depends_on` runs after the skills it names; skills in one wave run in
  parallel and waves run in series; skills without `depends_on` stay serial in declaration order, as before. The skill
  gate, `tenon status` and the canvas read the same order.
- The kernel projects a workflow (or a task's frozen plan) into an orchestration: per stage, the executors, skills,
  tests and reviewers in the order the runner takes them, the gate, return edges and the document flow. OpenSpec-injected
  and manifest-overlay skills are computed there instead of guessed in the page. Read-only endpoints:
  `GET /api/workflows/:name/orchestration?track=` and `GET /api/change/:c/orchestration?root=`.
- The workflow page has a 总览 row as the first step of the left column. Its right side is a full-width canvas with one
  column per stage (executor → skill → test → reviewer, gate in the column head, return edges dashed, document flow on
  hover) with zoom, fit and full screen. The workbench task detail has the same canvas as a 总览 tab, with each node's
  run state, the current stage highlighted, read from the task's frozen plan.
- The right pane of a single stage has four sections: 输入 → 技能 → 输出 → 门禁. The 技能 canvas shows executors, skills,
  tests and reviewers in lanes; "back to" moved into the gate section.
- A gate is 评审 (a person confirms) or 自动 (the declared outputs must all be set). `gate: null` and an omitted gate mean
  自动, so the workflow page offers two options. The outputs check applies to forward edges only; return edges such as
  `verify-fail` and `requirements-changed` are never blocked by it, and outputs the engine writes itself (`build_sha`,
  `archived`) are not part of it.

### Test system

- Every task registers all of its tests. The project has one catalog, `.tenon/tests/catalog.yaml` (tracked, human
  editable): each suite has a kind, runner, command, report format and path, optional coverage, artifact paths, services,
  retries, benchmark settings and a way to select changed files. `tenon test discover [--write]` recognises vitest, jest,
  mocha, node:test, Playwright, tsc, eslint, pytest and go, prints suggested suites with reporter flags that produce
  parseable reports, and `--write` adds the new ones.
- Each change has a test plan, `openspec/changes/<change>/test-plan.yaml`, written only by `tenon test` commands: the
  suites the change uses, the test files it added or changed, and the mapping from OpenSpec scenarios and `tasks.md`
  items to test cases. A hand-edited plan becomes `test-plan-tampered`.
- Every added or modified test file must be registered. `tenon test sync` and the step exit read the change's diff
  since it started (staged, unstaged and untracked files included) and block with `test-file-unregistered`; when the
  diff cannot be read they block with `files-diff-unavailable` instead of passing. Only scenarios and the tasks in the
  implementation section of `tasks.md` need a case; other tasks are optional.
- Workflows declare a `test_policy` per stage and track: which kinds must be registered, which must run (`changed` or
  `full` scope), coverage thresholds, benchmark baseline requirement, flaky limit, required browsers, and scenario
  coverage. `default` ships defaults for every track (for example frontend registers `unit` and `playwright` at spec,
  and Verify runs `unit`, `regression` and `playwright` on chromium and webkit with 80% line coverage). A stage without a
  policy and the old inline `tests[]` behave as before. Blockers have stable codes (`test-catalog-missing`,
  `test-plan-missing`, `test-kind-missing`, `test-not-run`, `test-failed`, `test-stale`, `no-tests-ran`,
  `coverage-below`, `scenario-uncovered`, …) with the fix command.
- Commands: `tenon test discover`, `catalog`, `plan`, `register`, `unregister`, `waive`, `sync`, `run`, `status`,
  `baseline`, `known`, `report`. `tenon test run <change>` runs by suite, kind, stage, changed files or everything.
  `tenon status` walks the flow in `step.next`: discover → seed the plan → map scenarios → register files → run the
  stage's tests → write the report.
- Results are parsed per case: JUnit (also pytest and surefire), Playwright JSON, Vitest JSON, Jest JSON, `go test
  -json`, TAP; benchmarks from benchmark JSON, hyperfine, k6 and Lighthouse. A run fails when there is no report, the
  report is unreadable, no case ran or all were skipped (`no-tests-ran`, so `"test": "exit 0"` no longer passes), the
  exit code and the report disagree, or a registered file or mapped case never ran.
- node:test suites from `tenon test discover` use a Tenon-shipped JUnit reporter (materialised in the run's artifact
  directory, nothing is written to the project), so every case has its file on Node 20, 22 and 24. When a report has no
  file, the case's file is recorded as unknown, and a registered case matches it by name only when that name is unique
  in the run.
- Suites can declare services. They start once per run in their own process group, are probed by URL, port or log text,
  and are stopped afterwards including grandchild processes. A URL or port that already answers before start is refused,
  because the tests would hit an old server.
- Failed cases are retried per suite (`retries`); a case that passes on retry is `flaky`, counted, and limited by the
  step policy.
- Coverage reads istanbul summary, lcov and cobertura and is judged against the policy; `changed_lines` comes from the
  diff.
- Benchmarks run warmup then N runs and keep the median, p95 and spread. Baselines are stored per machine profile in
  `.tenon/tests/baselines/<suite>/<profile>.json` and are committed. A regression beyond the threshold blocks on the
  same profile; without a baseline for the profile the run passes with a notice and the command to create one, unless the
  policy requires one; profiles never compare with each other.
- Known failures, `.tenon/tests/known-failures.yaml` (reason, optional link, expiry date): a listed case that still fails
  does not block, a new failure blocks, a case that now passes is reported with the command to remove the entry, and an
  expired entry counts as an ordinary failure.
- Playwright is the only browser evidence that counts. Screenshots, traces, videos and HTML reports are copied per file
  into the run, indexed with size and digest, and opened or downloaded one by one.
- Records are v2 (suite runs, cases, coverage, metrics, services, artifact index) and are bound to the code fingerprint,
  catalog entries, plan and workflow. They are written only by `tenon test run`, in a hash chain
  (`.tenon/users/<slug>/tests/<change>/<run-id>.json`, `prev_digest`). The gate hook refuses writes and shell
  redirects into the records, plans, baselines and known failures. Editing a record breaks the chain and the run counts
  as not run. Waivers for a missing kind or case need a person: `tenon review request` lists them and the user's
  confirmation approves exactly those.
- `tenon test report` writes a traceability matrix (scenario or task → case → latest result) into the verification
  report. Reviewers that declare `reads_tests` also get the failing and flaky cases, coverage and benchmark deltas.
- Dashboard 测试 views (read-only, no test is run or registered there): the project page lists the catalog's suites,
  baselines per machine profile and known failures; the workbench task has a 测试 tab (policy matrix, scenario trace,
  unregistered files, case-level failures) and a run drawer (failed cases, artifacts, coverage, benchmark against the
  baseline, logs); the workflow page edits each stage's test policy as a form; the Library shows test templates by
  runner. Endpoints: `GET /api/tests/catalog`, `baselines`, `plan`, `records`, `record`, `artifact`.
- Tenon's own repository registers its suites in `.tenon/tests/catalog.yaml`; CI runs the Dashboard browser tests on
  Chromium and the `tenon status` and snapshot benchmarks against the CI profile.

### Forms

- New workflow: pick a start point (blank, a copy of built-in `default` or `simple`, an existing workflow, or an imported
  YAML), a name and the OpenSpec switch; the right side previews the tracks and stages; name uniqueness and validity are
  checked as you type.
- New and edit template: name, category, frameworks (multi-select) and a Markdown body with an edit/render switch;
  placeholder variables are explained in a tooltip. Test templates in the Library are shown by runner, read-only.
- New project has a fifth step, 资源, between templates and clients: choose a component library, an icon set and a
  DESIGN.md. It works like the templates step (click a row to preview what will be written, add or remove from the
  preview head, filtered by the frameworks chosen before, switchable to all). The DESIGN.md is written by a streamed
  design step and an existing `DESIGN.md` is never overwritten. The default frontend spec prompt points at
  `tenon resources`.
- The skills page lists OpenSpec-injected and manifest-overlay skills in its references.
- All create dialogs share one behaviour: fixed height, Enter submits, Esc closes (asking first when there is input),
  validation under the field, help in tooltips.

### Fixes

- Codex: the managed block in `AGENTS.md` described per-phase skills that were removed. It now describes the single
  `tenon` skill. `tenon sync` reports the block as `absent`, `current`, `stale` or `invalid`, and `tenon sync --migrate`
  refreshes a stale one in place, touching only the lines between the markers.
- Playwright and other directory outputs were recorded as one directory and the Dashboard refused them (403). Every
  file is indexed and opens on its own; a saved artifact keeps its original file name instead of `artifact.zip`.
- The write-gate hook matched the whole tool input, so writing a document that merely mentioned a test-record path was
  refused. It now looks only at the write target (`file_path`, `notebook_path`, or the file headers of an
  `apply_patch`).
- The `hosts` list of an agent was never enforced because the `tenon` skill did not pass `--host`; it does now.
- Test runs that inherit `TENON_USER`, `TENON_RUNTIME_HOME`, `TENON_BASE_BRANCH` or `TENON_CHANGE_NAME` (for example
  `npm test` inside a Tenon session) no longer fail on identity assertions or write into the real runtime root; Vitest
  isolates all six variables per test file. Temp-directory cleanup retries, so a late write no longer surfaces as
  `ENOTEMPTY`. Vitest workers are capped at `min(8, cores)`, so full `npm test` runs alike locally and in CI.
- Documentation: the retired 1.x releases and tags are still published and stay until the v0.x real-host acceptance;
  `tenon user` and `tenon owner` are documented in the CLI reference and the contract; the AFK fail-closed error names
  the real gap (the caller did not inject `deps.preparation`).

### What you need to do

From v0.1.10: run `tenon update --codex` (or `--claude`), open a new host session and reload the Dashboard. The N-1 gate
reads and writes this release's data with the published v0.1.10 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.0/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.2.0/install.sh | /bin/bash -s -- --codex
```

Then, for every project that uses the default workflow:

- The default workflow now requires tests. Run `tenon test discover --write` once in the project, review
  `.tenon/tests/catalog.yaml` and commit it. Until a catalog exists, a new task is blocked at its first stage that
  has a test policy with `test-catalog-missing`, and `tenon status` shows the command.
- For Codex projects, run `tenon sync --migrate` once to refresh the managed block in `AGENTS.md`.
- Tasks that are already started keep the plan they froze: they do not get the new executors, test policies or gate
  behaviour, and finish under the rules they started with. New tasks get the new rules.
- To use your own agents, run `tenon agent new` (or the `tenon:agent-author` skill) and attach them to a step on the
  workflow page.

### Compatibility

- The CLI additions are new commands and new optional fields. Agent files without `role` still load (the role is
  inferred from the tools and `tenon agent validate` asks you to add it); v1 test records and steps that declare
  inline `tests[]` stay readable and in force; `gate: null` keeps working and means 自动.
- New project files: `.tenon/tests/` (catalog, baselines, known failures), `.tenon/agents/`, and per change
  `openspec/changes/<change>/test-plan.yaml`. Host agent files `.claude/agents/tenon-*.md` and
  `.codex/agents/tenon-*.toml` are generated and removed by Tenon; they are not part of a task's delivery commit.
- The Dashboard never runs or registers tests and never calls a model; registration happens in the terminal.

### Verify

```bash
tenon doctor
tenon runtime status
tenon test catalog validate
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.2.0. `tenon test catalog validate` is for a
project that has a catalog. Open the Dashboard: the workflow page
shows 总览 as its first step, the Library lists nine official agents grouped by role, and a project with a catalog shows
its suites under 测试.

## v0.1.10 · 2026-09-25

A Dashboard usability release, driven by walking through real user tasks end to end.

### New project

- Creating a project is now a four-step wizard: Location → Templates → Clients → Confirm.
- Folders are chosen with the system folder dialog (`POST /api/fs/choose-folder`); when no dialog is available an
  in-page folder browser is used (`GET /api/fs/list`). Typing a path remains a secondary option.
- The location step checks as you go: missing folder, not a git repository (with an "Initialize git" switch),
  already registered (with Open), and existing instruction files.
- Only `AGENTS.md` receives the full text; `CLAUDE.md` / `GEMINI.md` get a single `@AGENTS.md` import. Existing
  files can be appended to, replaced or skipped.
- Creation reports every step live (`POST /api/projects/create/stream`) with rollback and retry on failure, and
  stays on the result until you choose Open project.

### Projects

- Projects are organised by client: only the clients enabled for a project are listed, clients sharing one file
  are merged, and more are added from "+". The enabled set is stored in the project's `.tenon/clients.json`
  (`GET/POST /api/projects/clients`).
- Project level and user level are a switch inside the selected client; nothing is written just by opening or
  previewing; a missing `CLAUDE.md` can be created as an `@AGENTS.md` import.
- A project can be removed from the list (files are kept); load failures show an inline error with retry.

### Workspace

- Task readiness in the Dashboard now uses the same exit judgement as `tenon status` (skills, documents, tests,
  unchecked tasks). "Needs you" counts only pending reviews and is identical across all views.
- Each task shows a Next step block: one short line per blocker, a copyable status command and a copyable
  `/tenon 继续 <change>` prompt to resume it in the agent chat.
- Inputs, outputs and tests are tables; the stage bar is plain segments; filters fit one line.
- Deleting an untracked task says it cannot be recovered and asks for the name; archiving can be undone.

### Workflow, Library, Skills

- Every built-in workflow (including `simple`) is listed; OpenSpec-contributed skills appear on the canvas; new
  stages need only a name; deleting a workflow used by tasks is refused with the list of tasks.
- Skill canvases pulse continuously, each edge taking at least 480ms so short canvases pulse visibly.
- Library copies are named "… 副本" and open in edit; every list opens its first item instead of a blank pane.
- A failed skill source says why (for example, no installed release payload).
- View ids are `workspace` and `workflow`; old `progress` / `workbench` links redirect. The top-bar project
  switcher is gone on desktop; the connection dot only shows when disconnected.

## v0.1.9 · 2026-09-24

A Dashboard design release. After an in-depth aesthetic review (visual language, colour, typography, component
finish, interaction, motion) and research into top-tier developer products, the foundations, overlays, motion and
pages were brought up together.

### Foundations

- The accent is the prototype's pine `#236a50`; dark mode has four surface steps and a mid-green primary button
  with white text; selection is one neutral-green fill with a 2px inset edge, with no blue selection or second
  accent.
- Four radii: controls 8, lists and menus 10, dialogs and drawers 14, inline code 4; fully rounded shapes are kept
  for count badges, avatars and status dots only.
- Three shadow levels: a hairline for cards, a two-layer shadow for menus and popovers, a deep shadow for dialogs
  and drawers; overlays no longer draw a currentColor border.
- Latin text uses Inter (latin subset only, about 48 KB) while Chinese keeps the system fonts; numbers are tabular;
  weights are limited to 400 / 500 / 600.

### Motion

- One set of durations and curves: press 80ms, hover 140ms, selection and menus 160–180ms, dialogs and drawers
  240ms, exits 120ms.
- Menus, popovers and selects fade in from 0.98; dialogs scale from 0.97 and rise; drawers slide in from the right;
  toasts fade out before unmounting; the selected background of the nav, filter chips and segmented controls slides
  to its new place.
- The canvas pulse is one timeline: every edge at the same speed (420 px/s), passed on in order, fading at both
  ends, flashing each node on arrival and ringing the solid end dot; switching stages no longer sweeps the canvas.
- With reduced motion only 100ms fades and colour changes remain.

### Pages

- The top-bar nav follows the project switcher; the pending count sits on the workbench tab's corner; connection
  status is a dot.
- The rail drops nested frames and collapses to icons below 1360px.
- Workflow page: the gate is a segmented control with help in a tooltip; "back to" uses the shared select; the save
  bar slides in only with unsaved changes; composers are one surface with "+" and the drag handle shown on hover and
  a one-line file list; back arcs carry an arrow.
- The workbench empty state shows a one-line command with copy; stage progress fills from the left.
- The projects page aligns the host and file tables; the instruction editor grows with its content and switches
  edit/render with a segmented control.
- Library and skills use lighter weights and fewer decorations; skill links colour on hover only; empty details
  show no text.

### Upgrade

From v0.1.8: run `tenon update --codex` (or `--claude`), open a new host session and reload the Dashboard. The N-1
gate reads and writes this release's data with the published v0.1.8 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.9/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.9/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- Dashboard visuals and interaction only; the CLI, state and data formats are unchanged.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.9.

## v0.1.8 · 2026-09-24

A Dashboard experience release: a full overhaul after a professional UI/UX evaluation (visuals, components, graphics,
motion, task flows, smoothness, redundancy, information architecture, responsiveness, accessibility), plus a
server snapshot performance fix.

### Faster

- The server builds one shared snapshot for `/api/snapshot`, the stream's first frame, poll broadcasts and the AFK
  views, reuses it while the fingerprint is unchanged, and drops it after every server write. `/api/snapshot`
  supports `ETag` / `304`. A page load builds the snapshot once; with the cache warm, pages show their full content
  in about 0.1 s (3–5 s before); idle event-loop load falls from about 76% to about 1%.
- The workflow, library and skills pages no longer wait for the snapshot; the workbench and projects pages show
  skeletons on first load instead of a false "no projects".

### Workbench

- Filters stay on one line and never wrap: status chips (all / needs you / running / in review / done) plus owner,
  workflow, track and stage dropdowns, with whatever does not fit under "more"; a facet with one value is hidden.
  The top-bar pending badge and "needs you" share one count, and the badge filters to it.
- Archive, take over and delete move into "⋯" menus beside the title and on cards, also in the aggregate view; the
  bottom action bar is gone.
- Stages show their labels instead of ids; ready states use amber; single-stage workflows draw no bar; the selected
  task is written to the URL with a project tag, so same-name tasks are no longer confused.

### Workflow page and canvases

- Canvases render at 1:1 and grow with the number of parallel lanes instead of shrinking text, re-fit on resize,
  and align overflowing content to the left for panning. Zoom controls are no longer white in dark mode. The pulse
  plays only while a skill runs or right after an edit.
- The built-in default workflow no longer shows a warning on every stage (all were false positives); warnings are
  an icon with a tooltip.
- Gate help opens from the keyboard; the save bar shows the number of unsaved changes; composers use "done",
  preview a row on click and add it with "+".
- Deep links support `wf`, `track` and `step`.

### Projects, library and skills

- The host list is an even table; instruction files are applied from the diff drawer after "preview changes";
  delete moves into the "⋯" menu; Markdown previews no longer show HTML comments.
- The library shows names only (ids in tooltips); "copy" is "copy as custom"; built-ins are marked with a lock; agents
  are grouped as executors and reviewers; loading no longer looks empty.
- The skills page has search and row details, and marks only changed and failed skills. A server row carrying
  `modelInvocable` no longer makes the whole page report an invalid response.

### Design system and accessibility

- Secondary text in the light theme meets WCAG AA; disabled buttons change colour instead of only fading; buttons
  and chips have 40px hit areas.
- One Radix-based dialog; destructive confirmations are alertdialogs that start on "cancel".
- Duplicate breadcrumbs, eyebrows and names are removed; settings use two segmented rows for theme and language; the
  offline banner is fully visible.

### Upgrade

From v0.1.7: run `tenon update --codex` (or `--claude`), open a new host session and reload the Dashboard. The N-1
gate reads and writes this release's data with the published v0.1.7 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.8/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.8/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- Changes made outside the server that the snapshot fingerprint does not cover (such as editing a workflow file
  directly or changing identity with `git config`) show up within 30 s; writes through the Dashboard or the CLI
  show immediately.
- New URL parameters `status`, `step`, `wf` and `track`; in the aggregate view `change` carries a project tag, and
  old links still match by name.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.8.

## v0.1.7 · 2026-09-24

A sixth real-session acceptance release. On v0.1.6 all three tracks finished with no verify-fail and every review
gate opened on a single confirmation; this release fixes the last flow issue that run found.

### Flow

- When the user replied "继续" after the delivery step's turn, the resume itself appended to the interaction,
  skill-invocation and skill-confirmation ledgers in the change directory, and v0.1.6 asked for another delivery
  commit with the same title; the model skipped it and transitioned on an uncommitted tree. The "anything left to
  deliver" check now excludes all four hook-appended ledgers (history, interactions, skill invocations, skill
  confirmations); they go in with the next commit.

### Upgrade

From v0.1.6: run `tenon update --codex` (or `--claude`) and open a new host session. The N-1 gate reads and writes
this release's data with the published v0.1.6 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.7/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.7/install.sh | /bin/bash -s -- --codex
```

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.7.

## v0.1.6 · 2026-09-24

A fifth real-session acceptance release. On v0.1.5 all three tracks finished and every review gate opened on a
single confirmation; this release closes the remaining small issues.

### Flow

- build's skill, executor and reviewer actions and the `pre_verify_review_result` field carry `review_bar`: the
  reviewers the next step (verify) declares, with their `block_at` and focus. Self-review and sub-agent reviews in
  build use the same bar and fix blockers there, instead of being stopped at verify and sent back.
- The second delivery commit is titled `chore(<change>): update deliverables`, distinct from the first
  `feat(<change>): deliver`.
- A delivery value already known (such as `pr_url=no-remote`) is written before the last delivery commit; when a
  commit is needed first to get a PR URL, one more commit follows the write. The workspace is clean before the
  delivery step's transition.
- The entry skill replies in the user's language, keeping commands, field names and paths unchanged.

### Upgrade

From v0.1.5: run `tenon update --codex` (or `--claude`) and open a new host session. The N-1 gate reads and writes
this release's data with the published v0.1.5 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.6/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.6/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- build actions in `next` gain an optional `review_bar` field.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.6.

## v0.1.5 · 2026-09-24

A fourth real-session acceptance release. On v0.1.4 all three tracks finished with a clean working tree; this
release fixes the guidance and confirmation issues that run found.

### Review confirmation

- When a reply such as "按推荐" confirms a review, the hook now tells the model the receipt was written for which
  change and event, to follow `next`, and not to ask for "确认继续" again. In v0.1.4 the model claimed the
  confirmation had not taken effect and waited a turn.
- The resume context only reports review gates that still exist and are unconfirmed; a confirmed review awaiting its
  transition shows as confirmed.
- The entry skill lists every reply that confirms a review gate. "按推荐" only confirms the gate: field values follow
  `next`'s `recommended`, and the model must ask before using a different value.

### Flow

- When the planning step flags a missing test script, it asks for the script and tests to be written into the
  proposal and design too, and the `spec-consistency` reviewer no longer treats a script added only to satisfy a
  required test as a spec mismatch. In v0.1.4 this caused a verify-fail and a return to spec.
- The delivery step commits before ticking tasks, and later changes such as the applied spec get a second commit
  before `pr_url`.
- The `read-documents` action names the inputs this step may edit (`editable`) with a note; everything else is
  read-only and requirement changes go through `requirements-changed`. Document content must be read into context,
  not discarded.
- Workflows without OpenSpec report "finished" instead of "archived", and the `list --finished` column is
  `FINISHED_AT`.

### Upgrade

From v0.1.4: run `tenon update --codex` (or `--claude`) and open a new host session. The N-1 gate reads and writes
this release's data with the published v0.1.4 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.5/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- Human-readable output changes: the finished line of `check` for non-OpenSpec workflows, the `status` lines
  `finished` / `finished_at`, and the `list` column `FINISHED_AT`. JSON output is unchanged.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.5.

## v0.1.4 · 2026-09-24

A third real-session acceptance release. v0.1.3 was driven through the backend, free and simple tracks in real
Claude Code sessions; this release fixes what that found.

### Committing deliverables

- On the delivery step (a step whose fields include `pr_url` or `prd_path`), `next` adds a `commit` action before
  `pr_url` that commits every deliverable: code, docs, the applied main specs, test records under
  `.tenon/users/<user>/tests` and the state-directory `.gitignore` files. In v0.1.3 a default-workflow change
  finished with all of these left in the working tree.
- The commit covers the whole working tree but excludes the local gate markers at the repository root
  (`.pipeline-pending-*`) and local files left by older releases, and no commit is issued when only those remain.
  After the backend and free tracks finish, `git status` is empty apart from ignored files.
- The entry skill commits only when `next` names `commit` or `finish-change`.

### Flow

- When a later step's required test lacks its npm script, the planning step (spec) already raises it so it goes
  into the plan; if it is only found in build, the message says to add the `package.json` script without editing
  the recorded spec documents, so it no longer forces a return to spec.
- build asks for `build_mode` / `isolation` before the test-configuration fix.
- `status --json` always includes `step` for a finished change, with the same shape as an active one and `next` set
  to `stop` (`code: finished`).
- Main specs keep a blank line between Purpose and Requirements, and the unlock notice is printed once per prompt.

### Upgrade

From v0.1.3: run `tenon update --codex` (or `--claude`) and open a new host session. The N-1 gate reads and writes
this release's data with the published v0.1.3 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.4/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.4/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- The delivery commit includes every uncommitted change in the working tree; deal with unrelated uncommitted files
  in the same repository first.
- The finished-change stop code changes from `run-archived` to `finished`.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.4.

## v0.1.3 · 2026-09-24

A second real-session acceptance release. v0.1.2 was driven through the backend and free tracks in real Claude Code
sessions and the Dashboard was re-checked at 1440 px; this release fixes what that found.

### Data-driven flow (`step.next`)

- `ship`: unchecked `tasks.md` items come before `apply-spec` and document writes as a `fix` action listing every
  item, and ticking one no longer hides the rest.
- The `finish-change` commit succeeds first time: it lists only paths git accepts (an untracked original change
  directory is left out), adds `.pipeline/.gitignore`, `.tenon/.gitignore` and `openspec/.gitignore` when they
  exist untracked, and untracks heartbeat files committed by older releases. Outside a git repo `commit` is `null`.
- Workflows without OpenSpec, such as `simple`, also get a `finish-change` commit after `verify-pass` when changes
  are uncommitted.
- Choice fields such as `build_mode` and `isolation` appear in `next` after the input documents are read and
  before implementation starts.
- The `build` step of the `chat`, `pm` and `free` tracks declares the required `spec-consistency` reviewer, so
  `pre_verify_review_result` can be `pass` only once that review has a real verdict. Changes in progress keep
  their frozen plans.
- When a required test's npm script is missing, `tenon test run` reports it as not configured rather than failed
  and writes no record; `step.tests[].status` is `unconfigured`, flagged already in `build`.
- Finished changes have one `status --json` shape, and `tenon test status` lists each step's last record for them.
- `tenon spec apply` fills a new capability's main-spec Purpose from the proposal instead of leaving `TBD`, and
  fails with `purpose-missing` while the proposal is still a scaffold.

### Host and hooks

- When the user names a known track ("走 free 轨道", "track=free", "use the backend track", ...), routing uses it and
  the dispatch says `track_basis: user-named`; negated, unknown or multiple names fall back to scoring with a note.
- The unlock hints list the replies that actually unlock (including "按推荐" and "好的") and those that do not, and a
  test checks every phrase against the classifier.
- A new `openspec/.gitignore` ignores `.pipeline-terminal-activity.*` heartbeats, so they no longer dirty the tree.
- UserPromptSubmit hooks no longer time out on pasted text: v0.1.2 exceeded 30 s on a 64 KB log, and 1 MB now takes
  under 0.5 s. Prompts over 64 KiB are routed on their first and last 8 KiB.

### Dashboard

- The 含已完结 / 已归档 / 未提交删除 toggles sit on their own row, so workflow chips no longer collapse into a column.
- Each resource-catalog facet row starts with its group name (category, framework, styling, license).

### Upgrade

From v0.1.2: run `tenon update --codex` (or `--claude`) and open a new host session. The N-1 gate reads and writes
this release's data with the published v0.1.2 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.3/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.3/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- `next` order changed: choice fields and test configuration come first. `finish-change.commit` adds `untrack`, and
  `command` and `commit` may be `null`.
- Main specs already written with `TBD` are not rewritten.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.3.

## v0.1.2 · 2026-09-24

An acceptance-fix release. v0.1.1 was self-tested end to end in real use: a real Claude Code session through all
seven phases, every CLI capability, and every Dashboard page in a browser. This release fixes what that found.

### Host and hooks

- The interaction gate no longer blocks `ToolSearch`. In Claude Code `AskUserQuestion` is a deferred tool that must
  be loaded through `ToolSearch`, so v0.1.1 deadlocked whenever a skill required a question. The block message now
  explains how to ask.
- Hook JSON parsing is linear. On macOS's bash 3.2, v0.1.1 took quadratic time on long commands: a 21 KB heredoc kept
  the test-nudge hook busy for 67 s and the host cancelled it. A 166 KB input now takes about 1 s, and commands over
  64 KiB are never treated as read-only.
- The test reminder only matches tests declared on the current step and track; the `free` track is no longer told
  to run tests it does not have.
- The entry skill activates the session with the host session id, and "确认继续" / "继续执行" resume the current
  change while a review is pending instead of being routed as a new task.
- `.pipeline/.gitignore` ignores local-only state: `cache/`, `terminal-sessions/` and `codex-skill-receipts.jsonl`.

### Data-driven flow (`step.next`)

- `pre_verify_review_result` can be set to `pass` only once the step's declared tests, executors and required
  reviewers have real results. `next` no longer recommends `pass`, nor a `build_mode` that then demands
  `direct_override`.
- `phase_status`, `verified_at` and `updated_at` are managed by transitions and refused by `tenon set`.
- When a required reviewer fails, `next` goes straight to the fix or `verify-fail` exit.
- Parallel agents are numbered by dependency layer; `next` reports an agent that is still running, and
  `tenon agent next` no longer claims everything is done when it is not.
- `ship`: unchecked `tasks.md` items appear in `next` as the exit blocker. With no git remote, `pr_url` accepts
  `no-remote` (the CLI checks there is no remote); any other value must be an http(s) URL.
- Finished changes are listed under `finished_changes`, and `tenon check` reports them as finished with exit 0.
  `finish-change` carries the paths and message to commit the archive move, so no uncommitted changes are left.
- `document record` refuses scaffolds that still contain template placeholders and lists the lines.

### CLI

- Top-level workflow YAML keys may appear in any order (the documented example with `document_contract` after
  `steps` now parses).
- `--preset` accepts only `full|hotfix|tweak`; custom workflows no longer need one.
- Unknown change names report "change 不存在" instead of raw file errors, and the CLI exits quietly on a closed pipe.
- `tenon test code-size` counts source files only; reviewer verdicts bind to the workspace fingerprint like test
  records, so a code edit makes an old review stale.
- The human-readable `tenon workflow plan` lists each step's inputs, outputs, tests and agents; `doctor` and
  `last-update.json` agree on the changed-skill count.

### Dashboard

- The reviewer/executor editor keeps its draft across parent re-renders (in v0.1.1 added reviewers could be lost).
- First load shows a loading state instead of "no projects"; middle-column search boxes keep their height and filter
  rows wrap.
- Previews no longer render YAML frontmatter as body text; deleting a custom template, agent or test direction asks
  for confirmation; toasts report the outcome.
- The offline banner is fully visible below the top bar; the projects page no longer re-reads instruction files
  every 5 seconds.
- The resource catalog adds v0 templates, Skiper UI (links only) and coss ui.

### Upgrade

From v0.1.1: run `tenon update --codex` (or `--claude`) and open a new host session. The N-1 gate reads and writes
this release's data with the published v0.1.1 in both directions.

From 1.x: run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.2/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.2/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- `tenon status <change> --json` adds `finished_changes`; `set-field` and `agent next` JSON gain fields.
- An unknown `--preset` and `agent prompt` for an undeclared agent now exit 1.
- Documents already recorded with placeholders in changes in progress are unaffected; re-recording requires filling
  them first.

### Verify

```bash
tenon doctor
tenon runtime status
```

Both hosts' inventory, the active managed runtime and the Dashboard report 0.1.2.

## v0.1.1 · 2026-09-23

A correctness release. Accepting v0.1.0 on real hosts found the default workflow unusable on three of its five
tracks, and several places where Tenon reported a step as done without checking it.

### Blocker fixed: mandatory skills the host refused to run

- In v0.1.0 the `pm`, `frontend` and `backend` tracks could not leave `explore`, and `pm` was also stuck at `spec`,
  `verify` and `ship`. Their mandatory skills included upstream skills whose `SKILL.md` carries
  `disable-model-invocation: true`. The host refused to invoke them, no receipt was written, and every transition
  failed with `step-skills-incomplete`.
- Replacements: `grill-with-docs` becomes `grilling` + `domain-modeling`, the two skills it delegates to, and
  `improve-codebase-architecture` becomes `codebase-design`, also in the builtin `architecture` agent. `pm` no longer
  requires `handoff` (use `tenon handoff <change> [--bundle]`), `to-spec` or `to-tickets`: the applied-spec document
  and the spec step's task guard already cover what they did. The removed skills still ship as manual guides.
- This cannot ship again. The release candidate's skill verification fails with `mandatory-skill-not-invocable`;
  `tenon doctor` reports `skills:invocable`, red when every alternative of a mandatory skill is proven
  non-invocable and yellow when its `SKILL.md` cannot be read; and the Dashboard refuses to save a workflow that
  makes such a skill mandatory.

### No more false greens

- `tenon check`, `tenon transition` and `tenon status` share one judgement of a step's skills and of its exit rules.
  In v0.1.0 they could disagree on the same state: at pm `ship`, `check` failed while `status` showed the exit ready
  and `transition` let it through. A task can no longer ship without its deliverable, such as a pm task with an
  empty `prd_path`.
- A spec rehearsal no longer satisfies the applied-spec obligation, on any track.
- A mandatory skill that the step's document contract names as a producer is done only when a document it produced
  is recorded in the current step visit. An invocation receipt alone no longer counts for it.

### A task finishes by following `next` alone

`tenon status <change> --json` now emits in `next` only actions the commands accept, so a runner that follows it
takes a default task from `open` to `tenon list --finished`:

- an input document edited after it was recorded is recorded again, instead of being re-read forever;
- a scaffolded document is recorded in the same wave, so the scaffold step settles;
- an unrecorded `role: update` slot is a permission, not an obligation, and asks for nothing;
- a single rollback edge behind a review gate goes through a review request, like a forward edge;
- the archive step offers `complete` (the `archived` transition), then `finish-change` with the exact
  `openspec archive` command;
- `build_sha` is written by the Build exit transition instead of being asked of the runner;
- the coverage guard's remediation names what its parser actually reads.

### Ownership and finished tasks

- `tenon set`, `set-many` and `cas` require an identity and refuse a non-owner, like every other mutation, and
  refuse a finished task.
- 完结 is the transition `tenon transition <change> archived`, which stamps `archived_at`; writing `archived` or
  `archived_at` by hand is refused.
- A finished task stays readable with `tenon status`, and appears in `tenon list --finished` as soon as it is
  marked archived, before its directory moves.
- A task hidden with 归档 and a finished task give different messages: the first points at
  `tenon task unarchive`, the second says the task is finished and a new task is needed.

### Install and upgrade

- `tenon spec apply` creates the main-spec directory of a capability that does not exist yet.
- `tenon doctor` attributes its findings to the host in use, and contacts the remote only with `--verify-release`.
- The upstream skill lock keeps exactly the v0.1.0 format, so a v0.1.0 verifier reads a lock written by v0.1.1 and
  the reverse. Whether a skill can be invoked is read from its `SKILL.md` bytes, not from the lock.
- The installation guide explains raising `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS`: Claude Code clones the marketplace
  with a 120 s default, and a timed-out clone leaves that host without the plugin.

### Upgrade

From v0.1.0, run `tenon update --codex` (or `--claude`), then open a new host session. The N-1 compatibility gate
runs the published v0.1.0 against this release's writes in both directions.

From 1.x, run the versioned installer once for each host you use:

```bash
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.1/install.sh | /bin/bash -s -- --claude
/usr/bin/curl -fsSL https://raw.githubusercontent.com/jefferysha/tenon/v0.1.1/install.sh | /bin/bash -s -- --codex
```

### Compatibility

- In a task already in progress, a document that a producing mandatory skill recorded in an earlier step visit no
  longer counts for the current visit. `next` asks for it again as `record-document`, naming the skill.
- These mandatory skills are still satisfied by invocation alone, because no document slot names them as its
  producer at that step: `openspec-explore`, `grilling`, `domain-modeling` and `codebase-design` (explore);
  `brainstorming` (pm spec); `test-driven-development`, `frontend-design` and `prototype` (build); `browser-qa`,
  `web-design-guidelines`, `design-taste-frontend` and `e2e-testing` (verify); `finishing-a-development-branch`
  (ship). Binding them to an output needs a document-contract decision in a later release.

### Verify

```bash
tenon doctor
tenon runtime status
```

`skills:invocable` is green, and both hosts' inventories, the active managed runtime and the Dashboard report 0.1.1.

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
