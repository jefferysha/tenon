# CONTRACT — 数据格式 / CLI 面 / 并行开发规则

> 本文件 + `packages/kernel/src/types.ts` 是并行开发的单一契约。改契约 = human gate（见 LOOP.md）。

## 1. Canonical state 与 `.pipeline.yaml` adapter

- **唯一真相/唯一提交点**：`openspec/changes/<name>/.pipeline-run/current.json`。它保存当前
  N-1-compatible wire state、hook 热路径五字段快照、mutation reason/effects 与 state digest；
  同字节 immutable twin 位于 `.pipeline-run/revisions/<revision>-<revisionId>.json`。需要在旧 wire
  闭集之外表达的逻辑字段使用 immutable companion；当前
  `pre_verify_review_result` 位于 digest-anchored
  `.pipeline-run/pre-verify-review/<revision>-<revisionId>.json`，`review_acknowledged_via` 位于
  `.pipeline-run/review-acknowledged-via/<revision>-<revisionId>.json`（仅非 `unknown` 时发布，
  以 revision/revisionId/stateDigest 绑定；缺失读作 `unknown`），`start_sha` 位于
  `.pipeline-run/start-sha/<revision>-<revisionId>.json`（仅非空时发布，绑定方式相同；缺失读作空串）。三者都不进入 wire
  `state.fields`、mutation/TransitionRecord effects 或 `.pipeline.yaml`。读取端只有在验证
  current/twin、anchor 与 companion 身份/摘要一致后，才 hydrate 为完整逻辑 `PipelineState`；
  因此物理 revision 本身不宣称自包含这些逻辑字段。
- **发布顺序**：所有公开 `StateStore.write()` 自行取得同一把 change 锁；transition 先独占发布
  `TransitionRecord`，普通 mutation 直接构造下一 revision；随后按
  `digest-anchored companion → immutable revision → current.json` 发布，`current.json` 的
  tmp+rename 仍是唯一 commit。最后才 best-effort 刷新 `.pipeline.yaml`。TransitionRecord、
  companion 或 revision 已落而 current 未换都只是不可达孤儿；current 已换而 YAML 写失败是已提交
  状态，返回 projection pending，不得回滚或伪装失败。
- **完整性**：current 必须通过 closed wire schema、SHA-256、immutable twin 字节一致、直接 previous
  身份与 effects 真实 diff 校验；声明 companion anchor 且 companion 存在时，还必须验证精确
  revision/revisionId 与 payload digest，错配或篡改均 fail-loud。companion 缺失统一降为
  `pending` 失败关闭，绝不继承旧 `pass`。transition mutation 还必须绑定 `transitionRecordId`
  与该 record 精确字节的 `transitionRecordDigest`；当前 revision 即使是普通 set/cas，也必须验证
  直接 previous revision 若为 transition 时所绑定的 record，后续 mutation 不能让损坏的审计 head
  重新变得可读。history 冷路径遍历全部 immutable revisions，
  任一祖先 revision/record 损坏或 companion 身份/摘要不符均 fail-loud，不用 JSONL/YAML 补洞。
- **兼容断代**：只有 `current.json` 目录项完全不存在时才读取 legacy `.pipeline.yaml`。current 一旦出现，
  即使损坏、不可读、是 symlink 或读取中消失，也绝不授权 YAML fallback。首次官方写把 legacy YAML
  固化为 migration revision 0，再提交目标 mutation。
- **YAML adapter**：`.pipeline.yaml` 继续按下方窄格式输出，服务旧工具；每份投影带 revision/id/digest
  元数据。缺失、已知 stale、legacy-compatible 可幂等前滚；未知 drift 不自动覆盖。运维入口：
  `pipeline state status <change>`、`repair-projection`（未知 drift 需显式 `--force-canonical`）和
  `import-legacy`（用户明确选择把 YAML 作为一条新 canonical mutation 导入）。server 项目扫描只自动
  修复可证明的前滚态，并把损坏/未知 drift 暴露为项目错误。
- **Hooks**：纯 Bash hooks 共用 `hooks/canonical-state.sh` 读取 compact current 的 `hookState`；canonical
  无效时 fail-open 跳过该 change，但不反向读 YAML。只有从未迁移的 change 才走 legacy grep。
- **未来 canonical schema 兼容面**：kernel 解码器遇到 `current.json.schemaVersion` 高于本 runtime
  支持值时抛出结构化 `UnsupportedRunStateVersionError(foundVersion, supportedVersion)`，不得把它
  降级为普通 corruption 或尝试 YAML fallback。`GET /api/snapshot` 在项目级返回至多 100 条
  `compatibilityIssues[]`（`kind=unsupported-canonical-version`、Change 名、found/supported 版本和
  `action=upgrade-runtime`），对应 Change 不进入 `changes[]`，项目 `ok=false`；超过上限时仅返回
  排序后的前 100 条，并设置 optional 字面量 `compatibilityIssuesTruncated: true`，不得把 overflow
  写入普通 `error`。前端只在恰有 100 条 issue 时接受该信号，并以当前语言说明仍有 Change 未列出。
  普通 corruption 可与该数组同时存在，`error` 优先决定项目不可达，不能被升级提示掩盖。仅有未来
  版本问题时 Dashboard 可只读展示已成功解码的 sibling Changes 与升级提示；Machine 继续扫描这些
  sibling 的真实风险，不把 compatibility-only 项目误报为损坏。唯一允许的动作是刷新 snapshot；
  snapshot 请求错误按当前 locale 与 HTTP status 展示，并通过同一 refresh 通道提供通用重试；
  创建、transition/cancel、AFK 和 Workbench 写入口全部继续要求 `project.ok=true`。旧 server 省略
  `compatibilityIssues` 与 `compatibilityIssuesTruncated` 时前端保持兼容。

### 1.1 `.pipeline.yaml` 格式契约（与老内核字节级兼容）

- 位置：`openspec/changes/<name>/.pipeline.yaml`（相对项目根）。
- **字段序固定**：见 `types.ts::FIELD_ORDER`（现 51 字段，最末尾是 `start_sha`，见第 5 节第 16 条；2026-07-11 v5 T4 决策 G **末尾追加**
  `automation_current_phase`——沙箱内当前阶段，automation runner 检出 [TRANSITION] 行运行期回写、
  run 结算清空；老文件缺该行读作空串，容忍不变。新字段必须末尾追加：老版本窄解析器把首个未知
  key 起整段当 opaqueTail，插中段会让老读者回写时重复 key 腐蚀文件，见 types.ts 注释。
  2026-07-13 F-b **末尾追加** `automation_cause`——失败成因结构化 tag，automation 写入端按 error
  `_tag` 干净判定落盘（`cancelled`/`conflict`/`timeout`/`verify-fail`/`agent-exit`/`no-op` 开放集，
  空串=未知，读取端 fallback regex 分类 `automation_last_error` 文本），与 `automation_last_error`
  **同写同清**；老文件缺该行读作空串，容忍不变，末尾追加理由同上）。
  review-gate v2 五字段之后继续末尾追加逻辑字段 `pre_verify_review_result`：YAML 精确缺少这一尾
  字段时读作 `pending`；缺任意其他普通字段仍 fail-loud，不能借迁移兼容放宽闭合 schema。
  WorkflowRun schemaVersion=1 的物理 `state.fields` 为保持真实 N-1 runtime 可回滚而不扩张旧闭集；
  该逻辑 canonical 值写入 `.pipeline-run/pre-verify-review/<revision>-<revisionId>.json` 不可变
  companion，并由 wire `opaqueTail` 中的内部 anchor 把 result 摘要纳入 `stateDigest`。companion
  在 current 提交前发布，缺失按 `pending` 失败关闭，身份/摘要不一致 fail-loud。
  `.pipeline.yaml` 同样投影 N-1 wire 闭集：省略该逻辑字段，并在内部元数据后保留同一 anchor
  comment；否则真实上一发行版会把未知尾字段后的 run/projection metadata 一并当作 opaqueTail，
  导致可读但首次合法 mutation 因 projection drift 失败。当前 runtime 的 `get`、guard 与
  Dashboard 从 canonical companion 恢复逻辑值，不依赖 YAML 展示。
  写回时严格按此序全量输出，缺省字段写空串。
- **任务结果字段 `task_result`**（`FIELD_ORDER` 末尾，在 `max_rounds` 之后）：取值 `finished` | `escalated` | `terminated`（界面：完结 / 已升级 /
  已终止），空串 = 任务还没有结束。**系统专写**：只由 `tenon task finish` / `tenon task terminate` 在移动任务目录之前经状态仓库写一次修订；
  `tenon set|set-many|cas` 一律拒写（exit 1，文案点名这两条命令），`tenon get` 照常可读。移动失败时再写一次修订清回空串，所以失败后
  任务仍是原来的活跃任务、没有残留结果。空值不进 wire `state.fields`，也不进 `.pipeline.yaml` 投影（同 `max_rounds`，
  `state/omit-when-empty-fields.ts`），没有结束的任务逐字节不变；已知限制同 `max_rounds`：写过 `task_result` 的任务（即已归档的任务），
  N-1 运行时读 canonical 会因闭集校验失败而读不了。读取入口 `readTaskResult(dir)`（kernel）读不到时返回 `undefined`、不抛。
  「已结束」只由目录位于 `archive/` 判定：写完结果、移动目录前进程被打断时，活跃任务上会残留一个非空 `task_result`，它不表示任务已结束，
  `tenon task finish|terminate` 在锁内入口先把它清回空串再继续。
- **领域字段 `domain`**（`FIELD_ORDER` 末尾，在 `task_result` 之后）：`tenon init --domain <track>` 写入的同一工作流里另一条分支 id，
  空串 = 没记。轻量任务风险升级时 `escalate.then` 读它点名新任务的轨道；读取处校验它仍是当前可选分支，不是就当作没记、列出可选分支。
  `tenon set` 可改。空值不进 wire 与 `.pipeline.yaml` 投影（同 `max_rounds`）；已知限制同 `max_rounds`：记过 `domain` 的任务，
  N-1 运行时读 canonical 会因闭集校验失败而读不了。
- **标量引号契约（单层去引号）**：读取时若值首尾为同一对 `"` 或 `'` 则剥一层，不递归；写入时
  值含 `: `、` #`、换行或首字符为引号 → 拒写（fail-loud，对齐老内核 yaml_set 四闸）。
- **列表字段**（`scope` / `related_files` / `spec_scope` / `depends_on`）：块序列格式
  （`key:` 换行 + 两空格 `- item`），空列表写 `key: []`。
- **历史区容忍**：文件尾部可能出现老内核的 `tools_history:` / `prompts_history:` /
  `transitions_history:` base64 区块。lite **读时跳过、写回时原样逐字保留**（当不透明块处理）。
  lite 自己的历史写 `openspec/changes/<name>/.pipeline-history.jsonl`
  （每行 `{"ts":ISO8601,"kind":"transition|set|init|tool|prompt|import","field"?,"from"?,"to"?,"by"?,"raw"?,"transitionRecordId"?}`；
  tool/prompt/import 三种 kind 与 raw 字段是 `pipeline import` 老仓历史迁移的加法扩展，
  iteration-8，不影响 .pipeline.yaml 兼容；`transitionRecordId`（W1 第二增量，见下方"不可变
  TransitionRecord"条目）存在时表示这一行只是某条 canonical TransitionRecord 的兼容投影，
  不是 legacy 真相源）。
- **解析器**：kernel 手写窄解析器（仅支持上述子集），**禁止引入 yaml npm 包**——
  通用解析器的引号/锚点语义会悄悄偏离老内核三读取器契约。
- **内部提交元数据**（W1 第二增量：WorkflowRun 持久化提交接缝，2026-07-16）：`FIELD_ORDER`
  字段与 opaqueTail 之间可能出现固定三行、要么全有要么全无的保留键——**不进 `FIELD_ORDER`，
  不可被 `pipeline set` 改写**：
  ```
  pipeline_run_id: <uuid>
  pipeline_transition_sequence: <非负整数>
  pipeline_transition_head: <recordId 或字面量 "null">
  ```
  解析规则同"末尾追加"先例：老版本窄解析器遇到首个未知 key（`pipeline_run_id`）起整段当
  opaqueTail 逐字保留，混版本读写无损。老 change 缺这三行 → `runMetadata` 为 `undefined`；
  显式调 `establishRun()` 会立即生成新身份并落盘（幂等，已有 `runMetadata` 则原样返回，不重新
  生成）；单靠 `transact()` 访问（不落到 `commit()`）不会持久化——本次 callback 内生成的临时
  身份只存在于这次调用的内存里，callback 若不提交就直接返回，下次再 `transact()` 会重新生成
  一个不同的临时 id，**不能**把"调用过一次 transact()"等同于"身份已落盘"。新 change 由
  `WorkflowRunRepository.initChange()` 负责：在 `openspec/changes/` 下的私有 sibling 中一次性构建
  canonical revision 0、YAML adapter、locale、governance、document ledger、default OpenSpec
  proposal/design/tasks 与（若提供）custom workflow 首态。同名初始化先经独立名称锁串行化；
  发布再以原子 `mkdir` 独占最终 Change 名称，逐项使用 hard-link no-replace，
  `.pipeline-run/current.json` 最后成为官方读取
  提交点；任何内部写入或校验失败只回滚本次创建且 inode 身份未变化的目录项，不会
  暴露可读的缺文档、缺 ledger、缺身份或 provisional default/open Change。最终路径若被
  并发创建为普通目录或 symlink，发布必须 fail-loud 并保留竞争方目录项，绝不删除、替换或沿
  symlink 写入仓库外。详见
  `packages/kernel/src/state/{run-metadata,run-revision-store,store,workflow-run-repository}.ts`。
- **治理身份 sidecar**：`documentProfile`、`documentGovernanceFingerprint` 与
  `workflowPlanFingerprint` 不再写进 strict canonical `runMetadata`，而是固定在
  `openspec/changes/<name>/.pipeline-workflow-governance.json`。新 runtime 在读状态时校验
  `run_id` 后合并这三项；旧 runtime 会忽略 sidecar，仍能读取 canonical Change。旧 canonical
  revision 曾写入这三项时，新 runtime 保持只读兼容，并在下一次真实 state commit 发布不含这些
  扩展字段的新 current；不可变历史不回写。这样 workflow/document policy 身份继续 fail-loud，
  同时真实 N-1 runtime rollback 不会因未知 `runMetadata` 字段把整个 Change 判损坏。
