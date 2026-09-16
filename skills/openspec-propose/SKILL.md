---
name: openspec-propose
description: First-party OpenSpec proposal and default-change artifact authoring.
license: MIT
metadata:
  author: tenon
  version: "2.0.0"
---

# OpenSpec Propose

## Document language

New Changes default to `zh-CN`. Before authoring a missing governed file, use
`tenon document scaffold <change> <kind>` so the shared presentation registry supplies the
Change-pinned structure. Write reader-facing headings, requirements, scenarios, tasks, and
explanations in that pinned locale (`zh-CN` by default; English when explicitly pinned to `en`).
Keep file names, phase/event ids, document kinds, producers,
frontmatter/coverage keys, commands, and `ADDED/MODIFIED/REMOVED Requirements` as stable English
machine tokens.

For a delta spec, always pass the real capability explicitly:

```bash
tenon document scaffold <change> delta-spec --capability <capability>
```

Never infer the capability from the Change name or a default scope.

The scaffold is missing-only and never counts as Skill completion or document evidence. Existing
or archived files retain their language unless the user explicitly requests a digest-changing
translation.

Create or complete the OpenSpec artifacts owned by the active default pipeline change. This is a
packaged workflow skill; it never requires the separately distributed `openspec` CLI.

## Inputs

- A clear feature, fix, research, or product request.
- The selected `change`, `track`, and `preset` from `<pipeline-dispatch>` or the `pipeline` CLI.

If the request cannot safely produce a kebab-case change name, ask the user. If several active
changes exist and the user asked to resume without naming one, use `tenon list --json` and ask
them to select; never guess based on modification time.

## Procedure

1. Create the canonical change when it does not already exist:

   ```bash
   tenon init "<change>" --track "<pm|frontend|backend>" --preset "<full|tweak|hotfix>"
   ```

   `tenon init` creates the OpenSpec change directory, default document skeleton, document
   ledger, and canonical state atomically. Do not call `openspec new`, `openspec init`, or install
   a global dependency.

2. Bind the exact target before continuing.  The root pipeline skill must already have done this
   before loading `openspec-propose`; this repeated command makes a direct recovery deterministic:

   ```bash
   tenon session activate "<change>"
   ```

   Never infer a target from a pre-existing `active-change` pointer or its modification time.

3. Read the current `proposal.md`, `design.md`, and `tasks.md` before changing them. Preserve any
   user-written or previously approved content; replace only explicit open-phase scaffold text.

4. Write the three open artifacts:

   - `proposal.md`: 保留 OpenSpec 必需的 `Why`、`What Changes`、`Capabilities`、`Impact`
     机器标题；标题下按 Change-pinned locale 记录问题、变化、能力与影响。
   - `design.md`: 按 Change-pinned locale 记录初始架构/交互假设、风险和 Explore 必须验证的问题；
     Open 不伪造最终架构。
   - `tasks.md`: 阶段标题来自真实 workflow 的 label/id；default 使用固定 locale 对应的七阶段 label。
     Open 任务在前，实施 checkbox 只能在 Spec 后进入 Build。

5. Verify that all three files are non-empty, then register their evidence with the real skill name:

   ```bash
   CHANGE="<change>"
   tenon document record "$CHANGE" proposal "openspec/changes/$CHANGE/proposal.md" --producer openspec-propose
   tenon document record "$CHANGE" openspec-design "openspec/changes/$CHANGE/design.md" --producer openspec-propose
   tenon document record "$CHANGE" tasks "openspec/changes/$CHANGE/tasks.md" --producer openspec-propose
   tenon document status "$CHANGE"
   ```

   A record can succeed only after this Skill has a completion-state host evidence record.  On a
   Codex exec path that omitted PostToolUse, the CLI validates the matching host transcript before
   it appends the evidence. Do not invent a producer name to bypass that check.

6. Present the three artifacts to the user and stop at the phase boundary. The pipeline entry skill
   owns the later explore/spec/build dispatch; do not implement application code from this skill.

## Guardrails

- The task list is a living source of truth, not a one-time Todo list.
- New capability requirements are created in spec as
  `openspec/changes/<change>/specs/<capability>/spec.md`; open must not pretend they already exist.
- When a file changes after registration, re-register it so its digest-bound evidence stays current.
