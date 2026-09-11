# PRD · 整页滚动修复 + 去掉顶部搜索框

## 问题
1. 工作流页出现整页滚动：`TwoColumns` 网格高度固定但隐式行按内容撑高（右栏 section 没有 overflow），html 高出视口 136px。
2. 顶部搜索框没有用途（各视图有自己的过滤 / 搜索），删除；连带删除全局 query 上下文与 `/` 快捷键。

## 目标
- `TwoColumns` 加 `grid-rows-[minmax(0,1fr)]`，右栏 section 加 `overflow-hidden`；document.scrollHeight = innerHeight。
- TopBar 无搜索框；`GlobalSearch.tsx` 只保留 `matchesQuery`；WorkflowNav 去掉 `query` 属性；WorkspaceView 只用自己的任务搜索。

## 验收
- [ ] 工作流页 `documentElement.scrollHeight === innerHeight`（Playwright 目检）。
- [ ] 无 `global-search` testid；i18n 无 `shell.search_*`；web 用例、design-scale、comments、build 通过。
