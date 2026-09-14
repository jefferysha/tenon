# F1 设计

以现有 server application 层为唯一写入编排边界：GET 与 POST 共享投影输入构造；POST 在 lock 前完成所有可抛出的 interaction 编码。import-legacy 只允许导入非受保护字段，受保护字段与 canonical 不一致时拒绝，避免 yaml 投影成为 phase/review 的第二写入口。字段顺序以 `FIELD_ORDER` 末尾追加保持窄解析器兼容。
