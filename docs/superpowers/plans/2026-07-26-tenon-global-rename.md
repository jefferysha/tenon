---
change: rename-pipeline-lite-to-tenon
design-doc: docs/superpowers/specs/2026-07-26-tenon-product-identity-design.md
---

# Tenon 全局迁移实施计划

## 目标

把现行产品从 `Pipeline Lite`/`pipeline-lite`/`pipeline` 收敛为 Tenon，修复 Dashboard
执行来源误判，提供无需 clone 的 Marketplace 一步安装与可发布 npx 入口，清理仓库旧截图，
并把精选 Dashboard 图加入 README 和中文文档站。

## 已确定边界

- 最终 Tenon 包只暴露 `tenon`，不保留旧命令 alias。
- 宿主目录 `.codex`、`.agents`、`.claude` 不改名。
- 端口固定为 `127.0.0.1:18765`。
- Git 提交历史不改写；当前树不保留外部参考项目身份或相关调研、演示、归档产物。
- Marketplace 是首装主入口；npx 是同一 payload 的薄入口。
- B3 原型决策采用“执行”：在正式大规模改名之前，用隔离 HOME 和本地发行 tarball 打通一条
  tracer bullet；这是用户已授权“按推荐走完全流程”后的保守选择。

## Build 子阶段 1：身份真相源与纵向 tracer bullet

**目标：** 先贯通“identity source → CLI → Marketplace manifest → Dashboard → docs check”的最小链路，
尽早暴露生成和消费边界。

### Task 1.1：建立产品身份真相源

**文件：**

- 新增 `product/identity.json`
- 新增 `tools/generate-product-identity.mjs`
- 新增 `tools/check-product-identity.mjs`
- 新增 `packages/kernel/src/product-identity.generated.ts`
- 修改根 `package.json`

**实现：**

- 声明 display name、CLI/bin、plugin/marketplace、Skill prefix、runtime app、env/browser prefix、
  repository、Pages base、Dashboard port。
- 生成 TS/JSON/shell-safe 投影；生成器使用稳定排序与原子替换。
- 增加 `generate:identity` 与 `check:identity`，后者先生成到临时目录再做逐字节 freshness 比较。

**验证：**

```bash
npm run generate:identity
npm run check:identity
node --test tools/check-product-identity.node-test.mjs
```

### Task 1.2：贯通最小 CLI、manifest、Dashboard 与文档

**文件：**

- 修改 `packages/cli/src/program.ts`
- 修改 `.codex-plugin/plugin.json`
- 修改 `.agents/plugins/marketplace.json`
- 修改 `packages/dashboard-app/src/i18n/translations.ts`
- 修改 `README.md`
- 增加/修改对应 focused tests

**实现：**

- 只迁移一个可见帮助标题、一个 Marketplace identity、一个 Dashboard 标题与 README 快速安装，
  全部消费 identity projection。
- 用隔离 fixture 验证 `tenon --version`、manifest `tenon@tenon` 和页面标题一致。
- 这一步是一次性原型；若 identity 投影无法跨 JSON/shell/TS 保持 freshness，先修生成边界再扩散。

**验证：**

```bash
npx vitest run packages/cli/src/program.test.ts packages/server/src/marketplaceManifest.test.ts
npm run test:web -- --run packages/dashboard-app/src/App.test.tsx
npm run check:identity
```

**回滚：** 只回滚新 identity source/projection 和最小 consumers，不触碰 runtime selection。

**此处建议 `/clear`。**

## Build 子阶段 2：包、CLI、插件与生成链路全量迁移

### Task 2.1：迁移 workspace 与可执行入口

**文件：**

- 根及 `packages/*/package.json`
- `package-lock.json`
- `packages/cli/src/main.ts`、`program.ts`、`deps.ts`
- `packages/cli/dist/tenon.mjs`（构建生成）
- `packages/server/dist/dashboard.mjs`（构建生成）
- `runtime/tenon-bootstrap.mjs`
- 根 `.gitignore`

**实现：**

- workspace scope 改为 `@tenon/*`；公开 bootstrap 包与内部 private workspace 明确分离。
- CLI bundle 从 `pipeline.mjs` 迁移为 `tenon.mjs`，launcher 为 `tenon`/`tenon-hook`，
  Dashboard launcher 为 `tenon-dashboard`。
