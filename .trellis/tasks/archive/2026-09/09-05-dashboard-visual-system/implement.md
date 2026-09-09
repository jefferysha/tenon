# 视觉系统与组件实施

1. 搜索现有 CSS、Tailwind/theme 和组件样式，建立 token 对照表并替换散落值。
2. 先落地共用 Button/Select/Card/Drawer/Dialog/feedback 状态，再逐页调整布局密度。
3. 重构 Progress/Workbench 画布呈现和移动断点，确保 IA 子任务的页面职责不被重新膨胀。
4. 增加关键状态测试和 375/768/1440 浏览器检查，最后清理重复 key、焦点/aria 和 reduced-motion 问题。

避免引入第二套 token 或重复组件；所有视觉改动在同一主题和语言切换下验证。
