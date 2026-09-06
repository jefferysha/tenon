# Tenon 整体代码与插件评估（2026-09-06）

## 结论

当前 Tenon 的核心治理、发布安全和本地 Dashboard 基础已经较成熟；但当前工作树不能作为可交付版本，原因是 Dashboard 信息架构变更尚未完成收敛，前端测试与 OpenSpec/仓库卫生门禁均为红灯。插件的主要风险不在“功能数量少”，而在跨宿主真实运行证据、跨进程一致性、错误可恢复性和能力声明仍不完整。

## 当前验证证据

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck:web` | 通过 | Dashboard TypeScript 类型检查通过 |
| `npm run build:web` | 通过 | 2098 modules transformed，生产 bundle 可生成 |
| `npm run test:web` | 失败 | 102 文件中 98 通过，1743/1761 通过；18 个失败 |
| `npm run check:architecture` | 失败 | ProgressView 601 行、TaskDetail 490 行，超过规则阈值 |
| `npm run check:repository-hygiene` | 失败 | `.gitattributes` 新增注释触发受限外部身份检查 |
| `npm run check:openspec` | 失败 | `dashboard-ui-reimplementation` 没有 delta spec |
| `npm run check:identity` | 失败 | 当前工作树删除 `AGENTS.md`，身份检查无法读取 |
| `npm run test:hooks` | 通过 | hook ABI、门禁和 fail-open/fail-closed 回归通过 |
| `npm run check:npx-package` | 通过 | 薄包、安装 acceptance 边界测试通过 |
| `npm run check:release-workflows` | 通过 | release workflow SHA pin 和 writer 边界通过 |
| 浏览器 375/768/1440、键盘、触摸、200% 缩放 | 未完成 | 当前任务的真实浏览器验收仍缺证据 |

## P0：先解决，否则不能交付

1. **前端回归未收敛。** `AfkView.tsx:479-492` 移除了 enqueue 入口，但 `494-515` 仍保留 enqueue 对话框；AFK 相关测试找不到 `afk-tool-enqueue`。这是功能入口回归，不是测试噪声。需要决定 enqueue 是否仍是正式能力；若保留，应恢复入口并按 `enqueueCandidates` 控制禁用态。
2. **OpenSpec Change 无有效 delta。** `openspec validate dashboard-ui-reimplementation --type change` 报 “Change must have at least one delta”。当前实现计划和任务清单无法被规范校验消费，导致治理链断裂。应补齐 `specs/<capability>/spec.md` 的 MODIFIED/ADDED requirements 和 Scenario，或撤销该 Change。
3. **Tap trace session 具有跨进程竞态。** `packages/tap/src/trace-store.ts:160-192` 的 session sidecar 读改写没有锁/CAS；并发 append 会让 JSONL 行数与 `record_count` 不一致，后续窗口读取会报告 degraded。应先用双进程 1000 次 append 和崩溃注入复现，再决定锁、单写者或可重建索引方案。

## P1：近期应修复或形成明确决策

### Dashboard / UX

- `Nav.tsx:167-235` 只在设置面板打开时渲染 secondary-nav，旧测试和深链语义不一致；设置按钮缺少 `aria-controls` 与稳定 panel id。AFK 徽标在 `228` 只有数字，没有 `data-testid`/`aria-label`，读屏无法解释含义。
- `WorkflowCanvas.tsx:189-193` 对超过 3 个阶段的轨道使用 `minWidth: 100%`。现有测试仍要求 7 阶段保持 1624px，说明“移动端不横滚”和“阶段可读”之间的布局契约未定。必须在真实 375/768/1440 浏览器中验证，而不能只改 jsdom 断言。
- 视觉 token 仍是迁移态：`index.css` 同时维护 primitive、semantic、component 和 legacy `amb/amber` 别名；约 280 个 raw button 分布在 105 个文件，Button primitive 只被约 14 个文件使用，原生 select 仍广泛存在。只改 primitive 不会覆盖产品界面。
- 页面存在多套 Dialog/Drawer/Card/Stage 表达与大量任意圆角、尺寸、阴影；应先冻结 page frame、control size、surface/elevation、状态色和 drawer/sheet 语义，再分批迁移，避免继续产生第三套样式。
- `.trellis/spec/dashboard-app/frontend/*` 仍是 “To be filled by the team” 模板，无法作为组件、无障碍和测试验收依据。

### 核心运行时

- scheduler interruption 在等待 settlement 完成前调用 `state.markFailedSync`，可能出现 state=failed 但 ledger=won/lost（`packages/automation/src/scheduler/scheduler-service.ts:62-77`）。
- channel list 把 event 读取和 worker liveness 分开采样，计数可能不是同一快照，且 stale PID 会误报容量（`packages/channel/src/store.ts:131-174`）。
- server 顶层把未捕获异常统一成 500 + prose，缺少 operation/correlation id 和可重试分类（`packages/server/src/server.ts:304-319`）。
- 当前架构门禁还要求拆分 `ProgressView` 与 `TaskDetail`，避免页面/组件继续承担过多职责。

### 仓库与交付

- 当前工作树删除 `AGENTS.md`、修改 `.gitattributes`，使 identity/repository hygiene 失败；这些应先区分为有意变更还是并行任务残留。
- `git diff --check` 虽通过，但不能替代上述门禁。
- 无独立 lint script；需要决定采用 ESLint/oxlint，或把现有架构/设计系统规则扩展为可执行静态检查。

## P2：需要深入研究后再承诺

- **真实宿主矩阵：** Codex、Claude、Gemini、Continue、Cline、Amp 等在干净 HOME 中执行 setup、新会话 hook、PreToolUse/PostToolUse、update、rollback；尤其 Amp 当前只有文档声明，没有凭证 E2E 证据。
- **发布 payload 可复现性：** 为 release candidate 建立单一机器可读 payload manifest，逐资产 hash 对齐 marketplace、plugin root、npx thin package、CLI、Dashboard 和 server bundle。
- **卸载完整性：** 当前 opencode/pi/codex/tap 等路径存在 stub/降级语义；为每个 adapter 建 fixture，验证 install→用户修改→dry-run→uninstall→重复卸载后的 ownership 和幂等性。
- **升级并发与旧会话：** 并发 update/repair、SIGTERM、网络中断、半写 journal、Dashboard 正在运行时，验证 active pointer、旧 release、锁和恢复语义。
- **能力声明与 manifest：** 两份 plugin manifest 没有 schema version、minimum host version、runtime API version 或机器可读 capability matrix；应研究宿主官方字段并加入 schema lint。
- **可观测性：** 定义本地-only audit schema、敏感字段 redaction、保留/轮换和导出格式，让 doctor/runtime status 能解释 hook 拒绝、激活、回滚和 Dashboard mutation。
- **性能：** channel/tap 使用同步文件扫描；对 10k sessions、100MB trace 目录压测 `/api/traces`、channel list 和 event-loop delay，必要时加分页/索引。
- **真实 provider/Docker/TLS：** 当前测试对 provider credentials、Docker daemon、local CA/TLS handshake 使用 honest-skip；发布报告必须区分 pass、skip、环境缺失和 provider 认证失败。

## 建议执行顺序

1. 冻结 IA 决策，恢复/删除 enqueue，并同步 Nav/App/Progress 测试。
2. 为 `dashboard-ui-reimplementation` 补 delta spec，填充 Dashboard 实际规范文档。
3. 处理当前工作树门禁红灯（`AGENTS.md`、`.gitattributes`、architecture line limits）。
4. 做 tap 并发一致性实验，再决定实现修复。
5. 统一 token/component recipe，按 Button → Select/Input → Card → Dialog/Drawer → Stage/Canvas 迁移。
6. 完成真实浏览器矩阵和运行时故障注入。
7. 再跑 full test、typecheck、build、OpenSpec、identity、hygiene、release/npx acceptance，形成可追溯 verification report。

## 研究产物

- 插件完整性研究：`.trellis/tasks/09-05-dashboard-visual-system/research/tenon-plugin-completeness.md`
- 核心跨层审计：`.trellis/tasks/09-05-dashboard-visual-system/research/tenon-core-audit.md`
- 既有视觉组件地图：`.trellis/tasks/09-05-dashboard-experience-rework/research/visual-component-map.md`

以上结论基于当前工作树静态代码、测试和仓库门禁；真实宿主、Docker、TLS、provider 凭证和浏览器运行态尚未在本次现场验证。

