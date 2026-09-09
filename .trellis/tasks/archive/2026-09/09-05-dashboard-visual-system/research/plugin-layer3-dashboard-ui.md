# Research: 插件体系全链路排查 · 第 3 层 Dashboard 插件管理 UI 层

- **Query**: 工作台 Hook/Skill 编排 UI 的语义诚实性、写反馈闭环、CAS、适配器安装流、能力矩阵可见性、信息架构、状态覆盖
- **Scope**: internal（只读审计）
- **Date**: 2026-09-08
- **仓库根**: /Users/a1234/Documents/code-manager/projects/tenon-local
- **审计基线**: 分支 `codex/autonomous-loop-v1` @ deda3cf

---

## 一句话结论

工作台把**三档诚实的 Hook 呈现（可配 / 强制常开 / 暂不可配）压成了「锁 or 开关」的两档**，并且用 workflow 的只读态错误地关掉了与 workflow 无关的 hooks.json 运行时开关——用户在默认落地页上看到的 8 把锁 + 蓝色「启用」是**一个被误锁的静态标签**；更深一层，`capabilities.{inject,veto,track}` 在 server 端是从 tier 字母**凭空推导**的，而不是读 `adapters/registry.yaml` 的 `*_status`，导致 UI 对 inject 全线过度承诺、对 cursor/copilot 的 native veto 反而漏报——这是契约诚实性 P0。

---

## 一、「启用」语义的确定性答案

### 结论：它是**纯状态标签**，不是按钮；而且它此刻显示的是一个「你无法改变」的状态

**证据链（live 渲染路径）**

`packages/dashboard-app/src/workbench/TimelineHookRows.tsx:100`

```tsx
<span className={`text-xs font-semibold ${enabled ? 'text-accent-d' : 'text-text-3'}`}>
  {t(enabled ? 'workbench.timeline_hook_enabled' : 'workbench.timeline_hook_disabled')}
</span>
```

- 它是 `<span>`，**没有 `onClick`、没有 `role`、没有 `tabIndex`**，完全不可交互、不可聚焦。
- 文案来自 `packages/dashboard-app/src/i18n/translations.ts:1610` `timeline_hook_enabled: '启用'`（英文 4178 行是 `'Enabled'`）。
- **中英不对等是问题根源**：英文 `Enabled` 是形容词，语义无歧义；中文 `启用` 是动词/动名词同形，与同文件 `timeline_hook_count`（1588 行）的 `'{enabled} 个 Hook · {enabled}/{total} 已启用'` 里的「**已**启用」不一致。同一页面对同一状态用了两种说法，其中一种长得像按钮。
- **视觉进一步误导**：`enabled` 时上色 `text-accent-d`（= 项目主蓝 `--accent`），与全站链接/主行动色同源，且右对齐在行尾——这正是「行尾蓝字 = 行级操作」的通用模式。用户读成按钮是设计造成的，不是用户的错。

### 锁图标与它的组合表达什么

`TimelineHookRows.tsx:84`

```tsx
{locked || readonly ? <LockKeyhole className="h-4 w-4 flex-none text-text-3" aria-hidden="true" /> : (
  <button type="button" role="switch" aria-checked={enabled} ... onClick={() => config.toggle(hook.id, stageId, !enabled)} />
)}
```

- `locked = !hook.configurable`（`:58`）
- `readonly` 一路从 `WorkbenchView.tsx:213` 的 `const readonlyWf = wfName === 'default'` → `:544 readonly={readonlyWf}` → `ExecutionTimelineComposer.tsx:195 / :338 <TimelineHookNodes ... readonly={readonly} />` → `HookRows`。

**⇒ 你截图里 8 行全是锁，是因为你停在 `default` workflow 上（默认落地态），`readonly=true` 让全部 8 个 hook 的开关被整体替换成锁图标。**

这与本仓自己写下的契约**直接矛盾**。`packages/dashboard-app/src/workbench/HookTimeline.tsx:35-36` 原文：

> 注意：hooks.json 是 per-root 运行时配置、不属于 workflow def 草稿——default workflow 只读态下本区照常可切（不走保存钮，写回即时生效），**与 StepEditor 的 readonly 无关**。

live 路径违反了这条。默认 workflow 下 4 个本应可配的 hook（session-start / breadcrumb / router / skill-tracker）被无理由锁死。

**锁图标本身还是哑的**：`aria-hidden="true"`，无 `title`、无 `aria-label`、无说明文案。行级 `title`（`:77-82`）给的是 `{id} · {event} · 匹配 {matcher} · {script}` 技术详情，**完全没有解释「为什么锁」**。屏幕阅读器用户拿不到任何「此项不可改」的信息，只会听到 hook 名 + 「内置 Hook」+「启用」——即读成"可以启用"。

