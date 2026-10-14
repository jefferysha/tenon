# 设计：减少评审门摩擦

> 任务：`reduce-review-gate-friction`。用户 2026-10-13 确认要做三件事（「按推荐，1 2 3 都做」），并授权其余取舍按推荐定；本文里标「按推荐确定」的条目即由此而来。第 4 条（委托确认在 Claude Code 中不可用）不在本任务内，等用户另行决定。

## 背景与目标

评审门（`gate: review`）的人工确认应当只落在真正需要用户拍板的地方：进入下一阶段（尤其是交付）、接受剩余阻断、批准测试豁免与「不适用」声明、轮次用完后的去向。现在有三类摩擦让用户频繁、无意义地回复「确认继续」：

1. 轮次内的回退边（`verify-fail` 等）也要一次 `review request → 用户确认 → transition`；
2. 待处理期间，只读的组合命令（`git status --short | grep x`、`cd sub && ls`）被当作写操作拦截，提示还让 agent 去问用户；
3. 三种待处理标记共用一条提示，评审标记那条说「AskUserQuestion 完成后解封」，与事实不符。

**成功标准**（与 proposal 的「可验证结果」一致）：

- 受轮次约束的评审步上，轮次未用完时，回退边直接 `tenon transition` 成功，`next` 直接给 `transition`，不产生评审标记；轮次用完后照旧被拒。
- 前进边、剩余阻断、豁免、`not-applicable` 的人工确认语义完全不变。
- 评审 / 交互 / 确认待处理期间，由只读段组成的组合命令放行；任何一段可能写入或执行任意程序就拦截。
- 评审标记的拦截提示准确：不提 AskUserQuestion 解封，写明放行语与 Dashboard 确认。

## 方案比较（第 1 条）

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. 内核豁免（推荐） | 在 `transition-application.ts` 的回执判定处加「受约束步骤上、轮次未用完的回退边不要求回执」；`next` 投影同步改 | 采用。CLI 与 Dashboard 共调同一用例，单点生效；轮次门本来就在这里读轮次 |
| B. 只改 `next` | `next` 给 `transition`，转换仍要回执 | 否决：照做必被拒，等于没改 |
| C. 工作流 YAML 声明 | 给回退边加 `review: false` 之类的开关 | 否决：要改工作流 schema、生成物与 Dashboard 编辑器，范围大；规则本身与轮次上限强相关，不需要逐边配置 |

## 设计

### 1. 轮次内回退边免人工确认（内核）

**判定**（与 `rejectOnRoundsExhausted` 用同一组谓词、同一次轮次读取）：

```
exempt(from, to, event) =
      roundsOf 已接线
  and not isAbandonEvent(event)
  and not isForwardExit(plan, from, to, event)      # 回退边
  and isRoundsLimited(plan, from)                   # 评审门且有回退边
  and not roundsExhausted(roundsOf(from))           # 轮次未用完
```

- `transition-application.ts`：现在 `rejectOnRoundsExhausted` 已经为回退边读一次轮次；把它改成返回「拒绝 / 豁免 / 不适用」三态（或同一函数返回轮次，调用方判定），回执判定改为 `prepared.requiresReviewApproval && !exempt`。
- `roundsOf` 没接线（只在测试与第三方宿主中）：不豁免，照旧要求回执（失败关闭）。
- 轮次读取抛错（状态有 canonical 链头却没装配 `recordStore`）：与现状一致，向上抛（`rejectOnRoundsExhausted` 现在就会先抛）。按推荐确定。
- 免回执路径不产生「评审确认 → 转换」的 interaction 效果记录（没有人工确认发生），这是正确的。
- 两个 planner（step-graph 与旧 phase-manifest）都只算 `requiresReviewApproval`，不需要改：豁免在用例层统一判定。

**不新增回退边的就绪检查**（按推荐确定）。调研确认：新执行模型的任务在请求侧与转换侧本来都没有「验证报告已写出」检查，只有旧模型在途任务的 `review request` 才查；人工确认是唯一的兜底。去掉人工确认后不补这条检查，理由：回退不会绕过任何质量门（下一次前进仍要过全部测试、评审者与人工确认），代价由 `max_rounds` 封顶；`next` 已把 `test-report` 排在回退边之前。旧模型在途任务若仍走 `review request --event verify-fail`，检查照旧。

