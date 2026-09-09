# 插件体系全链路排查 · 第 2 层：分发与安装生命周期层

- **审计日期**: 2026-09-08
- **仓库根**: `/Users/a1234/Documents/code-manager/projects/tenon-local`
- **范围**: `skillsRegistry` / `marketplaceManifest` / `cli/runtime/*` / `cli/commands/*`(安装生命周期) / `hostTargetDetection` / `hostTargetPlanProtocol` / `hooksConfig` / `install.sh` / `adapters/install.sh` / `docs/DIST-RELEASE.md` / `docs/research/2026-07-1*`
- **性质**: 只读审计取证；未修改本文件以外的任何文件

---

## 0. 一句话结论

**managed runtime 这一半（本机 release store / selection / launcher / WAL）做到了工业级的 CAS + write-ahead + 幂等收敛，是全仓最扎实的部分；但它两端的三段——(a) 宿主 marketplace 侧的 `remove → remove → add → install` 序列完全没有补偿、(b) adapter 侧的项目落盘是裸 `>` 重定向且零事务零收据、(c) skill 元数据有两套解析器与三处真源且服务端全 fail-open——把整层的实际健康度从 A 拉到 C+：升级路径存在"网络一抖就把用户宿主插件删干净且不会恢复"的 P0 窗口。**

---

## 1. 安装生命周期状态机（文字版）

### 1.1 native host（codex / claude）`tenon setup --<host>` / `update`

图例：`⟦⟧` = 非原子区间（崩溃/断网/kill 会留下不可自愈的中间态）；`[WAL]` = 有 write-ahead journal 保护。

```
                 ┌── 0. 无事务 ──┐
                 │ withManagedTransaction 取跨进程锁
                 │ installer.ts:400  withLock(paths.managedTransactionRoot)
                 ▼
 S0 no-journal ──create()──► S1 preparing-host                [WAL]
     │                          │
     │                          │ resolveStableTarget:
     │                          │   GitHub Releases API → tag → git ls-remote → bare fetch → cat-file
     │                          │   stable-release.ts:94-151（三重证明，OK）
     │                          ▼
     │             ┌────────────────────────────────────────────────┐
     │             │ ⟦A⟧ 宿主 mutation 序列（**无补偿**）           │
     │             │ native-plugin-candidate.ts:121 nativeUpdatePlan │
     │             │  A1 plugin remove   tenon@tenon                │
     │             │  A2 marketplace remove tenon                   │
     │             │  A3 marketplace add  …@vX.Y.Z   ← 网络         │
     │             │  A4 plugin install/add tenon@tenon             │
     │             │  A5 plugin list --json (inventory)             │
     │             │ 每步 observe-before-replay-v1 记 WAL           │
     │             │ managed-host-reconciliation.ts:84-152          │
     │             │ **A1/A2 成功后 A3 失败 → 抛错直接退出，        │
     │             │   没有任何 re-add；用户宿主里 tenon 消失**     │
     │             └────────────────────────────────────────────────┘
     │                          ▼
     └──────────────► S2 candidate-resolved                    [WAL]
                          │ candidateRoot = 宿主 inventory 报告的 cache 根
                          │ dashboardBefore / dashboardBeforeAbsent 冻结
                          ▼
                      S3 activating-runtime                    [WAL]
                          │ checkpointActivation()（selection + launcher 快照）
                          │
                          │ ⟦B⟧ stageAndActivate（release-store.ts:230-342）
                          │   B1 mkdir staging/release-<uuid>/payload
                          │   B2 copyReleasePayload（拒 symlink/非普通文件）
                          │   B3 verifyReleasePayload → **执行候选自带的
                          │      tools/verify-skills.sh + node <候选CLI> --help**
                          │   B4 hashReleasePayload（v2 framed sha256）
                          │   B5 二次 inspectCandidatePayload 防 staging 后漂移
                          │   B6 rename(stage → releases/<id>)   ← 原子
                          │   B7 audit "activation-prepared"     ← WAL
                          │   B8 installBootstrap: previous.mjs ← active.mjs,
                          │      再 active.mjs ← payload bootstrap
                          │      **B8 内部两次 atomicWriteFile 之间非原子**
                          │      release-store.ts:412-427
                          │   B9 atomicWriteFile(selection.json)  ← 提交点
                          │   B10 audit "activated"（失败 → auditPending）
                          │   B11 prune（best-effort，失败被吞）
                          │
                          │ ⟦C⟧ writeStableLaunchers(~/.local/bin/tenon,
                          │      ~/.local/bin/tenon-hook)
                          │   installer.ts:65-90：失败 → revertActivation(selection)
                          │   → restoreStableLaunchers；两级回滚任一失败 →
                          │     ManagedRuntimeIndeterminateError
                          ▼
                      S4 runtime-activated                      [WAL]
                          │
                          ▼
                      S5 starting-dashboard  ─(detached spawn)─► S6 dashboard-ready
                          │ ⟦D⟧ spawn 前写 WAL，spawn 后端口可能延迟出现；
                          │     空端口不能证明子进程不会晚到（legacy 注释明确承认）
                          ▼
                      S7 evidence-committed                     [WAL]
                          │ commitReadyEvidence → recordPendingHostPluginConflict
                          │ 写 host-plugin-convergence receipt v4
                          ▼
                      journal.clear() ──► S8 ready ✅

  失败分支：
  S5/S6 失败 → S9 stopping-candidate → S10 reverting-activation
             → S11 restoring-previous → S12 previous-restored → 补偿完成
  A 段失败      → 直接抛 Indeterminate，**不进入补偿链**，WAL 留 preparing-host
  B 段失败      → journal 重置回 preparing-host（release-coordinator.ts:212-228）
  C 段失败      → selection + launcher 双回滚，或 Indeterminate
```

### 1.2 adapter host（cursor / gemini / …）`tenon setup --cursor --target <dir>`

```
S0 ─► verifyPackagedAssets(root)
   ─► publishSetupManagedRuntime（复用上面 S1..S8，source='adapter'，无 stableTarget）
   ─► ⟦E⟧ bash adapters/install.sh --cursor --target <dir> --yes
          setupHost.ts:270-277
          │ adapters/install.sh:83  bash "$REPO_ROOT/$conf" --target ...
          │   ├─ mkdir -p .cursor/rules
          │   ├─ cat > .cursor/rules/pipeline.md          ← 裸截断写
          │   └─ sed … > .cursor/hooks.json               ← 裸截断写
          │      adapters/cursor/install.sh:38, 67
          └─ **无 tmp+rename、无 receipt、无回滚、无 lock**
   ─► configureAutoUpdate
```

`⟦E⟧` 整段是**零事务区**：没有 WAL、没有 checkpoint、没有幂等收据。中途被 kill → `.cursor/hooks.json` 是被截断的半个 JSON。

### 1.3 Dashboard 触发的 adapter 安装

```
POST /api/adapters/install {root, hosts[], confirm:true}
  → AdapterInstallManager.run（adapterInstall.ts:90-118）
  → 串行 for host of hosts:
       queued → preflight(`tenon setup --<h> --dry-run`)
              → installing(`tenon setup --<h>`)
              → verifying   ← **空相位，什么都没做**
              → installed   ← 仅凭 exitCode===0
    单 host 失败 `continue`，不影响后续 host，也不撤销已完成 host
```

---

## 2. 逐问答复

### Q1 · manifest 版本协商

**结论：仓里同时存在 8 套独立的版本号语义，其中最关键的插件 manifest 本身根本没有 schema 版本字段；升级方向 fail-closed，降级方向直接把老版本 CLI 打死。**