### Hook 行状态枚举 × UI 呈现核对

数据面真值只有两个维度（`api/governanceTypes.ts:3-9`，`WbHookMeta` 只有 `id/event/matcher/script/configurable`，**没有 source 字段**）+ 矩阵键存在性：

| # | 真实状态 | 应有呈现 | live（HookRows）实际呈现 | 是否可辨 |
|---|---|---|---|---|
| 1 | configurable=true，矩阵无键（启用） | 开关 ON，可点 | readonly=false → 开关 ON；**readonly=true → 锁 +「启用」** | ❌ 只读态下与 3/5 无法区分 |
| 2 | configurable=true，矩阵有键（禁用） | 开关 OFF，可点 | 同上；只读态 → 锁 +「停用」 | ❌ 只读态下与 6 无法区分 |
| 3 | configurable=false 且 ∈ LOCKED_IDS（**强制常开**，关掉即 gate 语义失效） | 「强制常开」徽章 + 恒开 | 锁 +「启用」 | ❌ 与 1/5 同形 |
| 4 | 同 3 但矩阵里残留禁用键 | 恒显「开」（sh 侧不读该键） | 锁 + **「停用」（撒谎）** | ❌ **反向撒谎** |
| 5 | configurable=false 且 ∉ LOCKED_IDS（**暂不可配**，sh 未接线） | 灰显 +「暂不可配」徽章 | 锁 +「启用」 | ❌ 与 1/3 同形 |
| 6 | 同 5 但矩阵有禁用键 | 灰显 +「暂不可配」 | 锁 +「停用」 | ❌ |
| 7 | 自定义 / 非内置来源 hook | 应标真实来源 | **恒标「内置 Hook」** | ❌ 硬编码 |
| 8 | 在途写回（busyKeys） | 开关禁用 | 只读态无开关 → **零反馈** | ❌ |

**7 的证据**：`TimelineHookRows.tsx:97` 无条件渲染 `{t('workbench.timeline_hook_builtin')}`（「内置 Hook」），**没有任何条件判断**。`WbHookMeta` 里根本没有 source 字段，所以这个徽章 100% 是一句写死的话。同文件 `:16-21` 的 `sourceLabel()` 函数能区分 builtin/local-plugin/external-marketplace/user——但那是给 **Skill** 用的（`SkillOrchestrationDialog.tsx:152`），Hook 完全没有来源概念。适配器装进来的 hook 会被一律标成「内置」。

**4 的证据**：`TimelineHookRows.tsx:57` `const enabled = !(key in config.matrix)` 对**所有** hook 一视同仁地读矩阵。对比 `HookTimeline.tsx:286` 的正确做法 `checked={h.configurable ? enabled : true}`，并附注释「强制常开/暂不可配的 hook 实际都在跑（sh 侧不读/不认它们的禁用键）——开关恒显开，**不撒谎**」。live 路径丢掉了这条纪律。

### ⚠️ 关键发现：诚实版实现存在，但是**死代码**

仓内有 **3 套** hook 渲染器，只有最差的那套被挂载：

| 渲染器 | 文件:行 | 三档语义 | 是否被挂载 |
|---|---|---|---|
| `HookTimeline` | `HookTimeline.tsx:228` | ✅ locked/pending/configurable 三档 + 徽章 + 恒开不撒谎 | ❌ **从未挂载**（全仓只 import 它的 `useHooksConfig` / `LOCKED_IDS` / `HooksConfigState` 类型） |
| `OrchestrationHookBody` | `OrchestrationHookBody.tsx:45-60` | ✅ 三档 + 徽章 + `hook.configurable` 才给开关 + **不吃 workflow readonly**（符合契约） | ❌ 只被 `OrchestrationBoard.tsx:152` 调用，而 **`OrchestrationBoard` 自身从未挂载** |
| `HookRows` | `TimelineHookRows.tsx:29-107` | ❌ 两档、吃 readonly、硬编码徽章 | ✅ **唯一 live**（`ExecutionTimelineComposer.tsx:195,338`） |

`OrchestrationBoard.test.tsx` 有 2200+ 行测试直接 `render(<OrchestrationBoard>)`，其中 `:2042 §4.4 locked → 徽章 + 无开关`、`:2076 §4.5 pending → 灰态 + 无开关` 精确地钉住了三档语义——**但这些测试守护的是一个不会被用户看到的组件**，形成绿灯假象。

---

## 二、写路径反馈矩阵

图例：✅ 有 ／ ⚠️ 部分/隐式 ／ ❌ 缺失 ／ n/a 不适用

