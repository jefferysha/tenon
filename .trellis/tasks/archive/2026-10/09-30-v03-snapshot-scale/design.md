# 快照规模与增量 · 设计

分支 `v03/snapshot-scale`（基于 `integ/v03`）。需求见 `prd.md`（R1–R4），起因见 `../09-30-v03-production/product-audit.md` §2.2。最终数字见 §6。

## 1. 复现

`tools/bench/snapshot.mjs` 用真实 `tenon init` 建夹具、真实 `tenon dashboard` 起服务，经回环 HTTP 取快照。夹具生成改成按项目并行，并可用 `--fixture-dir` 在开发机复用同一份夹具。机器：darwin-arm64，Node 24.18，16 核；测量时整机负载高（其它 agent 在并行跑测试，load average 90–150），所以每个数字都应读作上限。

修改前（`integ/v03`，缓存每次先丢掉，取 `GET /api/snapshot`）：

| 夹具 | change 数 | 响应 | p50 | p95 |
|---|---|---|---|---|
| 2 × 6 | 12 | 155 KB | 0.80 s | 0.84 s |
| 10 × 20 | 200 | 2.55 MB | 9.1 s | 13.4 s（样本 8 个，含一次离群） |
| 30 × 30 | 900 | 11.47 MB | 37.2 s | 41.3 s（样本 5 个） |

与审计一致（0.86 s / 9.4 s / 37 s / 11.4 MB）。

## 2. 画像：时间花在哪

用 `--cpu-prof` 起服务，对 10 × 20 重复冷重建；再用一个记录每次 git 调用的 `git` 垫片数子进程。

1. **git 子进程。** 一次重建 2420 个 git 进程，正好是每个 change 12 个：`rev-parse --is-inside-work-tree`、`rev-parse HEAD`、`merge-base`、`rev-list -1 --before`、`diff --name-only`、`ls-files --others`，各两遍（一遍给出口就绪判定，一遍给测试证据）。主线程只在 `child_process.spawn` 上就烧掉约 3.3 s CPU，其余时间在等子进程（剖面里 20 s 空闲）。整次重建约 90% 的墙钟时间是它。这些命令的结果只取决于（仓库、`base_branch`、`created_at`），同一项目的 30 个 change 几乎全部相同。
2. **快照体积。** 每个 change 平均 12.3 KB：`testPolicy` 2.5 KB、`workflowRules` 1.8 KB（同一计划的 change 逐字相同）、`agentRuns` 1.7 KB、`todo` 1.3 KB、`fields` 1.1 KB、`workflowExecution` 0.9 KB、`skillRuns` 0.8 KB、`documents` 0.7 KB。gzip 后只有 1/30，说明几乎全是重复。
3. **每个 change 的纯 CPU**（git 之后）：约 8 ms——读状态时把 39 KB 的冻结工作流计划整个重建再和指纹比对（`parseWorkflowPlanSnapshot` → `effectiveWorkflowPlanFromSnapshot` → `planFromIr` / `freeze` / `structuredClone` / sha256，约 17%）、`JSON.parse` 计划、出口判定里有界读文件时逐级 `realpath`、`agentRuns` 读 8 个冻结 agent 文件。
4. **缓存粒度。** 整份快照一个缓存项，任何非 GET 请求都清空；`maxAge` 30 s 一到，下一次读取重建全部。34 个真实项目就是 34 份重建。
5. **记录链。** `readRecordChain` 每次读都 `readdir` + 逐文件 `readFile` + `JSON.parse` + 解码 + 重算 sha256。实测每条链读取：300 条记录 443 ms，100 条 95 ms。夹具里没有记录，所以基准测不到这一项，由单测和上面的微基准覆盖。
6. **未跟踪文件上限**（20 000）静默截断；git 超时（20 s）每个 change 各等一遍。

## 3. 设计

### 3.1 git：一个项目一个会话（R3）

`createChangedFilesSession(repoRoot, { timeoutMs })`（kernel `workspace/changed-files.ts`）：

