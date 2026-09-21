# Open-source Documentation Experience Specification

## Purpose

定义 Tenon 的开源入口、公开文档、Dashboard 概览、双语可访问性、事实校验与社区维护要求。
## Requirements
### Requirement: The repository SHALL provide a truthful open-source entry

以下开源入口行为 MUST 全部满足。

根 `README.md` 必须以中文介绍 Tenon，并链接到结构与行为说明完整对应的 `README.en.md`。两份 README 必须覆盖产品结果、前置条件、宿主选择安装、第一次受治理任务、执行模式、证据与 review 模型、adapter fidelity、Dashboard、架构模块、正式文档、支持、安全、贡献和许可证。

README 必须区分 `tenon` 产品名和真实仓库标识 `tenon`，不得宣称不存在的统一版本、未发布的 npm 全局安装、所有宿主具有相同强制能力、未成功部署的公共站点、未经验证的平台保证或永久有效的测试数量。

#### Scenario: 新 Codex 用户从中文首页开始

- **WHEN** 新用户打开根 README
- **THEN** 首选安装路径明确使用 `tenon setup --codex`
- **AND** 解释一次性 hook 信任边界和新会话生效行为
- **AND** 提供真实的运行时验证命令和本地 Dashboard 默认 loopback 端口
- **AND** 链接到中文正式文档的安装与首个任务页面。

#### Scenario: 英文读者切换语言

- **WHEN** 读者从根 README 选择 English
- **THEN** `README.en.md` 提供相同的采用、安全、导航和生命周期章节
- **AND** 所有仓库相对链接从该文件解析正确
- **AND** 关键命令、端口和 workflow 语义与中文稿一致。

#### Scenario: Pages 尚未真实发布

- **WHEN** Pages workflow 尚未成功部署或仓库未启用 Pages
- **THEN** README 不得展示一个声称已上线的文档 URL
- **AND** 必须提供仓库内文档和本地预览命令作为真实可用入口。

#### Scenario: New Codex user follows the quickstart

- **WHEN** 新 Codex 用户打开根 README
- **THEN** 首选安装路径明确使用 `tenon setup --codex`
- **AND** 说明一次性 hook 信任边界、新会话行为、真实验证命令和默认 Dashboard 端口。

#### Scenario: User needs Chinese documentation

- **WHEN** 读者需要中文文档
- **THEN** 中文根 README 提供完整采用、安全、导航和生命周期说明
- **AND** 所有仓库相对链接可以正确解析。

#### Scenario: Unsupported publication claim is considered

- **WHEN** 版本、包或公共站点尚未被真实发布和验证
- **THEN** README 不展示误导性的统一版本或托管 URL
- **AND** 只描述已验证的源码安装和本地能力。

### Requirement: Canonical usage documentation SHALL cover public modules and tasks

公开使用文档 MUST 覆盖下列模块、任务与失败恢复路径。

仓库必须提供中文规范内容和英文完整镜像，覆盖：

- 安装、宿主选择、更新、修复、回滚与卸载；
- 第一个任务与显式 Change 恢复；
- discussion、simple、default、free 和 custom 路由；
- default 阶段、回边和 review receipt；
- custom workflow、track、skill、guard 与 document contract；
- OpenSpec、Superpowers、ADR、producer digest 与 read receipt；
- Dashboard 视图、单端口运行时、本地 API 和状态语义；
- AFK、Docker 前置条件、loop、budget 和 autonomy level；
- advanced channel、memory bridge 和 Tap 诊断；
- 故障排查、安全、贡献、架构、验证与发行。

每个任务型页面必须说明目标、前置条件、步骤、预期结果、验证、常见失败和下一步。每页只能有一个主要内容类型：教程、操作指南、概念解释或参考。

#### Scenario: 用户询问短 workflow 是否创建完整 OpenSpec

- **WHEN** 读者打开路由或文档证据指南
- **THEN** 文档说明 discussion 不创建 Change，packaged simple 没有 default OpenSpec contract
- **AND** default 要求完整受治理文档链
- **AND** custom/short workflow 只生成并要求其 document contract 声明的文档。

#### Scenario: 用户调查一直等待的任务

- **WHEN** 读者打开 Dashboard 或故障排查指南
- **THEN** 指南区分 phase work、review waiting、AFK queued/running 和 blocked/failure
- **AND** 在任何修复操作前提供只读诊断命令。

#### Scenario: 中文规范页与英文镜像不同步

- **WHEN** 页面 manifest 中某个公开 slug 缺少 `zh-CN` 或 `en` 对应页
- **THEN** 文档检查失败并报告 locale、slug 和缺失 source
- **AND** 不允许用静默跳回首页或 404 冒充语言切换。

#### Scenario: User asks whether every task creates OpenSpec

- **WHEN** 用户询问是否每个任务都创建完整 OpenSpec
- **THEN** 文档区分 discussion、simple、default 与 custom 的真实文档合同
- **AND** 不把短流程伪装成 default 完整链。

#### Scenario: User investigates a waiting task

- **WHEN** 用户调查一直等待的任务
- **THEN** 文档区分 phase work、review waiting、AFK queued/running 和 blocked/failure
- **AND** 先提供只读诊断命令。

#### Scenario: User configures an advanced tool

- **WHEN** 用户配置 Channel、memory bridge 或 Tap
- **THEN** 文档说明其高级/显式启用边界
- **AND** 对 prompt、header、token 与 CA 材料给出敏感数据警告。

