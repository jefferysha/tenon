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
  以 revision/revisionId/stateDigest 绑定；缺失读作 `unknown`）。两者都不进入 wire
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
- **字段序固定**：见 `types.ts::FIELD_ORDER`（46 字段；2026-07-11 v5 T4 决策 G **末尾追加**
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
  review 确认，而不是“刚进入 phase 就暂停”；例如 `verify-fail` 的确认绝不能授权 `verify-pass`。常规确认
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

- 相位：`open → explore → spec ⇄ build ⇄ verify → ship → archive`。
- **Requirements rollback**：build 中发现批准后的需求/设计语义变化时，唯一合法路径是
  `requirements-changed`（build→spec）。该回退不要求先伪造已 stale 的前向文档证据；进入 spec 后
  必须由 `pipeline-spec` 重登记 proposal/design/tasks 的当前 SHA、补读取收据并重新通过 spec review。
- **Phase-scoped Todo gate**：有标准阶段标题的 `tasks.md` 在出口只统计截至当前 phase 的未完成项；
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
  一次性聚合，Critical/High/Medium 全部清零才可通过。预算耗尽后停止自动 Review，等待显式人类处置。
- **Build→Verify 可复验基线**：状态字段仍命名为 `build_sha` 以兼容既有 state ABI，但新 Build 必须写入
  `build:v1:<git|workspace>:<revision_hash>:<repository_hash>:<worktree_hash>` typed token。三个摘要
  是 domain-separated SHA-256；token 不含绝对路径、prompt、credential 或裸 SHA。`isolation=branch|worktree`
  以物理 Git common-dir/worktree identity 绑定 object ID，`isolation=in-place` 绑定排除 `.git`、依赖、
  OpenSpec/文档证据、pipeline 控制文件与测试缓存后的 `workspace:sha256:<64 hex>` 内容指纹。旧裸 Git SHA
  或旧裸 workspace baseline 不会 backfill，必须回 Build 重新捕获。`verify-pass` 会重算当前 identity/
  revision，并用 validated canonical transition head、唯一 `build_sha` effect 与当前 Verify-like step
  证明来源；缺失、非法、漂移、能力/来源无法证明都返回 stable
  `verify-build-revision-untrusted`，remediation 为 `return-to-build-and-capture-current-revision`，
  只投影 closed reason 与 `sha256:` state/revision hash。in-place 绝不要求或伪造 commit；工作区能力缺失或
  返回非规范值时 build-complete 与 readiness 均 fail-closed。
- 合法转换与 `review_phases` 由 `templates/manifest.yaml` 派生（**引擎侧真读该字段**——
  这是对老内核 state-transition.sh 硬编码欠账的构造性修复）。
- 门 marker 文件（项目根）：`.pipeline-pending-confirm` / `-review` / `-interaction`，
  存在且 age ≤ 分级 TTL 视为新鲜 → hook 拦截；陈旧 marker 由 gate.sh 顺手清除。
  TTL 分级（BACKLOG #13，对齐老内核 pipeline-gate.sh；TS 侧单一数值真相源
  `types.ts GATE_TTL_MS`，bash 侧 gate.sh/statusline.sh/session-start.sh 镜像）：
  **confirm 300s**（漏确认安全网，爆炸半径 5min）；**review / interaction 1800s**（跨整个
  决策 phase，缩短会中途误清 → 绕过强制复核）。边界同老内核：age > TTL 才陈旧。
- **持续交互授权投影（不是第四道 gate）**：用户在正常对话明确说“后续不用问 / 自主执行完成”后，
  `pipeline session activate <change> --continuous --host-session <id>` 或带合法 `session_id` 的 UserPromptSubmit 会写
  当前用户的 `.tenon/users/<slug>/local/authority`。它是版本化、原子发布、只含 `change/scope/review/issued_at` 的
  Change 与 host-session 双重绑定投影，只有该用户的 `local/active-change` 指向同一 live Change、且 hook
  输入携带同一 `session_id` 时 `interactive-skill-gate.sh` 才会
  识别；格式不完整、换 Change、已归档或撤回均 fail-closed 回到普通 interaction gate。它只避免每次
  读取 `brainstorming` 等交互式 skill 时重复要求低风险确认，同时在 Change history 留下最小化审计行；
  **绝不**清 `-review`、不写 canonical approval receipt、不能自动 transition，也不能替代涉及范围、
  安全、成本或外部状态的实质决策。
