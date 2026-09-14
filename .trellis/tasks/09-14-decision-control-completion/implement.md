# 实施计划

1. 并行实施：human gate 修复、自审批检测、Dashboard review 控制台。
2. 主线程逐项审查并合入，统一重建 CLI/server dist。
3. 串行实施 Change 回放与 artifact diff 数据面。
4. 串行实施 workflow dry-run 和流程体检。
5. 最后执行 npm 发布前检查；不发布外部包，除非另有明确授权。
