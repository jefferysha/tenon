# Design

以 `views.ts`、default workflow `tracks` 和构建后的 `index.html` 为三类真相源。历史截图与 research 文本先分类再决定 allowlist/迁移/豁免；正式截图只保留当前产品。资产 freshness 解析本地引用并检查 git 可发布清单。

## 卫生命中决策（2026-09-13）

- `.trellis/tasks/archive/09-09-dashboard-template-refactor/prototype/screens/*` 的 5 张图和 `.trellis/tasks/archive/09-12-workflow-ui-e2e/evidence/*` 的 3 张图均为历史审计证据，不属于 README/文档站正式资产；保留原位并在门禁中按固定归档路径豁免，避免把旧图误当当前产品截图。
- `docs/research/2026-09-12-runtime-artifact-code-findings.md` 是调查记录，出现产品身份是上下文事实；仅该固定文档允许保留产品名，其他受管理文本仍执行身份门禁。`.gitattributes` 中的注释不需要产品名，已保持通用措辞。
- Dashboard dist freshness 读取 `index.html` 的本地引用并检查文件存在，同时报告 `git ls-files --others` 发现的未跟踪生成资产；CI 中替代仅依赖 `git diff` 的 dist 检查。
- 四张正式 Dashboard 图已使用当前构建的两视图 UI 和脱敏演示项目重拍；由于受管浏览器固定为 1280×720，文档图片尺寸同步为 1280×720。`dashboard-automation.webp` 保留历史文件名以兼容外部链接，内容改为当前 Workbench 状态，不再描述退役的自动运行页。