| 写路径 | 端点 | loading | success | error | conflict(CAS) | 证据 |
|---|---|---|---|---|---|---|
| Hook 开关 | `POST /api/hooks` | ⚠️ 仅 `disabled`，无视觉 spinner；**只读态下开关不存在 → 零反馈** | ⚠️ 隐式（乐观翻转） | ✅ 回滚 + `hk_toggle_error` | ❌ 无版本号 | `governanceClient.ts:92-109`；`HookTimeline.tsx:136-176`；`TimelineHookRows.tsx:91` |
| 旁路词保存 | `POST /api/hooks/prompt-routing-bypass` | ✅ `hk_bypass_saving` | ✅ `hk_bypass_saved` | ✅ `role="alert"` + 重试钮 | ❌ 无版本号 | `TimelineHookRows.tsx:203-226`；`governanceClient.ts:111-132` |
| Workflow 定义保存（含 Skill 编排、阶段、prompt） | `POST /api/workflows/:name` | ✅ `saving` | ✅ `saveStatus.kind='ok'` | ✅ `readSaveErrors` 多条 | ❌ **整包覆盖，无 If-Match/revision** | `WorkbenchView.tsx:246-286`；`governanceClient.ts:219-225` |
| Skill 编排弹窗（拖拽增删/依赖） | 无独立端点（改本地 `def`） | n/a | ❌ **弹窗内零「未保存」提示** | n/a | n/a | `SkillOrchestrationDialog.tsx:10-19` 仅 4 个回调，全文件无 busy/error/dirty state |
| 强制 Skill 矩阵 | `POST /api/config/mandatory-skills` | ✅ 逐格 `busy` | ⚠️ 隐式（回读 cfg） | ✅ **逐格** `saveErrors[cellKey]` | ❌ 请求体不带 revision（`governanceClient.ts:234-245`） | `mandatoryState.ts:206-270`；`LaneMandatorySkills.tsx:60-62,221` |
| Track 新建/改/删 | `POST/PATCH/DELETE /api/tracks` | ✅ `useTrackMutationIdentity` | ✅ 回读 `revision` | ✅ | ⚠️ **唯一带 revision 的写**，但前端无 409 专属分支 | `governanceClient.ts:247-278`；`trackMutationResponse.ts:106-120` |
| 治理·自主级别 | `postLoopLevel` | ✅ `levelBusy` + `disabled` | ❌ 无确认 | ✅ `wb-gov-level-error` | ❌ | `GovernanceRail.tsx:31,96,111,208,230` |
| 治理·token 预算滑杆 | `postLoopUpdate` | ❌ **无 busy，滑杆不禁用** | ❌ 无确认 | ⚠️ 有 `budgetError`，但**滑杆不回滚，仍显示未落盘的值** | ❌ | `GovernanceRail.tsx:118-145,274-290` |
| 适配器安装 | `POST /api/adapters/install` + SSE | ✅ `busy` + `animate-pulse` | ❌ **无终局成功汇总** | ⚠️ 仅创建/流错误；`phase='failed'` **不触发 error 横幅** | n/a | `AdapterInstallWizard.tsx:72-107,118-119` |

### 缺失反馈的写路径（汇总）

1. **Hook 开关在只读 workflow 下完全无写入口** —— 最严重，见 §一。
2. **Skill 编排弹窗无脏态提示** —— 用户在模态里拖了半天 Skill、连了依赖，关掉弹窗后没有任何「这些改动还没保存」的信号；保存钮在弹窗外的 header 里。
3. **token 预算滑杆无 loading、失败不回滚** —— `GovernanceRail.tsx:141` 注释就写着「即时回显」，POST 失败后滑杆停在用户拖到的位置，只多一行小字红字。视觉主体（滑杆位置 + 数值）在说「已经是 80k 了」。
4. **适配器安装无终局汇总** —— 见 §四。
5. **自主级别、预算、强制 Skill 三处均无成功确认**，只能靠状态回读推断。

---

## 三、CAS / 脏态语义

### 结论：全局基本没有 CAS；主写路径是**后写覆盖（last-write-wins）**

- `postWorkflowDef`（`governanceClient.ts:219-225`）把整个 `def` 作为 body POST 过去，**没有 `If-Match`、没有 `fingerprint`、没有 `expected_revision`**。两个浏览器标签页同时开同一个 workflow，后保存的静默覆盖先保存的，双方都收到 `{ok:true}`，**先保存者的改动无声消失**。
- `postHookToggle`（`:92-109`）只发 `{root, hook, phase, enabled}`，无版本。
- `postMandatorySkills`（`:234-245`）只发 `{phase, track, skills, root}`，无版本——**尽管 `mandatoryState.ts:311` 明明持有 `revision`**，写请求里却不带。
- 唯一带 CAS 的是 track 三写（`:247-278` 都传 `revision`）。但前端**没有 409 分支**：全仓 `packages/dashboard-app/src/api/` 下只有 `loopScopePreview.ts:191` 提到 `response.status === 409`，其余写路径把冲突降级成通用 HTTP 错误字符串（如 `mandatoryState.ts:239` 的 `mand_save_failed {status}`）。用户看到「保存失败 409」，得不到「有人改过了，这是差异，要不要重载」的任何引导。