| manifest | 版本字段 | 未知版本行为 | 未知字段行为 | 证据 |
|---|---|---|---|---|
| `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` | **无 schema version**，只有产品 SemVer `version` | 不适用 | **静默忽略**（fail-open） | `plugin-manifest-version.ts:7-24` 只取 `version` 字段 |
| `release.json`（managed release） | `version: 1 \| 2` | **fail-closed**：`version !== 2 → return null` | **fail-closed**：`Object.keys().sort().join(',')` 精确等值 | `release-store-codecs.ts:119-134` |
| `selection.json` | `version: 1` | fail-closed | **fail-open**（无 exactKeys） | `release-store-codecs.ts:145-161` |
| `audit.jsonl` 行 | `version: 1` | 整个日志判 `auditCorrupt` | fail-open | `release-store-codecs.ts:163-190, 220-240` |
| `release-transaction.json`（WAL） | `version: 1` | fail-closed | **fail-closed** `exactKeys()` | `managed-release-journal.ts:26-29` |
| `host-plugin-convergence/<host>.json` | `version: 2\|3\|4`，**自动升格为 4** | **fail-closed → 且致命** | **fail-open**：`{...receipt}` 原样透传未知字段 | `host-plugin-convergence-receipt.ts:77, 102-112` |
| `templates/skill-sources.yaml` | `version: 3` + `hash_algorithm` | 严格解析器 fail-closed；**宽松解析器完全不读 version** | 严格 fail-closed / 宽松 fail-open | `source-registry.ts:290+` vs `:197-220` |
| `.pipeline/hooks.json` | `version: 1` | fail-open 成空矩阵 | fail-open | `hooksConfig.ts:114, 196-219` |
| host-target-plan / host-target-detection | `schema_version: '…/v1'` 字符串 | fail-closed | fail-closed `hasExactKeys` | `hostTargetPlanProtocol.ts:224-240, 254-288` |

**向前兼容的破绽（具体三处）：**

1. **plugin manifest 无 schema 版本**（`plugin-manifest-version.ts:19-22`）。将来若要在 `.codex-plugin/plugin.json` 引入不兼容结构（例如 `skills` 从字符串变数组），旧 CLI 会照常解析出 `version` 并继续安装，直到运行期才炸。当前只靠 `verify-skills.sh:96, 112-115` 的 **grep 字面量** `'"skills"[[:space:]]*:[[:space:]]*"\./skills/"'` 兜底——这是文本匹配不是 schema 校验。
2. **降级 = 砖头**。convergence receipt 只接受 `2/3/4`（`host-plugin-convergence-receipt.ts:77`）。若用户装过写 v5 receipt 的将来版本再回退到今天的版本，`readHostPluginConvergenceReceipt` 返回 `invalid`，`setupHost.ts:129-132` 直接 `return 1` 且提示只有「迁移 receipt 非法：<path>」——**没有告诉用户可以删这个文件**。同理 `release.json` v3 会让 `validateStoredRelease` 返回 null → `activeValid=false` → 整个 managed runtime 判为不可用。
3. **一份 YAML 两个解析器**。`parseSkillSources`（宽松，`source-registry.ts:197`）压根不读 `version:` 与 `hash_algorithm:`，把 v3 registry 当 v1 读；`parseSkillProvenanceRegistry`（严格，`:290`）才校验。服务端 `skillsRegistry.ts:206-212` 用的是宽松那个，且解析异常时 `catch → return new Map()`——**registry 版本升级到 v4 后，Dashboard 的技能页会静默变成"零技能"，而不是报错**。

---

### Q2 · 安装事务性

**一次 native setup/update 涉及的全部写操作（按时序）：**

| # | 写目标 | 原子性 | 证据 |
|---|---|---|---|
| 1 | `~/.tenon/state/managed/release-transaction.json`（WAL） | ✅ `atomicWriteFile` | `managed-release-journal.ts` |
| 2 | **宿主私有 cache**：`~/.codex/plugins/…` 或 `~/.claude/plugins/…`（remove ×2 + add ×2） | ❌ **完全非原子、无补偿** | `native-plugin-candidate.ts:121-173` |
| 3 | `~/.tenon/data/staging/release-<uuid>/` | 临时目录，finally `rm -rf` | `release-store.ts:236, 339-341` |
| 4 | `~/.tenon/data/releases/<id>/`（rename 发布） | ✅ rename | `release-store.ts:284` |
| 5 | `~/.tenon/state/audit.jsonl`（append） | append-only，非事务 | `release-store-codecs.ts:246-248` |
| 6 | `~/.tenon/data/bootstrap/previous.mjs` 然后 `active.mjs` | ❌ **两次独立 atomicWriteFile** | `release-store.ts:418-426` |
| 7 | `~/.tenon/state/selection.json` | ✅ atomicWriteFile（提交点） | `release-store.ts:310` |
| 8 | `~/.local/bin/tenon` + `~/.local/bin/tenon-hook` | ✅ 单文件 O_EXCL+hardlink+CAS；❌ **两个文件之间非原子** | `launchers.ts:357-405` |
| 9 | Dashboard 子进程（detached spawn） | ❌ 副作用不可回滚 | `release-dashboard-coordinator.ts` |
| 10 | `~/.tenon/state/migrations/host-plugin-convergence/<host>.json`（receipt） | ✅ `writeTextAtomic` | `host-plugin-convergence-receipt.ts:166` |
| 11 | adapter：`<project>/.cursor/hooks.json`、`.cursor/rules/pipeline.md` 等 | ❌ **裸 `>` 截断写** | `adapters/cursor/install.sh:38,67`；`adapters/codex/install.sh:243,246,276` |

**列出的非原子写序列（4 个）：**

- **NA-1（P0）** `plugin remove` → `marketplace remove` → `marketplace add`(网络) → `plugin install`。前两步破坏性、后两步依赖网络，中间无任何回滚。
- **NA-2（P1）** `previous.mjs ← active.mjs` 与 `active.mjs ← payload` 之间。崩在中间 → `previous.mjs` 已是新版本的前一版，但 `active.mjs` 还是旧的；后续 rollback 会用到一个与 selection 不配对的 bootstrap。
- **NA-3（P1）** `~/.local/bin/tenon` 已换新、`~/.local/bin/tenon-hook` 尚未换。`launchers.ts` 有 `convergeStableLaunchers` 专门收敛这个"byte-proven old/new partial pair"，说明作者知道这个窗口存在；但在收敛跑起来之前，hook 与 CLI 是跨版本的。
- **NA-4（P0，adapter）** `.cursor/hooks.json` 的 `sed … > "$hj"`。

**中途失败后的系统状态：**

| 失败时刻 | 磁盘满 | 进程被 kill | 权限拒绝 |
|---|---|---|---|
| A1/A2 之后、A3 之前 | — | **宿主里没有 tenon；WAL 停在 preparing-host；重跑 setup 才可能恢复；离线则永久失效** | 同左 |
| B2 复制 payload | staging 半成品 → finally 清理，selection 未动，**安全** | 同左 | 同左 |
| B8 与 B9 之间 | active.mjs 是新 payload，selection 还是旧 release → **bootstrap 与 selection 版本错配** | 同左 | 同左 |
| B9 之后 C 之前 | selection 已切、launcher 还旧 → installer.ts:65-90 双回滚 | kill 则回滚不执行，靠下次 `recoverActivation` | revert 也失败 → `Indeterminate`，人工介入 |
| ⟦E⟧ adapter 写文件 | **半个 JSON 落盘，无备份、无 receipt、无检测** | 同左 | `>` 直接报错退出，`adapters/install.sh` 只 `rc=1`，前面已改的平台不撤销 |

**回滚 / 幂等收敛机制盘点：**
- ✅ managed runtime 侧齐全：`checkpointActivation` / `recoverActivation` / `revertActivation` / `proveActivation`（`installer-contract.ts:16-27`）、selection CAS（`installer.ts:104-122`）、launcher hardlink CAS（`launchers.ts:290-317`）、`observe-before-replay-v1`（`managed-host-reconciliation.ts:38-48`）、`runtime-rollback.json` + bootstrap 侧 `tenon runtime repair --rollback`（`runtime/tenon-bootstrap.mjs:820-910`）。
- ❌ 宿主 marketplace 侧：**零**。`setup-managed-runtime.ts:114-119` 明文写着"Tenon 不直接覆盖或回滚宿主私有缓存，仅补偿自己的 managed transaction"。
- ❌ adapter 项目落盘侧：**零**。

---

### Q3 · convergence 语义

`host-plugin-convergence` **不是**"插件是否装好"的通用收敛器，它的范围窄得多：**只负责在证明新 Tenon 可用之后，删除旧的 legacy 工作流插件登记**（`LEGACY_PLUGIN_IDENTITY`）。