- **Document Presentation Registry**：`templates/documents/registry.v1.yaml` 同时声明文档模板、
  kind/path/section/layout 与 default workflow 的稳定 step id；`locales/{zh-CN,en}.yaml` 提供对应
  标题和 step label。运行时只能消费 `document-presentation.generated.ts` 并解释其 layout 指令，
  不得在 renderer、CLI 或 Skill 再维护第二份 section 图或默认阶段标签。
  `check:document-templates` 必须校验 schema、layout 引用、locale parity 与生成物新鲜度。
- **overwrite scaffold 可恢复提交**：事务所有权精确到目标 spec directory，stage、backup 和
  持久 transaction receipt 都锚定在可信项目根内；receipt 记录 owner pid 与提交状态。目标父目录
  在提交前复核普通目录 identity，symlink 或父级替换不能把提交重定向到仓库外。正常异常立即回滚，
  进程崩溃后下一次调用先独占恢复；
  若旧 envelope 移走后正式路径被第三方占用，则 fail-closed 并保留 lock/stage/backup，不覆盖
  未知内容也不丢失恢复证据。复制前冻结目标目录摘要与 identity，stage 必须与快照一致；
  original 移到 backup 后再次做 CAS 校验。事务期间目标目录内未受管文件发生 open-FD 更新时，
  新字节同步进 stage，并保留原 inode backup；目标目录外 sibling 命名空间从不移动。活跃 owner
  同样 fail-closed。
- **Ship 主规格迁移硬门禁**：`spec-migration-applied` typed guard 属于 default 与受 OpenSpec
  治理 custom workflow 的 Ship 出口政策。存在 `migration/spec-application.json` 时，仓库维护者在
  发布前以 owner-lock/inode 绑定的目录 FD 事务应用历史迁移：observed 内容先形成独立恢复快照，
  rename 线性化后再次核验移走 inode，再用 hard-link no-replace 发布 expected bytes；竞争方抢占
  正式路径、同 inode 漂移或 lock owner 更换时都拒绝覆盖。经代码审查的成功 result 绑定 Change、
  receipt digest、delta、目标路径和 after digest。该一次性维护工具不属于 managed plugin release，
  打包 Skill 不在用户项目调用它；`pipeline check` 与 `pipeline transition` 只读取已提交的同一机器
  证据。能力缺失、结果缺失、身份或摘要漂移均失败关闭。
- **review-gate v2 receipt**：`review_gate_phase` / `review_gate_status` / `review_gate_event` /
  `review_requested_at` / `review_acknowledged_at` 是 `FIELD_ORDER` 的受保护字段。只有
  `pipeline review request|acknowledge` 与成功的 transition 可以写入/消费它们；通用
  `set` / `set-many` / `cas` 必须拒绝。它记录的是“离开当前 review phase 前”的 exact-phase-and-event
  review 确认，而不是“刚进入 phase 就暂停”；例如 `verify-fail` 的确认绝不能授权 `verify-pass`。轮次内回退边除外：
  受轮次上限约束的步骤（评审门且有回退边）上，轮次还没用完时走回退边不需要评审回执，直接 `tenon transition`
  （转换用例在同一把 Change 锁内与轮次门读同一份轮次；宿主没有提供轮次读取时仍要回执）；这次转换照常清空
  当前步骤上任何待确认或已批准的回执，且不记录评审确认类的交互效果。前进边、放弃边、剩余阻断与测试豁免的
  人工确认不变。常规确认
  由 `acknowledge` 记录；用户明确的 Change 绑定持续授权只能在真实 review 证据完成后经
  `acknowledge --delegated` 记录来源与授权时间，不能跳过该 receipt 或任何 guard。
  每个 request 还在 Change 锁内写 `.pipeline-review-gate-binding.json`：它绑定排除上述五个 receipt
  字段（以及派生 interaction projection）的 canonical decision digest、exact phase/event、requestedAt
  与 run identity。缺失、损坏或 digest/visit 漂移的 binding 一律 fail-closed，不参与也不读取 interaction
  projection 做授权判断；pending/approved receipt 可通过 fresh request 撤销旧决定并重新绑定后恢复。
  Sidecar writer 的 canonical bytes 固定为单行 `JSON.stringify(binding) + "\n"`；authorization reader
  只接受不超过 16 KiB 的严格 UTF-8 普通文件，并复用 `O_NOFOLLOW | O_NONBLOCK` 的 bounded fd reader，
  在 proof/read 前后核对 parent realpath、target/fd 的 dev/ino/size/mtimeNs/ctimeNs。字段缺失/未知、
  duplicate key、字段重排、额外空白/trailing bytes、symlink、目录、超限、替换、同 inode 改写、增长
  或读取中消失均拒绝，错误不得回显 sidecar 内容。没有可信 binding 的 legacy pending/approved receipt
  不自动 backfill；必须对相同 exact phase/event 发起 fresh `review request` 产生新的 requestedAt、pending
  receipt 和 sidecar 后再 acknowledge，interaction projection 不能作为授权 fallback。
- **不可变 TransitionRecord**（同上）：`openspec/changes/<name>/.pipeline-transitions/
  <sequence 零填充 6 位>-<recordId>.json`，每条记录一个文件，写入用「临时文件 + `link()` +
  `unlink()` 临时文件」而非 rename——`link()` 目标已存在时原子失败（`EEXIST`），存储层强制
  不可变，同 sequence+id 不能被覆盖。记录写入本身不是提交点：先写记录（此时是未被引用的
  孤儿）、再发布绑定其 id+digest 的完整 revision，最后一次 `current.json` rename 同时提交新 fields
  与推进的 run 元数据（sequence/head），那次 rename 才是唯一提交点。`GET /api/change/:name/history` 从 `transitionHead`
  沿 `previousRecordId` 回溯这条链，是 transition 审计的真相源。`.pipeline-history.jsonl`
  继续承载 `set`/`init`/`tool`/`prompt`/`import`，以及所有没有 `transitionRecordId` 标记的
  transition 行（legacy/import/非 canonical writer 产生，链建立前后都原样保留）——**合并边界
  是逐条来源标记，不是时间戳**：每次真实 canonical commit 收尾写 JSONL 时都带上
  `transitionRecordId = record.id`（`HistoryEntry.transitionRecordId`，见 `types.ts`，唯一
  构造点是 `packages/kernel/src/state/history.ts` 的 `transitionRecordToHistoryEntry()`），
  `readChangeHistory()` 读取时只保留"无此标记"的 JSONL transition 行 + canonical 链上的记录——
  **这一步纳入/排除判定不比较任何 `ts` 字符串**（此前用链首记录时间戳做切分的版本已废弃——
  同秒冲突、时钟回拨、head 文件缺失导致链空、晚于链建立才执行的 `pipeline import` 都会让时间戳
  边界出错，2026-07-17 codex 架构评估否决）。最终展示顺序仍然要排序，但不是简单拼接后整体按
  `ts` 排序：canonical 链本身的顺序真相是 `sequence`（`readChain()` 回溯出的因果顺序，权威、
  不受时钟影响），只有 JSONL 遗留条目之间、以及遗留条目与 canonical 记录的交叉排位才用 `ts`——
  两指针合并（`mergeCanonicalAndLegacy()`）保证 canonical 记录之间永远不会互相比较，即使某条
  canonical 记录的 `observedAt` 因时钟回拨而"看起来"早于它前一条，展示顺序仍然保持 sequence
  顺序不被打乱（2026-07-17 codex 架构评估同一轮点名）。详见
  `packages/kernel/src/state/transition-record-store.ts` 与 `packages/server/src/transition.ts`
  的 `readChangeHistory()` / `mergeCanonicalAndLegacy()`。

## 2. 相位与转换

- 相位：重型轨道（`default` 的 `pm` / `frontend` / `backend`）为 `open → explore → spec ⇄ build ⇄ verify → ship → archive`；
  轻量轨道（`lite`）为 `open → build → verify → done`，另有终态 `escalated`（`scope-expanded` 的放弃边）。
- **按 YAML 执行**：新建的任务一律按冻结的工作流 YAML 的步骤、出边、离开条件与动作执行，代码里不再有以工作流名或阶段名为键的
  转换表、事件策略或阶段出口规则。通用离开条件有三个：`tasks-through-step`（`tasks.md` 里截至本步的任务已勾选）、
  `not-afk-queued`（未在 AFK 队列里）、`dependencies-ended`（`depends_on` 都已结束），写在步骤或前进边的 `guards` 里，能力经
  `GuardInput` 注入，缺能力失败关闭。离开条件不满足时一次列出全部、退出码 `2`；`tenon advance` 只自动走唯一的前进边，不走回退边
  与放弃边。新任务不再有 `build_mode`、`isolation`、`direct_override`、`branch_status` 这几个决定字段及其检查（升级前创建的任务
  照旧）。旧 phase-manifest 引擎只服务快照里记着旧执行模型的在途任务，按快照执行，下个版本删除。
- **Requirements rollback**：build 中发现批准后的需求/设计语义变化时，唯一合法路径是
  `requirements-changed`（build→spec）。该回退不要求先伪造已 stale 的前向文档证据；进入 spec 后
  必须由 `pipeline-spec` 重登记 proposal/design/tasks 的当前 SHA、补读取收据并重新通过 spec review。
- **Phase-scoped Todo gate**（通用离开条件 `tasks-through-step`）：有标准阶段标题的 `tasks.md` 在出口只统计截至当前 phase 的未完成项；
  未来 phase 任务仍由 UI 展示，但不反向阻塞。无阶段标题的历史文件保留“build 全清单完成”兼容语义。
- **Build pre-Verify readiness 门**：`pre_verify_review_result` 初始为 `pending`（字段名为兼容 ABI
  保留）。Build 必须对完整待冻结 diff 建立 capability / ADR / plan / 调用方 / 兼容边界覆盖表，并
  跑完适用 build、type、unit/integration、lint、静态检查与 release gate；这些是实现反馈，不产生
  Review verdict，也不创建或消耗 Review attempt。只有 readiness 证据完整时才可置 `pass`。
  `build-complete` 硬性要求该字段为 `pass`；`spec-complete`、`requirements-changed` 与
  `verify-fail` 都会重置为 `pending`。若通过后交付面再变化，Build 协议要求立即重置并重跑 readiness。
- **有限聚合 Review**：冻结候选后的 Standards/Spec、安全、E2E/API/browser/visual 与发布候选验收
  都是同一个 Review attempt 的 lanes，不得各自计次或形成独立循环。Workflow 通过版本化
  `review_budget` 配置每个 scope 的有限上限；默认上限为 2。每轮必须完成冻结的 required lanes 并
  一次性聚合，Critical/High/Medium 全部清零才可通过。预算耗尽后停止自动 Review，等待显式人类处置。（`review_budget` 键已随评审车道删除，解析时报「已删除」；现行的上限是步骤的
  `max_rounds`，见第 5 节第 15 条。）
- **Build→Verify 可复验基线**：状态字段仍命名为 `build_sha` 以兼容既有 state ABI，但新 Build 必须写入
  `build:v1:<git|workspace>:<revision_hash>:<repository_hash>:<worktree_hash>` typed token。三个摘要
  是 domain-separated SHA-256；token 不含绝对路径、prompt、credential 或裸 SHA。新任务不再有「怎么隔离」这个要填的决定：
  状态里没设 `isolation` 就按 `in-place` 取（`effectiveBuildIsolation`），`tenon init` 在任务 worktree 里建任务时预设
  `isolation=worktree`。类别只由 kernel `expectedBuildRevisionKind(isolation)` 判定（CLI、Dashboard 流转、Dashboard 快照、
  kernel 捕获与复核共用）：`isolation=worktree` 与 `isolation=in-place` 绑定排除 `.git`、依赖、OpenSpec/文档证据、
  pipeline 控制文件与测试缓存后的 `workspace:sha256:<64 hex>` 内容指纹（`workspace` 类），因为任务 worktree 里的实现在
  Build 出口时常常尚未提交；升级前创建、显式写过 `isolation=branch` 的任务仍以物理 Git common-dir/worktree identity 绑定
  object ID（`git` 类）。身份（物理 Git common-dir + worktree 顶层目录与 git 目录）对 worktree 任务同样绑定该 worktree：
  同一任务在别的检出里复核得 `worktree-mismatch`。类别与隔离方式不符（例如 `isolation=worktree` 却带 `git` 类令牌，升级前
  手动设置过 `worktree` 的旧任务）得 `isolation-mismatch`，回 Build 重新捕获。旧裸 Git SHA
  或旧裸 workspace baseline 不会 backfill，必须回 Build 重新捕获。`verify-pass` 会重算当前 identity/
  revision，并用 validated canonical transition head、唯一 `build_sha` effect 与当前 Verify-like step
  证明来源；缺失、非法、漂移、能力/来源无法证明都返回 stable
  `verify-build-revision-untrusted`，remediation 为 `return-to-build-and-capture-current-revision`，
  只投影 closed reason 与 `sha256:` state/revision hash。worktree / in-place 绝不要求或伪造 commit；工作区能力缺失或
  返回非规范值时 build-complete 与 readiness 均 fail-closed。
- 合法转换与评审门来自任务冻结的工作流 YAML（步骤出边与 `gate: review`）；`templates/manifest.yaml` 的 phases / transitions /
  `review_phases` 只服务快照里记着旧执行模型（phase-manifest）的在途任务。
- 门 marker 文件（项目根）：`.pipeline-pending-confirm` / `-review` / `-interaction`，
  存在且 age ≤ 分级 TTL 视为新鲜 → hook 拦截；陈旧 marker 由 gate.sh 顺手清除。
  TTL 分级（BACKLOG #13，对齐老内核 pipeline-gate.sh；TS 侧单一数值真相源
  `types.ts GATE_TTL_MS`，bash 侧 gate.sh/statusline.sh/session-start.sh 镜像）：
  **confirm 300s**（漏确认安全网，爆炸半径 5min）；**review / interaction 1800s**（跨整个
  决策 phase，缩短会中途误清 → 绕过强制复核）。边界同老内核：age > TTL 才陈旧。
  **子代理**：宿主在子代理里触发的 PreToolUse 输入带 `agent_id`；`-confirm` / `-interaction` 约束的是主线「先问用户再产出」，
  子代理没有提问工具，这两类 marker 不拦带 `agent_id` 的调用（也不清 marker）。`-review` 不在此列，对子代理照拦（人工确认不能被绕过）。
  **待处理期间的只读放行与提示**：三种 marker 下，由引号外的 `|` `||` `&&` `;` 连接、每段都是 `cd` 或严格只读命令的组合命令放行
  （`hooks/lib/read-only-command.sh`，失败关闭：引号外的重定向、后台 `&`、换行、命令替换与变量展开（含 `$IFS`）、引号不闭合、超过 2048 字符一律算非只读；
  丢弃输出的 `>/dev/null`、`2>/dev/null`、`&>/dev/null`、`2>&1` 不算重定向）。只读名单里带写文件或执行程序参数的形态被收紧：
  `git diff|log|show --output`/`--ext-diff`/`--textconv`、`rg --pre`/`-z`/`--search-zip`、`sed -n` 的非行号区间打印、
  `file -C`/`--compile` 均非只读。评审 marker 下访问本机
  Dashboard 控制面或其凭据的命令（自审批候选）排在只读放行之前拦截；形如 `tenon transition <change> <event>` 的单条命令
  （无 shell 元字符，且 `<change>` 是 marker 所属的本任务）放行，交给 CLI 判定——CLI 照旧拒绝缺回执的前进边与轮次用完后的回退边，只放行轮次内的回退边；确认与交互 marker
  下这条命令照旧被拦。拦截提示按 marker 种类区分：评审 marker 的提示写明任务与事件，要求把产出摆给用户，列出放行语与 Dashboard
  确认（`tenon dashboard --open`），不再提 AskUserQuestion；确认与交互 marker 的提示保留 AskUserQuestion / ToolSearch / 放行语的说法。