- 相同参数的 git 命令只跑一次（promise 按 argv 记忆）。`rev-parse --is-inside-work-tree --verify -q HEAD` 合成一个进程（仓库外 stdout 为空，无提交时只有 `true`）。
- 任务创建时刻对应的起点提交：一次 `rev-list --timestamp --max-count=2000 HEAD`，在同一份遍历序里取第一个不晚于该时刻的提交，与逐个 `rev-list -1 --before` 等价（有乱序提交时间和合并提交的仓库用测试对拍）；历史比窗口长且时刻更早才退回逐个调用。
- 每个起点一次 `diff --name-only`，整个仓库一次 `ls-files --others`。
- 超时策略：快照扫描里单命令 8 s；第一次超时后，会话里其余未缓存的命令立刻以同一原因失败（`git diff 超时（超过 8 秒）`），不再每个 change 各等一遍。超时和普通失败措辞区分。超时永远抛 `ChangedFilesUnavailableError`，不会被当成「没有结果」。
- 未跟踪文件上限：读前 20 000 个，结果里带 `untrackedTruncated: { found, limit }`；测试策略据此产出 `files-truncated` 提示（非阻塞；Dashboard 测试页签和 `tenon test sync` 文本 / JSON 里都能看到，带文案「把构建产物、依赖目录加入 .gitignore」）。
- 顺手修了 Linux 上的一个错位：扫描里 git 用的是锚点的 `/proc/self/fd/N` 路径，子进程解析不了；现在统一用子进程可用的真实路径。

10 × 20：git 进程 2420 → 70。

### 3.2 记录链校验缓存（R3）

`createRecordChainCache()`（kernel `test-system/record-chain.ts`）：按记录文件指纹（inode、大小、mtime、**ctime**）缓存解码结果和摘要校验结论；目录里文件名 + 指纹整体没变就直接复用上一次的链报告。ctime 由内核维护，写文件的人改不了，所以「改内容、保持大小、把 mtime 还原」也会让指纹失效（有测试）。**只给长驻进程的读取路径用**（Dashboard 快照的出口判定和测试证据）；转换门禁、`tenon test` 命令仍然每次从磁盘完整校验。目录数有上限（256，LRU）。300 条记录的链：443 ms → 3.3 ms。

另：读状态时重建冻结计划只为核对指纹，现在按快照原文的 sha256 记忆「已核对通过」（512 条上限，失败的原文永不记忆；伪造内容但声称同一指纹的原文仍然失败，有测试）。

### 3.3 缓存：按项目、按指纹、按写入点名（R1）

`packages/server/src/snapshotCache.ts`（装配在 `snapshotAssembly.ts`）。每个注册项目一个 cell：

- `list`（列表层）、`full`（完整层，仅文档化的 `GET /api/snapshot` 用，停读 2 分钟后释放）、`details`（单个 change 的详情，按 change 的 `rev`，每项目最多 16 个）。
- 键是该项目自己的输入指纹（`snapshotFingerprint.ts`：按项目、按 change 分组的 lstat 部件，sha1 压成 20 位）。指纹没变就不重建；聚合快照由各 cell 拼出来，未重建项目的序列化字节原样复用。
- `invalidate(roots?)`：写请求结束后只丢它点名的项目（query 或 JSON body 里的 `root`；query 里有的开始前也丢），没点名任何项目的写才丢全部；只算答案不写状态的 POST（router preview、scope preview）什么也不丢。在途构建用 epoch 保证「写之前开始的构建不会被写之后复用」，较早开始的构建晚完成不会覆盖较新的。
- `maxAge` 30 s 仍然兜住指纹没覆盖的输入（工作区内容、别处改的工作流文件、history）；每次读取最多刷新 4 个过期项目（最老的先刷），服务刚起时一起建出来的 cell 不会在同一刻全部过期成一次巨大重建。
- 指纹计算本身：按项目并行、同一项目内 change 并行、每个项目只读一次用户目录。30 × 30 一次约 35 ms（轮询每秒一次，约 3.5% 一核）。

### 3.4 分层：列表层 + 按需详情（R2）