### Requirement: The Dashboard SHALL expose a bundled read-only overview

The existing Dashboard SPA SHALL expose `overview` through
`/?view=overview`. The Pipeline brand control SHALL navigate to this view with
an accessible name and current-page state. `overview` SHALL NOT become a sixth
operational `PRIMARY_VIEWS` item and SHALL NOT replace Progress as the default.

The overview SHALL render before project/onboarding gating and SHALL remain
readable with zero projects, loading or failed snapshots, and a disconnected
event stream. It SHALL not call mutation endpoints or require project state.

#### Scenario: First-time user has no registered project

- **WHEN** the Dashboard snapshot reports zero projects and the URL requests
  `?view=overview`
- **THEN** the complete overview renders instead of project onboarding
- **AND** installation, workflow, evidence, documentation, and community links
  remain available.

#### Scenario: Operator enters through the brand

- **WHEN** an operator activates the brand control from any operational view
- **THEN** the URL changes to `view=overview`
- **AND** the brand exposes `aria-current="page"`
- **AND** the five operational rail destinations remain present and can return
  the operator to their existing workflow surfaces.

#### Scenario: Dashboard opens without an overview deep link

- **WHEN** no valid stored or linked view is present
- **THEN** the application still opens Progress
- **AND** no existing project/root/change deep-link behavior changes.

### Requirement: The overview SHALL explain modes, evidence, and modules without overclaiming

The overview SHALL present:

- Tenon's local-first value and exact setup command;
- discussion/simple/default/free/custom execution outcomes;
- the seven-phase default graph including return edges and review exits;
- the evidence chain from Skill visit through document digest/read receipt,
  review receipt, and transition;
- CLI, state/workflows, Dashboard, adapters/hooks, AFK/loops, and advanced
  diagnostics;
- adapter fidelity tiers and optional prerequisites;
- links to canonical usage, support, security, contribution, license, and the
  public repository.

It SHALL use static translated summaries backed by current sources and SHALL
not fetch remote marketing data, invent live project status, or embed a second
documentation renderer.

#### Scenario: User compares execution modes

- **WHEN** the mode section is rendered
- **THEN** each mode identifies its step shape, intended scope, and document
  behavior
- **AND** Free is not described as bypassing the selected Workflow's gates.

#### Scenario: User views the default workflow on a narrow screen

- **WHEN** the viewport is 320 pixels wide
- **THEN** all seven phases and review/return semantics remain visible in a
  vertical or wrapped reading order
- **AND** the page has no horizontal document overflow.

### Requirement: The open-source experience SHALL be accessible and bilingual

双语公开体验 MUST 同时满足语言对应、语义结构、键盘操作和响应式要求。

公开文档站必须以中文作为根 locale，以 `/en/` 作为英文 locale。两种语言必须有对应导航、侧栏、页内目录、搜索文案、SEO 元数据、正确 `html lang` 和稳定页面映射。Dashboard Overview 继续使用自己的 `zh/en` UI authority，不得隐式控制治理文档 locale。

站点必须使用语义标题、原生链接/按钮、跳过导航、可见焦点、安全外链属性、流程图文本替代和尊重 reduced motion 的非必要动效。

#### Scenario: 读者在对应页面切换语言

- **WHEN** 读者在任意有对应翻译的文档页切换中文与英文
- **THEN** 导航到相同 slug 的对应语言页
- **AND** 页面主旨、命令、约束和失败恢复保持语义一致
- **AND** 主题和当前阅读上下文不丢失。

#### Scenario: 键盘用户使用搜索和导航

- **WHEN** 用户只使用 Tab、Shift+Tab、Enter、Space、Escape 和 `Cmd/Ctrl+K`
- **THEN** 能打开搜索、选择结果、关闭搜索、展开移动端菜单和遍历主要链接
- **AND** 焦点顺序符合视觉阅读顺序
- **AND** 没有焦点陷阱或必须使用指针的操作。

#### Scenario: 320 像素窄屏阅读

- **WHEN** viewport 宽度为 320 像素
- **THEN** 顶栏、菜单、正文、代码块、表格和页内目录入口保持可用
- **AND** 页面不出现文档级水平溢出
- **AND** 全站菜单与“本页内容”入口语义可区分。

#### Scenario: 中文页面暴露 VitePress 内置控件

- **WHEN** 读者或辅助技术检查中文 locale 的导航、代码复制、heading permalink、搜索结果和移动菜单
- **THEN** 所有可访问名称、title 和状态文案使用中文
- **AND** 不出现 `Main Navigation`、`Sidebar Navigation`、`Pager`、`mobile navigation`、`Copy Code`、`Permalink to`、`Close search`、`Display detailed list`、`up arrow`、`down arrow`、`enter` 或 `escape`
- **AND** 英文 locale 仍使用完整英文文案。

#### Scenario: 语言切换发生在带 fragment 的页面

- **WHEN** 读者从带当前语言 heading fragment 的页面切换到对应语言
- **THEN** 导航到对应页面中真实存在的目标 fragment，或安全移除无法映射的 fragment
- **AND** 不保留一个在目标语言页面不存在的 hash。

#### Scenario: 首页作为主内容入口

- **WHEN** 用户或辅助技术打开中文或英文首页
- **THEN** 页面包含唯一 `<main>` landmark
- **AND** 跳过导航的焦点目标位于该 landmark 内
- **AND** 全局 header、nav 和 footer 位于该主 landmark 之外。