- **交互 marker v2（按会话归属）**：`.pipeline-pending-interaction` 首行为 `pipeline-interaction-v2`，随后 `change=`、`session=`、`skills=`、`requested_at=`。`session` 非空只属于该会话；`session` 为空而 `change` 非空属于「本会话任务为该 Change」的会话；两者皆空属于全部会话（宿主不给 session id 时的旧行为）。gate 只拦归属方；`confirm-clear.sh` 与 `confirm-clear-prompt.sh` 只解归属本会话的标记，InteractionConfirmed 只记到本会话任务；旧格式（首行不是协议名，含空文件）见到即删除、不拦截。「本会话任务」由 `hooks/active-change.sh` 的 `pipeline_session_change_dir` 解析：本会话有会话绑定取绑定的 Change；无绑定而共享指针指向的 Change 已被别的会话绑定则没有任务；宿主没给 `session_id` 或该 Change 无人绑定则回退共享指针。放行语只认整条短回复（`pipeline_text_is_approval_phrase`），AskUserQuestion 只看 `tool_response.answers` 的答案值。
- **持续交互授权投影（不是第四道 gate）**：用户在正常对话明确说“后续不用问 / 自主执行完成”后，
  `pipeline session activate <change> --continuous --host-session <id>` 或带合法 `session_id` 的 UserPromptSubmit 会写
  当前用户的 `.tenon/users/<slug>/local/authority`。它是版本化、原子发布、只含 `change/scope/review/issued_at` 的
  Change 与 host-session 双重绑定投影，只有该用户的 `local/active-change` 指向同一 live Change、且 hook
  输入携带同一 `session_id` 时 `interactive-skill-gate.sh` 才会
  识别；格式不完整、换 Change、已归档或撤回均 fail-closed 回到普通 interaction gate。它只避免每次
  读取 `brainstorming` 等交互式 skill 时重复要求低风险确认，同时在 Change history 留下最小化审计行；
  **绝不**清 `-review`、不写 canonical approval receipt、不能自动 transition，也不能替代涉及范围、
  安全、成本或外部状态的实质决策。
- step `gate` 只有 `review` / `auto` 两种；`gate: null` 与缺省是 `auto` 的别名（compile 归一，新编译的 IR 里不再出现 null）。
  `auto` = 本步声明的输出齐全才放行**前进边**（含完结边 `archived`），退回边（`verify-fail`、`requirements-changed`、自定义回边）从不受它约束；
  `build_sha`（`freeze-build-sha` 写入）与 `archived`（`archive-run` 写入）是引擎写入的输出，不进检查。
  已冻结的旧计划保留它当时的 IR：`gate: null` 的旧计划没有输出守卫，旧 `auto` 计划的守卫仍挂在每条出边上，快照读回不重编译。
- `review_phases` / custom `gate: review` 都是**出口**门：完成相位产物并选择 event 后运行
  `pipeline review request <name> --event <event>`，它先原子写 canonical pending receipt、再写
  `pipeline-review-v2` marker（含 phase/change/event/requested_at）。单出口可省略 event；多出口必须显式指定。
  展示产物后，用户明确确认会触发
  `pipeline review acknowledge <name>`，写 approved receipt 并清 marker；`transition` 只消费
  当前 source phase 与 event 都匹配的 approved receipt。dashboard 的显式真人 transition 点击等价于同一确认，
  但 CLI/agent 无法伪造该 flag。旧三行 entry-time review marker 被 hook 作为迁移遗留投影清理/忽略，
  不能绕过 canonical exit check。
  误给的批准在被 `transition` 消费之前可以撤回：`pipeline review revoke <name> --reason <原因>` 在 Change 锁内把当前步 approved 且未消费的回执撤回为同一 event 的 pending（沿用 `review_requested_at` 与绑定），重写 v2 marker，写 `review.revoked` 审计行；只有任务负责人能执行，缺原因、已消费、本就待确认或无回执一律拒绝且不改状态。终端与 delegated 的幂等账本不得让撤销后的重新确认退化成空操作（回执为 pending 时账本里的旧批准记录不参与 replay）。
  default 的 `verify-fail` 是内建回退 event：它校验真实 `verification_report` 与受治理的 OpenSpec
  文档证据，而不错误运行只适用于 `verify-pass` 的成功 guard。自定义多出口 review workflow 必须为每个
  可选 event 定义在该结果下可满足、可审计的前置证据；CLI 永远要求显式选择 event，不会猜测或复用另一出口的确认。
  例外是受轮次上限约束的步骤（评审门且有回退边，如 default 的 verify）：轮次还没用完时，回退边（既非前进边也非放弃边）
  不需要 `review request` 与评审回执，`tenon transition <name> verify-fail` 直接转换（`next` 也直接给 `transition`）；
  轮次用完后回退边的 `review request` 与 `transition` 照旧被拒。轮次内对回退边执行 `review request --event <回退事件>` 仍被接受
  （兼容升级前的流程与 Dashboard「退回到…」），只是 `next` 不再给出它。每次成功转换提交之后，转换用例还会删除绑定本任务的
  `.pipeline-pending-review`（失败只警告、不回滚，标记在 TTL 后自行失效；不碰其他任务的标记）。

## 3. CLI 面（`pipeline <cmd>`）与输出契约

| cmd | 参数 | stdout 契约 | exit |
|---|---|---|---|
| init | `<name> [--workflow <w>] [--track <t>] --preset [--domain <track>] [--in-place] [--json]`；preset ∈ full\|hotfix\|tweak，显式自定义 `--workflow` 时可省略（存 `null`）；有分支的工作流必须带 `--track`，平铺工作流（没有 `tracks:`）不带；`--domain` 把同一工作流里另一条存在的分支记入任务状态字段 `domain`（轻量任务升级时 `escalate.then` 直接点名它）。在 git 仓库的主检出里默认先建 worktree `.worktrees/<name>`（分支 `tenon/<name>`）再在其中建任务；非 git 仓库 / 无提交 / HEAD 分离 / 已在 linked worktree / `--in-place` / `TENON_INIT_IN_PLACE=1` 时原地建立 | 无（`[INIT] 路径` 与 worktree 路径走 stderr；`--json` 时 stdout 一行 `{change,path,worktree,worktree_reason}`） | 0；未知 preset / 缺必填 / worktree 路径或分支冲突 / `--workflow standard\|simple`（提示 `--workflow default --track lite`）/ 不存在的轨道（含已退役的 `standard`、`simple`、`chat`、`free`，列出可选轨道）=1 |
| assess | `--files <paths…> [--workflow <w>] [--track <t>] [--json]`；缺省 `default` / `lite`；只按路径分类、不读文件内容，路径须是仓库内相对路径 | 人读：评估摘要与推荐；`--json`：`{workflow,track,metrics,exceeded,reasons,recommendation}`（`reasons` 形如 `auth_files 1 > 0`；未超限时 `recommendation` 是轨道 id，超限时是列出同一工作流重型轨道的提示） | 0 未超限；3 超限；1 用法错误、绝对路径 / `..` / 指向仓库外的符号链接、读不出是否存在的路径（权限、I/O；只有 ENOENT / ENOTDIR 算不存在，错误里点名路径与原因）、或该轨道没有改动风险阈值（读 `diff-risk` 步骤测试的 `pass.metrics`，不猜阈值） |
| get | `<name> <field>` | 裸值一行；字段缺失/未知 → 空行 | 0；change 缺失/名非法=1 |
| set | `<name> <field> <value>` | 无输出 | 0；四闸/枚举/未知字段拒写=1 |
| set-many | `<name> k=v...` | 无输出 | 同上 |
| cas | `<name> <field> <expect> <new>` | 无输出 | 0；不匹配=3；错误=1 |
| transition | `<name> <event>` | 无（`[TRANSITION] name: old -> new` 走 stderr）；非法/未知事件的首行形状不变（`illegal transition: a -> b` / `未知 event: x`），第二行 `当前 step '<s>' 的合法 event：…`（语言随 `TENON_LANG`） | 0；非法/未知事件=1 |
| check | `<name>` | guard 报告（人读）：步骤 guards ∪ 前进边 guards，一次列出全部未满足的离开条件 | 0 过 / 2 不过 / 1 错误 |
| advance | `<name> [--max-steps <n>] [--dry-run] [--through-gates]` | 反复走唯一的前进边直到撞上评审门、终态或 guard 不过；不走回退边与放弃边（`scope-expanded`） | 0；guard 不过=2；错误=1 |
| review | `request\|acknowledge <name> [--delegated]` | review receipt 状态 | 0 成功；2 投影写/清失败（receipt 已提交）；1 用法/状态错误 |
| status | `[name] [--json]` | 单 change 摘要；`--json` 的 `step.exits[].blockers[]` 另带可选的结构化字段 `subject` / `state` / `count`（客户端据此分类，不解析 `message`） | 0 |
| support bundle | `[--out <path>] [--json]` | 本机脱敏诊断包 `.tar.gz`（版本、doctor、runtime status、配置摘要、最近 Dashboard 日志、hook 耗时；≤ 5 MiB，权限 0600，缺省 `~/tenon-support-<时间>.tar.gz`）；逐项打印包含的文件、截断与脱敏计数；`--json` `{path,bytes,entries,redactions,not_included}` | 0；`--out` 是目录/写失败=1 |
| logs | `[--follow] [--lines <n>]` | Dashboard server 日志 `<state>/logs/dashboard.log`（+ `.1` `.2` 轮转，共 3 个）的最近 n 行（缺省 100），行内凭证再脱敏一次；`--follow` 轮询新增行直到 SIGINT；没有日志文件 → stderr 提示、stdout 空 | 0；`--lines` 非正整数/读失败=1 |
| list | `[--json] [--finished]` | 活跃 change 表，另含建在 `.worktrees/<name>` 里的未归档任务（人读表末列 `WORKTREE`，无则 `-`；`--json` 每行末尾 `worktree` 为该 worktree 的绝对路径，当前根自己的任务为 `null`）；`--finished` 为已结束的任务表（`archived=true`，含已移进 `openspec/changes/archive/` 的完结 / 已升级 / 已终止）`NAME TRACK PHASE STATUS FINISHED_AT OWNER` | 0 |
| task delete | `<name> [--yes] [--json]` | 无（`[DELETE] name` 与 `未提交删除 n` 走 stderr）；`--json` `{change,removed,uncommitted_deletions}` | 0；用法/名/缺任务/身份/记录损坏/失败=1；待确认=2；被阻止=3 |
| task finish | `<name> [--json]` | 无（`[FINISH] name 结果 → 归档目录` 走 stderr）；`--json` `{change,result,archived_dir,ended_at}`；只接受状态机已到终态（完结 / 已升级）的任务，先在任务状态里写 `task_result`、再把目录移进 `openspec/changes/archive/<YYYY-MM-DD>-<name>/`（同名同日追加 `-2`、`-3`，不覆盖）；`spec: openspec` 的轨道由 Tenon 调用 `openspec archive <name> --skip-specs --yes --json`，`spec: none` 的轨道在锁内原子移动；提交由 `step.next` 的 `finish-change.commit` 给出 | 0；用法/名/缺任务/未到终态/移动失败=1 |
| task terminate | `<name> [--yes] [--json]` | 无（`[TERMINATE] name → 归档目录` 走 stderr）；`--json` `{change,result,archived_dir,ended_at,commit}`；任何还没结束的任务，`task_result=terminated`，目录同样移进 `archive/`，**只提交被移动的任务目录**（`chore(tenon): terminate <name>`），任务改过的代码不提交；已到终态的任务拒绝（改用 `task finish`）；目录移动之后审计记录写不进去只在 stderr 给 `WARN:`（HTTP 响应带 `warnings`），任务仍已终止、退出码 0；`delete` / `terminate` / `finish` 同序加锁（项目归档锁 → 任务锁）并在锁内重新评估，同一任务上互斥，后到的一方得到「任务不存在」 | 同 `task delete`（退出码 0/1/2/3） |
| task archive / unarchive | 已退役（「隐藏」已删除） | stderr 提示改用 `task terminate` / `task finish` | 1 |
| user | `[--json]` | `名字 <邮箱> 来源` 一行；`--json` `{user:{id,name,slug,source,trust}\|null, invalid?}` | 0；无身份=1 |
| user set | `<email> [--name <name>]` | 写本机 `user.json` 后同 `user`；`TENON_USER` 覆盖时 stderr 警告 | 0；邮箱非法/写失败=1 |
| owner take | `<name>` | 新负责人 `名字 <邮箱>` 一行；变更时追加 `assignee` history | 0；名非法/无身份/缺任务/写失败=1 |
| owner set | `<name> <email> [--name <name>]` | 同 `owner take` | 0；非当前负责人/邮箱非法=1，其余同 `owner take` |
| test discover | `[--write] [--json]` | 建议套件表（`--write` 追加进 `.tenon/tests/catalog.yaml`，已存在的 id 不覆盖）；`--json` `{catalog,written,suites[{id,state,source,suite}],notes}` | 0；目录无效=1 |
| test catalog show/validate/add/set/rm | `show [<id>] [--json]`、`validate [--json]`、`add [<id>] [--from <方向>] [--service] …`、`set <id> … [--service]`、`rm <id> [--service]` | 目录条目；`validate` 逐条 `catalog.yaml:<行>: …`；写回只替换实际变化的节点所在的行（顶层键 / `suites` 条目 / 条目内的键），其余字节（注释、空行、排版）原样保留，新增追加在所属列表末尾，删除只去掉它自己的行，被改键的行内注释随之丢失；写出前整份重新解析并与预期目录逐键比较，不一致不落盘（新建目录照旧整份写出） | 0；`validate` 有问题=2；用法/目录无效/引用缺失=1 |
| test plan | `<name> [--seed] [--json]` | 计划摘要与各项；`--seed` 只增不减：档位步骤不写套件和测试文件，只报告缺的必需测试类，以及档位要求映射时待映射的场景 / 任务（场景与实现阶段小节的任务要求映射；其余阶段的任务与骨架提示词单列为「可选」，不挡），旧策略只补碰到的套件与必需种类、不再写 `files`；`--json` `{change,state,digest?,plan?}` | 0；计划缺失或被改动=2；`--seed` 无目录/非负责人=1 |
| test register/unregister/waive | `register --auto\|--suite\|--file\|--case+--test`、`unregister --suite\|--file\|--case[--test]\|--waiver <种类\|场景>`、`waive --kind\|--covers --reason` | 一行确认；写入在 Change 锁内读—改—写并更新摘要台账；改动过的测试文件由套件 `files` glob 认领、不逐个登记；`--auto` 只处理本任务改动里没有套件认领的测试文件（孤儿），把该文件的**精确路径**追加进合适套件的 `files`，不放宽 glob、不碰本任务没改动的文件，没有合适套件时报错并给出补套件的命令、不写目录 | 0；计划被改动/校验失败/非负责人=1 |
| test sync | `<name> [--prune] [--json]` | 无套件认领（孤儿）/已不存在/目录已不认领的测试文件与修复命令（被认领的改动文件不再列为未登记）；`--json` `{unregistered,orphans,registeredButMissing,registeredButUnclaimed,unmapped,optionalUnmapped}`（`registeredButUnclaimed` 是 `[{path,suite?,reason}]`，`reason` 取 `no-owner`/`suite-missing`/`glob-mismatch`；`unmapped` 只含要求映射的场景 / 实现阶段任务，`optionalUnmapped` 是不挡的可选任务）。`--prune` 只删计划 `files` 里目录已不认领的登记（有意登记、只有 `kind` 的资源文件保留；套件、用例映射、豁免不动；不读 diff；要求负责人；写入走 `register` 同一条加锁、记摘要、留 `test:plan-write op=prune` 审计的路径），`--json` `{change,digest,pruned:[{path,suite?,reason}]}`，没有可删的项不重写计划 | 0 干净（`--prune`：删了或没有可删的）；2 有待处理；读不到 diff 或目录=1（`--prune`：目录缺失/无效/没有任何套件、计划被手改、非负责人=1） |
| test run | `<name> [--suite <id>]… [--kind <k>]… [--stage [<step>]] [--all] [--changed] [--json]`；旧形式 `<name> <test-id>` | 摘要（每套件一行、前 10 条失败用例、服务、产物位置、出口检查）；`--json` `{run_id,step,result,chain,record_path,artifacts_dir,legacy,gate,record}`；`--stage` 只跑目录套件（运行集与 `status` / `check` 求值用的阶段运行集一致，由步骤档位、目录与本任务改动决定），旧内联测试仍走 `<name> <test-id>`；本阶段按档位没有要运行的套件时如实说明并以 0 退出、不写运行记录 | 0 全部通过；2 有失败（记录已写）；1 用法/环境错误（无记录） |
| test baseline | `<name> --suite <id> --run <run-id>`；旧形式 `<name> <test-id> --run <run-id>` | `[BASELINE] 套件 @ 画像：n 项指标 ← run <id>`；写 `.tenon/tests/baselines/<套件>/<画像>.json` 并追加用户 `audit.jsonl` | 0；运行未通过/不在当前链上/无指标=1 |
| test known | `add --suite --test --reason --expires [--link]`、`rm --suite --test`、`list [--json]` | 一行确认或清单（过期项标出） | 0；参数非法/清单无效=1 |
| test report | `<name> [--step <id>] [--write <path>] [--locale zh-CN\|en]` | 验证报告测试段：旧步骤测试表（`tenon:tests:*`，仅有内联测试时）+ v2 块（`tenon:test-report:begin/end`：追溯矩阵/套件与各套件最新 run_id/基准/flaky/阻塞）；`--write` 只替换各自标记区间 | 0；写目标非法=1 |
| verify | `--ci (--change <name>\|--all-open\|--since <ref>) [--step <id>] [--format text\|json\|sarif\|markdown] [--out <file>] [--also <format>=<file>]… [--candidate error\|warn\|off] [--require-anchor]` | 在没有用户本机封存的 CI 里对已提交内容独立重算：每个用户目录的记录链与记录自洽、计划 ↔ 记录 ↔ 目录、当前步骤策略下的用例级判定、候选代码指纹、受保护文件的评审批准行（历史里的 `test:protected-approve files=… digests=… by=…`）、`refs/notes/tenon` 锚点；只读、不加锁；`json` 是 `tenon-verify-ci/v1`，`sarif` 是 2.1.0；报告恒带「CI 无法证明」清单 | 0；有 error 级发现=2；用法或环境错误（缺 `--ci`、选择器不是恰好一个、任务不存在、输出写不出）=1 |
| evidence export | `<name> --format agent-trace\|otel\|git-notes\|trailer [--out <file>] [--commit <rev>] [--user <slug>] [--apply] [--anchor] [--contributor human\|ai\|mixed\|unknown] [--model <provider/model>]` | 打印 Agent Trace v0.1 记录 / OTLP-JSON 的 GenAI span / `tenon-evidence-note/v1`（`refs/notes/tenon`）/ `Tenon-Change:` 与 `Tenon-Evidence:` 尾注；`--apply` 才写（`git-notes` 写 note、`trailer` amend HEAD），`--anchor` 仅 `git-notes`；记录 v2 的闭集 schema 不变 | 0；链断或为空=2；用法错误、`--apply` 用在其他格式、有暂存改动时 amend、别人的 note 不覆盖=1 |

