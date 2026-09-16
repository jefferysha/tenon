# 分发产物：完整 runtime 随插件入包

## 是什么

插件发布的运行时产物有四组，前三组由 `npm run build` 生成并提交，第四组是受版本控制的最小稳定 bootstrap：

- `packages/cli/dist/tenon.mjs`：单文件 ESM CLI bundle，带 `#!/usr/bin/env node` shebang；
- `packages/server/dist/dashboard.mjs`：单文件 dashboard server bundle；
- `packages/dashboard-app/dist/`：同源 dashboard SPA 静态产物。
- `runtime/tenon-bootstrap.mjs`：不从 payload import 的稳定 dispatcher；它只选择已验证的本地 release，
  并保留精确的 `tenon runtime repair --rollback` 恢复能力。

其余所有 tsc 中间产物（例如 `packages/cli/dist/` 下的 `main.js`/`commands/`/`*.d.ts`）仍被 `.gitignore` 忽略，不入库。

`tools/reconcile-spec-application.mjs`、`tools/spec-migration-cas.mjs` 与其 POSIX helper 是本仓
历史规格修复的 release-maintenance 工具，不是插件用户运行时，也不进入 managed release
`PAYLOAD_ENTRIES`。打包 Skill 和稳定 launcher 不得引用它们；历史迁移必须在发布前由仓库 CI/维护者
完成并提交 typed result，安装后的 Ship 只用 bundle 内的 `spec-migration-applied` guard 验证证据。
因此普通 Codex/Claude/Windows 用户无需 C 编译器，也不会在项目目录寻找本仓 `tools/`。

## 为什么要入库

Codex 与 Claude 的原生插件都通过 marketplace clone 整仓落地，**装完即用、没有 build 步**。新用户
本机没有仓库的 `node_modules`，因此不能把 dashboard 留成待编译源码。安装期会把 marketplace checkout
作为候选输入，完整校验后复制到本机 managed runtime 的不可变 release；host manifest 只调用稳定的
`tenon-hook` ABI，bootstrap 再把已选 payload 注入为 `PLUGIN_ROOT` 并执行 CLI/hook。`tenon dashboard`
直接执行随 release 打包的 server bundle，server 再同源托管随包 SPA。

若任一产物不随 clone 带上，hooks 会断，或 dashboard 会退化为无法启动/无页面。`tools/verify-skills.sh`
会把三组资产都作为安装期硬校验项；校验失败不得切换 launcher。

### Skill provenance candidate gate

`templates/skill-sources.yaml` travels with the candidate as the
machine-verifiable provenance source for Tenon-owned Skills, and
`skills/skills.lock.json` does the same for the upstream Skills that setup and
update fetch into the host plugin root before candidate verification. The
candidate's `skills/` therefore carries both the tracked `skills/tenon*` trees
and the fetched upstream trees, and `copyReleasePayload` moves the same bytes
into the managed payload. The stable-tag proof compares only the tracked
`skills/*` children (`git ls-tree --name-only HEAD skills/`), because fetched
content is not in the tag; `.gitignore` keeps it out of the marketplace
clean-worktree check. It is schema v3 with
`hash_algorithm: tree-sha256-v1`; every bundled entry carries a normalized
`source_ref`, a `sha256:` digest produced by `buildCanonicalManifest()`, and an
immutable coordinate containing that same identity and digest. Candidate
verification runs the packaged hidden command
`internal-skill-provenance verify --root <candidate>` through
`tools/verify-skills.sh` before changing active/previous selection or launchers.
Missing/extra/undeclared Skills, content drift, unsupported/legacy registries,
and a reintroduced `skills-lock.json` are actionable failures and leave the
active release untouched.

When authoring a release, change Skill bytes first, run
`npm run sync:skill-provenance`, inspect the registry diff, then run the quiet
verification command. Runtime verification is read-only; only the explicit
`internal-skill-provenance sync` operation writes the registry, using a
same-directory temporary file and atomic rename. A stored N-1 release remains
a rollback target under its own immutable verifier and payload digest; the
current v3 verifier is not taught to rewrite or synthesize provenance for an
older payload.

## .gitignore 机制（为什么需要显式放行）

