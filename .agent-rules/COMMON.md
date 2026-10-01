# COMMON.md

本文件存放所有任务都必须遵守的通用规则。当前端或后端任务开始前，先读取本文件，再按入口文件路由读取对应领域规则。

## 项目概览

`tenon` 是面向本地开发者和 coding agent 的 TypeScript 单语言开发流水线：以可验证的状态机、复核门和 guard 驱动 change/workflow，提供 CLI、dashboard、AFK 自动化、loop 治理、channel 兼容总线和 tap 诊断。项目采用 npm workspace；核心运行时要求 Node.js 22，Docker 仅用于隔离执行与部分真实验收。

核心维护目标是保持 CLI、YAML/JSON/JSONL、hook、adapter、技能包和 dashboard API 的既有兼容性，同时继续演进 workflow/automation 能力。当前属于功能成熟但持续演进阶段；公共契约、tracked bundle、生成 workflow artifact 与分发资产必须同步，不能只让源码测试通过。

最高风险边界包括：人工复核门与写工具阻断不得失效；状态/ledger/history 必须在跨进程并发下保持锁、CAS 与原子发布语义；本机 HTTP 端点必须维持 Host、登录会话（匿名请求 401）、写 token、content-type 和 root 信任锚，评审确认还须「人在场」nonce；Docker/runner、shell、Git、TLS 代理和反序列化输入必须按不可信边界处理；任何凭证只能通过既有受控配置/环境通道传递，禁止进入日志、trace、fixture、仓库或最终回复。

## 根路径结构与职责

新增、删除、重命名一级路径或改变职责时，必须同步更新本节及相关 README/contract。

