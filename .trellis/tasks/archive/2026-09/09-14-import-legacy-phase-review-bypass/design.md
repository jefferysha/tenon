# 设计

导入 legacy 仅处理非保护字段；保护字段漂移时拒绝并保持 state/history/revision 零写入。CLI 与 server 共用 kernel 校验，避免入口分叉。
