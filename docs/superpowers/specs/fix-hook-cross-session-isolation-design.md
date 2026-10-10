# 技术设计

## 背景

同一项目里同一用户并行多个会话、各做一个 Change 时，hook 用来判断「当前任务」的依据是 `.tenon/users/<slug>/local/active-change`。这个指针按用户共享，谁最后执行 `tenon session activate` 就指向谁。2026-10-07 的实测后果：

| 现象 | 位置 | 证据 |
| --- | --- | --- |
| 会话 A 的评审标记把会话 B 的 Bash / Edit / Skill / Agent 全部拦下 | `hooks/gate.sh:390-404` | B 的指针被 A 改写成 `setup-host-agents-step-progress` |
| 会话 B 回一句放行语就会替 A 写评审回执 | `hooks/review-ack.sh:102-117`、`confirm-clear*.sh` | 同上；注释 `review-ack.sh:82` 误称指针「per-session」 |
| 交互标记全项目共用，任一会话加载交互技能锁住所有会话，任一会话的提问都能解锁 | `interactive-skill-gate.sh:154`、`confirm-clear.sh:43-44` | 标记内容只有技能名 |
| 技能顺序门查错任务，技能证据记到别的任务 | `gate.sh` 的 skill / motion 门、`skill-tracker.sh` 等 | B 在 10:02 加载的 openspec-explore / brainstorming 记进了 A 的 `.pipeline-history.jsonl` 第 19-24 行，B 自己的历史里没有；门禁要求 B 先加载 A 所在后端轨道的 openspec-explore |
| 粘贴文字里含「确认继续」就被当成确认 | `prompt-intent.sh:358` 子串匹配 | A 的规格评审因此被误记为通过 |
| 误记的 approved 回执无法正规撤销 | `packages/cli/src/commands/review.ts:216` 拒绝重复 request | — |

每个会话其实已有精确绑定：`tenon session activate <c> --host-session <id>` 写 `.pipeline/terminal-sessions/<id>.json`，解析函数也已存在（`hooks/host-session-binding.sh:15` `pipeline_host_session_change_name`），只是拦截与记证据的 hook 都没用它。

宿主事实（调研报告 `.pipeline-agent-reports/4c0719b0….md`）：Claude Code 所有 hook 事件都带 `session_id`；子代理内的 hook 另带 `agent_id`；官方不保证 resume / clear / fork 后 `session_id` 不变（本对话已从 4f9542da… 变为 d4b6f501…）；Codex 明确子代理沿用父会话 id。

## 决策

### 1. 统一的「本会话任务」解析

在 `hooks/active-change.sh` 新增 `pipeline_session_change_dir <root> <session_id>`（纯 bash，复用 `host-session-binding.sh`），按顺序：

1. `session_id` 合法且有本会话绑定 → 返回绑定的 Change。
2. `session_id` 合法、没有本会话绑定，而共享指针指向的 Change 已被**别的**会话绑定 → 返回「无」（不是本会话的任务）。
3. 其余情况（宿主没给 `session_id`；或指针指向的 Change 没有任何会话绑定，例如未带 `--host-session` 激活）→ 返回共享指针（旧行为；用户确认）。

**一个 Change 只绑一个会话**（用户确认）：`tenon session activate <c> --host-session <id>` 写本会话绑定时，删除其他会话对同一 Change 的绑定，并在 stderr 写明「已从会话 <旧 id> 移交」（自动移交，用户确认）。一个会话本来就只有一个绑定文件，所以绑定是一对一的。被移交的旧会话落入规则 2。

所有**拦截与记证据**的 hook 改用它，并从各自的 hook 输入取 `session_id` 传入：`gate.sh`（评审门、技能顺序门、动画门）、`review-ack.sh`、`confirm-clear.sh`、`confirm-clear-prompt.sh`、`interactive-skill-gate.sh`、`skill-tracker.sh`、`skill-start.sh`、`codex-skill-receipt.sh`、`decision-recorder.sh`、`test-nudge.sh`。只做**恢复候选**的 `router.sh`、`breadcrumb.sh` 不变。`pipeline_active_change_dir` 保留给恢复候选使用；改正 `review-ack.sh:82` 的注释。