输出语言：`TENON_LANG=en|zh`，其次 `LC_ALL` → `LC_MESSAGES` → `LANG`；无信号或 `C`/`POSIX` 保持历史中文输出（hook 钉 `LC_ALL=C`）。命令/选项的 `--help` 文案、commander 用法错误与最常见的错误/提示经消息目录（`packages/cli/src/i18n/`，稳定消息码）出两种语言；JSON 字段、`ERROR:`/`WARN:` 前缀与退出码不随语言变化。

身份与负责人命令 `tenon user` / `tenon user set` / `tenon owner take` / `tenon owner set` 只登记自报身份，不做认证；`owner set` 仅当前负责人可执行，与 Dashboard 的负责人移交共用 kernel `transferOwner`。

测试体系（`tenon test …`）三层落盘契约：项目目录 `.tenon/tests/catalog.yaml`（人可编辑，加载时校验，报告/覆盖率/产物路径必须在 `test-results/`、`playwright-report/`、`coverage/` 之下；可选顶层键 `levels` 只接受 `plan` / `changed` / `full` 三档，每档只接受 `required`、`touched`（测试类）、`scenarios`（`off|required|passing`，缺省 `off`）、`coverage`（0–100）、`flaky`、`require_baseline` 六个键，`plan` 档只接受 `required` 与 `scenarios`，没写的档或键取内建缺省，未知档 / 键 / 测试类 / 越界值使整份目录无效、测试相关出口一律阻断，`levels` 计入目录摘要）、任务计划 `openspec/changes/<name>/test-plan.yaml`（只记手工选择：`register --suite` 加跑的套件、`--file --kind` 登记的资源文件、用例映射与豁免；改动过的测试文件由套件 `files` glob 在求值时认领、不写进计划；只经 `tenon test` 命令写入，字节摘要记进同目录 `.pipeline-test-plan.json` 台账，不符即 `test-plan-tampered`）、工作流步骤档位 `steps[].test`（`none|plan|changed|full`，编译后只记档位名，含义在求值时读目录 `levels`；与旧 `test_policy` 在同一步互斥，同时写则编译以退出码 2 报错；旧 `test_policy` 只为冻结快照保留读取与求值，其 `files: registered` 改按认领处理）。测试类是 `unit`（`unit`、`coverage`）、`integration`（`integration`、`regression`、`contract`、`smoke`）、`e2e`（`e2e`、`playwright`、`browser`、`a11y`、`visual`）、`static`（`typecheck`、`lint`、`code-size`、`design-system`）、`benchmark`，外加只在点名时运行的 `custom`；套件的 `kind` 可写类名或旧种类名（别名），档位按类匹配，旧 `test_policy` 仍按种类名逐字匹配。运行记录 v2 写入 `.tenon/users/<slug>/tests/<change>/<run-id>.json`，写入前（算摘要之前）把所有字符串字段里的仓库根（逻辑路径、真实路径、`file://` 前缀）改写成仓库相对路径、用户主目录改写成 `~/`（已有记录不回写；本机日志照旧），按 `prev_digest` 哈希链串联，`tenon test run` 是唯一写入方；断链则该用户该任务的 v2 记录全部视为未运行，重跑另起新链。`report-untrusted` 套件原因在磁盘上写成已有的 `report-unreadable` + detail 前缀 `[report-untrusted]`，摘要算在磁盘形上（上一个发行版读得了）。清理默认关闭：设了 `TENON_RECORD_RETENTION=<n>` 才在每次运行后只保留最新 n 条（v1 内联步骤测试固定按测试项保留最新 `RECORD_RETENTION`=20 条），因为上一个发行版（v0.2.1）读不了清理过的链。清理删最老的前缀并写同目录的链基点标记 `chain-base`（`{schema: tenon-record-chain-base/v1, base, pruned}`，`base` 是被删的最后一条的摘要，保留下来的最老一条的 `prev_digest` 必须等于它；先写标记再删文件，标记里的 `pruned` 校验时当作不存在），中间缺记录、基点对不上、标记损坏仍是断链。基线 `.tenon/tests/baselines/<套件>/<画像>.json` 与已知失败 `.tenon/tests/known-failures.yaml` 进 git，只经 `test baseline` / `test known` 写。「自任务起点以来改动的文件」由 kernel `changedFilesSinceChangeStart` 提供（起点见第 5 节第 16 条：`start_sha`、基线分支上游的 merge-base、基线分支的 merge-base 中最新的候选，都没有时取 `created_at` 之前的最后一个提交；含暂存/未暂存/未跟踪），CLI 与 server 快照共用；提供者抛错时，`test: changed|full` 的档位与旧策略 `files: registered` 以 `files-diff-unavailable` 阻塞（失败关闭）。测试改动判定先去掉控制目录 `openspec/`、`.tenon/`、`.pipeline/` 下的路径，测试文件名规则（`*.test.*`、`*.spec.*`、`test_*.py`、`*_test.go`、`*.bench.*`、`e2e/` 下的文件）只在源码扩展名上成立，git 没有改动的文件不算本任务改动；改动里像测试却没有套件认领的是孤儿（`test-file-orphan`）。阶段运行集由 kernel `stageRunSet` 单源计算（`changed`：`required` 与 `touched` 类里被改动碰到的套件按改动范围运行，没被碰到则零运行即满足；`full`：`required` 类全部套件全量、`touched` 类被碰到的全量；`plan`：不运行；所有档位另加计划显式加跑的套件；读不到改动列表时不猜运行集），`status` / `check` 求值与 `tenon test run --stage` 共用。没写 `covers` 的套件只有它自己的测试文件改了才算被碰到：`changed` / `full` 档里，`required` 或 `touched` 类有套件没写 `covers`、没进运行集，而本任务改了源码文件（控制目录之外、源码扩展名、文件名不像测试文件）时，求值与 `--stage` 出不阻断的提示 `suites-without-covers`（`policy.notices`，点名套件，`fix` 为 `tenon test catalog set <第一个 id> --cover-glob "<glob>"`）；旧 `test_policy`、`plan` 档、读不到改动列表、改动只碰到测试文件或非源码文件时不出。认领文件在套件跑完后必须有执行过的用例，否则 `registered-test-not-executed`，多个套件认领同一文件时在其中一个跑过的套件里执行过即可。`tenon test run` 写入的套件结论与门禁重算调用同一个 kernel `evaluateSuiteResult`；旧步骤 `tests[]` 与 v1 记录不变，`tenon test run <name> <test-id>` 与 `tenon test baseline <name> <test-id>` 保持原行为。

get/set/transition 的 stdout 与 exit code 以 **golden-oracle 双跑逐字一致**为准
（oracle=老内核 `skills/pipeline/scripts/pipeline-state.sh`，diff 白名单仅时间戳字段值）。
> 2026-07-06 oracle 实测回写（iteration-1，plan 风险条款授权）：init/get/transition 三行已按老内核
> 实测行为修订（原表为文档口径，实测 init stdout 为空、get 缺失字段=空行+0、transition 走 stderr
> 且非法=1）。**有意差异白名单**（oracle 比对时豁免并在报告标注）：① `check <name>` 单参签名
> （老内核 `check <name> <phase>`，lite 委托 guardCheck 查当前相位）；② transition stderr 无 ANSI 颜色。
> （已消除的旧白名单：门 marker TTL —— iteration-13 #13 恢复分级 confirm 300s / review·interaction
> 1800s，与老内核一致，不再是差异；build⇄verify 自动副作用 —— iteration-10/13 #14 已逐字实现老仓
> 事件体副作用，不再靠出口补偿。）

> 2026-07-13（workflow-customization-engine）：`check <name>` 现同时支持 default 相位与自定义 workflow
> ——读 `.pipeline.yaml` 的 `workflow` 字段分流（同 `transition` 的双轨分岔）：`default`（含历史遗留
> 空串）走相位出口全量规则表（`guardCheck`）；非 `default` 优先读取 WorkflowRun 初始化时原子冻结的
> `workflowPlanSnapshot`，按冻结 step 声明的 step-guard（`evaluateStepGuards`）评估，不在运行途中
> 重新绑定可变 `.pipeline/workflows/<workflow>.yaml`。仅没有快照的兼容 Change 才解析当前 YAML，并
> 要求其指纹与既有绑定完全一致；文件缺失、非法或指纹漂移均失败关闭。exit 语义对两轨一致：guard
> 不过为 `2`、通过为 `0`；workflow/step 配置错或当前 step 不在冻结图为 `1`。两条路径都是纯预览，
> 绝不写盘；`pipeline workflow plan <change> --json` 是 Agent、CLI 与 Dashboard 读取同一冻结计划的
> 公共入口。
>
> 2026-09-16（workflow-io-openspec；2026-10-13 起只适用于冻结了旧文档契约的任务，见下一条）：文档治理只有一个开关 `openspec: true`，`openspec_contract`
> 已移除。契约写在它引用的 `steps` 旁边：单流程写顶层 `document_contract`，有 `tracks` 时逐分支写
> `tracks.<id>.document_contract`；slot 的 `role` 只有 `produce | update | require`，scope 与路径由
> kind 决定（`design-md` → `DESIGN.md`）。未声明契约的 Workflow 是自由模式。`document_contract` 缺少
> `openspec: true`、owner/read 引用不存在或读取发生在 owner 之前均在 parse/compile/validate 阶段失败。
> CLI、server 与 dashboard 投影消费同一编译结果，不按 workflow 名猜测文档策略。

