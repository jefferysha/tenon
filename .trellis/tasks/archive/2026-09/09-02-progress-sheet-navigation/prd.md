# Progress navigation and sheet information architecture

## Goal

Repair page navigation breadcrumbs and convert dense Progress detail into a compact sheet-based workspace with plain-language UI and synchronized terminal/web status.

## Requirements

- Every primary page must expose a consistent breadcrumb trail. Breadcrumb ancestors are keyboard accessible and navigate through the existing view state; the current page is announced but is not a dead link.
- Selecting “进度” from the rail must always land on the Progress view. When no project is selected, the view shows a compact project-selection gate instead of silently redirecting back to Projects.
- Progress detail must be a compact sheet with four user-facing sections: `概览`, `产出`, `终端`, and `记录`. Only the active section is mounted so that users are not forced through one long document.
- The overview shows only the selected task, current stage, next action, and a short status summary. Technical identifiers, raw artifact keys, and verbose completed-task lists are kept behind the relevant detail section.
- User-facing copy in the new navigation and sheet surfaces uses plain Chinese (`任务`, `流程`, `方向`, `阶段`, `产出`, `终端记录`) while preserving workflow/track/change identifiers in URLs and domain contracts.
- The terminal section makes the boundary explicit: Web is for status, approvals, and evidence; the terminal/LLM session remains the place for conversation and code execution. Existing resume, log, and related-session controls are reused.
- The change is presentation and navigation only. Existing snapshot, task, transition, artifact, and run-history schemas remain the single source of truth; no second client-side execution state is introduced.
- The layout must remain usable at desktop and narrow mobile widths, with no horizontal page overflow, accessible tab semantics, and reduced-motion support.

## Acceptance Criteria

- [x] Breadcrumbs render on every primary view and expose working ancestor navigation with `aria-current` on the current item.
- [x] From a project list with at least one project and no selected root, clicking the Progress rail item changes the URL/view to Progress and shows the project gate; it does not bounce back to Projects.
- [x] Progress detail opens with the Overview sheet selected; switching sheets updates the active panel and does not duplicate hidden heavy content in the DOM.
- [x] Overview is materially shorter than the legacy all-sections timeline and contains no raw `[document]` labels or internal orchestration terms in its default copy.
- [x] Outputs, Terminal, and Records expose the existing evidence, session/log, and audit/history data respectively without changing their data semantics.
- [x] Unit/component tests cover breadcrumb navigation, rootless Progress navigation, tab switching, and terminal/web boundary copy.
- [x] `npm run typecheck:web`, `npm run test:web`, `npm run build:web`, and the existing Playwright orchestration E2E suite pass.
- [x] Browser verification at desktop and 390px mobile confirms no horizontal overflow and no console errors.

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
