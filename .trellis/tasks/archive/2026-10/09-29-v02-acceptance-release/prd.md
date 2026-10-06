# 真实宿主验收与发布

## 需求
- R1 验收脚本化场景（跨子任务验收）在 Claude Code 与 Codex 各跑一遍，记录到 docs/acceptance/2026-10-v0.2-<host>.md（命令、截图、记录路径、问题清单）。
- R2 两个身份协作一次（接手、评审、归档）。
- R3 通过后备份并删除 1.x Release 与标签（先导出资产与说明到本地归档目录），再把 F2 的文档改回「已删除」。
- R4 docs 截图重拍（dashboard 各页 webp）。
- R5 Trellis 账面：关闭已完成任务，合并宿主验收到本任务，归档。
- R6 发布 v0.2.0（完整门禁链、clean-install、release-candidate、public acceptance、更新本机宿主）。
- R7 默认工作流 verify 的必需测试 `tenon test code-size --json` 依赖 PATH 上的 tenon：在 AFK 沙箱、CI、临时 HOME 下核实可用；不可用时改走稳定 launcher 或由 doctor 检查（agent-registry 报告的风险）。
- R8 宿主真实加载 `tenon-<name>` 子代理（Claude Code .claude/agents、Codex .codex/agents TOML 字段）验证。