会话恢复后 id 改变时落入规则 2：不拦截、不代为确认、证据不记到别处，直到入口技能用新 id 重新 activate。这是有意的取舍：拦截只是体验层，离开评审步仍要 canonical 回执（transition 校验不变）；确认与记证据则宁可不做也不做错。

### 2. 交互标记带归属

`.pipeline-pending-interaction` 改为 v2：

```
pipeline-interaction-v2
change=<本会话任务，可空>
session=<session_id，可空>
skills=<技能显示名>
requested_at=<UTC ISO>
```

- 归属判定：`session` 非空 → 只属于该会话；`session` 为空但 `change` 非空 → 属于解析结果为该 Change 的会话；两者皆空 → 属于全部会话（宿主不给 id 时的旧行为）。
- `gate.sh` 只对归属会话拦截；子代理豁免（`agent_id`）保持不变。
- `confirm-clear.sh`（AskUserQuestion）与 `confirm-clear-prompt.sh`（放行语）只解本会话的标记，`InteractionConfirmed` 只记到本会话任务。
- 旧格式（首行不是协议名）见到即删除、不拦截，与现有 v1 评审标记的处理一致（用户已确认）。
- 按会话分文件（验证步评审后加入，用户确认）：宿主给了合法会话 id 时，标记写在 `.pipeline-pending-interaction.<会话>`，两个会话同时等回答时互不覆盖；没给会话 id 时仍写单个文件。一个会话判拦截时同时看自己的文件与单个文件；工作区指纹、交付提交的排除与 `advance` 硬门把两种文件同等对待。
- `.pipeline-pending-confirm` 当前代码里没有写入方，只保留读与清的兼容，不扩展格式。

### 3. 放行语只认整条短回复（用户已确认）

- `prompt-intent.sh` 的显式放行分支从子串匹配改为整条匹配：去掉首尾空白与句末标点（。！!.，,～~ 与空格）后，整条回复必须正好等于放行语清单中的一项（含现有的「继续，按你的推荐」等组合）。任何更长的文字、引用、粘贴都不构成确认。拒绝、附条件的判定保持不变。
- `confirm-clear.sh` 对 AskUserQuestion 只看答案值：去掉「 (Recommended)」「（推荐）」后缀后整值匹配，不再在整段 `tool_response` 里找子串。

### 4. 评审回执撤销命令（用户已确认：agent 可执行、必须写原因）

`tenon review revoke <change> --reason <原因>`：

- 在 canonical 锁内执行，只作用于当前步 `approved` 且尚未被 transition 消费的回执；把它撤回为同一 event 的「待确认」，并重写 v2 评审标记，门重新拦住，等用户确认或打回（用户确认）。
- 已被消费、本来就待确认、或没有回执时拒绝（exit 1，说明原因）。
- 写审计事件 `review.revoked`（actor、原因、被撤回执的标识与事件），同步 `.pipeline.yaml` 投影。
- 撤销只会让状态更保守，不需要人在场证明。

### 模块与接缝

现在的问题之一是同一判断散在多个 hook 里：放行语清单在 `prompt-intent.sh` 与 `confirm-clear.sh` 各写一份，会话 id 的校验在两个 hook 里各写一遍，标记读写各自解析。修复只引入 3 个模块，每个只暴露一个小接口：

| 模块（文件） | 接口 | 隐藏的行为 | 调用方 |
| --- | --- | --- | --- |
| `pipeline_session_change_dir`（`active-change.sh`） | 输入项目根、会话 id；输出本会话任务目录，或「无」 | 绑定文件的校验与大小上限、他会话绑定扫描、恢复候选回退、已归档 / 已隐藏任务排除 | 10 个拦截与记证据的 hook |
| 待处理标记（新文件 `hooks/pending-marker.sh`） | `写交互标记(根, 任务, 会话, 技能)`；`标记是否归本会话(标记, 根, 会话)` | v2 格式读写、归属规则、旧格式退役 | `interactive-skill-gate.sh`、`gate.sh`、`confirm-clear.sh`、`confirm-clear-prompt.sh` |
| `pipeline_text_is_approval_phrase`（`prompt-intent.sh`） | 输入一段文本；输出是 / 否 | 首尾空白与标点处理、「（推荐）」后缀、整条匹配清单 | 对话放行判定、AskUserQuestion 答案判定 |

