# 修复实跑暴露的质量门禁与测试发布问题

## Goal

把当前“主路径可运行但不能发布”的分支收敛到可重复、可审计、可发布状态。门禁必须读取当前产品真相源，测试失败必须先完成回归/fixture 分类，发布资产与正式截图不得漂移，CI 必须执行真实浏览器覆盖。

## Confirmed facts

- 当前分支 `codex/autonomous-loop-v1` 有 97 个未提交改动；本任务只修改子任务声明的文件，保留其他改动，不做广泛回滚。
- `check:docs` 仍读取已删除的 `packages/dashboard-app/src/shell/Nav.tsx`，并按顶层 `steps` 解析已改为 `tracks` 的 default workflow。
- `verify-skills.sh` 将仓库内 Claude Code 集成目录 `.claude/skills/*/SKILL.md` 误判为重复发行树。`.claude/` 包含本仓库的 settings、hooks、agents、commands、skills 配置，不能整体 gitignore；根因是发行归属扫描过宽，`.gitignore` 只允许必要的细粒度规则。
- `AGENTS.md` 当前被删除，身份门禁缺文件时直接暴露 ENOENT 堆栈。
- dashboard 当前视图真相源是 `packages/dashboard-app/src/shell/views.ts`，只有 `progress` 与 `workbench`；正式截图仍是旧五栏蓝色 UI。
- dashboard hashed dist 存在旧文件删除、新文件未跟踪的状态；仅 `git diff --exit-code` 会漏掉未跟踪资产。
- 确定性测试失败包含 fields 组合校验 7 个、artifact 5 个；`internal-skill-gate-hook.integration.test.ts` 3 个、`workflow-skill-orchestration.integration.test.ts` 2 个尚未纳入原计划。stable-hook 的文档路径失败和 internal-skill-gate 失败尚未完成回归/fixture 定性，不能预先假定为 fixture 过期。
- `transition-effects.integration.test.ts` 全量并行下出现超时，单独运行可通过，需隔离或合理调高超时并验证可重复性。
- `playwright.config.ts` 与 `tests/e2e/orchestration-v2.spec.ts` 当前没有被 package、CI 或 tools 引用；另有 `workflowRuntime.browser.e2e.test.ts` 硬编码 macOS Chrome 路径。
- `check:design-scale` 当前 13 条失败集中在 `packages/dashboard-app/src/workspace/ArtifactCatalogPanel.tsx:32-40`；`check:repository-hygiene` 当前 10 条失败，包含历史截图 allowlist 和外部参考身份文本的范围决策。
- `npm test` 依赖已生成的 `packages/*/dist`；CI 使用 npm ci，仓库同时有 pnpm 配置和占位 `pnpm-workspace.yaml`。`engines.node >=22`、CI Node 22、本机 Node 24 本身未违反约束，不把它误判为 bug。
- 架构门禁报告 5 个后端文件超 400 行、非空断言、`skillRuns.ts` 裸 JSON.parse、workflow identity capability 重建越界；OpenSpec/Trellis 还有长期失败或无 delta 项。

## Requirements

### R1 技能发行归属与身份门禁（子任务：skill-identity-gates）

修正 `verify-skills.sh` 按 canonical `skills/` 发行归属判定的误报，明确排除 `.claude/`、`.agents/`、`.pipeline/` 的投影路径但保留 `.claude/` 配置文件可被版本控制；保留真正重复发行树 fixture 的失败覆盖。恢复 `AGENTS.md`，并让身份门禁对缺失/不可读/managed block 缺失输出稳定可读错误。

### R2 文档、截图、设计刻度、发布资产与卫生门禁（子任务：docs-assets-hygiene）

让 `check-docs`/fixtures 从 `views.ts` 与 `tracks` workflow 读取契约；更新中英文文档并重拍四张 `docs-site/public/images/dashboard-*.webp` 正式截图。修复 `check:design-scale` 的任意字号/退役 token。对 `check:repository-hygiene` 的历史截图（8 个）决定扩 allowlist 或迁移到非正式证据目录，并决定 `.gitattributes` 外部身份注释与 research 文档是否豁免；决策必须记录在子任务 PRD/design。补强 dashboard dist freshness，替换仅靠 `git diff` 的检查，覆盖未跟踪资产和 index 引用。