### 静默丢弃用户输入的路径

| 路径 | 机制 | 证据 |
|---|---|---|
| Workflow def 并发保存 | 无 CAS，整包覆盖 | `governanceClient.ts:219`；`WorkbenchView.tsx:254` |
| `switchTo()` 切 workflow | `++saveGeneration` + `setDef(null)`，**未检查 dirty** | `WorkbenchView.tsx:287-296` |
| 保存成功后基线覆盖 | `defSnapshotRef.current = JSON.stringify(def)` 用的是**发请求时的 def 快照**，若用户在请求在途时继续编辑，`dirty` 会被错误清零 | `WorkbenchView.tsx:274-275` |
| 预算滑杆写失败 | UI 保留未落盘值，不回滚 | `GovernanceRail.tsx:141` |
| Hook 只读态 | 用户压根输入不了（不算丢弃，但是能力被吞） | `TimelineHookRows.tsx:84` |

正面：`beforeunload` 脏守卫存在（`App.tsx:225`），乐观更新的乱序竞态防护做得相当扎实（`HookTimeline.tsx:140,153,168` 的 token/generation/rootIdentity 三重校验；`useMandatoryCellMutations.ts` 的 per-cell 互斥）。**并发正确性写得很好，缺的是并发语义的对外表达。**

---

## 四、适配器安装流

链路：`AdapterInstallWizard` → `POST /api/adapters/install` → `subscribeAdapterInstall` SSE(`install-state` / `complete`) → 追加渲染。

### 错误呈现

- 创建失败 / 流错误 → `error` 红条（`AdapterInstallWizard.tsx:118`）。✅
- **`phase === 'failed'` 不触发任何错误横幅** —— 只会在日志 `<ol>` 里多出一行（`:119`）。安装真正失败时，`busy` 转 false、错误区空白，页面看起来像「跑完了」。
- **`exit_code` 被解码但从不渲染** —— `definitionCatalogTypes.ts:74` 定义、`definitionCatalogClient.ts:58` 校验，UI 零引用。失败原因线索被丢掉。
- **`phase` 直接输出未翻译的英文枚举** —— `:119` 的 `<span className="font-semibold text-text">{state.phase}</span>` 没过 `t()`。中文界面里出现裸的 `queued/preflight/installing/verifying/planned/installed/failed`。
- **15 分钟静默死锁** —— `:100` `window.setTimeout(stop, 15 * 60 * 1000)`。`stop` 是 `subscribeAdapterInstall` 返回的 `close`（`definitionCatalogClient.ts:150-155`），它**只关 EventSource，不调用 `onComplete`/`onError`**。若流挂起满 15 分钟，`busy` 永远为 true，两个按钮永久禁用，且无任何提示。

### 部分成功（8 个 hook 装了 5 个）如何表达

**表达不了。** 两层缺口：

1. **协议层无 hook 粒度**：`AdapterInstallState`（`definitionCatalogTypes.ts:68-75`）只有 `{job_id, host, phase, message, at, exit_code?}`。整个 schema 里**没有任何单项/条目级的成功计数**。"8 装了 5" 这个事实在数据面就不存在，只能挤进自由文本 `message`。
2. **UI 层无聚合**：`states` 是一条按到达顺序追加的扁平 `<ol>`（`:20, :88, :119`），跨 host 混排。`complete` 事件只做 `setBusy(false)`（`:80-84`），**没有任何终局汇总**——没有「3 成功 / 2 失败」，没有按 host 分组，没有把失败项提到顶部。选了 5 个 host 装，用户得自己在一串英文 phase 里数。

---

## 五、契约诚实性专项结论（能力矩阵可见性）—— **P0**

### 结论：不能。用户看不出自己终端的 veto 是降级的；更糟的是，UI 会对他撒两个方向的谎。

**真值**（`adapters/registry.yaml`，注释 `:26` 明确 `<cap>_status = native|degraded|none`）：

| id | tier | inject | veto | track | fallback |
|---|---|---|---|---|---|
| claude-code | A | native | native | native | |
| codex | A | native | native | native | |
| gemini / continue / cline / amp | A | native | native | native | |
| cursor | B | **degraded** | **native** | native | static-rules |
| copilot | B | **degraded** | **native** | native | copilot-instructions |
| pi | B | native | **degraded** | native | |
| aider | B | native | **degraded** | native | |
| devin | C | degraded | degraded | degraded | static-workflow |
| zed | C | degraded | degraded | degraded | static-rules |

