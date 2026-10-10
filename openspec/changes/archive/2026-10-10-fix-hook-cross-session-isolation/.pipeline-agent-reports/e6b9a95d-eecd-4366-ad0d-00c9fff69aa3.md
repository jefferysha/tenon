# 核验报告（run e6b9a95d-eecd-4366-ad0d-00c9fff69aa3）：对照修正后的 delta spec 核验就绪预审加固

结果：done。四处修正措辞在代码里都有对应实现，三处已有测试钉住；第四处（读链失败不退回 JSONL）只有「没装配 recordStore」一支有测试，我补了「装配了但读链本身失败」一支的测试，没有改任何生产代码。整套自测全绿，`npm run build` 退出码 0。

没有被 gate 拦过；没有运行 `tenon agent record`、`tenon test trust` 或任何改 Tenon 状态的命令；改文件只用了 Edit / Write；shell 一次一件事。

## 一、逐条核验（delta spec `specs/verify-round-limit/spec.md`）

### 1. 「上限调高到高于当前轮次之后，回退边恢复可用；调到等于当前轮次仍算用完」

实现（判据只有一处，`>=`）：

- `packages/kernel/src/workflow/step-rounds-read.ts:105-107` `roundsExhausted`：`rounds.current >= rounds.max`。
- 强制层 `packages/kernel/src/workflow/transition-rounds-gate.ts:30` 用它拒回退边；`next` 投影 `packages/cli/src/commands/statusStepRoundsActions.ts:109`（`roundsVerdict`）与 `blockExhaustedBackExits`（同文件 133 行起）用同一个函数，三处口径一致。
- 上限来自任务字段：`step-rounds-read.ts:100` `resolveMaxRounds(effectiveMaxRounds(step), state.fields.max_rounds)`，所以 `tenon set <c> max_rounds <N>` 之后重读即生效。

钉住它的测试：

- 判据本身：`packages/kernel/src/workflow/step-rounds-read.test.ts` `roundsExhausted > 当前轮次 >= 上限算用完；没有 rounds（不受约束）永远不算`（1/2 否、2/2 是、3/2 是）。
- `next` 投影：`packages/cli/src/commands/statusStepRoundsNext.test.ts:356` `第 2 轮时设为 1：仍视为用完；设为 2（等于当前轮次）：仍用完；设为 3（大于）：恢复 verify-fail 的评审请求`。
- 真 CLI 端到端：`packages/cli/src/review-residual.integration.test.ts:258` `调整上限：第 2 轮时设为 1 或 2 仍视为用完，设为 3 才恢复回退（verify-fail 的评审请求可发）`（设 1、2 时 `review request --event verify-fail` 退出码 1；设 3 后 exits 里 `verify-fail` 就绪，request、acknowledge、transition 全部成功）。
- Dashboard 服务强制层：`packages/server/src/transition-rounds.test.ts:121` `调整上限：设为 1 仍用完；设为 3 才恢复（越过这道门，由后面的评审确认门接着判）`。
- 内核强制层：`packages/kernel/src/workflow/transition-rounds-gate.test.ts` `当前轮次 >= 上限的回退边被拒…` / `未用完（当前轮次 < 上限）：放行…`。

### 2. 「没有直达规格的边时，回到规格这条出路写明真实路径」

实现（三处文案同义，都不暗示在当前步骤直接执行）：

- `next` / `stop` 的第 2 条出路：`packages/cli/src/commands/statusStepRoundsActions.ts:56-73` `specAlternative`（先由用户定 N 调高上限、经回退边回到回退目标步骤、再在那一步执行回到规格的事件；`stop` 与前进边评审请求共用 `roundsAlternatives`，同文件 76-83）。路径由 `packages/cli/src/commands/statusStepRoundsRoute.ts` 的 `roundsRoute(plan, stepId)` 按计划算出（`back` / `reset` / `resettable`）。
- 强制层拒绝（CLI）：`packages/cli/src/i18n/messages-transition.ts:67-74` `transition.roundsExhausted` zh / en（zh 含「没有直达的边」，en 含「no direct edge」）。
- 强制层拒绝（Dashboard 409）：`packages/server/src/transitionResult.ts:156-172` `rounds-exhausted` 分支，与 CLI zh 同义。

