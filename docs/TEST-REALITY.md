# TEST-REALITY — 测试真实性审计（GOAL C9/C10）

> 向 Tenon contract 学习：`tenon-check` 跑真实工具链而非自评。本仓每条功能的收编门以**真实证据**为准。
> 本文件登记每层测试「真 or mock」与覆盖缺口，缺口显式登记、不静默留白（2026-07-07 起维护）。

## 2026-08-10 · #42 trustworthy build revision implementation checkpoint

- Kernel/CLI/server source now carries the `build:v1` revision token, physical identity assessment,
  immutable transition-head provenance, and a shared `verify-build-revision-untrusted` blocker. Missing
  capability, malformed/legacy values, identity or revision drift, and provenance failures are fail-closed
  before commit; default and arbitrary-step custom lifecycle paths share the capture/guard policy.
- Automation admission and settlement map missing/invalid authoritative branch revision and revision-subject
  drift to the same stable cause; L3 does not merge. Dashboard readiness decoding and AFK/Progress diagnosis
  consume the stable cause/remediation without exposing raw token/path/exception data.
- `npx tsc -b packages/kernel packages/cli packages/server packages/automation --pretty false` and
  `npx tsc --noEmit -p packages/dashboard-app` passed after implementation. Fixed-worker targeted Vitest
  runs covered kernel trust/action/guard/transition suites (134 tests), automation verifier/scheduler/admission
  (279), CLI transition/check/default+custom integration (126), server snapshot/transition authority (93),
  and Dashboard decoder/model/Progress/AFK/i18n suites (247 + 54). `npm run build` completed and refreshed
  tracked CLI/server/dashboard bundles. Browser verification and the repository-wide final gate remain out of
  scope for this implementation worker; this entry is not a Verify verdict.
- Rework-specific fixed-worker runs were executed on the same checkout: review-candidate/attempt/internal-gate
  (27/27), Dashboard decoder/model/Progress mixed-Verify readiness (147/147), physical Git identity
  (3/3), and kernel guard/default-event plus CLI doctor (151/151). The server actual-transition contract
  was run by name (`malformed Build revision`): 1 passed, 313 skipped; it asserted the exact 409 blocker
  DTO and byte-for-byte canonical/record/history non-mutation, with snapshot/SSE blocker projections free of
  raw token and path data. These are incremental evidence only; the full final gate and browser QA remain
  intentionally unrun.
- Final fixed-worker rerun after the lifecycle/readiness and legacy-ABI corrections: kernel trust/action/guard/
  readiness/transition/identity set 199/199; automation verifier/revision/scheduler/admission/lifecycle set
  227/227; CLI review/doctor/check/transition/integration set 171/171; server snapshot/authority set 79/79
  plus the named actual-transition contract 1 passed (313 skipped); Dashboard strict decoder/model/Progress
  set 147/147. Four-package TypeScript build, Dashboard typecheck, production `npm run build`, comments,
  interaction-contract, default-workflow freshness, skill inventory, release-workflow checks, and
  `git diff --check` all passed. The legacy oracle binary is unavailable in this checkout, so the updated
  fixture was syntax-checked only; no full repository test or browser QA was run.

> **当前任务口径（2026-07-20）**：本文件是追加式历史审计账，不是当前 todolist。当前任务唯一真相源为
> `GOAL.md`（94/94 已勾选、0 未勾选）与 `BACKLOG.md`（队列空）。下方早期“待补”标题和旧测试数字保留
> 当时语境；v3 最新 source/dist/live/真实浏览器对照见
> `docs/ux/2026-07-19-v3-backend-to-frontend-gap-inventory.md`。

## 2026-07-30 · 最终独立复审回退修复证据

- 三个独立复审轨在 `8224c75d` 上给出合并结论 C0/H2/M7/L4，所有严重度均未豁免。
  Release/后端轨发现 release candidate 未固定 OpenSpec CLI 且缺少全仓 strict gate、
  canonical CI action 使用可移动 tag、Skill transcript 完成态会误扫 Skill stdout。
  Dashboard 轨发现 Machine 在事实未决时提前显示无阻塞、compact Operations 缺少重试和
  工具级空态、阶段/Skill 排序只支持指针、radio group 键盘语义不完整、帮助图标与导航计数
  缺少可访问名称。E2E 轨另发现 Loop refresh/save 会覆盖整份本地草稿、`beforeunload`
  注册存在时序窗口、测试现实和发布声明已过期。
- OpenSpec CLI 现在以 `@fission-ai/openspec@1.6.0` 精确锁定在根 lockfile；canonical CI 与
  release candidate 都运行 `openspec validate --all --strict --no-interactive`。
  `actions/checkout` 与 `actions/setup-node` 均固定完整 commit SHA，release contract
  23/23 通过；全仓 OpenSpec strict validation 为 35/35。
- Skill transcript 状态只从宿主信封读取，不再把 Skill 自身 stdout 中的
  `Process exited with code 1`、`exit_code: 9` 或 `Script failed` 当作调用失败；
  receipt 定向套件 105/105 通过。
- Dashboard 新增完整 Arrow/Home/End roving radio 行为、键盘可达的阶段与 Skill 排序及跨阶段
  移动、focusable 帮助控件和带名称的导航计数。Machine 等待全部权威事实后才计算阻塞结论；
  compact Operations 对失败提供就地重试，并按 starter/run/sync 的真实数据呈现独立空态。
- Loop 草稿以逐字段 revision 与 server 基线重放：刷新只更新未触碰字段，保存只接受本次提交的
  字段，保存期间继续输入的更高 revision 保留。Workbench 的 dirty ref 在编辑回调内同步更新，
  `beforeunload` 监听常驻，消除了 commit 与 effect 之间的离开窗口。
- 当前源码门禁：root 327 files / 5810 passed / 14 honest-skip、Dashboard 73 files /
  1445 tests、typecheck、698-file architecture、release contract 23/23、OpenSpec 35/35、
  receipt 105/105 全绿。首次并行高负载运行唯一失败为既有 5 秒集成测试超时；同一 Hook 文件
  9/9 通过后，完整 root 套件以 15 秒集成上限重新执行并全部通过。
- 干净 `npm ci` 后连续两次完整 build 逐字节稳定：CLI
  `74bf6154…c366`、Server `e2327b62…a07`、Dashboard JS
  `index-CRNCuoIq.js`（`64fbca9d…299`）、CSS `index-CLLRnTB_.css`
  （`1200acad…226`）。hooks 512/512、adapters 272/272、bundle 31/31、
  migration CAS 13/13、npx contracts 39/39、双语 docs 和五套 oracle 全绿。
  最终冻结 SHA 仍须执行生产浏览器 21 场景矩阵与 exact-SHA 独立复审，
  在这些证据完成前不宣称 Verify 通过。

## 2026-07-29 · 合并后统一审查当前证据

- Dashboard Workbench 的 header、内建阶段、Track 设置、执行时间线、Hook、Skill 编排、mandatory
  Skill、产出与可访问名称使用同一 `I18nProvider`；英文回归保留用户自定义中文数据，但拒绝已知产品
  中文残留。root `npm run test:web` 当前 67/67 文件、1210/1210 tests 通过。
- Governance 升档确认绑定 root、loop id、自治级、就绪、预算和 graduation 决策事实；逻辑等价的
  snapshot 对象刷新不再关闭确认，事实变化仍关闭并把焦点归还触发器。
- 依赖基线 5 Moderate / 1 High / 1 Critical 已收敛为 audit total 0。解析树为 AJV 8.20.0、
  Vite 6.4.3、Vitest 3.2.7、VitePress 1.6.4；VitePress 的 Vite 6.4.3 override 已通过 root build、
  Dashboard 全量测试与 docs check/build。
- CI、pre-tag candidate 与 tag release workflow 现在执行同一
  `npm run check:dependencies`，同时阻断 High/Critical advisory 与 `npm ls --all` 无效解析树。
  `Release candidate (pre-tag)` 的验证 job 为只读且 checkout 不持久化凭据；它只接受精确且仍为
  最新 `main`、并已有成功 canonical push CI 的完整 SHA；首次发布接受新 tag，中断恢复只接受
  peeled commit 精确等于该 SHA 的现有 tag，成功后发布 digest 规范化的 approval evidence。
  默认分支拥有的 `workflow_run` writer 重验仓库、workflow、run、artifact 与获批 SHA；创建新
  tag 前再次要求最新 `main` 精确一致，恢复同 SHA 现有 tag 时则幂等继续。writer 与 packaging
  均不 checkout/不执行仓库代码，packaging 以 `expected_sha` 再验证 peeled tag commit。
- 干净 `npm ci` 后，root Vitest 327/327 文件、5741 passed、14 个仓库既有 honest-skip；
  Dashboard 67/67 文件、1210/1210 tests 通过。生产 build、docs check/build/smoke、架构、
  注释、仓库卫生、身份、default workflow freshness、文档模板、npx 包、512 hook tests、
  13 migration CAS tests、golden oracle 与 legacy bridge 均通过。
- 当前第三次 Build clean production 资产 `assets/index-BwFU9uOX.js` /
  `assets/index-lJPhasUc.css` 已在真实 Chrome 复验 390px 英文 Automation：三操作按钮全部
  位于视口、自动换行且键盘焦点可见；工具 Dialog 与真实临时失败 Change 的重试 Dialog 均通过
  首焦点、Shift+Tab 困笼、Escape 关闭及触发器焦点归位，console/page error 为 0。完整
  390/720/1024/1440、zh/en、主题、状态与全 Dashboard 矩阵仍由冻结 SHA 的下一轮 Verify 判定；
  Build 证据见 `docs/superpowers/reports/2026-07-29-post-merge-unified-review-pre-verify.md`。

## 2026-07-29 · Host Target Plan 当前证据