- `review_phases` / custom `gate: review` 都是**出口**门：完成相位产物并选择 event 后运行
  `pipeline review request <name> --event <event>`，它先原子写 canonical pending receipt、再写
  `pipeline-review-v2` marker（含 phase/change/event/requested_at）。单出口可省略 event；多出口必须显式指定。
  展示产物后，用户明确确认会触发
  `pipeline review acknowledge <name>`，写 approved receipt 并清 marker；`transition` 只消费
  当前 source phase 与 event 都匹配的 approved receipt。dashboard 的显式真人 transition 点击等价于同一确认，
  但 CLI/agent 无法伪造该 flag。旧三行 entry-time review marker 被 hook 作为迁移遗留投影清理/忽略，
  不能绕过 canonical exit check。
  default 的 `verify-fail` 是内建回退 event：它校验真实 `verification_report` 与受治理的 OpenSpec
  文档证据，而不错误运行只适用于 `verify-pass` 的成功 guard。自定义多出口 review workflow 必须为每个
  可选 event 定义在该结果下可满足、可审计的前置证据；CLI 永远要求显式选择 event，不会猜测或复用另一出口的确认。

## 3. CLI 面（`pipeline <cmd>`）与输出契约

| cmd | 参数 | stdout 契约 | exit |
|---|---|---|---|
| init | `<name> --track --preset [--user]` | 无（`[INIT] 路径` 走 stderr） | 0/1 |
| get | `<name> <field>` | 裸值一行；字段缺失/未知 → 空行 | 0；change 缺失/名非法=1 |
| set | `<name> <field> <value>` | 无输出 | 0；四闸/枚举/未知字段拒写=1 |
| set-many | `<name> k=v...` | 无输出 | 同上 |
| cas | `<name> <field> <expect> <new>` | 无输出 | 0；不匹配=3；错误=1 |
| transition | `<name> <event>` | 无（`[TRANSITION] name: old -> new` 走 stderr） | 0；非法/未知事件=1 |
| check | `<name>` | guard 报告（人读） | 0 过 / 2 不过 / 1 错误 |
| review | `request\|acknowledge <name> [--delegated]` | review receipt 状态 | 0 成功；2 投影写/清失败（receipt 已提交）；1 用法/状态错误 |
| status | `[name] [--json]` | 单 change 摘要 | 0 |
| list | `[--json] [--archived]` | 活跃 change 表；`--archived` 为当前用户已归档表 `NAME PHASE ARCHIVED_AT BY` | 0；归档记录损坏=1 |
| task delete | `<name> [--yes] [--json]` | 无（`[DELETE] name` 与 `未提交删除 n` 走 stderr）；`--json` `{change,removed,uncommitted_deletions}` | 0；用法/名/缺任务/身份/记录损坏/失败=1；待确认=2；被阻止=3 |
| task archive | `<name> [--yes] [--json]` | 无（`[ARCHIVE] name phase=<phase>` 走 stderr）；`--json` `{change,changed,archived_at,phase}` | 同上 |
| task unarchive | `<name> [--json]` | 无（`[UNARCHIVE] name` 走 stderr）；`--json` `{change,changed}` | 0/1 |

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
> 2026-09-16（workflow-io-openspec）：文档治理只有一个开关 `openspec: true`，`openspec_contract`
> 已移除。契约写在它引用的 `steps` 旁边：单流程写顶层 `document_contract`，有 `tracks` 时逐分支写
> `tracks.<id>.document_contract`；slot 的 `role` 只有 `produce | update | require`，scope 与路径由
> kind 决定（`design-md` → `DESIGN.md`）。未声明契约的 Workflow 是自由模式。`document_contract` 缺少
> `openspec: true`、owner/read 引用不存在或读取发生在 owner 之前均在 parse/compile/validate 阶段失败。
> CLI、server 与 dashboard 投影消费同一编译结果，不按 workflow 名猜测文档策略。

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
   （`{ id, repo, path, commit, previous_commit, tree_sha256, license, fetched_at }`，随 payload
   分发、不入 git）。内容哈希沿用 `tree-sha256-v1`。单个 Skill 要么完整替换、要么保留旧内容，
   不留半装状态；内容未变时锁字节不变，更新报告 `current`。获取失败、缺许可证、许可证不符、
   上游改名或删除都不改变已激活 release，`<stateRoot>/skills/last-update.json` 记录该次结果，
   `tenon doctor --skills`、`skills:upstream` 与 Dashboard `技能` 页显示来源/提交/许可证/更新时间。
   verifier 的 declared 集合是 registry ∪ lock：缺目录、未登记目录、内容漂移、锁与 sources 不一致
   一律 fail-closed。开发 checkout 用 `npm run skills:fetch` 获取，获取物与锁均 gitignored。