会话 id 的取值与校验（字符集、≤128）也并进 `pipeline_session_change_dir` 一侧的小函数 `pipeline_hook_session_id <hook 输入>`，各 hook 不再自己校验。

测试面就是 hook 本身：`tools/test-hooks.sh` 往 hook 的标准输入喂 JSON、断言退出码与副作用，不越过接口去测内部函数。删除检验：去掉任一模块，它隐藏的规则就要在 2 到 10 个 hook 里重复，说明每个模块都在发挥作用。

### 5. 已污染状态的处理（用户确认：本任务里顺带处理）

- `setup-host-agents-step-progress` 的 `.pipeline-history.jsonl` 第 18-24 行、第 63 行由本会话串入：
  - 18-24 行是 10:02 的 brainstorming / openspec-explore 加载。
  - 63 行是 10:34 的 systematic-debugging。

  处理方式是经 kernel 的 history writer 追加一条更正事件，指明这些行来自其他会话、不是该任务的证据；原行不删（用户确认）。更正只是信息性的，不改证据求值逻辑：该任务已离开调研步，再改求值也不追溯。交付说明里写明影响：它调研步要求的 openspec-explore 实际没加载过。
- 同一任务规格步被误记的批准（10:39，`spec-complete`）：用户会让那个会话先停在规格步（用户确认）。本任务交付、本地运行时重装后，执行 `tenon review revoke setup-host-agents-step-progress --reason <串会话误确认>`，回到「待确认」，由用户正式再审。
- `unify-stage-skill-canvas` 缺的调研技能证据：本任务完结后，在会话里恢复该任务（activate 会把绑定从旧 id 4f9542da… 移交过来），重新加载它调研步的技能补齐证据。

### 6. 测试

`tools/test-hooks.sh` 新增：
- 两个会话 A / B 分别绑定 Change A / B，指针指向 B，A 的评审标记只拦 A。
- B 里回「确认继续」不确认 A。
- 宿主不给 `session_id` 时保持旧行为。
- 恢复后的新 id 没有绑定时不拦也不确认。
- 交互标记只拦、只解归属会话；旧格式被删除。
- 粘贴长文本中的放行语不触发确认，整条短回复触发。
- AskUserQuestion 的答案「确认继续 (Recommended)」触发，问题文本里的放行语不触发。
- skill-tracker 在会话 B 记到 Change B。

CLI 补 vitest：
- 撤销命令：撤回到待确认并重写标记；已消费、待确认、无回执时拒绝；缺 `--reason` 时拒绝。
- `session activate` 的移交：同一 Change 的旧绑定被删除并给出提示。

### 7. 在 Tenon 源码仓库里只用源码（规格阶段加入，用户确认）

架构决策单独记录在 `docs/adr/tenon-source-dev-install.md`。

**现状**：
- 本机插件来自 GitHub `jefferysha/tenon@v0.3.2`，运行时来自 release payload，没有从本地源码安装的入口：`install.sh` 写死标签，`tenon setup/update` 只认稳定标签，规格 `plugin-runtime`「Managed release source SHALL 绑定稳定标签版本」也这么要求。
- 上游技能约 57 个，被 `.gitignore:4` 排除，按 `skills/sources.yaml` 的 default-branch 浮动拉取。已装版和仓库工作区版是两次不同时刻的快照，实测有 12 个不一致。

**决定**：

- **源码开发安装**：新增 `tenon setup --claude|--codex --from-source <repo>`（用户确认）。
  - 只在四项源码仓库判据全满足时执行：根 `package.json` name=tenon；`.claude-plugin/marketplace.json` name=tenon 且 source 为 `./`；存在 `skills/sources.yaml`；存在 `runtime/tenon-bootstrap.mjs`。
  - 宿主插件市场改指向仓库目录，托管运行时从工作区构建。复用正式安装的事务、校验、原子切换与回滚，只替换「候选来源与版本身份」。
  - release 记录 `channel: dev`、commit、dirty、工作区摘要、技能索引摘要，不冒充 stable target。正式安装行为不变。