**收敛判据（`finalizePendingHostPluginConflictWithinTransaction`，`host-plugin-convergence.ts:167-281`）——七道闸：**

1. `installer.inspect()` 的 `activeValid && selection.activeRelease === receipt.releaseId && active.releaseId === receipt.releaseId`（:174-184）
2. session proof 文件存在且 `host/releaseId/releaseRoot` 全等，且 `loadedAtEpoch > receipt.createdAtEpoch`（:186-196）——即"必须有一次**新的**宿主会话真的加载过这个 release"
3. 现场跑 `plugin list --json` 拿权威 inventory；解析失败即 fail（:198-206）
4. `before.enabledIds.has(TENON_PLUGIN_IDENTITY)`（:207-209）
5. `before.tenonRoot === receipt.candidateRoot && before.tenonVersion === receipt.stableTarget.version`（:210-217）
6. 冲突 scope 集合不得比 receipt 记录的更宽（:221-223）；`managed` scope 一律拒绝自动清理（:226-228）；Tenon 必须已在同 scope 启用才允许删该 scope 的旧插件（:229-234）
7. 每删一个 scope 立即重读 inventory 复证并把剩余 scope 写回 receipt（:246-263）；全部结束后再读一次 inventory 复证唯一性（:267-280）

`recoverPendingHostConvergence`（`host-convergence-recovery.ts:120-197`）在 cleanup 前后**各跑一次** `proveConvergenceIdentity`，后者还额外证明：stable tag commit 未漂移、`nativeHostMatchesStableTarget`、宿主 plugin payload digest === active release digest、Dashboard 的 `releaseId`/`serverVersion` 与 active 一致（:33-86）。

**能否检测到用户手工改坏 hook 容器？——不能。**

- native hook 容器 = 宿主自己的 `hooks/hooks.json`（在宿主 cache 里）。收敛只看 `plugin list --json` 的 **id/root/version** 三元组（`parseHostPluginInventory`），不 hash cache 内容。
- 唯一的 payload 完整性证明发生在 **managed release 内部**：`validateStoredRelease` 每次 `inspect()` 都重算 `hashReleasePayload` 并重跑 `verifyReleasePayload`（`release-store.ts:394-410`）。也就是说 `~/.tenon/data/releases/<id>/payload` 被改会被抓到，但 `~/.codex/plugins/cache/tenon/tenon/<ver>/hooks/*.sh` 被改**不会**——只有在下一次 setup/update 走 `revalidateNativeStableCandidate → verifyPackagedAssets` 时才顺带查一次（`native-candidate-revalidation.ts:70`），而那已经是安装动作而非漂移检测。
- 用户手改 `~/.local/bin/tenon-hook`：`launchers.ts` 的 CAS 会在**下一次 setup** 拒绝覆盖（"launcher 在证明后被外部修改，拒绝覆盖"，:381），但平时没有任何后台检测。
- 用户手改项目 `.pipeline/hooks.json`：`hooksConfig.ts:12-13` 明文 fail-open —— "手改格式漂移/损坏 JSON：sh 侧匹配不中 → fail-open 启用"。
- 用户手改 adapter 落盘的 `.cursor/hooks.json`：唯一判据是 `grep -q "pipeline 适配器 hook 注册"`（`adapters/cursor/install.sh:63`）。**把那行注释删掉，重装就会静默覆盖用户文件；反过来把恶意 hook 写进去但保留那行注释，重装也会覆盖——但期间无人报警。**

**漂移检测的四个盲区：**

| 盲区 | 后果 |
|---|---|
| 宿主 plugin cache 内容（非 managed payload） | 篡改 cache 里的 hook 脚本不会被发现；但因为 `verify-skills.sh:185-187` 强制 host hook 只能调 `~/.local/bin/tenon-hook`，实际执行走 managed release，危害被架构限住——**前提是攻击者不同时改 hooks.json** |
| `~/.local/bin/tenon-hook` 被删 | 无检测；宿主 hook 静默失效（宿主侧只看到命令找不到），用户看不到任何 Tenon 报错 |
| 项目 `.pipeline/hooks.json` 损坏 | fail-open：全部 hook 视为启用（`hooksConfig.ts:189-198`）——这个方向安全，但反过来 UI 会显示与实际不符的开关状态 |
| adapter 产物漂移 | 完全无检测，无 receipt，`tenon doctor` 也不查 |

---

### Q4 · skillsRegistry 与 marketplaceManifest 的职责边界

**先说一个硬事实：`packages/server/src/marketplaceManifest.ts` 不存在。** 只有 `marketplaceManifest.test.ts`（`ls packages/server/src | grep marketplace`）。这个"模块"是一个纯断言文件，直接 `readFileSync` 仓根四份 JSON 做等值检查，不 import 任何源码（文件头注释自陈：「纯解析单测（不 import 任何包源码，只用 fs 读两份仓根清单）」）。

因此二者**没有代码级重叠**——但存在**真源级重叠**：

- `marketplaceManifest.test.ts` 断言 `.claude-plugin/marketplace.json` 的 name/source/description/owner/version 必须等于 `.claude-plugin/plugin.json`（:88-104），并断言 Codex/Claude 两份 plugin.json 版本一致（:130-137）。
- 但**同一组事实**在 `tools/verify-skills.sh:91-124` 用 grep 又校验了一遍（弱版本：只查字段存在，不查跨文件等值），在 `plugin-manifest-version.ts:31-42` 用 JSON 解析又校验了一遍（只查两份 plugin.json 的 version 相等）。
- 三处判据强度不一：test 最严（CI 才跑）、`decodePluginManifestVersion` 中等（安装期跑）、`verify-skills.sh` 最弱（安装期跑）。**安装期没有任何一处校验 marketplace.json ↔ plugin.json 的 name/description 一致性**——CI 的强断言在用户机器上不复现。

**同一个 skill 的元数据在几处定义 → 见 §4 真源重叠表。**

`skillsRegistry.ts` 的定位问题：它是 **Dashboard 展示层**的技能清单器，与 CLI 的 provenance 门是两套独立世界观：

| | `skillsRegistry.ts`（server） | `skill-provenance-locator.ts`（cli） |
|---|---|---|
| 读同一份 `templates/skill-sources.yaml` | ✅ 用 `parseSkillSources`（宽松） | ✅ 用 `parseSkillProvenanceRegistry`（严格 v3） |
| registry 版本校验 | ❌ 完全不读 `version:` | ✅ |
| content hash 校验 | ❌ | ✅ `content-hash-mismatch`（:221-227） |
| coordinate 校验 | ❌ | ✅（:228-234） |
| 解析失败行为 | **catch → 空 Map**（:206-212），页面变空 | throw `SkillProvenanceLocatorError` |
| 额外真源 | `skills/EXTERNAL-SKILLS.md` 的 `- name` 行 + `BUILTIN_SKILLS` 硬编码 4 个（:27）+ 宿主 `installed_plugins.json` + `~/.agents/skills` + `~/.codex/plugins/cache` | 只有 `skills/` + registry |

**结论：Dashboard 可以显示「installed: true」的 skill，正好是 provenance 门会拒绝的那一个。** 两者对"已安装"的定义不共享任何代码。

---

### Q5 · 信任与来源校验

**做了什么（诚实清单）：**

| 校验 | 强度 | 证据 |
|---|---|---|
| Release tag → commit 三重证明（Releases API schema 精确等值 + `html_url` 归属官方仓 + `git ls-remote` 双 ref + 独立 bare clone `cat-file -t` + 与 advertised commit 比对） | **强**，这是全仓最好的一段 | `stable-release.ts:68-151` |
| 冻结 tag 在 activation 前后各复证一次 | 强 | `native-candidate-revalidation.ts:37-73`（前后两次 `nativeHostMatchesStableTarget`） |
| candidate payload digest（framed sha256，含目录 mode） | 强 | `release-payload.ts:135-164` |
| staging 后再 hash 一次防漂移 | 强 | `release-store.ts:245-256` |
| 拒绝 symlink / 非普通文件 / 路径越界 | 强 | `release-payload.ts:20-45` |
| Bash/Node 可执行文件的物理身份证明（dev/ino/mode/uid/size + sha256 + 父目录链），每次 spawn 前重放 | 强 | `types.ts:11-27`；`release-store.ts:83-102` |
| bundled skill 的 tree-sha256 + coordinate | 强（**仅在 provenance verifier 路径**） | `skill-provenance-locator.ts:212-234` |
| **签名 / GPG / sigstore / provenance attestation** | **完全没有** | 全仓无相关代码 |

