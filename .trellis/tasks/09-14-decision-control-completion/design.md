# 技术设计

安全检测、门禁修复、Dashboard 控制、回放和 diff 分为独立子任务。共享 review application 继续作为唯一写入用例；Dashboard 只负责输入校验、调用 adapter 和刷新 projection。自审批信号属于 append-only observation，不改变 canonical approval 结果。回放和 diff 只读 canonical state、TransitionRecord、interaction 与 artifact revision，不新增第二套真相源。

工作顺序：安全门与检测可并行；Dashboard UI 依赖现有 HTTP adapter，可并行；回放/diff 在三项基础任务合入后串行；试运行、流程体检和 npm 发布最后处理。
