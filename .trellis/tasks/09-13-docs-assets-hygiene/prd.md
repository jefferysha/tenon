# 收敛文档发布资产与仓库卫生门禁

## Goal
让文档、正式截图、design-scale、repository-hygiene 与 dashboard dist 都读取当前产品真相源。

## Requirements
- check-docs 从 `views.ts` 和 `tracks` workflow 校验。
- 修 ArtifactCatalogPanel design-scale 13 条失败。
- 审查 8 个历史截图 allowlist/迁移和 2 个外部身份命中，记录最终决策。
- 重拍四张正式 dashboard WebP。
- freshness 检查覆盖 index 引用、磁盘文件和未跟踪资产，并替换 diff-only 步骤。

## Acceptance criteria
- [ ] docs/design-scale/repository-hygiene 通过。
- [x] 四张截图与两视图 UI 一致。
- [ ] dist 缺失/未跟踪资产可被门禁发现。