**`codexSkillTrust` 实际强度：三条信任根，强度差三个数量级。**

| 信任根 | 判据 | 强度 |
|---|---|---|
| `activeReleaseRoot`（`codexSkillTrust.ts:96-128`） | 路径必须是 `<dataRoot>/releases/sha256-<64hex>/payload`，且 `selection.json.activeRelease` 与 `release.json.releaseId` 双向对上，且与执行中的 CLI 是同一物理目录 | **强** |
| `directDevelopmentRoot`（:130-158） | 只要 `$PLUGIN_ROOT` 指向的目录里有 `.codex-plugin/plugin.json`（name==='tenon'）、`hooks/codex-skill-receipt.sh`、`packages/cli/dist/tenon.mjs` 三个普通文件即可 | **弱**：三个文件都可伪造。护栏只有 `samePhysicalDirectory(executingPluginRoot, logical)`——但攻击者若已能让你跑他的 `tenon.mjs`，这条本就失守 |
| `selectedCacheRoot`（:78-94） | `$TENON_CODEX_PLUGIN_ROOT` / `$TENON_HOST_PLUGIN_ROOT` 必须恰好是 `~/.codex/plugins/cache/tenon/tenon/<一级>`，且路径链全是普通目录 | **中弱**：**不校验版本、不校验 digest、不与 selection 对账**。cache 里任何一个残留/旧/被投毒的版本目录都能被环境变量指定为信任根 |

**可以被绕过的路径（三条）：**

1. **B3 自证（P0 类）**：`verifyReleasePayload`（`release-payload.ts:276-308`）"验证"候选的方式是 **`bash <候选>/tools/verify-skills.sh`** 和 **`node <候选>/packages/cli/dist/tenon.mjs --help`**。`verify-skills.sh:310-321` 又转身调用 `"$NODE_BIN" "$ROOT/packages/cli/dist/tenon.mjs" internal-skill-provenance verify --root "$ROOT"`。**这是候选自己验自己**：任何能控制 candidateRoot 内容的人，在"验证"阶段就已经拿到了用户权限下的任意代码执行。当前唯一的外部信任锚是 §Q5 第一行那套 tag→commit 证明——也就是说**整层安全性 100% 依赖 GitHub tag 不被移动 + 宿主 CLI 的 clone 忠实**，本地校验一步都不独立。
2. **`$TENON_HOST_PLUGIN_ROOT` 环境变量**（`codexSkillTrust.ts:43-44`）：指向 cache 下任一版本目录即可让 hook 从旧/投毒版本读 `SKILL.md`，无 digest 对账。
3. **`$TENON_REGISTRY` 环境变量**（`adapters/install.sh:15`）+ `bash "$REPO_ROOT/$conf"`（:83）：`conf` 来自 registry 的 `configure` 字段，只做 `[ -f "$REPO_ROOT/$conf" ]` 存在性检查，**不做路径规范化、不禁 `../`**。构造 `configure: ../../../../tmp/evil.sh` 即可让 adapters/install.sh 执行任意脚本。

`skill-provenance-locator` 本身很硬（realpath 逃逸检查、`isPathSafeSkillId`、tree hash、coordinate 双证），**但它的输入 registry 与被验内容来自同一个候选目录**——同样是自证，只能防"发布者手滑"，不能防"发布源被替换"。

---

### Q6 · 版本生命周期

**多版本共存**：`releasesRoot` 下按 `sha256-<hex>` 目录并存；`selection.json` 只有 `activeRelease` / `previousRelease` 两格。保留策略 `retainedReleases = max(2, opts ?? 3)`，prune 按 mtime 降序保留 `retained - protected` 个（`release-store.ts:103, 429-453`）。**prune 失败被静默吞掉**（`:322` `.catch(() => {})`），磁盘满时会无声堆积。

**回滚**：两条独立实现。
- CLI 侧 `rollbackToPrevious`（`release-store.ts:144-202`）：只换 selection，**明确不回退 bootstrap**——注释 `:164-165`「Rollback changes only the verified selection. The active bootstrap is the current backward-compatible security boundary and must never be downgraded to payload bytes.」这是个刻意的单向棘轮：**bootstrap 只升不降**。
- bootstrap 侧 `tenon runtime repair --rollback`（`runtime/tenon-bootstrap.mjs:820-910`）：带 `runtime-rollback.json` durable journal、launcher private checkpoint、第三方 checkpoint 拒绝。

**⚠️ bootstrap 是 `release-store-codecs.ts` + `release-payload.ts` 的第二份手写实现**（`tenon-bootstrap.mjs:156-160` parseSelection、`:194-198` stableTarget、`:205-215` releaseId 计算、`:228-247` parseManifest、`:264` hashPayload、`:284-322` 两套 payload visit）。两份实现必须逐字节等价，**没有任何测试或工具强制它们同步**。加一个 manifest v3 而忘了改 bootstrap，结果是 launcher 拒绝分发已经激活的 release。

**legacy 退役 —— `release-legacy-setup-retirement.ts` 的判据安全吗？**

`isExactLegacyV101NativeJournal`（:30-89）用**指纹式否定列表**识别 v1.0.1 WAL：要求 `stableTarget/dashboardPort/candidateOpenBrowser/dashboardBeforeAbsent/dashboardBeforeRetiring/compensationReason/dashboardRestored` **全部 undefined**，`dashboardBefore.serverVersion === ''`，phase 在白名单内，且 `activation.release.version === 1` 且 `pluginVersion === '1.0.1'`（或 update 场景等于 `expectedPluginVersion`）。

**判据总体安全，三条理由：**
1. 退役不是"删掉旧状态"，而是先 `resolveStableTargetBeforeRecovery()` + `proveFrozenTarget()` 证明后继 tag，再 `proveLegacyActivation` 从当前 selection/launcher 精确证明旧 activation，再 `proveLegacyDashboardBoundary` 证明端口无第三方，**全部通过后才**把同一 `transactionId` 原子改写为新的 `preparing-host`（:170-201）。
2. `stopping-candidate/reverting-activation/restoring-previous/previous-restored` 四个补偿相位被显式拒绝（:162-169），不猜测。
3. 任何异常一律包成 `ManagedRuntimeIndeterminateError`（:202-208），不降级为"当作没事发生"。

**但有一个逃逸口（P2）**：`:74-78` 允许 `journal.operation === 'update'` 且 `pluginVersion === request.expectedPluginVersion`。`expectedPluginVersion` 来自 `deps.pluginVersion ?? TENON_RELEASE_VERSION`（`setup-managed-runtime.ts:58`），即**当前版本**。于是一个 phase 合法、字段恰好全空的**当前版本 update WAL** 也会被判定为"v1.0.1 legacy"并被 retire 掉（重置为 preparing-host）。构造条件苛刻（要求 `dashboardPort`/`stableTarget` 都缺失，而现行代码总会写 `stableTarget`），实际难触发，但这条判据不是"v1.0.1"的充分条件，名不副实。

---

### Q7 · 错误面

**好的部分：** managed runtime 内部的错误几乎全部是"能自我诊断"的。例：
- `release-store.ts:149`「没有可回滚的已验证 runtime release；**请重新运行 tenon setup --<host>**」
- `tenon-bootstrap.mjs:988`「[runtime] 修复：**tenon runtime repair --rollback**；或 tenon setup --codex / --claude。」
- `tenon-bootstrap.mjs:1016, 1040` 都带下一步动作
- `verify-skills.sh:360-368` 三段式「缺什么 / 在哪引用 / 怎么修」，是全仓错误面的样板

**不足的部分（按严重度）：**

