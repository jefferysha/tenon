# Real backend full-workflow evidence

This directory records a real seven-stage run against a disposable task-service project. Each stage invoked a local `codex exec --json --output-schema` child with a task-local SKILL.md, captured its JSON result, observed filesystem changes through `StageArtifactRuntime`, and published observed files through the durable artifact service.

Stages: `plan → design → build → review → verify → package → acceptance`.

- `01-plan` through `04-review`: child result and artifact catalogs pass.
- `05-verify`: the Codex child honestly returned `blocked` because its sandbox denied TCP bind with `EPERM`. The same independent acceptance harness was run by the parent process and passed all source API checks; see `05-verify/external-acceptance.json` and `source-acceptance.json`.
- `06-package`: real archive `project-snapshot/release/tasks-service.tgz` was created, inspected, and its source/package launch logs were captured.
- `07-acceptance`: child report was retained; parent package acceptance passed all checks; see `07-acceptance/external-acceptance.json` and `package-acceptance.json`.

`full-workflow-outcome.json` is the aggregate outcome. It marks effective stage status separately from the raw child status so environmental TCP restrictions are visible rather than hidden. `orchestrator-probe.json` records a successful public V2 planner/runtime probe with a frozen serial pipeline and a passed verification gate.

The existing production CLI/server orchestration entrypoints were not changed or claimed as UI-to-model wiring. This run is a task-local validation adapter around the public runtime and artifact APIs; it proves the real child execution and artifact lifecycle, not that the current product UI already launches these children.
