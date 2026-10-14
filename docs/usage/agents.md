# Agents

An agent is a task-level executor or reviewer that a workflow step declares.
It is not an instruction file (`AGENTS.md`, `CLAUDE.md`): it only runs inside a
task, at the step that names it. Agents are registered in the terminal; the
Dashboard only displays them and edits their bodies.

## The agent file

One Markdown file per agent: a closed frontmatter and a body.

```markdown
---
name: sql-review
description: SQL review — injection, indexes, migrations
role: reviewer
version: 0.1.0
skills: [security-review]
tools: [Read, Grep, Glob, Bash, Skill]
model: sonnet
---

# sql-review (reviewer)
## Responsibility
## Does and does not
## Method
## Self-check
## Report
```

- `role` is `executor` (does the step's work) or `reviewer` (checks the step
  before it is left). Files written before `role` existed still load; the role
  is inferred from the tools (any of `Write` / `Edit` → executor) and
  `tenon agent validate` asks you to add the line.
- `version` is optional semver. `hosts` (optional) limits the agent to some
  hosts; `model` is passed only to a host that knows it.
- `attach_on` (optional, reviewers) scopes a reviewer by risk: `attach_on: [auth,
  dependency, contract]` attaches it to a step only when the task's changes touch a
  path in one of those classes (`auth`, `dependency`, `contract`, `migration`; the
  same classification as the `lite` Track's risk probe). A reviewer that is not
  attached is not listed, not waited for and not required; `agent prompt` refuses it
  (exit `2`). If the changes cannot be read the reviewer is attached (fail closed).
  The official `security` reviewer declares `[auth, dependency, contract]`. Without
  the field a reviewer is always attached, and a task that froze an older copy keeps
  its old behaviour.
- `host` (optional, `codex` | `claude` | `any`) is where a reviewer *should* run. It is a
  suggestion that routes the reviewer to the other vendor; the workflow step is
  what makes it binding (see [Cross-vendor review](#cross-vendor-review)). Do not
  confuse it with `hosts`, which lists where the agent *can* run.
- The report the agent writes ends with a `tenon-result` block. A reviewer lists
  findings and never states its own verdict — Tenon derives pass or fail from
  the severities and the step's `block_at`. An executor reports `done` or
  `failed`.

## Sources

| Source | Where | Editable |
| --- | --- | --- |
| Official | shipped with the plugin (`templates/agents/`, recorded in `templates/agents/manifest.json` with name, version, role and digest), synced to the user config | read-only; copy it to change it |
| Custom | user config (`<config>/agents/custom/`) | yes |
| Project | the project's `.tenon/agents/`, committed and shared with the team | yes |

A project agent wins over a custom agent with the same name (the custom one is
listed as overridden). No layer can reuse an official name; such a file is
listed as a conflict and never used.

The official agents are `builder` and `researcher` (executors) and
`architecture`, `backend-quality`, `code-review`, `code-size`, `e2e`,
`frontend-quality`, `security` and `spec-consistency` (reviewers). `code-review` is
the `lite` Track's reviewer: it reads the diff against the goal and acceptance check
the host appends to its prompt, and needs no specification documents.

## Author in the terminal

```text
tenon agent list [--role executor|reviewer] [--source official|custom|project] [--json]
tenon agent show <name> [--json]
tenon agent new [<name>] --role <role> --description <text> [--skills a,b] [--tools A,B] [--model <m>] [--hosts a,b] [--scope user|project] [--from <agent>]
tenon agent add <file> [--scope user|project] [--replace]
tenon agent validate <file|name>
tenon agent copy <from> <to> [--scope user|project]
tenon agent rm <name> [--scope user|project]
tenon agent export <name> --host claude|codex
```

- The official layer is called "official" in text and in `--source official`; the machine-readable
  value in `--json` and in `GET /api/agents` is `source: "builtin"` (`--source builtin` is accepted as
  an alias). Scripts should compare against `builtin`.
- `new` asks for whatever is missing in an interactive terminal; with every
  required flag it runs non-interactively. Without `--from` it writes a body
  skeleton with the five sections; `--from builder` starts from an official
  agent's fields and body.
- `validate` (and `add`) check the frontmatter and body, that every skill exists
  in the plugin, that the body no longer contains the skeleton placeholders
  `new` writes (`<第一步>`, `<第二步>`, `<写报告前必须满足的条件>` and the
  "what this agent does" line), and the tool names per host: for Claude Code an
  unknown tool name fails; for an agent only for Codex it is a warning, because
  Codex does not restrict tools by name. `new` itself registers the skeleton and
  asks you to complete it; `validate` fails until you do.
- `rm` refuses an official agent and any agent a workflow step still uses, and
  lists those steps (exit 2).
- `new`, `add`, `copy` and `rm` change the library only. They write no host
  subagent file and print a reminder to run `tenon agent install` and open a new
  session; see [Host subagents and the install command](#host-subagents-and-the-install-command).
- In Claude Code or Codex, the `tenon:agent-author` skill drafts the body from
  your description (responsibility, does and does not, method, self-check,
  report with the `tenon-result` block), validates the draft and registers it
  with `tenon agent add`. It writes no Tenon state.

## Host subagents and the install command

A task runs its agents as host subagents. The dedicated `tenon-<name>` subagent
files are written once, in the terminal, at user level; no Tenon command that
runs inside a session writes them. A subagent file added in the middle of a
session is picked up at a time the host does not specify, so only files that
exist before the session starts are dependable.

```text
tenon agent install [--host claude|codex]
tenon agent uninstall [--host claude|codex]
```

| Host | File | Fields |
| --- | --- | --- |
| Claude Code | `<Claude config dir>/agents/tenon-<name>.md` | name, description, tools, model |
| Codex | `<Codex config dir>/agents/tenon-<name>.toml` | name, description, developer_instructions, model; `sandbox_mode = "read-only"` when the tools cannot write or run commands |

The config dir is `$CLAUDE_CONFIG_DIR` for Claude Code and `$CODEX_HOME` for
Codex when that variable is set to an absolute path (surrounding spaces and a
trailing slash are ignored); a relative or empty value is not used. Otherwise it
is `~/.claude` and `~/.codex`. A host reads subagents only from its own config
dir, so the install, the uninstall and the `tenon agent prompt` check all resolve
it the same way, from the environment of the process that runs the command.

- **Install in the environment the host starts in.** If your Claude Code or Codex
  starts with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` set, run the install with the same
  variable, or the files land in `~/.claude/agents` and the host never sees them.
  The first line of `tenon agent install` and `uninstall` output, `目标目录：<dir>`
  ("target directory"), shows where it went. From inside a session you can run it
  with the `!` prefix, for example `! tenon agent install --host claude`, which
  uses the session's environment.
- Ownership is recorded per target directory, so installing or uninstalling in one
  config dir never deletes, rewrites or claims the files Tenon wrote in another
  (for example `~/.claude/agents` and `$CLAUDE_CONFIG_DIR/agents` on the same
  machine).
- `tenon agent install` renders every official and custom agent that applies to
  the host (an agent whose `hosts` list leaves the host out is skipped) into
  those files. Project agents (`.tenon/agents/`) are never installed, so the
  result is the same in whichever directory you run it. `--host` defaults to the
  host detected from the process environment, and to `claude` in a plain
  terminal.
- `tenon setup --claude|--codex` and `tenon update --claude|--codex` run the same
  install after they succeed (`update` also when it finds the release already
  current; installing is idempotent) and print what was written. A failed
  install only warns: the exit code of `setup` / `update` does not change, and
  you can run `tenon agent install --host <host>` yourself. `--dry-run`
  installs nothing, and the once-a-day automatic update (`--auto`) speaks only
  when the install fails.
- **Open a new session afterwards.** The host loads subagent files when a
  session starts; the install command and `tenon agent new|add|copy|rm` all say
  so. The four library commands write no host file: they only print the reminder
  to run `tenon agent install` (for a project agent they add that it is not
  installed).
- A file is written only when that is safe: it does not exist yet, it already
  has exactly the rendered content (Tenon then records that it owns it), or
  Tenon wrote it earlier and nobody has edited it since. A same-named file that
  is yours, or one you edited, is left alone and listed as a `WARN`; a target
  file that is itself a symlink is refused (a symlinked parent directory, such as
  a dotfiles-managed `~/.claude`, is fine). When an agent has left the library,
  its file is removed if Tenon wrote it and it is unedited. An agent that is
  still in the library but cannot be loaded (a file that fails to parse or to
  read) does not count as removed: its installed file is neither rewritten nor
  deleted. If the library has no usable agent at all (it could not be read), no
  file is removed and a `WARN` says so. Ownership is kept as
  a content hash per file in `<config>/agents/host-owned.json`, grouped by the
  subagent directory it was written to; if that file
  cannot be parsed, no existing file is changed or deleted, only missing files
  are written, and the command says so.
- `tenon agent uninstall [--host claude|codex]` deletes the user-level files
  Tenon wrote and that are unedited; edited ones are kept and listed as `modified`.
  `tenon uninstall` works on the project's `.pipeline-owned.json` and does not
  touch these user-level files, so run `tenon agent uninstall --host <host>`
  first if you want them gone.

### Dispatch: what `tenon agent prompt` returns

`tenon agent prompt <change> <agent> --host claude|codex --json` writes no host
file. It renders the task's frozen definition for the host, compares it with the
installed file, and returns `subagent_type: tenon-<name>` with `native: true`
only when the user-level file exists and is byte-for-byte the same, and the
project has no different same-named file (`.claude/agents/tenon-<name>.md` or
`.codex/agents/tenon-<name>.toml`): a project-level file outranks the user-level
one and would shadow it. Inside a task worktree both the current root and the
main checkout are checked, because a session started from the main checkout
loads the files that stay there.

Claude Code enforces the `tools` allowlist of a dedicated subagent. Codex custom
agents have no per-agent tool allowlist: Tenon only sets
`sandbox_mode = "read-only"` for an agent whose tools cannot write or run
commands, and every other restriction is an instruction in the agent body. A
tool the host does not provide (for example `Grep` in some headless runs)
answers `No such tool available`; the agent uses the shell equivalent. A model
alias the host does not know is omitted.

Otherwise it returns the host's generic subagent (`general-purpose` for Claude
Code, `default` for Codex) with `native: false`, a `reason` and a `hint`. Both
are `null` for a dedicated subagent and when no host is detected.

| `reason` | Meaning | What to do |
| --- | --- | --- |
| `not-installed` | no user-level file for this agent | `tenon agent install --host <host>`, then a new session |
| `definition-mismatch` | the file exists but differs from the task's frozen definition: the library or the agent changed after the file was installed, or you edited the file | install again and start a new session (an edited file is kept and listed; delete it to let install rewrite it). A task keeps the definition it froze, so a task that froze an older version stays on the generic subagent instead of silently using a newer one |
| `shadowed` | a project-level `tenon-<name>` file with different content outranks the user-level file | remove or fix the project file (usually left by an older version, see [Files left in the project by older versions](#files-left-in-the-project-by-older-versions)) |
| `project-agent` | the agent comes from the project layer (`.tenon/agents/`); Tenon installs no host file for those | nothing: a project agent always runs as the generic subagent |

`hint` is one line, printed in Chinese whatever `TENON_LANG` says:
`执行 tenon agent install --host <host> 后开新会话生效（目标目录 <dir>；设了 CLAUDE_CONFIG_DIR / CODEX_HOME 时要在带同样变量的环境里执行，例如会话里用 ! 前缀）`
(run `tenon agent install --host <host>`, then open a new session; `<dir>` is the
user-level subagent directory `prompt` checked, resolved from the session's
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`; run the install in an environment with the same
variable, for example with the `!` prefix inside a session). If `<dir>` is not
where you installed, that is why it says `not-installed`. The line is the same for
all four reasons; for `shadowed` and `project-agent` installing does not change
the result.

The `tenon` skill dispatches `subagent_type` as returned and passes the `hint`
on to you. If the host still reports that the subagent cannot be found (for
example it was installed in this very session), the skill runs the same prompt
in a generic subagent and records what actually ran with
`tenon agent record <change> <run-id> --subagent <type>`. When no subagent was
dispatched at all and the work ran in the main thread, record
`--subagent none`: the run record then reads
`subagent: { host, type: "none", native: false, reason: "not-dispatched" }`.
`not-dispatched` is a registration-only reason, written by whoever records the
run; `agent prompt` never returns it.

- Every run record carries `subagent: { host, type, native }`, plus `reason`
  when the run did not use the dedicated subagent. `--subagent <type>` keeps the
  `reason` that `prompt` gave for a generic type and drops it when the type
  actually used is the dedicated `tenon-<name>`.
- The `reason` is kept beside the ledger, in the run side note
  `.pipeline-agent-run-meta.jsonl` (as `subagent_reason`), and merged back when
  the record is read. The ledger row itself keeps its three `subagent` keys, so a
  runtime released before this change still reads the ledger.

### Files left in the project by older versions

Earlier versions wrote `.claude/agents/tenon-<name>.md` and
`.codex/agents/tenon-<name>.toml` into the project when a task froze its agents.
Because a project-level file outranks the user-level one, a leftover file would
shadow the one you install. Tenon therefore cleans them up, and writes no new
ones:

- when: at `tenon init`, and when a task is finished (`archived`), terminated or
  deleted (in the CLI and in the Dashboard);
- which files: a leftover is deleted when the project's `.pipeline-owned.json`
  lists it and its content still matches the recorded hash, or when its content
  equals what the current library renders for that agent (the CLI and the
  Dashboard use the same two rules). If the library cannot be read, a `WARN` says
  so and only the first rule applies. The `.pipeline-owned.json` entry is removed
  with the file, and the file is deleted only if no path component is a symlink;
- everything else is kept and reported as a `WARN` naming the file: edited files,
  files that match neither rule, unreadable ones. Delete those by hand once you
  are sure you do not need them;
- from inside a task worktree the cleanup targets the main checkout, where those
  files and `.pipeline-owned.json` live;
- the cleanup is best effort: a failure only warns and never changes the exit
  code of `init`, finish, terminate or delete.

## Use agents in a workflow

A step declares its executors and reviewers:

```yaml
agents:
  executors:
    - agent: builder
  reviewers:
    - agent: code-size
      required: true
      block_at: medium
      reads_tests: [code-size]
    - agent: security
      required: false
      block_at: medium
```

Executors run first and must finish `done` before the step can be left;
required reviewers must pass on the current candidate; advisory reviewers only
report. The heavy Tracks of the default workflow (`pm`, `frontend`, `backend`) attach
`researcher` to every Explore, `builder` to every Build (one subagent per independent
task, merged into one report), and the `code-size` reviewer with its `code-size` test
to every Verify; the `lite` Track runs the reviewers `code-review` and `security` at its
Verify. The `code-size` reviewer reads the measured `files_changed`, `lines_added`, `lines_deleted`
and `largest_added_lines` and judges, from the numbers and the nature of the change, whether the size is
reasonable (generated output and bulk migrations are large by nature); the default test sets no line
ceiling, and when the project's workflow gives the test a `pass.metrics` ceiling, that ceiling
applies. See
[Default workflow](default-workflow.md) and
[Custom workflows](custom-workflows-and-tracks.md).

The skills an agent declares (`skills:` in its file) can only be loaded while
that agent runs. A return edge, the way back to fix something (for example
`verify-fail` from Verify or `requirements-changed` from Build), therefore does
not require the skills of the agents the step declares, so you never have to
start a builder just to go back. Skills the main thread loads itself are still
required on a return edge, and a forward edge requires everything, as before.
The same rule applies to `tenon status`, `tenon check` and the Dashboard
transition.

## Cross-vendor review

Claude can write and Codex can review (or the other way round). A reviewer in a step names the
host it must run on:

```yaml
agents:
  reviewers:
    - agent: security
      required: true
      block_at: medium
      host: codex        # codex | claude | any
```

| Where | Meaning |
| --- | --- |
| step `host: codex` or `claude` | binding: the verdict only counts when the host recorded with it is that host |
| step `host: any` | no requirement; overrides the agent's suggestion |
| no `host` on the step, `host:` in the agent file | a suggestion: `tenon agent prompt` still routes to that host, a verdict from another host still counts |
| neither | no routing, no requirement |

**Routing.** `tenon agent prompt <change> <agent>` knows the host that runs it (from the process
environment, or `--host`). If that is not the required host it still opens the run, but writes the
prompt to `openspec/changes/<change>/.pipeline-agent-reports/<run-id>.prompt.md` and prints the
exact command for the other host instead of the prompt:

```bash
codex exec --sandbox workspace-write - < openspec/changes/demo/.pipeline-agent-reports/<run-id>.prompt.md
# a Claude reviewer from Codex:
claude -p --allowedTools "Read,Grep,Glob,Write,Bash(tenon agent record:*)" < openspec/changes/demo/.pipeline-agent-reports/<run-id>.prompt.md
```

Tenon does not start that CLI for you. Run the command (or have the agent in the current host
run it); the prompt ends with `tenon agent record <change> <run-id> --host <host>`, so the
review registers itself when it can. When the other CLI cannot write to Tenon state, record
from the original host with `tenon agent record <change> <run-id> --host codex`: the host is
then `declared` instead of `detected`.

**Binding.** A cross-vendor verdict is bound twice. *To the code:* the run row carries the
candidate (the content hash of the workspace the reviewer was started on); `record` refuses when
the code changed during the review, and any later change makes the verdict stale and requires a
new run. *To the host:* `record` stores `host` and `host_source`; when the step requires a host, a
record from another (or an unknown) host is refused with `exit 2`, and a ledger row that
disagrees anyway is not a verdict — the reviewer shows `stale`, the step exit reports
`reviewer-wrong-host`, and rerunning on the right host needs no `--rerun-reason`. The host is the
recorder's claim, in the same trust model as the rest of the ledger; `host_source` shows whether
it was detected or declared so a human can tell.

**With `attach_on`.** Scoping by risk comes first. A reviewer that `attach_on` does not attach
to the task is not part of the step at all, so its `host` requirement is neither routed nor
checked: it is not listed, not waited for and never reports `reviewer-wrong-host`. The host
rules above apply to the reviewers that are attached.

The status JSON (`step.reviewers[]`: `required_host`, `route_host`, `host`, `host_source`,
`wrong_host`) and the `run-agent` action (`host`) carry the same facts for a runner. The workflow
page edits the reviewer's `host` next to `block_at`.

The Dashboard's agent run drawer shows the host row as the recorded host and the required host side
by side, the required one with a small "required" marker (the two merge into one when they match),
and a red dot with "Host mismatch" when the recorded host breaks the requirement. It also shows the
bound candidate. While the reviewer has no valid run on the required host, and the step is the task's
current or a later one in an open task, a Command row gives a copyable
`tenon agent prompt <change> <agent>`. The Dashboard only displays it and never runs it.

## Dashboard

The Library page lists agents grouped by role, with source (official / project
/ custom) and version on each row. The detail shows the fields, the rendered
body, the workflow steps that use the agent and its recent runs in the selected
project (with the subagent that ran each). Custom and project agents can edit
their body; an official agent can be copied as a custom one. An empty library
shows the `tenon agent new` command to copy.