#### Scenario: 文档页显示阅读路径

- **WHEN** 用户打开任一中文或英文文档页
- **THEN** breadcrumb 依次提供首页、内容分组和当前页
- **AND** 每一级使用当前 locale 的可见名称
- **AND** 当前页使用非链接的当前位置语义。

#### Scenario: Language is switched

- **WHEN** 用户在文档站或 Dashboard Overview 切换语言
- **THEN** 所有产品文案切换到目标 locale，且不暴露原始 translation key
- **AND** 当前页面、主题和可映射的阅读上下文保持一致。

#### Scenario: Keyboard-only user navigates the page

- **WHEN** 用户只用键盘访问品牌、CTA、文档链接、搜索和 shell 控件
- **THEN** 焦点顺序符合阅读顺序且每个焦点可见
- **AND** 不存在焦点陷阱或指针专属操作。

#### Scenario: Reduced motion is enabled

- **WHEN** `prefers-reduced-motion: reduce` 生效
- **THEN** 内容和意义不依赖动画
- **AND** 装饰性过渡被移除或缩短为近即时。

#### Scenario: Dashboard 首次显示长阶段轨

- **WHEN** 当前 Change 位于横向阶段轨首屏之外的后续 phase，或 phase 在页面存续期间发生变化
- **THEN** Dashboard MUST 在首次呈现该轨时将 current stage 定位到横向可视区
- **AND** 当前状态与任务卡不需要用户先手动滚动才能发现
- **AND** 定位不依赖动画，也不覆盖用户之后的手动滚动。

### Requirement: Documentation claims and links SHALL be verified

文档事实、链接与构建产物 MUST 由确定性门禁验证。

仓库必须提供确定性文档检查，校验 README、公开内容 manifest、双语对应关系、导航、内部链接、锚点、关键产品声明、Pages base path、`llms.txt` 和禁止发布路径。

检查至少覆盖 Node.js 最低版本、setup/update/runtime/dashboard 命令族、生产 Dashboard 端口、五个操作视图和独立 overview、default/simple workflow 形状、README 语言与社区链接、所有公开页面的 locale parity、Markdown 锚点，以及静态 artifact 不包含未登记 ADR/Superpowers 文件、pipeline receipts、私钥、Bearer/query token 或用户目录绝对路径。

#### Scenario: 文档文件被重命名

- **WHEN** README、导航或 manifest 指向不存在的 source/target
- **THEN** 检查失败并指出来源文件、locale 和目标。

#### Scenario: Pages base path 出现根路径资源

- **WHEN** 生产 artifact 中的内部资源或导航绕过 `/tenon/` base
- **THEN** smoke 检查失败
- **AND** artifact 不得上传部署。

#### Scenario: 内部材料被加入公开产物

- **WHEN** artifact 复制了未在公开 manifest 登记的内部文件，或包含 `.pipeline-*` receipt、真实 token、私钥或工作区绝对路径
- **THEN** 安全检查失败并列出违规文件
- **AND** Pages deploy job 不运行。

公开指南可以解释 `docs/adr`、`docs/superpowers` 等治理路径；仅出现路径名称不得被误判为复制内部文件内容。

#### Scenario: A documented file is renamed

- **WHEN** canonical README 或 usage 链接指向缺失文件
- **THEN** 文档检查指出来源文档和目标并失败。

#### Scenario: Production port drifts

- **WHEN** 文档中的生产 Dashboard 端口与源码常量不同
- **THEN** 交付前的事实门禁失败。

#### Scenario: Operational navigation is changed

- **WHEN** 文档中的五个操作视图与 `PRIMARY_VIEWS` 漂移
- **THEN** 聚焦测试或文档检查失败
- **AND** Overview 仍被验证为独立的品牌级入口。

### Requirement: The repository SHALL expose maintainable community guidance

The repository SHALL provide contribution, conduct, support, and security
documents with real repository-relative or GitHub-owned actions. Security
guidance SHALL request private reporting for vulnerabilities, prohibit secrets
in public Issues, and avoid an invented response SLA.

#### Scenario: User wants to report a normal defect

- **WHEN** the reader opens `SUPPORT.md`
- **THEN** they are directed to a reproducible GitHub Issue with sensitive data
  removed
- **AND** troubleshooting and discussion paths are distinguished.

#### Scenario: Researcher finds a vulnerability

- **WHEN** the reader opens `SECURITY.md`
- **THEN** they are directed to GitHub's private vulnerability reporting path
  when available
- **AND** told not to disclose exploit details, credentials, prompts, tokens, or
  local traces in a public Issue.

### Requirement: The repository SHALL provide a formal static documentation site

正式静态文档站 MUST 提供可学习、可查阅、可深链的完整信息架构。

仓库必须包含独立的 VitePress workspace。站点必须提供首页、开始使用、教程、操作指南、概念与架构、参考、运维与安全、贡献和发布说明，并支持全局侧栏、页内目录、面包屑、上一篇/下一篇、深浅主题、响应式布局和可分享深链。

站点必须是纯静态产物，不得依赖 Dashboard server、本地 `/api`、SSE、token、工作区文件系统或 agent 会话。

#### Scenario: 新用户按学习路径进入

- **WHEN** 用户打开中文站点首页
- **THEN** 可以看到产品定位、执行模式、五分钟快速开始和按角色/目标组织的文档入口
- **AND** 第一个成功路径不要求先理解全部状态机和内部协议。

#### Scenario: 用户查阅精确参考