- **上游技能**：正文与本机拉取索引（`skills/skills.lock.json`）都不进仓库（用户确认）。
  - 源码开发安装时缺技能或缺索引就自动拉取，两次安装之间不重拉。
  - 拉取失败整体中止、不改宿主（按推荐确定）。
- **防覆盖**：开发安装写本机安装通道标记并关闭 auto-update；开发安装下 `tenon update` 默认拒绝，`--to-stable` 切回正式（按推荐确定）。
- **漂移检查**：
  - 源码仓库内，会话开始比较已装与工作区（commit、工作区摘要、技能索引摘要），不一致就在会话上下文给出同步命令。
  - 已装的是正式版时同样提示（按推荐确定）。
  - 判据只有安装内容摘要（发布载荷路径集合的内容摘要）与技能索引摘要；commit 与是否有未提交改动只展示，不是判据，只提交文档不提示（实施计划 B 部分差异表第 7 项，验证步评审后写进规格）。
  - fail-open；hook 侧纯 bash 直接精确比较（发布载荷路径的内容摘要，实测约 20 ms，不读缓存），`tenon doctor` 的 `source:drift` 用同一口径做完整比较。
  - 提示里的仓库路径用 `printf %q` 加引号；路径含控制字符时不输出提示，免得目录名改写会话上下文。
- **可见性**：Dashboard 健康信息加 `channel` 与短 commit，版本显示 `<version>+dev.<sha7>`；`identity:release` 对开发版为黄色。

**先验证再实现**：实施计划 B 部分第一个任务是一次实验，回答 4 个问题：
1. Claude 从本地目录市场安装时，是否复制 `.gitignore` 忽略的文件，以及缓存如何刷新。
2. Codex 是否支持本地目录市场。
3. `plugin list --json` 对本地市场的返回形态。
4. 宿主对账代码对 stable target 的硬依赖。

如果第 1 问的结论是「不复制」，就从工作区 `skills/` 直接拷入候选根。

**分工**：A 部分（hook 隔离与撤销）与 B 部分（源码安装与漂移）共享 `hooks/session-start.sh`、`tools/test-hooks.sh` 与入库的 `packages/cli/dist/tenon.mjs`。B 部分改 hook 的那一项排在 A 部分合入之后。

### 8. 步骤测试豁免（验证步加入，用户确认）

**现状**：
- 验证步的必需步骤测试 `code-size` 写在冻结的工作流计划里，`pass.metrics` 是硬上限（新增行 ≤ 2000），没有覆盖途径。
- `tenon test waive` 只认 `--kind`（策略要求的种类）与 `--covers`（追溯条目）。
- 步骤测试失败后，`next` 的测试检查排在出口之前，只会给 `run-test`，任务到不了评审门。
- 本任务实测新增 11271 行：其中约 3060 行是未跟踪、未忽略的本机 `.claude/`，约 2100 行是重新生成的打包产物，手写源码本身也超过 2000 行。拆分任务无济于事：重建打包产物的任务都会接近上限，且每个任务的探针都会算上检出里全部未提交的改动。

**决定**：
- **计划模型**：`PlanWaiver` 增加 `{ test: <id> }`，键 `test:<id>`；`kind`、`covers`、`test` 恰好写一个；id 用 `isStepTestId`（与编译工作流步骤测试同一校验）。冻结豁免清单的键正则同步接受 `test:`，否则确认时读不回清单、什么都批准不了。
- **判定**（`evaluate-v2.ts` 的 `evaluateInline`）：只在「必需测试 + 最新有效记录是失败」时查 `test:<id>` 豁免。
  - 已批准：verdict 为 `waived`，保留失败原因，另出提示 `test-waived`，不阻塞。
  - 未批准：verdict 为 `waiver-pending`，以 `waiver-unapproved` 阻塞；它本来就在评审请求时放行、转换时要求批准的集合里。
  - 未运行、运行中、过期、计划缺失或被篡改：一律照旧，豁免不生效。