| 路径/包/文件 | 作用 | 修改注意事项 |
| --- | --- | --- |
| `AGENTS.md`、`.agent-rules/` | agent 规则入口、通用/前端/后端长期约束 | 保持入口仅做路由；策略细节写入最窄规则文件，修改后运行 create-rule checker |
| `packages/kernel/` | 状态机、workflow、track、loop、state、verification、codec 与持久化原语 | 领域层不得依赖协议/供应商；生成的 `default-workflow.generated.ts` 由模板生成，不得手改 |
| `packages/channel/` | 历史迁移/experimental worker event bus 兼容面 | 非默认 agent runtime；不得在无明确目标时扩建或重新并入 kernel |
| `packages/automation/` | AFK 队列、调度、admission、runner、lifecycle、triage、verifier 与技能快照 | 修改执行/合并/凭证通道时覆盖 Docker、Git、冲突保留和取消/恢复路径 |
| `packages/cli/` | Commander CLI、命令、装配与单文件分发 | `src/` 是源码；tracked `dist/tenon.mjs` 必须由 `npm run bundle` 生成并通过 freshness/smoke，禁止手改 dist |
| `packages/server/` | 本机 dashboard HTTP/SSE server、鉴权与跨包应用编排 | 保持 loopback/Host/会话/token/root 安全模型（不落盘任何凭证，匿名请求 401）；构建产物在 `dist/`，不得手改 |
| `packages/dashboard-app/` | React dashboard SPA | 前端详细边界见 `FRONTEND.md`；`dist/` 为 Vite 生成物，源码/样式/交互改动需真实浏览器验证 |
| `packages/tap/` | 本地 LLM 流量代理、TLS/WS、trace store 与诊断 | 证书、header、prompt 和凭证按敏感数据处理；capture 默认与降级语义不得被弱化 |
| `hooks/` | Session/Prompt/PreToolUse/PostToolUse 的 bash 薄 shim 与三门阻断 | 必须兼容 macOS/BSD 与 Linux/GNU 工具；复杂规则回收到 TypeScript，修改后跑 hook 与 workflow 集成测试 |
| `templates/` | manifest、skill source 和默认 workflow 真相源 | 修改默认 workflow 后运行 codegen freshness；不得让模板与生成 artifact/技能引用漂移 |
| `skills/`、`skills-lock.json` | 对外分发的 pipeline 技能与解析锁 | 修改引用、名称或来源时运行 `tools/verify-skills.sh` 和 bundle/安装相关测试 |
| `adapters/` | Codex、Claude 及其他 coding agent 安装/能力适配 | 遵循 `adapters/contract.md` 与 registry；修改后跑 conformance/变异测试，不夸大宿主能力 |
| `agents/`、`commands/` | 插件 agent 角色与用户命令资产 | 与 CLI/skill 实际行为保持一致；不得写入机器绝对路径、凭证或仅本地成立的说明 |
| `.claude-plugin/`、`.claude/`、`.codex/`、`.agents/` | 插件 manifest 与本仓 agent/hook 配置 | 区分可分发配置和本机 `*.local.*`/worktree 状态；不得提交或传播本机秘密与缓存 |
| `.github/` | CI workflow 与仓库 hook 配置 | CI 是 canonical verify；命令应复用根 scripts，新增外部 secret/权限/发布行为前确认 |
| `tools/` | 构建、codegen、oracle、sandcastle、hook/adapter/skill/bundle 验收 | 不得成为生产领域逻辑唯一实现；脚本须 fail-closed、跨平台或明确运行平台 |
| `e2e/` | Dashboard 浏览器 e2e（Playwright，chromium + webkit）及其种子项目 / 被测服务脚本（`e2e/dashboard/`） | 只经 `npm run test:e2e` 或目录套件 `dashboard-e2e` 运行，vitest 不收录；种子与被测服务全部在隔离 HOME / TENON_RUNTIME_HOME 里，不得触碰真实 Tenon 状态；报告只写 `test-results/`、`playwright-report/` |
| `.tenon/tests/` | 本仓自己的测试目录 `catalog.yaml`（已跟踪、人可编辑）与基线 | 改套件后运行 `node packages/cli/dist/tenon.mjs test catalog validate`；基线只经 `tenon test baseline` 写，且只提交 CI 机器画像的基线；目录顶层 `profile: coarse` 选粗口径画像（OS + 架构 + 核数 + Node 主版本），改它会让早先的运行记录过期 |
| `docs/` | contract、测试现实、发布、计划、研究、UX 与迭代证据 | `docs/CONTRACT.md`、`TEST-REALITY.md`、`DIST-RELEASE.md` 属高优先维护文档；行为变化需同步 |
| `README.md`、`GOAL.md`、`BACKLOG.md`、`LOOP.md` | 使用入口、终态/验收、队列与迭代协议 | 不得提前勾选、伪报收官或让命令/已知缺口与实现漂移 |
| `design-demos/`、`design-qa.md` | dashboard 设计原型、规格、截图与 QA 证据 | 原型不是生产源码；吸收方案时在 dashboard 重实现并验证，`shots/` 只存无敏感信息的证据 |
| `.impeccable/`、`.superpowers/` | 设计评审、brainstorm/SDD 的本地或历史过程资产 | 不作为运行时真相源；本机 token/port/cache/diff 产物不得进入产品或秘密处理流程 |
| `package.json`、`package-lock.json`、`tsconfig.base.json`、`vitest.config.ts` | workspace、依赖锁、构建/测试入口 | 使用 npm；依赖改动同步 lockfile，配置改动运行受影响的全量 build/test |

## 指令优先级

1. 用户当前明确要求。
2. 更靠近被修改文件的项目规则或用户指定规则。
3. `AGENTS.md` 或 `CLAUDE.md` 入口文件及 `.agent-rules/` 下已选规则。
4. README、CONTRIBUTING、架构文档、测试文档等项目文档。
5. 相邻代码和测试体现的既有模式。

如果规则冲突，按更高优先级执行，并在最终回复中说明冲突、取舍和是否需要更新长期规则。

## 默认工作流

- 开始修改前，读取与任务直接相关的实现、调用方、测试、配置和规则文件。
- 不得仅凭文件名或常见框架习惯推断 API 行为、错误语义、数据格式或测试命令。
- 做最小充分修改，避免顺手重构、格式化无关文件、改动无关锁文件或引入未请求的依赖。
- 修改公共契约、schema/migration、鉴权/权限、支付/账务、基础设施、CI、生成代码、共享类型或跨端 API 时，说明影响范围并按风险执行验证；只有超出用户授权、难以回退或会改变外部/生产状态时才先确认。
- 运行命令需要网络、外部服务、密钥或长时间任务时，遵循当前环境权限并选择风险匹配的验证方式；破坏性或授权不清晰的操作必须先确认。