**`review request --event <回退事件>` 在轮次内仍允许**（兼容升级前的流程与 Dashboard「退回到…」），只是 `next` 不再给出它。

### 2. 转换后清掉过期的评审标记

调研发现 `tenon transition` 不删 `.pipeline-pending-review`。升级前已发起的回退边请求、或「pending 的是前进边却直接回退」，转换后 canonical 回执已被清空，标记却还在，最多 30 分钟内写类工具被拦，而用户回放行语也解不开（`review acknowledge` 找不到回执，不清标记）。

- 每次**成功**转换后，删除绑定本任务的评审标记（`clearReviewMarkerOfChange` 一类的现成函数）。任何成功转换都会清空回执，标记必然过期，所以对所有转换都清，不只免回执路径。按推荐确定。
- 落点：内核转换用例在提交之后直接调用自带的 `clearReviewMarkerOfChange(command.root, command.changeName)`（`state/markers.ts`），失败只记一条 `review-marker` 告警，不回滚转换；两个宿主只需渲染这条告警。不新增端口：两个宿主会传入同一个函数，只有一种实现的接缝是假接缝（规格步修订）。
- 标记只属于本任务时才删（标记里的 change 名与本任务一致），不碰其他任务的标记。

### 3. `next` 投影

- `statusStepExits.ts` 的 `gatedBackActions`：唯一回退边在轮次未用完时直接给 `transition`（`rounds` 缺席时照旧走 request → await → transition，失败关闭）。多条回退边仍给 `choose-exit`。
- 回退边上挂着的 pending / approved 请求（升级前遗留）：`next` 一律直接给 `transition`，转换会清掉回执与标记。
- 轮次用完后的分支（`stop`、接受剩余阻断的评审请求）不变。

### 4. gate 只读判定支持组合命令

新增函数 `pipeline_command_is_read_only_chain`（名字以实现为准），不改共享的 `pipeline_command_has_shell_metachars`（评审控制命令白名单还在用它）。

- 先剥离无害重定向：` 2>/dev/null`、` >/dev/null`、` 2>&1`、` &>/dev/null`（只在引号外、作为独立记号时）。
- 长度上限：解码后超过 2048 字符直接判非只读（保持超长命令 3 秒内拦截）。
- 引号感知的线性扫描（bash 3.2）：单引号内全字面；双引号内遇到 `$(` 或反引号判非只读；引号外遇到 `>`、`<`、单个 `&`、反引号、`$(`、换行、回车判非只读；引号外的 `|`、`||`、`&&`、`;` 作为段分隔。引号没闭合判非只读。
- 每段去掉首尾空白后：`cd` 段放行（不写任何东西）；其余段走现有严格只读白名单。
- 顺手收紧白名单里会写文件或执行程序的既有形态（按推荐确定）：
  - `git diff|log|show` 带 `--output` → 非只读；
  - `rg` 带 `--pre` → 非只读（`--pre` 会执行任意程序）；
  - `sed -n` 的脚本只认行号区间打印（如 `1,80p`、`'10,20p'`、`$p`），其余形态（可能含 `w` 写文件、`e` 执行）→ 非只读；
  - `file` 带 `-C` / `--compile` → 非只读。
- 调用点：`pipeline_tool_is_read_only` 改用新函数；三种标记共用。评审标记下的「自审批候选」拦截（Dashboard 控制面、`dashboard-token`）现在排在只读放行之后：组合命令放宽后必须保证这类候选仍被拦：把 review kind 的自审批拦截挪到只读放行之前（按推荐确定；不在只读函数里掺入自审批判定，两件事保持分离）。

### 4b. 评审待处理期间放行 `tenon transition`

`is_review_control_command` 增加一种形态：`tenon transition <change> <event>`（单条、无 shell 元字符、恰好两个参数）。理由见决策 D12：前进边的评审待确认时用户要求回退，agent 需要执行回退；CLI 照旧拒绝缺少回执的前进边与上限用完后的回退边，所以 gate 不必再替它把关。只在评审标记下放行，确认 / 交互标记照旧拦截。

### 5. 按标记种类给拦截提示

