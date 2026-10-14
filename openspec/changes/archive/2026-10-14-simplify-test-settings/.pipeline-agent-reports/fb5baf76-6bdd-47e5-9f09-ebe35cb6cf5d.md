# code-size 评审报告(simplify-test-settings)

## 指标摘要
- 探针给出:改动 263 个文件,新增 19076 行,删除 6265 行,单文件最大新增 4975 行。
- 失败原因是 `lines_added` 19076 超过上限 2000。
- 我没有重算这些数字。
- 最大的 4975 行是 `packages/cli/dist/tenon.mjs`,由 `npm run build` 生成,CI 逐字节校验。生成物规模有正当理由,不报。
- 豁免理由是登记者自述,我对照代码确认了这几点:
  - 我读过的生产 TS 文件都在 500 行以内,最大的是 `kernel/workflow/parse.ts` 的 449 行。
  - `protected-writes.sh` 拆出 `trust-command.sh` 后比 main 的 632 行更短,是 628 行。
  - 规模上限本身就是本任务要删的东西。
- 下面列出的文件我都用 Read 从头读到了末行,`kernel/test-system/review-waivers.ts` 的行数除外。

## 逐文件判断

| 文件 | 行数 | 职责 | 重复 | 夹带 |
|---|---|---|---|---|
| `kernel/test-system/trust-store.ts` | 224 | 单一:用户级信任存储的读、验封印、锁内写入、淘汰 | 已读全文,未发现 | 无 |
| `kernel/test-system/catalog-patch.ts` | 198 | 单一:按节点写回目录 | 见下面"catalog-patch 说明",已读全文 | 无 |
| `kernel/test-system/catalog-patch-lines.ts` | 90 | 单一:按行切分和按区间替换的工具函数 | 已读全文,未发现 | 无 |
| `cli/commands/test-trust.ts` | 289 | 目标构造、信任范围三态、执行前校验、`cmdTestTrust` 四块,偏满但内聚 | 已读全文,未发现 | 无 |
| `kernel/test-system/evaluate-files.ts` | 87 | 单一:改动测试文件的认领、孤儿、未执行检查 | 已读全文,未发现 | 无 |
| `kernel/workspace/test-evidence-files.ts` | 103 | 单一:未跟踪证据文件的判断 | 已读全文,未发现 | 无 |
| `hooks/lib/trust-command.sh` | 153 | 单一:识别命令段是否在替用户做信任决定或改写状态目录 | 已读全文,见下面"trust-command.sh 说明" | 无 |
| `cli/commands/agent-prompt.ts` | 93 | 单一:评审者提示词渲染 | 已读全文,未发现 | 无 |
| `cli/commands/review-waivers.ts` | 261 | 单一:评审请求里待批准项的冻结、列出、批准、审计 | 已读全文,未发现 | 无 |
| `kernel/test-system/catalog.ts` | 306 | 单一:解析、校验、摘要、写出 | 第 150 至 232 行已无字段表粘贴,见"重点核对" | 无 |
| `kernel/test-system/stage-run-set.ts` | 164 | 单一:阶段运行集和 covers 提示 | 已读全文,未发现 | 无 |
| `kernel/test-system/waiver-metrics.ts` | 141 | 单一:豁免旁的指标现算和格式化 | 已读全文,未发现 | 无 |
| `dashboard-app/workspace/testsTabModel.ts` | 309 | 页签投影纯函数,职责内聚 | 有轻微重复,见 low 发现 | 无 |
| `cli/commands/test-run-suites.ts` | 163 | 命令层:参数、运行集、打印、退出码 | 已读全文,未发现 | 无 |
| `cli/test-system/repo-identity.ts` | 142 | 单一:仓库身份三态 | 已读全文,未发现 | 无 |
| `kernel/test-system/levels-codec.ts` | 135 | 单一:levels 解码和写出 | `decodeTier` 里五个 `if (name !== 'plan' && ...)` 句式相同,各调不同解码器,不构成可抽取的粘贴 | 无 |
| `dashboard-app/api/testRunTypes.ts` | 134 | 纯类型声明,从 `testSystemTypes.ts` 拆出 | 不适用 | 无 |
| `cli/test-system/report-md.ts` | 230 | 单一:报告 Markdown 渲染 | 已读全文,未发现 | 无 |
| `cli/test-system/run-paths.ts` | 102 | 单一:运行记录路径改写 | 已读全文,未发现 | 无 |
| `kernel/test-system/evaluate-kinds.ts` | 92 | 单一:必需种类或类的检查 | `legacyKinds` 和 `levelClasses` 的 `waiver-unapproved` 文案相近,但分支条件不同,不是粘贴 | 无 |
| `dashboard-app/projects/ProjectLevels.tsx` | 85 | 单一:档位只读表 | 已读全文,未发现 | 无 |
| `kernel/test-system/evaluate-v2.ts` | 322 | 编排各检查,已拆出子模块 | 已读全文,未发现 | 无 |
| `kernel/workflow/parse.ts` | 449 | 单一:工作流窄解析器 | 逐行 `if (regex) { ...; continue }` 是既有风格 | 无 |
| `cli/commands/test-run.ts` | 279 | 单一:`tenon test run <change> <test-id>` | 已读全文,未发现 | 无 |