1. **宿主步骤失败后不告诉用户"你现在没插件了"。** A1/A2 已删、A3 失败 → 用户看到的是 `ERROR: managed runtime 事务状态无法证明：host step 'marketplace-register' 执行后未证明 desired postcondition`，加上 `setup-managed-runtime.ts:114-119` 那段抽象声明。**没有一句话说明"你的 codex 里现在没有 tenon 了，网络恢复后重跑 tenon setup --codex 即可恢复"**，也没有给出手动 `codex plugin marketplace add jefferysha/tenon --ref vX.Y.Z` 的救急命令。
2. **Dashboard adapter 安装只回一个退出码。** `adapterInstall.ts:98, 110`：`${host} 预检失败` / `${host} 安装失败` + `exit_code`。**CLI 的 stdout/stderr 全部丢弃**——而 CLI 恰恰是唯一知道真实原因的一方。`runner` 返回的 `exitCode` 之外的字段没有被消费。
3. **`verifying` 相位是假的。** `adapterInstall.ts:112-113` 先 emit `verifying` 再立刻 emit `installed`，中间零动作。UI 会显示"正在验证安装产物"然后"已安装并通过 CLI 退出码验证"——**措辞本身就把退出码包装成了"验证"**。
4. **convergence receipt 非法 = 无出路。** `setupHost.ts:130`：`ERROR: 迁移 receipt 非法：<path>；未执行新的 marketplace/runtime 变更。` 用户拿到一个绝对路径但没被告知"删掉它就能继续"。
5. **skillsRegistry 的所有失败都是静默的。** `:206-212`、`:178-183`、`:199-200` 三处 `catch` 全部吞掉；registry 解析失败 → 页面零技能；`installed_plugins.json` 损坏 → 所有插件技能显示未安装。**用户看到的是"东西没了"而不是"读取失败"。**
6. **adapter 失败信息丢失。** `adapters/install.sh:83` `bash … || rc=1`，子脚本 stderr 直通终端但**不汇总**；多平台批量安装时哪个失败要自己翻屏。

---

## 3. 缺陷清单

### P0

---

**P0-1 · 宿主插件升级序列先删后加、无补偿：网络抖动即把用户的插件删干净**

- **证据**：`packages/cli/src/commands/native-plugin-candidate.ts:121`（setup 也走 `nativeUpdatePlan`）；`packages/cli/src/commands/plugin-host.ts:234-267`（计划 = remove plugin → remove marketplace → add marketplace → install → list）；`packages/cli/src/runtime/managed-host-reconciliation.ts:138-142`（postcondition 不满足直接 throw，无 undo）；`packages/cli/src/commands/setup-managed-runtime.ts:114-119`（明文放弃宿主侧补偿）
- **失败场景**：用户 v1.0.8 → v1.0.9。`verifiedInstalledNativePlugin` 因版本不匹配返回 null（`native-plugin-candidate.ts:82-87`）→ 进入 `nativeUpdatePlan`。A1 `codex plugin remove tenon@tenon` 成功、A2 `marketplace remove tenon` 成功、A3 `codex plugin marketplace add jefferysha/tenon --ref v1.0.9` 因为公司代理断线/GitHub 429/DNS 劫持失败 → `runStep` 抛 `ManagedRuntimeIndeterminateError`。**结果：`~/.codex` 里 tenon 插件与 marketplace 双双消失，managed runtime 仍是 v1.0.8 且 launcher 可用，但新开的 Codex 会话没有任何 Tenon hook 与 skill。用户离线时无法恢复。** 错误文案里没有一个字提示这件事。
- **修复方向**：(a) 把 A1/A2 改成"先 add 新 marketplace（不同名，如 `tenon-next`）→ install → 证明可用 → 才 remove 旧的"，即 blue-green 而非 destroy-first；(b) 若宿主 CLI 不支持并存，则在 A1 前把"当前 marketplace 源 + ref + plugin 版本"写进 WAL，A3/A4 失败时执行 `marketplace add <旧源@旧ref> && plugin add` 的显式补偿步骤；(c) 最低限度：失败文案必须打印"当前宿主已无 tenon 登记 + 恢复命令原文"。

---

**P0-2 · 候选校验是自证：`verifyReleasePayload` 执行候选自带的脚本与 CLI**

- **证据**：`packages/cli/src/runtime/release-payload.ts:291-307`（`bash <payload>/tools/verify-skills.sh` + `node <payload>/packages/cli/dist/tenon.mjs --help`）；`tools/verify-skills.sh:310-321`（再调候选自己的 CLI 做 provenance verify）；`packages/cli/src/runtime/release-store.ts:242`（在 selection 变更前调用）
- **失败场景**：任何能替换 candidateRoot 内容的途径——GitHub 账号被接管后移动 tag、宿主 CLI 的 clone 被中间人替换、用户被诱导 `TENON_HOST_PLUGIN_ROOT=/tmp/evil` 后跑 setup——都会在"资产校验"这一步以用户身份执行攻击者的 `tools/verify-skills.sh`（bash）与 `tenon.mjs`（node）。**"校验"本身就是执行入口，不是校验。**
- **修复方向**：(a) 把 payload 校验拆成两级：结构/哈希级校验由**已激活 release 的可信 CLI**（而非候选 CLI）执行；(b) 引入外部信任锚——release 资产的 sigstore/minisign 签名，公钥随 stable launcher 分发而非随 payload；(c) 短期止血：候选 CLI 的执行至少放进受限子进程（无网络、只读挂载），并在文档里显式声明"当前安全边界 = GitHub tag 不可变性"。

---

**P0-3 · adapter 项目落盘是裸截断写，无原子性、无备份、无收据**

- **证据**：`adapters/cursor/install.sh:38`（`cat > "$rdir/pipeline.md"`）、`:67`（`sed … > "$hj"`）；`adapters/codex/install.sh:246, 276`；`adapters/install.sh:11`（只有 `set -u`，**没有 `-e`/`-o pipefail`**）、`:83`（`bash … || rc=1`，失败继续下一平台）
- **失败场景**：用户在 Dashboard 点"安装 cursor adapter"，`sed` 写 `.cursor/hooks.json` 写到一半（磁盘配额满 / 用户 Ctrl-C / 编辑器持有锁）→ **`.cursor/hooks.json` 是被截断的非法 JSON**。Cursor 加载失败后按自身策略 fail-open，veto hook 静默失效——而 `adapters/registry.yaml` 里 cursor 的 `veto_failclosed: true` 是这个适配器的核心承诺。用户和 Tenon 双方都不知道防线已经没了。
- **修复方向**：(a) 所有 adapter 落盘统一走 `mktemp -p <同目录> && mv`（`adapters/codex/install.sh:85-98` 已经在 hooks 段这么做了，其他段没有——先内部统一）；(b) 每个 adapter 写一份 `.pipeline/adapter-receipt.json`（平台、adapter 版本、产物路径 + sha256、时间戳），让 `tenon doctor` 能做漂移检测；(c) 顶层 `adapters/install.sh` 加 `set -euo pipefail` 并在任一平台失败时汇总输出。

---

### P1

---

**P1-1 · `$TENON_REGISTRY` + 未规范化的 `configure` 路径 = 任意脚本执行**

- **证据**：`adapters/install.sh:15`（`REG="${TENON_REGISTRY:-…}"`）、`:76-83`（`conf="$(reg_field "$pid" configure)"`；只做 `[ -f "$REPO_ROOT/$conf" ]`；然后 `bash "$REPO_ROOT/$conf"`）
- **失败场景**：`TENON_REGISTRY=/tmp/x.yaml adapters/install.sh --cursor --target .`，其中 `/tmp/x.yaml` 声明 `configure: ../../../../tmp/pwn.sh`。存在性检查通过 → `bash /repo/../../../../tmp/pwn.sh --target . --yes`。在 CI runner 或共享机器上这是提权面。
- **修复方向**：`configure` 必须匹配 `^adapters/[a-z0-9-]+/install\.sh$`；`TENON_REGISTRY` 只在显式 `--registry` 参数下生效或干脆去掉（生产不需要）。

---

**P1-2 · `selectedCacheRoot` 信任 cache 里任意版本目录，不对账 digest/version**

