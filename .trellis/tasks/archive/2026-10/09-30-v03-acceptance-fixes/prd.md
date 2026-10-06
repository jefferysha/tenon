# 验收问题修复
依据：../09-30-v03-production/acceptance-claude-code.md（F1–F19）与 product-audit.md §1 / §5 P2。
## 需求
- F11 code-size 阈值（2000 行）进入冻结计划并真正判定；文档与实现一致。
- F1 Dashboard 智能体详情 references 为空、DELETE 能删被引用的智能体：与 CLI `agent rm` 一致地拒绝并列出引用（含项目级工作流）。
- F4 等待交互 marker 阻塞正在运行的执行者子代理（含写自己的报告）：子代理运行期间豁免或按子代理身份放行。
- F7 design-system 任务归档时提交 DESIGN.md / design/；后续任务 code-size 不计入。
- F10 `tenon test catalog add --report-format exit-code` 可用。
- F5 研究者按裸名加载 deep-research 被宿主拒：技能引用解析到插件内全名。
- F9 产物归属到正确套件；F12 见 standard-lane；F13 见 test-flow-lite；F14 交付提交不包含 .pipeline-owned.json 与运行记录（或按设计明确并文档化）、归档后清理空 .claude/；F15 非负责人看到负责人的测试状态（按负责人记录展示并标注）；F16 明确谁能确认评审（负责人或授权者），非负责人确认被拒或需显式 --as；F17 doctor 检查 PATH 上 tenon 并让测试环境前置运行中的 launcher；F18 服务就绪探测失败给出原因（状态码/超时/日志尾部）；F2、F19 按记录处理。
- 产品评估 P2：`(unknown)` 显示为「未报告文件」；技能页引用改读编排接口（含 OpenSpec 注入与 manifest 叠加）；一个波次计算器；TrackDialog 用 FormDialog；agent validate 拒绝占位符并按宿主校验工具名；任务 delete/archive 也清理宿主智能体文件；生成的 .claude/agents/tenon-* 与 test-results/ 加入忽略；运行记录保留上限清理；Codex 智能体「工具白名单」措辞修正；.codex-plugin defaultPrompt 更新；`tenon update` 时刷新 Codex 受管块（提示或自动）。
## 验收
每条有测试或门禁证明；验收记录中的复现步骤不再复现。
