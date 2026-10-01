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
  same classification as the `standard` lane's risk probe). A reviewer that is not
  attached is not listed, not waited for and not required; `agent prompt` refuses it
  (exit `2`). If the changes cannot be read the reviewer is attached (fail closed).
  The official `security` reviewer declares `[auth, dependency, contract]`. Without
  the field a reviewer is always attached, and a task that froze an older copy keeps
  its old behaviour.
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
the `standard` lane's reviewer: it reads the diff against the goal and acceptance check
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
- In Claude Code or Codex, the `tenon:agent-author` skill drafts the body from
  your description (responsibility, does and does not, method, self-check,
  report with the `tenon-result` block), validates the draft and registers it
  with `tenon agent add`. It writes no Tenon state.

## Host-native agent files

When a task freezes its agents (at `tenon init`, or at the first
`tenon agent prompt --host <host>`), Tenon generates a native subagent file for
the current host:

| Host | File | Fields |
| --- | --- | --- |
| Claude Code | `.claude/agents/tenon-<name>.md` | name, description, tools, model |
| Codex | `.codex/agents/tenon-<name>.toml` | name, description, developer_instructions, model; `sandbox_mode = "read-only"` when the tools cannot write or run commands |

- `tenon agent prompt <change> <agent> --host claude|codex --json` returns
  `subagent_type: tenon-<name>`; the host runs the agent as that subagent. Claude
  Code enforces the `tools` allowlist. Codex custom agents have no per-agent tool
  allowlist: Tenon only sets `sandbox_mode = "read-only"` for an agent whose tools
  cannot write or run commands, and every other restriction is an instruction in
  the agent body. A tool the host does not provide (for example `Grep` in some
  headless runs) answers `No such tool available`; the agent uses the shell
  equivalent. A model alias the host does not know is omitted.
- If a file cannot be generated (a same-named file that Tenon did not write, a
  file you edited, a symlinked path), the host falls back to a general subagent
  and the run record says so. When the host cannot load the subagent it was
  given, record what actually ran with
  `tenon agent record <change> <run-id> --subagent <type>`.
- Every run record carries `subagent: { host, type, native }`.
- The files are listed with their content hash in the project's
  `.pipeline-owned.json`. When a task reaches its end, Tenon removes the files
  no other running task uses; `tenon uninstall` removes only files it generated
  and you have not edited. They are never part of the delivery commit and never
  change the review candidate.

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
report. The default workflow attaches `researcher` to every Explore, `builder`
to every Build (one subagent per independent task, merged into one report), and
the `code-size` reviewer with its `code-size` test to every Verify; chat and
free also run `security` as an advisory Verify reviewer. See
[Default workflow](default-workflow.md) and
[Custom workflows](custom-workflows-and-tracks.md).

## Dashboard

The Library page lists agents grouped by role, with source (official / project
/ custom) and version on each row. The detail shows the fields, the rendered
body, the workflow steps that use the agent and its recent runs in the selected
project (with the subagent that ran each). Custom and project agents can edit
their body; an official agent can be copied as a custom one. An empty library
shows the `tenon agent new` command to copy.