- **编排**：测试证据项带上 verdict 的豁免状态，`testItemSettled`（通过，或失败但有豁免）统一给三处用：
  - `next` 不再发 `run-test`；
  - 评审者「必需测试就绪」；
  - 结论字段的证据核对。
  `requiredEvidenceFailed` 只看 `failed`，带豁免的失败不会把评审门推去回退边。没有豁免的失败行为不变。
- **评审者提示**：`reads_tests` 引用的测试若有豁免，结果下加一行 `豁免（已批准|待评审批准）：<理由>`；没有豁免时提示词逐字不变。
- **展示**：server DTO 与 Dashboard 解码器接受新状态与 `test` 键，否则服务端一发新状态整份策略报告解码失败；页面不改。
- **代码规模口径**：`.gitignore` 忽略本机 `.claude/`（与已忽略的 `.agents/`、`.codex/` 同类）。

**已知限制**：
- 没声明 `test_policy` 的步骤走旧判定、不读计划，豁免登记得进但不生效（内置工作流没有这种步骤）。
- `diff-risk` 探针的升级信号仍读原始失败状态，对它登记豁免压不住 `scope-expanded` 升级。按范围不改。
- 登记豁免会改计划摘要，目录套件的运行因此过期，顺序是先登记、再跑阶段测试。

**备选**：
- 调高默认工作流的上限：对已冻结的任务无效，且改的是所有新任务的口径。否决。
- 拆分任务：见现状。否决。
- 在流程外交付：绕过门禁。否决。

### 9. 验证评审后的修正（用户逐条确认）

第二轮验证的四个必需评审者给出 14 条阻断级问题，主线逐条核对后修正如下：

- **agent 不能自己执行手动评审确认**（security）。
  - 原状：评审挂起时 gate 放行 agent 执行 `tenon review acknowledge`，终端通道没有「人在场」证明，agent 能登记豁免再自己批准；评审标记 30 分钟过期后 gate 也不再拦。
  - 现在：`gate.sh` 在任何时候都拒绝 agent 的 shell 调用执行不带 `--delegated` 的手动确认，包括经包装器、解释器、`bash -c`、命令串接的写法。
  - 确认只经三条路：放行语由 hook 写入；Dashboard；没有写回执 hook 的宿主由用户本人在终端运行。
  - `templates/workflow.md`、`adapters/contract.md` 与各适配器说明同步改写。
  - 局限：这是对命令文本的静态判定，变量拼出的命令名、脚本文件里的调用不在覆盖内，边界仍是同机同用户的信任模型。
- **交互标记按会话分文件**（backend-quality），见 §2。
- **豁免批准绑定代码候选**（security）。
  - 请求时冻结失败记录的候选，确认时写进计划的 `approved_candidate`，判定要求它与当前新鲜失败的候选相同。
  - 旧批准没有候选，按待批准处理。
  - 批准后代码变了再失败：评审回执已是确认状态，`review request` 对已确认事件一律拒绝，所以 `next` 给出 `fix`，点名先 `tenon review revoke` 再重新请求。
- **豁免理由标注为登记者自述**（security）：评审者提示与 `test-waived` 提示里加「登记者自述、未经核实」，单行、200 字符截断、反引号与尖括号换全角。
- **`session activate` 写入顺序**（backend-quality）：先原子写本会话绑定，再移交，二者在 Change 目录锁内完成；写失败不删任何绑定。
- **漂移提示的路径**（backend-quality、security），见 §7。
- **文件规模**（code-size）：豁免判定拆到 `test-system/step-test-waivers.ts` 与 `evaluate-inline.ts`，出口动作拆到 `statusStepExits.ts`，会话绑定拆到 `session-binding.ts`，会话标记符号移到 `kernel/state/markers.ts`。
- **Dashboard 快照带豁免状态**（backend-quality low）：已豁免算完成，待批准算等待。
- **规格补齐**（spec-consistency）：漂移判据、`/api/health` 开发版字段、`--dry-run` / `--skip-build`、旧插件收敛回执未完成时拒绝、测试环境隔离，都写进提案与 delta spec。
- **记为已知风险**（用户确认）：`--from-source` 会执行所给仓库的构建，并长期安装其 hooks 与技能，属开发者显式命令。
- **推迟**：`review revoke` 一并撤回已写入的豁免批准，需要把批准与确认回执关联，进后续任务。

