# 提案

## Why

同一个项目里同时开着多个会话（同一用户、不同 Change）时，Tenon hook 会让它们互相干扰，2026-10-07 实际发生：

- 会话 A（`setup-host-agents-step-progress`）在规格步请求评审后，会话 B（`unify-stage-skill-canvas`）的 Bash / Edit / Skill / Agent 全被 `gate.sh` 拦截，只剩只读工具，连它派出的原型子代理也停工。
- 根因：评审标记的归属判定（`hooks/gate.sh:390-404`）和对话里的自动确认（`hooks/review-ack.sh:102-117`）都读 `.tenon/users/<slug>/local/active-change`。这个指针按用户共享、不分会话，谁最后 `tenon session activate` 就指向谁；`review-ack.sh:82` 的注释却把它写成「per-session」。因此会话 B 里一句「可以」就会替会话 A 写下评审回执。
- `.pipeline-pending-interaction` 只记技能名、全项目共用：任一会话加载 brainstorming 会锁住所有会话，任一会话的 AskUserQuestion（`confirm-clear.sh:43-44`）或放行语都能解锁它。
- `prompt-intent.sh:358` 用子串匹配 `*确认继续*` 等放行语：用户粘贴的文字里含这几个字就被当成确认，会话 A 的规格评审已因此被误记为通过。
- 评审回执一旦写成 approved，若该步只有一条出边，就没有正规撤销入口（`tenon review request` 在 `review.ts:216` 拒绝重复请求），误记无法纠正。

- 在 Tenon 源码仓库里干活时，加载的技能、hook、CLI 全是已安装的发布版，不是仓库源码：本机插件来自 GitHub `jefferysha/tenon@v0.3.2`，运行时来自 release payload，且没有任何从本地源码安装的方式（`install.sh` 写死标签，`tenon setup/update` 只认稳定标签）。上游技能（约 57 个）不进 git、按 `skills/sources.yaml` 的 default-branch 浮动拉取，已装版与仓库工作区版各是一次不同时刻的快照，2026-10-07 实测有 12 个技能不一致（如 domain-modeling 一份要求 `GLOSSARY.md`、一份要求 `CONTEXT.md`），导致 agent 照发布版做了与仓库约定冲突的事。用户明确要求：在 Tenon 源码仓库里必须全部使用仓库源码里的技能。

- 验证步发现（2026-10-08）：default 工作流验证步的必需步骤测试 `code-size`（新增行数上限 2000）失败后，没有任何豁免途径。
  - `tenon test waive` 只能豁免策略要求的测试种类或追溯条目，对冻结工作流里的步骤测试无效。
  - 失败后 `next` 永远是 `run-test`，任务到不了评审门，用户决定的「本任务豁免、写明理由」无法落地。
  - 同时代码规模把未跟踪、也未被忽略的本机 `.claude/`（Trellis 本地 hook 与技能）算进了新增行。

这些都是评审门、人工确认这类安全边界上的错误，以及开发自身时用错版本的问题，必须在继续多会话并行开发前修好。

## What Changes

1. 统一「本会话任务」解析并让所有拦截与记证据的 hook 改用它（调研阶段确认的范围）：优先用 hook 输入的 `session_id` 读 `.pipeline/terminal-sessions/<id>.json`（复用 `host-session-binding.sh`）。本会话有绑定 → 只认绑定的 Change；没有绑定、而共享指针指向的 Change 已绑到别的会话 → 既不拦截、不代为确认、也不记证据；宿主不提供会话 id（或该 Change 无人绑定）时才退回读共享指针。覆盖评审门、自动确认、技能顺序门、动画门与技能 / 决策 / 测试提醒的证据记录（实测：会话 B 的技能加载被记进了会话 A 的任务）；恢复候选（router / breadcrumb）不变。改正 `review-ack.sh:82` 的注释。
2. 交互标记带归属：标记写入 Change 与会话 id；`gate.sh` 只拦归属会话，`confirm-clear.sh`（AskUserQuestion）与 `confirm-clear-prompt.sh`（放行语）只解本会话的标记；旧格式标记见到即删除。
   - 宿主给了会话 id 时，标记按会话分文件 `.pipeline-pending-interaction.<会话>`，避免两个会话同时等回答时后写覆盖先写。验证步评审发现，用户确认。
   - 没给会话 id 时仍用单个文件。
