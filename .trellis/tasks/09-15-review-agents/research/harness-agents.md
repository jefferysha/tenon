# Host-native custom agents (research)

Tenon agents are task-level (user clarification 2026-09-15). Host-native agent directories are only a delivery mechanism.

## Claude Code (https://code.claude.com/docs/en/sub-agents.md, https://code.claude.com/docs/en/agents.md)

Reported from the docs by a research agent; field list and precedence to be re-verified against the installed version
during design.

- Locations, higher wins on name collision: managed settings → `--agents` CLI JSON (session only) → project `.claude/agents/`
  → user `~/.claude/agents/` (plugins can also ship agents).
- Format: Markdown with YAML frontmatter; body is the agent's system prompt. Required `name`, `description`; optional
  `tools` / `disallowedTools`, `model`, `permissionMode`, `skills` (preloaded), `memory`, `maxTurns`, `isolation`, `hooks`,
  `mcpServers`, `omitClaudeMd`.
- Invocation: automatic delegation by `description`, explicit @-mention, or session-wide `--agent`; several subagents can run
  in parallel; subagents can spawn further subagents (default depth 3).
- Context: a subagent starts fresh with its own prompt, CLAUDE.md files (unless `omitClaudeMd`), preloaded skills and git
  status; it does not inherit conversation history or previously invoked skills. Per-agent progressive skill unlocking has to
  be enforced by Tenon's skill gate, not by the host.
- Files are read when a subagent is spawned, so edits apply on the next invocation without restart. `/agents` shows the file
  locations; creation and editing are file-based.
- Task-level delivery options: session-only `--agents` JSON, or files generated under `.claude/agents/` with a Tenon-owned
  prefix and removed when the task ends (to be decided in design).

## Other hosts (official docs, 2026-09-15)

| Host | Feature | Format and fields | Locations | Invocation / parallel |
|---|---|---|---|---|
| Codex | Custom agents [2] | **TOML**: `name`, `description`, `developer_instructions` required; `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config` | `.codex/agents/`, `~/.codex/agents/` | explicit request or instructions; parallel, capped by `agents.max_concurrent_threads_per_session` |
| Gemini CLI | Subagents [5] | Markdown + YAML: `name`, `description`, `tools`, `model`, `temperature`, `max_turns`, `timeout_mins`, `mcpServers` | `.gemini/agents/` > `~/.gemini/agents/` | automatic or `@name`; one at a time, no nesting |
| Cursor | Subagents [7] | Markdown + YAML: `name`, `description`, `model`, `readonly`, `is_background` | `.cursor/agents`, `.claude/agents`, `.codex/agents` and `~/` equivalents; project > user | automatic, `/name`, mention; parallel and background |
| Copilot | Custom agents [10][11] | `*.agent.md`: `name`, `description`, `tools`, `model`, `mcp-servers`, `target` (+ VS Code `handoffs`, `agents`, …) | `.github/agents`, `.claude/agents`, `~/.copilot/agents`, `~/.claude/agents` | picker, issue assignment, CLI `/agent`; VS Code parallel or sequence |
| Cline | built-in subagents only [13] | not user-definable | — | automatic; parallel |
| Continue | `cn` agent files, `subagent` role [15][16] | Markdown + YAML agent file; subagent = model with `roles: [subagent]` | `.continue/agents/`, `~/.continue/config.yaml` | `cn --agent`, Subagent tool |
| Aider | not supported | — | — | — |
| Amp | Custom agents [20] | **TypeScript** plugin `amp.createAgent({name, model, instructions, tools})` | `.amp/plugins/`, `~/.config/amp/plugins/` | tool, agent mode or `amp -x`; parallel |
| Devin | CLI subagent profiles [22] | Markdown + YAML: `name`, `description`, `model`, `allowed-tools`/`tools`, `max-nesting` | `.devin/agents`, `.agents/agents`, `~/.config/devin/agents` | automatic or by name; parallel |
| Zed | built-in `spawn_agent` only [25] | no custom files | — | parallel |
| Pi | not supported [26] | — | — | — |
| OpenCode | primary / subagent agents [28] | Markdown + YAML (file name = agent): `description`, `mode`, `model`, `prompt`, `permission`, `temperature`, `steps`, `hidden`; or JSON | `.opencode/agents/`, `~/.config/opencode/agents/` | Tab, `@mention`, Task tool |

Conclusions for task-level agents:

- Common denominator: Markdown + YAML frontmatter with `name` and `description`, body as the prompt (Claude Code, Gemini,
  Cursor, Copilot, Devin, OpenCode, Continue agent files). Tool/permission field names differ (`tools`, `allowed-tools`,
  `permission`, `readonly`); Codex uses TOML; Amp needs a TypeScript plugin.
- Hosts without user-definable agents: Cline, Zed, Pi, Aider — Tenon can only run a task-level agent there as a prompt in the
  main session (no isolation, no parallelism).
- Only Cursor and Copilot (VS Code) read `.claude/agents` natively; every other host needs a generated per-host definition.

Sources: [2] https://learn.chatgpt.com/docs/agent-configuration/subagents · [5] https://geminicli.com/docs/core/subagents/ ·
[7] https://cursor.com/docs/context/subagents · [10] https://code.visualstudio.com/docs/copilot/customization/custom-agents ·
[11] https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents ·
[13] https://docs.cline.bot/features/subagents · [15] https://github.com/continuedev/continue (extensions/cli) ·
[16] https://docs.continue.dev/guides/run-agents-locally · [20] https://ampcode.com/news/custom-agents ·
[22] https://docs.devin.ai/cli/subagents · [25] https://zed.dev/docs/ai/tools ·
[26] https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md · [28] https://opencode.ai/docs/agents/