### 10. 第三、四轮验证评审后的 gate 加固（用户确认回退修复）

第三轮 security 发现：手动 acknowledge 的预筛在去引号之前按原文找子命令，词中拆分（`ackn""owledge`）可以绕过。第四轮又发现 `--delegated` 被含空白的引号串带进来、带值选项夹在 `review` 与子命令之间都会漏判，code-size 指出判定逻辑把 `gate.sh` 撑到 1273 行。修正：

- **位置**：判定移到 `hooks/lib/ack-command.sh`（source-only），`gate.sh` 只留预筛、按需加载与拒绝提示。预筛已命中而库缺失时失败关闭；`tools/verify-skills.sh` 检查库随插件交付。
- **还原顺序**：JSON 转义的 ASCII → `\xHH` / `\NNN` / `\uHHHH` / `\UHHHHHHHH` → 续行、反斜杠、引号与 `$'…'` / `$"…"` 的 `$` → 花括号展开（预算内真展开，超预算或认不出的组按「字母能依次拼出子命令」失败关闭）。还原出的字符垫 `\002`，含空白引号串里的词垫 `\003`；`--delegated` 只认不带标记的原词。
- **参数结构**：`review` 之后按 `review <sub> [name]` 与 `--event` / `--as` / `--reason`（带值）、`--delegated`、`--` 的真实结构找子命令；结构核对不了时退回「段里出现子命令就算」。
- **包装器**：补 `arch`、`caffeinate`、`flock`、`tsx` 等常见启动器，源码与产物入口路径也认作 tenon 入口。
- **耗时**：全部线性（`read -a` 切分），读取上限从 512 KiB 降到 64 KiB，最坏实测约 1.5 秒，低于 hook 的 5 秒时限；超过上限只做字面检查（原文含子命令字样就拦）。
- **仍覆盖不到**（库文件头注释如实列出）：变量或命令替换拼出的字符串、别名与函数、脚本文件、解释器内联程序、靠文件系统通配符展开的路径、名单外的启动器、超过 64 KiB 且原文不含子命令字样的拆分写法。失败关闭的误拦（包装器后引号里只是提到子命令等）也列出并由用例固定。
- **不在本任务**：gate 自审批候选提取与 `hooks/lib/protected-writes.sh` 对超长密集命令的平方级耗时，在 HEAD 就存在，进后续任务。

### 11. 验证轮次上限（第四轮验证后用户提出，逐条确认）

**现状**：build ⇄ verify 没有任何次数上限。原来的评审次数预算（`review_budget`，主规格 `review-attempt-budget`）于 2026-09-17 随评审车道一起删除，主规格未同步、已过期。本任务连续四轮验证，每轮评审者都挑出新问题，`next` 每次都给出回退，没有停下来交给人的机制。

**决定**（用户逐条选定）：

