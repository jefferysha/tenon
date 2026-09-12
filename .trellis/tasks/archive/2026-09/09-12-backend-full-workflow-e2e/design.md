# 验证设计

测试项目包含一个可运行的 Node 后端样例和最小 API 变更。workflow 使用内建 backend track；每一阶段执行对应仓库 skill 指令并将结果写入 openspec change。CLI transition/check/advance 负责真实门禁，server API 负责读取 snapshot、skill runs 与 artifact catalog。
