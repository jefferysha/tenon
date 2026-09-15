# Harness instruction files (research)

Instruction files (AGENTS.md / CLAUDE.md …) are project-level and user-level (user clarification 2026-09-15).
They are unrelated to custom agents, which are task-level (see `09-15-review-agents`).

## Claude Code (https://code.claude.com/docs/en/memory.md)

- Loaded files, in order:
  1. Managed policy: `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux/WSL),
     `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows) — cannot be excluded.
  2. User level: `~/.claude/CLAUDE.md`.
  3. Ancestors of cwd: `CLAUDE.md` and `CLAUDE.local.md` in every directory from root down to cwd.
  4. Project level: `./CLAUDE.md` or `./.claude/CLAUDE.md`; local override `./CLAUDE.local.md`.
  5. Rules: `.claude/rules/**/*.md`.
  6. Subdirectory `CLAUDE.md` files load on demand when files in that subtree are read.
- **All levels are loaded together (concatenated); none replaces another.** Project files are read last, so they carry the
  most weight on conflict. Within a directory `CLAUDE.md` then `CLAUDE.local.md`.
- Does **not** read `AGENTS.md`; documented options are `@AGENTS.md` import in CLAUDE.md or a symlink.
- Imports `@path` (outside code blocks), relative to the importing file, max depth 4; external imports need one-time approval.
- Size: aim ≤200 lines per file; files >4 MiB skipped. `/memory` browses and edits loaded memory; `/context` shows what loaded.
- `claudeMdExcludes` setting (globs/absolute paths) at user, project, local or managed layer.

## Other hosts (official docs, 2026-09-15)

| Host | Project files | User-level file | Both loaded? Conflict | Other names / config | Size limit |
|---|---|---|---|---|---|
| Codex | root → cwd, one per directory: `AGENTS.override.md` else `AGENTS.md` else fallback names [1] | `~/.codex/AGENTS(.override).md` (`$CODEX_HOME`) | Yes, joined global → root → cwd; later wins | `project_doc_fallback_filenames` | `project_doc_max_bytes` 32 KiB |
| Gemini CLI | `GEMINI.md` in workspace and parents (stops at `.git`), subdirectories on demand [3][4] | `~/.gemini/GEMINI.md` | Yes; global < workspace < subdirectory | `context.fileName` (string or list, e.g. `["AGENTS.md","GEMINI.md"]`), `@file` | none; `discoveryMaxDirs` 200 |
| Cursor | `.cursor/rules/**/*.mdc` (plain `.md` ignored); `AGENTS.md` root and nested [6] | User Rules in Settings only (no file) | Yes; Team → Project → User, first wins | CLAUDE.md not documented | "under 500 lines" |
| Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` (`applyTo`), `AGENTS.md`, root `CLAUDE.md`/`GEMINI.md` [8][9] | VS Code `~/.copilot/instructions`, `~/.claude/rules`; GitHub web settings | All sent; Personal > Repo > Org | `chat.useAgentsMdFile`, `chat.useClaudeMdFile` | "≤2 pages" |
| Cline | `.clinerules` file/folder, `.cursorrules`, `.windsurfrules`, `AGENTS.md` [12] | `~/Documents/Cline/Rules`, `~/.agents/AGENTS.md` | Yes; workspace wins | per-rule toggle | — |
| Continue | IDE `.continue/rules/*.md`; `cn` CLI first of `AGENTS.md`/`AGENT.md`/`CLAUDE.md`/`CODEX.md` in cwd [14][15] | `~/.continue/rules` | Joined; no conflict rule | `cn --rule` | — |
| Aider | none automatic; `CONVENTIONS.md` via `--read`/`read:` [17] | `~/.aider.conf.yml` `read:` | config home → git root → cwd, last wins [18] | any name | — |
| Amp | `AGENTS.md` cwd and parents to `$HOME`, subdirectories on read; fallback `AGENT.md`/`CLAUDE.md` [19] | `~/.config/amp/AGENTS.md`, `~/.config/AGENTS.md`, `/etc/ampcode/AGENTS.md` | Yes, all | `@path`, `globs` | — |
| Devin | CLI `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `CLAUDE.md`, `.windsurfrules`, `.devin/rules/*.md` [21]; cloud imports into Knowledge [23] | `~/.config/devin/AGENTS.md` | Yes | `read_config_from` | — |
| Zed | worktree root only, **first match wins**: `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` [24] | `~/.config/zed/AGENTS.md` | project overrides personal; merge undocumented | not configurable | — |
| Pi | `AGENTS.md` or `CLAUDE.md` cwd and parents; `AGENTS.override.md` replaces in its dir [26] | `~/.pi/agent/AGENTS.md` | Yes | `--no-context-files` | — |
| OpenCode | `AGENTS.md` (else `CLAUDE.md`) walking up [27] | `~/.config/opencode/AGENTS.md` (else `~/.claude/CLAUDE.md`) | Both; first match per level | `instructions` globs/URLs | — |

Conclusions:

1. Project and user levels are both loaded (joined) in Claude Code, Codex, Gemini, Copilot (VS Code), Cline, Continue, Amp,
   Devin CLI, Pi, OpenCode. Zed reads both but the project wins and merging is undocumented; Cursor's user level is
   Settings-only; Aider loads nothing unless configured. Nearest/project usually wins; Copilot (Personal > Repo) and Cursor
   (Team > Project > User) are exceptions.
2. Common project file: root `AGENTS.md` (read natively by Codex, Cursor, Copilot, Cline, Amp, Devin, Zed, Pi, OpenCode, `cn`).
   Claude Code needs `CLAUDE.md`; Gemini needs `GEMINI.md` or `context.fileName`; Aider needs `read:`; Continue IDE needs
   `.continue/rules`. No shared user-level path.
3. Possible existing Tenon adapter defects to verify: Zed adapter writes `.rules`, which (first match wins) hides `AGENTS.md` /
   `CLAUDE.md`; Cursor adapter writes `.cursor/rules/pipeline.md`, but docs say `.md` there is ignored (must be `.mdc`).

Sources: [1] https://learn.chatgpt.com/docs/agent-configuration/agents-md · [3] https://geminicli.com/docs/cli/gemini-md/ ·
[4] https://geminicli.com/docs/reference/configuration/ · [6] https://cursor.com/docs/rules ·
[8] https://code.visualstudio.com/docs/copilot/customization/custom-instructions ·
[9] https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions ·
[12] https://docs.cline.bot/features/cline-rules · [14] https://docs.continue.dev/customize/deep-dives/rules ·
[15] https://github.com/continuedev/continue/blob/main/extensions/cli/src/systemMessage.ts ·
[17] https://aider.chat/docs/usage/conventions.html · [18] https://aider.chat/docs/config/aider_conf.html ·
[19] https://ampcode.com/docs/customize/agents-md · [21] https://docs.devin.ai/cli/extensibility/rules ·
[23] https://docs.devin.ai/product-guides/knowledge · [24] https://zed.dev/docs/ai/instructions ·
[26] https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md · [27] https://opencode.ai/docs/rules/
