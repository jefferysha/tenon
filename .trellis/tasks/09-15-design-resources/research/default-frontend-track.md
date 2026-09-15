# Default workflow frontend track and document kinds (evidence, 2026-09-15)

- Document kinds are a closed list of 10: proposal, openspec-design, tasks, superpower-design, adr, delta-spec, superpower-plan,
  plan, verification-report, applied-spec (`packages/kernel/src/workflow/document-contract-model.ts:7-18`). No DESIGN.md kind.
- Document requirements are keyed by canonical phase ids and ignore the track (`document-contract.ts:32-123`), so a
  frontend-only required document needs track-aware contracts (recorded as R10 in `09-15-workflow-io-openspec`).
- Frontend track steps and skills (`templates/workflows/default.yaml`, frontend branch):
  - open 立项 (no gate): tenon-open, openspec-propose
  - explore 调研 (review): tenon-explore, openspec-explore, brainstorming, grill-with-docs — no design skill
  - spec 规格 (review): tenon-spec, openspec-propose, writing-plans
  - build 实现 (no gate): tenon-build, frontend-design, test-driven-development
  - verify 验证 (review): tenon-verify, browser-qa, web-design-guidelines, design-taste-frontend,
    verification-before-completion, e2e-testing
  - ship, archive