> 2026-10-13（rework-document-mechanism）：新任务不再有预先规定的文档契约。工作流定义拒绝
> `document_contract` 与非空的步骤 `inputs` / `outputs` / `artifacts`（空列表照收、序列化不再写出），也拒绝依赖
> `outputs` 的 `nonempty-output` 守卫；报错点名替代写法。文档条件只剩按路径的 `required-output` 守卫
> （`{ type: required-output, path: <模式> }`，可写在步骤或边的 `guards` 上，支持 `when`；模式是项目相对 POSIX
> 路径，支持 `{change}`、`*`、`**`、`?`，拒绝空串、绝对路径、`..`、反斜杠与其他占位符）。Tenon 在离开步骤时
> （转换锁内、所有门禁通过之后、提交之前）把工作区与进入步骤时的 git 检查点比较，把本步新增、修改、删除的文件与
> 来源技能（hook 记录的技能加载时间与文件修改时间的尽力标注，对不上记「未知」）记入
> `openspec/changes/<change>/.pipeline-step-outputs.json`（`.pipeline-` 前缀的 Tenon 状态，只经 Tenon 命令写）。
> 非 git 目录或 git 失败时该次访问记 `observation: unavailable`，不记产出也不阻断转换。下一步只拿到直接上游那次
> 访问新增或修改、且仍存在的文档（`.md` / `.mdx` / `.markdown`）；`tenon document read <change> all|<path>` 写
> 读取回执（摘要等于上游记下的或文件当前的即算读过）；离开除放弃边外的任何边都要求输入读完，否则阻断
> `source: document`、`code: input-unread`、`subject: <path>`，转换退出码 `1`。必须产出不满足时是步骤守卫失败，转换
> 退出码 `2`，`step.next` 走 `fix`。`capabilities.documents.mode` 是唯一分流点：`observed`（冻结计划没有旧文档契约）
> 走上述机制；`contract`（冻结计划带旧文档契约）仍走文档账本 `.pipeline-documents.json`、按 kind 的读取与
> `scaffold-document` / `record-document` / `register-field` 动作，行为不变；`governed` 只表示走 OpenSpec 生命周期。
> 观察模式下 `tenon document scaffold|record|init|migrate-delta` 退出码 `2`、`tenon artifact register` 退出码 `1`。
> `gate: auto` 不再由 `outputs` 推导输出齐全守卫，自动门禁就是离开条件全部满足。观察、交接、读取回执与必须产出
> 不认识任何规范格式（OpenSpec、Spec Kit 一视同仁）。工作流 API 不再返回 `effectiveIo`，任务编排接口
> （`GET /api/change/:name/orchestration`）的 `io` 换成 `stepIo`。

> 2026-07-24（PM Spec 后 AFK）：内建 PM track 在 `spec-complete` 成功提交后会按独立的
> `auto_enqueue_on_spec_complete` 策略将 automation 从 `off` 原子置为 `queued`，并记录入队时间；不启动
> runner。golden-oracle 的 `pm-history` fixture 用逐步 sidecar 先验证这条精确状态演进，再只忽略该步的
> `automation` 与 `automation_queued_at` 旧新投影差异；未声明的 automation 差异仍是失败。

### 3.1 Dashboard Context Bundle 预算预览 API

- **入口**：`GET /api/context-bundle/preview`。查询参数必须同时包含 registered `root`、安全
  `change`、canonical `target` 与正安全整数 `budgetBytes`；该端点只读，成功与失败都不得修改
  canonical state、document ledger、handoff 默认预算或项目配置。
- **成功**：HTTP 200，`{ ok: true, preview }`；`preview.schemaVersion` 固定为
  `context-bundle-preview/v1`，`sideEffects` 固定为 `none`。输入摘要只返回 kind、项目相对 path、
  digest、兼容 reason、稳定 reasonCode、mode、sourceBytes 与 materializedBytes，不返回正文；
  预算足够时才返回有效 `aggregateDigest`。
- **错误**：请求无效 400、state/ledger/document 完整性错误 409、固定资源上限 413、预算不足
  422、平台缺少 fd-relative trusted reader 501。机器码分别为
  `CONTEXT_BUNDLE_INVALID_REQUEST`、`CONTEXT_BUNDLE_STATE_CORRUPT`、
  `CONTEXT_BUNDLE_LEDGER_MISSING`、`CONTEXT_BUNDLE_DOCUMENT_MISSING`、
  `CONTEXT_BUNDLE_DOCUMENT_STALE`、`CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED`、
  `CONTEXT_BUNDLE_BUDGET_EXCEEDED` 与 `CONTEXT_BUNDLE_TRUSTED_READER_UNAVAILABLE`。
  预算错误可返回无正文且无 aggregate digest 的 safe preview；其他错误只返回稳定 code、安全
  相对 path/kind/metric/limit/actual 与恢复提示，不暴露底层异常或绝对路径。
- **可信读取**：server 仅在运行平台能从已打开 registered root 目录 fd 做相对遍历时读取 Change；
  当前 Darwin/Node 在任何 canonical state、ledger 或正文读取前 fail closed 为 501，Linux 保留
  完整预览。canonical current/twin/direct previous、上一 transition record、ledger SHA 与源文件
  inode/regular-file/resource-limit 均须验证后才可返回成功。
- **共享规则**：CLI `handoff --bundle` 与 Dashboard API 调用同一个 port-based ledger compiler；
  Node path、SHA-256 与 UTF-8 byte 计算由 adapter primitives 注入，kernel 应用服务不绑定持久化
  路径实现。Dashboard 按稳定 code/reasonCode 做中英文映射，并覆盖 loading、empty、budget error、
  integrity error、retry、Abort/竞态及键盘路径。

### 3.2 Host Target Plan 只读契约

- **入口**：`tenon host-target-plan --json` 返回固定注册宿主目录；同时提供
  `--host <registered-host> --operation <setup|update>` 时返回单个
  `host-target-plan/v1`。Dashboard 对位入口是 `GET /api/host-targets` 与
  `GET /api/host-target-plan?host=<id>&operation=<operation>`。
- **纯预览**：CLI、API 与 Dashboard 都不得执行展示命令。响应 `side_effects` 固定为
  `none`；Dashboard 只提供复制，不提供执行按钮。
- **命令语义**：原生宿主的 setup/update 是用户级命令；适配器宿主必须输出固定 argv
  `tenon <setup|update> --<host> --target .`。`.` 表示调用者当前项目目录，禁止使用
  `<project>` 等会被 shell 解释为重定向的展示占位符。
- **输入与资源边界**：只接受固定 12 个宿主、两种 operation、各一个查询参数且无额外参数；
  重复、缺失、未知或额外参数统一为稳定 400。server 在进入 runner 前执行 loopback Host
  守卫；runner 只使用固定 argv，严格解码 JSON，错误响应不得暴露 stderr、绝对路径或底层异常。
- **运行时有界性**：同 key 并发共享一次请求；成功结果进入 25-key 有界缓存；失败可重试；
  全局并发默认最多 4；单次默认 10 秒，超时必须中止子进程、释放槽位并返回稳定 503。
- **静态资源**：生产 server 对大于等于 1024 bytes 的可压缩生成资源按
  `Accept-Encoding` 协商 gzip，返回 `Vary: Accept-Encoding` 并遵守显式 `gzip;q=0`；
  原始与 gzip 响应字节均由真实 HTTP 测试校验。

### 3.3 Interaction observability v1

Issue #46 adds an optional, derived interaction projection for each Change:
openspec/changes/<name>/.pipeline-interactions.jsonl. Canonical
RunRevision, exact review receipts, transition effects, and session binding
remain the source of truth; this JSONL is never read by guards,
authorization, transition, or resume decisions. An older Change with no file
keeps its existing canonical behavior.

Each line is a closed tenon-interaction-event/v1 envelope. The wire keys are
snake_case and include a deterministic event_id, sequence/hash-chain fields,
Change/run/workflow identity and plan fingerprint, origin and current step
visits, canonical state-before/state-after digests, actor/surface, execution
and comparison dimensions, stable event/result semantics, namespaced
reason/trigger/effect/outcome codes, and duration. Prompt text, token,
credential, artifact body, URL, session id, and arbitrary metadata are not
valid fields; the codec rejects unknown keys. Unknown namespaced codes
round-trip into unclassified_codes and are never inferred as success. Extension
codes are ASCII namespaced identifiers of at most 128 characters.

Replay performs the terminal-order fence after the common anchor/time continuity
checks and before unknown-code semantic skipping. A journey becomes terminal on
rejected acknowledgement, failed effect/operation, or its first valid
`resume.validated(success)`. After that point every core event must emit both
global and journey-local `malformed-order` and cannot execute request,
acknowledgement, effect, or resume success semantics. The only exception is an
idempotent, fully-known `resume.validated(success)` with the same effect state and
visit; it preserves the first `validResumeAt`, completion, and scorecard values.
Unknown namespaced codes remain in `unclassified_codes`, but their core event
still crosses this fence.

The public writer port is `recordUnderLock`; callers invoke it only while
holding the existing Change lock. The adapter appends through `appendUnderLock`
without re-entering the lock. A regular non-symlink reader enforces bounded bytes/lines, sequence starting at
1, exact UTF-8 previous-line hashes, and trailing newlines. Missing, valid,
and corrupt projections are distinct. Projection write failures carry the
stable `interaction-projection-write-failed` warning code after a canonical
commit, never a rollback. Missing projections remain explicitly unavailable
(`projection-unavailable`) rather than empty.

Deterministic local benchmark: tenon interaction scorecard <fixture-dir> --json.
It emits tenon-interaction-scorecard/v1, stable fixture ids, the three fixed
metrics (zero denominators are null), event completeness, stale/repeat/resume
guardrails, diagnostic counts, and sorted unclassified_codes. Tracked v1
matrix, measurement fixtures, and negative controls live under
tools/fixtures/interaction-events/v1/; negative controls never enter product
metric denominators. Manifest fixture ids are closed ASCII identifiers of at
most 64 characters, and a manifest contains at most 256 fixtures.

### 3.4 Skill Invocation evidence v1

- **canonical ledger**：每个 Change 的 `.pipeline-skill-invocations.jsonl` 是
  `skill-invocation-evidence/v1` 唯一真相源；history 只能由 completed event 单向生成兼容行，
  `Skill:`、`CodexSkillRead:` 或自由文本 history 永远不能反向铸造 completed evidence。
- **身份和状态**：每个事件必须绑定由 repository 重读得到的 Project、WorkflowDefinition、
  WorkflowRun 与 StepVisit；TaskPlanRevision/WorkItem 和 AFK attempt/reservation 存在时也必须精确
  匹配。每个 invocation 恰有一个 started、至多一个 terminal；相同 event 重放幂等，冲突、坏行、
  不连续 sequence、错误 subject、adapter 漂移、无 ownership recovery 的 interrupted 均失败关闭。
- **证明而非正文**：input/output 只保存版本化 schema、字段名/分类、SHA-256 与 validator verdict；
  QuestionEvent 保存 question key/schema/options/requiredness/shown；自由文本回答只保存分类和 digest。
  API/Dashboard 投影排除 Project ID、所有 digest/proof、transcript/Skill 绝对路径、host session/turn、
  raw prompt/answer/output 与 credentials。
- **默认和产物**：recommended-default 只能引用 repository 精确复核通过的 frozen policy/rule、
  option 与 rationale，且 question 必须 `shown=false`；hard-gate 永不默认。ArtifactBinding 先写 intent，
  仅 completed invocation 可写；commit 时重新核对 canonical document record 或当前文件 digest，漂移
  拒绝，未 commit 的 intent 保持未绑定。
- **存储和读取**：写入在 Change lock 下使用 closed codec、bounded read、O_NOFOLLOW、inode/size
  fence、append、fsync；读取使用 ledger identity fence。只读入口为
  `GET /api/skill-invocations/:change?root=<registered-root>&run_id=<optional>&work_item_id=<optional>`；
  server 在 registered root、Change parent、Change 与 root mutation version 上做前后锚定。坏证据返回
  `409 SKILL_INVOCATION_CORRUPT`，路径漂移返回 403，未知/future DTO 不显示为成功。

### 3.5 轨道、路由、评估与任务结束

- **轨道只是工作流的分支**：轨道的身份是「工作流 + 轨道 id」（工作流 YAML 的 `tracks.<id>`），只此一种；没有 `tracks:` 的平铺
  工作流是只有一条隐式轨道的工作流，`tenon init` 不带 `--track`。分支键是闭集：`label`、`steps`、
  `spec`（`openspec` | `none`；缺省继承顶层 `openspec`，`openspec: true` 视为 `spec: openspec`，旧文件的工作流指纹在不出现新键时
  不变）、`route`（`keywords`、`exclude`、`priority`、`fallback`；不写表示不参与自动路由，只能点名）、`automation`（`eligible`、
  `enqueue_after_spec`；缺省两者皆关）。未知键与非法值一律失败关闭；`document_contract` 不再是分支键（校验报错并给出
  `required-output` 替代写法，解析器仍读它只为表示冻结快照）。内建轨道登记表与 `.pipeline/tracks.yaml` 不再读取（文件在
  时只打印一行提示）。内建工作流只有 `default`（`lite` / `pm` / `frontend` / `backend`）与平铺的 `design-system`；`standard`、
  `simple` 工作流与 `chat`、`free` 轨道已删除。`tenon tracks list|show` 只读列出全部可用工作流（项目 → 全局存储 → 插件模板）的分支。