- **声明位置**：工作流步骤声明 `max_rounds: <N>`（1–20 的整数），只允许在设了评审门（`gate: review`）且至少有一条回退边的步骤上；`default` 工作流五条轨道的 verify 步声明 2。没有评审门的步骤（build）不受约束，它的 `requirements-changed` 始终可用。没声明的步骤和升级前已冻结的计划按内置默认 2。上限随计划冻结。新键改变编译后的计划形状，指纹与快照要照常读取旧计划。
- **任务覆盖**：`tenon set <change> max_rounds <N>`（1–20），对本任务所有受约束的步骤（评审门且有回退边）生效，写进历史；`FIELD_ORDER` 末尾追加。`status --json` 的步骤块写出 `rounds: { current, max, source }`，`source` 是 `workflow` / `default` / `task`。调高上限是用户的决定：技能与宪法写明 agent 不自行调高（agent 技术上能执行 `tenon set`，这一点靠同机同用户信任模型，记为已知限制）。
- **计数口径**：当前轮次 = 自上次清零以来进入该步的次数（含当前）。任务落到早于该步所有回退目标的步骤时清零；`default` 里就是经 `requirements-changed` 回到规格。计数取 canonical 转换记录链（`readChain` 加 `runMetadata`），没有链的旧任务退回读 `.pipeline-history.jsonl` 的转换行。
- **用完后**：当前轮次 ≥ 上限且 `requiredEvidenceFailed` 时，`exitActions` 不再走 `gatedBackActions`。
  - 不通过的只有评审者，或失败的必需测试都已登记豁免：发前进边的 `request-review`，带待接受的剩余阻断。
  - 还有没登记豁免的失败必需测试：发 `stop`（code `rounds-exhausted`）。
  - 两种都在文案里列出另外三条出路：调高上限后回退、`requirements-changed` 回规格、终止任务。
  - 回规格的真实路径按计划算：受约束步骤自己声明的回退边，目标本身就是回退目标，落到那里不清零、用完后也被拒，所以从 verify 回规格总是两步——用户先调高上限（须大于当前轮次），经 `verify-fail` 回到 build，再在 build 上执行 `requirements-changed`。文案点名事件，不给在 verify 上必然失败的单步命令（实现阶段发现，按此修正规格措辞）。
  - 强制层：回退边的 `review request` 与 `transition` 在用完时拒绝（写出 used/max 与调高命令），不只靠 `next`。CLI、kernel 转换用例与 Dashboard 转换三处入口都接线；Dashboard 返回 409 `rounds-exhausted`。
- **剩余阻断**：照搬步骤测试豁免的「冻结 → 人工确认批准 → 绑定候选」流程。
  - 上限用完时，前进边的 `review request` 放行，把结论为不通过的必需评审者（`reviewer:<agent>`）连同阻断级发现、运行 id 与候选冻结，逐条列给用户。
  - 人工 `review acknowledge`（非委托、非 AFK）在提交回执的同一把锁内写入接受，记 `review.residual-accepted` 历史。
  - 评审者结论判定把「已接受且候选、运行都对得上」的不通过视为已处置，前进边转换放行。
  - 有待接受项时委托确认被拒。代码变了或评审者在新候选上重跑，接受失效。
  - 剩余阻断只覆盖评审者；失败的必需测试仍走步骤测试豁免。
  - 存放：扩展既有、受 gate 保护的冻结清单 `.pipeline-review-waivers.json`（`residual` 待接受项、`accepted` 接受记录，严格解码、坏形状整份读不出即什么都不接受）；新文件名不在 hook 的保护名单里，所以不新建文件。
  - Dashboard 确认不展示待接受项，冻结了剩余阻断时返回 409 `residual-pending`，只能在终端回复放行语接受；读不出冻结清单时同样拒绝。
  - 发现摘要（列给用户、写进历史）折成单行、截短、去掉控制字符与双向覆盖字符；历史行 `review.residual-accepted` 带评审者、运行 id、候选、发现数与摘要。
- **失败关闭**（就绪预审后加固）：任务有转换记录链头却没装配读取依赖时，计数报错而不退回读历史文件（否则会静默算成 0 轮）。
- **本任务自身**：上限功能完成后，本任务用 `tenon set fix-hook-cross-session-isolation max_rounds 1`（用户已决定「这轮修完就停」）：回规格后重新计数，下一次验证就是第 1 轮，仍不通过就停下交给用户。
- **Dashboard**：工作流定义解码器、写回与克隆保留 `max_rounds`，不加编辑控件（用户确认只保证读写不丢）。

**备选**：
- 只做任务级字段、不进工作流定义：改动小，但用户选择在工作流里声明。
- 按 `verify-fail` 转换次数计：与「第几轮验证」的说法差一，且自定义工作流里回退边名字不固定。否决。
- 用完后只停下、不提供接受剩余阻断：用完后任务只能调高上限继续修，等于没有出口。用户否决。
- 恢复已删除的 review attempt 事务：它按候选计 attempt、按车道聚合，比需要的复杂得多，且已被步骤 agents 取代。否决。

## 备选方案