- **证据**：`packages/cli/src/codexSkillTrust.ts:43-44`（读 `TENON_CODEX_PLUGIN_ROOT`/`TENON_HOST_PLUGIN_ROOT`）、`:78-94`（只校验"恰好在 `~/.codex/plugins/cache/tenon/tenon/` 下一级 + 目录链是普通目录"）。对比 `activeReleaseRoot`（`:96-128`）会验 selection.json + release.json 双向对账。
- **失败场景**：用户曾装过 v1.0.5，cache 里残留 `~/.codex/plugins/cache/tenon/tenon/1.0.5/`。任何进程设 `TENON_HOST_PLUGIN_ROOT=~/.codex/plugins/cache/tenon/tenon/1.0.5` 后触发 hook，`trustedCodexSkillPath` 会从旧版本读 `SKILL.md` 并当作可信内容注入模型上下文——**跨版本 skill 指令注入，无任何日志**。
- **修复方向**：`selectedCacheRoot` 增加与 `activeReleaseRoot` 同级的对账：读该目录的 `.codex-plugin/plugin.json` 版本，必须等于当前 active release 的 `source.pluginVersion`；或直接对 `skills/` 做 tree-sha256 与 registry 比对。

---

**P1-3 · 降级到旧版本会被 receipt/manifest 版本闸门永久卡死，且不给恢复指引**

- **证据**：`packages/cli/src/commands/host-plugin-convergence-receipt.ts:77`（只认 2/3/4）、`packages/cli/src/commands/setupHost.ts:128-132`（invalid → `return 1`，文案只有路径）；`packages/cli/src/runtime/release-store-codecs.ts:124`（`value.version !== 2 → null`）
- **失败场景**：用户装 v1.1.0（假设写 receipt v5）后回退到 v1.0.9。`tenon setup --codex` 立刻 `ERROR: 迁移 receipt 非法：/Users/x/.tenon/state/migrations/host-plugin-convergence/codex.json；未执行新的 marketplace/runtime 变更。` 退出码 1。用户没有任何提示可以删这个文件，且 `tenon doctor` 也不会建议。**降级路径实际不可用。**
- **修复方向**：(a) 区分"版本比我新"和"结构损坏"两类错误，前者给出 `rm <path>` 或 `tenon runtime repair --reset-convergence` 的明确出路；(b) 所有 durable 状态文件统一约定"未知的更高版本 = 提示降级不受支持并给出清理命令"。

---

**P1-4 · bootstrap dispatcher 是 codec 的第二份手写实现，无同步保障**

- **证据**：`runtime/tenon-bootstrap.mjs:156-160`（parseSelection）、`:194-198`（stableTarget）、`:205-215`（releaseId 计算）、`:228-247`（parseManifest）、`:264, 284-322`（payload hash v1/v2 两套）——逐条对应 `packages/cli/src/runtime/release-store-codecs.ts:88-161` 与 `release-payload.ts:99-164`。`tools/` 下无任何一致性检查脚本（`check-architecture.mjs`/`kernel-runtime-import-graph.mjs` 都不覆盖）。
- **失败场景**：将来引入 `release.json` v3 或改动 payload hash framing，只改了 TS 侧并发布。用户升级后 `selection.json` 指向 v3 release，但 `~/.tenon/data/bootstrap/active.mjs` 是**上一版**的 bootstrap（P1-5 说明它是单向棘轮，可能还没换），`parseManifest` 返回 null → `active === null` → 每个 hook 调用都打印 `[runtime] 修复：tenon runtime repair --rollback`。**全宿主 hook 集体失效。**
- **修复方向**：(a) 从单一 TS 源生成 `tenon-bootstrap.mjs` 的 codec 段（build 步），或 (b) 加 `tools/check-bootstrap-codec-parity.mjs`，对同一组 fixture 分别跑 TS 与 mjs 实现断言输出一致，纳入 `npm run check`。

---

**P1-5 · bootstrap 单向棘轮 + 两次写之间非原子**

- **证据**：`packages/cli/src/runtime/release-store.ts:412-427`（先 `previous.mjs ← 当前 active.mjs`，再 `active.mjs ← payload bootstrap`，两次独立 `atomicWriteFile`）；`:164-165` 注释声明 rollback 刻意不回退 bootstrap
- **失败场景**：磁盘在两次写之间满。`previous.mjs` 已被覆盖为 N-1，`active.mjs` 还是 N-1 → 两个文件内容相同，`tenon runtime repair --rollback` 的 N-1 ABI 保障（`tenon-bootstrap.mjs:651` 注释）失去意义。更糟的组合：`installBootstrap` 抛错 → `stageAndActivateUnderLock` catch → 记 `activation-rejected` → 但 `previous.mjs` 已被改写，**没有任何补偿把它写回去**。
- **修复方向**：把 bootstrap 的 previous/active 一对做成"同目录 staging + 单次 rename 目录"或引入版本化文件名 + 单个原子指针文件。

---

**P1-6 · Dashboard adapter 安装：假验证 + 丢失全部诊断输出**

- **证据**：`packages/server/src/adapterInstall.ts:112-113`（emit `verifying` 后立即 emit `installed`，零动作）、`:98, 110`（只用 `exitCode`，`preflight`/`installed` 的 stdout/stderr 未被消费）、`:94, 106`（`hosts` 可包含 `codex`/`claude`，即从 HTTP 触发完整 native 宿主 mutation）
- **失败场景**：用户在 Dashboard 勾选 codex + cursor 点安装。codex 走到 P0-1 的场景失败 → UI 显示「codex 安装失败 exit_code 1」，然后**继续**装 cursor 并显示「已安装并通过 CLI 退出码验证」。用户以为只是 codex 一个小问题，实际宿主插件已被删除且 UI 无从得知。
- **修复方向**：(a) 把 CLI 的 stdout/stderr 尾部（截断到 4KB）随 `failed` 事件回传；(b) `verifying` 相位必须做真事（至少读 `.pipeline/adapter-receipt.json` 或 `tenon doctor --json` 的对应项），否则删掉这个相位别撒谎；(c) 任一 host 失败后默认停止后续 host，除非显式 `continue_on_error`。

---

**P1-7 · `installNativePluginCandidate` 的失败处理分支对 managed 步骤全是死代码**

- **证据**：`packages/cli/src/commands/managed-host-command.ts:89-91`（非 inventory 步骤的返回值被强制 `code: 0`）；`packages/cli/src/commands/native-plugin-candidate.ts:137-172`（`if (result.code === 0) continue` 之后的 `isDuplicateMarketplaceResult` 分支、`plugin-install` 兜底 inventory 分支、以及最后的 `deps.io.err(...); return null`）
- **失败场景**：不是 crash，而是**维护陷阱**——读代码的人（包括未来的你）会以为 marketplace 重复登记有兜底、plugin-install 失败有 inventory 二次确认，实际这些路径永不执行；真实失败一律以 `ManagedRuntimeIndeterminateError` 从 `runStep` 抛出，绕过这里全部文案。用户拿不到 `ERROR: codex plugin marketplace add … 失败：<真实 stderr>` 这条本该最有用的信息。
- **修复方向**：要么让 `runManagedHostCommand` 保留真实 exit code 并由调用方决定，要么删掉这批分支并把 `runStep` 的异常文案补上被吞掉的 stdout/stderr。

---

### P2

---

**P2-1 · skillsRegistry 全链路 fail-open，失败表现为"东西消失"而非报错**

- **证据**：`packages/server/src/skillsRegistry.ts:6`（设计声明）、`:206-212`（registry 解析失败 → 空 Map）、`:178-183`（settings.json 损坏 → 视为无禁用）、`:199-200`（installed_plugins.json 损坏 → 无插件源）
- **失败场景**：`templates/skill-sources.yaml` 升到 v4，宽松解析器 `parseSkillSources` 因 `TOOL_SET` 不含新 tool 抛错 → catch → 空 Map → Dashboard 技能页显示 0 项，无任何错误提示。
- **修复方向**：区分"没有"与"读不出来"，`SkillEntry[]` 之外加 `degraded: {source, reason}[]` 并在 UI 显式展示。

---

**P2-2 · `descriptionForSkill` 按宿主 JSON 里的任意 `installPath` 读文件**

