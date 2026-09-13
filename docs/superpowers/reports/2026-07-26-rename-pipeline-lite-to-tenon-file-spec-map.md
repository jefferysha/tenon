# Tenon 冻结构建逐文件 Spec 回读清单

> Change：`rename-pipeline-lite-to-tenon`
> 实现提交：`8f6e35b`
> 比对基线：`origin/main`
> 映射记录：1179；受禁参考路径以不可逆摘要逐项登记 266 条，避免在当前树重新引入已删除身份。

每一条实现 diff 记录均已回读对应 capability delta spec，并与 requirement/scenario 逐项比对。重命名记录同时覆盖旧路径删除与新路径新增；删除的受禁参考路径使用独立序号与 SHA-256 审计，不重投明文。本清单随后的 governance-only 提交只冻结证据，不改变被审实现。

| 状态 | 改动文件 | 命中的 capability spec | 已回读规范并比对 diff |
| --- | --- | --- | --- |
| M | `.agent-rules/BACKEND.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `.agent-rules/COMMON.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `.agent-rules/FRONTEND.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `.agents/plugins/marketplace.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `.claude-plugin/marketplace.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `.claude-plugin/plugin.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `.codex-plugin/plugin.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `.gitattributes` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `.github/workflows/ci.yml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `.github/workflows/docs-pages.yml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `.github/workflows/release.yml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `.gitignore` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `AGENTS.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `BACKLOG.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `CONTRIBUTING.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `GOAL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `README.en.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `README.zh-CN.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `SECURITY.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `SUPPORT.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `adapters/aider/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/aider/hooks/inject.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/aider/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/aider/hooks/veto.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/aider/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/amp/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/amp/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/amp/plugins/pipeline.js` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cline/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/cline/hooks/PostToolUse` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cline/hooks/PreToolUse` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cline/hooks/TaskStart` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cline/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/codex/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/codex/hooks/inject.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/codex/hooks/prompt.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/codex/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/codex/hooks/veto.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/codex/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/continue/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/continue/hooks/inject.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/continue/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/continue/hooks/veto.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/continue/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/contract.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/copilot/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/copilot/hooks.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/copilot/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/copilot/hooks/veto.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/copilot/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cursor/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/cursor/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cursor/hooks/veto.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/cursor/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/devin/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/devin/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/gemini/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/gemini/hooks/inject.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/gemini/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/gemini/hooks/veto.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/gemini/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/lint-adapter.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/pi/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/pi/hooks/inject.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/pi/hooks/track.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/pi/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/registry.yaml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `adapters/zed/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `adapters/zed/install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R094 | `agents/pipeline-builder.md` → `agents/tenon-builder.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R099 | `agents/pipeline-design-reviewer.md` → `agents/tenon-design-reviewer.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R099 | `agents/pipeline-researcher.md` → `agents/tenon-researcher.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R097 | `agents/pipeline-reviewer.md` → `agents/tenon-reviewer.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `commands/channel.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R084 | `commands/pipeline-cancel.md` → `commands/tenon-cancel.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R071 | `commands/pipeline-pass.md` → `commands/tenon-pass.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R078 | `commands/pipeline-reject.md` → `commands/tenon-reject.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R076 | `commands/pipeline-retry.md` → `commands/tenon-retry.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R087 | `commands/pipeline-sync.md` → `commands/tenon-sync.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R086 | `commands/pipeline-uninstall.md` → `commands/tenon-uninstall.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `design-demos/index.html` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/accept-01-custom.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/accept-02-default.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/e2e-01-saved-on-8765.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p0-01-real-custom.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p0-02-real-default-readonly.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p0-03-real-custom-editable.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p1-01-default-mandatory.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p1-02-custom-editable.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p1-03-dirty-after-gate-edit.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p1-04-default-track-backend.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p2-01-custom-drag.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p2-02-default-nodrag.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p2-03-real-drag-done.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p3-01-hooks-governance.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p4-01-merged-canvas.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p4-02-machine-expanded.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/p4-03-loop-dialog.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10a-1.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10a-2.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10a-3.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-1.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-2.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-3.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-blue-1.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-blue-2.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-blue-3.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-blue-4.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-1.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-2.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-2b.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-2loop.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-3.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-4.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-5.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-mono-6.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-qa-afk.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-qa-inbox.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10b-qa-observe.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10c-1.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10c-2.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v10c-3.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11a-01-initial.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11a-02-selected-inspector.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11a-03-connected.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11a-04-default-readonly.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11a-05-default-skills.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-01-editable.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-02-default.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-03-dark.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-prod-01-custom-light.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-prod-02-default-light.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-prod-03-custom-dark.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11b-prod-03-default-dark.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-1-root.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-2-stage.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-3-skill.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-4-hook.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-5-default.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-6-default-full.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | `design-demos/shots/v11c-7-dark.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #1（sha256:16d2e97cc166deb67d5085d8151880f4f8473579293c0db9153ff1ba50cec503） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `design-demos/v10b-migration-spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `design-demos/v10b-saas-blue.html` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #2（sha256:ed51f78ff0d8eb79b7d4a2af85901c78774e6ce533921cb334ee6924f84c7187） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `design-demos/v7d-lanes.html` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #3（sha256:e335462deb47f69bad81bb91ba4ee45a496297eac52e40867b80c803bd72eaef） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `design-demos/v9-flowdeck.html` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `docs-site/.vitepress/config.mts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/.vitepress/theme/DocsLayout.vue` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/.vitepress/theme/custom.css` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/content-manifest.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `docs-site/public/images/dashboard-workflow-editor.webp` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `docs-site/public/images/dashboard-overview.webp` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `docs-site/public/images/dashboard-progress.webp` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `docs-site/public/images/dashboard-workbench.webp` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/public/llms.txt` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/public/logo.svg` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/scripts/check-content.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/scripts/smoke.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs-site/scripts/sync-content.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/DIST-RELEASE.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `docs/TEST-REALITY.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/adr/2026-07-24-dashboard-state-scope-identity.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/adr/2026-07-24-resilient-plugin-runtime-explore.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| D | 已删除受禁参考路径 #4（sha256:fa279ff7df062c53b48345f27dd6f8269f9b1623901cac96eb1e3640caa960d9） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #5（sha256:f24bf2da8a32b00d63b6bf644f59eb744659220f9f21086d765e05a038f1c137） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/adr/2026-07-26-tenon-product-identity-explore.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/adr/2026-07-26-tenon-update-transaction-ownership.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/loops/progress.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/proposals/2026-07-11-loop-relations-afk-credentials.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `docs/superiority-matrix.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #6（sha256:1c23087409d987292e6cd383bad6825c241e2a67f98acc866358af8b81876a3f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #7（sha256:fed7b88d59999c6912a4ae0a16ea3a18762f829bef7a1cd3f3c8f33ba750b0e5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #8（sha256:57e9fe40f09ba2647d3022fc8e8b0d149acb463ea3599e9a73750682c860b0de） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #9（sha256:836faf5179927eb5fdb1eb42e9ed80d24e52b398088d1bc0fd161a87c536aa15） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/superpowers/plans/2026-07-26-tenon-global-rename.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #10（sha256:68c6434df9f87e69b18e7ac38854f9afd0e2d16817c6275cc8f62007fc8562df） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #11（sha256:a979dca6fd12c8dd5517d9c3555cc3faacf1a413a065f10eb49adec68d7dfb95） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/superpowers/reports/2026-07-26-rename-pipeline-lite-to-tenon-file-spec-map.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/superpowers/reports/2026-07-26-rename-pipeline-lite-to-tenon-verify.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #12（sha256:2fbf4fb7d6b2bc410aeb872f15e350ddbfdf475bc98453a7b2c9a38da98e1338） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #13（sha256:fdbd647ff12f91ec60b298c13056fc346f6073ad267fc6845a6a01073d011c7e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/superpowers/specs/2026-07-24-resilient-plugin-runtime-design.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| D | 已删除受禁参考路径 #14（sha256:7643b9b908a214f111b616389c9a33c81d29fc046f09e103001a47832e924aae） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #15（sha256:69ea2e77f64c149bd0df0954eb05ca2bea882bd005fe23a7d0c406a3e5b0239e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `docs/superpowers/specs/2026-07-25-open-source-docs-industry-patterns-research.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/superpowers/specs/2026-07-25-open-source-docs-solution-site-design.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `docs/superpowers/specs/2026-07-25-open-source-solution-ux-research.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `docs/superpowers/specs/2026-07-25-pipeline-lite-current-state-research.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #16（sha256:ff38589e1cc848d8033a4f75502b87a7d4465242147f5e4d4e53bb5d07c29b8f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #17（sha256:9c7945fba5a457eba89f0d8b35170b720fc6df06e415a71e7a4cfe3bc175d068） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #18（sha256:613b0cf47c1edd16c723f7b2599c7269a791ad91a61ca4c1620e87d0dbc52c23） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #19（sha256:4da391ac31fe949a8d20803c557ca7884c64c139af570f26deed4c345d96a356） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | 已删除受禁参考路径 #20（sha256:ff4e76828661fb4066ff4eaa96745b71a47d0f8948f458525817f6836525ec3c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/superpowers/specs/2026-07-26-tenon-github-pages-rename-research.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/superpowers/specs/2026-07-26-tenon-host-plugin-migration-research.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `docs/superpowers/specs/2026-07-26-tenon-install-and-repository-research.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `docs/superpowers/specs/2026-07-26-tenon-product-identity-design.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `docs/usage/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/advanced-tools.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/automation-and-loops.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/cli-reference.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/contributor-development.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/custom-workflows-and-tracks.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/dashboard-and-local-api.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/default-workflow.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/documents-skills-and-evidence.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/installation.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/quickstart.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/release-notes.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/routing-and-workflows.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/security-model.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/troubleshooting.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/updates-recovery-and-uninstall.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/advanced-tools.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/automation-and-loops.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/cli-reference.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/contributor-development.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/custom-workflows-and-tracks.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/dashboard-and-local-api.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/default-workflow.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/documents-skills-and-evidence.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/index.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/installation.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/quickstart.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/release-notes.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/routing-and-workflows.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/security-model.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/troubleshooting.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `docs/usage/zh-CN/updates-recovery-and-uninstall.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `hooks/auto-update.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/codex-skill-receipt.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/confirm-clear-prompt.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/confirm-clear.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/decision-recorder.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/gate.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/hooks.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/host-session-binding.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/interaction-authority.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/interactive-skill-gate.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/project-root.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/review-ack.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/router-gen.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/router.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/session-start.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/skill-evidence.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `hooks/terminal-activity.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `install.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/.claude-plugin/marketplace.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/.claude-plugin/plugin.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/.codex-plugin/plugin.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/LICENSE` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `migration/legacy-channel/bridge.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/hooks/hooks.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `migration/legacy-channel/manifest.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `openspec/changes/archive/2026-07-24-resilient-plugin-runtime/tasks.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #21（sha256:0fa7abf6367a3ddf38e106df4e9e9b581d2cc5cb1cd74aa2ea893d0f240d3ca5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #22（sha256:baf0492db60e492e9066ba568c61261aaed9b1ad2dc95d8459f3ac335f199ed2） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #23（sha256:471bd57f75e8c052b30562fc7f64ae870cda6e082b1d7a603892e8d1e7e17023） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #24（sha256:5fe3a741cc2b863854e2653cdeead21e12343b1b715e7872ee12c98133951f98） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #25（sha256:c8076632f43383b8c2c5120f84045e6f7b0796a1c7cee5951d73616b55410179） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #26（sha256:4d5725efb6c6e64934a136989b79881a3e31ae8791dcc72c558f4b9f8c46633a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #27（sha256:393d1ddcdecfaf78a7318bc6927d4ad1ffbca60dd2b8d5dca15febe6c43504b4） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #28（sha256:03a91fc89518805f4908adeaa1cc45a8e82adbe01c42cca80c5b76791104a4ca） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #29（sha256:c30fa115b8695805693bb49adcc96868456b18a51b5d092982ca4efde48feca1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #30（sha256:e6966821044116d22ecd5114493e199aba0e84168dd4e81e3ed9822360d5e2bd） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #31（sha256:ba166d1256d70d039fd2b7701e9170b4ae4f6e10cb2549f448f0130d9721f269） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #32（sha256:cec1338cf2a33b1e978a7598ca48ba345fc56306fccac804e30b0d00295578b0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #33（sha256:47a3b6bfbebfb83f3f07b39eeb7331c00be0e0a66d93b291372dfec50129736c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #34（sha256:dc5627a20a3d60899602c351452972db78b37cd9b60a72b06564869676cc5b05） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #35（sha256:b1447accc9530becd943a0193bc9d6db3b8831bba739b57dcf3428d220dcc90b） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #36（sha256:e3c0bad6d2e267da974b2e16ef48ac2ddb50ff1168a676caf5153beebe3c103b） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #37（sha256:64c1cfe737de9127a451eabfab989cf3f722b92d7fd2e148e4ab4dc9165bc092） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #38（sha256:fba4c8038a1b81546e9e57b940ce754752a47c5486cf4d0cf4bcf9284026cbe0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #39（sha256:847ef45f8a7ca1bc937de31fac29ec98fad3a5c32e598e16c5e1d6d374dc6e6f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #40（sha256:961eb3ed7dd4cd2d31cfc8678ef1c9c20a616086defd637bb109a60a4976ac80） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #41（sha256:eae420ac14a96379b7409acbb7ef42530bb655ec91ccad77b0bf51c25580640e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #42（sha256:6c482d4832bafbe27fdba5a5f1f3ce47859135aabba781dcf0ac99800fde1c53） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #43（sha256:93787c402e1ce06aa481ef5acc0af3609863508757c19788614cc3d882f457b1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #44（sha256:d1a5eaf1345a6ed157123941f3faeb075baa7fbf4e1b2eda63276dd83a387e86） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #45（sha256:65747f4c72d472376f9c070a77497813690ed60584a74cf7ceac8fc1d6e77cf7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #46（sha256:745408bf7355db51c9a54e119e84430012c9ada0025fa733d02349001ec32cc4） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #47（sha256:8f4b5b2312cce5b9f12860d3c99fd32fbac70e77405a909a0b01280929f799eb） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #48（sha256:50e8b9805375af1797822fe10357eee1398bef079e14f9221ead9290697c6e32） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #49（sha256:18f158c22215d39e876098b866ec98fc9830d54ff1e29527f444c807f60a4e56） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #50（sha256:8196af073647d676967a07d5c270b00094236e39a949585141d531b0c1e42325） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #51（sha256:753cb383488029c0e2b9a2d81c33c8071988686563eb01cbea7f1626dd574213） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #52（sha256:be16186fd05181c7f8c8251834e04746fa3beb65ed8813c942f208f9c4a4f538） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #53（sha256:2b0162b413790a942f1c9822c24e065590a2c90cc6be55f7e7f97c5c66be2133） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #54（sha256:8fe0e855b5b4b7a15542cba7b5e39d96130bdab9133f77b9c43fe56308693f4a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #55（sha256:8f479424076ddc43cdc034e80046e0818ae562d2844d04c83b15ef57a7b9a025） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #56（sha256:1d25f97e4f3f1a6c39187923b5a037597bb8c87d06d4f5a1ea22d2e2694a6f7b） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #57（sha256:3542f5e86f77df1c643fcaba0b3b5c68d10d4be8236aa6fc63d7ddb4a1525e0d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #58（sha256:9e2e5b0f9257a0b498a8649945d6859c9c16d828d39ba26c816858126c490fe2） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #59（sha256:3407cb26b945de713f66203bf76384838d89c256ee794f1783e1790f4875c827） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #60（sha256:3b3ce7bc52b1d239ee58c04d33d1193168ec953484ebecc1e54900d85367f1c0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #61（sha256:e0253a5fac56d45688c7f73889b7e86c5f25ad8a2b3585acfdbdff0b8af6ee61） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #62（sha256:0977047088f2ad9fbe9529b364c02c95698f1883a6aba794519b13a6e6cbfdba） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #63（sha256:c2ffb3ea87893e759dd55c67cb2419034447644c3231763dc55c43b3737a741f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #64（sha256:45e6a179e292c010daabf76e1a8d6faf2d2e9dea691c3c7654a488d05e393871） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #65（sha256:39341834820912d455a26fdfbff12f0ecdc756c1675c02cccbf23538f144dcf5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #66（sha256:2496b3e4261d9062f16ece587db0ea0b399a88225f688327b8e5e8c08d886a94） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #67（sha256:92af2749b37b48cd265883809541427d43ba6f085c6806a194846402889fb89e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #68（sha256:2dadaed3b8cb8493e14ee82c85ee69b64f69ccd6a7395c70b3ec87a2233a4cc0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #69（sha256:e9b48a8f9d28a3ffc48a32909944c05959998e4d3008f115020102b90f2de78c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #70（sha256:15fa518477758298b5dc63b9644ebdafe600623add98a88424ed4a6de71863b5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #71（sha256:7379b3f854e6fbaf58d3b30e003cc7989606e4a9e2130fb2f5972c7bb2fff245） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #72（sha256:f113ad9297cc0dbf14db3d1c14f818465412edbc7ddad4c622d3c49dc924c2e0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #73（sha256:858b4c812ab844048b13245015770980f5eb1e5ab340ff5ec34cd3a372f3e8f4） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #74（sha256:cbd4e0ef48ae3e9ec1144c9e8b759b5bf985c20f9d89bb1b8f9e1b6f49b8d58c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #75（sha256:69822bb42ee6ed8c605778d5003a6b2e811c64d7e09a9566d180fea1b1946c22） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #76（sha256:c16b5edd0201cca8a882779fe24f347ac92be4e6c4476688c28cd95830bdcfa2） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #77（sha256:e2f9f632d21cf289e352ab7f2c5face38f06dbf60b8e59c64e96a0d77c3e00e0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #78（sha256:82a9a081a6740d2352e8b2f6e00f77af222f915b57c2289bf505484a6a78dcc8） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #79（sha256:2be2958491496cce60b6e35cfdb1e63f0aea745c626f41bc64be402e07a49361） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #80（sha256:a86a4031dc727dc72e542eaf2889bae687d0f0b2f7cf858ee9cb4868839b73b2） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #81（sha256:f5284399fa8eb9746b2bf502d1ed36dacad1b318ac50090cdbdc7b3540addc3d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #82（sha256:f91c9153d6f98b4d4ae92c737bd45c2c784862adeb3e6e01b63f14c463d1fbed） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #83（sha256:37e6bda5e25f24383ef76095abfb376611cc920d649bd1d7e7646976b08ddaed） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #84（sha256:ff168c92e1bdd897950fb41bc12eefc5d7379ff973fc08c710f24f4453b3daf1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #85（sha256:22e82b79bc9c07f0095334d78968370facd675a61131694d2f0fe67b0b955b0f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #86（sha256:e2bf90b89218b0724b9c78e13b0a16084ecce7370f5176b466854c457f4c6f6e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #87（sha256:8b2a0322b16327f05f30fa95e15cd3c240139c5d531f184fc6c2c4233395e4db） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #88（sha256:3f05152a09ac621aa877f3cd97e54cdde4b3ef75f03c282dea68afaf2fae9866） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #89（sha256:9a0a4374ad6163b6110dec79ad094bd12822cdbe6b58a8e937a1839b930dc8bc） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #90（sha256:c5982ceaa369778f52336358ca60006f531b04c3f60e0215cb3084d3cd61c162） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #91（sha256:2d5b6a9309cb353a5f8e6a50b9f7ef702d17a52c398d8275c17869fb9e9d9334） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #92（sha256:c3c2e8ba33faae08b2baa6e94d14e1f3e7aca1900bfe31b24ec9ca82d0ef4f12） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #93（sha256:5f444689679a82ba8d13c296c923ac5045401c52fa02c4b2d430c2aea8fbc2ed） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #94（sha256:47ae5c32048991f22c62d9945c65420d9c7fe8b3502aa5da515e34f763ba7ad0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #95（sha256:944e56346efc0bdd2ef4ca48a88c238dd843dc1fed2d5623226cafc0c6183c38） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #96（sha256:dd50b5b05559ccb15facf8ee65c24f240ab569ea9f3da16d22e57681f88e9c1f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #97（sha256:a040a528986333ab8c285c6ac93ee09e77dcee617d1bbfff87555a1c24c235cb） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #98（sha256:a015a23f5dc1bd3e8fd9b0c05c05f42a39d292e962bab62c3ac1eca7d1334978） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #99（sha256:d761705ef2e5e5c66e7692e90072ed9d56ab8231c8eaf83ed6e3e53629a80f07） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #100（sha256:8b5b0760d1b29ef900e5e3dfe26c8f29c60e18c17f100c615b5deb06facd98ba） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #101（sha256:3bb41ebfa8a2cc41f60918a0154bca99c37e9fdc71b086c1ba7c891a6c414736） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #102（sha256:2d102679c053b0f32d3bea59541e0f1d9c800a96d8bb7f454000f6e1b9d2036f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #103（sha256:f1f4f039d26fe12dc978657f9c020fdb80f5075647c52c42749756722e5e469a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #104（sha256:00ad9f9ebfb0ffcd0d0ee96e2d88f8e6d64ffb19d403a2edbbb2364f11cd30cb） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #105（sha256:750a383f5855345a1819aabe9372e0910f908a1caca7d929a532016066695880） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #106（sha256:b93b2f2fbe3e297a6e76ea2969bee78f4d4550cde91ada4c3af53eb22c0994cb） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #107（sha256:2a34899ba61adee6368ad31d64faf040b657cc66dbc477556e167453933fc174） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #108（sha256:050bc0d53769a7b791b1de06cb3e8930dd8a8ea049720b043d99a95445ee93a3） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #109（sha256:68dcd7906b8be69d9dfa63af004e66d2ab0789193aad363293d9725365783c21） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #110（sha256:0c8ff771a1c48137aaf07ab82f5e6b30bc0ec66b3f82321364c69737ec6a85a7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #111（sha256:f7200111d061763d320bac73a3c6e88bd2feaf9b7f3b3bc70dd3d5f67988a8f6） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #112（sha256:4b1159afa9ce1f78c41e5edb3a0fa87b7f6a1cb5d794c8cc24374f737e3b1e78） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #113（sha256:3338cd63828035463e49201622eb9d1981f44f907399be3d10c40a9de43e5211） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #114（sha256:1f256e4279c4504ce072f18d069727cc54457dd989d697655db1ea679c96c0ad） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #115（sha256:98fd88e39a9feb8f51cffe7aea07ad7cc67941325781eb86f8b213f29a9468ee） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #116（sha256:ff769e08260a04261900dfc6f20b051c23543d108d9be3968d5f2fb5c348bdfd） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #117（sha256:afe3ed183968c1b20afe50fb658bfe0e09691b92d8feb93605488fcf14d5dee9） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #118（sha256:909a97bea5c716dd31123414f43f75f62e2904048d7e15cbabf74c448708d8a4） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #119（sha256:a4a2eaf59c6546b0a357feaae2278625ace29d1f6e586f3dfe0b894036e6bb82） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #120（sha256:057f817a67f93990f9f2bfb07448fc4a109d037831bdd7f3122a36011df832d0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #121（sha256:dc4ef2f69e6ea27d74c7e83213c5c21d2ebf94937628bdc4e0876851fdcd8c43） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #122（sha256:db69cf97bc723b277d5230f711220eade82e8ff25fc186b1763716d8480db627） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #123（sha256:05234f251d110eccc7dc7f1477f7619160a69cf83ec7e55e718781bb13a88036） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #124（sha256:8214316a9aae49836ca5f8dbcb5d6627382a290e04d56c76004db2ec38044c54） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #125（sha256:8af476bb3aa0fb963101acad36d3c1a7af48f2cc3323ec6a0c080258321c8674） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #126（sha256:1418265d9dca188fb18e84dd3a06d6b56473d256fb8881d077f1cfd2f34a872c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #127（sha256:c96a87c50e76fb2731fdae74e6f64c6ab8a06a282f99134f840bb5cd58fe41c9） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #128（sha256:400ff8b568ed8130aebefab7ed376ee0d8f8ed3fff8fc248484445f65ae78e08） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #129（sha256:f9110f19dd1b6992c9dc4f079bf5b9c9609ac7f28831ac73b5e570e7c94abb2f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #130（sha256:03ff91ca0d58771df5567b2830a5df4a5f9fa3ff565a1bad9ee64dce7a3c8583） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #131（sha256:bd0eedacbd01b98941ca4b44cf042fac60f535c962319b62bc4758e50786186f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #132（sha256:c806a45cbe8f789984b17aaef0547d79dd09a4d9d982863698b90eecce654429） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #133（sha256:ab3bf903440833bb1c2eeca2beacd354f477d28fc46e6d18934993bf74901647） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #134（sha256:2d8b8dd12d2fc1693d8b551cea7cd048c594fcc313d8e0b378b6286f2d80bf60） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #135（sha256:316c16ab27ff5bd737d95f2cef5deab6072e0351511c7e7d6d7f7281549196c2） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #136（sha256:c73b2a78d01d9b67c9d362316b7bc1e040984b08997a1c8b77c49105deb9cef3） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #137（sha256:1952c57b99e608cd564c8b95eb4870dad9514285ab02220002523238216f3221） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #138（sha256:2508704829cbc335a6bededf58393ad9ef39902a86c8cd28c5a3193fa9e96b6a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #139（sha256:ced36d6bdc4053213b0033897a1a26e8b94fece72beb92c26d2effbf0d6bdb9f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #140（sha256:3b0ec07eb469874acdbe027789319ba81c92400c68f949bf50c9cad730dcacc7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #141（sha256:2f5a519ee1c69fb2ca86e87fedaff8f35889b0c433b115385cb0ffbd686ca4ae） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #142（sha256:7be37becdf6a476eaaac07118608dfd60e9ff46cc851c8a2a3aedb0ee7060813） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #143（sha256:c48e4b3c967fe422e8fae7fcf6887e7a7f1936646e84f8e22f37ccb5a5ef12c3） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #144（sha256:9582f188a5e6a15c5c6ad83c758946cae99ec256eaa45e8dc4a971af0a1571c7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #145（sha256:4baea0ef51219692b9d1d1865efc8a520175755f6425f913b4cc08cdf56f892f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #146（sha256:74e5d3f1f4d40f5d14b7ddc100ef3c1add4e8889b0c102a714b5905c75a03df7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #147（sha256:437bb38eaafb40851b336bc034bf1c332941e414e74f638a889d2023c894b4b7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #148（sha256:6326d35b5c778187c0633ec4e01f84865b77713777bc1f2879eeb657c76a0dd1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #149（sha256:1df182ec02793c40cd2517d33f0248f13d3fc5c496051393a90abdcd71736f8e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #150（sha256:350ae4a00924de7d0d70a8fc76458f5f71857122c640a35c474199a520b4f2b3） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #151（sha256:104cfda6a0bf30aaa803621a3206d96fd50d8db4857cd36d416f1982d10bf9f1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #152（sha256:0a0d022cd85b77f6a41cd5f716f5419667d1bc0c35c4ba143571da9055a50d39） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #153（sha256:dbbd2615681f7dfe058a900d9430ac99151b54dc5595e3320bbfc6bbb95c2359） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #154（sha256:8d5971fac9fe287826f0ffa5c321ebaa9fb00e278f5250e9b83c70ff5c78c416） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #155（sha256:bdf03d632da8ed428d3aaf3fbd1f2f633c25b18e806e00e90adb68242cfee7c3） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #156（sha256:49326b95c2fc5a461c4e037d29accea0d8b414914677b9233c3c8733cfb76105） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #157（sha256:271bccf69685cd8b79bc10072a2ecc792de5e15301cd85b4b2018b3be8137080） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #158（sha256:cc48c96bb7ba4529cb37634f7bf19f5c74b5451506d135763680957f8c6912a3） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #159（sha256:e10a2eb0f8d7d810857396c1147c244d3eee6836ce99edd7b7751fe1964bbd47） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #160（sha256:4dd6e8365c2d396bd231c5c054a9b53bdc95fbef3d94cef68d7f3a96e13bfa17） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #161（sha256:de5bc1615f75f24fc4f285521b6b810f70b9235b111b47195a18267e521f0da8） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #162（sha256:8b3567f8e93259f6725cd8863ba2522207df3d74209b5ebc4b4ee127008dd9ca） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #163（sha256:85e25ac4bfd993c91cbc9cbb4d7bca4eb6574e768ecfeb627b9529b350ef0121） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #164（sha256:c7ec65b13bb0f7d2f4acac8f3d5cc23ce900c61771a2bbdd15fc9ae58579eba5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #165（sha256:431560f2225441067f9d12f5ccbce1ac17774b2f96e0ad69847fbebaef03018e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #166（sha256:f6401fe84c38869757d833dc2e561e9ce762d6bd3c27df0a09fb6a18ec696d20） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #167（sha256:e0c04326b17bf310d312d81bb7294c678783ed18546f021c4bf8a4c10db42da6） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #168（sha256:79ee27bd923861e9846c6034089d78a4f28270385867ccd44d75416cf29ca785） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #169（sha256:fb48684438670ad5ed69253cad8fab68b7760c38b8cf29372bed2ca197e3f887） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #170（sha256:bd56ad437b9090fe87fa971739e8c0f47cb8e0f9f8db2045589addf120db41ae） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #171（sha256:d2c0a9275ede99b945bf910b79e6705b4d2b3d22be3321c3617f4fb4aac4a28d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #172（sha256:7e6687250698bfe45798771bcdf1e7f0121c9c866280403d32a24e764df1c834） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #173（sha256:2c89af33d6dd1d32dbae4cdb9211db6ceb2bb3756a3a29716efd7ea16cb554f5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #174（sha256:7356218b85e5691a115fa972890fed406b6fcfec4d8d2fed6f16a09d188e65d1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #175（sha256:8d8f9202f5521f1b1e460d7c6994b14220bd38bb76648a14773293dd2e722f2f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #176（sha256:2d051fd9821bc0f95e26939782406f005ac6549c925078693356ecdf2383855b） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #177（sha256:72051139e4ec7ae0dfb4df15c07d7804fb7d6a4522fc2904da3503e61063c940） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #178（sha256:0a75374bdfe14202a13fd64c840968c3e88641e5d98cf31b2586a64f2f8cd35a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #179（sha256:63ceb0ae7f5a77986de319720d0cb70e3e23798240ad0214f8690e41537dd99f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #180（sha256:b77e632ed64b6bb64b9ab88b69784c190a6f8c10d61b852f5cda1d6769595a46） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #181（sha256:bce00f5a4705e28c7c53195e027ca5d34b99ba08ea3f7aaa714b5a9ad422ea36） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #182（sha256:7e5a0049a43e91a54609fdd79805cae5f52e9dadec6f52b1d192b84abc084fa1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #183（sha256:615aa0695a99b62f331b3fb68d272fddd4dc7aa7c3664ba4f05a9b272b399066） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #184（sha256:14e50262beb4e5c428b83979993df75689201b039cb6b1cad999b08c1636d415） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #185（sha256:60e2b7f169569403bedd9e41c56b65eb43537676499cdb2351f56b3911996038） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #186（sha256:89848b06f1bd3772c0fc80b143eecc84de57bea98f9850ab6b20537cb587f2f0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #187（sha256:97c7c726fff21d65ba41b6430d13af3545eabb3b53be79d965721ae4fa4524e9） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #188（sha256:ecd7e097bf2ca47ac7d95a896cb41b22ecc232b4685f1943db833d3d95541710） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #189（sha256:fdff8a7380815a445f2b11ce6f335055c93286867b41ce8fe4b6f4d69ba78925） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #190（sha256:42a39432dd26f2ab4e955ea59f486288762b9f480415da1a83e2a5be59185498） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #191（sha256:81e0b1542b0913e6d62e6bf841a88115c2dc072b8a0b0cde74fbdfec24259f33） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #192（sha256:4228369d9984369096506d2904cb302a063bae8a19100eedee736aa4ec54b482） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #193（sha256:b8f852f04e3d4de2d9a5accc787195c8c690fcf2f934d5b5c05222e66994ebe6） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #194（sha256:c1931c28cc93a248e8765286d5139db3076ed2a77f1c2f66bcaa556f6083e00f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #195（sha256:a809602cdb71876c424f3a76a0ed67429347375726293a5a5fd76d127c314407） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #196（sha256:7715416feb4b5caea9cffc1c6e5167b9faf3497c02dba0ede281190bc15ab815） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #197（sha256:8603ede3c2c2866f67dc29231e112c015c8d6f1c57df8d264413ce3c551f7275） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #198（sha256:78dd44f429b353defb5c53fb09dbcccf4ce41243fd366de651f9b20d8cfcad0b） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #199（sha256:e2ccd19c01e503e7fc70f2afee5dc7414450a387f422254d07746aee2a5f0c18） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #200（sha256:d2a67db5f88c5eac8e57e7cdc5413873d9f4087721eb47d5263895d00752768c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #201（sha256:c3d2800f6fe76382e772c4014ad961f59c90989924d67e99f9128d44f075bae1） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #202（sha256:4326ad05a1f7e0bc3883ed0a271beda1454f8c0611d6b189e809f57165cf505e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| D | 已删除受禁参考路径 #203（sha256:df21a55fd0000740339e1f93734da62b5d71b2865ba2d18a4cf2fc39dda28faa） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #204（sha256:aa5fd8ef7456a9e4ff587837efd976cb801eb084384459b5dab2d1ff70ac5586） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #205（sha256:a4d097a870fcaa71646baf2bd22a0a28a2f895dd1967e605fe680df87af33092） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #206（sha256:fa0afd64caee134c03f92babcefc648c05ed667b3dab2f3a309e501c5ad8048f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #207（sha256:f65d2799fb6526c92237d9279353ab5bf0aee0c5aff3d1f1edc5106ac310867d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #208（sha256:03fb2a9bcd0e32dda84a2916fb08cbba707b034f3497ed5addd4d7a99b690c96） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #209（sha256:ef16fd6051331c231fa7e4cfea1949fb52359231b6130be07d889f27abdf694d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #210（sha256:cc02379ce8f87dd636e12e45326259a68b5a30e866b146e150637fa84ff1a068） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #211（sha256:f367775018d4ad2d2d6b309f01c342d88a6fe6245dd3143aee56eda63a8ee391） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #212（sha256:dd7f85520ec7f3e2dea2929e828a1f1ed7ba0d5e086218ee122e9eebc48149c0） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #213（sha256:641915a21d466704b46c8706a4003356bb7ae04376d9f6db0fd447edb44ee368） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #214（sha256:ebff0b1df0a7678f82da920f72423f605153053d197b873a08728a1acc327260） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #215（sha256:ad2e8f36f5b7323f82cd1de451872067ca12b79bc8e3ee3e79f0fd394ceb8619） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #216（sha256:10a87744b58af72be28728ba4c01a5b6174c2074f432d304cc242ebff5a84d3d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #217（sha256:394e3a0f47f0c4e2307cc9f2820a11380307571defd3eeb7f20912c8dca6566a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #218（sha256:06767062490640ae136513c3fd8c2d576e382e47c733679d8319e041e2e50154） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #219（sha256:efce3d3a125057126c13258139cfd906e9b5311e44168f1f2cca90fc89b49faa） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #220（sha256:55563b663b5033fc42fa88046f782b05eff1afe7aeab243affd9f41102c1bc49） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #221（sha256:8922b0b56903ee4a2846de2f7c310be01784cec006f92f748b5b11a8a767a6de） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #222（sha256:b417a9e5ac334bd3d6bbecebc4ac8efc6494db8603d32ba1ef3fb4075ea34d9c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #223（sha256:1d46051cc44281243cbd51f4fd9f42ad2d9428b064dd687bede3b4c29659809d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #224（sha256:52d1802b3b7ef783d7cd9d7645985db19fcdbb0e27de5abe281cf027c28dd690） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #225（sha256:7bd66826c3f466cc802b42c8b79bc5faae748dcb8198247ead92f15282bfa2af） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #226（sha256:7a7d4a7d7b74386f10509f7a6743676b92994751f6e00b7184808ecca85af7a9） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #227（sha256:4fc3bdf8dfcd89c48b6f7a254a956f9d2f795c56f1806d92dba29bcefb9ab15f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #228（sha256:6fdf9bb76a1e4a4263295026357f878051239df65fa294664b4c2413f84d0daa） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #229（sha256:4f359010ce39c795c000ac1e8969833b013c60f5c14b44a182c8d8b14ac6ee11） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #230（sha256:3779b897b010918f6d9682bee4f0aff4df2f6aa042071fa2940a22a6602f2a13） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #231（sha256:042999d6584b44e8ac8650891720ca784f1e415d884a6317b7c70b34b0d64161） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #232（sha256:d117d10f5655fc0c84fb1f6d4fd59a67eb8a9cac9b5676e3897abcfdbf1e7b7f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #233（sha256:b0ae3b96048ce8ffe57bf719408a458ccc0c64b123db32a3072702e1b32f500f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #234（sha256:b31b4d0598f44e3ecdeae35236b47be9a826dfeeded39cf90c2cdad89666f02d） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #235（sha256:35d46ad1fc606283b73bb4ace3a67a06a6de440a4005598ef5b30d19ea3fca96） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #236（sha256:39154499bfbe16faace99a2e703870969c82a0cee91a48348a31280dedb4a3fa） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #237（sha256:8aff3648f9f13a3ef729d53b7244f0e0f7b6beeebb95b693926a51ea1c7a4055） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #238（sha256:701144ff94613d73141f6b4d7f483f6212c76304aba95a3472bed4bf1ed7e6d6） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #239（sha256:d722d4910e28d9ed705f44429a4d0c1c5b3fb6b56d36de5c4af5b90b1c3d7aca） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #240（sha256:e0de1b7e526c03dfe22125fdf3c37e3f72f58420189c7ecc0e6c7a0b5f241222） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #241（sha256:f0db0d0b329a9eb12559724751763115c5d87295d685060ca35dbd78d6494c80） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #242（sha256:70924933c004eaf3967ca63346f8965c73173c3fa96c3084c3029acbbc618b05） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #243（sha256:aba95254432a36706596e3232429f1ab44dcda20eb3a78aefd70e8178ae63304） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #244（sha256:fc403e05a79aadad08fbbd1a2939824e6f97b64bce5445d2d320906e80730207） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #245（sha256:856bc8df853c1f091cf3c7970eb12e3c77278320ae9f4440ec86410802f2217a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #246（sha256:498f03e0bacf1de28a7a23b819b829fd57e28c0b5f5979c5d94d2c6ac63d1271） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #247（sha256:159efb0dd30a504498c3cb6057626562e41de5858fe4628fd57659eb7daca674） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #248（sha256:f9fdb91ffa69ea151dac883be31d6e3c631fa95bc6124b7231222b6e473e27ef） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #249（sha256:901d55682007396701f35c3b5458b16f5ecd8c50b00d98a150640703eb69ad5e） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #250（sha256:e3bead135c6850826eb0535779c19a7315152893e83638aaa6c219b0f642da57） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #251（sha256:42e2509531d509d716f50e202517e7744d3e106347d4e6cbd7c4c735aa51ca7c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #252（sha256:ab933010c14eacd4b9870920de584a60dd145bdf3a747e558cc4bc1e77b8831f） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #253（sha256:59760bf33e8a10e4f6a06365b345974dccd88986c7ed8b38a065d99e7616e8fb） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #254（sha256:2d896eacff146753b64b2d3e444ca669c4f65637afb1234226e28d7aba379a6a） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #255（sha256:7233ff730bb18a7026fbb1d045bb8fccdd8649e78074f32f8576cdbf4b942fbb） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #256（sha256:257478ee189580ed18729b091094136f72c0a2a638f2169abdab4ad50dccca11） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| D | 已删除受禁参考路径 #257（sha256:130dcf0094cb2addfa25fa8400cf29142d15c5056b1e8be39d17b459fb19a235） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| R100 | 已删除受禁参考路径 #258（sha256:b4cfa796aa5aae30cd93d83bb831c7bf8e91c2e54be9727c19a3a3fbc25e7759） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-documents.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-history.jsonl` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/current.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R059 | 已删除受禁参考路径 #259（sha256:d47c1093f4a026a3aeb9f734e42fb6f1cf8c1c3cb3debdc3f39f7d558e84ca12） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000001-96da285b-f11f-4498-9a55-e0506aea25df.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000002-d501f11f-3093-46fd-9aa0-4d7696231d3e.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000003-380409b4-089c-44ae-8986-809413074221.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000004-6f772de4-cfdd-4d63-bd27-fc1d0a4ba1ea.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000005-30fda606-bde8-4e9c-b087-b009e3d1db93.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000006-a4165423-4045-4d2d-8055-958952d5e6ae.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000007-70fc3950-4e5b-4444-9517-1f00492d2f58.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000008-34090f4f-5e8c-4647-8470-ae229a30de20.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000009-ecc83aed-625e-475d-aa4b-39b9bae9f6eb.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000010-2cc3c907-9416-4a93-a892-c402f3a784d2.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000011-c03ac690-a78a-4e2a-9031-73445b7dcf88.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000012-5b142790-f291-4c3f-bb85-62e9fd3e6124.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000013-029e866d-5892-4f1c-916c-1bce280e1fcd.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000014-def8e97b-bd16-4db1-803b-18a526277baa.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000015-5b0b25ab-4e6c-41a9-8577-b434929c7d25.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000016-2c2ffcfe-e04d-48c5-b43e-2f97039d258a.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000017-380259ff-db31-4c48-9854-754c047cdda0.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000018-94d004fe-3b65-49d7-9ec9-dfc35cc1a94c.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000019-c624955a-a68e-44cb-840f-e867e0c8c286.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000020-8cd25fc8-aece-45e0-9397-14ba195974e7.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000021-e3a4e330-9c39-4821-b0d1-4c9f03d6c9c6.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000022-bc559979-f229-4329-a141-6c4020faf204.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000023-e0c0dfa3-2dcb-45f9-a430-aa3e7ac87194.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000024-41bcc08b-3d65-4f33-9e27-e63ed7e14457.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000025-a8955f49-3517-417b-b390-266786efdbed.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000026-77c2d83e-bb11-434a-9ed5-1f1f1137d0cd.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000027-b38d583a-5060-4781-a664-ca407643007b.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000028-3e77c97b-2387-4213-8e4d-da7ebf211ab0.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000029-fffdc255-3ad7-4132-94bc-ed9e44d3aa85.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000030-af8836c5-0c5e-4763-a422-420f124a4c4b.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000031-1454adc8-9227-42be-bdd7-490190c168e1.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000032-cf6b7a04-b1b9-432a-8955-2f95b9edad5a.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000033-038e18e3-e75d-454d-b7f7-5599c96dbe89.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000034-b750aed0-befe-4a27-b0b5-d4d3f5c08367.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000035-0f363bb2-b418-44d1-83d7-1ca6f8924ad9.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000036-79c60def-122c-4f0f-927d-829d432116d4.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000037-335fac40-63ef-40c2-90a4-c42d19f199d8.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000038-46fece7b-eac1-4143-969d-41af0259f028.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000039-3fe04e34-26f9-493f-8a24-b66f9255d353.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000040-ba47efff-b0d3-4bc1-8fa7-874544311c4e.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000041-699bb375-7c6b-4046-befa-c0d2904f2527.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000042-6fff1f95-ea9f-42f9-a2fe-e3a7ecebc792.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000043-4e16a34e-5299-4de7-a937-467ddee3fa22.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000044-ea1b0d8e-88d3-4990-a852-35057066cf03.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000045-bb91b4e7-076c-4b3a-9ba9-2085094a29cc.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000046-0f332835-8232-4273-9b59-77aefdd8d17c.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000047-d9511ad9-ffc2-4784-8271-ea8a90cf32d1.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000048-5d2c4cf4-6951-4c9b-aa13-5bf2e78c7c34.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000049-f05c3758-e2f3-499e-b867-266da8518381.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000050-c320cef1-756b-4588-a0ff-ce74b74341b3.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000051-6c5401ca-27f9-4e05-a222-c0fe1796583f.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000052-75dd349a-a255-4f0a-b344-a9fcef7d8f38.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000053-7b6c3ebf-164e-401b-9baf-597ca5db7c7d.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000054-a6f50bc0-84db-4775-a762-1c028c28d6f1.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000055-bea7d83c-c380-4649-9210-1f46229ecefc.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000056-0c567a19-cdef-4757-b1c3-f3bac4171b84.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000057-72c77e92-2aca-4738-b983-205e5bd82675.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000058-c324667e-9d1d-4303-b331-845555446ed5.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000059-e6d2ec27-f3fa-4a2e-8298-09193709c68b.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000060-56fc7fc7-d42f-45c1-92dc-953485ffc7d2.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000061-4ac6c704-cba9-4576-827d-42b83501811d.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000062-105f4805-4ff0-4d24-9170-e7c483636fce.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000063-237660eb-55cd-46a4-a8e8-b071ce0981da.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000064-dd2411b3-2f4b-4472-bbf5-aaf871af5704.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000065-03d94093-f431-40b1-8461-30cb26d8d49c.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000066-1daafeae-cf26-4d54-bece-0a1b4991e50f.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000067-a57669d1-c50a-4e26-bd33-98047d9c0e9f.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000068-a8eec2e6-7da9-4a49-a745-7e99013b8eb5.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000069-0d496c7a-6386-4534-ad8c-e4c220107acf.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000070-c5be9eb2-1df1-4ec9-91a7-1ab18dbad5df.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000071-f47aac93-c614-4d7f-918e-d659e8b5a3ef.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000072-eb73b27e-c44e-40e5-9bee-9ee3be50f5fc.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000073-5cf86ea6-329d-4a5e-86c6-1d63615e0bc9.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000074-4e00940c-04b1-4bd8-b786-4236d31b82f5.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000075-40daa71e-f9b3-4294-abc7-104833bc63e2.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-run/revisions/000076-33798aef-fc76-40e2-9d03-ec7112e1f605.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-terminal-activity.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000001-9c0587a7-f992-41a7-b77e-e232572b27d7.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000002-0df4c459-3a02-43a3-a977-f117bd9d7e33.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R054 | 已删除受禁参考路径 #260（sha256:c3de02774832db33e6ac4a19246c14a2a625eec7840526ba74e0328b75852bfa） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000004-87ae467e-7d84-48da-9d4e-f8277ec1c169.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R056 | 已删除受禁参考路径 #261（sha256:c4faadc37adafcd3b1f5ea9e800b910d763b1cca2429790bc6eed7045ee4cbc5） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000006-f6e42715-0f78-4fb3-b4c7-f080a4e7e8db.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R052 | 已删除受禁参考路径 #262（sha256:45fde56978a5433e85a3b38c8b961a5ef71c215491e7b2c4f629c278102df8e7） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000008-0e807306-8010-489e-a671-0369251470e3.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000009-d280aecf-ec53-416d-9c97-1dd505ad99a2.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000010-bce919a9-7fbe-478e-b1ec-aa9d22087373.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000011-23e703bd-17fc-4ba8-a8c6-34235cfa6a2e.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000012-c2b5ea42-1d6b-4963-9497-16df93345ceb.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R056 | 已删除受禁参考路径 #263（sha256:87374d6f731deca64540cf205ace4b3cf651f4388692f636dcb3fd59736af955） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000014-68c529be-7049-4f01-b967-f9eea4e827dd.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R056 | 已删除受禁参考路径 #264（sha256:d860c7390813d640786c254614cae4366217e82f755931ae2aa8cb0d08e6629c） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000016-65dec100-a629-45a3-9e92-157f747b69ef.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000017-c8c63f88-44f9-4de9-be87-3c03f87094c8.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000018-78c02aa6-1d18-4ec3-a6d8-0fbcac3bf819.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000019-c4690b93-5e49-42dd-ba3a-db1b90701d01.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000020-6cc0c4d9-8aaa-4577-a0b0-0e906632c8b0.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000021-aa50dc34-7ddd-4e99-b215-084d88271a04.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000022-67aa0662-169e-4565-8eb0-3b6fe136dff5.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R056 | 已删除受禁参考路径 #265（sha256:c41e9e825d594a78fb4a88f5c296f3a1917576c08f6e7660169d4255bfe2ef31） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000024-8e822326-98b3-4327-8e9b-69e1bc2a97a6.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000025-bd960a77-1379-4017-8edd-cf13d37eb166.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000026-bc8614e1-43e1-413b-b69a-de31fb7362fa.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000027-7ec42982-e695-4c78-9c9f-bd325d3cc090.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000028-c7f5bd51-afda-4021-b8a1-a49dcc5112fa.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-transitions/000029-40e725c4-77fb-47e0-939f-7fad3774427d.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline-workflow-governance.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R081 | 已删除受禁参考路径 #266（sha256:fda4efe33969bd8241fbffa2425f1313c8d82cf69111e65f68cc9e74943ee414） | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/.pipeline.yaml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/design.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/proposal.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `openspec/changes/rename-pipeline-lite-to-tenon/tasks.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/automation-loop-init/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/document-evidence-contract/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/interaction-and-skill-provenance/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/normal-chat-routing/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/open-source-documentation-experience/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `openspec/specs/plugin-distribution/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/plugin-runtime/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `openspec/specs/repository-architecture-compliance/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `openspec/specs/simple-task-routing/spec.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `package-lock.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/automation/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/automation/src/admission/execution-context.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/admission/execution-preparation.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/admission/loop-admission-journal.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/admission/loop-admission-service.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/admission/loop-admission-types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/admission/loop-admission.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/lifecycle-run.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/lifecycle-support.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/lifecycle.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/ports.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/ports.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/spec-complete.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/lifecycle/spec-complete.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/queue/claim.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/queue/claim.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/queue/gate.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/queue/gate.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/queue/scan.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/queue/scan.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/runner/container.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/runner/container.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/runner/container.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/runner/runner.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/runner/runner.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/scheduler/scheduler-execution.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/scheduler/scheduler-outcomes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/scheduler/scheduler-service.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/scheduler/scheduler-support.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/scheduler/scheduler.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/sdk/dockerRunChange.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/sdk/dockerRunChange.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/sdk/dockerRunChange.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/sdk/sdk.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/sdk/sdk.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/skills/content-locator.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/automation/src/skills/production-content-locator.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/automation/src/skills/types.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/automation/src/skills/wiring.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/automation/src/starters/execution-guard.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/starters/execution-guard.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/starters/wiring.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/checkpoint-store.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/checkpoint-store.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/connectors/git-commits-types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/connectors/git-commits.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/connectors/git-commits.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/connectors/loop-run-terminals.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/connectors/loop-run-terminals.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/contracts.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/orchestrator-run.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/orchestrator-support.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/orchestrator.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/workflow-run-create-repository.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/workflow-run-create-repository.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/workflow-run-materializer.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/triage/workflow-run-materializer.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/verifier/git-revision-verifier.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/verifier/git-revision-verifier.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/verifier/verifier.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/automation/src/verifier/verifier.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/channel/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/guard.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/paths.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/paths.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/process.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/supervisor.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/channel/src/thread-state.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R095 | `packages/cli/dist/pipeline.mjs` → `packages/cli/dist/tenon.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/afk-run.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/afk.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/afkReadiness.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/afkReadiness.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/argv.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/artifact.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/channel-process.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/channel.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/codexSkillReceipt.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/codexSkillReceipt.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/codexSkillTrust.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/codexTranscriptEvidence.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/commands/advance-support.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/advance.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/advance.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk-cancel.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk-executor-contract.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk-executor.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk-executor.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk-loop-wiring.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/afk.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/artifact.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/artifact.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/channel.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/channel.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/channelMessaging.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/channelSupervisor.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/channelSupport.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/check.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/check.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `packages/cli/src/commands/dashboard-health.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `packages/cli/src/commands/dashboard-health.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `packages/cli/src/commands/dashboard-process.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/dashboard.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/dashboard.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/doctor-skills.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/doctor.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/doctor.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/document.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/documentScaffoldSafety.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/effective-artifacts.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/effective-workflow.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/field-values.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/fields.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/fields.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/gen-router.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/gen-router.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/handoff.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/import.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/import.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/inbox.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/inbox.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/init.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/init.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/internalCodexJsonl.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/internalConstraintGate.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/internalConstraintGate.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/internalSkillGate.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/internalSkillGate.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-admission-view.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-admission-view.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-run-selection.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-run-selection.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-run-view.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-run.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-run.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-run.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-starter-wiring.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-starter-wiring.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loop-sync.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loops-governance.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loops-init-input.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loops-init.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loops.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/loops.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/mem-render.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/mem.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/mem.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/migrateWorkflow.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/migrateWorkflow.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/plugin-host.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `packages/cli/src/commands/release-coordinator.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `packages/cli/src/commands/release-coordinator.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/review.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/review.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/runtime.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/runtime.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/scaffold.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/scaffold.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/session.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/session.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setup.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setup.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setupEnvironment.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setupHost.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setupRuntime.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setupSkills.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/setupSkillsPlan.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/spec.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/specScaffoldRecovery.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/specScaffoldTransaction.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/specScaffoldTransaction.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/state-projection.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/status.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/status.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/sync.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/sync.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/tap.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/task.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/task.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/tracks.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/transition.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/transition.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/triage.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/triage.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/uninstall.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/uninstall.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/update.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/update.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/workflow-plan.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/commands/workflow-plan.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/context-bundle.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/deps.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/documentLocale.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/events.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/executionCoordinatePort.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/guardContext.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/guardContext.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/h11-starters.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/h13-loop-sync.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/handoff.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/inbox-ttl.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/init-registry.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/init-workflow.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/integration-harness.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/internal-skill-gate-hook.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/loop-run.real.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/loops-budget.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `packages/cli/src/machineHome.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `packages/cli/src/machineHome.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/main.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/migration/legacy-launcher-ownership.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/migration/legacy-launcher-ownership.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/migration/legacy-project-registry.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/migration/legacy-project-registry.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/migration/legacy-tenon-migration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/migration/legacy-tenon-migration.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/program-help.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/program-install.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/program-tracks.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/program-workflows.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/program.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/program.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/cli/src/runtime/activation-compensation.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/bootstrap.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/installer.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/launchers.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/launchers.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/paths.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/paths.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/release-store-codecs.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/release-store.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/release-store.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/stable-hook.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/runtime/types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/scaffold.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/skill-bundle-lifecycle.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/skillBundleAssembly.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/skillBundleAssembly.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/skillSources.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/skillSources.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/sync-uninstall.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/cli/src/tap.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/task.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/terminal-activity-hook.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/cli/src/test-support.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/tracks.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/transition-afk.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/transition-custom-workflow.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/cli/src/workflow-skill-orchestration.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/dashboard-app/dist/assets/index-DJdQov39.js` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `packages/dashboard-app/dist/assets/index-KnBr1lWp.js` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/dist/index.html` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/index.html` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/dashboard-app/src/App.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/App.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/afk/AfkView.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/dashboard-app/src/afk/AfkView.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/dashboard-app/src/afk/OperationResultView.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/api/client.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/api/serverIntegration.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/api/transport.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/i18n/index.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/i18n/translations.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/index.css` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/machine/MachineView.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/model/progressModel.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/dashboard-app/src/model/transition-mirror.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/CreateChangeDialog.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/ProgressActions.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/ProgressToolbar.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/ProgressView.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/WorkflowCanvas.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/progressCanvasModel.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/progress/progressViewModel.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shared/Icon.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shared/TaskConnectionCard.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shared/TaskDetail.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shared/failureDiagnosis.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shared/failureDiagnosis.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shell/Nav.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shell/Onboarding.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/shell/Onboarding.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/solution/SolutionView.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/solution/SolutionView.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/solution/solutionModel.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/GovernanceRail.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/LoopCard.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/SecretsCard.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/SkillChain.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/SkillHealthPanel.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/SkillHealthPanel.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/SkillTransferModal.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/StepperRail.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/WorkbenchView.test.tsx` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/skillPresentation.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/src/workbench/workbenchDefinition.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/dashboard-app/vite.config.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/kernel/src/compress/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/compress/types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/flow/GUARD-RULES.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/flow/guard.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/flow/guard.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/flow/manifest-derive.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/kernel/src/flow/manifest.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/kernel/src/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/loops/binding.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/loops/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/machine-state-scope.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/mem/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/mem/phase.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/kernel/src/product-identity.generated.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/kernel/src/product-paths.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/kernel/src/product-paths.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/allowlist.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/allowlist.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/doc-scaffold.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/doc-scaffold.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/workflow-resolution.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/scaffold/workflow-resolution.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/document-evidence.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/document-ledger.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/document-ledger.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/fixtures/channel-adapter-worker-guard-oldschema.pipeline.yaml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/kernel/src/state/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/markers.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/ownership-fs.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/ownership-manifest.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/kernel/src/state/ownership-version.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/projectRegistry.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/projectRegistry.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/run-metadata.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/secrets.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/secrets.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/spec.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/tasks.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/tasks.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/transitionTail.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/state/workflow-plan-snapshot.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/kernel/src/state/workflow-run-repository.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/tracks/registry.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/tracks/router-projection.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/tracks/router-projection.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/tracks/types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/triage/validate.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/document-contract-validation.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/document-contract.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/effective-plan.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/effective-plan.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/kernel/src/workflow/migrations/pre-tenon-v1-document-policy.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/skill-evidence.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/skill-evidence.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/transition-application.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/validate.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workflow/validate.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/kernel/src/workspace/fingerprint.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/npm-bootstrap/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| A | `packages/npm-bootstrap/bin/tenon-bootstrap.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `packages/npm-bootstrap/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/server/dist/dashboard.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/server/src/afk.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/afk.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/afkReadiness.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/afkReadiness.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/automationConfig.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/cadence.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/cadence.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/changeLaunch.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/config.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/config.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/hooksConfig.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/server/src/loops.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/loops.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/loopsTypes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/main.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/marketplaceManifest.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/server/src/memSessionLink.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/operations.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/server/src/paths.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/paths.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/preempt.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/preempt.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/projects.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/server/src/projects.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/registry.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/routerPreview.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/routerPreview.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/runDetail.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/secrets.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/secrets.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/server/src/server-args.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/server/src/server-args.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `packages/server/src/server-process.integration.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/server.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/server.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverGetActivityRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverGetRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverGovernance.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverMutationRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverPostChangesRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverPostExecutionRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverPostGovernanceRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverPostOperationsRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverPostRoutes.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverSupport.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/serverTransport.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/skillsRegistry.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/server/src/skillsRegistry.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/server/src/snapshot.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/server/src/snapshot.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/dashboard-execution-provenance/spec.md` | ☑ |
| M | `packages/server/src/test-support.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/token.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/traces.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/traces.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/transition-concurrency.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/transition.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/transitionHistory.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/types.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/version.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/workflowReferenceScan.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/workflowTrustedFs.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/workflows.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/server/src/workflows.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/tap/package.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `packages/tap/src/certificate-store.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/tap/src/certs.test.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/tap/src/index.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/tap/src/launch.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `packages/tap/src/paths.ts` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `product/identity.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `product/legacy-identity-policy.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R083 | `runtime/pipeline-bootstrap.mjs` → `runtime/tenon-bootstrap.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/EXTERNAL-SKILLS.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/brainstorming/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/browser-qa/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/code-review/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/code-tour/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/deep-research/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/deployment-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/design-taste-frontend/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/dispatching-parallel-agents/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/docker-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/e2e-testing/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/find-skills/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/finishing-a-development-branch/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/frontend-design/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/frontend-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/github-ops/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/grill-with-docs/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/hallmark/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/handoff/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/huashu-design/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/hue/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/improve-codebase-architecture/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/learn-record/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/market-research/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/nestjs-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/openspec-apply-change/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/openspec-archive-change/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/openspec-explore/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/openspec-propose/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| D | `skills/pipeline-lite/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/postgres-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/prototype/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/python-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/python-testing/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/react-best-practices/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/react-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/run/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/search-first/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/security-review/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/shadcn-ui/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/simple-task/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/skill-creator/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/subagent-driven-development/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/tailwind-css-patterns/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R080 | `skills/pipeline-archive/SKILL.md` → `skills/tenon-archive/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R086 | `skills/pipeline-build/SKILL.md` → `skills/tenon-build/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R073 | `skills/pipeline-explore/SKILL.md` → `skills/tenon-explore/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R074 | `skills/pipeline-open/SKILL.md` → `skills/tenon-open/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R090 | `skills/pipeline-researcher/SKILL.md` → `skills/tenon-researcher/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R084 | `skills/pipeline-ship/SKILL.md` → `skills/tenon-ship/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R080 | `skills/pipeline-spec/SKILL.md` → `skills/tenon-spec/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R076 | `skills/pipeline-verify/SKILL.md` → `skills/tenon-verify/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| R070 | `skills/pipeline/SKILL.md` → `skills/tenon/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/test-driven-development/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/to-spec/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/to-tickets/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/triage/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/uiuxdesign-pro/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/verification-before-completion/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/verify/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/web-artifacts-builder/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/web-design-guidelines/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/writing-plans/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `skills/zoom-out/SKILL.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `templates/documents/schemas/registry.v1.schema.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `templates/manifest.yaml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `templates/skill-sources.yaml` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `templates/workflow.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/build-legacy-bridge.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/build-legacy-bridge.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/build-npx-package.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/build-npx-package.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/check-architecture.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `tools/check-comment-honesty.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/check-docs.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/check-docs.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/check-legacy-identity.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/check-legacy-identity.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/check-product-identity.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/check-repository-hygiene.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| A | `tools/check-repository-hygiene.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/repository-architecture-compliance/spec.md` | ☑ |
| M | `tools/fixtures/n-minus-one-release.json` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `tools/generate-product-identity.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| A | `tools/install-bootstrap.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `tools/oracle/fixtures/backend-full.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/oracle/fixtures/default-effects.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/oracle/run.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/prepare-n-minus-one-release.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| A | `tools/product-identity.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/reconcile-spec-application.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/sandcastle/Dockerfile` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/sandcastle/README.md` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/open-source-documentation-experience/spec.md` | ☑ |
| M | `tools/sandcastle/build.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| R090 | `tools/sandcastle/pipeline-afk-run.sh` → `tools/sandcastle/tenon-afk-run.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/spec-migration-cas.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/spec-migration-cas.node-test.mjs` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/test-adapters.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `tools/test-bundle.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| M | `tools/test-hooks.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| M | `tools/verify-skills.sh` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/plugin-distribution/spec.md` | ☑ |
| D | `workflow-governance-desktop.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `workflow-governance-mobile-dark.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
| D | `workflow-governance-mobile.png` | `openspec/changes/rename-pipeline-lite-to-tenon/specs/tenon-product-identity/spec.md` | ☑ |