- **路由缓存 `router.v6`**（`.pipeline/cache/router.v6.data`，kernel 编码的有界纯数据，至多 64 条路由行，bash 只读、从不 source /
  eval）：由所有可用工作流里带 `route` 的分支生成；缓存摘要覆盖全部工作流文件的内容，任一变化即重建；旧版本缓存整体作废；
  写坏的工作流在生成时跳过并警告，其余照常路由，路由保持失败关闭。路由只决定「是不是开发请求、属于哪个领域」，不按关键词决定轻重：
  点名轨道或工作流 → 照用，不评估；轻量分支自己的 `exclude` 命中（重型信号）→ 直接走领域重型轨道；其余开发请求 → dispatch 带
  `assess: required` 与若干行 `candidate: workflow=<w>;track=<t>`（轻量 + 领域重型轨道）；最高分并列，或最高分落在自定义工作流的
  分支 → `selection_required: true` 与候选；被排除又无分支认领 → 落到声明了 `route.fallback: true` 的分支（`default` 里是 `backend`）。
  dispatch 的其余字段：`workflow`、`track`、`track_basis`（`user-named` | `score` | `state` | `none`）、`intent`、
  `continuous_execution`、`host_session_id`。
- **评估与探针共用分类**：`tenon assess` 与轻量轨道实现步的 `diff-risk` 探针共用 kernel `classifyChange` 与同一组阈值（该步骤测试的
  `pass.metrics`），事前评估与事后探针对同一组文件给出相同的指标与结论；评估只读路径，不读文件内容。探针超限时 `step.next` 只给
  `scope-expanded` 与 `escalate`（`reasons`、`then`）。
- **任务结束一律归档**：`tenon task finish` / `tenon task terminate` 是仅有的结束入口，任务结果 `task_result` ∈ `finished` | `escalated`
  | `terminated`，在移动目录之前写入；目录移进 `openspec/changes/archive/<YYYY-MM-DD>-<name>/`，同名同日追加 `-2`、`-3`，绝不覆盖。
  `step.next` 的 `finish-change` 对所有轨道都给出 `command: tenon task finish <name>`，agent 不再直接执行 `openspec` 命令。Dashboard
  的「已结束」分类列出 `archive/` 下的全部任务，详情是只读的 `GET /api/change/:dir/snapshot?archived=1`。
- **AFK 资格**只读所选分支的 `automation.eligible`；没写 `automation` 的分支（含平铺工作流）不可进入 AFK，`tenon afk enqueue` 退出码 `3`，
  `--json` 带 `reason: "track-not-afk-eligible"`；`enqueue_after_spec: true` 的分支在规格完成后自动入队。

## 4. 目录所有权（并行 agent 只写自己的格子）

| 目录 | 所有者 | 内容 |
|---|---|---|
| `packages/kernel/src/state/` + 同目录 tests | agent:kernel-state | 解析/写回/锁/CAS/init |
| `packages/kernel/src/flow/` + `templates/manifest.yaml` + tests | agent:kernel-flow | manifest/转换/guard |
| `packages/cli/src/` + tests | agent:cli | commander 装配、渲染 |
| `hooks/` + `.claude-plugin/` | agent:hooks | bash shims、插件清单 |
| `tools/oracle/` | agent:oracle | 双跑 harness、fixtures |
| 根配置 / `packages/kernel/src/types.ts` / docs | 主会话 & integrate | 契约与接缝 |

共享文件（package.json、types.ts）只有 integrate 阶段可改。

## 5. 硬规则

1. TDD：先写红测试再实现；vitest；测试与源码同 package。
2. kernel 零第三方运行时依赖；cli 仅允许 `commander`。
3. TypeScript strict、ESM、NodeNext；node ≥22。
4. hook 热路径（PreToolUse/UserPromptSubmit shim）纯 bash：只做文件存在性/读缓存，**禁 spawn node**。
   breadcrumb 缓存由 CLI 在 transition 时写 `openspec/changes/<name>/.breadcrumb`，shim 只 cat。
   `.pipeline/hooks.json` version 1 同时承载 `prompt_skip_keyword`：缺字段/非法值回退
   `no-tenon`，显式 `""` 禁用。`router.sh` 与 `breadcrumb.sh` 只用 Bash 3.2 兼容逻辑做
   ASCII 大小写不敏感的独立 token 匹配；命中仅抑制当前轮两类上下文输出，不影响
   review acknowledgement、confirm、PreToolUse、安全门、Skill 证据或 Change 状态。server
   的 Hook toggle 与 keyword 写回必须原子替换完整 canonical JSON 并互相保留字段。
   **唯一披露的窄例外**（2026-07-07，GOAL 清单 E6，`workflow-customization-engine` 计划
   Task 9）：`hooks/gate.sh` 在"当前 change 存在 + 声明的 `workflow` 字段非 `default`/未设 +
   本次调用是 `Skill` 工具"三条同时成立时，委托 `node .../pipeline.mjs internal-skill-gate`
   做真实 skill DAG 解锁判定（自定义 workflow 的依赖图判定不值得在 bash 里重新实现一遍）；
   `workflow==='default'` 这条最高频路径（以及无活跃 change / 非 Skill 工具调用）零改动、
   零 spawn，本条硬规则对它的承诺不变。`tools/test-hooks.sh` 把 `gate.sh` 从"零 node"红线
   自证清单里单独摘出、改断言"仅这一处合法引用"，零 spawn 的行为证据见
   `packages/cli/src/internal-skill-gate-hook.integration.test.ts`。
5. 老仓（`/Users/a1234/Documents/code-manager/projects/workflow-plugin`）只读，作 oracle 与语义参考。
6. 时间戳统一 ISO8601 UTC；测试中注入 clock，不直接 `new Date()` 散落业务码。
7. **插件资产零悬空引用（安装期验证，2026-07-06 用户硬要求）**：`plugin.json` / `hooks.json` /
   manifest / 任何 skill 清单引用的每个路径与 skill 名，必须被 `tools/verify-skills.sh`
   在安装/CI 时证实存在（路径存在 + 脚本可执行 + skill 目录含 SKILL.md），缺失即**硬失败并
   逐条列出**。第三方 skill 依赖必须在 `skills/sources.yaml` 显式声明来源，由 setup/update 获取后
   经 `skills/skills.lock.json` 校验，**不允许运行时才发现「skill 找不到」**。老内核靠 manifest
   选装外部 skills 曾出现此坑，本仓封死。

8. **Canonical Skill provenance（Issue #44）**：`templates/skill-sources.yaml` 是分发
   Skill 唯一 tracked provenance source，使用 schema `version: 3` 与
   `hash_algorithm: tree-sha256-v1`。每个 entry 必须声明 `source_kind: bundled`、规范化的
   `source_ref: skills/<id>`、由 `buildCanonicalManifest()` 得到的 `sha256:` content hash，
   以及同时绑定 identity/hash 的 `coordinate: tenon:skills/<id>@sha256:<digest>`。install、
   verify、doctor、release candidate 与 bundled locator 只能消费这一份 registry，并对缺失、
   额外、重复、漂移、未知 source 和不安全引用 fail-closed；解析/读取错误不得降级为空清单。
   `skills-lock.json` 已移除，重新出现必须以 `legacy-provenance-source` 失败。作者只可运行
   `npm run sync:skill-provenance` 原子刷新 registry，随后用
   `bash tools/verify-skills.sh --quiet --root "$PWD"` 验证；隐藏的
   `internal-skill-provenance verify|sync --root <path> [--json]` 是共享实现。

9. **上游 Skill 安装（2026-09-15 用户硬要求）**：第三方 Skill 不再随仓库维护精简副本。
   `skills/sources.yaml`（tracked，flow YAML，`version: 1`）按 id 声明
   `{ repo, path, ref: default-branch, license_expected }`，许可证只允许 MIT 与 Apache-2.0。
   `tenon setup --<host>` 与 `tenon update --<host>` 在宿主写好插件根之后、候选校验之前，从每个
   仓库默认分支获取最新完整内容写入 `<插件根>/skills/<id>/`，并写 `skills/skills.lock.json`
   （`version: 2`，`{ id, repo, path, commit, previous_commit, tree_sha256, license, fetched_at,
   model_invocable }`，随 payload
   分发、不入 git）。内容哈希沿用 `tree-sha256-v1`。单个 Skill 要么完整替换、要么保留旧内容，
   不留半装状态；内容未变时锁字节不变，更新报告 `current`。获取失败、缺许可证、许可证不符、
   上游改名或删除都不改变已激活 release，`<stateRoot>/skills/last-update.json` 记录该次结果，
   `tenon doctor --skills`、`skills:upstream` 与 Dashboard `技能` 页显示来源/提交/许可证/更新时间。
   verifier 的 declared 集合是 registry ∪ lock：缺目录、未登记目录、内容漂移、锁与 sources 不一致
   一律 fail-closed。开发 checkout 用 `npm run skills:fetch` 获取，获取物与锁均 gitignored。
   锁是**跨年龄线格式**：写它的 fetcher、候选根里自带的 verifier、已激活 release 里的 doctor，
   在一次升级里可以是三个年龄。v0.1.0 的读取器按 exact-keys 校验条目（多一个键就整条拒，与
   version 无关），因此这份文件**加不了任何字段**，也不许换 version：两种改法都让 `setup`/`update`
   在候选校验处中止（真机各中过一次）。规则是：**永远按 v1 那 8 个键写**；读的时候同时收 v1 与
   0.1.1-pre 短命的 v2（`model_invocable` 视为附注，缺失=未知、绝不当作「不可调用」），读进来一律
   归一成 v1，下一次写盘即自愈。技能可不可以被模型调用的权威来源是 SKILL.md 字节本身
   （`tree_sha256` 已把字节钉死），由 doctor 探针与候选校验现读，不进锁。

10. **强制 Skill 必须模型可调用（2026-09-22）**：`templates/workflows/default.yaml` 的 step `skills`
   （技能只来自工作流 YAML，manifest 的 `mandatory_skills` 技能矩阵已删除）只能声明宿主肯代模型调用的 Skill。
   带 `disable-model-invocation: true` 的 Skill 由设计只接受人工触发，宿主 Skill 工具拒绝代模型
   执行它，Tenon 下发的 `load-skill <id>` 因此既跑不起来也留不下回执，transition 的
   step-skills-incomplete 会把该 phase×track 永久锁死（v0.1.0 的 explore.pm/frontend/backend、
   spec.pm、verify.pm、ship.pm 即如此）。判定实现单源于 kernel `isSkillModelInvocable`，获取期
   记进锁的 `model_invocable`，两道门禁消费它：候选校验（`internal-skill-provenance verify` 的
   `mandatory-skill-not-invocable`，随 `tools/verify-skills.sh` 与 setup/update 的候选门一起跑）
   与 `tenon doctor` 的 `skills:invocable`。两者都直接读 `skills/<id>/SKILL.md` 的 frontmatter。
   token 的 `a|b` 备选只要有一个被证明可调用即算过；**读不到字节 = 未知**，既不定罪也不报绿——
   候选校验对未知沉默（干净检出本就没有这些字节，否则没人能发版），doctor 对未知报 yellow。
   「强制技能压根没装」由 `skills:mandatory` / `skills:workflow` 报红，不会因这条沉默而漏掉。
   仅人工调用的 Skill 仍随包分发作人工指引，只是不得出现在工作流步骤的 `skills` 里。

11. **跨年龄线格式不许做版本握手（2026-09-22）**：一份文件如果由一个组件写、由另一个**可能是
   别的年龄**的组件读，它的 schema 就是对外契约，不能靠「双方同时升级」成立。本仓已知的这类面：
   `skills/skills.lock.json`（fetcher ↔ 候选 verifier ↔ 已激活 doctor）、
   `<stateRoot>/skills/last-update.json`（fetcher ↔ doctor，state root 跨 release 共享、回滚后仍在）、
   以及 `openspec/changes/<name>/.pipeline.yaml` 这类项目态（回滚后由更老的读取器读，故
   `tools/test-bundle.sh` 备有冻结 N-1 读取器）。纪律：这些文件**只增不改、且只能以旧读取器
   已经容忍的方式增**；旧读取器若是 exact-keys，就一个字段都不能加，新事实应当放到旧读取器
   根本不看的地方（如内容字节本身）。改 version 等于断代，必须当作破坏性变更单独设计升级路径。

12. **必需技能 = 调用 + 本步绑定的产物（2026-09-23；2026-10-13 起只适用于冻结了旧文档契约的任务）**：step 的 document 契约（`document_contract`
   的 role produce 槽）点名为 producer 的必需技能，要在**本次步骤访问**里由它（按别名等价）登记了
   该槽的文档才算完成；只有调用回执不算（第三轮真机验收里五条空 PostToolUse 就把五个技能刷成了
   done）。本步没有产出槽点名它的技能仍以调用为准——没有可以绑定的产物。「本次访问」按文档记录的
   producer invocation 锚点（runId + transitionSequence）与当前 WorkflowRun 逐字比对，上一次访问、
   backfill 与无锚点的旧记录都不算。绑定只从契约推出（kernel `documentKindsProducedBySkillAtPolicyStep`），
   不另立名单，所以自定义 workflow 适用同一条规则。判定单源于 kernel `judgeStepSkillSlots`：
   `tenon check`、CLI 与 Dashboard 的 transition、`tenon status --json` 的 `skills[].status`
   （新增 `invoked` = 已调用、欠 `pending_documents`）、`exits[].blockers` 与 `next` 都读它；
   `next` 对 `invoked` 的技能下发它欠的 `scaffold-document` / `record-document`（带 `skill`），
   不再发 `load-skill`。不加交互门：headless `claude -p` 没有 AskUserQuestion。
   新任务（`capabilities.documents.mode` 为 `observed`）没有文档契约，也就没有可以绑定的产物：必需技能以本次
   步骤访问里的调用回执为准，不产生 `invoked` 状态与 `pending_documents`；步骤产出的来源技能（见 §3 的
   2026-10-13 说明）只是尽力而为的标注，不进任何门禁。