- **证据**：`packages/server/src/skillsRegistry.ts:51-62`（从 `installed_plugins.json` 取 `installPath` 字符串，无路径校验）、`:78-82`（`join(root, 'skills')` 后逐个尝试读 `SKILL.md`）
- **失败场景**：`~/.claude/plugins/installed_plugins.json` 被第三方插件写入 `installPath: "/etc"` → server 尝试读 `/etc/skills/<name>/SKILL.md`。当前只会读到不存在，但这是"用外部可写 JSON 驱动文件读取"的模式，随代码演进容易升级成真实泄漏。
- **修复方向**：`installPath` 必须 `isAbsolute` + `realpath` 后落在 `~/.claude/plugins/` 或 `~/.codex/plugins/` 之下。

---

**P2-3 · `isExactLegacyV101NativeJournal` 的判据不是 v1.0.1 的充分条件**

- **证据**：`packages/cli/src/commands/release-legacy-setup-retirement.ts:74-78`（`journal.operation === 'update' && pluginVersion === request.expectedPluginVersion` 也算 legacy）
- **失败场景**：理论上一个字段恰好全空的当前版本 update WAL 会被当作 v1.0.1 retire，重置回 `preparing-host`。因为现行代码总会写 `stableTarget`/`dashboardPort`，实际难触发；但判据命名与实际语义不一致，是未来 bug 的温床。
- **修复方向**：加一条硬条件——WAL 必须缺少任何 v1.0.2+ 才引入的字段**且** `startedAt` 早于某个已知边界，或干脆在 WAL 里写 `schemaVersion` 而不是靠字段指纹推断。

---

**P2-4 · Dashboard 的 adapter 安装端点无 Origin/Host 校验**

- **证据**：`packages/server/src/main.ts:75, 135`（绑 127.0.0.1）；`packages/server/src/server.ts` 全文 grep 无 `Origin`/`csrf`/`Authorization`；`packages/server/src/adapterInstallRoutes.ts:23-52`（POST `/api/adapters/install` 唯一防线是 `workflowRootForRequest` 的 root 白名单）
- **失败场景**：DNS rebinding 或任意本机进程（含浏览器扩展、其他 CLI）都能触发 `tenon setup --codex`，进而触发 P0-1 的破坏性宿主序列。浏览器 CORS 预检会挡住普通网页的 `application/json` POST，但挡不住 rebinding 与本机同源进程。
- **注意**：本条属于第 3 层（server/API）职责，此处仅记录它与本层 P0-1 的**耦合放大效应**，不在本层给修复方案。

---

**P2-5 · adapter hook 直连可变仓库 checkout，与 native hook 的信任政策相反**

- **证据**：`adapters/cursor/install.sh:67`（`__ADAPTER_DIR__` 被替换为 adapter 脚本所在的**仓库/cache 目录绝对路径**）vs `tools/verify-skills.sh:184-187`（native host hook **禁止**引用 `${PLUGIN_ROOT}`，必须走 `~/.local/bin/tenon-hook`）
- **失败场景**：用户装完 cursor adapter 后跑 `tenon update`，宿主 cache 目录名随版本变化 → 项目 `.cursor/hooks.json` 里的绝对路径悬空 → hook 静默失效（Cursor fail-open）。native 侧专门用稳定 launcher ABI 解决了这个问题，adapter 侧没有。
- **修复方向**：adapter 也改为调用 `~/.local/bin/tenon-hook <hook-id>`，与 native 统一。

---

**P2-6 · marketplace ↔ plugin manifest 的一致性校验只存在于 CI**

- **证据**：`packages/server/src/marketplaceManifest.test.ts:88-104`（跨文件等值断言，vitest 才跑）vs `tools/verify-skills.sh:99-124`（安装期只 grep 字段存在性）
- **失败场景**：发布时手改了 `.claude-plugin/plugin.json` 的 description 而忘了同步 marketplace.json，CI 没跑（或跑在另一分支）→ 用户 `claude plugin install tenon@tenon` 时看到的描述与实际不符；更坏的情况是 `name` 漂移导致安装名对不上，安装期完全不报错。
- **修复方向**：把 test 里的跨文件等值断言下沉成 `verify-skills.sh` 可调用的 Node 子命令（复用现有 `internal-skill-provenance` 那套 hidden command 模式）。

---

## 4. 真源重叠表

| 元数据项 | 定义处 1 | 定义处 2 | 定义处 3+ | 冲突风险 |
|---|---|---|---|---|
| **产品版本 `1.0.9`** | `package.json:4` | `.claude-plugin/plugin.json:4` + `.codex-plugin/plugin.json:3` | `packages/cli/package.json:3`、`packages/server/package.json:3`、`plugin-host.ts:36` `TENON_RELEASE_VERSION`、`hostTargetPlanProtocol.ts:35` `HOST_PLAN_RELEASE_TAG='v1.0.9'`、`install.sh:10` `TENON_RELEASE_VERSION="1.0.9"`、`.claude-plugin/marketplace.json:6` `metadata.version` | **高**：8 处硬编码。`tools/check-product-identity.mjs` 覆盖了一部分，但 `install.sh` 的 shell 常量与 `hostTargetPlanProtocol.ts` 的 TS 常量各自独立；漏改一处 → 安装期 tag 与 payload 版本不一致 → `stageAndActivate` 抛 `候选 plugin version X 与冻结目标 Y 不一致`（release-store.ts:257-262） |
| **marketplace 源 `jefferysha/tenon`** | `plugin-host.ts:32` `TENON_MARKETPLACE_SOURCE` | `install.sh:8` `MARKETPLACE_SOURCE` | `hostTargetPlanProtocol.ts:140,149,159,166`（服务端为验证 plan 而**再次硬编码**完整命令） | **高**：服务端 `nativeCommandTruth()` 逐字重写了 CLI 的 `nativeUpdatePlan()`。任一侧改动 → `decodeHostTargetPlan` 返回 null → Dashboard 的宿主计划页整块失效，且无差异化报错 |
| **native 安装命令序列** | `plugin-host.ts:207-267`（CLI 真源，会真执行） | `hostTargetPlanProtocol.ts:130-170`（server 校验副本，只比对） | `install.sh:66-79`（dry-run 文案第三次描述） | **高**：三份必须逐 token 相同；`decodeHostTargetPlan` 用 `arraysEqual` 严格比对（:335） |
| **plugin manifest 字段契约** | `plugin-manifest-version.ts:7-24`（只取 version） | `tools/verify-skills.sh:94-124`（grep 字面量） | `marketplaceManifest.test.ts:74-137`（CI 强断言） | **中**：三种强度，安装期最弱 |
| **release.json / selection.json / payload hash codec** | `release-store-codecs.ts:88-161` + `release-payload.ts:99-164`（TS） | `runtime/tenon-bootstrap.mjs:156-322`（手写 JS 副本） | — | **极高**（P1-4）：无自动同步检查 |
| **skill 元数据（token/tier/source/hash）** | `templates/skill-sources.yaml`（唯一数据文件） | `parseSkillSources`（`source-registry.ts:197`，宽松，server 用） | `parseSkillProvenanceRegistry`（`:290`，严格，CLI 用）；另有 `skills/EXTERNAL-SKILLS.md` 与 `skillsRegistry.ts:27` `BUILTIN_SKILLS` 两个补充真源 | **高**：一份数据两套语义 + 两个旁路真源；"已安装"的定义在 server 与 CLI 之间不共享代码 |
| **hook 清单（id/event/matcher/script）** | `hooks/hooks.json`（运行时真源，宿主读） | `hooksConfig.ts:58-67` `HOOK_METAS`（server 硬编码副本，注释自陈"逐条核实自 hooks/hooks.json"） | `tools/verify-skills.sh:188-204`（第三份文件名列表） | **中高**：加一个 hook 要改三处；漏改 `HOOK_METAS` → Dashboard 开关矩阵缺项；漏改 verify-skills → 发布期不校验该脚本存在 |
| **native host 探测（是否已装 tenon）** | `hostTargetDetection.ts:196-241`（server：直接解析 `~/.codex/config.toml` 与 `~/.claude/.../installed_plugins.json`） | `plugin-host.ts:54` `parseHostPluginInventory`（CLI：解析 `plugin list --json` 输出） | `skillsRegistry.ts:156-202` `detectInstalled`（第三套：扫 cache 目录 + installed_plugins.json + `~/.agents/skills`） | **高**：三套互不相同的"装没装"判据。server 的 TOML 正则（`:199-204`）手写解析 TOML 子集；CLI 走宿主 CLI 的权威输出。**server 可以说"已安装"而 CLI 说"未安装"** |
| **stable target（version/tag/commit）** | `stable-release.ts:22-26` `StableReleaseTarget` | `types.ts:44-48` `RuntimeStableReleaseTarget`（结构相同的第二个类型） | `tenon-bootstrap.mjs:194-198`（第三份解码器） | **中**：类型重复但形状一致，靠 `ManagedStableReleaseTarget = RuntimeStableReleaseTarget` 别名（`installer-contract.ts:53`）勉强对齐 |
| **runtime 路径布局** | `runtime/paths.ts` + `@tenon/kernel` `ProductPaths` | `tenon-bootstrap.mjs:131-146`（从 `TENON_RUNTIME_ROOTS` 环境变量重建） | `codexSkillTrust.ts:106-107`（正则硬编码 `releases/sha256-<hex>/payload` 布局） | **中**：布局改动要同步三处 |