- 扫描拆成 `snapshotChangeScan.ts`（单个 change、两个层级、项目级共享上下文：git 会话、当前用户、候选指纹、按计划指纹记忆的计划和规则）+ `snapshotProjectScan.ts`（枚举、归档划分、项目内并发 4、项目间并发 8）。
- 列表层 = 完整层去掉逐任务证据：`documents`、`skillRuns`、`agentRuns`、`tests`、`testPolicy`、`testPlan`、`testUser`、`testDiagnostics`；`workflowRules` 去掉 `policy`；`todo` 只留阶段状态；`fields` 在线上只留 `workflow`、`automation`（服务端内部的列表对象仍带全部字段，AFK 视图读它）。带 `rev`。已有的解码器早就接受「只有当前步骤的 readiness」，所以 `workflowExecution` 不变。列表层不读 `tasks.md`、不算文档证据、不算测试证据。测试用例断言：同一个治理过的 change，列表行 = 完整行去掉上述字段。
- 线格式（`snapshotWire.ts`）：每个项目单独序列化；项目内许多 change 共用的子树（规则、当前步骤 readiness、阶段状态、用户引用）写进 `shared` 表，change 用整数指向它。前端在严格解码之前把整数换回同一个对象（`api/snapshotWire.ts`），越界、非整数、缺表都让整份快照无效。
- 端点（全部向后兼容的扩展）：`GET /api/snapshot?view=list`、`GET /api/stream?view=list`、`GET /api/change/:name/snapshot?root=`（详情 = 完整层里那个 change + `rev`，归档的再带 `archive`；ETag / 304 / gzip）。不带 `view` 的 `/api/snapshot` 和 `/api/stream` 与以前逐字相同，文档化的契约不变。
- SSE：首帧是完整 `snapshot`，之后每个客户端各自记着上次发给它的项目摘要，只发变化的项目（`snapshot-delta`，带 `roots` 注册表顺序）；后来的连接不会把 `lastFp` 推过先到连接还没收到的变化（旧实现有这个丢更新的窗口）；前端对增量按引用保留未变项目。
- 前端：`fetchSnapshot` / `subscribeSnapshot` 走列表层并合并增量；`useChangeDetail(root, name, rev)` 在行带 `rev` 时读详情，`rev` 变了再读，同一任务重读时旧证据不闪掉，换任务回到 loading，失败给带重试的提示（中英文）；工作台右列收到的是「列表行 + 详情」合并后的 change，其余页面（任务列表、进度、收件箱、筛选）只读列表层，行为不变。没有 `rev` 的行（完整快照、旧 server）不发详情请求。

### 3.5 基准与 CI（R4）

- `bench-snapshot`（2 × 6，冷重建列表层）保留；新增 `bench-snapshot-large`（30 × 30，标 `slow`，不在默认 verify 里）：`snapshot_write_ms`（终端里用真实 CLI 改一个项目的一个任务，取列表快照）、`snapshot_ms`（冷重建）、`change_detail_ms`、`snapshot_bytes`。
- 验收线 p95 < 1.5 s 由脚本自己判（`--max-p95-ms 1500`，超了退出码非零，不依赖基线），catalog 里同样给中位数上限；载荷 < 1 MB 用 `snapshot_bytes` 的 `max` 判。CI 的基准步骤注册并运行它，基线候选照常上传；**不提交任何基线**。

## 4. 没做、以及原因

- **冷重建（所有缓存丢光）没有降到 1.5 s。** 900 个 change 约 2.3–2.6 s（负载高时 3 s 多），已经是纯 CPU：单线程，每个 change 约 2.8 ms（读状态 + 计划 + 出口判定）。再往下需要 worker 线程，而扫描依赖的 store / flow / 身份解析都是闭包，不能跨线程；不值得为冷启动引入它。验收线按「写入一个任务之后页面多久看到」定义（R1 之后这才是一次「重建」），冷重建作为回归护栏单列。
- 项目内不做逐 change 的列表缓存：一个项目指纹变了就重建这个项目（30 个 change 约 90–150 ms）。
- 出口判定里有界读文件的逐级 `realpath`（TOCTOU 防护）没动。
- 夹具所有 change 都停在 `open`：推进阶段需要真实技能调用证据，夹具做不出来。后面阶段的 change 多读 agent 台账、测试策略等，单个 change 更贵；项目级 git 会话和记录链缓存对它们同样生效。

