# 支持与国际化
依据：product-audit.md §2.4。
## 需求
- `tenon support bundle`：本地打包诊断（版本、doctor、runtime status、最近日志、配置摘要），自动脱敏（token、home 路径、邮箱），<5MB。
- Dashboard server 日志文件（轮转），`tenon logs` 查看。
- CLI 国际化：TENON_LANG=en|zh（默认跟随系统 locale），help 与错误信息；非法转换报错列出当前合法事件。
- Dashboard：index.html lang 跟随语言；taskCommands/blockerLabel 不再依赖中文服务端文本（改用错误码）；Playwright 里加 axe 可访问性检查（关键页零 serious/critical）。
## 验收
各项有测试；axe 在 CI 跑。