3. 放行语只认整条短回复：显式放行语（确认继续、继续执行等）不再做子串匹配，只在整条回复（去掉首尾空白与标点）是放行语时成立；引用、粘贴的长文本中出现放行语不触发确认。AskUserQuestion 的答案判定同样收紧。
4. 新增评审回执撤销命令 `tenon review revoke <change> --reason <原因>`：把当前步已批准但未被 transition 消费的回执撤回为同一 event 的「待确认」并恢复评审标记，留审计记录；agent 可执行。
5. 一个 Change 只绑一个会话：`session activate --host-session` 自动移交并提示旧会话 id。
6. 处理已被污染的状态：给 `setup-host-agents-step-progress` 的历史追加更正事件；撤销它误记的规格批准；`unify-stage-skill-canvas` 恢复后补加载调研技能。
7. 源码开发安装模式（用户确认）：新增 `tenon setup --claude|--codex --from-source <仓库>`，从仓库工作区构建并安装插件与托管运行时，记录 commit、工作区摘要与技能索引摘要，不冒充版本标签；正式安装仍只认稳定标签。初始化时（即执行源码开发安装）若缺上游技能或本机拉取索引，自动按 `sources.yaml` 拉取并写索引；技能正文与索引都不进仓库（用户确认），两次初始化之间不自动重拉。
   - 命令行为：支持 `--dry-run`（只打印计划）与 `--skip-build`；宿主还有未完成的旧插件迁移收敛回执时拒绝。
   - 开发版标识：`/api/health` 报告 `channel: dev`、短 commit 与 `<version>+dev.<sha7>`，`tenon doctor` 的 `identity:release` 对开发安装给出黄色。
   - 已知风险（用户确认接受）：它会执行所给仓库的构建，并把其 hooks 与技能长期装进宿主，属开发者显式命令，只在文档写明。
8. 源码仓库漂移检查：在 Tenon 源码仓库里开会话时，比较已装插件 / 运行时与仓库工作区，不一致就在会话开始时报警并给出同步命令；不阻断会话。
   - 判据是安装内容摘要与技能索引摘要。commit 只展示，只提交文档不提示。
   - 提示里的仓库路径加引号，含控制字符时不提示。
9. 领域术语并入仓库既有的 `CONTEXT.md`（不新建 `GLOSSARY.md`）。
10. 测试补在 `tools/test-hooks.sh`（及 CLI 命令的单测）：两个会话分别绑定不同 Change，只有拥有者被拦、被确认；粘贴文本里的放行语不触发确认；撤销命令的正反用例。
11. 修好后用新的源码开发安装把本机切到仓库源码，让 hook、CLI、技能都用上新代码。
12. 步骤测试豁免（验证步加入，用户确认）：新增 `tenon test waive <change> --test <步骤测试> --reason <理由>`，与种类豁免同一机制。
    - 豁免登记进测试计划（键 `test:<id>`），评审请求时列给用户，用户确认这道门时一并批准；批准前不放行。
    - 只覆盖在当前候选上新鲜的失败记录，未运行、运行中、过期照旧阻塞。
    - 带豁免的失败不再让 `next` 卡在 `run-test`，读测试的评审者提示里写明豁免状态与理由。
13. `.gitignore` 忽略本机 `.claude/`，与已忽略的 `.agents/`、`.codex/` 同类，不再计入代码规模，也不会被交付提交带入。
14. 步骤测试豁免的加固（验证步评审发现，用户确认）：
    - 批准绑定被批准时那条失败记录的代码候选，代码变了再失败要重新批准。
    - 豁免理由在评审者提示与提示文案里标注为登记者自述、截短、去掉能伪造结构的字符。
    - Dashboard 测试快照带豁免状态。