**server 端的实现**（`packages/server/src/definitionCatalog.ts:124-128`）：

```ts
capabilities: {
  inject: true,
  veto: tier === 'A',
  track: tier !== 'C',
},
```

三个问题，逐个致命：

1. **`registry.yaml` 根本没被读**。全仓 TS/服务端零引用（唯一提到它的是 `packages/cli/src/commands/plugin-host.ts:9` 的一句注释）。`definitionCatalog.ts:30-33` 手抄了**第二份 tier 表**，与 registry 并行漂移（且 key 用 `claude` 而 registry 用 `claude-code`）。单一真源被破坏。
2. **类型把三态压成布尔**。`DefinitionCatalogAdapter.capabilities` 是 `{inject: boolean; veto: boolean; track: boolean}`（`definitionCatalogTypes.ts:11`），`degraded` 这个档位**在协议层就被抹掉了**，前端即使想诚实也没有数据。
3. **推导本身两个方向都错**：
   - `inject: true` **无条件** —— cursor / copilot / devin / zed 的 inject 是 `degraded`（只落一个静态 rules 文件，没有 SessionStart 级原语）。UI **过度承诺**。
   - `veto: tier === 'A'` —— cursor / copilot 是 tier B 但 veto 是 **native**（还带 `veto_failclosed: true` 的硬拦保证，registry `:93`），却被报成 `veto: false`。UI **漏报了用户真正拥有的强制能力**。而 pi / aider 的 `veto: degraded`（advisory，不硬拦）同样被报成 `false`——与「完全没有」不可区分。

**更釜底抽薪的一点：这些 capabilities 前端根本没渲染。**

`grep capabilities.inject|veto|track` 在 `packages/dashboard-app/src` 下只命中 `definitionCatalogClient.ts:19-20` 的**类型校验**。`AdapterInstallWizard.tsx:116` 渲染的全部信息是：

```
{adapter.label}   Tier {adapter.tier}
{kind} · {scope} · {state}
```

一个孤零零的字母 `Tier B`，**卡片里没有图例、没有 tooltip、没有降级说明**。tier 的解释文字只存在于另一个页面 `SolutionView.tsx:276-284`，且其宿主清单（`translations.ts:197,200,203` 的 `tier_a_hosts` 等）是**硬编码的字符串**，不从 registry 派生——registry 一改就变成过期文案。

**判定 P0。** 用户在 dashboard 上看到 Cursor 标着 `Tier B` 就装了，界面从头到尾没说过一句「你的上下文注入会降级成一个 rules 文件」，也没说「你的 veto 其实是原生硬拦」。`registry.yaml` 开头写着「把 contract.md 变机器约束的数据源」，而这份约束在到达用户眼前的最后一跳被丢弃并替换成了臆测。

---

## 六、信息架构 / 认知负荷

工作台单页承载 workflow / track / stage / skill / hook / loop / 治理 七类对象。

**可交互控件（静态声明数，live 挂载路径）**

| 组件 | 控件声明 |
|---|---|
| StepPolicyEditor | 29 |
| ExecutionTimelineComposer | 14 |
| WorkflowPolicyEditor | 12 |
| WorkbenchDialogs | 11 |
| SkillOrchestrationDialog | 9 |
| WorkbenchHeader | 7 |
| TimelineHookRows | 6 |
| TimelineStageStrip | 4 |
| LaneMandatorySkills | 3 |
| WorkbenchView / TrackSelector | 2 + 2 |
| GovernanceRail / WorkbenchSideRail | 1 + 1 |
| **合计** | **101 处静态声明** |

**运行时实例数远高于此**——`TimelineHookRows` 的 6 处声明在 8 个 hook × 4 时机分组下展开；`TimelineStageStrip` 按阶段数展开；`ExecutionTimelineComposer` 的 skill 卡按 skill 数展开（每卡含拖手柄 + 移动 + 删除 + 依赖 4 个控件）。你截图那一屏，单是 hook 区就有 8 行 × (1 锁/开关 + 1 状态字) = 16 个视觉元素在争夺注意力。

**嵌套深度（JSX 最大缩进换算）**

| 组件 | 最大深度 |
|---|---|
| ExecutionTimelineComposer | ~14 层 |
| SkillOrchestrationDialog | ~13 层 |
| GovernanceRail | ~8 层 |
| TimelineHookRows | ~7 层 |

跨组件的最深链路：`WorkbenchView → ExecutionTimelineComposer → TimelineHookNodes → HookRows → hook 行 → 开关` ≈ **5 层组件 + 14 层 DOM**。用户要修改一个 hook 开关，认知路径是「选 workflow → 选 track → 选 stage → 找到时机分组 → 找到 hook 行 → 点开关」，六级下钻。