## 5. 兼容

- 公开 HTTP 契约只增不改：旧调用方照旧拿完整快照。已打开的旧标签页连到新 server 后仍然在订阅不带 `view` 的流。
- 新增测试提示码 `files-truncated`（kernel 词表 + 中英文标签）；Dashboard 里未知提示码本来就原样显示。
- 所有持久化格式不变；缓存都是内存里可重建的派生物，来源是各项目的状态文件，失效靠指纹 + 写入点名 + 30 s 上限。
- tracked 产物（`packages/*/dist`）由 `npm run build` 重新生成。

## 6. 最终数字

同一台机器（darwin-arm64，Node 24.18）、同样的真实 `tenon init` 夹具；每个数字 15 个样本（修改前 5–10 个），整机负载 30–60（其它 agent 在并行跑测试，所以都是上限）。「写后重建」= 先用真实 CLI 改一个项目里的一个任务，再计时 `GET /api/snapshot?view=list`；「冷重建」= 缓存全丢后的第一次读取（服务刚起）。

| 夹具 | 修改前 重建 p50 / p95 | 修改前 响应 | 冷重建 p50 / p95 | **写后重建 p50 / p95** | 详情 p50 / p95 | 列表响应（原始 / 传输 gzip） |
|---|---|---|---|---|---|---|
| 2 × 6 | 0.80 s / 0.84 s | 155 KB | 64 / 145 ms | 44 / 51 ms | 73 / 77 ms | 13.7 KB / 2.0 KB |
| 10 × 20 | 9.1 s / 13.4 s | 2.55 MB | 475 / 500 ms | 82 / 85 ms | 76 / 84 ms | 153 KB / 6.5 KB |
| 30 × 30 | 37.2 s / 41.3 s | 11.47 MB | 1.93 s / 1.97 s（另一轮 1.97 / 2.01 s） | **128 / 133 ms** | 79 / 84 ms | **645 KB** / 21.6 KB |

- 验收线 30 × 30 重建 p95 < 1.5 s：**写后重建 p95 133 ms，达到**（`npm run bench:snapshot:large` 退出码 0，脚本自己按 p95 判）；首屏载荷 645 KB < 1 MB（原始字节，gzip 后 21.6 KB），达到。
- **冷重建 p95 约 2.0 s，没有达到 1.5 s**（见 §4）：比修改前快约 20 倍，但它不是被缓存的路径；它只在服务刚启动、或一次没有点名项目的写之后出现一次。
- 同一台机器上冷重建 CPU：900 个 change 约 4.6 CPU 秒（含 libuv 线程池），墙钟 1.9–2.0 s。
- 分步贡献（10 × 20，冷重建）：git 会话 9.1 s → 1.6 s；列表层 + 去掉逐任务证据 → 0.55 s；10 × 20 的写后重建再降到 0.09 s。

CI 画像基线不在本机提交：`bench-snapshot-large` 在 CI 上第一次运行只提示 `baseline-missing`，基线候选作为 artifact 上传。

## 7. 验证

见交付报告：`npm run build`、`npm test -- --maxWorkers=6`（608 文件 / 9043 用例通过，16 跳过）、`npm run test:web`（114 / 1563）、`npm run test:e2e -- --project=chromium`（20）、`check:architecture`、`check:comments`、`check:identity`、`check:docs`、`check:release-workflows`、`check:dashboard-dist-freshness` 全部通过。另在本机按 CI 的步骤用 `tenon test run ci-bench --suite bench-snapshot --suite bench-snapshot-large` 走了一遍（large 缩成 3 × 3 验证接线与指标解析），并确认 `--max-p95-ms` 超限时脚本退出码为 1。
