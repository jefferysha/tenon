# 实施计划

1. 发布准备（完成于 `release: prepare v1.1.0`）：版本号、发布说明、依赖漏洞、hygiene；重建 dist；本地发布门禁。
2. 推送 `main`，等待 CI push 成功；失败则修复后重推。
3. 派发 release-candidate（ref=main SHA，tag=v1.1.0），跟踪 writer / release / public acceptance 至成功。
4. 本机官方安装：`install.sh --claude`、`install.sh --codex`；`tenon runtime status`、`tenon doctor`、Dashboard 健康。
5. 自定义 workflow E2E（Claude Code）：
   - Playwright 打开 Dashboard → 新建工作流 → 新建多个轨道 → 每个阶段配置技能与门禁 → 保存。
   - 沙箱项目 `tenon init --workflow <name> --track <track>` 创建 change。
   - `claude -p` 驱动逐阶段真实执行；每阶段核对技能调用、产出、transition 与 Dashboard 状态。
   - 至少覆盖两个轨道各自的分支。
6. default workflow E2E（Claude Code）：两个真实任务（功能开发、缺陷修复），走完阶段与评审门禁（含 Dashboard 批准一次、终端批准一次）。
7. Codex E2E：一个真实受治理任务的多阶段执行。
8. 修复发现的问题（补测试、门禁），必要时发布 `v1.1.1` 并复装复验。
9. 证据写入 `research/`，勾选验收，归档任务。

## 验证命令

本地发布门禁（每次发布前）：`npm run build` + dist diff、`check:dependencies`、`check:release-workflows`、`check:openspec`、`check:comments`、`check:architecture`、`check:identity`、`check:repository-hygiene`、`check:legacy-bridge`、`check:default-workflow-freshness`、`check:docs`、`check:document-templates`、`check:design-scale`、`typecheck:web`、`test:web`、`tools/test-hooks.sh`、`tools/test-adapters.sh`、`tools/verify-skills.sh`、`test:migration-cas`、docs 站点四步、`npm test`。
