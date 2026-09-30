# BACKEND.md

本文件只在后端任务或后端相关跨端任务中读取。前端-only 任务不得读取本文件，除非需要理解 API contract、返回体、鉴权、数据库或跨端验证。

## 后端项目概览

后端是本地优先的 pipeline 状态机、CLI、dashboard server、自动化调度与流量采集工具链。必须保持轻量、可离线构建的 TypeScript 单语言架构；除非当前任务明确授权架构迁移，不得引入 Web 框架、数据库、ORM、迁移工具或外部缓存服务。

| 项 | 内容 |
| --- | --- |
| 语言 | TypeScript ESM；bash 仅用于现有 hook 与构建/验收薄脚本 |
| 运行时 | Node.js 22；CLI、全局本机 dashboard server、AFK runner 与 tap daemon |
| 框架 | HTTP 服务使用原生 `node:http`；CLI 使用 Commander；不得无授权引入服务端框架 |
| 包管理/构建 | 根目录 npm workspace 与 `package-lock.json`；TypeScript project references + esbuild 单文件 bundle |
| 数据库/ORM | 不使用数据库、ORM 或迁移工具；YAML/JSON/JSONL 与目录结构是持久化契约，写入必须复用既有原子发布、文件锁、revision/epoch CAS 和 codec |
| 缓存/队列 | 不依赖外部缓存或消息队列；内存缓存必须可重建，持久队列、scheduler、ledger 与 admission 归 `packages/automation` 及 kernel 既有存储边界 |
| 测试/验证 | Vitest 单元、集成、跨进程和 real-Codex 验收；bash smoke、adapter conformance、golden oracle 与 TypeScript/esbuild 构建 |
| 部署/外部依赖 | 本机 CLI/server 为主；Docker sandcastle 执行隔离任务；GitHub Actions 运行 CI；Git、Docker 与明确配置的 Codex/Claude 凭证属于受控外部依赖 |

## 后端包结构

后端保持现有 npm workspace 包边界。跨包能力必须从提供方 `src/index.ts` 的公开出口导出，不得从消费方深度导入另一包的内部文件。

| 路径/包 | 允许放入 | 不允许放入 | 测试/验证 |
| --- | --- | --- | --- |
| `packages/kernel/` | 零运行时依赖的状态机、workflow/track/loop 规则、codec、验证、锁/CAS 与持久化原语 | HTTP、CLI 参数、Docker/进程执行、具体 UI 或供应商 SDK | 实现旁 `*.test.ts`；文件/锁语义补跨进程 integration test |
| `packages/channel/` | event-sourced worker 总线、事件/过滤/存储/监督与兼容面 | pipeline 核心状态机规则、HTTP 展示或 CLI 命令编排 | 实现旁单元测试；进程/存储行为补 integration test |
| `packages/automation/` | 队列、scheduler、admission、runner、lifecycle、triage、verifier、skill snapshot 与 Docker 执行编排 | 复制 kernel 状态机、dashboard 协议渲染、CLI 输出格式 | 单元测试、跨进程/容器 integration test；Docker 不可用时诚实记录 skip |
| `packages/cli/` | Commander 程序、命令参数/输出、依赖装配、用户交互与 bundle 入口 | 可复用领域不变量、直接复制其他包内部逻辑 | 命令旁 `*.test.ts`、根级 `*.integration.test.ts`、bundle smoke 与 real-Codex 定向验收 |
| `packages/server/` | 原生 HTTP/SSE 边界、Host/会话/token/content-type 守卫、请求校验、响应映射、静态前端托管和跨包应用编排 | 在 handler 中重写 kernel/automation 领域规则；数据库/ORM 抽象 | 模块旁 `*.test.ts`、`server.test.ts` 与前端 serverIntegration 测试 |
| `packages/tap/` | 本地代理、CA/TLS MITM、记录、重建和 trace store | 通用状态机、dashboard 组件或无关自动化策略 | 安全、证书、代理与 daemon 的单元/integration 测试 |
| `hooks/` | Claude/Codex 事件接入的 bash 薄 shim 和门禁 | 可在 TypeScript 包表达的复杂业务状态机、重复 codec | `bash tools/test-hooks.sh`；改门禁时运行 oracle/相关 CLI 测试 |
| `templates/`、`skills/`、`adapters/`、`commands/` | 分发契约、默认 workflow/manifest、技能与多 agent 适配资产 | 构建缓存、真实凭证、只在源码生效但未同步分发的副本 | `tools/verify-skills.sh`、`tools/test-adapters.sh`、codegen freshness 与 bundle smoke |
| `tools/` | 构建、golden oracle、sandcastle、bundle/hook/adapter 验收脚本 | 生产领域逻辑的唯一实现、静默吞错的替代路径 | 对应脚本或 `tools/oracle/harness.test.ts`；CI 命令必须与根 scripts 对齐 |