- CLI/server：12 个固定宿主 × setup/update 真值表、严格 query、Host 守卫、固定 argv、
  严格 JSON/DTO、错误脱敏、同 key 共享、失败重试、25-key 缓存、4 并发与 10 秒超时均有
  定向回归；生产 API 实测成功 200、非法/重复/额外参数 400、恶意 Host 403。
- Dashboard：真实生产同源 server 覆盖 1440/1024/900/769/768/390、明暗主题、中英文、键盘、
  focus、复制、移动端选中定位、无横向溢出与控制台零错误/警告。`design-taste-frontend`
  审查发现的卡片重排、移动端详情位置和未压缩传输均已修复。
- 静态资产：最终生产 JavaScript 资产原始 851,512 bytes；`Accept-Encoding: gzip`
  实测返回 257,888 bytes、`Content-Encoding: gzip`、`Vary: Accept-Encoding`；
  `gzip;q=0` 返回原始 851,512 bytes。
- 契约：适配器计划固定使用安全 argv `--target .`，不再输出会被 shell 当作重定向的
  `<project>`；CLI、API、Dashboard、英文/中文文档与生成分发物保持同源。

## 真实证据链（三道，收编门必过）

## 2026-08-10 · Issue #46 interaction observability evidence

- Post-integration focused kernel/CLI Vitest is real source execution: 10 files,
  157 tests passed.
  Coverage includes closed/privacy codec and matrix round-trip, deterministic replay,
  projection sequence/hash/truncation/symlink failures, scorecard denominator guards,
  unknown-code unclassified handling, scorecard CLI path/error sanitisation, exact review
  journeys, session resume, and projection-failure compatibility.
- Tracked fixture replay is deterministic through the built CLI bundle:
  tenon interaction scorecard tools/fixtures/interaction-events/v1 --json.
  It reports governedCompletionRate 0.6, humanInterruptionsPerVerifiedCompletion
  1.6666666666666667, medianTimeToValidResumeMs 4000, eventCompleteness 1,
  acceptedStaleDecisions 0, sameStateRepeatedPrompts 0, invalidResumes 1; projection-loss,
  malformed-order, and wrong-resume remain negative controls with sequence-gap,
  malformed-order, invalid-resume, and incomplete-success-journey diagnostics.
- Post-integration root verification ran the full repository Vitest suite: 387 files,
  6,729 tests passed, 27 environment/CI-gated tests skipped, and 0 failed. Docker-backed
  cases were honestly skipped because the local daemon was unavailable; the real-Codex
  acceptance remained CI-gated because `TENON_REQUIRE_REAL_CODEX!=1`. This change has no
  Dashboard UI or server API surface, so browser acceptance was not applicable.
- `npm run build`, `npm run check:architecture` (864 production files), OpenSpec/docs,
  comments, repository hygiene, release-workflow/identity, default-workflow/document-template,
  legacy/npx packaging, migration CAS, and the 32-case bundle smoke gate all passed. The
  CLI and server dist artifacts were regenerated from the merged source graph.

## 2026-08-10 · Issue #66 bounded remediation worker evidence

- TDD RED replay evidence: `npx vitest run packages/kernel/src/interaction/replay.test.ts
  --minWorkers=4 --maxWorkers=4` initially reported 21 tests with 2 failures because terminal
  successors and unknown extension core events were silently skipped. Sidecar RED evidence:
  `npx vitest run packages/kernel/src/state/review-gate-binding.test.ts --minWorkers=4
  --maxWorkers=4` initially reported 4 tests with 1 failure because the old reader accepted
  reordered non-canonical JSON.
- Focused green gate:
  `npx vitest run packages/kernel/src/interaction/replay.test.ts packages/kernel/src/interaction/scorecard.test.ts
  packages/kernel/src/state/review-gate-binding.test.ts packages/cli/src/commands/review.integration.test.ts
  packages/cli/src/commands/transition.test.ts --minWorkers=4 --maxWorkers=4` — 5 files, 87 tests passed.
  Coverage includes every terminal successor class, unknown-code fence, idempotent resume, canonical
  sidecar bytes, missing/ambiguous/oversize/symlink/non-regular/UTF-8 cases, deterministic read-window
  mutation/replacement/disappearance races, CLI refusal, fresh-request recovery, and projection independence.
- `npx tsc -b packages/kernel packages/cli --pretty false` passed. `npm run bundle` and
  `npm run build:server` regenerated the tracked CLI/server artifacts; `bash tools/test-bundle.sh`
  passed 33/33 checks.
- The worker did not run the root-owned full `npm test`, `npm run build`, architecture/comments/oracle/
  OpenSpec gates, formal Review, PR/CI, or browser/Docker/real-Codex acceptance. Those remain separate
  evidence owned by the root agent; this Change has no Dashboard/server route or browser surface.

| 层 | 文件 | 真实性 | 驱动什么 |
|---|---|---|---|
| **真 fs 集成** | `packages/cli/src/integration.test.ts` | 🟢 真 | `buildProgram` + 真 `createStateStore/createFlowEngine/loadManifest/createHistoryWriter` + 真临时目录，断言真实落盘的 .pipeline.yaml/JSONL/marker 字节；真子进程跑 dist bundle --help |
| **golden-oracle 双跑** | `tools/oracle/run.sh` | 🟢 真 | 真跑老内核 `pipeline-state.sh`(bash) vs 新 CLI(node)，stdout+exit+落盘三面逐字 diff |
| **bundle 冒烟** | `tools/test-bundle.sh` | 🟢 真 | 真起子进程跑编译产物 init→get→transition→history 全程 |
| **managed release 事务** | `packages/cli/src/runtime/release-store.integration.test.ts` | 🟢 真 | 真复制完整候选、发布 immutable release，并验证 selection 与稳定 launcher 字节/mode 的精确补偿 |
| **安装入口与 npx 包** | `tools/install-bootstrap.node-test.mjs`、`tools/build-npx-package.node-test.mjs` | 🟢 真 | 真 bash 跑 Codex/Claude 一步安装计划；真生成发布包并验证 release installer SHA-256 |
| **hook 脚本** | `tools/test-hooks.sh` | 🟢 真 | 真 bash 跑 gate/breadcrumb/session-start/statusline，真 marker 文件三态 |
| **kernel 单元** | `kernel/src/state/*.test.ts`、`flow/*.test.ts` | 🟢 真 | 真解析/真 mkdir 锁/真 base64/真 fixture 往返——本就无 mock |

## mock 层（快速回归，**不单独构成收编证据**）

| 文件 | 性质 | 为何保留 | 真实对位 |
|---|---|---|---|
| `cli/src/commands/*.test.ts` | 🟡 mock（mockStore/mockFlow） | 毫秒级定位命令层逻辑分支、错误路径穷举 | 每条命令在 integration.test.ts 有真 fs 对位用例 |
| `cli/src/program.test.ts` | 🟡 mock | commander 装配与 exit 映射的快速回归 | integration 走同一 buildProgram 真路径 |
| `cli/src/test-support.ts` | mock 工厂 | 上述 mock 层的基座 | — |

**规则（GOAL C9）**：新增命令/子系统 → 必须同时进 integration.test.ts 真 fs 面；只有 mock 单测 = 未收编。

## 真 fs 集成覆盖矩阵（GOAL C10 全量要求）