`.gitignore` 第 2 行 `dist/` 会忽略任意层级名为 `dist` 的目录。git 的规则是：**父目录被忽略后就不再下探**，因此单独写 `!packages/cli/dist/tenon.mjs` 一行**不生效**（已 `git check-ignore` 实测确认仍被忽略）。要放行目录内某一个文件，须三行缺一不可：

```gitignore
!packages/cli/dist/          # 先放行该目录本身，让 git 重新下探
packages/cli/dist/*          # 再把目录内全部内容重新忽略
!packages/cli/dist/tenon.mjs   # 最后单独放行这一个 bundle
```

同样的“先放行目录、再精确放行资产”规则适用于 dashboard server；SPA 的整个 `dashboard-app/dist/`
是同一份运行时产物，必须完整入库（含哈希资产）。验证：`git check-ignore packages/cli/dist/tenon.mjs`
和 `git check-ignore packages/server/dist/dashboard.mjs` 应均无输出。

## 维护纪律（重要）

**改了 CLI、server 或 dashboard 前端源码后，必须 `npm run build` 重新构建，并把三组更新后的发布资产一并提交。** 否则入库的包会与源码脱节（stale dist），装插件的人会运行旧行为或缺失完整 dashboard。

提交 bundle 时逐文件 add：

```bash
npm run build
git add packages/cli/dist/tenon.mjs
git add packages/server/dist/dashboard.mjs packages/dashboard-app/dist
```

## 单插件发布与自动更新

发布物是一个 `tenon` 插件，不拆分为外部 OpenSpec、Superpowers 或 skill 安装包。每次发版必须
让下面四份清单保持同一个插件 identity（拥有 `version` 字段的两份 plugin manifest 还必须同版），并且
继续指向仓根的同一套 `skills/` 与 `hooks/`：

