# 任务

## 立项

- [x] 写 proposal / design / tasks，记录 4 处问题的源码证据、范围与非目标。

## 调研

- [x] 核实各宿主 hook 输入里 `session_id` 的提供情况（PreToolUse / PostToolUse / UserPromptSubmit、子代理、会话恢复）。 (explore)
- [x] 定交互标记新格式、放行语整条匹配规则、撤销命令的语义与权限。 (explore)
- [x] 写设计文档与 ADR。 (explore)

## 规格

- [x] 写 `interaction-and-skill-provenance` 与 `plugin-runtime` 的 delta spec。 (spec)
- [x] 写实施计划（测试先行的顺序、验收命令、本地运行时重装步骤）。 (spec)
- [x] 登记测试计划（tools/test-hooks.sh 新用例、CLI 撤销命令单测）。 (spec)
- [x] 写 `step-test-waiver` 的 delta spec，并把步骤测试豁免写进提案、设计与实施计划（验证步发现 code-size 无豁免途径后加入）。 (spec)
- [x] 按第二轮验证评审结论更新三份 delta spec、提案、设计、ADR 与实施计划（Part D）。 (spec)
- [x] 写 `verify-round-limit` 的 delta spec，并把验证轮次上限与第三、四轮 gate 加固写进提案、设计、ADR 与实施计划（Part E、Part F）。 (spec)
- [x] 按就绪预审修正 `verify-round-limit` 措辞：上限「调到高于当前轮次」才恢复回退；从 verify 回规格写明两步路径；历史记下发现摘要；有链头时读不到链即报错。设计、提案同步。 (spec)

## 实现

- [x] 会话归属 helper，所有拦截与记证据的 hook（评审门、自动确认、技能顺序门、动画门、证据记录）改用它，改正 review-ack.sh 注释。 (build)
- [x] 交互标记带 Change 与会话，拦截与解锁只作用于归属会话，旧格式见到即删除。 (build)
- [x] 放行语只认整条短回复（prompt-intent.sh 与 confirm-clear.sh）。 (build)
- [x] 新增 `tenon review revoke` 命令（回到待确认）及测试。 (build)
- [x] `session activate --host-session` 一对一绑定与自动移交提示及测试。 (build)
- [x] 实验：本地目录市场的缓存行为、Codex 支持、`plugin list` 形态、宿主对账对 stable target 的依赖。 (build)
- [x] 源码开发安装 `tenon setup --<host> --from-source`（dev release 身份、自动拉取上游技能、防覆盖、`--to-stable`）及测试。 (build)
- [x] 源码仓库漂移检查（`tenon doctor` 的 `source:drift`、SessionStart 提示、Dashboard channel）及测试。 (build)
- [x] 步骤测试豁免 `tenon test waive --test <步骤测试>`：失败的必需步骤测试经评审批准后放行，待批准时随评审请求列出而不是要求重跑，读测试的评审者提示里带豁免与理由；文档与测试。 (build)
- [x] 补步骤测试豁免的两条回归用例：测试计划被篡改时豁免不生效；理由含换行时评审者提示折成单行（实施计划 Part C Step 7）。 (build)
- [x] 验证评审修复（hook）：交互标记按会话分文件；agent 不能自己执行手动 `tenon review acknowledge`（只放行 `--delegated` 与 `review request`）；gate 评审分支统一用 `pipeline_hook_session_id`；漂移提示的仓库路径遇控制字符不输出、命令里加引号。 (build)
- [x] 验证评审修复（kernel / CLI）：步骤测试豁免的批准绑定到被批准的代码候选；豁免判定拆出 `evaluate-v2.ts`、`statusStepNext.ts` 留出余量；评审者提示与 `test-waived` 提示里的豁免理由标注为执行者自述并截短；Dashboard 快照带豁免状态；`review revoke` 一并撤回豁免批准（主线决定推迟，未做，见验证报告）。 (build)
- [x] 验证评审修复（CLI 小项）：`session activate` 先写本会话绑定再移交、在锁内完成；上游技能 id 校验；安装通道标记写失败时清理临时文件。 (build)
- [x] 第三轮验证评审修复：gate 拒绝手动 acknowledge 的预筛改为对去引号、去反斜杠后的命令判定（词中拆分不再绕过）；五处文档补写 `--from-source` 的已知风险。 (build)
- [x] 验证轮次上限：工作流步骤 `max_rounds` 的解析、校验、编译与计划冻结，`default` 工作流 verify 步声明 2；`tenon set … max_rounds` 任务覆盖；按进入次数计轮次、回规格清零；用完后 `next` 不再给回退、回退边的评审请求与转换拒绝；剩余阻断 `reviewer:<agent>` 的冻结、人工接受与候选绑定；`status --json` 的轮次字段；Dashboard 解码器保留该键；文档、宪法与 tenon 技能的处置说明；测试。 (build)
- [x] 就绪预审加固：回规格出路按计划写明两步路径（CLI 与 Dashboard 拒绝文案同改）；发现摘要去掉控制字符与双向字符、历史行带摘要；有链头缺读取依赖时报错；Dashboard 读不出冻结清单时拒绝；「删标记、重跑不清零」集成测试。 (build)
- [x] oracle 夹具 `default-effects` 适配验证轮次上限：把「提交后验证被屏障拒绝」挪到第 1 轮，两轮走完 A–F 六个场景（验证轮次上限第 1 轮发现，用户决定调高到 2 修复）。 (build)
- [x] 本任务设 `max_rounds 1`（用户决定「这轮修完就停」），确认 `status --json` 显示当前轮次与上限。 (build)
- [x] 第四轮验证评审修复：手动 acknowledge 判定拆到 `hooks/lib/` 按需加载；`--delegated` 只认未被带空白的引号包住的词；`review` 与子命令之间夹带值选项不再断链；花括号步长写法失败关闭、补常见包装器。 (build)

## 验证

- [x] tools/test-hooks.sh 与相关 vitest 全过，两会话场景手工复现不再互锁。 (verify)

## 交付

- [x] 提交交付物，并用 `tenon setup --claude --from-source .` 把本机切到源码开发安装。 (ship)
- [x] 处理已污染状态：给 setup-host-agents-step-progress 的历史追加更正事件，撤销它误记的规格批准。 (ship)

## 完结

- [ ] 归档变更；之后恢复 unify-stage-skill-canvas 并补加载调研技能。 (archive)