## Playwright MCP 与浏览器复用

- 任一 agent、subagent 或并行任务准备调用 Playwright MCP、浏览器验收或浏览器自动化前，必须先检查当前宿主是否已有项目专用的 Playwright MCP endpoint、browser owner、活动 browser root、profile 和连接；普通串行验收必须复用同一个长期运行的专用 MCP 与浏览器，不得按 tool call、turn、task 或 agent 重复启动 `npx @playwright/mcp`、新 Chrome 或临时 profile。
- 项目专用浏览器与用户日常 Chrome 必须隔离。除非用户当次明确要求并知晓共享登录态、Cookie、标签页和误操作风险，不得通过扩展、CDP 或其他方式接管用户日常 Chrome。
- 多个 agent 需要浏览器时，默认由一个 browser-owner 串行执行并共享结果；其他 agent 不得并行驱动同一 context、页面或标签页。确有多角色、并行隔离或破坏性测试需求时，才可创建额外 context 或浏览器实例，并必须在启动前声明用途、数量和清理责任，在完成后关闭额外实例。
- 若宿主仅提供会为每个连接启动独立 stdio 服务的 Playwright MCP，且无法连接项目专用的长期 endpoint，agent 不得盲目调用并制造重复实例；必须改用可复用的现有 Browser/Chrome connector、由 browser-owner 代执行，或向用户报告宿主限制。不得直接修改 `.codex/plugins/cache/`、`.claude/plugins/cache/` 等托管缓存来伪造持久配置。
- 浏览器任务开始前必须至少记录可核验的 endpoint、owner 或 session identity；本机进程可观察时，还必须记录 browser root PID、profile 和现有实例数，结束前复查同类证据。普通串行任务不得增加遗留的 MCP server、browser root、Dock 窗口或临时 profile；若本次确有新增，最终回复必须说明原因、存活范围和清理结果。
- 发现重复或疑似孤儿 Playwright/Chrome 时，必须先核对 PPID/PGID、启动参数、profile、活动连接和所属任务，再仅终止确认无主且无客户端的精确进程树；不得误杀用户日常 Chrome、共享 browser-owner 或仍在验收的实例。无法安全判定归属时，保留进程并报告阻塞。
- 长期 Playwright MCP 服务必须固定经过验证的版本，并通过受支持的用户级或项目级配置连接；不得把 `@latest` 作为要求可重复的共享运行时。仅使用 `--headless` 隐藏窗口不算解决实例泄漏，验收必须同时检查 MCP 与浏览器进程是否被复用和回收。

## 修改权限边界

- 可以直接执行：用户请求已授权、范围内且可合理回退的代码、测试、依赖、schema、配置、CI、文档和文件修改；按风险说明影响并验证。
- 需要先确认：实质扩大任务范围、难以回退，或在授权不清晰时改变外部/生产状态、发布/部署/发送内容、产生费用、访问 secrets、影响真实用户/数据的操作。
- 禁止：提交或输出 secrets、伪造测试结果、绕过验证门禁、执行未经授权的破坏性 git 操作、覆盖用户未要求覆盖的改动、删除范围外资产。

## 安全与数据规则

- `.env*`、密钥、tokens、证书、真实用户数据和生产数据库内容只可用于确认变量名或存在性，不得输出具体值。
- 处理不可信输入时必须使用与目标边界匹配的显式校验、编码/转义、路径规范化、最小权限和失败路径；shell 参数必须使用参数数组或安全引用，不得拼接未校验输入。
- 涉及 shell、文件系统、网络、权限、沙箱、上传下载或反序列化的改动，必须覆盖错误处理和滥用场景。
- 日志不得泄露密码、token、身份证件、支付信息、私密联系人、个人健康/财务等敏感数据。