- **WHEN** 用户从 CLI、配置、workflow schema 或错误语义进入参考页
- **THEN** 页面提供签名/字段、默认值、约束、失败语义和真实示例
- **AND** 不把教程步骤混入完整参考表。

#### Scenario: 无 JavaScript 内容可读

- **WHEN** 客户端脚本未执行或搜索不可用
- **THEN** 预渲染正文、导航链接和核心内容仍然可读
- **AND** 不影响仓库内 Markdown 作为回退入口。

#### Scenario: 读者需要当前位置

- **WHEN** 读者进入首页之外的任意公开页面
- **THEN** 页面展示可访问的面包屑并反映 locale、内容分组和当前页
- **AND** 面包屑链接保留 `/tenon/` base 与当前语言。

### Requirement: Documentation search SHALL be local and locale-aware

本地搜索 MUST 在离线静态产物中按 locale 提供真实索引与结果。

第一版必须使用 VitePress 本地搜索，不依赖 SaaS、登录、远程索引或服务端。搜索必须按 locale 隔离索引，支持标题、章节、正文、命令、错误码、配置键和文件路径。

#### Scenario: 中文用户搜索 review gate

- **WHEN** 中文 locale 用户通过可见入口或 `Cmd/Ctrl+K` 搜索“评审”或 `review gate`
- **THEN** 结果优先返回中文页面
- **AND** 显示页面标题、章节路径和摘录
- **AND** 能命中保留英文的协议术语。

#### Scenario: 离线预览搜索

- **WHEN** 静态站点在无外部网络环境中加载
- **THEN** 已构建页面的全文搜索仍可用
- **AND** 不发送搜索查询到第三方。

#### Scenario: 搜索固定查询回归

- **WHEN** CI 运行搜索验收
- **THEN** 安装、更新、review gate、verify-fail、默认端口和关键配置查询均至少命中一个预期页面
- **AND** 搜索索引不包含内部文档。

### Requirement: Public documentation sources SHALL be deterministic and allowlisted

公开内容源、生成目录和最终 artifact MUST 由同一显式 allowlist 约束。

站点内容必须由版本化 manifest 明确映射 source、locale、slug、标题、描述、内容类型和导航位置，并通过确定性同步器写入非人工编辑的生成目录。

#### Scenario: 同一提交重复生成

- **WHEN** 在相同 Node/npm 版本和相同 source 上连续运行两次同步
- **THEN** 生成内容逐字节一致
- **AND** 第二次运行不产生 Git 漂移。

#### Scenario: 未登记页面出现

- **WHEN** `docs/usage` 或其他目录新增 Markdown 但没有加入公开 manifest
- **THEN** 检查明确报告孤儿页或显式私有状态
- **AND** 不通过宽泛 glob 自动发布。

#### Scenario: 内容类型混合

- **WHEN** 页面同时被标为多个主要内容类型或缺少类型/描述
- **THEN** manifest 检查失败
- **AND** 指示作者选择教程、操作指南、概念或参考之一。

#### Scenario: 公开产物出现未知文件

- **WHEN** VitePress artifact 包含未由构建器固定资产或公开 manifest 推导出的任意额外文件
- **THEN** artifact audit fail-loud 并列出相对路径
- **AND** 不因扩展名未知、二进制格式或内容无法解码而跳过
- **AND** `assets/` 下扩展名合法但未被当前构建清单引用的 `.js`、`.css` 或字体文件同样失败
- **AND** `.pipeline-*`、receipt、ADR、Superpowers 内部材料和 source map 一律不得发布。

#### Scenario: 重复同步验证确定性

- **WHEN** CI 对同一 source 连续运行两次同步
- **THEN** 两次生成树的文件清单与每个文件 digest 完全一致
- **AND** 不依赖 tracked 工作区恰好干净来推断确定性。

### Requirement: GitHub Pages SHALL deploy only verified static artifacts

GitHub Pages 发布 MUST 只消费 `main` 上通过完整门禁的静态 artifact。

仓库必须提供 GitHub Pages Actions workflow。PR 只构建和验证；`main` 成功后才上传并部署。workflow 必须使用 `contents: read`、`pages: write` 和 `id-token: write` 的最小权限、`github-pages` environment 和部署 concurrency。

#### Scenario: 主分支验证成功

- **WHEN** `main` 上 install、sync、docs check、build、base smoke 和 artifact audit 全部成功
- **THEN** workflow 上传 VitePress 静态 artifact
- **AND** 通过官方 Pages deploy action 发布。

#### Scenario: PR 构建成功

- **WHEN** pull request 的文档验证通过
- **THEN** 产生可审计构建结果
- **AND** 不取得生产部署权限或部署 Pages。

#### Scenario: feature branch 手动运行

- **WHEN** 维护者从非 `main` 分支触发 `workflow_dispatch`
- **THEN** workflow 可以运行 install、sync、check、build 与 smoke
- **AND** `configure-pages`、artifact upload 和 deploy 均不得运行。

#### Scenario: 构建或审计失败

- **WHEN** 任一内容、语言、链接、base、搜索或禁止路径检查失败
- **THEN** deploy job 不执行
- **AND** 既有 Pages 部署保持不变，可由上一成功 artifact 回滚。

### Requirement: The plugin SHALL generate all first-party human-readable Markdown in Chinese by default

插件的第一方人读 Markdown 呈现 MUST 默认使用中文，并在显式英文 Change 中保持英文一致性。