### R3 工作流组合语义与失败集（子任务：workflow-failure-set）

落实已决策的窄规则：同一 workflow 内换轨允许，只有目标 track 在当前 workflow 没有同名 branch 时拒绝；`simple` 的 `escalated` 是显式终态，不是换轨出口。按真实 branch 更新 fields 7 个 fixture；artifact 5 个仅在确认 policy/required_when 事实后修正。先诊断再处理 stable-hook 文档路径和 internal-skill-gate 3 个失败；将 orchestration 2 个失败分别归入 R1 或 R3，并补真实回归证据。

### R4 Playwright CI 与测试自举（子任务：ci-test-bootstrap）

将 `workflowRuntime.browser.e2e.test.ts` 改为 Playwright 配置发现浏览器；决定把现有 `tests/e2e/orchestration-v2.spec.ts` 接入 CI 还是删除，并以实际执行为验收。修复 `npm test` 对 dist 的隐式依赖，统一或明确 npm/pnpm 契约；Node 版本保持现行 >=22/CI 22，除非新证据要求收紧。

### R5 架构、CLI 与维护债务（子任务：architecture-cli-debt）

拆分超长后端模块而不放宽阈值，移除非空断言和裸 JSON.parse，修复 workflow identity 重建越界。修复不存在 change 的 `tenon get` 错误边界。对长期 OpenSpec/Trellis change 给出可追踪的完成、归档或 deferred 处理，不伪造通过。

### R6 交付证据

每个子任务独立提供定向测试、门禁、构建/类型检查和回滚点；父任务做集成复核。浏览器或 CI-only 项必须给真实日志或明确 deferred，不得把用户提供的历史实跑结果当作本次证据。

## Key decisions

- change 创建后禁止切换到当前 workflow 没有同名 branch 的 track；同 workflow 内换轨保持可用，并重新解析冻结 workflow plan。
- `simple` workflow 的 `escalated` 是终态；文档中的升级出口表示结束当前 change 后另起流程。
- `.claude/` 是仓库的 Claude Code 集成配置，不能整体忽略；只修发行扫描归属，任何 gitignore 调整必须细粒度且有路径级验证。
- dashboard dist 继续作为发布资产入库；新增 freshness 检查必须替换或覆盖现有只检查 `git diff` 的步骤。
- Node `>=22`、CI 22、本机 24 当前视为兼容，不因版本差异单独改 engines。

## Acceptance criteria

- [ ] 五个子任务均有独立 PRD、设计/执行计划（如复杂）和验证证据；父任务完成集成复核。
- [ ] `verify-skills`、`test-hooks`、identity、docs、design-scale、repository-hygiene 门禁按当前真相源通过；真正重复 Skill fixture 仍能拒绝。
- [x] 四张正式 dashboard 截图与当前两视图 UI 一致，文档不再描述退役视图。
- [ ] dist freshness 检查发现缺失和未跟踪资产，index 不会指向不存在文件。
- [ ] fields/artifact/internal-skill-gate/workflow-skill-orchestration/stable-hook 失败先完成分类，产品回归有代码修复，过期 fixture 有契约依据；全量与定向结果可重复。
- [ ] CI 安装 Chromium 并由 `npm test` 执行真实 browser runtime 测试；退役视图依赖的孤立 e2e 已删除。
- [x] 干净 checkout 测试自举、CLI 边界和 OpenSpec deferred 状态均有可审计结果；架构门禁仍报告既有超长文件、非空断言和 identity 重建债务，已保留为明确的后续债务。
- [ ] 任务范围外的现有未提交改动未被回滚、删除或混入提交。

## Out of scope

- 不整体 gitignore 或删除 `.claude/` 配置，不清理无关 worktree、缓存或其他 Trellis 任务。
- 不通过放宽门禁、永久跳过测试、强制添加无引用 dist 或修改 Node engines 来伪造绿色。
- 不在 stable-hook/internal-skill-gate 完成诊断前直接改断言。