13. **测试体系接入流程（2026-09-29）**：`tenon status --json` 的 `step.next` 读 kernel 的策略判定
   （`TestEvidenceReport.policy`，与 `tenon check`、transition、工作台同一份）下发测试动作，顺序固定为
   `test-discover`（无目录）→ `test-plan-seed`（无计划 / 计划被改）→ `test-plan-map`（只在缺必需测试类，或档位要求场景映射时下发）→
   `test-register-files`（只在出现孤儿测试文件时下发，内容是一条 `tenon test register <c> --auto`，不再逐个登记）→ `run-tests`（`tenon test run <c> --stage`；
   `trust` 只列本次要执行、尚未信任的命令）→ `test-report`
   （验证报告还没带上最新运行的追溯矩阵）。登记类一次只发最靠前的一类；整体排在本步文档之后、评审者之前；
   旧步骤 `tests[]` 仍走 `run-test`。已经运行过却不满足策略的阻塞（用例失败、覆盖率不足……）没有专门动作：
   非评审门发 `fix`，评审门上有回退边就走回退边（受轮次约束的步骤上，轮次内 `next` 直接给回退边的 `transition`，不要评审回执）。计划里的豁免（`waivers[].approved_by`）只由人工确认写入：
   `tenon review acknowledge`（非 `--delegated`）与 Dashboard 复核决策台的通过（`POST /api/change/<name>/decisions`）
   在提交 receipt 的同一把锁内写入（同一个 kernel `approveFrozenWaivers`）：`review request` 冻结并列出未批准的豁免
   （`request-review` 带 `waivers`），确认只批准清单里仍原样存在的那几条；`--delegated` 不批准豁免，计划里有待批准的豁免时它整个被拒
   （receipt 保持待确认，等人工确认），避免留下谁也批准不了的豁免。Dashboard 的 `GET …/pending-decisions`
   带 `waivers`（这次通过会批准的冻结清单，绑定当前请求，否则为空），POST 成功响应带 `waivers: { approved, skipped }`。
   项目目录里的「本项目不适用」声明（`catalog.yaml` 的 `not_applicable: [{kind, reason, approved_by}]`，由
   `tenon test catalog not-applicable <kind> --reason` 写入）走同一条批准路径：未批准的声明以 `not-applicable:<kind>`
   进冻结清单，确认时写回 `catalog.yaml` 的 `approved_by`（批准人），批准前档位照旧要求该测试类并报 `waiver-unapproved`；已批准的声明
   同时满足该种类所属的测试类。步骤测试豁免（`test:<id>`）在评审请求清单、验证报告、读测试结果的评审者提示与 `test-waived` 提示里，另起一行附带该测试
   在当前候选上最新失败记录的实测值（`最新运行：lines_added=2810（上限 2000）`，每次展示时重读；当前候选上没有失败记录则写
   `当前候选上没有失败记录`），登记理由照旧标注为登记者自述。
   default 工作流只写档位（lite：build `changed` / verify `full`；pm：spec `none` / verify `changed`；frontend、backend：spec `plan` / build `changed` / verify `full`），
   内建档位只强制 `unit` 类，覆盖率与不稳定用例没有缺省门槛，`scenarios` 缺省 `off`（不要求时追溯矩阵只列已映射行，另加一行「另有 N 条场景 / 任务未映射（本步不要求映射）」，
   不出 `scenario-uncovered`，`next` 不下发 `test-plan-map`）；default 三个重型轨道验证步的 `code-size` 与 `templates/test-directions/code-size.yaml` 不带 `pass.metrics`，
   探针照常统计，退出码 0 即通过，没有上限时实测值照样记进运行记录、写在 `code-size` 评审者的提示里，要上限的项目在自己的工作流里写回 `pass.metrics`。
   计划写入、豁免批准、基线更新各在 change 历史里留一行 `test:plan-write|waiver-approve|baseline-update`。
   写门（`hooks/gate.sh`）拒绝对 `test-plan.yaml`（及台账、冻结清单）、`.tenon/tests/baselines/**`、
   `.tenon/tests/known-failures.yaml`、按用户的记录目录的编辑类工具写入与 shell 重定向 / tee / cp / mv / rm /
   `sed -i`，只看写入目标；`tenon` 调用与普通 git 操作放行。声明 `reads_tests` 的评审者提示词附带目录套件最新
   运行的失败用例、flaky、覆盖率对照门槛与基准变化。

