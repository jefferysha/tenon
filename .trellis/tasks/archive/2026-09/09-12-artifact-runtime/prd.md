# 执行器产物采集与渐进上下文

## Goal and requirements
R2–R8 and R10: connect the service to real execution and CLI/host paths with baseline/reconciliation, publication and consumption.

The parent PRD is authoritative: `.trellis/tasks/09-12-runtime-artifact-workflow/prd.md`. Preserve every relevant acceptance criterion; no unresolved user-owned decisions. User explicitly authorized creation and execution.

## Acceptance
Demonstrate this child’s requirements with meaningful tests and provide integration-ready exports/wiring. Existing governed workflows retain their evidence gates. No claim of completion without real runtime connections and verification.

## Boundary
Automation runtime/admission/lifecycle integration, artifact CLI and supported host hook wiring. Depend on the core public API.
Preserve concurrent edits and never edit another worker’s owned modules without coordination. No external deployment or unrelated refactor.
