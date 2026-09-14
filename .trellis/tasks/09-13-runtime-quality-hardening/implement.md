# Implementation Plan

## Child task order

1. **skill-identity-gates**：修正 `verify-skills` 发行归属扫描，保留 `.claude/` 配置；恢复并硬化 `AGENTS.md` identity gate。验证 `test-hooks`、identity。
2. **docs-assets-hygiene**：对齐 `check-docs` 到 `views.ts`/`tracks`，修 design-scale；审查 8 个历史截图与 2 个外部身份命中并记录决策；重拍四张正式 dashboard WebP；实现 dist index/asset freshness。验证 docs/design-scale/repository-hygiene。
3. **workflow-failure-set**：先复现并分类 7 fields、5 artifact、3 internal-skill-gate、2 orchestration、stable-hook 失败；落实跨 workflow fail-closed、同 workflow 换轨和 escalated 终态测试。只有证据确认后才改产品或 fixture。
4. **ci-test-bootstrap**：接入或删除完整 `tests/e2e`；Playwright 统一浏览器发现、CI 安装和执行；修复 npm test 的 dist 自举依赖，明确 npm/pnpm 契约；保持 Node >=22。
5. **architecture-cli-debt**：拆分五个超长 server 模块，修非空断言/裸 JSON.parse/identity 重建越界；修 `tenon get` 边界；处理 OpenSpec/Trellis 长期失败或 deferred。
6. **父任务集成**：汇总五个子任务证据，运行跨层 build/typecheck、定向测试、`test:web`、门禁集合和必要的全量 npm test；记录无法在本机验证的 CI-only 项。

## Validation commands

- `bash tools/verify-skills.sh && bash tools/test-hooks.sh`
- `npm run check:identity`
- `npm run check:docs && npm run check:design-scale && npm run check:repository-hygiene`
- 失败集定向 Vitest（fields、artifact、internal-skill-gate、workflow-skill-orchestration、stable-hook、transition-effects）
- `npm run typecheck:web && npm run build && npm run test:web`
- Playwright CI job（安装浏览器后执行 `tests/e2e`）
- 架构、OpenSpec、release-workflow、npx-package 等受影响门禁

## Risky files and rollback points

- `.claude/`、`.gitignore`、`tools/verify-skills.sh`：不可整体忽略或删除 Claude 配置；路径级检查失败时回滚本组。
- `AGENTS.md` 与 identity checker：只从 HEAD 恢复缺失文件，避免覆盖其他脏改动。
- `tools/check-docs*`、正式截图、dist：先更新真相源再更新文档/资产，freshness 失败时停止发布。
- `packages/cli/src/commands/fields.ts`、kernel workflow：保持同锁校验和 branch fail-closed。
- `.github/workflows/ci.yml`、Playwright 配置：保持 e2e job 独立，避免 CI 失败无法定位。
- server 拆分：每次只移动一个边界并跑导出/API 回归，禁止顺手改行为。