**同名折叠行（你观察到的）**——`WorkbenchView.tsx:505-537`：

```tsx
<summary>{t('workbench.policy_title')}          <span>{t('workbench.advanced_show')}</span></summary>  // :510-511
<summary>{t('workbench.policy_runtime_title')}  <span>{t('workbench.advanced_show')}</span></summary>  // :531-532
```

- `policy_title = 'Workflow 策略'`（`translations.ts:1404`）
- `policy_runtime_title = 'Workflow 策略运行时摘要'`（`:1449`）
- 两行**共用同一个副标签 `advanced_show = '高级设置'`**（`:1377`），前 6 个字完全相同，垂直相邻，视觉上无任何区分（同 `rounded-2xl border-border bg-card`）。
- 附带 bug：`advanced_show` 在这里是**静态文案，永不切换成 `advanced_hide`（'收起高级设置'）**。对比 `loopCardModel.tsx:73` 的正确写法 `{open ? t('advanced_hide') : t('advanced_show')}`。展开后标签仍写着「高级设置」，不提示可收起。

---

## 七、空 / 错 / 加载态覆盖

### 缺陷：「运行前事实」5 点里只有 2 个点携带信息，且其中 1 个**永远看不见**

`ExecutionTimelineComposer.tsx:380-384` + `TimelineHookRows.tsx:265-271`：

