# 模板重构原型

M0 视觉对齐门的产物。四页：

- **工作台** —— 按用户提供的模板 1:1 复刻，是本任务的还原度基准。
- **阶段 / 自动化 / 机器** —— 模板未覆盖，按同一套 token 与版式语汇新设计。

打开方式：直接用浏览器打开 `index.html`，顶部四个标签切换页面。

`styles.css` 的 `:root` 即 design.md §2 的 token 表，改这里等于改设计规范；
React 实现阶段把同一批值搬进 `packages/dashboard-app/src/index.css` 的 `@theme`。