- 删除最终包中的旧 bin 与旧 bundle allowlist；不手改生成 bundle。

**验证：**

```bash
npm install --package-lock-only
npm run build
bash tools/test-bundle.sh
npm run check:identity
```

### Task 2.2：迁移插件、Marketplace、Skills、commands 与 hooks

**文件：**

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `skills/**/SKILL.md`
- `commands/*.md`
- `hooks/**`
- `templates/manifest.yaml`
- `tools/verify-skills.sh`、`tools/test-hooks.sh`

**实现：**

- 插件/Marketplace 使用 `tenon`，phase Skill 目录和逻辑 id 使用 `tenon-*`，入口 Skill 为 `tenon`。
- 所有 hook 命令通过 `tenon-hook` 稳定 ABI；环境与浏览器注入改为 `TENON_*`/`__TENON_*`。
- 重新生成 router/manifest 投影；同步 DAG producer、文档 contract 和测试 fixture。
- 当前树中的 archive、ledger 与 fixture 同样受外部参考身份零残留约束；Git 既有提交对象不改写。

**验证：**

```bash
bash tools/verify-skills.sh
bash tools/test-hooks.sh
npm run check:default-workflow-freshness
```

**此处建议 `/clear`。**

## Build 子阶段 3：Managed runtime、安装、更新与迁移桥

### Task 3.1：迁移 runtime 路径和原子 launcher

**文件：**

- `packages/cli/src/runtime/paths.ts`
- `packages/cli/src/runtime/launchers.ts`
- `packages/cli/src/runtime/release-store*.ts`
- `packages/cli/src/commands/{setup,update,dashboard,plugin-host}.ts`
- `runtime/tenon-bootstrap.mjs`
- 相关单元/集成测试

**实现：**

- 应用目录切到平台标准根下的 `tenon`；active/previous、锁、审计和 retention 语义不变。
- stable launcher 只生成 `tenon`/`tenon-hook`；健康检查继续验证 releaseId/stateScopeId/18765。
- 旧 runtime 只由 migration reader 读取，普通 Tenon path resolver 不回退旧目录。

**验证：**

```bash
npx vitest run packages/cli/src/runtime packages/cli/src/commands/setup.test.ts \
  packages/cli/src/commands/update.test.ts
```

### Task 3.2：实现有期限的 legacy migration channel

**文件：**

- 新增 `packages/cli/src/migration/legacy-tenon-migration.ts`
- 新增 ownership/hash manifest 与 fixture
- 修改 update/setup orchestration
- 修改 `.github/workflows/` 发布工作流

**实现：**

- 旧通道仅验证并安装 Tenon、原子切换、验证新入口、再清理旧登记。
- 对真实目录、外部 symlink、用户文件和双目标冲突 fail-closed。
- 失败注入覆盖下载、manifest、smoke、selection、launcher 和宿主登记。
- Tenon 主包不导出旧 CLI 或旧插件 alias。

**验证：**

```bash
npx vitest run packages/cli/src/migration packages/cli/src/runtime
bash tools/prepare-n-minus-one-release.sh
```

**回滚：** migration 失败保留旧 active；Tenon 激活失败恢复 previous verified release。

### Task 3.3：重构整包更新事务

**文件：**

- `packages/cli/src/commands/update.ts`
- `packages/cli/src/runtime/{installer,launchers,types}.ts`
- `packages/cli/src/commands/dashboard.ts`
- `hooks/auto-update.sh`
- `packages/cli/src/program-install.ts`
- 对应单元、失败注入和真实进程测试

**实现：**

- 删除 `--self-update`，手动/自动更新统一走 `tenon update --<native-host>`。
- 将宿主 inventory 提交与 Tenon managed 提交建模为两个明确边界，不直接读写宿主私有 cache。
- launcher 写前捕获存在性、内容和 mode；首装、部分写入、Dashboard readiness 失败均做 CAS 安全的精确补偿。
- Dashboard coordinator 持有候选 child，失败时终止候选并恢复 previous release 的唯一 18765 服务。
- update 只读扫描项目注册表并报告显式 `tenon sync`，后台更新不修改用户工作区。
- CI 的 N−1 路径从 fixture `cliEntry` 派生，不再硬编码当前 CLI 名。

**验证：**