## 编码规范

后端采用“现有风格 + 严格边界、安全与并发测试”规范：

- 类型、类和导出接口使用 PascalCase，函数、变量、模块文件使用 camelCase；CLI 命令和 HTTP 路径沿用既有 kebab-case/路径命名，不得创造同义命名。
- 新增或本次修改的生产代码不得使用显式 `any`、隐式 `any` 或非空断言；外部输入、解析结果和捕获异常先以 `unknown` 接收并收窄。触碰旧违规时必须在修改边界内消除，范围外遗留不得扩散。
- HTTP/CLI request、response、DTO 与持久化 codec 类型必须和 kernel 领域类型分离；转换发生在边界层，协议对象不得直接替代领域状态或绕过 validator。
- 所有文件、HTTP、子进程、Docker、Git 与供应商调用必须保留原始因果信息并映射为稳定错误语义；不得静默吞错、把失败伪装成成功，或无界重试。只有既有契约明确“查不到是正常状态”时才可返回成功空结果。
- 本项目的事务边界是锁、revision/epoch CAS、临时文件 + 原子 rename、ledger/repository 提交或既有等价原语；多文件操作必须说明提交顺序、失败恢复和并发冲突，不得以普通 read-modify-write 替代。
- 所有非公开端点（公开的只有 `/api/health` 与 `/assets/*`）必须先过 `serverAccess.ts` 的会话门；写端点在其后保持 Host 守卫、token 鉴权、content-type、路径/root 信任锚和输入校验的既有顺序与失败码；新增写能力不得复用只读端点的宽松权限，也不得把登录码、会话或 token 写盘、写进响应或日志；人工评审确认只能经「会话 + 在场 nonce」。
- 配置必须经现有 config/paths 层读取并验证；不得散落读取 `process.env`、用户 home 或 cwd 假设。日志和错误响应不得包含 token、凭证明文、私钥、完整敏感路径内容或原始用户数据。
- 新增或修改行为必须覆盖每个可达的成功、校验失败、鉴权失败、并发/CAS 冲突、I/O 失败、恢复和向后兼容分支；涉及跨进程、锁或原子发布的语义不能只用 mock 单元测试证明。
- 公共导出、CLI 输出、HTTP JSON、YAML/JSONL codec 和分发 bundle 都是兼容面；破坏性变更必须有明确授权，并同步更新调用方、fixture、contract、迁移/兼容读取路径及定向验收。

- 新增代码前读取同目录相邻实现、调用方、测试和配置，遵循既有分层、命名、异常映射、日志、事务和校验风格。
- 修改公共 API、DTO/schema、鉴权/权限、支付/账务、迁移、消息契约或生成代码前，必须说明影响范围、调用方、兼容策略和验证计划。
- 输入必须在边界层校验；持久化和外部调用必须处理超时、重试/幂等、错误映射和可观测性。
- 日志必须有排查价值但不得泄露 secrets、token、密码、支付信息或真实敏感用户数据。
- 不得为单次需求引入未使用的抽象、全局状态、新中间件或新依赖；任务已明确授权且依赖必要、兼容、可回退时可直接新增，否则在扩大范围或引入重大维护/安全风险前确认。

## 文件长度规范

后端采用严格文件长度门禁。本次触碰的生产文件如果已经超过对应硬上限，必须在交付前按职责拆分，不得只新增代码后以“历史遗留”为由继续保留；拆分必须保持公共契约并补齐回归测试。

- Controller/HTTP handler 超过 250 行应考虑拆分，超过 400 行必须拆分。
- Service/application use case 超过 300 行应考虑拆分，超过 500 行必须拆分。
- Domain model/entity 超过 250 行应考虑按聚合、值对象或领域服务拆分，超过 450 行必须拆分。
- Repository/storage adapter/codec 文件超过 300 行应考虑按聚合或存储场景拆分，超过 500 行必须拆分。
- 生成文件、迁移脚本、测试 fixtures 或协议文件可例外，但最终回复必须说明例外原因。

## 架构约束