钉住它的测试：

- `packages/cli/src/commands/statusStepRoundsRoute.test.ts` 共 7 条：`内置 default：verify-fail 回 build，再在 build 上用 requirements-changed 回 spec`、`不受约束的步骤…：null`、`自定义计划：回退目标步骤上落到更早步骤的边按事件名点出来`、`多个回退目标：挑回退目标步骤上有回更早步骤的边的那条回退边`、`回退目标步骤上没有落到更早步骤的边，但工作流里有更早的步骤：不点名事件（reset 为 null），仍可回`、`回退目标就是第一个步骤：没有更早的步骤可落，回规格这条路不存在`、`受约束步骤自己声明的回规格的边不算出路：它本身就是回退目标，落到那里轮次不清零，用完后它也被拒`。
- `packages/cli/src/commands/statusStepRoundsNext.test.ts:260` 起 `第 2 条出路：回规格要分两步（受约束步骤上没有直达的边）` 共 7 条：`default 的 verify：先调高上限、经 verify-fail 回 build，再在 build 上执行 requirements-changed；回到 spec 后重新计数`、`回规格的命令只出现一次，且明确写在 build 上执行；不再是在 verify 上直接执行的单步说法`、`stop 与前进边的评审请求共用同一份文案`，以及 reset 为 null、resettable 为 false、自定义事件名、调用方没给 route 四种变体。
- 真 CLI：`packages/cli/src/review-residual.integration.test.ts:209`（第 2 条出路匹配 `verify-fail.*在 build 上执行 tenon transition <c> requirements-changed`）、`:233`（拒绝文案 zh 含「没有直达的边」、en 含「no direct edge」、en 无 CJK）、`:295`（verify 自己声明回 spec 的边：exits 带 `rounds-exhausted`、`transition` 退出码 1、next 不给单步命令）。
- Dashboard：`packages/server/src/transition-rounds.test.ts:107` `用完后回退边被拒：409 + code rounds-exhausted…`（断言含「没有直达的边」、不含旧说法「经 requirements-changed 回到规格」）。

### 3. 「任务历史记下接受的评审者、运行与发现（发现数与冻结时的摘要）」「摘要单行、截短，去掉控制字符与双向覆盖字符」

实现：

- 冻结时清洗：`packages/kernel/src/test-system/review-residual.ts:77-92` `residualFromBlockers`，摘要最多 `RESIDUAL_SUMMARY_MAX = 5` 条，每条走 `waiverReasonText`（`packages/kernel/src/test-system/step-test-waivers.ts:74-80`：折成单行、去 C0 / C1 / DEL 与双向覆盖 U+202A–202E、双向隔离 U+2066–2069、最多 200 字加 `…`、反引号与尖括号换全角；码点区间在 `:56-63`）。
- 列给用户：`review-residual.ts:95-105` `residualLines`（带键、发现数、运行、候选与逐条摘要）。
- 历史行：`review-residual.ts:198-209` `residualAcceptedRaw` 输出 `review.residual-accepted reviewer=<agent> run=<runId> candidate=<候选> findings=<n> by=<确认人> summary=<条1>|<条2>…`，写入点 `packages/cli/src/commands/review-waivers.ts:228-230`（每个被接受的评审者一行，kind `tool`）。写历史前再清洗一遍，不依赖调用方已干净。
- 读回失败关闭：`review-residual.ts:134-166` `decodeResidual` / `decodeAccepted` 拒收含控制字符或双向字符的摘要、确认人与时间。

钉住它的测试（`packages/kernel/src/test-system/review-residual.test.ts`）：

