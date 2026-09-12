# 后端真实运行验证设计

验证链路为：已构建 server 启动 → 注册临时项目 → CLI init 创建 change → CLI status/check/advance 执行 → HTTP 查询任务与 artifact catalog → 保存证据 → 删除临时项目并停止服务。

服务固定监听本机临时端口，所有请求带项目 root 参数并使用现有 dashboard token。运行使用一个可通过治理门禁的 free workflow，同时保留 default/chat 的真实门禁结果作为对照。证据只写入当前 Trellis task archive。
