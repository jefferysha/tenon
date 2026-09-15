# Project instruction files today (evidence)

Tenon has no per-project instruction feature. It only maintains a Tenon-owned block inside AGENTS.md.

- Block source `tools/generate-product-identity.mjs:7,48-68` → `templates/generated/codex-agents-block.md` with
  `<!-- PIPELINE:CODEX:START/END -->`; drift check `tools/check-product-identity.mjs:59-78`.
- Writer `adapters/codex/install.sh:61-126`: refuses unpaired/out-of-order markers (70-90), replaces the block (92-117)
  or appends (118-123) atomically; tests `tools/test-adapters.sh:309-354`. Copilot same pattern
  (`adapters/copilot/install.sh:51-100`); Cursor writes `.cursor/rules/pipeline.md` (`adapters/cursor/install.sh:45-66`).
- Ownership `packages/kernel/src/state/ownership-manifest.ts:60-61,184-229` (`isManagedAgentsMd`, `shouldKeepAgentsMd`);
  callers `cli/src/commands/sync.ts:95-98`, `uninstall.ts:228-229`.
  **Defect:** kernel looks for `<!-- PIPELINE:START -->` but the adapter writes `<!-- PIPELINE:CODEX:START -->`.
- `hooks/session-start.sh:199-258` injects `templates/workflow.md`, change context and `GOAL.md`; never reads AGENTS.md/CLAUDE.md.
- `tenon init` (`cli/src/commands/init.ts:133-250`) creates a Change and registers the project only.
- No product code creates CLAUDE.md or `@AGENTS.md` imports.

## This repo

- `/AGENTS.md`: routes to `.agent-rules/COMMON.md`, `FRONTEND.md`, `BACKEND.md` (3-42), subagent rules (44-54), Tenon
  Codex block (56-76); line 6 forbids unescaped `@path` imports for Claude Code.

## Reusable template system

- Document templates: `templates/documents/registry.v1.yaml` + `locales/{zh-CN,en}.yaml` →
  `tools/generate-document-presentation.mjs` → `kernel/src/documents/document-presentation.generated.ts`;
  renderer `document-template-renderer.ts:165`; check `tools/check-document-templates.mjs`.
- Scaffold strategies skip/overwrite/append with marker `<!-- pipeline:scaffold -->`
  (`kernel/src/scaffold/doc-scaffold.ts:21-38,60-188`, CLI `commands/scaffold.ts:148-175`).
- Dashboard: settings only theme/language (`shell/TopBar.tsx:196-242`); no project settings view (`shell/views.ts`);
  onboarding shows CLI commands (`shell/Onboarding.tsx:162-194`); `/api/projects` (`serverPostChangesRoutes.ts:95`,
  `projects.ts`); file-write pattern into a trusted root `serverWorkflowYamlRoutes.ts`.

## Host loading (general knowledge, to verify during design)

Codex merges `~/.codex/AGENTS.md` and AGENTS.md files from repo root to cwd. Claude Code loads CLAUDE.md (project,
`.claude/CLAUDE.md`, user) and supports `@file` imports; it does not read AGENTS.md by itself.