- `.codex-plugin/plugin.json`
- `.agents/plugins/marketplace.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

默认 workflow 的每个 Tenon 自有 skill 都必须在 `templates/skill-sources.yaml` 里标为
`tool: bundled`，并有对应的 `skills/<name>/SKILL.md`；第三方 skill 必须在 `skills/sources.yaml`
声明上游来源，由 setup/update 获取并记进 `skills/skills.lock.json`。禁止把新的默认步骤改回 npm、
第三方 marketplace 或某个开发者本机 cache；可选集成只能作为非阻断增强项。

用户侧入口固定为 `tenon setup --codex` 或 `tenon setup --claude`。升级时：

```bash
tenon update --codex
# 或启用每日一次的 SessionStart 自动检查：
tenon setup --codex --auto-update
```

更新实现先让宿主刷新 marketplace/插件，再用宿主 `plugin list --json` 返回的安装根运行资产校验。
宿主插件缓存与 Tenon managed runtime 是两个明确边界：Codex/Claude CLI 是宿主登记/cache 的唯一
writer，Tenon 不读取、复制或恢复其私有缓存；只有候选校验通过，Tenon 才通过唯一
`release-coordinator` stage → 完整验证 → 原子切换 managed release。

稳定 `~/.local/bin/tenon` / `tenon-hook` 在写入前捕获存在性、字节与 mode，失败时只在当前内容仍属于
本次事务时做 CAS 精确补偿。Dashboard readiness 属于同一 managed transaction：失败先终止候选 child，
恢复 activation 前 selection/launcher，再从 previous immutable payload 恢复唯一 18765 服务。审计必须
分别报告 `host=in-progress|committed` 与 `managed=unchanged|restored|indeterminate`，不得把 managed
补偿描述成“宿主插件已整体回滚”。

selection、audit、bootstrap slot 都放在平台标准 runtime 目录，且仅保留 active/previous 为恢复候选。
kernel 的 `resolveProductPaths` 是产品机器路径的唯一真相源：项目注册表与凭证位于 config root，
Dashboard token/pid 与 selection/audit 位于 state root；`~/.claude`、`~/.codex` 仅用于发现对应
宿主资产，Tenon 不在其中保存自己的状态。`TENON_RUNTIME_HOME` 是完整产品域唯一允许的显式隔离覆盖。
稳定 launcher 把已解析 root 元组编码为版本化 `TENON_RUNTIME_ROOTS`，bootstrap 和当前 CLI 只消费
该契约，不各自重算平台路径；单 root 变量仅作为 shell hook 与冻结 N−1 bootstrap 的只读输出投影。
`tenon runtime repair --rollback` 会再次校验 previous release digest 后才切换，绝不把任意 marketplace
checkout 当作恢复源。自动更新是用户 opt-in，当前会话不热替换 skills/hooks，新会话才加载新版本。
每次成功 setup 会从刚发布的不可变 payload 启动受管 dashboard，健康检查通过后自动打开本机页面；
后台自动更新只刷新同一受管服务，不会主动打开浏览器。项目工作区永远在更新事务外；update 只读扫描
注册表并显示显式 `tenon sync`。

Codex 的第三方 hook 必须由用户在 `/hooks` 完成一次性信任；新发布物改变 hook hash 时，宿主可能要求
重新信任，不能用安装脚本绕过这一安全边界。完整工作台固定通过 `tenon dashboard` 启动，默认端口
18765；其他端口需显式 `tenon dashboard --port <port>`。

可选 npx 包固定下载自身 release tag 对应的 `install.sh`，并验证构建时内嵌的 SHA-256；该安装脚本
把 Marketplace 精确绑定到同一个不可变 release tag，使 npx 与 Marketplace 消费同一发布身份。
后续 `tenon update` 会重新解析最新的正式稳定 Release，并以新的不可变 tag 完成重绑。

每次发布至少执行：

```bash
npm run generate:default-workflow
npm run build
bash tools/verify-skills.sh
bash tools/test-hooks.sh
bash tools/test-adapters.sh
npm run check:default-workflow-freshness
```

`bash tools/test-bundle.sh` 还必须用不依赖本机缓存的冻结 N-1 严格读取器读取当前 bundle 新建的
canonical Change。CI 另外读取 `tools/fixtures/n-minus-one-release.json`（`schemaVersion: 3`）：
`status: "pinned"` 时按固定 tag、commit 和 payload 闭集，通过 `tools/prepare-n-minus-one-release.sh`
重建完整上一发行版（CLI、templates、skills、hooks、adapters、server/SPA 与 bootstrap），校验 CLI
digest 后从该真实 payload 路径运行读取。当前版本不属于已退役的 1.0.0–1.1.5 版本线时，固定基线不得是
退役版本，并且必须是 checkout 中低于当前版本的最近非退役正式 tag，否则脚本失败。
`status: "none"` 只用于版本号重置后的首个发行版 v0.1.0：fixture 的 `release` 必须等于
`v<package.json version>`，脚本以退出码 78 输出 `N-1 skipped: <release> <reason>`；CI 与 release
candidate 只把 78 当作已声明的跳过，`test-bundle.sh` 打印 `[HONEST SKIP] bundle: 真实 N-1 兼容：<reason>`
（不计通过也不计失败）。`release` 与当前版本不同时脚本失败；从 v0.1.1 起 fixture 固定 v0.1.0。
开发机存在 managed `previousRelease` 时可再交叉验证，但不能代替 CI 的完整固定 payload。

`release.yml` 以 `gh release create --latest` 创建 Release：`tenon update` 与公开安装验收都解析
`releases/latest`，新发布的版本必须成为 Latest。release candidate 拒绝已退役的 1.0.0–1.1.5 版本号
（`tag vX uses a retired 1.x version number`），退役号永不复用；安装与更新的版本顺序把退役版本线
排在其他所有正式版本之下。

## CI 新鲜度门（2026-07-17 补）

`d34b5f7 → ef84644` 已经出现过一次 source/dist 脱节（source 改了行为，入库 bundle 没跟着重
build），W1 第二增量的 codex review 第 8 轮又真实撞见第二次——本轮多处 kernel/CLI/server 源码
改动，`packages/cli/dist/tenon.mjs` 全程没有随之重新构建，直到 review 明确点名才发现。已满足
本文此前"若未来 bundle stale 反复发生，再上一道 CI 门"的条件，`.github/workflows/ci.yml` 的
Build 步骤之后新增了完整 runtime 的逐字节比较：
`packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs` 与
`packages/dashboard-app/dist/` 都必须等于当前源码重新构建的结果。源码改了却忘记本地 `npm run build`
并一并提交，会在这里直接红，不再只靠本文纪律与人肉 review 兜底。`bash tools/test-bundle.sh` 仍然是
行为冒烟（能否真正 init/transition/history，以及发现随包 dashboard），不能替代这条新鲜度门——两者
验证的是不同的事，都保留。