插件必须提供版本化 Document Presentation Registry，并以 `zh-CN` 作为新 Change 的默认文档 locale。Registry 必须覆盖 default workflow 的 proposal、design、tasks、Superpowers design、ADR、delta spec、Superpowers plan、implementation plan、verification report 和 applied spec。Registry/locale YAML 是分发真相源，运行时呈现表必须由确定性生成器生成并通过 freshness 检查。

除 Change 治理文档外，插件生成的项目规格骨架、Loop 受管镜像段落和 phase handoff 人读摘要也必须默认使用中文。显式英文 Change 的 handoff 摘要必须跟随该 Change 固定的 `documentLocale=en`；无 Change 语言上下文的生成入口只有在显式 `--document-locale en` 时才可生成英文。

document contract 和 ledger 继续治理 kind、owner、producer、path、digest 与 reads；Registry 只能治理结构和展示文案。phase id、event id、DocumentKind、producer、文件名、metadata key、coverage key 和 OpenSpec 操作词必须保持稳定英文 token。

#### Scenario: 新 default Change 使用默认设置

- **WHEN** 用户创建一个没有显式 locale 的 default Change
- **THEN** Change 在 canonical current 提交前原子创建 `.pipeline-document-locale.json` 并固定 `zh-CN`
- **AND** 严格 canonical state 与 YAML projection 不增加 locale 字段
- **AND** 缺失的 proposal、design 和 tasks 骨架使用中文可见标题和提示
- **AND** 七阶段任务标题来自实际 workflow label/id。

#### Scenario: 用户显式选择英文

- **WHEN** 用户以受支持的显式配置或 CLI 参数创建新 Change 并选择 `en`
- **THEN** 该 Change 的 locale sidecar 固定 `en`
- **AND** 之后所有 scaffold 使用英文对应模板
- **AND** 全局 locale 的后续变化不改写该 Change。

#### Scenario: 旧 release 回滚读取

- **WHEN** 新 release 创建带 locale sidecar 的 Change 后回滚到不知道该 sidecar 的旧 release
- **THEN** 旧 release 仍能按原严格 canonical schema 读取和转换 Change
- **AND** 不因未知 locale 字段拒绝 canonical/YAML。

#### Scenario: 历史 Change 没有 locale sidecar

- **WHEN** 当前 release 为旧 Change 创建缺失治理文档
- **THEN** 从 proposal、design 和 tasks 的一致 H1 推断一次 locale 并原子固定
- **AND** 已有文档中英文混合时 fail-loud，不静默选择中文或英文。

#### Scenario: 用户创建项目规格骨架

- **WHEN** 用户运行 `tenon scaffold spec web` 且没有显式 locale
- **THEN** frontend、backend 与 guides 的可见标题、摘要和待填写提示使用中文
- **AND** 路径、project type、scaffold marker 与冲突策略 token 保持稳定
- **AND** `--document-locale en` 生成结构等价的英文版本。

#### Scenario: 插件生成 Loop 镜像与 phase handoff

- **WHEN** reconciliation 为新的 Loop 创建受管 `LOOP.md` 段落
- **THEN** 标题与真相源说明使用中文，ownership marker 与 loop id 保持稳定
- **AND** 已存在的手写或历史受管段落不会仅因升级而被翻译。
- **WHEN** 用户为中文 Change 生成 phase handoff 摘要
- **THEN** 人读标题、结构、决策、约束、待办、关键字段和压缩统计使用中文
- **AND** JSON 字段名、phase、路径与原文信号保持稳定。

#### Scenario: locale catalog 不等价

- **WHEN** `zh-CN` 与 `en` 缺少相同 template、section 或 placeholder
- **THEN** 构建和模板检查 fail-loud
- **AND** 运行时不得生成结构残缺的文档。

#### Scenario: Registry、schema、catalog 与 renderer 漂移

- **WHEN** template section 顺序、section key、placeholder 或动态值来源在任一层不一致
- **THEN** codegen 或模板门禁 fail-loud
- **AND** renderer 只消费由 Registry 和 locale catalog 生成的结构，不维护第二套硬编码 section 图
- **AND** `registry.v1.schema.json` 对 Registry 与 catalog 资产执行真实结构校验。

#### Scenario: custom workflow 复用 default phase id

- **WHEN** custom workflow 的 step id 是 `open`、`build` 或其他 default id，但声明了自定义 label
- **THEN** tasks 使用该 workflow 的显式 label
- **AND** 只有 default workflow 缺少显式 label 时才使用产品内建本地化 label。

#### Scenario: 显式英文 Change 调用 phase Skill

- **WHEN** Change locale 固定为 `en`
- **THEN** phase Skill 的人读标题、requirement、scenario、任务和解释使用英文
- **AND** Skill 指令不得无条件要求中文而覆盖 Change-pinned locale。

### Requirement: Governance document localization SHALL preserve workflow contracts and history

文档本地化 MUST 保持 workflow 合同、历史字节、路径边界和证据语义不变。

中文化不得改变 default/simple/custom 的 document contract，也不得自动改写既有或归档文件。renderer 必须保留 missing-only、普通文件校验、并发安全、原子 no-replace 和确定性换行语义。document scaffold 在创建任何父目录前必须逐级拒绝 symlink 和项目边界逃逸。

#### Scenario: packaged simple task starts

- **WHEN** 用户创建内建 simple workflow
- **THEN** 不生成 default proposal、design、tasks 或完整 OpenSpec 链
- **AND** 只执行 simple 自己的短 DAG 和文档合同。