- `摘要最多 5 条，每条折成单行、截短，反引号与尖括号换全角（评审者的话不能伪造标签）`
- `摘要去掉 C0 / C1 控制字符与双向覆盖 / 隔离字符：评审者的话带不进终端转义序列或文字方向反转`
- `历史里的接受行：review.residual-accepted，带评审者、运行、候选、发现数与确认者，单行可 grep`
- `历史接受行带上冻结时的发现摘要：summary= 后各条用 | 连接，条内空白折成 _、| 换全角，仍是一行`
- `历史接受行的摘要最多 5 条、再清洗一遍：控制字符与超长都去掉，整行不超过 4 KiB`
- `历史接受行没有摘要时与以前逐字相同（不带 summary= 键）`
- `逐条列给用户的行带键、运行 id、候选和发现摘要`
- `手工写进清单的摘要含控制字符或双向字符：整份拒收（失败关闭），不读成待接受项`
- 展示文本清洗本身：`packages/kernel/src/test-system/step-test-waivers.test.ts:87` `去掉 C0 / C1 控制字符与双向覆盖 / 隔离字符：终端转义序列、行内回车、文字方向反转都带不进展示文本`。
- 真 CLI 端到端：`packages/cli/src/review-residual.integration.test.ts:318`（评审者发现里带 ESC 序列：request 列出的文本、边车冻结的 summary、历史行 `by=<确认人> summary=high_<位置>_SQL_拼接[2K` 都不含 `\u001b`；历史行含 `reviewer=security`、`run=<runId>`、`findings=1`、`candidate=workspace:sha256:…`）。

### 4. 「任务有转换记录链却读不到时 SHALL 报错，不退回读历史文件」

实现：`packages/kernel/src/workflow/step-rounds-read.ts:41-53` `chainTransitions`：状态有 `transitionHead` 时必须走链，`recordStore` 没装配则抛错（不碰 `readHistoryRaw`）；`readChain` 自己抛的错不加 try/catch，原样上抛。只有没有链头的旧任务才在 `:92` 走 `historyTransitions`。三个宿主装配点都传了 `recordStore`：`packages/cli/src/commands/statusStepRounds.ts:20`、`packages/cli/src/commands/transition.ts:165`、`packages/server/src/transition.ts:236`。

钉住它的测试：

- `packages/kernel/src/workflow/step-rounds-read.test.ts` `状态里有转换记录链头、调用方却没传 recordStore：抛错（失败关闭），不走 JSONL 回退算出偏小的轮次`（没装配这一支；断言 `readHistoryRaw` 没被调用）。
- `packages/kernel/src/workflow/step-rounds-read.test.ts` `有链头且传了 recordStore：照旧读链；没有链头：照旧退回 JSONL`（正反两面）。
- `packages/cli/src/status-step-rounds-stable.integration.test.ts` 6 条：删标记、重跑测试、重登记评审者、删除 / 截断 / 伪造 JSONL 转换行，`step.rounds.current` 都稳定为 2（链优先）。

## 二、这次补的一条测试（找到实现、缺测试 -> 补测试）

缺口：「读链本身失败」这一支（`recordStore` 装配了，但 `readChain` 抛错，比如磁盘 I/O 错误）实现上是原样上抛，但没有测试钉住；将来有人给 `readChain` 包一层 try/catch 并退回 JSONL，所有现有测试仍会绿。

新增（`packages/kernel/src/workflow/step-rounds-read.test.ts`，在 `readStepRounds` 组里）：

`有链头、recordStore 也装配了，但读链本身失败（如磁盘 I/O 错误）：原样抛出，不退回读 JSONL 算出偏小的轮次`：`readChain` 抛 `EIO`，断言 `readStepRounds(...)` rejects 同一个错误对象，且 `readHistoryRaw` 没被调用。

RED / GREEN 说明：行为在前面的组里已经实现，新测试一上来就是绿的（不存在「功能缺失导致的红」）。为证明它能抓到回归，我用临时改动验证：

- 临时改动（在 `chainTransitions` 里给 `readChain` 包 try/catch、失败时 `return undefined` 退回 JSONL，标记 `TEMP-MUTATION`）：`npx vitest run packages/kernel/src/workflow/step-rounds-read.test.ts` 得到 1 failed | 8 passed，失败信息 `promise resolved "{ current: 1, max: 2, …(1) }" instead of rejecting`（正是「偏小的轮次被悄悄放过」）。
- 还原后：该文件 9 条全绿；`grep -rn TEMP-MUTATION packages/kernel/src packages/cli/src packages/server/src` 零命中。生产文件 `step-rounds-read.ts` 最终内容与改动前逐字相同。

