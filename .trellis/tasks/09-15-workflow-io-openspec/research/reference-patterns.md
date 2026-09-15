# How other products show step IO (research)

- OpenSpec (`schemas/spec-driven/schema.yaml`): artifact `id`, `generates` path/glob, `template`, `instruction`,
  `requires`; `openspec status` → `[x] proposal`, `[ ] design`, `[-] tasks (blocked by: design)`; never blank.
- spec-kit: fixed files per command, required vs optional; ✓/✗ per file; missing → "Run speckit plan first".
- BMAD: `module-help.csv` with `phase`, `preceded-by`, `required`, `output-location`, `outputs`; scans outputs to decide done.
- Kiro: three fixed files, a single "Move to design phase" gate button, per-task status.
- Dagster: asset nodes with status; "Unsynced" tag with hover reason (closest to Tenon `stale`).
- n8n: schema preview before a run; empty states give reason + one action ("Execute previous nodes").
- Dify: fixed read-only "Output Variables" per node type; separate "Last Run" tab.
- GitHub Actions / Argo / Kestra / Prefect: outputs declared in YAML, never a form; artifacts listed per run with preview.
- Superpowers skills state output paths only as prose (`brainstorming/SKILL.md:100`, `writing-plans/SKILL.md:18`).
- Trellis: `prd.md` alone valid for light tasks; complex tasks need design + implement; "artifact presence informs the next step".

## Patterns ranked by fit

1. One checklist row per slot, same row in definition and run views (expected → recorded/missing/stale).
2. Every missing/blocked state names the reason or the producing skill.
3. Stale shows a hover reason.
4. Gate shows its preconditions as a count.
5. Inputs render as "from step · file", not a separate editor.
6. Progress count in the header; hide slots that do not apply.
7. Recorded files open in a preview panel.
8. Step-level status colours the flow; no IO inside nodes.