| 命令 | happy path | 关键错误路径 | 跨命令串联 |
|---|---|---|---|
| init | ✅ 落盘字段序 + `--workflow <name>` 真加载校验后种 phase=steps[0].id（init-workflow.integration.test.ts 6 例，2026-07-08 whole-branch review 补：此前无支持命令能把 change 摆到自定义 workflow 首个 step 上） | ✅ workflow 未找到/非法（校验失败）均 exit 1 且不落盘半成品 change | ✅ 全程起点；`--workflow` 落地的 change 可直接被 internal-skill-gate/transition 消费，链式验证见同文件 |
| get | ✅ 读回 init 值 + 未设字段忠实 null + 未知字段空行 | ✅ grep-miss | ✅ |
| set | ✅ 写+history | ✅ 四闸拒写字节不变 | ✅ |
| set-many | ✅ 真原子写+字段序 | — | — |
| cas | ✅ 匹配写入 | ✅ 不匹配 exit 3 | ✅ |
| transition | ✅ 改相位+marker+history+全副作用（#14，见 transition-effects.integration.test.ts 17 例） | ✅ 非法 exit 1 + 12 条前置校验路径 | ✅ 喂足真实前置的七相位全程 |
| workflow 自定义引擎（GOAL 清单 E） | ✅ 解析/校验/DAG/guard 各自单测（parse.test.ts/validate.test.ts/skillDag.test.ts/stepGuard.test.ts）+ loadWorkflow 真 fs 5 例（含 E5 校验 fail-loud 2 例）+ 真实 step 间转换（transition-custom-workflow.integration.test.ts 3 例）+ gate.sh 委托真 bash 子进程（internal-skill-gate-hook.integration.test.ts 6 例）+ migrate-workflow（migrateWorkflow.test.ts）+ init --workflow 首个 step 落点全链路（init-workflow.integration.test.ts 6 例） | ✅ 循环依赖/悬空引用/死路 step 保存时拒绝（E5）+ 非法 event/guard 不满足运行时拒绝 | ✅ init --workflow → internal-skill-gate → transition 全程走真实支持命令，无需手改状态文件（2026-07-08 whole-branch review 补，见 G13 及 init 行） |
| inbox TTL 分级 | ✅ inbox-ttl.integration.test.ts 7 例（真 mtime + 分级 300/1800s） | ✅ 边界 age>TTL | — |
| task lifecycle | ✅ task.integration.test.ts 14 例（真依赖图/级联/canonical，含物理归档节点反查）+ 走 buildProgram 1 例 | ✅ | ✅ add-dep→children→remove |
| manifest 全派生 | ✅ manifest-derive.test.ts 18 例（真读 templates/manifest.yaml → 真派生，改 yaml 即变） | ✅ 未知 track fail-loud | — |
| living-spec | ✅ spec.integration.test.ts 14 例（真枚举 openspec/specs + 真落 spec_scope 标量 + 真 inject-jsonl cat/目录展开）+ 走 buildProgram 1 例 | ✅ | — |
| session | ✅ session.integration.test.ts 14 例（真落当前用户 active-change + 两用户隔离 + monorepo 真路由）+ 走 buildProgram 1 例 | ✅ 缺 change exit1 / degraded 不炸 | — |
| router hook | ✅ test-hooks.sh section9 32 断言（真跑 router.sh：三 Track 选对 + breadcrumb 注入 + 缓存单源实证 + 命中缓存零 node spawn shadow 证明） | ✅ patterns 缺 exit0 不阻断 | — |
| sync / uninstall | ✅ sync-uninstall.integration.test.ts 16 例（真装文件/真写 .pipeline-owned.json/真删自己装的/真保留 user-modified/真 scrub 写回）+ 走 buildProgram 2 例 | ✅ dry-run 不动盘 | — |
| PostToolUse 四 hook | ✅ test-hooks.sh section10 64 断言（真跑：confirm-clear 真清 marker + decision/skill 真 append JSONL + 转义硬测 + interactive-gate 真注入姿态+硬门） | ✅ 无 change 不写/归档跳过/fail-open | — |
| mem 跨 runtime | ✅ mem.integration.test.ts 12 例（真建 Claude/Codex/Pi fixture session → nodeMemFs 真读真解析 → 真检索评分排序/cwd 作用域/聚合） | ✅ OpenCode 降级 no-op（诚实待补） | — |
| dashboard server | ✅ packages/server 38 例（17 真 node:http 请求 + 真 crypto token + 真 SIGTERM 版本抢占 + 2 bin 级真进程 smoke） | ✅ POST 无 token 真 401 / Host 守卫 403 | — |
| channel worker 总线 | ✅ channel.integration.test.ts 12 例（真 append events.jsonl + 真重建 registry/forum + seq 无空洞 + **barrier 隔离红线**：跑完 cwd 零 openspec/门 marker mtime 不变） | ✅ send 三态 | ✅ create→send→messages |
| 前端 dashboard-app | ✅ 71 真 render 测试（jsdom 真 render DOM + 真拖拽 fireEvent + SSE 真 EventSource stub emit→组件更新）+ 3 真 server HTTP 集成 | ✅ transition 失败呈现/非法 no-op | ✅ 收件箱默认→看板→设置 |
| server 服务 SPA | ✅ server.test.ts +1（真起 server webRoot → GET / 真返 SPA index.html+token 注入 + /assets/* 真供给 + 路径穿越防护） | ✅ 穿越 !=200 | — |
| loops 治理 | ✅ loops.integration.test.ts 15 例（真建 loops.yaml/progress.md → 真裁决 R1-R11 verdict + L1 report-only/L3 unattended + schema 拒非法 exit3） | ✅ budget 超限 kill | ✅ list→enforce→status |
| tap 流量代理 | ✅ packages/tap 116+ 例（13 真 socket + bedrock CRC32 交叉校验 + **真 crypto 本地 CA 真自签真 X509 验签 + 真 TLS MITM 终结解密**(node v24 真跑 0 skip) + 13 runtime clients；源码级扫描断言 certs 零 outbound + CA 私钥 0600）+ doctor tap 灯真跑 + **#34-wire（iteration-30）**：daemon.ts 真接 CertificateAuthority.fromDir→serveForward({ca})（2 真 TLS MITM 例，走 daemon 装配非直调）+ launch.ts 真装配 detectTarget/reverseEnvMap/forwardEnvMap（7 例，含真绑端口+真转发）+ forward-proxy 响应体真接 decodeBedrockEventstreamEvents（1 例，非流式装配 converse body）+ **全新 ws-proxy.ts**：WsFrameAccumulator 增量帧合并 + wss:// 真中继（CONNECT→TLS MITM→upgrade→真握手透传→reconstructWsRequestBody/ResponseBody 首次接活，7 例，含 prompt-bearing 门控/capture OFF 门控）+ security.ts InterceptEntry.tls 供 doctor「正在解密」披露（2 例） | ✅ 默认 OFF 真不监听 / capture OFF 不解密 / 8766 隔离 / forward 缺 ca 拒绝而非盲隧道误导 | ✅ `pipeline tap start` CLI（见下）|
| automation AFK | ✅ packages/automation 113+ 例（纯逻辑真状态机/race idle·grace·abort/boundedTail 64KiB/git 双挂载/merge-back 冲突判定 + 真 kernel fs 集成 + **真 git 集成**：worktree add/remove、merge-back 干净交付+冲突留现场、barrier 派生+drift）+ **#29-wire（iteration-30）**：createDockerRunChange 真接 createLifecyclePorts+runChangeInSandbox，dockerRunChange.integration.test.ts 3 例真跑 sandcastle:test 镜像（L3 真容器+真 worktree+真 merge-back+真 barrier build_sha；L1 report-only 真验证不 merge）；docker.integration.test.ts/container.integration.test.ts 原 4 处 honest-skip 中 2 处（非 token 门控）已真跑通过 + **RunChangeConfig.extraEnv（iteration-31）**：真流到 docker run -e argv（dockerRunChange.test.ts 2 例 fake exec 断言 + lifecycle.test.ts 1 例），此前无任何通道能把凭证/代理地址传进沙箱是真实遗漏，本轮真 token 验证时发现并补齐 | ✅ L1→paused/L3→merged/conflict 留现场（真 SyncError→worktree 不清+preserved_path） | ✅ enqueue→scan→run（真容器）+ **真 token 全链路（iteration-31）**：容器内自起 tap reverse proxy（放弃 host.docker.internal 方案，该方案在本环境对宿主监听端口真实静默丢包，已用真 http server+真 docker run 探测证实）→ claude CLI 走代理连真 api.anthropic.com，tap trace_store 真记录 4 条完整请求（含真实 User-Agent/系统提示词/Bearer 头）——证明代理路由约束成立；该次提供的 token 被 Anthropic 真服务端拒绝（401 Invalid bearer token，未耗真实 API 额度），故 agent 编码成功这一步本身仍未验证，待有效凭证 |
| 上下文压缩 | ✅ handoff.integration.test.ts 7 例（真建长文档 → 真压缩 → 断言压缩率≥25% + 决策/约束保留 + 样板去除）；确定性零 LLM 可 oracle | ✅ 无文档/缺 change | ✅ 达 build 相位 handoff |
| Context Bundle v1 + Dashboard budget preview | ✅ ledger-context-bundle.test.ts 17 例 + context-bundle.integration.test.ts 3 例（真 ledger、真 SHA-256、port primitives、确定性聚合摘要、UTF-8 预算、缺失/漂移 fail-closed）；contextBundleTrustedReader.test.ts 15 例（fd-relative、BOM、FIFO/symlink、canonical state）；ContextBundlePreview.test.tsx 16 例（loading/empty/success/error/retry/竞态/i18n/键盘/交互态）；legacy handoff 7 例保持兼容 | ✅ 非法路径/digest、previous transition record 损坏、非普通文件、资源/预算超限与无 trusted fd 平台均失败关闭 | ✅ `pipeline handoff <change> --bundle --target <phase> --json` 与 `GET /api/context-bundle/preview` 复用同一 ledger compiler；Linux UI→API 预览，Darwin 501 |
| auto-transition advance | ✅ advance.integration.test.ts 6 例（真推进到复核相位即停 + guard 不过不推进 + dry-run 不改盘）；**HITL 红线**：verify/ship guard 预备仍停 verify、硬门 --through-gates 也不跨 | ✅ guard-fail exit2 | ✅ 多步推进 |
| 适配器 conformance | ✅ tools/test-adapters.sh 58 断言（真跑各适配器归一 canonical 决策 + 反例哨兵 + **真适配器变异测试**：改坏 codex veto 立即抓红、还原回绿）；claude/codex(A)/cursor(B) active | ✅ 判别力自证 | — |
| loop 预算/熔断 | ✅ loops-budget.integration.test.ts 16 例（真建 run-log → 真熔断 ok/warn/tripped + 成本估算 within/over）+ 真 bundle e2e | ✅ 超阈值 tripped exit2 | ✅ budget→cost |
| loop 漂移/审计 | ✅ loops-drift.integration.test.ts 20 例（7 维漂移各一 + loop-ready 评分 ready/not-ready + --json/--loop）| ✅ 漂移 warn exit1 | ✅ list→drift→audit |
| Tenon contract scaffold | ✅ scaffold.integration.test.ts 14 例（真铺分层空文档集 + 三态 skip/overwrite/append 真删真补真保留 + resolve-workflow 真读源 + removeHash 真改 .pipeline-owned.json）| ✅ spec-dir 冲突 exit2 | ✅ scaffold web/cli/lib |
| transition 单源 | ✅ transition-table.test.ts 40 例（kernel 单源事件表/前置/副作用全量）+ cli/server 接线断言（引用同一对象）；**oracle 双跑 0 不一致=行为逐字保持铁证** | ✅ | ✅ cli+server 共消费 |
| loop 毕业制 | ✅ loops-graduation.integration.test.ts 16 例（真建不同就绪/漂移/熔断态 → 真升降档裁决 + 跨级拒 + --confirm 真改 autonomy_level）| ✅ 跨级 exit2 | ✅ graduate→level set |
| channel 进程层 | ✅ channel-process.integration.test.ts 11 例（真 fork cat 桥接 + 真 spawn 预算 + 真 SIGTERM kill + 真 OS-liveness 判活判死 + 真 prune）+ process.test.ts 4 真 fork node；**架构红线**：跑完零 openspec/门 marker 不变 | ✅ | ✅ spawn→run→kill→prune |
| server afk/traffic 数据端 | ✅ server 14 真 HTTP（afk 泳道+调度器灯 / traces sessions/records）+ 前端 13 真 render（AfkPanel/TrafficPanel/AdvancedPanel capabilities 驱动）| ✅ 缺 session 400 / 未装占位 | — |
| afk CLI 命令 | ✅ afk.integration.test.ts 6 例（真 automation SDK：enqueue 真落 automation=queued + queued_at / PM 轨真拒 exit3 / scan 真判就绪 / run 空队列诚实报告）+ **afk-run.integration.test.ts 4 例（iteration-30，#29-wire）**：真 git 仓 + 真 docker 镜像（自足构建，不依赖跨文件执行序）→ `pipeline afk run --level L3 --image` 真跑 automation.runRound(createDockerRunChange)，L3 真 merge 落 host / L1 report-only 落 paused 不 merge / 无 docker 诚实降级 | ✅ PM 拒 / 未知子命令 exit1 / 无 docker 明示 | ✅ enqueue→status→scan→run（真容器） |
| tap CLI 命令 | ✅ tap.integration.test.ts 8 例（iteration-30，#34-wire：tap 包此前零 CLI 可达性）：真子进程跑 dist bundle（`--` 透传场景，规避 commander 一个真 bug——见下）→ reverse client 真绑端口+真 env 注入被子进程看到+真转发到上游；daemon 模式真打印 export 行+真收 SIGINT 干净退出；readiness 首条 stderr/JSON 到达即 SIGINT 的竞态覆盖；forward 缺 --ca 真拒绝；未知 client/子命令 exit1 | ✅ 未知 client/子命令 exit1 / forward 缺 ca 拒绝 | ✅ start（reverse/forward/daemon/passthrough 四模式）|
| transition 单源守卫（dashboard） | ✅ transition-mirror.test.ts 2 例（node 侧真 import kernel TRANSITION_EVENTS + dashboard 镜像，逐边/逐事件字节相等——跨 node/浏览器边界的单源守卫，镜像漂移即抓红）| ✅ | — |
| check | ✅ guard 全量面真跑：不满足 exit 2 / 建 design doc 后 exit 0 | ✅ | ✅ |
| inbox | ✅ --json 复核相位 | — | ✅ |
| status/list | ✅ 真枚举 | — | ✅ |
| doctor | ✅ --json 真探针 | — | — |
| import | ✅ 真迁移+strip | ✅ 幂等哨兵 exit 1 | ✅ 老仓 fixture |
| 并发锁 | ✅ 两 set 竞争不丢写 | — | — |

## 登记的覆盖缺口（不静默——逐条待补）

- ✅ G1 已闭（iteration-12）：`get` 未设字段忠实 null + 未知字段空行，真 fs 用例
- ✅ G2 已闭（iteration-12）：`set-many` 真原子写 + 落盘字段序
- ✅ G3 已闭（iteration-12）：`check` 真跑 guard 全量面（不满足 exit 2 / 建 design doc 后 exit 0）
- ✅ G4 已闭（iteration-33）：新增 `packages/cli/src/workflow-skill-orchestration.integration.test.ts`
  （4 例，零 mock）——真跑一个项目走完整 7 相位（open→explore→spec→build→verify→ship→archive），
  每相位内驱动真 `hooks/*.sh` 子进程（`gate.sh` 硬拦 → 真 `AskUserQuestion` 解锁流程 → `skill-tracker.sh`
  +`interactive-skill-gate.sh` 真记账），mandatory_skills 从 `templates/manifest.yaml` 真读而非手选；
  单一 `.pipeline-history.jsonl` 里 kernel 写入（transition/set）与 hook 写入（tool/prompt）**按因果顺序**
  逐条核验（非仅计数）；另覆盖 TTL 自愈 + 与 `verify-skills.sh` 的零悬空联动。真跑当场用变异测试自证
  非空转绿（强制 gate 恒放行 → 抓出真实specific 失败 → 复原回绿）。
- ✅ G5 已闭（iteration-33）：`packages/kernel/src/mem/adapters/opencode.ts` 改真 `node:sqlite`
  内建模块读取（零第三方依赖，替换 no-op 桩）——schema 非凭源码猜测，真跑 `opencode-ai@1.17.14`
  建库+真会话+`sqlite3 .schema` 逐字核对；19 例真 fixture（真建 SQLite 文件）。**node:sqlite 在
  node 22.5–22.12 需 `--experimental-sqlite` 标志**（本仓 `engines.node` 仅要求 >=22），故用
  `try/catch` 每次调用探测而非缓存"不可用"，探测失败诚实降级空结果（不抛不假绿）；`opencodeSqliteAvailable()`
  导出供 CLI 降级提示按需警告（原无条件警告已改按真检测结果）。已知诚实缺口：compaction 边界摘要暂未
  折叠（OpenCode 摘要落在独立 message 而非可复用同条 part，无真实压缩会话可核对前不猜规则）。
- ✅ G6 已闭（iteration-32）：full Claude-Code-in-sandbox「agent 真编码成功」用有效
  `CLAUDE_CODE_OAUTH_TOKEN` 真跑验证通过——一次性诊断脚本（未保留在仓库里）seed 一个带真实
  `design_doc` 的 change → `createAutomation`+`createDockerRunChange`（L1，extraEnv 注入 token）
  → agent 真读设计文档、真建 `HELLO.md`（内容逐字比对）、真 git commit `edf75df`，`git show` 独立
  核验（不只信 agent 自报）；tap 记录 8 条真请求，`upstream_base_url: https://api.anthropic.com`
  + 真 `claude-cli/2.1.202` UA + 真 `anthropic-beta: oauth-2025-04-20` + `response.status: 200`
  逐字确认走代理不直连。**真跑过程中抓出 2 个此前从未被有效凭证触发过的沙箱环境真缺口**（均已修复，
  见下）。
  - **缺口 A**：alpine 镜像默认无 `bash`、`SHELL` 未设——Claude Code 的 Bash 工具报
    `No suitable shell found`，agent 完全无法执行任何命令（诚实报告卡住，未伪造结果）。修复：
    `tools/sandcastle/Dockerfile` agent 层追加 `apk add --no-cache bash` + `ENV SHELL=/bin/bash`
    （置于 npm install 层之后，新增层不影响其 docker 缓存）。
  - **缺口 B**：容器 `--user host-uid:host-gid`（对齐 host worktree 属主，DESIGN §7-item5）在
    alpine `/etc/passwd` 里查不到条目时，`HOME` 默认解析成 `/`（**非空、非未设**——原
    `export HOME="${HOME:-/tmp}"` 兜底判断的是"未设或空"，捕不到这种"设了但设错"的情况，真跑
    实测才发现）；agent 建 `~/.claude` 时因此 `EACCES: mkdir '/.claude'`。修复：
    `pipeline-afk-run.sh` 改为无条件 `export HOME=/tmp` + 按当前 uid 自助注册一条 `/etc/passwd`
    条目（幂等，root 等已有条目则跳过；Dockerfile 配合 `chmod o+w /etc/passwd /etc/group` 放行
    非 root uid 写入）。
  - **凭证处理**：用户先给的字符串其实是 OAuth 登录流程的 authorization code（`code#state`
    格式），非最终 token，直接当 bearer 用必然 401——用最简化对照实验（host 直跑、`env -i` 清空
    环境、绕开 docker/tap/repo 代码）逐层排除后才定位到这是弄混了 OAuth 流程的两个产物而非本仓
    代码/环境问题；真正的 `sk-ant-oat01-...` token 全程只作临时环境变量传递，未写入任何文件/
    commit/memory，一次性诊断脚本与所有临时 host 仓库（含 tap 捕获的凭证痕迹）验证后已清理。

**iteration-33 新增收编（非缺口登记，操作性记录）**：
- **5 个长尾适配器全部实现**（aider/continue/cline/amp/zed）——非照抄 registry.yaml 已登记的目标档位：
  逐个查证主要来源后，continue（真实 CLI `cn`，非旧 IDE 插件 config.yaml）与 cline 的 hook 协议均
  比原假设更强，**由目标档 B 升级为档 A**（continue：`extensions/cli/src/hooks/types.ts` 头注自陈
  "沿用 Claude Code 同款 schema"；cline：`.clinerules/hooks/` + `hooks.proto` 证实真 `PreToolUse`
  硬拦，非审批流）；amp 经真下载 `@ampcode/cli` 二进制 `strings` 分析验证机制不同构但能力等价，
  仍判档 A；zed 经其真实 GitHub issue 确认无 hook 原语，档 C 不变。`tools/test-adapters.sh` 断言
  125→224；变异测试覆盖 cline/amp/aider 三项（"至少一项"高标完成）；顺带修复 `tools/test-adapters.sh`
  一个真实预置 bug（`drive_track()` 里 `local id=... w="...$id..."` 单语句内变量展开顺序错误，仅因
  过去调用点都在同变量名 for 循环里才恰好"能用"，新增的非循环调用点当场暴露）。
- **Dashboard 配置写端点已实现**：`GET /api/config` + `POST /api/config/mandatory-skills`（`packages/server/src/config.ts`），
  精确复用既有 B5 token 鉴权（同一 `handlePost` 派发链，零新鉴权代码）；写入对 `templates/manifest.yaml`
  的 `mandatory_skills:` 块做行级手术式替换（其余行含注释逐字保留），写临时文件后**真过一遍 kernel
  `loadManifest` 回读校验**才 `rename()` 覆盖，失败不落地；phase/track/skill token 全部白名单校验
  （拒绝会打破单行 flow-list 语法的字符）。`SettingsView.tsx` 按 `capabilities.config` 决定是否启用
  编辑（旧 server/无此能力时优雅降级回原只读预览）。server 89/89、dashboard-app 86/86。
- **CI 已补齐**：`.github/workflows/ci.yml`（ubuntu-latest 自带 docker，八门验证全部真跑，非仅子集）。
- **sandcastle 镜像发布现状诚实登记**：`tools/sandcastle/build.sh` + `tools/sandcastle/README.md` 新增，
  文档手动构建步骤 + 发布到某 registry 的示例命令；**未代为选择 registry 或实际推送**（需仓库所有者
  账号/凭证决定），镜像仍只在本机 docker 缓存。

**真实发现（真测试的产出，mock 从未暴露）**：① doctor 需 `deps.doctor` 探针束装配——集成层漏装即 exit 1（realDeps 已补真探针）；② init 对可选字段落盘字面 `null` 而非空串（忠实老内核 heredoc，oracle 双跑据此过）；③ import `--strip` 后再 import 返回 exit 0「无历史区」而非幂等哨兵 exit 1（两条路径语义不同，已各自钉死）；④（iteration-30，#34-wire）commander（^12.1.0）variadic `[args...]` 捕获里的裸 `--`：若前一个 token 是普通位置参数（不以 `-` 开头）会被静默吞掉，若前一个 token 是 `--foo` 形态的选项样 token 则保留——穷举受控 argv 数组验证过，是 commander 内部状态机的真实缺陷。真子进程 e2e（tap.integration.test.ts 最初用 in-process harness 跑）当场抓出：`pipeline tap start claude -- <command>`（无前置 flag）时 `--` 消失，wrapped command 的 argv 被误吞进 client 列表。修复：main.ts 在调用 commander 前从原始 `process.argv` 手工切出 `--` 之后的段（`passthroughArgv`），commander 自始至终看不到裸 `--`，绕开该缺陷；mock 测试（不走真 argv/真 commander）绝不会暴露这类第三方库边界情况。⑤（iteration-33，CI 首次真跑抓出）`hooks/` 全仓 **8 处**（gate.sh/skill-tracker.sh/router.sh/breadcrumb.sh/statusline.sh×2/session-start.sh/decision-recorder.sh）同一处 mtime 读取写法 `stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo ...` 在 Linux 上全部失效：GNU `stat -f` 是「文件系统状态」模式（非文件 mtime），传真实文件路径会**成功**吐一段文件系统信息文本而非报错，`||` 兜底判断的是退出码、永不触发；本机 macOS（BSD stat）一直"恰好能用"所以从未暴露，本仓在此之前也从无 CI/无 Linux 真跑过。真机 ubuntu-latest CI 首次运行时，`gate.sh` 处理刚创建的新鲜 review marker 时 `$((now - mt))` 对着一整段文本做算术，报 `arithmetic syntax error` 崩溃退出 1（非预期的 0/2），被新增的 G4 e2e（workflow-skill-orchestration.integration.test.ts）当场抓红。修复：8 处统一改为「先试 GNU 语法（`-c`，BSD stat 不识别该 flag 会真报错退出）+ 输出数字校验兜底，而非只信退出码」；用真 Ubuntu 容器直接复现老写法崩溃 + 验证新写法在 GNU coreutils 下正确产出纯数字 epoch，且真跑 `gate.sh` 新鲜/陈旧 marker 两条路径均正确（阻断/放行+自清）后才提交。**此前全部 180 个 test-hooks.sh 断言、全部 hooks 相关 vitest 均只在 macOS 本机跑过，从未在 Linux 上验证过——这正是"没有 CI"这一操作性空白本身掩盖的真实缺口，补 CI 当轮即抓出。**

**2026-07-08 集成收尾登记（GOAL v2.0：workflow 自定义引擎 + dashboard 工作台，四份计划合并后
的总盘点，证据源见四个 worktree 的 `.superpowers/sdd/progress.md` + `docs/loops/progress.md`
iteration-35）**：

- **G7**：`tasks-at-least` guard 类型恒定失败（`workflow-customization-engine.md` Task 7
  明确 TODO）——需要复用 `packages/kernel/src/flow/guard.ts` 现有的任务计数逻辑，本轮未做，
  非设计缺陷，是待排期的小任务。
- **G8**：自定义 workflow 下 `pipeline transition` 不写 review marker/breadcrumb（Task 8
  明确的范围收缩）——只影响自定义 workflow；`default` workflow 的 review marker/breadcrumb
  机制完全不受影响。
- **✅ G9 已闭**：登记时（2026-07-08 集成收尾）E8（workflow 编辑器节点连线画布 UI）完全
  不在当时四份计划范围内——`workflow-customization-engine.md` 收尾说明明确写"画布 UI 不在
  本计划内……等这条主线落地、真有一个可读写的 workflow 文件格式之后再设计画布怎么读写
  它"，是故意的范围切分，非遗漏。**已于同日由第五份独立计划补上**：
  `docs/superpowers/plans/2026-07-08-workflow-editor-canvas.md`（9 个任务）落地真画布
  （`@xyflow/react`，两层：顶层 step 拓扑 + 钻入 skill DAG），GOAL.md E8 已勾选。该实现
  自身的已知简化点不是本条的延续缺口，另行登记见下方 G14。
- **G10**：Task 8 一个非阻塞边缘情况——不存在的 change 名 + 未知 event 名同时出现时，
  `pipeline transition` 会泄漏一条原始 `ENOENT` 报错而不是干净的"未知 event"错误；
  exit code/stdout/文件写入均无变化（CONTRACT §3 oracle 承诺覆盖的维度不受影响），没有测试
  覆盖这个组合输入，判定为非阻塞。
- **G11**：`automation_attempts` 归零操作和前面的 CAS 不是同一个原子操作（afk-workbench
  Task 5），窄竞态窗口（`store.cas()` 与随后的 `store.set('automation_attempts','0')`
  之间），reviewer 判定为计划文本本身写的顺序、影响面窄（仅瞬时计数偏差，下次自增自愈，
  不影响 CAS 保护的 `automation` 字段本身）且自愈，非阻塞。
- **G12**：若干 Minor 级别发现（测试覆盖不够全、命名不完全一致、文档措辞小瑕疵等）——完整
  列表在四个 worktree 当时的 `.superpowers/sdd/progress.md` 里（已随 worktree 清理，摘要
  见 `docs/loops/progress.md` iteration-35），不在此处逐条复述。
- **G13**（legacy handoff 的已知限制；2026-07-26 新增的 ledger-bound Context Bundle v1
  已覆盖 canonical 七阶段，但尚未把任意 custom step 的声明式 `inputs`/`outputs` 接入）：
  GOAL.md E3 字面要求
  workflow step 的 `inputs`/`outputs` 契约"驱动现有相位 handoff 压缩机制
  （`packages/kernel/src/compress/handoff.ts`）"，但 `handoff.ts` 的 `PHASE_DOCS` 仍是
  按 7 个固定相位名写死的映射表，未读取 step 级 `inputs`/`outputs` 声明；11 个任务的
  brief 与设计文档（`docs/superpowers/specs/2026-07-07-*-design.md`）通篇都未提
  `handoff.ts`，是设计阶段本身遗漏的一处衔接，非实现偷工。**影响面**：`default` workflow
  的 handoff 压缩（B13 护城河功能）完全不受影响；自定义 workflow 下 `phase` 字段是任意
  step id，与 `PHASE_DOCS` 键值不匹配，`phaseHandoffDocs()` 静默返回空列表——即自定义
  workflow 目前拿不到 handoff 压缩优化，非崩溃、非误报（fail-open 静默降级，与本仓其余
  未接线能力的处置风格一致）。已在 GOAL.md E3 脚注同步登记，见 GOAL.md。
- **G14**：workflow 编辑器画布（E8，2026-07-08，`docs/superpowers/plans/2026-07-08-
  workflow-editor-canvas.md` 9 个任务，G9 已闭见上）已知简化点——均已对照实际落地代码逐条
  核实，非照抄计划草稿：
  - 多项目场景下画布固定编辑 `snapshot.projects[0]` 这个 project 的 workflow（`App.tsx`
    的 `currentRoot`，Task 9）——App 层没有"当前选中 project"概念，`snapshot` 本身聚合
    全部已注册 project；真实多项目场景下选哪个 root 编辑 workflow 是留给后续的更大问题，
    未做显式切换 UI，单项目场景下可正常跑通。
  - guard 只支持移除、不支持新增（`StepDetailPanel.tsx`，Task 8 范围收窄）——i18n 已预留
    `detail_guard_add` key，当前未被任何 JSX 使用。**对计划草稿的修正**：新增不是简单照抄
    既有 `renderFieldList`（inputs/outputs 的名字+固定 string 类型列表）套一个 `<select>`
    就能补齐——guard 需要"选类型 + 按类型条件渲染参数"（如 `tasks-at-least` 还需要额外的
    `n` 数值输入，`nonempty-output` 则不需要任何参数），复杂度比 inputs/outputs 的新增表单
    高一档；列表+移除按钮+新增表单这个整体模式仍是通用的，只是新增表单本身要另起一份，
    未在本轮做。
  - 不支持撤销/重做/多选/复制粘贴/minimap；workflow 改名 / 节点（step、skill）改名需删除
    重建（不做级联更新其它地方对旧名字/旧 id 的引用）——以上均是设计文档
    `docs/superpowers/specs/2026-07-08-workflow-editor-canvas-design.md` §3 明确列出的
    范围外项（"范围外（本轮不做，留作后续小任务）"），不是本轮遗漏。
- **G15**（E8 whole-feature review 时发现，**系统性缺口、非 E8 引入**）：
  `packages/dashboard-app` 自己的 `build` 脚本是 `tsc --noEmit && vite build`，真含类型
  检查；但根 `npm run build`（八门验证第①门、CI "Build" 步骤实际跑的命令）字面是
  `tsc -b packages/kernel packages/tap packages/automation packages/cli packages/server
  && npm run bundle`——**不含 `dashboard-app`**；`.github/workflows/ci.yml` 其余步骤
  （`npm run test:web` 只是 `vitest run`，不做类型检查）同样未单独跑它。即
  `dashboard-app` 的 TypeScript 从这个仓库有 CI 以来大概率从未被真正类型检查门禁过——
  实据：`src/loops/LoopsPanel.tsx:117`（F4 范围代码，与 E8 无关）现存一个真实
  `tsc --noEmit` 类型错误（`NEXT_LEVEL[row.autonomy_level]` 类型是 `string | null`，
  用在要求 `string | number` 的位置），此错误活生生地未被任何现有门拦截，是这个缺口
  确实存在的直接证据。**对 E8 本身的影响是中性的**：whole-feature review 时单独真跑
  `cd packages/dashboard-app && npx tsc --noEmit`，除上述那一条已存在的 `LoopsPanel.tsx`
  错误外，E8 新增的四个组件（`WorkflowCanvas.tsx`/`WorkflowEditorView.tsx`/
  `StepDetailPanel.tsx`/`layout.ts`）本身类型干净，未新增任何类型错误。**本轮不处理**：
  修复 `LoopsPanel.tsx` 那一行、或者把 `dashboard-app` 接入 build 门禁/CI，都超出了
  E8"workflow 编辑器画布"这一个功能本身的范围（前者是 F4 相关代码，后者是项目级
  CI/build 配置决策），留给后续单独处理，不在本轮顺手做。
- **G16**（E8 whole-feature review 的 fix 轮次里，实现方自查披露，非隐瞒）：
  kernel `validateWorkflow`（`packages/kernel/src/workflow/validate.ts`）对 workflow
  的 transition `event` 名 / field-ref `field` 名没有字符集规则（跟 step/skill id 用的
  `^[a-zA-Z0-9_-]+$` 不同）——而 `parse.ts` 读这两处只认 `\S+`（不含空白）。whole-feature
  review 发现"用户通过画布 UI 输入含空格的名字会导致往返损坏（保存成功但下次打不开）"
  已在 dashboard-app 客户端（`WorkflowCanvas.tsx` `confirmConnect` + `StepDetailPanel.tsx`
  `confirmAddField`）堵住，且经复审独立验证为真实、完整的修复（唯二的两处构造点均已
  加同款字符集校验，全仓搜索确认没有第三处遗漏）。**残留的、本轮未处理的窄口子**：
  任何绕开浏览器直接调用已鉴权 `POST /api/workflows/:name` 的调用方（curl/脚本/未来
  客户端）仍可写入一个之后会让 `loadWorkflow` 解析失败的 workflow——因为服务端
  `validateWorkflow` 本身没有这条规则做纵深防御后盾，只挡住了"通过正常 UI"这一条路径
  （原始审核发现的复现场景本身就限定在这条路径，服务端加固在审核建议里明确标注为
  "可选"，不属于本轮须做的修复范围）。**建议后续单独一个小任务**：给
  `validateWorkflow` 补一条 event/field 名的字符集规则，作为服务端纵深防御层；因为
  这条路径已被证实"今天就可通过一次已鉴权的直接 HTTP 调用触发"（不是纯假设性的
  未来风险），建议排进较近期的后续处理，而非无限期搁置。

**2026-07-09 全功能真机验证登记（用户追加任务：UI 重构收尾 + Playwright 真实点击驱动
正常 pipeline/AFK 两条全流程 + 自定义 workflow 创建与切换 + loop 面板联动，见
`docs/loops/progress.md` 对应轮次）**：

- **G17（本轮最大发现，真机验证过程中确认，非猜测）**：**自定义 workflow 的 change 一旦
  使用非标准 step 名，在看板（BoardView）和收件箱（InboxView）里完全不可见，也就无法
  通过 dashboard 推进它的任何相位转换**——这不是"某个按钮点不动"这种局部小毛病，而是
  E1-E8（workflow 自定义引擎）交付时，dashboard 两个最核心的操作视图从未被同步更新到
  能感知自定义 workflow 的地步，两者都还是 v1.0 时代"phase 只可能是 7 个固定值之一"的
  假设。
  - **复现（真实操作，非代码走读）**：用 workflow 编辑器（真实点击）建了一个不叫
    `default`、step 名真正自定义（`draft`→`review`→`ship`，不是给 7 相位换皮）的
    workflow `release-train`；`pipeline init release-demo --track backend --preset
    full --workflow release-train` 建一个用它的 change（`phase=draft`）。真开浏览器：
    `GET /api/snapshot` 确认 server 端聚合完全正确（`release-demo(phase=draft)` 真的
    在返回体里）；但 Inbox 和 Board 的 UI 上都找不到这张卡——`BoardView` 的看板 7 列
    一张都不显示它，`board-card-release-demo` 这个 testid 在 DOM 里根本不存在。
  - **根因**（读代码 + 真机双重确认）：`packages/dashboard-app/src/types.ts` 的
    `PHASES`/`TRANSITIONS`/`EVENT_BY_EDGE`/`REVIEW_PHASES` 四个常量都是**只镜像
    default.yaml 七相位的静态表**，`BoardView.tsx` 的 `byPhase`
    （`m.get(fc.change.phase as Phase)`，命中不了就是 `undefined`，`if (bucket)`
    直接跳过不 push）与 `InboxView.tsx` 消费的 `isAwaitingDecision`
    （`REVIEW_PHASES.includes(c.phase)`）都基于这四个常量；`events.ts` 的
    `plannedTransition` 也一样，`isPhase(fromPhase)` 对任何自定义 step 名恒 false，
    直接 `return null`——即便侥幸能在看板上看到卡片，拖拽也算不出合法转换事件。
  - **影响面**：只影响**使用非默认、且 step 命名不复用标准 7 相位名字**的自定义
    workflow；`default` workflow 的 change（本仓绝大多数真实用法）完全不受影响；如果
    自定义 workflow 的 step 恰好也叫 `open`/`explore`/…（用标准骨架、只是内部
    guards/skills/gate 不同），看板能显示、能拖，只是转换边表仍然用的是 default 的
    固定边表，若自定义 workflow 的转换图和 default 不完全一致（比如多了一条 default
    没有的边、或者事件名不同），拖拽算出来的 event 依然会是错的。
  - **为什么本轮不修**：真做对需要 BoardView 按每个 change 实际使用的 workflow
    （`change.fields.workflow`）动态取它自己的 step 列表 + 转换图（`GET
    /api/workflows/:name` 这个端点数据已经现成，E8 已经在消费），而不是复用一套写死
    的 7 列/7 条边——但一块看板上可能同时有用 `default` 和多个不同自定义 workflow 的
    change，"不同 change 该显示成不同的列集合"这件事本身是一个需要先想清楚交互设计
    的产品问题（每个 workflow 一块独立迷你看板？取所有活跃 workflow 的 step 并集做
    列？换个完全不是"列"的呈现方式？），不是照抄 inputs/outputs 现成模式就能补的
    表单级小活，贸然改动核心看板逻辑还有把 `default` workflow 这条最主要使用路径
    改出回归的风险。判定为需要先设计再实现的独立后续任务，本轮如实记录，不假装
    绕过去。
  - **本轮如何完成验证目标**：`release-demo` 后续的相位推进改用 `pipeline transition`
    CLI 真跑（kernel 状态机本身对自定义 workflow 的处理——`internal-skill-gate`
    动态 DAG 判定、guard 校验等——不受这个 dashboard 层缺口影响，真跑验证通过，
    见 progress.md）；AFK 工作台（不依赖 `phase` 值，只看 `automation` 字段）与
    Loop 设置面板（loops registry 有自己独立的 `phases` 声明，不复用 dashboard 的
    固定 `PHASES` 常量）经真机验证不受此缺口影响，可以正常通过 dashboard 点击驱动。
- **G18（历史记录，现已关闭）**：当时项目注册表只有读路径，必须手改宿主目录中的 JSON。
  后续 `tenon init` 与 Dashboard 项目端点已经复用 kernel 原子 store；当前注册表由
  `resolveProductPaths().registryPath` 定位在 Tenon config root 的 `projects.json`，不再借用
  `~/.claude`，update 也只读该同一注册表并输出显式 `tenon sync`。

### 2026-07-09 · iteration-38 dashboard 全量重构 —— 改判追记

- **G14 已闭（部分）**：① 多项目「当前选中 project」概念已落地——App `currentRoot` 状态化 +
  Nav 项目切换器（localStorage 记忆，`App.tsx`/`shell/Nav.tsx`），收件箱/看板/AFK/workflow
  编辑器统一 currentRoot 语境；② guard「只有移除没有新增」已补齐——`StepDetailPanel.tsx`
  新增内嵌表单（类型下拉 + tasks-at-least 条件参数 n + 行内校验），`detail_guard_add`
  预留 key 接线。撤销重做/多选/minimap/改名等其余 E8 已知简化维持原状（本轮范围外）。
- **G17 已闭（前端 + server 双侧）**：前端——新模块 `dashboard-app/src/model/workflowModel.ts`
  混合相位模型（default 走 types.ts 常量镜像零网络、单源守卫测试零改动；自定义按
  `fields.workflow` 走既有 `GET /api/workflows/:name` + 缓存），BoardView 分组看板（每个
  workflow 独立分组/列集/转换图，rules 拉取失败组只读降级——任何情况下卡不消失）、
  InboxView 判据泛化为 `gateByStep[phase]==='review'`、events.ts 按 WorkflowRules 泛化。
  server——**本轮验收真机新发现 G17 其实有个 iteration-37 未触达的 server 侧半边**：
  `server/src/transition.ts::performTransition` 锁死 kernel 固定事件表，dashboard 发出的
  自定义 event 一律 400；已镜像 `cli/commands/transition.ts` 双轨分岔修复（default 原链路
  一行不改，响应形状两轨一致）。验收证据：`.playwright-tmp/acceptance-redesign.mjs`
  真机四连证（独立分组可见/组内拖拽推进/收件箱现卡/快捷转换清徽章），ACCEPTANCE_ALL_PASS。
- **G18 已闭**：`POST /api/projects`（注册，豁免第四层信任锚的唯一写端点，补偿校验=路径
  存在+目录+两侧规范化判重 409）/ `DELETE /api/projects`（注销）/ `POST /api/changes`
  （init 的 HTTP 化）三端点 + Nav 注册入口 + `NewChangeDialog` + 教学式空状态
  （注册表单 + CLI 等价命令双路径）。验收证据：空注册表起步 → onboarding 注册 →
  新建 change → 推进 → 归档全闭环真机通过。
- **G19（本轮新增已知简化，如实登记）**：① `POST /api/changes` 不写 history 记账
  （CLI 侧 best-effort 职责，server 端点不注入 history deps）；② Loops 面板不设降档按钮
  （server 无降档端点，YAGNI——demo 里的降档钮是视觉示意未实现）；③ 看板/收件箱从
  「全项目聚合」改为「currentRoot 单项目」语境（D5 拍板的语义变更，与 AFK/编辑器对齐）；
  ④ default 组 archive 列渲染折叠计数不逐卡列出（有意简化）；⑤ 收件箱「决定类型文案行」
  （awaiting.*）退役——紧凑工票行里徽章+相位胶囊承担语义，i18n key 保留；⑥ 相位显示一律
  原始 step id（mono），default 的中文相位名退役出看板/收件箱（settings 相位轴仍用）。

### 2026-07-09 · G15 收编追记（iteration-38 后续会话）

- **G15 已闭**：根 `npm run build` 接入 `typecheck:web`（`tsc --noEmit -p packages/dashboard-app`），
  排在 `tsc -b` 之后（dashboard 类型依赖 kernel/server 的 `dist/*.d.ts`，全新 clone 的 CI 里
  顺序不可反）、`npm run bundle` 之前；CI "Build" 步骤跑的就是 `npm run build`，自动继承，
  八门数目不变。**红绿实证**：故意类型错误探针（`__g15-red-probe.ts`）——旧门 `npm run build`
  全放行（缺口复证）→ 接线后同一探针被 TS2322 拦截 → 删探针回绿 + `npm test`（1931 pass）
  `npm run test:web`（217 pass）三连全绿。G15 登记时引用的实证错误 `LoopsPanel.tsx:117`
  已在 iteration-38 工票化重写中消亡（接线前基线 `tsc --noEmit` 即全绿，无需修码）。
  **已知残留**：`vite build`（build:web 的后半）仍不在 CI 内——类型之外的纯打包破坏
  （如资源 import 路径错误）CI 依旧不拦，是否补一步由后续拍板。→ **同日拍板补入**：
  CI 新增第九步 `dashboard-app build (vite)`（`npm run build:web`），本地真跑绿后接线，残留清零。

### 2026-07-09 · G16 收编追记（同日后续会话）

- **G16 已闭（范围较登记扩大）**：`validateWorkflow` 新增统一字符集后盾 `^[a-zA-Z0-9_-]+$`——
  不止登记的 event/field 两处，**wf.name / step.id / skill.id 一并锁死**：parse.ts 对这五类
  标识符全部 `(\S+)` 读取，同属「serialize 写得出、parse 读不回」破坏类；且 POST body 的
  `name` 不被强制等于路由 name（serialize 第一行原样写它），是登记时未列出的同类活口。
  `to` 由既有「必须指向真实 step id」规则间接覆盖。**红绿实证**：server.test.ts 新增直调
  已鉴权 HTTP 含空格 event 用例——修复前真实 200 + 落盘（漏洞活体复证），修复后 400 +
  errors + 不落盘；kernel 五例先红后绿。存量扫描（templates/default.yaml + .playwright-tmp
  两测试环境）全部合规，规则零误杀。writeWorkflowForApi/loadWorkflow 都以 validateWorkflow
  为闸，一处加规则双向（写入/读取）闭合。

### 2026-07-09 · G19① 升级收编 + G20 新登记（同日后续会话）

- **G19① 已闭**：`POST /api/changes` 落盘成功后写 history 记账（`kind=init` 单行 JSONL，
  形状对齐 `cli/commands/init.ts`）；best-effort 语义同 CONTRACT §1——失败仅 WARN 到 stderr
  （server 全源无 console，这是首个 best-effort 写操作，通道选择已注释在端点内），绝不影响
  主写已成功的 200。红绿：先加「history 文件存在且单行 kind=init」用例见 ENOENT 红，再接线绿。
- **G20（G19① 实施中发现，同类未登记缺口，如实追加）**：`server/src/transition.ts::
  performTransition` 完全不写 history——CLI `pipeline transition` 有 `kind=transition` 记账，
  dashboard 驱动的相位推进（含 iteration-38 新增的自定义 workflow 双轨）在 history 里不留
  痕迹。change 的历史账本因此**按操作入口分裂**：同一个 change 的推进，CLI 走的有账、
  dashboard 走的无账。修法与 G19① 同模式（transition 成功后 best-effort append），
  未动手——待用户勾选。

### 2026-07-09 · G19② 升级收编（同日后续会话）

- **G19② 已闭（登记文本有一处过时）**：登记称「server 无降档端点」，实查 `POST
  /api/loops/level` 本就是双向升降档端点（kernel `applyLevelChange` 语义：升档须准入、
  跨级拒、**降档总允许**）——真正缺的只是面板入口。落地：`LoopsPanel` 新增 `PREV_LEVEL`
  + 降档幽灵钮（`qk__btn--ghost` 新变体，视觉对齐设计 demo all-views §3 的 btn-ghost
  并排配对），`promote` 泛化为 `setLevel(row, target, kind)`，失败文案分 `demote_fail*`
  i18n 键（中英）。TDD 四例先红后绿（POST target 正确 / L1 无降档钮边界 / 失败行内
  可见 / 成功 refetch）。真机验证（`.playwright-tmp/shot-loops-demote.mjs`，深浅色
  截图人工核对）：点降档 → loops.yaml 真被 surgical 改写 → 徽章 L2→L1 → 降档钮消失
  （到底），零 page error。**过程教训**：真机脚本第一版断言 `row.textContent.includes('L1')`
  假阳性——「降档 → L1」按钮文案本身含 L1，改为查 `.loop-level b` 徽章真值。

### 2026-07-10 · 视觉重塑+交互深化收口追记

（对照评审快照 `.impeccable/critique/2026-07-09T07-42-21Z__packages-dashboard-app-src.md`
——19 个实现任务 + 计划落地前 3 项独立速修，逐条改判。P0/P1 编号沿用该评审在计划与提交历史里实际使用的标签——P0 与
评审原文 1:1；P1 标签 5/6/8/9/10/11 对应评审原文 P1 列表第 6/7/8/9/10/11 条，P1-7 不是
评审 P1 列表的独立条目，而是 Design Health Score 启发式表格第 1 行「AFK/Loops 静止快照
无刷新」分句与 P0-3 的重复引用，随 P0-3 同一次修复一并处置，非另一个缺口。）

**P0（5/5 已闭）**

- **P0-1 已闭**（Task 6/7）：收件箱 gate 行零决策证据——`inbox/evidence.ts::gateEvidence`
  纯函数按当前 gate 相位映射证据字段（verify 门 verify_result/agent_review_result/
  codex_review_result + verification_report/build_sha；explore/spec 门 design_doc/plan；
  未产出显式`未产出`pending 占位，不静默剔除）+ `ChangeDetailCard` 详情卡（证据格/产物/
  语境/全边动作条）+ InboxView 行内证据 chips、j/k/Enter/Esc 键盘。
- **P0-2 已闭**（Task 9）：看板卡片死元素（role=button 但 click/Enter/Space 三路无
  反应的 ARIA 谎言）——点击/键盘打开同一 `ChangeDetailCard`，`draggingRef` 隔离拖拽
  与点击互斥。
- **P0-3 已闭**（Task 12，P1-7 随附处置见上）：AFK 日志冻结（选中拉一次永不更新，
  无轮询无刷新钮）——`useAfkLog` running 态 2.5s 轮询 + 跟随尾部开关 + 手动刷新钮；
  跨项目混列补 root 徽章 + currentRoot 过滤；挂队自由文本改 `<datalist>` 识别化。
- **P0-4 已闭（计划落地前独立速修，`0a7204d`，早于 plan 定稿 `be90315`）**：编辑器
  保存成功后 `invalidateWorkflowRules` 零调用——一行接线补上，收件箱/看板保存后
  即时见新规则，不再需要整页刷新。
- **P0-5 已闭**（Task 3/4）：注册对话框陷阱（无 role/无取消/backdrop 不关/Esc 不关，
  真机证实唯一逃逸是刷新页面）——统一 `<Dialog>` 组件落地（Esc/初焦点/Tab 困笼〔评审
  修复排除 disabled/hidden 逃逸口〕/模块级 LIFO 栈防多实例串扰/卸载焦点归位），全部
  7 处手写 backdrop 迁移（含过程中发现计划漏记的第 8 处——`StepDetailPanel` 字段
  弹窗，移交 Task 15 补齐）。

**P1（7/7 标签已闭，对应评审原文 6 条 P1 列表项）**

- **P1-5 部分已闭（计划落地前独立速修 `8a5de4d`）**：critique 原文第 6 条含两个
  分句——「guard 失败 detail[] 被 client 丢弃只剩首行」**已闭**（`api/client.ts`
  改透传全部违规行，用户不再「修一条→再撞下一条」）；「无转换前置预览（qk 钮不带
  门票状态）」**仍未处置**——`InboxView.tsx`/`BoardView.tsx` 的 `qk__btn` 快捷转换
  按钮目前仍只按 `planned.backward` 分蓝/红两色，不带任何门禁前置检查或 tooltip，
  本轮 19 任务未见涉及这半句的实现，如实标记未闭而非笼统报「已闭」。
- **P1-6 已闭**（Task 13）：Loops budget.remaining 取到不渲染/熔断态无下一步/升 L3
  全自动无确认（风险倒挂）——预算行+就绪构成行+熔断 tint 说明块+升档 Dialog 确认
  （降档保持直发，风险改按后果而非「哪个功能先写」排序）。
- **P1-8 已闭**（Task 15）：画布脏状态零守卫，返回即静默丢编辑，保存钮无 dirty
  指示——`dirty` 位（JSON 快照浅比较）+ 未保存 chip + 返回确认 Dialog + 保存钮
  dirty 才实底。
- **P1-9 已闭**（Task 1 + Task 3）：对话框键盘礼仪全缺（Esc/autoFocus/困笼/归位，
  全 src 零 keydown）由 `<Dialog>` 组件本体兑现；「两个文本输入框无可见焦点样式
  （outline:none 且 box-shadow 全透明）」由 Task 1 token 替换时补的全局
  `:focus-visible`（`--ring` 3px，`.input`/`.select` 专属规则 + 兜底通用规则）
  一并解决，已在 `styles.ts` 核实存在。
- **P1-10 已闭（前半计划落地前独立速修 `528c292`；后半 Task 16）**：设置两处陈旧
  文案正面误导（「逗号分隔」描述已退役文本框、「待 M3 接线」早已接线）改真相；
  穿梭框此前 `.modal/.split` 无 CSS 裸渲染、条目点击无反应——Dialog 化 + 点击
  移动 + 真样式。
- **P1-11 已闭**（Task 10）：拖拽合法性不前示，任何列都亮 target、非法 drop
  静默——dragStart 按 `plannedTransition` 逐列判 legal/illegal 类，非法 drop
  shake 300ms + toast 一句解释。

**本轮未处置（P2/P3，已登记 YAGNI，非缺口，不重复挂 G 号）**：零过滤/搜索/批量/撤销重做
（spec 明确非目标）；键盘数字键触发出边（P2 尾巴，plan self-review 已登记未排）；
跨项目合并同名 workflow 列集（语义不可行，spec 明确判定）。

**新登记（如实追加，非静默留白）**：

- **G21**：change 详情卡（`ChangeDetailCard`）无历史区——spec §5 明确「待 history
  读端点」：本轮只渲染 snapshot 可得的当前态（证据/产物/语境），无「最近 N 条变更」
  时间线。现状是 server 侧 history 仍是纯写入面（CLI best-effort 追加 JSONL，
  `server/src/transition.ts` 也不写，见下方 G20 仍开放条目）、全仓找不到任何
  `GET .../history` 读端点——补历史区需要先补这个读端点，非本轮 19 任务范围。
- **G22**：AFK 日志轮询用 2.5s `setInterval` 而非 SSE——spec §5 明确登记「AFK 日志
  SSE 化：轮询够用，登记 G 项待评估」，是本轮有意的设计决策而非疏漏。相关联的既有
  架构空白（Task 12 minor deferred 重申，非本轮引入）：AFK 卡片 running→completed
  的状态感知依赖用户下一次 `doAction`（取消/重试）触发的 resync，组件本身不轮询
  `/api/afk/snapshot` 顶层状态——P0-3 本轮修的是日志**内容**轮询，不是运行**状态**
  轮询；若某次运行在两次用户操作之间的空档静默完成，状态徽章会滞后到下一次交互
  才更新。
- **G20 仍开放（2026-07-09 登记，本轮 19 任务未处置）**：`server/src/transition.ts::
  performTransition` 不写 history 记账，dashboard 驱动的相位推进在 history 里不留
  痕迹（同一 change 的推进按操作入口分裂账本）——本计划范围是视觉重塑+交互深化，
  未涉及 history 记账链路，该缺口维持登记时状态，待用户勾选处置。
- **G23**（本轮 `.superpowers/sdd/progress.md` 计划段 minor deferred 台账择要，只
  登记有复发风险的模式性问题，措辞/命名类瑕疵不进）：
  - **testing-library `defaultIgnore` 绕过 `within()` 陷阱**（Task 15，
    `WorkflowCanvas.test.tsx`）：Task 15 新增的阶段卡横排让每个 step 的
    id/label/gate 徽章文字在 DOM 里重复一份（阶段卡+xyflow 节点内并存），本文件
    约 40 处既有裸 `getByText` 查询假设「文本只有一份」逐处报错；若逐处改写成
    `within(...)` 会让 diff 爆炸性膨胀，改用 testing-library 官方
    `configure({ defaultIgnore })`（ByText 系专属排除选择器，`beforeAll` 覆盖
    `.stage-card,.stage-card *,.side-col,.side-col *`、`afterAll` 复原）全局解决。
    已知残留 footgun（Task 15 原始记录）：此 `defaultIgnore` 配置只在本测试文件的
    `beforeAll/afterAll` 生效——任何其它测试文件若也渲染 `<WorkflowCanvas>` 并对
    同类重复文本做裸 `getByText` 查询，不会继承这个排除，会重演同样的多重匹配
    报错；目前无第二个文件这样做，是潜在复发点而非当前故障。
  - **聚合模式卡片级 testid/name 比对不含 root**（Task 11 minor deferred）：全部
    项目聚合视图下，同名 change（不同 root）的看板卡片 `board-card-<name>` testid
    与盖章比对逻辑仍只用 `name`，不拼 root——功能层已用 `group.root` 区分互不
    误操作，只是 DOM 查询主键理论上可碰撞，罕见边界，未来任何新增查询若照抄现有
    testid 模式仍会踩中同一个坑。
  - **`rulesKey` 键分隔符是字面控制字符，消费方必须走函数、禁止手工拼接**
    （Task 8 既有设计，本轮真实复发一次）：Task 12 的 `useAfkLog` 请求级乱序 guard
    键构造摹仿同一拼接模式，独立引入同一类源文件二进制化问题（`git diff`/`grep`
    对其静默失明），Task 12 review 当场自查自纠（`ee2bb20`），过程详见
    `docs/loops/progress.md` iteration-39 行「过程教训」。任何未来消费方如果绕开
    `rulesKey()` 手工拼接 root+wf 键，存在重演同一类源文件污染事故的风险。
  - **`WorkflowEditorView` 列表行 gate 计数把 review+confirm 合并成一个数字**
    （Task 14 minor deferred）：与画布上分别显示两种徽章的语汇不一致，产品裁决项，
    未违反功能正确性，但两处呈现口径不统一，后续若要在列表行拆分成两个数字，是
    已知的一致性欠账而非新发现。
  - **`closePending`/`guardedClose` 闭包关闭模式 + `deferred<T>()` 辅助函数均已
    见 4 处局部拷贝**（Task 3/4/15 累计，各消费点各自独立实现同一形状）：均未抽
    共享 testkit/helper，第 5 处出现时应该抽——继续原样复制会持续增加维护漂移
    风险（改一处逻辑需要记得同步改另外 4 处），登记以防遗忘。
  - **Dialog LIFO 栈「最后挂载=最上层」假设有已知边界**（Task 3 重审 Important-
    边界发现，Task 4 以 JSDoc 登记 + 「迁移时禁止同 commit 首挂父子 Dialog」告诫）：
    在同一个 commit 里真嵌套挂载父子两个 `<Dialog>` 时不成立（React 子组件 effect
    先于父组件执行，LIFO 栈顺序与挂载顺序直觉相反）。当前全仓零调用方触发这个
    场景，约束只靠代码注释而非测试强制——后续任何场景如果需要嵌套弹窗，需要人工
    记得这条边界，无自动化护栏会在违反时报警。

> 本条追记不改变上方「登记的覆盖缺口」小节任何既有条目的状态；G14/G15/G16/G17/G18/
> G19 系列缺口的收编状态见各自章节，未被本轮 19 任务触及。

> 缺口在对应里程碑收编时清零；新缺口发现即追加，绝不删除未解决项。

## 2026-08-04 Skill Invocation evidence v1

| 能力 | 自动化证据 | 真实运行证据 |
|---|---|---|
| closed codec / aggregate / 隐私投影 | kernel 单测覆盖未知字段、唯一 terminal、缺失问题、hard-gate default、adapter 漂移、digest/proof/session 排除 | 只读投影不含原始 prompt/answer/output |
| repository / canonical binding | repository 单测覆盖 canonical WorkItem/attempt 错绑、并发幂等、坏行、可信 completion、ownership recovery、默认策略与 artifact 漂移 | 生产 API 对当前 `task-planner-evidence` 返回 `skill-invocation-list/v1` empty，而不是推断成功 |
| Codex/native/AFK adapters | Codex 精确 transcript verifier、native validator gate、AFK prepared run/attempt/reservation 定向测试 | history 只有 completed event 的单向兼容投影，不能作为 v1 receipt |
| server / Dashboard | anchored reader 路径替换拒绝；client 闭合 decoder；zh/en 卡片 loading/empty/error/retry/ready 与键盘原生 details 测试 | production server `127.0.0.1:18772` 由单一 browser owner 验收；fixture 覆盖 completed/incomplete/failed/interrupted、shown/default question 与 artifact |

## 2026-07-11 追记(v5 交互重建 T19 收口)
- G24(P2,新):AFK cancel 起步竞态窗口——running 置位与 automation_worktree/sandbox 写回之间 1-2s,窗口内 cancel kill 旧容器名打空,靠 .cancel-requested 标记在 settle 时兜底(取消意图最终达成,非阻塞)。修复建议:claim 时清旧字段或 cancel 校验字段新鲜度。
- G22(AFK 轮询非 SSE)维持登记;G21 已闭(T1 history 读端点);G20 已闭(T1 server transition 记账)。