- **只点修用户列的 4 处**：改动小，但技能顺序门与证据仍会记错任务；用户否决。
- **把共享指针改成按会话存**：最彻底，但要改 `session activate`、恢复候选与 Dashboard 的语义；用户否决。
- **放行语子串匹配但剔除引用 / 粘贴**：依赖宿主如何标记粘贴，容易漏；用户否决。
- **旧格式交互标记兼容 30 分钟**：过渡期仍会跨会话互锁；用户否决。
- **同一 Change 允许多个会话绑定**：语义上可行，但用户要求一个任务只绑一个会话；否决。
- **移交时拒绝、需 `--takeover`**：会卡住会话恢复；用户否决。
- **撤销后回到「无回执」**：在 agent 重新 request 之前门是开着的；用户否决。
- **删除串单的历史行**：等于篡改审计记录；用户否决。
- **上游技能正文与锁文件提交进仓库**：可复现，但仓库体积与许可证核对成本高；用户选择不入库、初始化时自动拉取。
- **借验收工具的本地标签 + git insteadOf 冒充发布**：要改全局 git 配置、冒充发布标签，会和真实更新冲突；否决。
- **只改技能读取来源**：hook 和 CLI 仍是发布版，不满足「全部用源码」；否决。

## 风险

- hook 热路径必须保持纯 bash、不 spawn 解释器（`tools/test-hooks.sh` §3 红线）；解析函数要扫描 `.pipeline/terminal-sessions/*.json`，文件只增不删，需限制单文件大小并评估数量增长。
- 放行语收紧后，「好的，确认继续吧」这类长一点的说法不再放行，需在提示文案里写清可用的说法。
- 撤销与 acknowledge / transition 必须在同一把 canonical 锁下互斥；撤销后重新 request 是否计入评审次数预算（`review-attempt-budget`）要在规格步核实。
- 已安装运行时不随源码更新：交付步用新的 `tenon setup --claude --from-source .` 切到源码开发安装后才在真实会话生效。
- 误记的规格批准在撤销命令上线前一旦被 transition 消费就无法撤回，依赖用户让那个会话先停住。
- 自动移交意味着两个仍活着的会话先后 activate 同一 Change 时，先绑的那个会悄悄失去门约束；移交提示写在 stderr，是唯一的提醒。

## 覆盖

```coverage
L1_api: filled -> 决策 §4 `tenon review revoke`；§1 `session activate --host-session` 移交；§7 `tenon setup --from-source`、`tenon update --to-stable`、`/api/health` 的 channel 字段；§8 `tenon test waive --test`、`unregister --waiver test:<id>`
L2_data: filled -> 决策 §2 交互标记 v2 格式；§7 release manifest 的 devSource 字段与本机 install-channel 标记；§8 测试计划豁免的 `test` 键
L3_rules: filled -> 决策 §1 本会话任务解析三条规则与一对一绑定；§3 放行语整条匹配；§7 源码仓库四项判据；§8 豁免只覆盖必需测试的新鲜失败
L4_state: filled -> 决策 §4 评审回执 approved → pending 撤销；§1 会话绑定移交；§7 开发 / 正式安装通道切换；§8 步骤测试 failed → waiver-pending → waived；§11 验证轮次计数、清零与用完后的剩余阻断接受
L5_errors: filled -> 决策 §4 撤销的拒绝条件；§7 拉取失败整体中止、开发安装下 update 拒绝；漂移检查 fail-open；§8 未知测试 id 退出 2、三种豁免键互斥
L6_security: filled -> 决策 §1、§3、§4 评审门与人工确认边界（跨会话越权确认、粘贴文本放行、回执撤销）；§7 开发安装不冒充稳定标签；§8 豁免只经评审批准生效、不放行未运行或过期的测试；§9 agent 不能自批、豁免批准绑定候选、理由标注自述、漂移提示路径；§10 手动确认判定的静态还原与耗时上限；§11 剩余阻断只经人工确认接受、委托确认拒绝
L8_deps: filled -> 决策 §7 上游技能按 sources.yaml 拉取且不入库；宿主 CLI 的目录市场命令
```
