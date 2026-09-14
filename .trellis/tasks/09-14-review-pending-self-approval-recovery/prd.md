# S：恢复并实现 pending review 自审批检测

依赖 P 的事件名、channel、路径和 observation 契约。恢复历史完整 PRD，补 design/implement/check；在 pending review 期间精确匹配 token 文件读取与 localhost 写端点，写入脱敏 append-only observation，不改变 canonical approval。必须记录稳定的 process/host hash，不写 token、原始命令或原始身份；补 hook、CLI、跨层测试。