- **评审标记**：「评审待确认（任务 X，事件 Y），本次 Z 已被拦截：现在不要改文件或推进状态；把产出与结论摆给用户，等用户回复放行语（列出）或在 Dashboard 确认（`tenon dashboard --open`）；agent 不能自己确认；只读工具与只读命令（含 `|` `&&` `||` `;` 连接的只读组合）不受拦截。」放行语清单与 hook 实际认的保持一致。
- **确认 / 交互标记**：保留现有「AskUserQuestion / ToolSearch / 放行语」说法，补一句只读组合可用。
- `tools/test-hooks.sh` 按种类分开断言；`GATE_UNLOCK_TEXT` 一类的「提示列出的放行语真能解封」一致性测试同时覆盖两条提示。

### 6. 规则与文档

- `templates/workflow.md`：「评审是出边级的」补一句「受轮次上限约束的步骤上，轮次内的回退边不需要确认，直接 transition」。
- `skills/tenon/SKILL.md`：出口、`request-review`、`await-review`、`run-tests` 相关句子；interactive 模式下轮次内回退边也直接走，用一句话告诉用户原因（按推荐确定）。保持 `test-hooks.sh:2683-2689` 守的那段放行语原文。
- `tools/generate-product-identity.mjs` 的 Codex AGENTS 块文案 → `npm run generate:identity` 同步 `templates/generated/codex-agents-block.md`、`codex-agents-block.generated.ts` 与仓库根 `AGENTS.md`。
- `docs/CONTRACT.md`、`adapters/contract.md`、`docs/usage/{,zh-CN/}{default-workflow,cli-reference,index,troubleshooting}.md`、发布说明新增一条。
- 主 spec：`verify-round-limit`、`plugin-runtime`、`document-evidence-contract` 中冲突的场景；gate 只读与提示所属 capability 在规格步确定。
- 重新打包并提交 `packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`（hook 执行的是 dist）。

### 不做的事

- 不改 Dashboard 前端「退回到…」复制 `review request` 的行为（仍然合法）；作为后续可选优化记录。按推荐确定。
- 不改 design-system 工作流：它的 `review → generate`（`review-changes`）同样是受约束步骤的回退边，统一适用新规则（agent 可以在给用户看之前自行打回重做，前进仍要用户确认）。按推荐确定。
- 不改委托确认、AFK、剩余阻断、豁免、轮次计数。

## 模块与接缝

| 模块 | 接口 | 藏在后面的东西 | 接缝 / 适配器 |
| --- | --- | --- | --- |
| 回退边轮次判定（内核，`transition-rounds-gate.ts` 扩展） | 一次调用返回 `none`（不是受约束的回退边）/ `within`（轮次内，可免回执）/ 拒绝（已用完） | 放弃边、前进边、受约束判定、轮次读取（只读一次） | 已有的 `roundsOf` 端口（CLI、Dashboard 两个适配器） |
| 转换用例（`transition-application.ts`） | 不变（告警联合多一种 `review-marker`） | 用上面的三态决定是拒绝、免回执还是照旧要回执；提交后直接删本任务的评审标记 | 无新接缝（两宿主会给同一实现，不值得开端口） |
| 只读命令判定（新文件 `hooks/lib/read-only-command.sh`） | `pipeline_command_is_read_only <命令>` → 0 / 1 | 长度上限、无害重定向剥离、引号感知切段、逐段白名单与收紧规则 | gate.sh 唯一调用点；文件缺失时判非只读（失败关闭），`tools/verify-skills.sh` 登记它为发布包必备文件 |
| 拦截提示（gate.sh `gate_check_marker`） | 按 `kind` 输出一条提示 | 评审标记读出 change 与 event 写进提示 | 无新接缝 |

`next` 投影（`statusStepExits.ts`）只改 `gatedBackActions` 的一个分支，用已有的 `rounds` 入参，不新增模块。

## 决策清单

用户已授权按推荐定；以下是决策树上每个分叉与采用的答案，评审门上可逐条推翻。