```bash
npx vitest run packages/cli/src/commands/update.test.ts \
  packages/cli/src/runtime/launchers.test.ts packages/cli/src/commands/dashboard.test.ts
bash tools/prepare-n-minus-one-release.sh <tmp>
TENON_N_MINUS_ONE_PAYLOAD=<tmp>/payload bash tools/test-bundle.sh
```

**此处建议 `/clear`。**

### Task 3.4：收敛产品机器状态与跨进程 root contract

**文件：**

- 新增 `packages/kernel/src/product-paths.ts` 及平台矩阵测试
- 修改 `packages/kernel/src/state/{projectRegistry,secrets}.ts`
- 修改 `packages/cli/src/runtime/{paths,installer,launchers}.ts`
- 修改 `runtime/tenon-bootstrap.mjs`
- 修改 `packages/server/src/{paths,main,server}.ts`
- 修改 `tools/check-architecture.mjs`

**实现：**

- 由 kernel 唯一解析 macOS、Linux、Windows 的 Tenon data/state/config roots 和所有产品状态文件。
- 取消 `~/.claude` 产品状态与 Dashboard 专属 Home；宿主目录仅用于宿主资产发现。
- 安装器解析一次并序列化版本化 `TENON_RUNTIME_ROOTS`，launcher、bootstrap、CLI、Dashboard
  消费相同元组；单 root 变量只作为 N−1 bootstrap 与 shell hook 的输出投影。
- 架构门禁禁止其他 production 文件拥有产品状态文件名、解释 `TENON_RUNTIME_HOME`、读取
  `TENON_DASHBOARD_HOME` 或把单 root 投影重新当输入。

**验证：**

```bash
npx vitest run packages/kernel/src/product-paths.test.ts \
  packages/kernel/src/state/projectRegistry.test.ts packages/kernel/src/state/secrets.test.ts \
  packages/cli/src/runtime/paths.test.ts packages/cli/src/runtime/launchers.test.ts \
  packages/cli/src/runtime/bootstrap.test.ts packages/server/src/paths.test.ts
npm run check:architecture
bash tools/test-bundle.sh
```

**回滚：** 只允许恢复 previous verified release 与其已记录 root contract；不得回退到宿主目录或
重新启用第二路径解析器。

**此处建议 `/clear`。**

## Build 子阶段 4：一步安装与 npx 发布包

### Task 4.1：把 `install.sh` 收敛为 Marketplace bootstrap

**文件：**

- `install.sh`
- `packages/cli/src/commands/plugin-host.ts`
- `packages/cli/src/commands/setup*.ts`
- 安装集成测试与 fixture

**实现：**

- 来源改为 `jefferysha/tenon`，插件为 `tenon@tenon`。
- Codex/Claude 各自只查询自己的 inventory；安装后运行包内 `tenon setup --<host> --yes`。
- 用户侧不执行 clone、npm install 或 build；重复执行保持幂等。

**验证：**

```bash
bash -n install.sh
npx vitest run packages/cli/src/commands/setup.test.ts
bash tools/test-adapters.sh
```

### Task 4.2：增加可发布 npx 薄包与内容审计

**文件：**

- 新增私有模板 workspace `packages/npm-bootstrap/`
- 新增 `packages/npm-bootstrap/bin/tenon-bootstrap.mjs`
- 新增 `tools/build-npx-package.mjs`
- 新增 npx pack/内容审计测试
- 新增 npm publish workflow（不内置 secret）

**实现：**

- package basename 固定 `tenon`，publisher scope 由发布配置显式注入，不在源码猜测。
- bin 固定下载 release tag 对应的 installer，并校验内嵌 SHA-256；installer 复用 Marketplace
  `main` 稳定通道和同一 managed transaction，不打入 monorepo 私有内容。
- workflow 使用 npm provenance/受保护 environment；没有凭据时只 pack/audit，不发布。

**验证：**

```bash
npm run check:npx-package
# 对生成 tarball 使用临时 HOME 运行 npx --package <tarball> tenon setup --codex --dry-run
```

**此处建议 `/clear`。**

## Build 子阶段 5：Dashboard provenance 与品牌 UI

### Task 5.1：建立 neutral execution provenance

**文件：**