#### Scenario: custom workflow declares three documents

- **WHEN** custom workflow 的 `document_contract:v1` 只声明三个 kind
- **THEN** 只允许为这三个 kind 选择 Registry 模板
- **AND** 不因 step 名或 locale 自动补齐 default 十类文档。

#### Scenario: setup or automatic update runs

- **WHEN** 用户安装、修复或更新插件模板版本
- **THEN** 已有 Change 和 Archive 的文档字节、ledger digest 与 read receipt 保持不变
- **AND** 新模板只影响后续新建或明确缺失的文档。

#### Scenario: 现有文件已存在

- **WHEN** renderer 发现目标路径已经是普通文件
- **THEN** missing-only 操作跳过且不改变字节
- **AND** 不伪造新的 producer、record 或 read receipt。

#### Scenario: delta spec scaffold

- **WHEN** Skill 请求创建缺失 delta spec
- **THEN** 必须显式传入真实 `--capability <capability>`
- **AND** 不得从 Change 名、单候选 spec 目录或默认 scope 猜测 capability
- **AND** capability 非法或缺失时不得写文件或固定新的 locale sidecar。

#### Scenario: scaffold 父路径是 symlink

- **WHEN** 任一目标父路径组件是 symlink 或解析后越过项目根
- **THEN** 命令在创建外部目录或文件之前失败
- **AND** 已有外部目标保持逐字不变。

#### Scenario: Change 根目录是 symlink 或在检查后被替换

- **WHEN** `openspec/changes/<name>`、`--spec-dir` 或任一父组件是 symlink，越过项目根，或在安全检查与发布之间发生替换
- **THEN** `tenon init`、`tenon scaffold spec` 和 `tenon document scaffold` 在 locale pin、mkdir、write、rename、link 或 remove 前 fail-loud
- **AND** 不得在仓库外创建、覆盖或删除任何文件
- **AND** overwrite 也必须使用同一可信根与普通文件约束。

#### Scenario: init 遇到预先存在的 Change symlink

- **WHEN** 攻击者在运行 `tenon init <name>` 前把 `openspec/changes/<name>` 建为指向仓库外目录的 symlink
- **THEN** init 在创建任何 locale、文档、canonical state 或 YAML projection 前失败
- **AND** 外部目录的文件清单与内容逐字不变
- **AND** 不留下一个可被后续恢复为活跃 Change 的半初始化状态。

#### Scenario: overwrite 在发布途中失败或竞争

- **WHEN** `tenon scaffold spec --strategy overwrite` 在暂存、验证或提交阶段失败，或目标路径在检查后被替换
- **THEN** 原文件集保持完整，或者一次性切换为经过完整验证的新文件集
- **AND** 不出现新旧文件混合、缺失文件或仓库外删除
- **AND** 临时目录可以安全识别和清理，不会被当作正式规格
- **AND** 事务发布边界 MUST 只拥有目标 `specDirectory`，不得移动、复制或替换 sibling Change 命名空间
- **AND** sibling 文件在事务前已打开并于提交期间继续写入时，其更新仍保持可见
- **AND** 目标目录或可信父路径身份漂移会使事务 fail-loud，并保留可确定恢复的 receipt/stage/backup。

#### Scenario: reconciliation 遇到已有历史受管段

- **WHEN** Loop 镜像段已经存在且内容为旧版本或英文
- **THEN** 普通 ensure/setup/update 保持该受管段逐字不变
- **AND** 只有显式迁移操作才可改变其人读语言与 digest。

#### Scenario: 历史 Change 使用自定义 H1

- **WHEN** 没有 locale sidecar 的历史 Change 使用一致但非模板默认的中文或英文 H1
- **THEN** locale 推断综合全部受管文档的文字脚本和结构信号
- **AND** 信号不足或混合时 fail-loud，不静默回退 `zh-CN`。

#### Scenario: locale 参数缺值

- **WHEN** 用户传入裸 `--document-locale`
- **THEN** CLI fail-loud 并说明允许值
- **AND** 不得静默回退到中文后写文件。

### Requirement: OpenSpec lifecycle SHALL remain machine-compatible and single-owner

中文默认呈现 MUST 保持官方 OpenSpec 解析兼容，并为 delta 应用定义唯一、幂等的生命周期边界。

proposal 的 `Why`、`What Changes`、`Capabilities` 和 `Impact`，delta 的操作标题以及
`Requirement`、`Scenario` 必须保持 OpenSpec 官方机器拼写；这些标题下的人读正文跟随 Change-pinned
locale。Verify 只能在隔离临时副本演练 delta 应用；Ship 负责对主规格执行幂等应用并生成
`applied-spec` receipt；Archive 对已应用的 Change 使用官方跳过规格更新的归档路径。

#### Scenario: 中文 proposal 进入官方工具

- **WHEN** proposal 正文使用中文且 Change-pinned locale 是 `zh-CN`
- **THEN** `openspec show <change> --json --deltas-only` 成功识别 Why、Capabilities 和 delta
- **AND** `openspec validate <change> --strict` 通过
- **AND** 机器标题保持英文，正文和解释保持中文。

#### Scenario: Verify 演练规格应用

- **WHEN** Change 包含 ADDED、MODIFIED 或 REMOVED delta
- **THEN** Verify 在隔离的临时仓库副本中运行官方 apply/archive 演练
- **AND** 真实主规格、Change 目录和 workspace fingerprint 不发生变化
- **AND** 演练失败会阻断 verify-pass。

