# 任务

## 立项

- [x] 创建新的 `dashboard-ui-reimplementation` Change，确认旧 Change 与已取消方案不再作为依赖。

## 调研

- [x] 盘点 App shell、导航、项目选择、Progress、AFK、Workbench、Machine、Host Plan 的现有入口和状态来源。
- [x] 盘点现有 API client、snapshot/SSE、脏态导航、i18n、testid 和浏览器验证边界。
- [ ] 用真实浏览器记录当前桌面/窄屏溢出、上下文缺失和关键动作可达性。

## 规格

- [ ] 定义 `task-command-context` 的投影字段、空态和跨页面恢复规则。
- [x] 定义 dashboard 状态字典、只读/可写标识、错误/离线/脏态反馈和响应式验收矩阵。
- [ ] 定义 Skill 依赖图与列表的节点/边、键盘交互和错误呈现契约。

## 实现

- [ ] 在 model/state 提取同源 command context 和状态标签。
- [ ] 重排 App shell、Projects、Progress、AFK，使当前 Change 和下一动作稳定可见。
- [ ] 重排 Workbench 为阶段脊 + inspector，保留全部已有写入口和 dirty/CAS 语义。
- [ ] 重做 Skill 依赖图的可读列表、键盘路径和窄屏布局。
- [ ] 统一 Machine/Host Plan 的页面层级、状态反馈和 i18n 文案。

## 验证

- [ ] 运行受影响组件测试、`npm run typecheck:web` 和 `npm run build:web`。
- [x] 真实浏览器检查当前构建的桌面 shell、主导航和 runtime artifact 路径；窄屏、多主题和网络失败矩阵继续由独立 UI 验收 Change 跟踪。
- [ ] 核对 UI 投影与 `status`、`check`、`workflow`、`tracks` 的终端输出一致。

## 交付

- [x] 记录 build_sha、verification_report、受影响文件和未验证项。
- [ ] 只提交本 Change 范围内的源码、测试、文案和必要文档。

## 归档

- [ ] 完成 applied-spec 和公共契约漂移审计后归档。