- 新增 `packages/dashboard-app/src/model/executionProvenance.ts`
- 修改 `packages/dashboard-app/src/model/index.ts`
- 修改 `packages/dashboard-app/src/progress/ProgressView.tsx`
- 修改 `packages/dashboard-app/src/afk/AfkView.tsx`
- 增加 model/Progress/Afk focused tests

**实现：**

- 实现 `automation|terminal|none` truth table。
- 删除 AfkView 本地 `running|queued|failed` 来源推断。
- Progress 继续显示终端运行，Auto Run 只接收 automation provenance。

**验证：**

```bash
npm run test:web -- --run \
  packages/dashboard-app/src/model/executionProvenance.test.ts \
  packages/dashboard-app/src/progress/ProgressView.test.tsx \
  packages/dashboard-app/src/afk/AfkView.test.tsx
```

### Task 5.2：迁移 Dashboard 品牌与浏览器注入

**文件：**

- `packages/dashboard-app/src/**`
- `packages/server/src/**`
- `packages/dashboard-app/index.html`
- Dashboard/server bundle

**实现：**

- UI/i18n/API 诊断使用 Tenon；浏览器全局键和 env 使用 `__TENON_*`/`TENON_*`。
- API 路径若属于稳定协议可保留 `/api`，不得因品牌迁移创建第二服务。

**验证：**

```bash
npm run typecheck:web
npm run test:web
npm run build:web
npm run build:server
```

**此处建议 `/clear`。**

## Build 子阶段 6：README、中文文档站与精选 Dashboard 图

### Task 6.1：迁移公开文档身份和安装路径

**文件：**

- `README.md`、`README.en.md`
- `docs/usage/**`
- `docs-site/content-manifest.mjs`
- `docs-site/.vitepress/**`
- `docs-site/public/llms.txt`
- `.github/workflows/pages.yml`

**实现：**

- 中文首页以 Marketplace bootstrap 为首选；npx 仅在真实发布后显示为可用。
- 仓库 URL/base 改为 `jefferysha/tenon` 与 `/tenon/`。
- 命令、端口、review、自动更新和历史迁移边界跨语言一致。

**验证：**

```bash
npm run docs:sync
npm run docs:check
npm run docs:build
npm run docs:smoke
```

### Task 6.2：生成正式 Dashboard 图片并排版

**文件：**

- 新增 `docs-site/public/images/dashboard-overview.webp`
- 新增 `docs-site/public/images/dashboard-progress.webp`
- 新增 `docs-site/public/images/dashboard-workflow-editor.webp`
- 新增 `docs-site/public/images/dashboard-workbench.webp`
- 修改 README 与中文 Dashboard/快速开始页面
- 新增 `tools/capture-docs-dashboard.mjs` 与图片清单/检查

**实现：**

- 从真实 18765 Tenon Dashboard 的受控无隐私 fixture 捕获当前 UI，裁切并压缩为 WebP。
- README 放总览图和紧凑四宫格/能力链接；中文站用响应式图文块解释四个视图。
- 每图稳定命名、alt text、尺寸阈值；不得出现本机用户名、临时目录、私有任务或 bug 状态。

**验证：**

```bash
node tools/capture-docs-dashboard.mjs --check
npm run check:repository-hygiene
npm run docs:check
npm run docs:build
npm run docs:smoke
```

**此处建议 `/clear`。**

## Build 子阶段 7：仓库卫生、残留清理与生成物

### Task 7.1：删除旧截图并建立精确 ignore

**文件：**

- 删除 `design-demos/shots/*.png`
- 删除根 `workflow-governance-*.png`
- 修改 `.gitignore`
- 修改指向已删除图片的报告/验证说明

**实现：**

- 保留 `design-demos/*.html|*.md` 和正式 docs 图片。
- ignore 只覆盖 QA/临时截图目录和根命名模式，不使用会吞掉正式资产的 `*.png`/`*.webp` 广泛规则。
- 不执行 `git filter-repo` 或历史重写。

### Task 7.2：增加 repository/package hygiene 门禁

**文件：**

- 新增 `tools/check-repository-hygiene.mjs`
- 新增对应 node test
- 修改根 `package.json`、`.github/workflows/ci.yml`
- 修改 workspace fingerprint spec/test，正式图片仍计入实现 fingerprint

**实现：**

- 检查受禁 tracked paths、二进制尺寸和 allowlist、悬空图片引用、npm/Marketplace/Pages 内容清单。
- CI 在 build/publish 前运行；错误必须列出相对路径和治理规则。