---

## 5. 架构层面的重构建议

### R1 · 把"宿主 mutation"升级成真正的两阶段（对应 P0-1）

现状是 managed runtime 侧做了教科书级的 WAL + CAS，宿主侧却退化成"顺序执行、失败即弃"。这个不对称是整层最大的结构性问题。建议：

- 引入 **host-side compensating action 表**：每个 host step 除了 `desired`，再持久化一个 `compensate` 描述（例如 `plugin-remove` 的补偿是"用 WAL 里记录的旧 marketplace 源 + 旧 ref 重新 add + install"）。
- 补偿链复用现有的 `stopping-candidate → reverting-activation → restoring-previous → previous-restored` 相位机制，而不是另建一套。
- 如果确实认为"不碰宿主私有缓存"是不可动摇的产品原则，那就**改变顺序**：先证明新版本可安装（在临时 marketplace 名下 add + install + 校验），再删旧的。破坏性操作永远排在不可逆点之后。

### R2 · 引入一个不随 payload 分发的外部信任锚（对应 P0-2）

现在的信任链是：`GitHub tag 不可变` → `宿主 CLI 忠实 clone` → `候选自己验自己`。第三环是空的。最小可行方案：

- 发布时对 `payloadDigest` 做 minisign/sigstore 签名，签名文件与公钥**随 stable launcher（`~/.local/bin/tenon`）分发**，不进 `PAYLOAD_ENTRIES`。
- `verifyReleasePayload` 的第一步改为"用已激活 release 的可信 CLI 验签 + 验 digest"，验签通过后**才**允许执行候选自带的脚本。
- 首次安装（无 active release）的引导问题用 `install.sh` 内嵌公钥指纹解决——`install.sh` 本身来自用户显式 `curl` 的那个 tag，是当前唯一合法的信任引入点。

### R3 · 用单一 codec 源消灭 bootstrap 手写副本（对应 P1-4）

`runtime/tenon-bootstrap.mjs` 必须是零依赖单文件——这个约束是对的，但不必然导致手写副本。方案：

- 把 `release-store-codecs.ts` 里的纯函数段（parseSelection / parseManifest / runtimeReleaseIdV2 / hashReleasePayload）抽成一个无依赖的 `codec-core.ts`，用 esbuild 在 build 期 inline 进 `tenon-bootstrap.mjs`（它已经是 build 产物入库模式，见 `docs/DIST-RELEASE.md`）。
- 若不接受 bootstrap 变成生成物，退而求其次加 `tools/check-bootstrap-codec-parity.mjs`：同一组 fixture 分别喂两个实现，断言输出逐字节一致，纳入 `npm run check`。

### R4 · 给 adapter 层补上与 native 层同等的"稳定 ABI + 收据"（对应 P0-3、P2-5）

native 侧已经证明了正确做法：host manifest 只调 `~/.local/bin/tenon-hook`，真正的实现在已验证的 managed release 里。adapter 侧应当照抄：

- adapter 产物里的所有路径改为 `~/.local/bin/tenon-hook <hook-id>`，不再 `sed __ADAPTER_DIR__`。
- 每次 adapter 安装写 `<project>/.pipeline/adapter-receipt.json`：`{version, platform, tenonVersion, artifacts:[{path, sha256}], installedAt}`。
- `tenon doctor` 增加 adapter 漂移检测（读 receipt → 重算 sha256 → 报告 drifted/missing/foreign）。
- 所有落盘统一 `mktemp` + `mv`，禁止裸 `>`。

### R5 · 统一"装没装"的判据，消灭三套探测器（对应真源重叠表第 8 行）

现在 server 有两套（`hostTargetDetection` 直读宿主配置文件、`skillsRegistry.detectInstalled` 扫目录），CLI 有一套（`parseHostPluginInventory` 走宿主 CLI 权威输出）。三者结论可以互相矛盾，而 Dashboard 展示的是前两套、实际安装决策用的是第三套。建议：

- 把"权威 inventory"定义为**唯一**判据：server 需要这个信息时通过 `PipelineCliRunner` 调 `tenon` 的只读子命令拿，而不是自己解析宿主私有文件。
- `hostTargetDetection` 的价值是"宿主装没装（不是 tenon 装没装）"，把它的输出收窄到 `detected_hosts`，删掉 `codexPluginEnabled`/`claudePluginEnabled` 这部分与 CLI 重复且更弱的逻辑。
- 由此顺带解决 `hostTargetDetection.ts:199-216` 手写 TOML 子集解析器这个长期维护负担。

### R6 · 版本号从单一 identity 文件生成（对应真源重叠表第 1–3 行）

仓里已经有 `tools/generate-product-identity.mjs` 与 `tools/check-product-identity.mjs` 的雏形。把覆盖面扩到全部 8 处（含 `install.sh` 的 shell 常量与 `hostTargetPlanProtocol.ts` 的 `HOST_PLAN_RELEASE_TAG`），并把 `nativeCommandTruth()` 从服务端删除——改为 server 通过 CLI 的只读 `tenon host-target-plan --json` 拿计划，而不是自己重写一份再比对。当前"两份手写命令表互相校验"的设计，正确性靠人肉同步，收益只有"检测到不同步"而不是"不可能不同步"。

### R7 · 错误面统一为三段式（对应 Q7）

`tools/verify-skills.sh:360-368` 的「缺什么 / 在哪引用 / 怎么修」是全仓最好的错误面。把这个结构上升为约定：

- 所有 `ManagedRuntimeIndeterminateError` 与 `deps.io.err` 的终态错误，必须携带 `{what, where, howToFix}` 三元组。
- 尤其是 P0-1 的宿主失败：`howToFix` 必须包含可复制粘贴的宿主恢复命令原文。
- `adapterInstall.ts` 的 SSE 事件 payload 增加 `detail`（截断的 stdout/stderr）与 `remediation` 字段。

---

## 6. 未覆盖 / 存疑事项

- `docs/CONTRACT.md` 只做了引用性抽查（§5.4 hooks 禁 spawn、§5.7 资产校验），未逐节对齐实现。
- `adapters/` 下 11 个平台只精读了 `cursor` 与 `codex` 两个 install.sh；其余 9 个（gemini/copilot/pi/devin/zed/aider/continue/cline/amp）假定与 cursor 同构，未逐一取证。
- `release-store.integration.test.ts`（109KB）与 `bootstrap.test.ts`（26KB）未通读，**未运行任何测试**；本报告的失败场景均为静态推演，未做实证复现。
- Dashboard 前端如何消费 `adapter-install/v1` SSE、失败态如何呈现，属第 4 层，未审。
- `docs/research/2026-07-11-skills-distribution.md` 与 `2026-07-12-skill-install-sources.md` 描述的是 v3 registry 之前的外部依赖世界观（当时 28 个外部 token 只满足 11 个）；当前 `templates/skill-sources.yaml` 已全部 `tool: bundled`（62/62），**这两份文档的结论已过期**，但 `skillsRegistry.ts:234-245` 的 `installCmdFor` 仍保留着 `npx skills add` / `npm install -g` / `claude plugin install` 三条外部安装命令生成逻辑——对当前 registry 而言是死代码，对未来是重新引入外部依赖的后门。