## 测试与验证门禁

已确认的统一命令：

| 目的 | 命令 |
| --- | --- |
| 干净安装 / 本地安装 | CI 与干净环境使用 `npm ci`；需要更新依赖锁时使用 `npm install` |
| 全栈构建 | `npm run build` |
| 前端类型检查 / 构建 | `npm run typecheck:web`；`npm run build:web` |
| server bundle | `npm run build:server` |
| 后端与全仓测试 | `npm test`；前后端合并套件使用 `npm run test:all` |
| 前端测试 | `npm run test:web` |
| 定向测试 | `npx vitest run <test-file...>`；前端使用 `npx vitest run --config packages/dashboard-app/vitest.config.ts <test-file...>` |
| 静态/生成物门禁 | `npm run check:comments`；`npm run check:default-workflow-freshness` |
| 分发与兼容验收 | `bash tools/test-hooks.sh`；`bash tools/test-adapters.sh`；`bash tools/verify-skills.sh`；`bash tools/test-bundle.sh`；`npm run oracle` |
| 浏览器/API smoke | `npm run build:web && npm run build:server` 后按 README 启动 `npx tenon-dashboard`，检查受影响真实流程 |
| Dashboard 浏览器 e2e | `npm run build` 之后 `npm run test:e2e -- --project=chromium`（webkit 需 `npx playwright install webkit`）；CI 三处阻塞地跑：verify（Node 22，Chromium）、node-matrix（Node 20/22/24，Chromium，另跑测试体系 / reporter / 解析器套件）、独立的 dashboard-e2e-webkit 作业；ci.yml 不允许任何 `continue-on-error`；`npm test` 在 CI 带 `TENON_E2E=1`（缺 Chromium 即失败） |
| 基准 | `npm run bench:status`、`npm run bench:snapshot`、`npm run bench:snapshot:large`（30 项目 × 30 任务，写入后重建 p95 < 1.5 s）；判定与基线走 `tenon test run <change> --suite bench-status --suite bench-snapshot --suite bench-snapshot-large` |
| Docker/真实 agent | `bash tools/sandcastle/build.sh local`；需要凭证时按 `BACKEND.md` 的 real-Codex 命令运行 |

仓库当前没有独立 lint、format npm script，浏览器 e2e 只有上面 Dashboard 那一套（`npm run test:e2e`）；不得编造命令或声称已执行。格式与静态正确性依靠 TypeScript 构建、现有门禁和相邻代码风格；新增工具必须属于当前任务授权范围，并同步根 scripts、CI 和本节。

风险分层：

- Level 0：文案、注释、纯文档或低风险局部样式改动，至少做定向检查或说明无需运行代码验证的理由。
- Level 1：局部行为变更，运行相关单元测试、类型检查或最小 smoke check。
- Level 2：共享逻辑、公共接口、权限、持久化、并发、缓存、任务队列、支付、schema 或跨端契约变更，运行相关集成/回归测试；无法运行时报告阻塞原因和剩余风险。
- Level 3：迁移、批量数据修复、基础设施、CI/CD、发布流程或安全边界变更，必须给出验证计划和回滚/恢复思路；存在超范围、不可逆或外部状态风险时再列出需要用户确认的事项。

## 最终回复格式

每次完成改动后的最终回复必须包含：

- 改动摘要：说明做了什么和为什么。
- 受影响文件：列出关键文件路径及其变化。
- 验证命令与结果：列出实际运行的命令和结果摘要；如果未运行，说明原因。
- 未验证项、剩余风险和需要用户决策的事项。
- 涉及架构、分层或包边界时，给出对应架构自检结论；不涉及时无需增加形式化的“不适用”说明。

## 规则维护

- 用户当前清晰要求与长期偏好冲突时，本次任务可直接按当前要求执行并说明偏离；不得强制用户先更新长期规则。
- 当同类要求反复出现，或不持久化会导致未来 agent 持续做错时，再询问是否沉淀为长期规则。
- 更新规则时要保持具体、可执行、可验证，优先使用“触发条件 + 必须/不得行为 + 验证证据 + 失败处理”格式。
