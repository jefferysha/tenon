# 执行清单（精简重做）

- [x] 服务端只读接口 `GET /api/documents/read?root&path`（readTrustedFile，256KB，UTF-8，5 用例）
- [x] 顶部条只剩 工作台 / 工作流；afk / machine / hostPlan / advanced / verification / taskPlan 目录删除
- [x] 工作台右列 = 阶段轨 + 所选阶段 输入 / 输出 文件 + 变更文档 + 点击即读预览；无其他 sheet
- [x] 工作流右列 = 技能（串行 / 并行切换、增删）/ 门禁 / 推导输入输出，无页签；轨道只在左列副行展示
- [x] 删除工作流页的轨道面板、管线预览、策略 / 运行时 / 钩子 / 治理、执行指令、hook 开关、技能编排 Dialog
- [x] i18n 清掉 15 个无人引用的命名空间；测试迁移；typecheck / test:web / design-scale / comment-honesty 全绿
- [x] 真实服务端（:18790）验证读文件；1440 截图
- [x] 工作流页浏览器验收（:18790）；375 视口无横向滚动；spec 已更新