后端采用严格 DDD，并以现有 workspace 包作为物理部署边界、以业务能力作为限界上下文。至少区分 workflow/state、track/skill、loop/governance、automation/execution、channel 与 trace/tap；新增概念必须先确定唯一所属上下文，跨上下文通过显式 contract、领域事件或应用服务协作。

- 领域层包含聚合根、实体、值对象、领域服务、领域事件、specification 与领域自有的 repository port；必须是纯 TypeScript，不得导入 application 层、HTTP/CLI DTO、Node 文件/进程 API、Docker、Git、供应商 SDK或具体存储实现。`packages/kernel` 可以物理容纳基础设施模块，但领域目录只能依赖领域层内部 contract，不能反向导入同包的 application、文件系统、锁或 codec 实现。
- 应用层以命名用例编排聚合、repository port、事务/原子提交边界和外部 port；不得复制聚合不变量，也不得向调用方暴露可绕过聚合的可变内部状态。
- 基础设施层实现文件系统 repository、codec、锁/CAS、进程、Docker、Git、HTTP/SSE 和供应商 adapter；adapter 必须把外部错误与数据映射成应用/领域可理解的类型，不得让基础设施模型渗入领域层。
- CLI、server 和 hooks 是入站 adapter，只负责鉴权/权限上下文、输入校验、DTO 转换、用例调用与响应/退出码映射；handler/command 不得直接拼装领域状态或执行跨聚合写入。
- 新增或修改旧代码时必须在任务边界内把混合的协议、应用、领域和基础设施职责拆开；不得以“现有代码如此”为由新增反向依赖。迁移必须保持当前公共 contract 和文件格式，除非用户明确授权破坏性变更。
- DTO、持久化 record、API request/response、CLI option 和领域对象必须分别定义并显式转换；任何反序列化数据在进入聚合前必须通过 codec/validator 与值对象构造校验。

严格 DDD 核心约束：

- 不允许贫血模型：核心业务不变量、状态迁移和领域行为必须靠聚合根、实体、值对象或领域服务表达，不得全部堆在 application service 中。
- 聚合边界必须清晰；跨聚合一致性通过领域事件、应用服务编排或最终一致性策略表达。
- Repository 面向聚合或领域概念，不向领域层泄露文件路径、序列化 record、锁/CAS 或底层查询细节。
- DTO、持久化 record、API request/response 不得替代领域模型。

## RESTful API 规则

HTTP API 保持现有 `/api` 前缀和端点契约，不统一增加 `/v1`，也不把现有响应迁移为全局信封。

- 成功响应使用端点已经定义的直接 JSON 结构；新增端点必须定义稳定、最小的 response DTO，不得无理由包裹 `{ data }` 或泄露领域聚合/持久化 record。
- 失败必须使用准确 HTTP 状态并保持端点现有的 `{ ok?: false, error: string, code?: string, detail?: unknown, blockers?: unknown }` 兼容形状；机器调用方需要分支时必须提供稳定 `code`，不得依赖中文 `error` 文案解析。
- 现有路径、方法、字段、状态码和“查不到是否为成功空结果”的语义属于公共契约；默认只做向后兼容扩展。破坏性变更必须有明确授权、迁移期或新路径，并同步前端 client、类型、文档和 contract/integration 测试。
- 现有有界列表不强制分页；新增可能无界增长的列表必须使用 cursor + `limit`，响应包含 `items` 与可空 `next_cursor`。不得用 offset 模拟稳定游标；排序键和过滤语义必须写入契约并测试。
- 不设置全局 `Idempotency-Key` 要求。每个写端点必须明确重试语义，复用领域标识、revision/epoch CAS、锁和原子提交防止重复或丢失更新；新增可由网络客户端安全重试的创建操作若没有天然幂等键，必须设计显式幂等键及存储生命周期。

基础安全约束（可直接保留，但不能替代用户对路径/返回体的决策）：

- 修改 API 前检查调用方、OpenAPI/接口文档、生成客户端、前端请求封装和现有测试。
- 新增或变更接口必须说明路径、方法、鉴权、请求体、响应体、错误码、兼容性和验证方式。
- 破坏性响应结构变更已被当前请求明确授权时可以实施，但必须说明兼容影响并同步更新 contract、mock、客户端类型和相关测试；授权不清晰或存在未协调外部调用方时先确认。

## 数据库与持久化规则

项目不使用关系型数据库、ORM 或通用迁移工具；YAML、JSON、JSONL、目录布局和生成 artifact 是持久化公共契约。