15. agent 不能自己执行手动评审确认（验证步评审发现，用户确认）。
    - 手动 `tenon review acknowledge` 会批准冻结的豁免与受保护改动；gate 改为任何时候都拒绝 agent 执行它，只放行 `--delegated` 与 `review request`。
    - 确认只经三条路：用户回复放行语由 hook 写入；Dashboard；没有该 hook 的宿主由用户本人在终端运行。
    - 工作流宪法与各适配器说明同步改写。
    - 第三、四轮验证评审后加固（用户确认回退修复）：判定移到 `hooks/lib/ack-command.sh`，命中预筛才加载，库缺失时失败关闭；判定前先还原引号、反斜杠、转义编码与花括号展开，`--delegated` 只认不在含空白引号串里的词，带值选项夹在 `review` 与子命令之间不再漏判；判定读取上限 64 KiB，超过上限只做字面检查；五处文档补写 `--from-source` 的已知风险。
16. 测试环境隔离（验证中发现的测试泄漏修复）：
    - 测试与验收辅助代码不再把启动器导出的本机运行时根（`TENON_RUNTIME_ROOTS`、`TENON_RUNTIME_*_ROOT`）与插件根（`PLUGIN_ROOT` 等）传给子进程，避免测试写进用户真实的项目登记表、或跑到已装插件。
    - 范围：`tools/lib/runtime-roots.mjs` 及各隔离夹具、shell 套件开头的 unset、action 自测（`verify-action-selftest`）的守卫测试。
17. 验证轮次上限（第四轮验证后用户提出并决定并入本任务）：本任务连续多轮验证，每轮评审者都挑出新问题，build ⇄ verify 没有任何上限，会无休止回退。原有的评审次数预算（`review_budget`）已于 2026-09-17 随评审车道一起删除。
    - 工作流步骤可声明 `max_rounds`（1–20）；内置 `default` 工作流的 verify 步声明 2；没声明的步骤与旧计划按内置默认 2；任务可用 `tenon set <change> max_rounds <N>` 覆盖。
    - 轮次按进入该步的次数计，回到规格步（`requirements-changed`）后重新计数。
    - 上限用完且必需证据不通过时不再自动回退：`next` 改为请求用户接受剩余阻断，并说明调高上限、回到规格、终止三条出路；回退边的评审请求与转换被拒。
    - 剩余阻断（不通过的必需评审者）由用户在前进边评审门确认接受，绑定当前候选与评审者运行，委托确认不能接受。
    - 从 verify 回到规格没有直达的边，出路文案写明两步路径（用户调高上限、`verify-fail` 回实现、再 `requirements-changed`）。

非目标：不改 canonical 评审回执的数据结构与 transition 校验；不改按用户隔离的 active-change 指针本身（它仍是恢复候选）；不改 Dashboard 的页面结构（只在健康信息里标出开发版、在测试状态词里加「已豁免 / 待批准」）；`review revoke` 不撤回已写入的豁免批准（验证步评审提出，推迟到后续任务）；Dashboard 工作流编辑器里编辑 `max_rounds` 的控件（本次只保证读写不丢）；清理已过期的主规格 `review-attempt-budget`；gate 自审批候选提取与 `hooks/lib/protected-writes.sh` 对超长密集命令的平方级耗时（HEAD 既有，后续任务）；不把上游技能正文或拉取索引提交进仓库；不改正式发布与正式安装的标签约束。

可验证结果：上述测试全绿；在两个并行会话里复现 2026-10-07 的场景不再互锁、不再越权确认。

## Capabilities

### New Capabilities

- `step-test-waiver`：失败的必需步骤测试经评审批准的计划豁免放行，批准绑定被批准的代码候选；`tenon test waive --test` 登记与校验；步骤编排把带豁免的失败导向评审；读测试的评审者看到豁免状态与标注为自述的理由。
- `verify-round-limit`：工作流步骤声明验证轮次上限（默认 2，任务可覆盖），按进入次数计、回到规格重新计数；用完后停止自动回退，由用户接受剩余阻断或另选出路。