## 三、整套自测

| 命令 | 结果 |
| --- | --- |
| `npx vitest run packages/kernel/src/workflow packages/kernel/src/test-system packages/cli/src/commands packages/server/src` | 258 文件通过，4328 条通过、10 条跳过、0 失败（上次 4327，多出的 1 条是新增测试） |
| `npx vitest run packages/cli/src/review-residual.integration.test.ts packages/cli/src/status-step-rounds.integration.test.ts packages/cli/src/status-step-rounds-stable.integration.test.ts` | 3 文件、26 条通过 |
| `npx tsc -b packages/kernel packages/channel packages/tap packages/automation packages/cli packages/server` | 退出码 0，无输出 |
| `npm run typecheck:web` | 退出码 0 |
| `node tools/check-architecture.mjs` | passed（1523 个生产文件，5 个 size-only 例外；运行时 SCC=0，type-only SCC=1 为既有） |
| `npm run check:comments` | 通过 |
| `npm run check:docs` | 32 条 node 测试通过；documentation check passed（43 份文档） |
| `npm run test:hooks` | 2124 passed, 0 failed |
| `npm run build`（输出丢弃） | 退出码 0 |
| build 之后重跑 round 相关 4 个文件（3 个集成 + `step-rounds-read.test.ts`） | 35 条通过 |

`vitest` 输出里的几行 `[dashboard-server] 500 GET …/history` 和 `[AGENT] 已回收…`、一条 `FileHandle` 弃用警告，是既有反向用例的预期日志，与本次无关。项目没有 lint 脚本，所以没跑 lint。

## 四、改动清单

- 修改 `packages/kernel/src/workflow/step-rounds-read.test.ts`：新增 1 条用例（读链失败原样抛出、不退回 JSONL）。
- 生产代码：零改动。`step-rounds-read.ts` 临时改动已还原。
- `npm run build` 重新生成了受版本控制的产物（`packages/*/dist/`、`packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`、dashboard-app 的 `dist/`），内容来自未改动的源码。
- 没有动范围外文件，没有 commit / stash / 还原。
- `step-rounds-read.test.ts` 是已有测试文件，只加了一条用例；若测试计划按文件登记则无需新登记，若按用例 id 登记请主线确认。

## 五、遗留

- 读链「断裂」的语义：`TransitionRecordStore.readChain` 的契约是链在中途断裂（祖先文件缺失、内容损坏、runId 对不上、成环）时从断点截止、不抛错（见 `packages/kernel/src/state/transition-record-store.ts:57-67`）。所以「有链头、读链返回的链比实际短（含空）」会让轮次偏小，`readStepRounds` 不会报错；spec 措辞「读不到时 SHALL 报错」在实现里落实的是「没装配读取依赖」与「读取抛错（文件系统故障）」两支，没有覆盖「链被截断」。这是 store 既有契约，改它超出本任务范围，也与主线说的「措辞改了、语义与已落地实现一致」相符；如果将来要覆盖，需要在 `chainTransitions` 里核对「链长度 >= 链头 sequence」并相应改 spec 措辞。

```tenon-result
{"result":"done","findings":[{"severity":"low","location":"packages/kernel/src/workflow/step-rounds-read.ts:41","message":"readChain 按 store 契约在链断裂（记录缺失或损坏、runId 不符）时截止不抛错，截断后的链让轮次偏小且不报错；spec 的读不到即报错只落实在没装配 recordStore 与读链抛错两支，未覆盖链被截断。"},{"severity":"low","location":"packages/kernel/src/workflow/step-rounds-read.test.ts:78","message":"新增的读链失败用例在实现已存在时一上来就是绿的，已用临时 try/catch 退回 JSONL 的改动证明它会变红，改动已还原且 grep 零残留。"}]}
```