- 不强制所有 record 具有统一的 `id`、`created_at`、`updated_at`、`deleted_at`、`version` 或 `tenant_id`。字段、删除方式、审计方式与 identity 必须由所属聚合及其 codec 明确定义，不得从其他 schema 类推。
- 文件名、key 和序列化命名沿用对应 codec 与文档；TypeScript 的 camelCase 与持久化 snake_case 等差异必须在 adapter/codec 显式转换，不得让领域对象直接决定磁盘格式。
- 持久化时间必须使用 UTC ISO-8601，并通过可注入 clock 产生；精度和更新时间点保持现有 contract。不得在读取或无业务变化时偷偷刷新时间戳。
- 聚合写入必须持有对应治理/项目/registry 锁，校验 revision 或 epoch CAS，并使用项目既有临时文件 + 原子 rename/atomic publish；不得用未加锁的普通覆盖写、跨进程内存锁或先写后校验替代。
- 多文件变更必须由应用用例声明提交顺序、失败恢复和可观察的中间态；需要原子可见时使用既有 repository/ledger/atomic-publish 机制，不得假装文件系统提供跨文件事务。
- append-only history、ledger、transition record 和 audit artifact 不得就地改写或静默丢弃；拒绝/损坏记录必须按既有 fail-closed 或 degraded 契约处理并保留诊断证据。
- 读取器必须支持项目承诺的旧格式，写入器只生成当前 canonical 格式。迁移必须有显式触发、备份或可重建来源、幂等重跑、失败恢复、旧版兼容影响与 fixture/integration 验证；禁止启动时静默执行破坏性迁移。
- 不得在无关任务中顺手重写历史 schema。新增派生快照或索引必须注明 source of truth、重建方式、一致性窗口、失效行为和验证方法。

## 后端验证

后端按改动风险使用以下已存在的验证命令：

| 目的 | 命令 | 适用范围 |
| --- | --- | --- |
| 定向单元/集成测试 | `npx vitest run <test-file...>` | 局部领域、应用、adapter、API、并发或 codec 改动；交付时列出实际文件 |
| 后端测试套件 | `npm test` | kernel、channel、cli、server、automation、tap 的共享或准备交付改动 |
| TypeScript + bundle 构建 | `npm run build` | 公共导出、类型、CLI/server、workspace 依赖或跨端契约改动 |
| 注释可信度 | `npm run check:comments` | 注释、TODO/FIXME、错误说明或大范围实现改动 |
| 默认 workflow codegen | `npm run check:default-workflow-freshness` | `templates/workflows/default.yaml`、生成器或生成 artifact 改动 |
| hook / adapter / skill / bundle | `bash tools/test-hooks.sh`；`bash tools/test-adapters.sh`；`bash tools/verify-skills.sh`；`bash tools/test-bundle.sh` | 对应分发资产、hook、adapter、skill 与 CLI bundle 改动 |
| golden oracle | `npm run oracle` | 状态机、guard、转换、历史兼容或模板契约改动 |
| Docker sandcastle | `bash tools/sandcastle/build.sh local` | runner、镜像、挂载、凭证传递或真实隔离执行改动；要求本机 Docker |
| real-Codex 验收 | `TENON_REQUIRE_REAL_CODEX=1 npx vitest run packages/cli/src/loop-run.real.integration.test.ts` | Codex runner/AFK 真实路径；仅在可安全使用凭证和网络的环境运行，不得输出密钥 |
| API smoke | 先执行 `npm run build:web && npm run build:server`，按 README 启动 `npx tenon-dashboard`，检查 `/api/health`、用 `tenon dashboard --open` 登录后受影响的读端点及带同源 token 的真实写流程 | server 路由、鉴权、静态托管、SSE 或 client/server contract 改动 |

项目没有数据库迁移命令；持久化 schema/codec 变更必须用旧 fixture、幂等迁移测试、跨进程 repository 测试和恢复场景代替。仓库当前没有独立 lint/format npm script，不得声称运行过；除非任务明确授权，不得为满足规则临时编造或引入工具。

默认要求：

- 修改业务逻辑必须运行相关单元测试；修改 API/持久化/权限/并发/事务必须运行相关集成或 contract 测试。
- 修改迁移或 schema 必须说明迁移方向、回滚/恢复、兼容性、数据回填和验证命令。
- 无法运行依赖外部服务的验证时，必须记录失败命令、错误摘要、未覆盖风险和建议的替代验证。