### Modified Capabilities

- `interaction-and-skill-provenance`：放行语分类（整条短回复）、待处理交互的拦截与解锁按会话归属（按会话分文件）、评审确认只作用于本会话的 Change、新增回执撤销、一个 Change 只绑一个会话、agent 不能自己执行手动评审确认。
- `plugin-runtime`：新增源码开发安装模式（含 `--dry-run`、`--skip-build`、开发版标识与已知风险）与源码仓库漂移检查（判据为安装内容与技能索引）；「Managed release source SHALL 绑定稳定标签版本」加开发模式例外。

## Impact

- 代码：`hooks/active-change.sh`、`hooks/gate.sh`、`hooks/review-ack.sh`、`hooks/confirm-clear.sh`、`hooks/confirm-clear-prompt.sh`、`hooks/interactive-skill-gate.sh`、`hooks/skill-tracker.sh`、`hooks/skill-start.sh`、`hooks/codex-skill-receipt.sh`、`hooks/decision-recorder.sh`、`hooks/test-nudge.sh`、`hooks/prompt-intent.sh`、`hooks/host-session-binding.sh`（复用）、`packages/cli/src/commands/review*.ts` 与 `program-review.ts`、`tools/test-hooks.sh` 及 CLI 测试。
- 契约：交互标记文件格式升级为 v2（旧格式见到即删除），按会话分文件；新增 CLI 子命令；hook 输入多依赖 `session_id` 字段（缺失时回退旧行为）；agent 执行的手动 `tenon review acknowledge` 被 gate 拒绝（各宿主适配器说明、`templates/workflow.md`、`adapters/contract.md` 同步）；测试计划的步骤测试豁免多一个被批准候选字段。
- 兼容：不提供会话 id 的宿主行为不变；纯 bash 热路径约束（不 spawn 解释器）保持。
- 安装链路：`packages/cli/src/program-install.ts` 及 setup / update 事务、release source 记录、`hooks/session-start.sh`、`tenon doctor`、`docs/DIST-RELEASE.md`、`docs/usage/contributor-development.md`、`.agent-rules/COMMON.md`（规则：Tenon 源码仓库内只用源码安装）。具体文件以实施计划为准。
- 运维：本机从 GitHub 发布版切到源码开发安装；可用 `tenon runtime repair --rollback` 或重新正式安装回退。
- 步骤测试豁免：
  - kernel：测试计划模型与解码（`test-system/plan.ts`）、冻结豁免清单（`review-waivers.ts`）、策略判定（`evaluate-v2.ts`）、测试证据项（`test-evidence/evaluate.ts`）。
  - CLI：`test waive` / `unregister` / `test plan`，`next` 编排、评审者就绪与结论字段核对、评审者提示。
  - server / Dashboard：只同步测试状态 DTO 与解码器的新取值，不改页面。
  - 文档：`cli-reference`、`default-workflow`，中英两份。
  - 契约：测试计划豁免多一种 `test` 键（旧计划照常解析）。
- 验证轮次上限：
  - 工作流：`templates/workflows/default.yaml` 五条轨道的 verify 步与生成的内置副本；kernel 工作流解析、校验、序列化、编译与 effective plan 指纹 / 快照（新键改变计划形状）。
  - 状态：`FIELD_ORDER` 末尾追加 `max_rounds`；轮次计数读 canonical 转换记录链。
  - CLI：`next` 编排（`statusStepExits.ts` 等）、`review request` / `transition` 的回退拒绝、剩余阻断的冻结与批准、`status --json` 的轮次字段、文案与帮助。
  - server / Dashboard：工作流定义解码器与写回保留 `max_rounds`。
  - 文档：`cli-reference`、`default-workflow` 中英两份，`templates/workflow.md`，tenon 技能的上限用完处置说明。