**验证：**

```bash
npm run check:repository-hygiene
node --test tools/check-repository-hygiene.node-test.mjs
git ls-files | rg 'design-demos/shots|workflow-governance-.*\\.png' && exit 1 || true
```

### Task 7.3：全量残留分类和受控 bundle 重建

**文件：** 全部现行源码、配置、测试、fixture、公开文档与受控 dist。

**实现：**

- 运行旧身份扫描；现行产品类必须为零。
- 旧产品迁移允许项采用精确路径/结构分类；外部参考身份不设置路径或内容排除。
- 运行 build 重新生成 CLI/server/SPA；验证 freshness。

**验证：**

```bash
npm run build
npm run check:identity
bash tools/test-bundle.sh
bash tools/verify-skills.sh
```

**此处建议 `/clear`。**

### Task 7.4：外部参考身份零残留

**文件：**

- 删除路径名含受禁参考身份的设计 demo、研究、报告和 OpenSpec archive
- 改写仍有价值的代码、规范、测试与文档为 Tenon 自有中性表述
- 修改 `tools/check-repository-hygiene.mjs` 及其测试

**实现：**

- 同时扫描 `git ls-files` 的路径与受管理文本内容，不为 archive、ledger、fixture 或检查器自身开例外。
- 门禁使用非明文的策略 token 构造受禁身份，避免检查器自身成为残留；报告只输出命中路径，不回显名称。
- 只改变当前树；不运行 history rewrite。

**验证：**

```bash
npm run check:repository-hygiene
git ls-files | rg -i '<external-reference-identities>' && exit 1 || true
git grep -n -i -E '<external-reference-identities>' && exit 1 || true
```

**此处建议 `/clear`。**

## Verify 子阶段

### Task 8.1：代码、契约与适配器回归

```bash
npm run check:architecture
npm run check:comments
npm run check:docs
npm run check:document-templates
npm run typecheck:web
npm test
npm run test:web
npm run test:hooks
bash tools/test-adapters.sh
bash tools/test-bundle.sh
```

### Task 8.2：隔离首装、更新和回滚

- 在临时 HOME 分别验证 Codex/Claude Marketplace bootstrap。
- 对 npm tarball 运行 npx dry-run/首装；若 npm 未发布，只报告 tarball 结果。
- 用 n-minus-one fixture 验证成功迁移、各失败注入和 previous rollback。
- 验证只有一个 Skill root、一个 18765 listener、一个 active release。

### Task 8.3：真实浏览器验收

- 进度页：terminal-only 任务显示“终端运行中”。
- 自动运行页：同一 terminal-only 任务不存在；automation fixture 正常存在。
- Tenon 品牌、导航、帮助和 18765 健康状态一致。
- README GitHub Markdown 图片与 Pages `/tenon/` 图片在桌面/移动宽度可见、无溢出、无 page error。

### Task 8.4：验证报告与残留审计

- 生成中文 verification report，列出每条命令、浏览器截图、失败/修复循环和未发布外部动作。
- 全量扫描现行产品入口、包清单、bundle、Marketplace、Pages artifact。

## Ship 子阶段

### Task 9.1：主规格应用与发布准备

- 应用五个 delta spec，重新读取并登记 applied-spec。
- 版本按破坏性迁移提升，生成中文 release notes。
- 检查 commit 不含 secret、临时目录、旧 QA 图片或未登记二进制。

### Task 9.2：GitHub 交付

- 提交 `codex/tenon-global-rename`，推送并合入 `main`。
- 按迁移顺序准备 Tenon 新仓库/旧通道桥；更新 origin。
- 验证仓库首页 README 图片、Actions、Pages `/tenon/` 和公开链接。
- 不复用旧仓库名，以免破坏 GitHub redirect。

### Task 9.3：npm 外部发布边界

- 有真实 publisher scope、2FA/token 和受保护 environment 时才首次 `npm publish --access public`。
- 无凭据时保留“pack 已验证、npm 未发布”，Marketplace 仍是完整一步安装入口。

## Archive 子阶段

- 完成 Change 归档，验证 main specs、文档 ledger、tasks 与最终 Git 状态。
- 确认 migration-only 内容有明确移除条件，Tenon 主包无旧命令兼容面。