`kernel/test-system/review-waivers.ts`(446 行)我只取得了行数,没有读内容。它接近 500 行上限,在发现里单独列为 low。

### catalog-patch 说明
- `replaceEntry` 和 `replaceItem` 各自生成"替换一段行区间"的 `LineEdit`,前者按键、后者按列表条目,发射函数不同。
- `patchObjectList` 和 `appendToList` 都在末尾追加行,但前者按身份键对上条目,后者只对标量列表追加。
- 这几处是同一算法的不同层,不是复制粘贴。

### trust-command.sh 说明
- 它与 `ack-command.sh` 从 `gate.sh` 拆出同理,是从 `protected-writes.sh` 拆出,拆分方向正确。
- 第 53 至 99 行里,`HOME=` 和 `TENON_RUNTIME_*` 的拒绝分支在 `seen_head=0` 和 `exporting=1` 两个位置各写一次,只有 2 处。
- `pipeline_segment_takes_trust` 里(第 146 至 147 行)和逐记号函数(第 59 至 60 行)都有"换空格再按空白切"的两行。
- 约 3 行的重复,抽一个函数收益有限。
- 没有夹带。

## 重点核对
- **catalog.ts**
  - `byCodeUnit`、`suiteExecFields`、`serviceExecFields` 各一份。
  - `catalogExecDigest`(第 150 至 159 行)和 `suiteExecEntry`(第 199 至 212 行)都调用它们,没有再列一份字段表。粘贴重复已消除。
  - 遗留一处 `parseTestCatalog` 里套件和服务的"id 查重"循环(第 50 至 73 行),结构相同、约 10 行,是小重复,不影响结论。
- **changedRepoPaths**:定义只在 `claim.ts:24`。`stage-run-set.ts` 第 43 行和第 128 行以及 `claim.ts` 内部都调用它。路径归一只有一处。
- **suites-without-covers**
  - 文案只在 `stage-run-set.ts` 的 `suitesWithoutCoversNotice`(第 154 至 164 行)里。
  - `evaluate-v2.ts:87` 和 `test-run-suites.ts:117` 都只调用它。
- **指标格式化和清洗**
  - `formatWaiverMetrics` 和 `shownName` 只在 `waiver-metrics.ts` 里。
  - `report-md.ts:171`、`review-waivers.ts:142`、`agent-prompt.ts:60` 和 `agent-prompt.ts:65`、`evaluate-inline.ts:67` 都调用它。
  - 清洗用的 `waiverReasonText` 来自 `step-test-waivers.ts`,没有被重新实现。
- **testsTabModel.ts**:`legacyRows`(第 138 至 160 行)和 `levelRows`(第 180 至 202 行)各有约 5 行相同。
  - 相同部分是 `planSuites`、`waivers`、`declared`、`notApplicable`、`verdicts`。
  - `met` 和 `blocker` 的判定逻辑不同。
  - 这是轻微的近似重复,可以抽一个小助手。

## 发现
- 没有 `high`,没有夹带。
- 豁免成立:总行数超限的原因是 dist 生成物、测试夹具和一次性迁移。我读过的生产文件都在 500 行以内。
- 以下几条都是 `low`:
  - `testsTabModel.ts` 里有 5 行近似重复。
  - `parse.ts` 449 行,接近 500 行。
  - `kernel/test-system/review-waivers.ts` 446 行,接近 500 行,我只取得了行数。
  - `test-trust.ts` 289 行,含四块职责,可考虑把 `printStatus` 和 `confirm` 拆出。

```tenon-result
{"findings":[{"severity":"low","location":"packages/dashboard-app/src/workspace/testsTabModel.ts:138-160,180-202","message":"legacyRows 与 levelRows 各有约 5 行相同(planSuites/waivers/declared/notApplicable/verdicts),可抽一个小助手"},{"severity":"low","location":"packages/kernel/src/workflow/parse.ts","message":"449 行,接近 500 行上限,后续增长应先拆分"},{"severity":"low","location":"packages/kernel/src/test-system/review-waivers.ts","message":"446 行,接近 500 行上限,后续增长前可拆出一部分;只取得了行数"},{"severity":"low","location":"packages/cli/src/commands/test-trust.ts","message":"289 行,含目标构造、信任范围、执行前校验、cmdTestTrust 四块,可考虑把 printStatus 与 confirm 拆出"},{"severity":"low","location":"packages/cli/dist/tenon.mjs","message":"新增 4975 行为 npm run build 生成物,CI 逐字节校验,规模超限有正当理由,不计为拆分问题"}]}
```