| # | 决策 | 采用 | 理由 |
| --- | --- | --- | --- |
| D1 | 免确认的范围 | 只限受轮次约束的评审步（评审门且有回退边）上、轮次未用完的回退边 | 与 `max_rounds` 绑定，代价有上限；放弃边、前进边不变 |
| D2 | design-system 的 `review-changes` 是否也适用 | 适用 | 规则统一；前进仍要用户确认，agent 先自行打回重做无害 |
| D3 | 是否为回退边新增就绪检查 | 不新增 | 新模型本来就没有；回退不绕过任何质量门 |
| D4 | 过期评审标记何时清 | 每次成功转换后，由内核转换用例直接删 | 成功转换必然清空回执，标记必然过期 |
| D5 | interactive 模式下轮次内回退是否先问用户 | 不问，直接走并用一句话说明 | 这正是要消除的摩擦 |
| D6 | 轮次内 `review request --event <回退>` 是否仍允许 | 允许，`next` 不再给出 | 兼容升级前流程与 Dashboard「退回到…」 |
| D7 | Dashboard「退回到…」 | 不改 | 仍可用；最小范围 |
| D8 | 组合只读的分隔符 | `\|` `\|\|` `&&` `;`；允许 `cd` 段；剥离 `/dev/null` 与 `2>&1` | 覆盖常见只读写法，其余元字符一律拦 |
| D9 | 是否顺手收紧既有白名单 | 收紧 `--output`、`rg --pre`、`sed -n` 非行号打印、`file -C` | 放宽组合的同时补上写文件 / 执行程序的旧洞 |
| D10 | 评审提示内容 | 列放行语与 Dashboard 确认，不提 AskUserQuestion | 与 hook 实际行为一致 |
| D11 | 第 4 条（委托确认） | 不在本任务 | 等用户决定 |
| D12 | 评审待处理期间 gate 是否放行 `tenon transition <change> <event>` | 放行单条、无元字符的这一形态，由 CLI 判定 | 否则前进评审待确认时用户要求回退，agent 的回退命令会被 gate 拦住；CLI 本就拒绝无回执的前进边与用完后的回退边，不打开新口子（规格步补充） |

## 错误处理

- 豁免判定的任何前提读不到（`roundsOf` 缺席）→ 照旧要求回执。
- 清标记失败（只可能是文件系统错误）→ 转换已提交，输出一行警告，说明标记会在 30 分钟 TTL 后自动失效；gate 侧不为此去读 canonical 状态（按推荐确定：低概率退化换取 gate 不新增状态读取与解析失败面）。
- 只读判定的任何不确定（引号不闭合、超长、未知命令）→ 非只读（宁可误拦）。

## 覆盖

```coverage
L1_api: filled -> §1 轮次内回退边免人工确认（`tenon transition` 与 Dashboard 转换端点的契约）、§3 `next` 投影
L2_data: filled -> §2 转换后清掉过期的评审标记（评审回执与 `.pipeline-pending-review` 的生命周期）
L3_rules: filled -> 决策清单 D1–D12
L4_state: filled -> §1 判定（受约束步骤回退边的转换条件）、§3 `next` 投影
L5_errors: filled -> 错误处理
L6_security: filled -> §4 gate 只读判定与收紧、§4b 评审期放行 transition、§5 提示不得暗示 agent 自行确认
L8_deps: waived -> 不新增、不升级任何依赖
```

## 测试

- 内核：`transition-application.test.ts` 新增 / 改写：轮次内回退边无回执成功；前进边无回执仍拒；用完后回退边仍拒；`roundsOf` 缺席时回退边仍要回执；放弃边不受影响；成功转换调用清标记端口、失败只警告。
- CLI 单测：`statusStep*.test.ts` 的 `next` 期望改为 `transition`；多回退边仍 `choose-exit`；`rounds` 缺席仍走评审请求。
- 集成：`review-residual`、`next-action-runner`、`test-flow`、`review.integration`、`transition-effects` 中改用直接回退；新增「升级前已 pending 的回退边请求 → 直接 transition 成功且标记被删」。
- Dashboard 服务：`transition-concurrency.test.ts` 回退边断言改为成功；新增「Dashboard 回退边转换后标记被删」。
- Hook：`tools/test-hooks.sh` 新增组合只读放行 / 拦截矩阵（含评审标记下）、收紧形态的拦截、超长组合 3 秒内拦截、自审批候选在组合里仍被拦、按种类的提示断言。