```tsx
<span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${ready ? 'bg-green' : 'bg-amb'}`} aria-hidden="true" />
```

| # | 行 | `ready` 表达式 | 行为 |
|---|---|---|---|
| 1 | Skill | `skills === undefined \|\| skills.length > 0` | ✅ 真实 |
| 2 | Hook | `enabledHooks !== null && enabledHooks.length > 0` | ✅ 真实 |
| 3 | 运行时产出 | **`ready`（字面常量 true）** | ❌ 恒绿，零信息 |
| 4 | 依赖 | **`ready`（字面常量 true）** | ❌ 恒绿，即使「全部并行/无依赖」也绿 |
| 5 | 执行指令 | `prompt.trim().length > 0` | ⚠️ 真实，但 → `bg-amb` → **不可见** |

**`bg-amb` 是一个不存在的 class。** `src/index.css` 定义了 `--color-amb-d` / `--color-amb-t` / `--color-amb-b`（`:165-167`），但**没有裸的 `--color-amb`**；对照 `--color-green`（`:153`）是有裸 token 的，所以 `bg-green` 能编译。核验产物：

```
$ grep -l "bg-amb{" dist/assets/*.css   →  NOT FOUND in any bundle
$ grep -o "\.bg-green{[^}]*}" dist/assets/index-BKo9p-Xb.css  →  .bg-green{background-color:var(--green)}
```

`.bg-amb{}` **从未被 Tailwind 生成**。未就绪的点渲染成一个 8×8px 完全透明的 span，且 `aria-hidden="true"` 让无障碍树也拿不到。**这正是你看到的「第 5 项没有点」——不是设计，是一个坏掉的 class name。** 全仓仅此一处误用（`TimelineHookRows.tsx:268`）。

净效果：绿点在这个面板里等于噪音（3 个恒绿 + 2 个条件绿），唯一有信息量的「未就绪」信号则物理不可见。

### 逐组件状态分支缺口

| 组件 | loading | empty | error | 缺口 |
|---|---|---|---|---|
| `HookRows` | ✅ `hk_config_loading` | ✅ `timeline_hook_empty` | ⚠️ `loadError` **只在 `event==='UserPromptSubmit'` 分组里渲染**（`:43`），其余 3 个时机组只显示 `'—'`，用户以为"这个时机没 hook" | 错误定位错乱 |
| `SkillOrchestrationDialog` | — | ⚠️ 库空态有 | ❌ **registry 加载失败无分支**（`registry: WbSkillEntry[] \| null \| undefined`，null/undefined 都退化成空库） | 加载失败伪装成"没有可用 Skill" |
| `TimelineStageStrip` | ❌ | ❌ | ❌ | 三态全无（0/0/0） |
| `TrackEditorFields` | ❌ | ❌ | ❌ | 三态全无 |
| `WorkbenchSideRail` | ❌ | ❌ | ❌ | 三态全无 |
| `WorkflowPolicyRuntimeSummary` | ❌ 无 loading | ✅ 3 处 | ❌ 无 error | 快照拉取中/失败不可辨 |
| `AdapterInstallWizard` | ✅ | ✅ `select_project` | ⚠️ `phase='failed'` 不进 error 区 | 见 §四 |
| `GovernanceRail`（预算） | ❌ | — | ⚠️ 有错但不回滚 | 见 §二 |
| `StepPolicyEditor` | ❌ 无 loading | ✅ 5 处 | ⚠️ 1 处 | 29 个控件仅 1 处错误分支 |
| `TrackSettingsList` / `GovernanceRailHead` / `GovernancePromoteDialog` / `LoopGoalFields` | ❌ | ❌ | ❌ | 三态全无 |

---

## 八、缺陷清单

### P0

**P0-1 · workflow 只读态错误吞掉 hooks.json 运行时开关**
- 证据：`TimelineHookRows.tsx:84`（`locked || readonly`）← `ExecutionTimelineComposer.tsx:195,338` ← `WorkbenchView.tsx:544` ← `:213 readonlyWf = wfName === 'default'`
- 违反本仓自述契约：`HookTimeline.tsx:35-36`「default workflow 只读态下本区照常可切……与 StepEditor 的 readonly 无关」
- 用户可感知的坏结果：**停在默认落地页（default workflow）的用户完全无法开关任何 hook**，8 行全是锁，且界面不解释为什么。用户会认定"这个产品的 hook 是不能配的"。
- 修复方向：`HookRows` 的开关只应由 `hook.configurable` 决定，`readonly` prop 不参与 hook 开关的可用性判断（仅作用于 workflow def 草稿类控件）。

**P0-2 · 能力矩阵被凭空推导，registry.yaml 从未被读**
- 证据：`packages/server/src/definitionCatalog.ts:124-128`（`inject: true` / `veto: tier === 'A'` / `track: tier !== 'C'`）；`:30-33` 手抄第二份 tier 表；`definitionCatalogTypes.ts:11` 布尔化；全仓 TS 零处读 `adapters/registry.yaml`
- 用户可感知的坏结果：Cursor/Copilot 用户被告知"无 veto"（实际有 native 硬拦），全体降级 host 被告知"有 inject"（实际只有静态 rules 文件）。**用户据此做的安全假设是错的。**
- 修复方向：capabilities 改为 `'native' | 'degraded' | 'none'` 三态，从 `registry.yaml` 的 `*_status` 直读，删掉 `ADAPTER_TIERS` 手抄表。

**P0-3 · 能力/降级信息在 UI 上完全不可见**
- 证据：`AdapterInstallWizard.tsx:116` 只渲染 `Tier {tier}`；`capabilities.*` 全仓仅出现在类型校验（`definitionCatalogClient.ts:19-20`）
- 用户可感知的坏结果：用户无法回答"我这个终端的 veto 是不是降级的"。契约诚实性缺口。
- 修复方向：适配器卡片展示 inject/veto/track 三能力 chip（native/降级/无），降级项附 `inject_fallback` 落点说明。

### P1

**P1-1 · 「启用」是动词形状的静态标签，且用主行动蓝**
- 证据：`TimelineHookRows.tsx:100`；`translations.ts:1610`（对比 `:1588` 的「已启用」、`:4178` 的 `Enabled`）
- 坏结果：用户反复点击一个不响应的蓝字，判定产品坏了。
- 修复方向：中文改「已启用/已停用」；只读态改用中性色而非 `text-accent-d`；若保留开关则移除冗余文字标签。

**P1-2 · 三档 hook 语义压成两档，诚实实现是死代码**
- 证据：live `TimelineHookRows.tsx:58` vs 未挂载的 `HookTimeline.tsx:265-266,282-286` / `OrchestrationHookBody.tsx:45-46,59-60`；`OrchestrationBoard.test.tsx:2042,2076` 测的是未挂载组件
- 坏结果：「强制常开的安全门」和「后端还没接线的 hook」在界面上长得一模一样；`:57` 还会对强制常开 hook 显示「停用」（撒谎）。
- 修复方向：把 `OrchestrationHookBody` 的三档判定移植进 `HookRows`，或直接复用；清理 2 个未挂载组件及其 2200+ 行假绿灯测试。

**P1-3 · `bg-amb` 是不存在的 class，未就绪的点不可见**
- 证据：`TimelineHookRows.tsx:268`；`src/index.css:165-167` 无裸 `--color-amb`；`dist/assets/*.css` 无 `.bg-amb{}`
- 坏结果：**「执行指令 · 尚未填写」失去唯一的视觉未就绪信号**（正是你观察到的现象）。
- 修复方向：改 `bg-amber-d`（已存在），或在 index.css 补 `--color-amb`。

**P1-4 · 「运行前事实」5 点里 2 点恒绿**
- 证据：`ExecutionTimelineComposer.tsx:382,383` 的裸 `ready`
- 坏结果：绿点失去指示意义，用户学会忽略整个面板。

**P1-5 · 主写路径无 CAS，并发编辑后写覆盖**
- 证据：`governanceClient.ts:219-225`（workflow）、`:92-109`（hook）、`:234-245`（mandatory，持有 revision 却不发）
- 坏结果：两个标签页/两台机器同时编辑，先保存者的改动无声消失，双方都看到"保存成功"。
- 修复方向：写请求带 `fingerprint`/`revision`，server 返 409 时前端给出"已被他人修改"专属分支 + 重载入口。

**P1-6 · 「Workflow 策略」与「Workflow 策略运行时摘要」视觉无区分**
- 证据：`WorkbenchView.tsx:505-537`；`translations.ts:1404 / 1449 / 1377`
- 坏结果：用户分不清点哪个；且 `advanced_show` 永不切换成 `advanced_hide`（对比正确写法 `loopCardModel.tsx:73`）。

**P1-7 · 适配器安装：失败不进错误区 + 无终局汇总 + phase 未翻译 + 15 分钟静默死锁**
- 证据：`AdapterInstallWizard.tsx:80-84`（complete 只 setBusy）、`:100`（setTimeout(stop) 不解锁 busy）、`:119`（裸 `state.phase`，`exit_code` 未渲染）；`definitionCatalogClient.ts:150-155`（close 不触发回调）
- 坏结果：装失败的界面看起来像装成功了；中文界面里蹦出英文枚举；流挂起后按钮永久变灰无提示。

**P1-8 · Skill 编排弹窗无脏态提示**
- 证据：`SkillOrchestrationDialog.tsx:10-19`（仅 4 个回调，全文件无 dirty/busy/error state）
- 坏结果：用户在模态里编排完关掉，不知道还得去外层点保存，直接切走 → 改动丢失。

**P1-9 · Hook 配置加载失败只在一个时机分组里报错**
- 证据：`TimelineHookRows.tsx:43`（`config.loadError && event === 'UserPromptSubmit'`），其余分组走 `:48` 的 `'—'`
- 坏结果：另外 3 个时机看起来像"这里没有 hook"，而不是"没读到"。

**P1-10 · 「内置 Hook」徽章硬编码**
- 证据：`TimelineHookRows.tsx:97` 无条件渲染；`governanceTypes.ts:3-9` 的 `WbHookMeta` 无 source 字段
- 坏结果：适配器/插件装进来的 hook 一律被标成「内置」，来源不可追溯。

### P2

- **P2-1** 锁图标无可及名与解释：`TimelineHookRows.tsx:84` `aria-hidden="true"` 且无 tooltip；行 `title`（`:77-82`）只给技术详情。屏幕阅读器用户完全感知不到只读态。
- **P2-2** token 预算滑杆无 busy、失败不回滚：`GovernanceRail.tsx:118-145`（`:141` 注释「即时回显」）。
- **P2-3** 治理级别/预算/强制 Skill 三处写成功无确认反馈。
- **P2-4** `AdapterInstallState.exit_code` 解码后从不渲染：`definitionCatalogTypes.ts:74` / `definitionCatalogClient.ts:58`。
- **P2-5** tier 说明文案硬编码、不从 registry 派生：`translations.ts:197,200,203`（`tier_a_hosts` 等）。
- **P2-6** 六个组件三态全缺：`TimelineStageStrip` / `TrackEditorFields` / `WorkbenchSideRail` / `TrackSettingsList` / `GovernanceRailHead` / `LoopGoalFields`。
- **P2-7** `WorkbenchView.tsx:287-296` `switchTo()` 不检查 dirty 直接丢弃草稿。
- **P2-8** `WorkbenchView.tsx:274-275` 保存成功用请求发出时的快照覆盖基线，在途编辑会被错误标记为已保存。
- **P2-9** 认知负荷：单页 101 处静态控件声明、最深 ~14 层 DOB 嵌套、hook 开关需六级下钻。

---

## Caveats / Not Found

- 本轮为**纯静态代码审计**，未在 http://127.0.0.1:18765 上做运行时验证。`bg-amb` 的不可见性通过检查 `dist/assets/*.css` 产物（`.bg-amb{}` 缺失）+ `src/index.css` token 表交叉确认，可信度高；只读态锁图标通过 `readonlyWf` 完整调用链确认，可信度高。
- 未审计 server 端 `/api/hooks`、`/api/workflows`、`/api/tracks` 的实际写入实现与 409 行为——本报告的 CAS 结论仅覆盖**前端是否发送/处理版本令牌**。server 是否在 track 路由上真正执行 CAS 未验证。
- 未审计 `adapters/install.sh` 与 CLI 侧的实际安装语义，第四问的结论限于「UI 能表达什么」，未追到 CLI 究竟回传了什么粒度的 message。
- `SolutionView.tsx` 不在给定审计范围内，只在第五问追踪 tier 文案时顺带引用。
- 控件计数为 JSX **静态声明数**，非运行时实例数；实例数因列表渲染显著更高，报告中已注明。