#### Scenario: Ship 重复应用相同 delta

- **WHEN** Ship 首次或重复执行已验证 delta
- **THEN** 主规格最终内容相同且每个 requirement/scenario 只出现一次
- **AND** 已经完全应用时返回可审计 no-op，而不是冲突或重复追加
- **AND** `applied-spec` receipt 记录 source、target、effect、digest 和 no-op/changed 结果。

#### Scenario: 历史流程在 Ship 前提前写入主规格

- **WHEN** 已知历史流程在 Verify 中提前写入主规格，且当前主规格既不等于固定 base 也不等于官方重建结果
- **THEN** Build 生成机器迁移 receipt，固定 base commit、规范化规则、delta、observed current 和 expected after digest
- **AND** Verify 只在隔离目录重建并验证 receipt，不写真实主规格
- **AND** Ship MUST 执行受管 migration gate，在同一锁定事务内校验 observed current digest、原子发布 expected bytes 并复核 after digest
- **AND** migration gate 返回结构化 changed/no-op receipt 后，才能由正式 `applied-spec` 记录结果
- **AND** 无法重建、digest 漂移或 CAS 失败都会阻断 Ship。

#### Scenario: Archive 处理已应用规格

- **WHEN** Ship 已生成有效 applied-spec receipt 且主规格与 delta 一致
- **THEN** Archive 使用官方 `--skip-specs` 路径移动 Change
- **AND** 不再次应用 delta
- **AND** 归档后主规格保持 Ship 已验证的字节。

### Requirement: Phase Skills SHALL author meaningful Chinese documents without fabricating evidence

phase Skills MUST 按 Change-pinned locale 编写有意义正文，并保持真实 producer/read/review 证据。

phase Skills 必须引用共享 Registry/幂等 scaffold 入口，并在当前 Change 的固定 locale 下编写有意义正文。模板只提供结构，不能代表 Skill 已执行或文档已完成。

#### Scenario: Spec phase writes a delta spec

- **WHEN** `openspec-propose` 为中文 Change 编写 delta spec
- **THEN** `ADDED/MODIFIED/REMOVED Requirements`、Requirement、Scenario 等机器结构保持兼容 token
- **AND** requirement、scenario 和解释正文使用中文
- **AND** 仍由真实 `openspec-propose` producer 登记。

#### Scenario: Verify phase writes report

- **WHEN** Verify 步骤完成验证
- **THEN** verification report 的可见章节、结果解释、失败和剩余风险使用中文
- **AND** 命令、路径、测试名称和退出码保持原样
- **AND** 未运行的验证不得被写成通过。

#### Scenario: 后续阶段读取前序文档

- **WHEN** 当前 phase 需要读取已登记的中文文档
- **THEN** `tenon document read` 为当前 digest 写入 read receipt
- **AND** locale 不改变 digest、producer、review 或 transition guard 语义。

#### Scenario: Codex 内容块报告 Skill 调用完成态

- **WHEN** Codex 的 `custom_tool_call_output` 以内容数组返回 `Script completed` 或 `Script failed`，且不提供数值 exit code
- **THEN** Skill evidence verifier MUST 把 completed 视为成功、failed 视为失败
- **AND** 混合、缺失或未知完成态 fail-closed
- **AND** 后续正文偶然出现 `exit=0` 不得覆盖宿主的 failed 状态。

#### Scenario: Registry 为 CLI 提供呈现投影

- **WHEN** CLI 需要从 document kind 解析模板、路径或默认 workflow label
- **THEN** 该映射来自 Registry codegen 的版本化投影
- **AND** CLI 不维护第二套硬编码标题或 kind-to-template/path 表
- **AND** Registry freshness 检查能捕捉任一消费者漂移。

#### Scenario: 使用上一已发布版本回滚读取

- **WHEN** 当前 release 创建 Change 后使用项目支持的 N-1 已发布 bundle 读取该 Change
- **THEN** N-1 能解析 canonical current 和 YAML projection
- **AND** 不因展示 locale、document profile、fingerprint 或 run metadata 的未知字段拒绝整个 Change
- **AND** 兼容门禁从固定 commit 重建包含 CLI、templates、skills、hooks、adapters、server/SPA 和 bootstrap 的完整 payload
- **AND** 门禁校验固定 CLI digest，运行该 payload 内的真实 N-1 CLI，并记录 release、版本与命令结果。

### Requirement: The site SHALL expose an agent-readable public index

Agent 可读索引 MUST 只列出公开 manifest 中的真实 canonical 页面。

静态产物必须包含由公开 manifest 生成的 `llms.txt`，列出 canonical 页面、locale 和 Markdown/HTML 入口，不包含内部设计、ADR、计划、receipts 或未发布草稿。

#### Scenario: Agent discovers documentation

- **WHEN** agent 请求 `/tenon/llms.txt`
- **THEN** 返回按 locale 和内容类型组织的公开页面清单
- **AND** 每个条目指向构建中存在的 canonical 页面。

#### Scenario: Internal file is added to repository

- **WHEN** 新 ADR、Superpowers report 或 pipeline evidence 被创建
- **THEN** `llms.txt` 不会因目录扫描自动包含它
- **AND** 只有显式公开 manifest 变更才能改变索引。

### Requirement: README 与正式文档 SHALL 以 Tenon 为唯一现行产品身份