14. **测试证据的可信根（v0.3）**：证据必须是「被它约束的 agent 造不出来」的东西。
   · 本机封存 `<用户目录>/local/test-seal.json`（按用户、gitignored、HMAC-SHA256，密钥 `local/env.key`）：记录链头
   （`appendTestRunRecordV2` 在链锁内更新）、Tenon 命令写出的共享受保护文件摘要（`known add|rm`、`baseline --suite`）、
   人工批准（change + 路径 + 内容摘要）、早先版本写下的信任决定（`trusted[]`，只读兼容，只在不是 git 仓库的项目里才认；git 仓库里的信任只记在下面的用户级信任存储）。缺失 / 损坏 / mac 不符读成空封存，绝不放行。链头不等于封存链头
   的记录链判 `record-unsealed`（无人工出口；下一次 `tenon test run` 另起新链取代它，`chain: reset`）。
   · 受保护配置改动（`.tenon/tests/catalog.yaml`、`baselines/**`、`known-failures.yaml`、`.pipeline/workflows/*.yaml`）出现在任务
   diff（含删除）里，在 `gate: review` 步骤判 `protected-file-unapproved`（封存里没有同内容的批准）或 `protected-file-tampered`
   （Tenon 命令写出之后又被改）；`review request` 把它们连同语义摘要（目录：档位定义 `levels` 按生效值逐档逐键标出放宽 / 收紧、项目级不适用声明的增删改，排在套件 / 服务命令的变化之前；门槛与命令两段各自最多 8 行，哪段改得再多也不挤掉另一段）冻结进 `.pipeline-review-waivers.json` 的 `protected`，人工
   `review acknowledge`（与 Dashboard 通过共用 `approveFrozenWaivers`，入参多一个 `repoRoot`）把仍同摘要的项写进封存，
   `--delegated` 在有待确认项时整个被拒；POST 成功响应多 `protectedChanges: { approved, skipped }`，历史多一行
   `test:protected-approve`。读不出 diff：档位 `changed|full` 与旧策略 `files: registered` 的步骤 `files-diff-unavailable`，其余只提示 `files-unchecked`。
   · 已知失败：`test` 必须是 `<文件> › <用例名>`；`expires` 距今 ≤ 30 天（`known add` 拒绝更长的，手写更长的判定时不被承认，
   提示 `known-failure-too-long`）。
   · 报告：必须新于本次调用开始（否则 `report-untrusted`），并复制进本次运行产物目录 `artifacts/<套件>/<仓库相对路径>`，
   记录里 `report.digest` 必须等于副本摘要（`evaluateSuiteResult` 重算同一判断）。
   · 首次信任：键是「用户 + 仓库身份 + 单条命令摘要」。仓库身份取 `git rev-parse --git-common-dir` 的真实路径，同一仓库的所有 worktree 共享；当前检出的根目录
   必须出现在 `git worktree list --porcelain` 里，否则视为未信任（防压缩包里伪造指向别处的 `.git` 文件）。命令摘要按单条可执行命令算：套件的 `command`、`cwd`、
   `select.files` / `select.grep`、排序后的 `env` 与它用到的服务，步骤内联测试的 `command` 与 `cwd`（`catalogExecEntries` / `stepTestExecEntries`）。
   `tenon test run` 执行前只校验本次要执行的命令，未信任的逐条列出并以退出码 1 拒绝、不写运行记录。判定顺序：环境变量 `TENON_TEST_TRUST=1`（CI）→ 用户级信任存储里有
   `(仓库身份, 摘要)` → 拒绝。只有检出目录及其所有上级都没有 `.git`（不是 git 仓库）时，才在拒绝之前多看一步检出旧封存 `trusted[]` 是否含当前整份摘要
   （`catalogExecDigest` / `stepTestsExecDigest`，只读兼容，不迁移），这时 `tenon test trust` 也写检出旧封存。
   git 仓库里一律不认检出里的旧封存，不论它是否被 git 跟踪：检出里的任何文件（含封存与它的 HMAC 密钥）都可能随仓库提交或压缩包带来，能算好封印给仓库自己授信，
   只看检出内容的检查（例如「是否被 git 跟踪」）都能被伪造。以前在检出里信任过的命令，要在你自己的终端重新运行一次 `tenon test trust`；检出旧封存恰好记着当前整份摘要时，
   `tenon test run` 多打一行提示「检出里的旧信任在 git 仓库里不再被认，请在你自己的终端重新运行 `tenon test trust <change>` 确认一次」。
   git 仓库里没有用户级状态目录时，`tenon test trust` 直接报错「没有用户级状态目录：git 仓库的信任只记在用户级存储里，写不进去」，不再退回写检出封存。
   有 `.git` 却读不出仓库身份（git 出错、超时、不可用，或 `.git` 是不在 worktree 列表里的伪造指针）一律未信任，既不查用户级存储也不看旧封存：`tenon test run` 提示先修好 git，
   `tenon test trust` 拒绝写入（否则克隆来的仓库只要让 git 出错，自带的封存与密钥就能自行授信）。
   存储在 `<stateRoot>/test-trust/<user-slug>.json`（`stateRoot` 经 `resolveProductPaths`，整份 HMAC-SHA256 封印，密钥 `<user-slug>.key` 权限 0600，锁 + 原子替换，
   最多 2000 条、满了淘汰最旧的），读取永不抛错，坏文件读成空。`tenon test trust [change] [--yes] [--status]` 只能由用户在终端给出；hook 也拒绝 agent 在调用中改写 Tenon 的状态目录
   （`TENON_RUNTIME_HOME`、`TENON_RUNTIME_ROOTS`，以及在 `tenon` 调用前改 `HOME` / `XDG_STATE_HOME`），信任存储不能被指到 agent 自造的位置。仓库身份取路径、不取内容摘要：
   在同一路径换成另一个仓库会继承命令级信任，与拉取新提交同一信任级别，记为已知限制。
   目录顶层的 `setup`（`tenon init` 在新 worktree 里执行）不属于任何套件，是目录里单独的一条可执行命令（`catalogSetupEntry`，按命令文本算摘要）：
   `tenon test trust` 确认整份目录时把它连同各套件的命令一起列出；`tenon test run` 不执行它，所以不校验它。`tenon init` 建好 worktree 后按同一份用户级信任存储判定——
   这条 `setup` 已得到信任（同一仓库的所有 worktree 共享，不需要把信任「带进」新 worktree）才执行，未信任只提示、不执行，`tenon init` 照常成功。
   信任绑定的是命令文本，不绑定命令执行时读取的仓库文件（例如 `package.json` 的生命周期脚本、它调用的脚本）。已信任的 `setup` 在之后的提交改了这些文件时
   会在新 worktree 里直接执行；不想自动执行用 `tenon init --in-place`，或从目录里去掉 `setup`。
   · 指纹：`fingerprintWorkspace(root, { declaredOutputs })` 忽略声明的产物路径，另加一条通用规则：路径有一段名为 `test-results` / `playwright-report` / `coverage`、
   git 没有跟踪、且扩展名（小写）属于证据格式（log、txt、xml、md、csv、png、jpg、jpeg、gif、webp、webm、mp4、lcov、info）的文件不计入（完整值与可移植值都排除）；
   已跟踪的文件、源码 / 脚本扩展名与没有扩展名的文件照旧计入，json、html、htm、zip、gz、har 这类能被代码或浏览器直接加载、解包的产物也照旧计入（能借目录名藏内容），
   真产出这些文件的套件在测试目录里把它们声明为输出；规则只为这些目录读取 git 跟踪状态，git 不可用、超时或出错时目录下全部计入（失败关闭）；生产口径是 `candidateFingerprint`
   （目录声明 ∪ 在途任务冻结工作流里内联测试的 `outputs`）。它把宿主本地**文件**（`HOST_LOCAL_FILES`：
   `.claude/settings.local.json`、根目录的 `CLAUDE.local.md`，从不提交）照算，但不计入未被 git 跟踪的 `.claude/worktrees/`
   （`HOST_LOCAL_DIRS`：宿主为子代理与会话建的本项目检出，里面的文件都是源码在别处的副本，同仓库的另一个会话随时在改，目录可能非常大；
   两个指纹都跳过它时遍历不再进入该目录）；该目录下被 git 跟踪（已提交或已暂存）的文件照算，所以 PR 不能把代码藏进这个目录。
   评审结论与构建基线冻结的是它，0.3.0 及更早版本写进测试记录的也是它；在没有未被跟踪的 `.claude/worktrees/` 的树上它与 0.3.0 逐位相同。
   后果：在有这个目录的机器上，0.3.0 写下的测试记录（那时绑的是完整指纹），以及 0.3.0 / v0.3.1 写下的评审结论与构建版本，升级后判为过期、需要重跑，不判损坏
   （0.3.1 起的测试记录绑可移植指纹，不受影响）；回滚到 v0.3.1 时，当前版本记下的评审结论与构建版本同样被它判为过期要重跑。
   `fingerprintWorkspaceTwins` 一次遍历同时给出这个完整指纹与不含宿主本地文件的可移植指纹；
   测试记录从 0.3.1 起绑可移植的那个（`candidateOf` 经 `knownPortableCandidate`），干净克隆因此复现得出来。判定记录是否新鲜时，绑定等于
   宿主给的候选或它的可移植孪生（`portableCandidate`）都算新鲜，所以 0.3.0 的记录在本机（没有未被跟踪的 `.claude/worktrees/` 时）不因升级而过期；0.3.0 / 0.2.x 读 0.3.1 的记录在有
   宿主本地文件的工作区里读成「代码已变化」（过期，不是损坏）。记录 schema 没有改（绑定仍是一个 `workspace:sha256:` 值）。
   两个指纹都只排除 git 没有跟踪的宿主本地路径（`trackedHostLocalPaths`：对清单做 `git ls-files --cached`；可移植指纹排除清单上的全部，完整指纹只排除 `.claude/worktrees/`）；被跟踪（已提交或已暂存）的
   路径是仓库的一部分，两个指纹都算，写入方与 CI 一致。只有真正不是 git 仓库（git 在项目根和所有上级目录里都找不到仓库，且根目录没有 `.git` 条目）才什么都不跟踪；
   git 读不出来（缺失、索引损坏、`.git` 是 gitfile 但 `gitdir` 不在、`.git` 为空 / 损坏 / 读不了（git 只认项目根这个 `.git`，上级仓库不会顶替它回答）、上级仓库隔着文件系统边界）就一律照算，完整指纹也照算 `.claude/worktrees/`；git 的环境变量里指定仓库的那几个（`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等）不传给它。
   在不区分大小写的文件系统上（探测项目根得知）清单对 git 的回答按忽略大小写匹配：索引拼写 `.Claude/Settings.local.json` 对磁盘上的 `.claude/settings.local.json` 算被跟踪。
   可移植指纹按 git 的权限位模型记录（`portableModeOf`）：普通文件只看属主的可执行位（644 / 755），目录与符号链接用常量 755，不读实际权限位；
   完整指纹仍记原始权限位（在没有未被跟踪的 `.claude/worktrees/` 的树上逐字节等于 0.3.0）。原始位不跨机器稳定（符号链接在 macOS 是 0755、在 Linux 恒为 0777，目录与文件跟 umask），
   所以只有可移植指纹能让 Linux runner 复现 Mac 上写下的记录。常量取自 umask 022 的检出，普通的树上两个指纹相等，只认完整指纹的 0.3.0 读 0.3.1 的记录仍是新鲜。
   · 评审者：`agent-runs` 行可带 `rerun_reason`；同候选上已有结论时 `tenon agent prompt` 需要 `--rerun-reason`，判定取同候选全部
   已结束运行里最严的一次（最后一次带原因时以它为准）；`AgentView` 多 `reruns / flipped / rerunReason`。
   · 跨厂商评审：工作流评审者可声明 `host: codex|claude|any`（IR 里只在声明时出现，不改旧工作流指纹），agent 定义可用 `host:` 建议一个
   （只路由）。`agent-runs` 行可带 `host` / `host_source`（`detected|declared`）；步骤声明了 `codex|claude` 时，登记的宿主不符的运行不是裁决
   （`AgentView.wrongHost`、状态 `stale`、阻断 `reviewer-wrong-host`，也不计入"同候选已有结论"）；`tenon agent record` 在宿主不符时 exit 2 不写；
   候选绑定沿用 `candidate`。`AgentView` 多 `requiredHost / host / hostSource / wrongHost / candidate`。`tenon agent prompt` 在当前宿主不是要求的宿主时
   把提示词写进 `<change>/.pipeline-agent-reports/<run-id>.prompt.md` 并给出 `codex exec` / `claude -p` 命令（JSON 的 `host.run_on`），不替用户起另一家的 CLI。
   · 宿主子代理：`agent-runs` 行可带 `subagent`（`host` / `type` / `native` 三键）。没用专属子代理的原因（`not-installed`、`definition-mismatch`、
   `shadowed`、`project-agent`，以及 `tenon agent record --subagent none` 的 `not-dispatched`）不写进行里，按 run_id 记在旁注
   `.pipeline-agent-run-meta.jsonl` 的 `subagent_reason`，读取时叠加回 `subagent.reason`：行的键集合不变，升级前的运行时仍能读台账。
   · 测试完整性：旧 `test_policy` 的 `integrity: notice|block`（缺省 notice，不进 IR，不改指纹与策略摘要；档位没有这个设置，恒为 notice）。`TestPolicyReport.integrity` 报告十种信号
   （运行记录：`case-count-drop`、`skip-count-rise`；diff：`test-file-deleted`、`tests-removed`、`test-skipped`、`assertion-weakened`、
   `snapshot-rewritten`、`baseline-changed`、`known-failure-added`、`coverage-threshold-lowered`），notice 汇成一条 `test-integrity` 提示，block 汇成
   一条 `test-integrity` 阻塞（读不出 diff 时失败关闭 `files-diff-unavailable`）；宿主经 `TestEvidenceContext.integrityDiff` 提供改动行。`tenon test integrity` 输出同一份报告。
   · 写门（`hooks/gate.sh`）认 13 种写法（见安全模型），并拒绝 agent 的 shell 调用里的 `tenon test trust` 与 `TENON_TEST_TRUST=`
   前缀赋值（只在命令位置匹配），以及任何写入 `*/test-trust/*` 路径（用户级信任存储）。

15. **验证轮次上限（2026-10-09）**：build ⇄ verify 不再无休止回退；带评审门和回退边的步骤有可声明、可覆盖的轮次上限，
   用完后停止自动回退，交给用户。
   · 任务字段 `max_rounds`（任务级覆盖）：`FIELD_ORDER` 末尾追加（在 `review_acknowledged_via` 之后），只接受 1–20 的规范十进制整数
   （`tenon set|set-many|cas` 同一口径，其余取值 exit 1 且不落盘；成功写入记一行 `set` 历史）。**空值不进 wire `state.fields`，也不进
   `.pipeline.yaml` 投影**（`state/omit-when-empty-fields.ts`）；读取端缺这个键读作空串，不算 `FIELD_ORDER` 闭集违例，所以没设置过它的
   任务，wire、YAML 与评审绑定摘要逐字节不变。已知限制：设置过 `max_rounds` 的任务，N-1（升级前发布）运行时读 canonical 会因闭集校验
   失败而读不了；设置本身改变整份序列化状态，已发起或已批准的评审绑定随之失效，要重新 `review request`。
   · 工作流步骤键 `max_rounds: <N>`（IR 属性 `maxRounds`）：1–20 的整数，只能声明在 `gate: review` 且至少有一条回退边（非前进边，
   判定同 kernel `isForwardEdge`）的步骤上；声明在别处、越界或不是整数，parse / compile 报错并点名 step 与原因。没有评审门的步骤
   （build）不受约束，它的回退边（`requirements-changed`）始终可用。`default` 每条轨道的 verify 步声明 2；受限步骤没声明按内置默认 2。
   IR 只在声明时出现该键：没声明的工作流指纹逐字不变，升级前冻结的计划（快照 v4 没有此键）照常解码、指纹不变，上限读作
   `{ max: 2, source: 'default' }`。上限随工作流计划冻结；任务字段覆盖它。来源标签 `workflow` | `default` | `task`。
   · 轮次 = 自上次清零以来进入该步的次数（含当前）；清零 = 任务落到早于该步所有回退目标的步骤（default 里经 `requirements-changed`
   回到规格）。计数取 canonical 转换记录链（`readChain` + `runMetadata`，只数当前 run），没有链的旧任务读 `.pipeline-history.jsonl`
   的 `kind: transition` 行。`tenon status --json` 的 `step.rounds` 是 `{ current, max, source }`（键序在 `exits` 之后、`next` 之前）；
   不受约束的步骤与已完结任务为 `null`。
   · 未用完（`current < max`）：回退边**不需要评审回执**。受约束步骤上必需测试或必需评审者不通过时，`next` 对唯一的回退边直接给
   `transition`（多条回退边仍给 `choose-exit`；`step.rounds` 缺席时失败关闭，仍走 `request-review` → `await-review` → `transition`），
   `tenon transition <name> <回退事件>` 在 kernel 转换用例里与「用完即拒」读同一份轮次（同一把 Change 锁），读到未用完就跳过回执要求；
   宿主没有接线轮次读取时仍要回执，轮次读取抛错照旧向上抛。前进边与放弃边的回执要求不变，也不为此去读轮次。轮次内回退边上挂着的
   pending / approved 请求（升级前遗留）由转换一并清空，不另外要求确认。
   · 用完（`current >= max`）且必需测试或必需评审者不通过：`next` 不再给回退边的 `request-review` / `choose-exit` / `transition`。
   只剩必需评审者不通过、或失败的必需测试都已豁免 → 前进边的 `request-review`，多带 `residual`（`reviewer:<agent>` 列表）、`rounds`、
   `alternatives`；还有没登记豁免的失败必需测试 → `stop`，`code: rounds-exhausted`。`step.exits[]` 里回退边 `ready: false`，带阻断
   `{ source: 'guard', code: 'rounds-exhausted' }`。强制层：回退边的 `tenon review request` 与 `tenon transition` 被拒（CLI exit 1，
   消息码 `transition.roundsExhausted`，写出已用轮次、上限与 `tenon set <name> max_rounds <N>`；kernel 转换用例结果
   `kind: 'rounds-exhausted'`；Dashboard `POST /api/change/<name>/transition` 返回 HTTP 409
   `{ code: 'rounds-exhausted', step, event, current, max, source }`）。不受约束的步骤的回退边、前进边与放弃边（`scope-expanded`）不拦；
   上限调高到大于当前轮次后回退边恢复。回到规格没有直达的边：受约束步骤声明的回退边本身就是它的回退目标（落到那里不清零，用完后也被拒），
   所以 `alternatives` 与拒绝文案写两步路径——用户调高上限、经回退边回到回退目标、在那一步上执行落到更早步骤的事件（default 是 build 的
   `requirements-changed`），文案按计划算出事件名；工作流里没有更早的步骤时写明回去也不会清零。调高上限是用户的决定，技能与宪法写明 agent 不自行调高（同机同用户信任模型，记为已知限制）。
   · 剩余阻断：用完后前进边的 `review request` 放行必需评审者的不通过，把 `reviewer:<agent>` 连同评审运行 id、代码候选、阻断级发现
   冻结进 `.pipeline-review-waivers.json` 的 `residual`，逐条列给用户。人工 `review acknowledge`（非 `--delegated`、非 AFK）在提交回执的
   同一把锁内把它们写进同一文件的 `accepted`（跨请求保留，清除待批准项时不清；每个评审者只留最新一条，最多 20 条），并追加历史行
   `review.residual-accepted reviewer=… run=… candidate=… findings=… by=… summary=…`（kind `tool`；`summary=` 是冻结时的发现摘要，
   最多 5 条，用 `|` 连接，条内的 `|` 换成全角 `｜`，每条已清洗；没有摘要时不带 `summary=`）。接受只对被接受的评审运行和当时的代码候选
   有效，候选变了或评审者有了新运行即失效；`evaluateStepAgents` 据此把对得上的 `reviewer-failed` 视为已处置，前进边的 `transition`
   不再因它被拒。`--delegated` 与 AFK 遇到待接受项整个被拒（回执保持待确认）；Dashboard 的确认因不展示待接受项而返回 HTTP 409
   `{ code: 'residual-pending' }`，只能回终端确认。冻结清单读取严格：未知键或坏形状的 `residual` / `accepted` 让整份清单读不出
   （什么都不冻结、不接受，失败关闭）；N-1 运行时遇到新键同样读不出，按没有清单处理。剩余阻断只覆盖评审者，失败的必需测试仍走
   步骤测试豁免（`tenon test waive --test`）。

16. **任务起点 `start_sha`（2026-10-10）**：「自任务起点以来改动了哪些文件」不再只靠 `created_at` 推算——建任务时记下当时的 HEAD，
   起点再跟随上游前进，别人合并后拉进来的提交不算本任务的。
   · 任务字段 `start_sha`：`FIELD_ORDER` 最末尾追加（在 `max_rounds`、`task_result`、`domain` 之后）。`tenon init` 与 triage 物化建任务时写入
   当时检出的 HEAD（只接受 40 或 64 位小写十六进制提交 id，别的值 init 直接拒绝）；仓库还没有提交或不是 git 仓库时不写。**它是逻辑字段，
   物理值由伴随文件承载**（`state/start-sha-store.ts`，同 `review_acknowledged_via`）：每个 revision 在 `.pipeline-run/start-sha/<revision>-<revisionId>.json`
   发布一份不可变记录 `{schemaVersion, revision, revisionId, stateDigest, sha}`，绑定该 revision 的 `stateDigest`，先于 immutable revision 与
   `current.json` 发布，值为空时不发布；`tenon get`、起点解析与快照经读取端 hydrate 得到它（同步读取路径同样还原）。**wire `state.fields`、
   mutation / TransitionRecord effects 与 `.pipeline.yaml` 投影都不含它**，所以新建的带 `start_sha` 的任务，N-1（升级前发布）运行时读得了、
   也能续写——与 `max_rounds` 不同（那个由用户主动设置，写进 wire）。读取：没有记录读作空串；记录被改动、形状非法、不是普通文件，或与
   revision / `stateDigest` 对不上，一律按损坏处理（失败关闭）。已知行为：N-1 运行时续写任务后，它写下的 revision 没有这份记录，当前版本读到的
   `start_sha` 为空，起点退回上游 / 基线分支候选（与「旧任务没有 `start_sha`」同一路径）；之后当前版本的写入沿用空值，不会重新发布。
   开发版曾把 `start_sha` 写进 wire：读取时没有记录就沿用 wire 值，下一次写入改发伴随记录；那份开发版 YAML 投影（多一行 `start_sha`）作为
   已知的 current / stale 形状接受，不会被判成漂移。历史里那条带 `start_sha` 的 revision 不会被改写（immutable），而 N-1 会校验直接 previous
   revision，所以这样的任务要在当前版本再写入两次之后 N-1 才读得了（只影响开发版建出来的任务）。`import-legacy` 把 `start_sha` 当受保护字段（YAML 里没有它，不能被空值覆盖）。
   空值在逻辑序列化里也不写（`state/omit-when-empty-fields.ts`），所以没有它的任务评审绑定摘要等逐字节不变。
   · 只读：`start_sha`、`base_branch`、`created_at` 决定任务起点，只由 `tenon init` 写入；`tenon set|set-many|cas` 拒写它们（exit 1，消息码
   `field.managedByInit`，状态不变）。此前 `base_branch`、`created_at` 可经 CLI 改写，现在不可以。
   · 起点解析（kernel `workspace/changed-files.ts` 会话 + `workspace/change-start.ts` 规则）：候选取 `start_sha`（是 HEAD 祖先、且提交者时间
   `git show -s --format=%ct` 不晚于任务 `created_at` + 60 秒时）、
   `merge-base(HEAD, <base_branch>@{upstream})`（上游存在时）、`merge-base(HEAD, <base_branch>)`（不等于 HEAD 时）中最新的；互为祖先取后代，
   不成链取二者的共同祖先（宁可多算、不许漏算）；没有任何候选才退回 `created_at` 之前的最后一个提交。不读提交信息与作者。
   `start_sha` 的时间校验是读取时校验：它的伴随文件（`.pipeline-run/start-sha/`）不在 wire 的 `stateDigest` 里（`created_at` 在），而真实的
   `start_sha` 是建任务时的 HEAD，提交时间必然不晚于建任务时刻；所以被改写成建任务之后的提交、读不到提交时间、`created_at` 不可用都让它
   不入选（`git show` 超时照旧抛 `ChangedFilesUnavailableError`）。伴随文件被改写或删除（读作没有 `start_sha`）只会让起点前移、改动范围变宽，不会漏算；
   已知限制：伪造 `GIT_COMMITTER_DATE` 提交出来的、时间早于 `created_at` 的提交能通过这条校验（同机同用户信任模型，同「评审绑定」的已知限制）。登记与同步、
   受保护配置审批、测试完整性、改动风险探针、评审者挂载、改动行覆盖率、证据导出、流转门（CLI 与 HTTP）、Dashboard 快照与
   `tenon verify --ci` 都经同一个会话入口取起点。git 调用超时照旧失败关闭（`ChangedFilesUnavailableError`）。
   · 已知限制：原地任务在 base 分支上提交了自己的改动并推送到它的上游后，起点前移过这些提交，它们不再算本任务的改动；worktree 任务的
   `base_branch` 是来源分支，任务分支的提交在合并前不在来源分支的上游里，不受影响。