中文 README、英文 README、VitePress 中文/英文内容、`llms.txt`、CLI 示例、仓库链接与 Pages base
SHALL 使用 Tenon 现行身份。历史说明 MAY 提及旧名，但不得把旧 CLI、旧插件或旧仓库作为当前安装入口。
中文仍是默认读者路径，英文内容 SHALL 与中文命令、端口和安全边界等价。

#### Scenario: 新用户从 GitHub 首页安装

- **WHEN** 用户打开根 README
- **THEN** 首选路径是一行 Marketplace bootstrap 且不要求 clone
- **AND** 明确宿主选择、hook 信任、新会话生效、18765 Dashboard 和验证命令
- **AND** npx 只有在 npm 包真实发布后才作为可执行入口展示。

### Requirement: README 与中文文档站 SHALL 提供精选 Dashboard 图文

仓库 SHALL 生成 3–4 张当前 Tenon Dashboard 正式图片，覆盖项目/总览、进度、自动运行和工作台中的
核心能力。图片 SHALL 使用稳定命名、压缩格式、尺寸阈值和隐私检查。README SHALL 使用核心总览图与
紧凑说明；中文文档站 SHALL 使用响应式图文块解释各视图之间的关系，不得把旧 QA 截图图库直接公开。

#### Scenario: 读者在 GitHub 查看 README

- **WHEN** GitHub Markdown 渲染根 README
- **THEN** 相对图片链接可加载且 alt text 描述视图和用途
- **AND** 图片不会把安装步骤和核心文字推到首屏之外
- **AND** 暗色 GitHub 背景下仍可辨识边界。

#### Scenario: 读者在 Pages 查看中文文档

- **WHEN** 用户在桌面或移动宽度打开 Dashboard 概览/教程
- **THEN** 图片 URL 在 `/tenon/` production base 下有效
- **AND** 图文块响应式堆叠、无横向溢出、可键盘访问
- **AND** 图片不含本机用户名、临时目录、真实私有任务或错误状态。

### Requirement: 文档图片 SHALL 进入确定性公开资产清单

正式图片 SHALL 同时进入 repository hygiene allowlist、文档 source manifest 或固定 public asset 清单、
链接检查与 Pages artifact audit。未引用图片、超阈值图片和未知二进制 SHALL fail-loud。

#### Scenario: 新增未登记图片

- **WHEN** `docs-site/public/images/` 出现未被 allowlist 和公开页面引用的图片
- **THEN** 文档检查失败并列出该文件
- **AND** Pages deploy 不执行。

#### Scenario: 删除或重命名正式图片

- **WHEN** README 或生成文档仍引用不存在的图片
- **THEN** GitHub/VitePress 链接检查失败
- **AND** 维护者必须同步更新引用和 allowlist。

### Requirement: 安装文档 SHALL 提供可复现的版本化一行命令

README、中文/英文安装文档、quickstart 和文档站 SHALL 使用同一个已发布稳定版本的一行安装命令，不得用 `main` 作为脚本 URL 或 Marketplace ref。发布版本变化时 SHALL 由确定性检查同步并验证全部公开投影。

#### Scenario: 新用户从 README 安装

- **WHEN** 用户复制 README 的 Codex 安装命令
- **THEN** URL 明确包含当前稳定 `vX.Y.Z`
- **AND** 文档说明安装消费预构建 Release、不需要源码编译
- **AND** 中文与英文入口指向同一个版本身份

#### Scenario: 文档版本落后于 manifests

- **WHEN** README/正式文档中的安装标签与当前 release manifests 不一致或仍出现 `main/install.sh`
- **THEN** docs/identity/release 门禁失败
- **AND** 不发布漂移的版本

### Requirement: 安装文档 SHALL 解释 Dashboard 启动与打开行为

安装和更新文档 SHALL 说明 Dashboard 在 managed runtime 发布后自动启动并等待健康，但只有交互式首次 setup 尝试自动打开。curl/CI、手动 update 和后台 update SHALL 给出 URL 与 `tenon dashboard --open`，不承诺弹出浏览器。

#### Scenario: curl 安装完成

- **WHEN** 用户通过官方 curl 管道完成安装
- **THEN** 终端显示 Dashboard 已验证 URL 和 `tenon dashboard --open`
- **AND** 文档不要求用户从源码启动 Dashboard

#### Scenario: 自动打开失败

- **WHEN** 交互式 setup 无法调用系统浏览器
- **THEN** 文档和 CLI 都把已验证 URL 作为恢复路径
- **AND** 不把浏览器失败描述为插件或 runtime 安装失败

### Requirement: 文档 SHALL 诚实说明 v1.0.1 一次性迁移边界

正式安装与升级文档 SHALL 说明：已经发布的 v1.0.1 无法由后续源码追溯增加同进程 self-reexec，旧
`main`/local marketplace 用户迁移到 v1.0.2 时 SHALL 执行一次固定版本安装器；完成后每次更新 SHALL
使用单条 `tenon update --codex`。文档 SHALL NOT 要求用户运行源码构建，也 SHALL NOT 用第二次隐式
update、验证脚本 mutation 或 Dashboard side effect 冒充一键迁移。

#### Scenario: v1.0.1 用户查看升级说明

- **WHEN** 用户从当前稳定文档查找 v1.0.1 到 v1.0.2 的升级方式
- **THEN** 文档给出与新用户相同的 `v1.0.2/install.sh` 一行命令
- **AND** 解释这是一次性 legacy bridge，后续恢复为 `tenon update --codex`
