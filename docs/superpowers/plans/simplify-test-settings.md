# 测试设置简化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：把每步十几个字段的测试策略收成一个档位选择，档位含义、阈值放进项目测试目录。同时去掉逐个登记、场景映射、按检出信任、固定代码规模上限、绝对路径和测试输出污染指纹这些手工负担。

**Architecture**：
- **档位求值**：工作流步骤只记档位名；求值时由 M1 `resolveStepTestPolicy` 把档位（读目录 `levels`，没写用缺省）或旧 `test_policy` 统一成一个有效策略。
- **运行集**：由 M2 `stageRunSet` 结合目录与本任务改动算出，`evaluate-v2` 与 `tenon test run --stage` 共用。
- **认领**：改动过的测试文件由 M3 `claimChangedTestFiles` 在求值时认领。
- **其余**：目录写回（M4）、信任存储（M5）、路径改写（M6）、指纹规则（M7）各自独立。

**Tech Stack**：TypeScript ESM（Node 22）、Vitest、bash 3.2 hooks、React（Dashboard）、esbuild bundle。不新增 npm 依赖。

**Spec**：
- `openspec/changes/simplify-test-settings/specs/test-settings/spec.md`、`specs/step-test-waiver/spec.md`、`specs/workspace-verification-integrity/spec.md`；
- 设计 `docs/superpowers/specs/simplify-test-settings-design.md`；
- ADR `docs/adr/simplify-test-settings.md`。

## Global Constraints

- **范围**：只改测试相关的代码与键，其余属于并行任务 `rework-document-mechanism`，不碰：
  - `document-contract`、`effective-io`；
  - YAML 的 `inputs` / `outputs` / `document_contract` 键；
  - `document` / `artifact` 命令及其 `next` 动作行。
- **共用文件只改测试相关段落**：`templates/workflows/default.yaml`、`skills/tenon/SKILL.md`、`docs/usage/*`、`docs/CONTRACT.md`、发布说明、`statusStep*`。
- **生成物只用脚本重新生成，禁止手改**：
  - `npm run generate:default-workflow` → `packages/kernel/src/workflow/default-workflow.generated.ts`；
  - `npm run build` → `packages/*/dist`。
- **兼容**：
  - 没写 `test` 的工作流编译结果与指纹逐字节不变；
  - 旧 `test_policy` 只把 `files: registered` 改为认领，其余语义不变；
  - 目录没写 `levels` 时目录摘要不变。
- **代码规范**：
  - 新增或修改的生产代码不得有显式 / 隐式 `any`、非空断言；外部输入先以 `unknown` 接收再收窄。
  - 生产文件超过 500 行必须拆分；新逻辑放进新模块。
- **测试隔离**：测试不得读写真实的 `~/.claude`、`~/.codex`、`~/Library/Application Support/tenon`。
  - 用户级状态一律经 `resolveProductPaths`，测试注入 `TENON_RUNTIME_HOME` / `TENON_RUNTIME_ROOTS` 指向临时目录。
  - vitest 的隔离脚本已经为每个测试文件设置 `TENON_RUNTIME_HOME`，集成测试用 `freshHarness`。
- **改文件**只用 Edit / Write；shell 一次只做一件事。hook 套件用 `npm run test:hooks`，vitest 用 `npx vitest run <文件>`。被 hook 拦下就停下报告，不绕过。
- **不提交**：不 `git commit`；交付提交由 Tenon 的 `next` 在交付步统一做。
- **不碰信任**：不运行 `tenon test trust`，不设置 `TENON_TEST_TRUST`，不运行 `tenon setup --from-source`。
- **测试类**：`unit`、`integration`、`e2e`、`static`、`benchmark`、`custom`。归类规则：
  - `unit`、`coverage` → `unit`；
  - `integration`、`regression`、`contract`、`smoke` → `integration`；
  - `e2e`、`playwright`、`browser`、`a11y`、`visual` → `e2e`；
  - `typecheck`、`lint`、`code-size`、`design-system` → `static`。
- **测试文件源码扩展名**：js、jsx、ts、tsx、mjs、cjs、mts、cts、py、go、rs、java、kt、rb、php、cs、swift、scala、vue、svelte。
- **控制目录**（测试改动判定时排除）：`openspec/`、`.tenon/`、`.pipeline/`。
- **证据扩展名**（指纹规则）：log、txt、xml、md、csv、png、jpg、jpeg、gif、webp、webm、mp4、lcov、info。json、html、htm、zip、gz、har 不在名单里（能被代码或浏览器直接加载、解包，照旧计入，由目录声明放行）。
- **信任的仓库判定**：
  - 只有检出目录及其所有上级都没有 `.git` 才算「不是 git 仓库」，这时认检出旧封存。
  - git 仓库里一律不认检出旧封存，不论是否被跟踪，信任只来自用户级存储（Task 14）。
  - 有 `.git` 却读不出身份（git 出错、超时、不可用、伪造指针）一律未信任。
- **没写 `covers` 的提示**：`changed` / `full` 档里，`required` 或 `touched` 类有套件没写 `covers`、没进运行集，而本任务改了源码文件（控制目录之外、源码扩展名、不是测试文件）时，出不阻断的提示 `suites-without-covers`；`tenon test status` 与 `--stage` 都打印（Task 15c）。
- **评审请求里的豁免理由**：单行化、去控制字符与双向字符、反引号与尖括号换全角，不截短；受保护改动的路径与摘要只去控制字符（Task 14b）。
- **档位缺省**：
  - `plan`：`required: [unit]`；
  - `changed`：`required: [unit]`、`touched: [static]`；
  - `full`：`required: [unit]`、`touched: [integration, e2e, static, benchmark]`；
  - 三档都是 `scenarios: off`、`require_baseline: false`，无覆盖率与不稳定用例门槛。

## Review Focus

1. **目录文件的字节级保留**：CRLF 换行、行尾空格、没有结尾换行、`---` 开头的目录，经 `patchCatalogText` 改一个键后，其余字节必须与原文逐字相同。→ Task 5 的保留测试覆盖这四种输入。
2. **路径写法差异**：
   - 仓库根含空格或中文；
   - macOS 临时目录 `/var/...` 与 `/private/var/...` 互为真实路径。
   - 相对化与信任身份都必须认出同一个仓库。→ Task 8 与 Task 7 各加一条用 `realpath` 差异的用例。
3. **信任遇到异常的 worktree 状态**：
   - worktree 被删除，`git worktree list` 里留下 prunable 条目；
   - 当前目录是 git 子目录，不是检出根。
   - 信任判定必须失败关闭，或正确取检出根。→ Task 7。
4. **目录无效时不能静默放行**：档位策略在目录无效时用缺省档位求值，但照旧出 `test-catalog-missing` 阻断。→ Task 4 的求值测试。
5. **并发写信任**：两个 worktree 同时 `tenon test trust`，用户级信任文件不丢条目、封印有效（锁 + 原子替换）。→ Task 7 的并发用例。

---

## 执行分波

| 波次 | 执行位置 | 任务 |
|---|---|---|
| 1 | 任务主 worktree | Task 1 → 2 → 3 → 4（内核主线，串行） |
| 1 | 独立 worktree `sts-trust` | Task 7（信任存储） |
| 1 | 独立 worktree `sts-evidence` | Task 8 → 9（相对路径、指纹规则） |
| 2 | 独立 worktree `sts-catalog` | Task 5（保留注释写回、`--auto`），基于第 1 波合并后的状态 |
| 2 | 独立 worktree `sts-ui` | Task 10（server DTO 与 Dashboard），基于第 1 波合并后的状态 |
| 2 | 任务主 worktree | Task 6 → 11（场景与豁免展示、default 工作流 / 技能 / 文档） |
| 3 | 任务主 worktree | Task 12（端到端集成测试、全量回归、构建与新鲜度检查） |

独立 worktree 由主线从任务主 worktree 当前状态建立：先应用主线当时的未提交改动，执行者不提交。主线收回补丁时用 `git diff` 应用回任务主 worktree，逐项验收。

---

### Task 1: 测试类与测试文件名规则

**Files:**
- Modify: `packages/kernel/src/test-system/vocabulary.ts`
- Create: `packages/kernel/src/test-system/test-paths.ts`（控制目录过滤、源码扩展名判定）
- Modify: `packages/kernel/src/test-system/index.ts`（导出）
- Test: `packages/kernel/src/test-system/vocabulary.test.ts`、`packages/kernel/src/test-system/test-paths.test.ts`

**Interfaces:**
- Produces（`vocabulary.ts`）：
  - `TEST_KINDS` 增加 `'static'`；
  - `TEST_CLASSES = ['unit','integration','e2e','static','benchmark','custom'] as const`，`type TestClass = typeof TEST_CLASSES[number]`；
  - `isTestClass(value: unknown): value is TestClass`；
  - `testClassOf(kind: TestKind): TestClass`；
  - `EXIT_CODE_KINDS` 增加 `static`；
  - `kindRunnerProblem` / `kindFormatProblem` 对 `static` 的放行规则与 `typecheck` 和 `lint` 的并集相同。
- Produces（`test-paths.ts`）：
  - `TEST_CONTROL_DIRS = ['openspec', '.tenon', '.pipeline'] as const`；
  - `withoutControlPaths(paths: readonly string[]): string[]`：去掉首段在控制目录里的路径；
  - `TEST_SOURCE_EXTENSIONS`；
  - `hasTestSourceExtension(path: string): boolean`。
- Changes：`looksLikeTestFile(path)` 改为原规则成立**且** `hasTestSourceExtension(path)`。`claim-orphans.ts` 的 `CLAIMABLE_NAME` 在 Task 5 改用它。

- [ ] **Step 1: 写失败的测试**
  - `testClassOf`：`coverage`→`unit`；`regression`/`contract`/`smoke`→`integration`；`playwright`/`browser`/`a11y`/`visual`→`e2e`；`typecheck`/`lint`/`code-size`/`design-system`/`static`→`static`；`benchmark`→`benchmark`；`custom`→`custom`。
  - `looksLikeTestFile`：
    - 以下 MUST 为 false：`openspec/changes/archive/x/.pipeline-run/review-attempt-reports/a.spec.report`、`fixtures/data.spec.json`、`e2e/fixtures/seed.json`；
    - 以下 MUST 为 true：`src/a.test.ts`、`test_x.py`、`x_test.go`、`e2e/dashboard/a.spec.ts`、`bench/a.bench.mjs`。
  - `withoutControlPaths(['openspec/a.test.ts', '.tenon/x.test.js', '.pipeline/y', 'src/a.test.ts'])` 等于 `['src/a.test.ts']`。
  - 目录解码接受 `kind: static`，并接受 `kind: static` 搭配 `runner: tsc`、`report.format: exit-code`。
- [ ] **Step 2**：`npx vitest run packages/kernel/src/test-system/vocabulary.test.ts packages/kernel/src/test-system/test-paths.test.ts`，预期失败。
- [ ] **Step 3**：实现。
- [ ] **Step 4**：同一命令通过；再跑 `npx vitest run packages/kernel/src/test-system`，确认既有测试不回归。

### Task 2: 工作流步骤的 `test` 档位键

**Files:**
- Modify：
  - `packages/kernel/src/workflow/types.ts`（`StepDef.test?: TestLevel`）
  - `ir.ts`（`StepIR.test?: TestLevel`）
  - `compile.ts`（允许键 `test`；与 `test_policy` 互斥；只在声明时进 IR）
  - `parse.ts`（YAML 解析 `test:` 标量）
  - `serialize.ts`（写回 `test:`）
- Create：`packages/kernel/src/workflow/test-level.ts`（`TEST_LEVELS = ['none','plan','changed','full'] as const`、`type TestLevel`、`isTestLevel`）
- Test：`packages/kernel/src/workflow/test-policy.test.ts`（追加），或新建 `packages/kernel/src/workflow/test-level.test.ts`

**Interfaces:**
- Produces：`TestLevel`、`TEST_LEVELS`；`StepIR.test?: TestLevel`；`stepDeclaresTests(step: Pick<StepIR,'test'|'test_policy'|'tests'>): boolean`。它在 `test` 不是 `none`、或有 `test_policy`、或有 `tests` 时为 true，供只关心「本步有没有测试要求」的调用方使用。

- [ ] **Step 1: 写失败的测试**
  - YAML 步骤写 `test: changed` → 编译后 `step.test === 'changed'`；serialize → parse 往返不变。
  - 同一步 `test: full` + `test_policy: {...}` → `compileWorkflow` 抛错，信息含步骤 id 与「test 与 test_policy 只能写一个」。
  - `test: quick` → 报错，并列出 `none | plan | changed | full`。
  - 回归：`templates/workflows/default.yaml` 当前版本（尚未改档位）编译结果的 JSON 与修改前逐字节相同（对比 `default-workflow.generated.ts` 的快照）。
  - 服务端的结构化输入 `decodeWorkflowDef` 走同一条校验链（`compile.ts:395`），在同一测试文件覆盖。
- [ ] **Step 2–4**：`npx vitest run packages/kernel/src/workflow`：先失败，实现后通过（含 `default-yaml-rules.test.ts`、`template-workflows.test.ts`、`generate-default-workflow.test.ts`）。

### Task 3: 目录的 `levels` 档位定义

**Files:**
- Modify：
  - `packages/kernel/src/test-system/catalog-types.ts`（`TestCatalog.levels?: CatalogLevels`）
  - `catalog-decode.ts`（顶层键 `levels` 的闭集校验、行号报错）
  - `catalog.ts`（`serializeTestCatalog` 写出 `levels`；没声明时省略，摘要不变）
- Create：`packages/kernel/src/test-system/levels.ts`（类型、缺省、合并）
- Test：`packages/kernel/src/test-system/levels.test.ts`、`catalog.test.ts`（追加）

**Interfaces:**

```ts
// levels.ts
export interface LevelThresholds {
  readonly scenarios: 'off' | 'required' | 'passing'
  readonly coverage?: Readonly<Partial<Record<CoverageMetric, number>>>
  readonly flaky?: { readonly max: number; readonly fail_on_new: boolean }
  readonly require_baseline: boolean
}
export interface ResolvedLevel extends LevelThresholds {
  readonly name: 'plan' | 'changed' | 'full'
  readonly required: readonly TestClass[]
  readonly touched: readonly TestClass[]   // plan 档恒为 []
  readonly source: 'catalog' | 'default'   // 档位整体来自目录或缺省（目录写了这一档任意键即为 catalog）
}
export type CatalogLevels = Partial<Record<'plan' | 'changed' | 'full', Partial<Omit<ResolvedLevel, 'name' | 'source'>>>>
export const DEFAULT_LEVELS: Readonly<Record<'plan' | 'changed' | 'full', ResolvedLevel>>
export function resolveLevel(name: 'plan' | 'changed' | 'full', catalog: TestCatalog | undefined): ResolvedLevel
```

- [ ] **Step 1: 写失败的测试**
  - 没有 `levels` 时，`resolveLevel('full', catalog)` 等于缺省（见 Global Constraints），`source: 'default'`。
  - `levels.full.coverage.lines: 80` 只覆盖该键，`required` / `touched` 仍是缺省，`source: 'catalog'`。
  - 解码以下几种写法时失败，且报出行号：
    - `levels.changed.scope: full`（未知键）；
    - `levels.plan.touched: [static]`（plan 档不接受）；
    - `levels.full.required: [foo]`（未知类）；
    - `levels.quick: {}`（未知档）；
    - `levels.full.coverage.lines: 120`（超出范围）。
  - 没写 `levels` 的目录：`catalogDigest` 与修改前相同（用 `.tenon/tests/catalog.yaml` 的真实文本做快照对比）。写了 `levels` 后摘要改变。
- [ ] **Step 2–4**：`npx vitest run packages/kernel/src/test-system/levels.test.ts packages/kernel/src/test-system/catalog.test.ts`：先失败，实现后通过。

### Task 4: 档位求值、阶段运行集与认领（内核与 CLI 主线）

**Files:**
- Create：
  - `packages/kernel/src/test-system/resolve-policy.ts`（M1）
  - `packages/kernel/src/test-system/stage-run-set.ts`（M2）
  - `packages/kernel/src/test-system/claim.ts`（M3）
- Modify（kernel）：
  - `workflow/ir.ts`：`StepTestPolicyIR.level?: ResolvedLevel`，只在档位派生的策略上出现。
  - `test-system/policy.ts`：`stepTestRequirements(step, catalog)` 改用 M1。
  - `evaluate-v2.ts`：`checkKinds` / `checkFiles` / `runSet` 改用 M2 / M3；认领文件的执行检查。
  - `evaluate-suite.ts`：执行检查接受认领文件。
  - `evaluate-types.ts`、`load.ts`、`test-evidence/evaluate.ts:264`、`test-support.ts:40`、`workflow/orchestration.ts:181`（只需判断「有无测试」或「必跑类」）。
- Modify（cli）：
  - `test-system/run-set.ts`：`--stage` 改用 M2；空运行集合法。
  - `test-system/run-orchestrator.ts:137-140`、`test-system/plan-context.ts:55`。
  - `test-system/plan-edit.ts`：`seedPlan` 对档位策略不写套件 / 文件，旧策略不再写文件。
  - `commands/test-run-suites.ts:99-102`、`commands/agent.ts:47`、`commands/test-integrity.ts:45`、`commands/test-report.ts:63`、`commands/verify-ci-policy.ts:20`、`commands/init.ts:382`、`commands/statusStepTests.ts`（下发规则）、`commands/test-status.ts`。
  - `integration-test-flow-support.ts:151`、`integration-harness-legacy.ts:200`。
- Test：
  - `packages/kernel/src/test-system/resolve-policy.test.ts`、`stage-run-set.test.ts`、`claim.test.ts`、`evaluate-v2.test.ts`（追加）
  - `packages/cli/src/test-system/plan-edit.test.ts`、`run-set` 的测试（追加）
  - `packages/cli/src/commands/statusStepTests.test.ts`（追加）

**Interfaces:**

```ts
// resolve-policy.ts（M1）
/** 档位或旧策略 → 有效策略；none / 未声明 → undefined。档位派生的策略带 level，kinds/run/run_if_registered 为空。 */
export function resolveStepTestPolicy(
  step: Pick<StepIR, 'test' | 'test_policy'>,
  catalog: TestCatalog | undefined,
): StepTestPolicyIR | undefined
// 档位 → IR 的映射：plan: 'required'；scope: name === 'full' ? 'full' : 'changed'（plan 档也记 'changed'，它不跑套件）；
// files: 'any'；scenarios/coverage/flaky 来自档位；benchmark: { require_baseline }；browsers: []；level: ResolvedLevel。

// claim.ts（M3）
export interface ChangedTestFiles {
  /** 套件 id → 本任务改动过、被该套件 files glob 认领的测试文件（仓库相对、排序）。 */
  readonly claimed: ReadonlyMap<string, readonly string[]>
  /** 像测试却没有任何套件认领的改动文件。 */
  readonly orphans: readonly string[]
}
export function claimChangedTestFiles(changedFiles: readonly string[], catalog: TestCatalog): ChangedTestFiles
// 先 withoutControlPaths，再按 suitesOwningFile 认领；不被认领且 looksLikeTestFile 的进 orphans。

// stage-run-set.ts（M2）
export interface StageRunItem {
  readonly suite: CatalogSuite
  readonly scope: PlanScope
  readonly reason: 'run' | 'if-registered'
  readonly pattern?: string
  readonly files?: readonly string[]
}
export interface StageRunSet {
  readonly items: readonly StageRunItem[]      // 按目录顺序、按 id 去重
  readonly missingClasses: readonly TestClass[] // 仅档位策略：required 类在目录里没有套件，且没有已批准的项目级不适用声明
}
export function stageRunSet(input: {
  readonly policy: StepTestPolicyIR
  readonly catalog: TestCatalog
  readonly plan: TestPlan | undefined
  /** undefined = 读不到改动列表（调用方另出 files-diff-unavailable）。 */
  readonly changedFiles: readonly string[] | undefined
}): StageRunSet
```

规则（逐字实现）：
- **「被改动碰到」**：改动文件经 `withoutControlPaths` 后，匹配套件 `files` 或 `covers` 的任一 glob（复用 `plan-edit.ts` 里 `touches` 的口径；把 `touches` 移进 kernel 的 `stage-run-set.ts` 并导出，`plan-edit.ts` 改为导入）。
- **档位 `changed`**：`required` ∪ `touched` 类里被碰到的套件，`scope: 'changed'`，`reason` 为 `required` 时 `'run'`、否则 `'if-registered'`。
- **档位 `full`**：
  - `required` 类的全部套件，`scope: 'full'`，`reason: 'run'`；
  - `touched` 类里被碰到的套件，`scope: 'full'`，`reason: 'if-registered'`。
- **档位 `plan`**：`items: []`。
- **所有档位**：
  - 计划里显式登记的套件追加为 `reason: 'run'`；`full` 档 `scope: 'full'`，否则沿用计划登记的范围与 `pattern` / `files`。
  - `changedFiles === undefined` 时只返回计划里显式登记的套件，再加上 `full` 档的 `required` 类套件。
- **`missingClasses`**：档位的 `required` 类在目录里没有任何套件（按 `testClassOf` 归类），且没有已批准的项目级不适用声明（`testClassOf(entry.kind)` 等于该类）。
- **旧策略（`policy.level === undefined`）**：
  - 计划套件按 `policyRunReason` 过滤（现有逻辑原样搬入）；
  - 再追加认领文件所属、种类在 `run` ∪ `run_if_registered` 里且不在计划中的套件，`scope` 取 `policy.scope === 'full' ? 'full' : 'changed'`。
  - `missingClasses: []`，旧的 `checkKinds` 逻辑不变。

evaluate-v2 的改动：
- `runSet()` 改为调用 `stageRunSet`。
- `checkKinds`：档位策略按 `missingClasses` 出 `test-kind-missing`。修复命令沿用现有两种文案（补套件 / 项目级不适用）。另外，计划里有该类的已批准种类豁免（`waivers[].kind` 等于类名）时也算满足。
- `checkFiles`：
  - 档位策略（`changed` / `full`）与旧 `files: registered` 都改为只报孤儿（`test-file-orphan`，修复命令 `tenon test register <c> --auto`）；
  - 不再产生 `test-file-unregistered`（码保留在词表里，供旧报告显示）；
  - 读不到改动列表照旧 `files-diff-unavailable`；
  - 报告的 `files` 字段新增 `claimed: Array<{ path, suites }>`。
- **认领文件的执行检查**：
  - `evaluateSuiteResult` 接收本套件的认领文件。范围为 changed 时只查 `selection` 里的；没有 selection（退回全量）时全查。
  - 查出未执行的文件先收集起来，所有套件判完后，只对**每个跑过的认领套件里都没执行**的文件出 `registered-test-not-executed`。
- **`checkProtected`**：现有逻辑在 `input.policy.files === 'registered'` 时把读不到改动列表视为阻断。改为：档位策略的 `changed` / `full` 也按阻断处理。

CLI 的改动：
- **`planRunSet` 的 `--stage` 分支**改用 `stageRunSet`。空运行集时返回 `{ items: [] }`，`test-run-suites.ts` 打印「本阶段按档位没有需要运行的套件」并以 0 退出，不写运行记录。只有旧策略 `run` 非空、却没有套件时，才保留原来的错误。
- **`seedPlan`**：
  - 档位策略不加套件、不加文件，只报告 `missingKinds`（= `missingClasses`），以及档位要求场景映射时的 `unmapped`；
  - 旧策略只保留「碰到的套件」与「必需种类」两项补齐，不再写 `files`；
  - 计划不存在时照常创建空计划。
- **`statusStepTests.ts`**：
  - `files` 类只会有孤儿；
  - `test-register-files` 动作的 `files` 只列孤儿，`fix` 统一为 `tenon test register <c> --auto`；
  - `test-plan-map` 的 `items` 不再含 `scenario-uncovered`，除非策略的 `scenarios` 不是 `off`（求值器已按此出阻断，这里只是透传）。
- **其余调用方**：一律改为 `resolveStepTestPolicy(step, catalog)`。只判断「有没有测试要求」的地方用 `stepDeclaresTests`。

- [ ] **Step 1: 写失败的测试（kernel）**
  - `resolve-policy.test.ts`：
    - `test: none` → undefined；
    - `test: changed` 在没有 `levels` 的目录下 → `scope: 'changed'`、`files: 'any'`、`level.required` 为 `['unit']`；
    - `test_policy` 原样返回；
    - 目录为 undefined 时用缺省档位。
  - `claim.test.ts`：
    - 改动 `['src/a.test.ts','openspec/changes/archive/x/a.spec.report','fixtures/d.spec.json','tools/x.test.mjs']`，目录只有一个 `unit` 套件（`files: ['src/**/*.test.ts']`）→ `claimed` 为 `unit:['src/a.test.ts']`，`orphans: ['tools/x.test.mjs']`。
  - `stage-run-set.test.ts`（设计文档 §5 与 spec「阶段运行集」的各个场景逐条落成用例）：
    - 跑改动只跑被碰到的套件（`unit` 覆盖 `src/**`，`docs-unit` 覆盖 `docs/**`，只改 `src/a.ts`）；
    - 只改 `README.md` 时为空；
    - `full` 档必需类全量、`hooks` 只在改了 `hooks/gate.sh` 时加入；
    - 计划显式套件追加；
    - `changedFiles` 为 undefined 时的退化；
    - 旧策略：计划套件过滤 + 认领套件追加；
    - `missingClasses`：没有 unit 类套件 → `['unit']`；`kind: coverage` 的套件满足 unit；已批准的不适用声明满足。
  - `evaluate-v2.test.ts` 追加：
    - 新增测试文件不出 `test-file-unregistered`；
    - 孤儿出 `test-file-orphan`；
    - 认领文件未执行出 `registered-test-not-executed`；
    - 两个认领套件之一执行过则不出；
    - 档位策略在目录无效时照旧出 `test-catalog-missing`（Review Focus 4）；
    - 旧策略 `files: registered` 不再要求登记；
    - 没写 `test` 的旧策略在同样输入下，除 `test-file-unregistered` 外，阻断码与修改前相同。
- [ ] **Step 2: 写失败的测试（cli）**
  - `plan-edit.test.ts`：档位策略 `seedPlan` 后 `suites` / `files` 为空；旧策略不再写 `files`。
  - `run-set` 测试：`--stage` 在档位策略下与 `stageRunSet` 一致；空运行集返回 `{ items: [] }`。
  - `statusStepTests.test.ts`：只有孤儿时下发一条 `test-register-files`，`fix` 为 `--auto`；没有孤儿、只有新增被认领文件时不下发。
- [ ] **Step 3**：先跑 `npx vitest run packages/kernel/src/test-system packages/cli/src/test-system packages/cli/src/commands/statusStepTests.test.ts`，确认新增用例失败。
- [ ] **Step 4**：实现。
- [ ] **Step 5**：同一命令全部通过；再跑 `npx vitest run packages/cli/src/test-flow.integration.test.ts packages/cli/src/test-flow-lite.integration.test.ts packages/cli/src/test-system-plan.integration.test.ts`。其中断言 `test-file-unregistered` 的用例按新规则改写：登记步骤删除，断言改为「无登记类阻断」。
- [ ] **Step 6**：`npm run build` 通过（类型检查）。

### Task 5: 测试目录保留注释写回、`--auto` 只追加精确路径

**Files:**
- Create：`packages/kernel/src/test-system/catalog-patch.ts`（M4）
- Modify：`packages/kernel/src/test-system/catalog-file.ts`（`updateCatalog` 改用 M4）、`packages/cli/src/test-system/claim-orphans.ts`（精确路径；用 `looksLikeTestFile`）、`packages/cli/src/commands/test-register-auto.ts`（只处理本任务改动里的孤儿）
- Test：`packages/kernel/src/test-system/catalog-patch.test.ts`、`catalog-file.test.ts`（追加）、`packages/cli/src/test-system/claim-orphans` 的测试与 `packages/cli/src/test-sync-prune.integration.test.ts` 邻近新增 `packages/cli/src/test-register-auto.integration.test.ts`

**Interfaces:**

```ts
/** 只替换 before → after 实际变化的节点所在行；其余字节原样。节点三层：顶层键 / suites 条目 / 条目内键（列表键的新增项追加在列表末尾）。
 *  返回的文本 MUST 能被 parseTestCatalog 解析成与 after 深相等的目录，否则抛错（调用方不写盘）。 */
export function patchCatalogText(text: string, before: TestCatalog, after: TestCatalog): string
```

- 实现方式：用 `yaml-subset.ts` 解析原文得到带行号的节点。变化的节点按 `serializeTestCatalog` 的同一套发射规则单独发射，替换掉它的行区间。
  - 区间 = [节点起始行, 下一个同级节点起始行) 去掉尾部的空行与整行注释（它们属于下一个节点）。
  - 缩进按原节点的缩进。
  - 换行符沿用原文：原文有 `\r\n` 就用 `\r\n`。
- `updateCatalog`：原文存在时用 `patchCatalogText`，不存在时用 `serializeTestCatalog`。
- `claimOrphans`：追加精确路径。路径相对套件 `cwd`；`cwd` 为 `.` 时就是仓库相对路径。
- `register --auto`：候选只取本任务改动列表（`changedFilesForState`，经 `withoutControlPaths`）里的孤儿，不再调用 `listRepoFiles`。

- [ ] **Step 1: 写失败的测试**
  - `catalog-patch.test.ts`，以本仓库 `.tenon/tests/catalog.yaml` 原文为夹具（复制进测试，不读真实文件）：
    1. 改 `unit.command` → 只有该行不同（逐行 diff 只有 1 行），全部 `#` 注释行保留。
    2. 新增套件 → 出现在 `suites` 末尾，原文逐字是新文本的前缀加上尾部（新增行之前与之后的原文都在）。
    3. 删除中间的套件 → 它前面的分节注释保留，只少了它自己的行。
    4. 给 `unit.files` 追加一项 → 只多一行。
    5. 加 `not_applicable` / `levels` 顶层键 → 追加在文件末尾，原文不变。
    6. Review Focus 1：CRLF 原文、行尾空格、无结尾换行、`---` 开头，改一个键后其余字节不变。
    7. 生成的文本解析后与 `after` 深相等。
  - `test-register-auto.integration.test.ts`（临时 git 仓库，用 `freshHarness`）：
    - 本任务新增孤儿 `tools/x.test.mjs` → `--auto` 后 `unit.files` 只多 `tools/x.test.mjs`，没有 `tools/**`；目录注释保留。
    - 仓库里本任务没改动的 `old/y.test.js` 不被认领。
    - 已提交的归档文件 `openspec/changes/archive/a/r.spec.report` 不被认领。
    - 执行 `tenon test catalog set unit --command "npm test"` 后，目录注释行全部保留。
- [ ] **Step 2–4**：`npx vitest run packages/kernel/src/test-system/catalog-patch.test.ts packages/kernel/src/test-system/catalog-file.test.ts packages/cli/src/test-register-auto.integration.test.ts`：先失败，实现后通过；再跑 `npx vitest run packages/cli/src/commands/test-catalog-edit.test.ts packages/cli/src/test-sync-prune.integration.test.ts`。

### Task 6: 场景映射默认收起、豁免展示附带实测值

**Files:**
- Modify：`packages/kernel/src/test-system/evaluate-trace.ts`（`scenarios: off` 时行的 `required` 为 false）、`packages/cli/src/test-system/report-md.ts`（不要求时只列已映射行 + 一行统计）、`packages/kernel/src/test-system/review-waivers.ts` / `step-test-waivers` 相关展示、`packages/cli/src/commands/agent-prompt-tests.ts`、`review request` 输出处（`packages/cli/src/commands/review-waivers.ts`）
- Test：`evaluate-trace` 相关测试、`packages/cli/src/test-system/report-md` 的测试、`packages/kernel/src/test-system/step-test-waivers.test.ts`、`packages/cli/src/commands/agent-prompt-tests.test.ts`

**Interfaces:**
- Produces：`latestFailureMetrics(change, testId, records, candidate): readonly { name: string; value: number; max?: number }[] | undefined`（kernel，读当前候选上该步骤测试的最新失败记录）。
- Produces：`formatWaiverMetrics(metrics): string`，结果为 `最新运行：lines_added=2810（上限 2000）`；`undefined` 时为 `当前候选上没有失败记录`。

- [ ] **Step 1: 写失败的测试**
  - 69 个未映射场景，`scenarios: off` → 无 `scenario-uncovered` 阻断；`report-md` 输出只有一行「另有 69 条场景 / 任务未映射（本步不要求映射）」，不含「未覆盖」。
  - `scenarios: required` 时输出与修改前一致（快照）。
  - 豁免展示：
    - 理由写「新增 2100 行」、最新失败记录 `lines_added=2810`、门槛 2000 → 评审请求清单、报告、评审者提示三处都含「最新运行：lines_added=2810（上限 2000）」，理由仍标注为登记者自述；
    - 无失败记录 → 「当前候选上没有失败记录」。
- [ ] **Step 2–4**：对应测试文件 `npx vitest run …`：先失败，实现后通过。

### Task 7: 测试信任按「用户 + 仓库 + 命令」共享

**Files:**
- Create：`packages/kernel/src/test-system/trust-store.ts`（M5：用户级存储，HMAC 封印、锁、原子替换、2000 条上限）、`packages/cli/src/test-system/repo-identity.ts`（`git rev-parse --git-common-dir` + `git worktree list --porcelain` 反查，经现有安全的 git 执行方式，清掉 `GIT_DIR` 等仓库选择变量）
- Modify：`packages/kernel/src/test-system/catalog.ts`（`catalogExecEntries(catalog)`：逐条命令摘要）、`packages/cli/src/commands/test-trust.ts`（`ensureTrusted` 只校验本次要执行的命令；`cmdTestTrust` 写用户级存储；`--status` 逐条显示）、`packages/cli/src/commands/statusStepTrust.ts`（只列未信任的命令）、`packages/cli/src/test-system/run-orchestrator.ts` / `commands/test-run.ts:110`（传入本次要执行的命令）、`hooks/lib/protected-writes.sh`（`*/test-trust/*` 写入拒绝；预筛词加 `test-trust`）、`tools/test-hooks.sh`（拒绝 / 放行夹具各一）
- Test：`packages/kernel/src/test-system/trust-store.test.ts`、`packages/cli/src/test-system/repo-identity.test.ts`、`packages/cli/src/test-trust.integration.test.ts`（新）

**Interfaces:**

```ts
// trust-store.ts
export interface TrustEntry { readonly repo: string; readonly digest: string; readonly command: string; readonly by: string; readonly at: string }
export function testTrustPaths(stateRoot: string, slug: string): { readonly file: string; readonly key: string }
export async function readTrustStore(stateRoot: string, slug: string): Promise<readonly TrustEntry[]> // 坏文件 / mac 不符 → []
export async function addTrustEntries(stateRoot: string, slug: string, entries: readonly TrustEntry[]): Promise<void> // 锁 + 原子替换，去重，超 2000 淘汰最旧
// catalog.ts
export interface ExecEntry { readonly digest: string; readonly line: string } // line = 给用户看的一行
export function catalogExecEntries(catalog: TestCatalog, suiteIds?: readonly string[]): readonly ExecEntry[]
export function stepTestExecEntries(tests: readonly { step: string; id: string; command: string; cwd: string }[]): readonly ExecEntry[]
// repo-identity.ts
export async function repoTrustIdentity(cwd: string): Promise<string | undefined> // common dir 真实路径；检出根不在 worktree 列表里 → undefined
```

- `stateRoot` 取 `resolveProductPaths().stateRoot`，经 CLI 的 deps / paths 层传入，不在 kernel 里读 `process.env`。
- **判定顺序**：
  1. `TENON_TEST_TRUST=1` → 信任（保留原行为与 stderr 提示）；
  2. 有仓库身份时，用户级存储里有 `(repo, digest)` → 信任；
  3. 检出旧封存的 `trusted[]` 含当前 `catalogExecDigest` / `stepTestsExecDigest` → 整份信任；
  4. 否则列出未信任的条目，以退出码 1 拒绝。
  - 不是 git 仓库时，`tenon test trust` 退回写检出封存。

- [ ] **Step 1: 写失败的测试**
  - `trust-store.test.ts`（临时 `stateRoot`）：
    - 写入后读回；
    - 改一个字节后读成 `[]`；
    - 2001 条后保留最新 2000 条；
    - 两个并发 `addTrustEntries` 的条目都在（Review Focus 5）；
    - 文件权限 0600。
  - `repo-identity.test.ts`（临时 git 仓库）：
    - 主检出与 `git worktree add` 出的 worktree 返回同一身份；
    - 伪造检出（目录里手写 `.git` 文件指向该仓库的 common dir，但不在 worktree 列表）→ undefined；
    - 子目录 cwd 返回检出根的身份；
    - 删除 worktree 目录后，留下的 prunable 条目不影响主检出（Review Focus 3）；
    - macOS `/var` 与 `/private/var` 两种写法得到同一身份（Review Focus 2）。
  - `test-trust.integration.test.ts`：
    - 主检出 `tenon test trust --yes` 后，新 worktree 里 `tenon test run --suite unit` 不要求信任；
    - 改一个套件的 `command` 后只列这一条为未信任；
    - 旧封存里有整份摘要时视为已信任；
    - 测试环境的 `TENON_RUNTIME_HOME` 指向临时目录，断言真实用户目录未被创建或写入。
  - `tools/test-hooks.sh`：写 `<任意>/test-trust/x.json` 的 Write / Bash 重定向被拒；读它（`cat`）放行。
- [ ] **Step 2–4**：`npx vitest run packages/kernel/src/test-system/trust-store.test.ts packages/cli/src/test-system/repo-identity.test.ts packages/cli/src/test-trust.integration.test.ts`、`npm run test:hooks`：先失败，实现后通过。

### Task 8: 运行记录相对路径

**Files:**
- Create：`packages/cli/src/test-system/run-paths.ts`（M6）
- Modify：`packages/cli/src/test-system/suite-exec.ts` 或 `run-record.ts`（在 `appendTestRunRecordV2` 计算摘要前对每个 `SuiteRunV2` 调用）
- Test：`packages/cli/src/test-system/run-paths.test.ts`、`packages/cli/src/test-system/run-record.test.ts`（追加）

**Interfaces:**

```ts
export interface PathRoots { readonly repo: readonly string[]; readonly home: string | undefined } // repo 含逻辑路径与 realpath，去重、长的在前
export async function pathRootsFor(repoRoot: string, home: string | undefined): Promise<PathRoots>
export function relativizeRunStrings<T>(value: T, roots: PathRoots): T // 深拷贝，只改字符串；`file://<repo>/` 与 `<repo>/` → ''；`<home>/` → '~/'
```

- [ ] **Step 1: 写失败的测试**
  - 失败堆栈含 `<repo>/packages/cli/src/a.test.ts:10:5` 与 `file://<repo>/node_modules/x.js` → 改写为 `packages/cli/src/a.test.ts:10:5` 与 `node_modules/x.js`。
  - 主目录前缀 → `~/`。
  - 仓库根含空格和中文。
  - `/var/folders/...` 与 `/private/var/folders/...` 两种写法都被改写（Review Focus 2）。
  - 不是前缀的同名片段（如 `<repo>-other/`）不改。
  - 写出的整份运行记录里，任何字符串都不含仓库绝对路径（集成：`run-record` 测试）。
- [ ] **Step 2–4**：`npx vitest run packages/cli/src/test-system/run-paths.test.ts packages/cli/src/test-system/run-record.test.ts`：先失败，实现后通过。

### Task 9: 测试输出目录的通用指纹规则

**Files:**
- Modify：`packages/kernel/src/workspace/fingerprint.ts`（内部判定 + 只为测试输出目录读取 git 跟踪状态）、可能拆出 `packages/kernel/src/workspace/test-evidence-files.ts`（内部模块，不从包出口导出）
- Test：`packages/kernel/src/workspace/fingerprint.test.ts`（追加）

**Interfaces:**
- 内部：`trackedUnder(root, dir) → Promise<ReadonlySet<string> | undefined>`。它沿用 `host-local.ts` 的 git 环境清理与超时；出错返回 undefined，按失败关闭处理（目录下全部计入）。
- 判定：路径有一段等于 `test-results` / `playwright-report` / `coverage`，且不在跟踪集合里，且扩展名（小写）在证据名单里 → 排除。完整值与可移植值都排除。

- [ ] **Step 1: 写失败的测试**（临时 git 仓库）
  - 未跟踪的 `test-results/dashboard-e2e-server/serve.log`、`dashboard.log` 写入前后指纹相同；
  - 未跟踪的 `coverage/hook.js` 改变指纹；
  - 已跟踪的 `test-results/fixture.json` 被修改时改变指纹；
  - 没有扩展名的 `playwright-report/run` 改变指纹；
  - git 不可用（`PATH` 去掉 git 或注入失败的 runner）时 `.log` 也计入；
  - 已声明的输出照旧排除；
  - 回归：没有这些目录的工作区，指纹与修改前相同（快照）。
- [ ] **Step 2–4**：`npx vitest run packages/kernel/src/workspace/fingerprint.test.ts packages/kernel/src/test-system/candidate.test.ts`：先失败，实现后通过。

### Task 10: server DTO 与 Dashboard

**Files:**
- Modify（server）：`packages/server/src/testPolicyDto.ts`、`testEvidenceSnapshot.ts:42,94,96`（改用 M1；DTO 带 `level?: { name, required, touched, source }`）、`workflowOrchestration.ts`、工作流写接口（`serverPostGovernanceRoutes.ts` 经 `decodeWorkflowDef`，已由 Task 2 拒绝互斥）、测试目录只读接口返回生效的档位定义（`testSystemReads.ts` / `serverGetTestSystemRoutes.ts`：`levels` 为三档的 `ResolvedLevel`）
- Modify（dashboard，先读 `.agent-rules/FRONTEND.md`）：
  - `src/workflow/GateSection.tsx`：测试设置换成四选一单选。
  - `src/workflow/TestPolicyForm.tsx` / `TestPolicyControls.tsx` / `testPolicyEdits.ts`：删除逐字段控件，旧策略只读摘要，选档即替换。
  - `src/workbench/workbenchDefinition.ts:106-108`：保存 `test`，删除 `test_policy`。
  - `src/api/governanceTypes.ts` / `governanceSchema.ts` / `governanceTestPolicyDecoder.ts`：解码 `test`。
  - `src/projects/ProjectTestsList.tsx`：显示生效档位定义与每个套件的类。
  - `src/projects/suiteThresholds.ts`：门槛来自档位定义。
  - `src/workspace/TestsTabLists.tsx` / `testsTabModel.ts`：文件列表标「自动认领」，追溯矩阵按 §7 收起，策略矩阵按类。
  - `src/workspace/blockerLabel.ts`：不再出现未登记。
- Test：对应的 `*.test.ts(x)`，以及 `e2e/dashboard/workflow.spec.ts`、`e2e/dashboard/workspace-tests.spec.ts`

- [ ] **Step 1: 写失败的测试**
  - 工作流编辑：某步选「跑改动」并保存 → 请求体该步为 `test: 'changed'` 且没有 `test_policy`。
  - 旧策略步骤显示只读摘要，选档后替换。
  - 项目测试页：没写 `levels` 时三档显示缺省并标「内建缺省」。
  - 任务测试页：认领文件显示「自动认领」；`scenarios: off` 时追溯矩阵只有统计行。
  - server：`GET /api/tests/catalog` 带 `levels`；快照的步骤策略 DTO 带 `level`；`POST /api/workflows/:name` 同一步同时有 `test` 与 `test_policy` 返回 400。
- [ ] **Step 2–4**：
  - `npx vitest run --config packages/dashboard-app/vitest.config.ts <文件>`、`npx vitest run packages/server/src/<文件>`：先失败，实现后通过。
  - `npm run typecheck:web`、`npm run build:web`。
  - e2e 交给 Task 12 统一跑。

### Task 11: default 工作流、代码规模、技能与文档

**Files:**
- Modify：
  - `templates/workflows/default.yaml`：只改 `test_policy` / `tests` 键：
    - 各步改成 `test:` 档位（见 Global Constraints 的选档表）；
    - 删除全部 `test_policy`；
    - 删除三处 `code-size` 的 `pass` 块。
  - `templates/test-directions/code-size.yaml`：删除 `pass`。
  - `templates/agents/code-size.md`：如有固定上限的文字，改为按实测值判断。
- 运行 `npm run generate:default-workflow`，重新生成 `packages/kernel/src/workflow/default-workflow.generated.ts`。
- Modify：`skills/tenon/SKILL.md` 只改动作表的 `run-test`、`test-discover`、`test-plan-seed`、`test-plan-map`、`test-register-files`、`run-tests`、`test-report` 七行：
  - 登记改为认领；
  - `test-register-files` 只为孤儿；
  - `test-plan-map` 只为缺类或要求映射；
  - `run-tests` 的信任说明改为「同一仓库的所有 worktree 共享，只列未信任的命令」。
- Modify 文档（只改测试相关段落）：
  - `docs/usage/default-workflow.md`、`docs/usage/cli-reference.md`、`docs/usage/dashboard-and-local-api.md`、`docs/usage/custom-workflows-and-tracks.md`，以及 `docs/usage/zh-CN/` 对应文件；
  - `docs/CONTRACT.md`（测试三层契约、改动文件规则、信任、next 动作）；
  - `docs/usage/release-notes.md`：新增一节。内容包括：
    - 档位；
    - `levels`；
    - 五类；
    - 认领；
    - 信任位置变化；
    - code-size 无缺省上限；
    - N-1 回滚注意：回滚前先结束用 `test` 新键建的任务，并删除目录里的 `levels`；
    - 指纹规则：升级后一次性 `revision-stale` 的可能。
- Test：`packages/kernel/src/workflow/default-yaml-rules.test.ts`（追加），`default-direction-fidelity.test.ts`、`template-workflows.test.ts` 按新档位更新

- [ ] **Step 1: 写失败的测试**
  - `default-yaml-rules`：
    - 轻量：实现 `changed`、验证 `full`；
    - 产品：规格 `none`、验证 `changed`；
    - 前端、后端：规格 `plan`、实现 `changed`、验证 `full`；
    - 全文件没有 `test_policy`；
    - `code-size` 测试没有 `pass`。
- [ ] **Step 2–4**：
  - 改 YAML；
  - `npm run generate:default-workflow`；
  - `npx vitest run packages/kernel/src/workflow`；
  - `npm run check:default-workflow-freshness`；
  - `bash tools/verify-skills.sh`；
  - `npm run check:docs`（如存在）；
  - `npm run check:repository-hygiene`。

### Task 12: 端到端集成测试与全量回归

**Files:**
- Create：`packages/cli/src/test-settings-lite.integration.test.ts`
- Modify：`packages/cli/src/test-flow-lite.integration.test.ts`（按认领规则改写：删除逐个登记步骤）

用例：
1. **lite 全程**：
   - 只有 `npm test` 的新 JS 项目（参照 `test-flow-lite` 的夹具），`tenon init lite1 --workflow default --track lite`；
   - 实现步新增 `src/sub.js` 与 `test/sub.test.js`；
   - `tenon test run lite1 --stage` 在 build 与 verify 都以 0 退出；
   - 各步 `tenon test status --step <id> --json` 无阻断；
   - 断言整个过程**没有**执行任何 `tenon test register`、`--case` 映射或 `tenon test plan --seed` 之外的测试配置命令（统计 harness 调用记录），`test-plan.yaml` 的 `files` 为空。
2. **跨 worktree 信任**：
   - 主检出 `tenon test trust --yes`（测试代码里以用户身份直接调用 CLI，不经 agent hook）；
   - `git worktree add` 出新 worktree，在其中 `tenon test run --stage` 不报未信任。
3. **在途旧计划**：
   - 用旧 `test_policy`（含 `files: registered`）的工作流建任务，计划里逐个登记过 2 个文件；
   - 再新增 1 个被认领的测试文件；
   - 跑测试后 verify 出口无测试阻断。
4. **指纹**：build 冻结后，在 `test-results/` 写入未跟踪 `.log`，`tenon check` 不报 `revision-stale`。

全量回归，按 `rebuild-dist-before-build-complete` 的顺序，都在 `build-complete` 之前跑：
- `npm run build`；
- `npm run check:dashboard-dist-freshness`、`npm run check:default-workflow-freshness`、`npm run check:adapter-capabilities-freshness`；
- `npm test`；
- `npm run test:web`；
- `npm run test:hooks`；
- `bash tools/test-adapters.sh`；
- `bash tools/test-bundle.sh`；
- `bash tools/verify-skills.sh`；
- `npm run oracle`；
- `npm run test:e2e -- --project=chromium`、`npm run test:e2e -- --project=webkit`；
- 全部 `check:*`。

- [ ] **Step 1**：写 4 个集成用例，先失败（在 Task 1–11 合入前）。
- [ ] **Step 2**：合入后全部通过：`npx vitest run packages/cli/src/test-settings-lite.integration.test.ts packages/cli/src/test-flow-lite.integration.test.ts`。
- [ ] **Step 3**：按上面的顺序跑全量回归，记录结果。

### Task 13: 验证第 1 轮评审修复（4 条 medium 与同处的 low）

背景：验证第 1 轮，security 报 2 条 medium，backend-quality 报 1 条，code-size 报 1 条。下面的 13a–13d 各修一条，13e 是同文件里零风险的 low，13f 同步文档，13g 回归。

#### 13a 证据扩展名收窄（security medium）

**Files:**
- Modify：`packages/kernel/src/workspace/test-evidence-files.ts`（`EVIDENCE_EXTENSIONS` 去掉 `json`、`html`、`htm`、`zip`、`gz`、`har`；文件头注释同步写明原因）。
- Test：`packages/kernel/src/workspace/fingerprint.test.ts`。

**Interfaces：** 不变（内部模块）。

- [ ] **Step 1：写失败的测试**（`fingerprint.test.ts`，沿用现有的临时 git 仓库夹具）：
  - 未跟踪的 `coverage/x/fixture.json`、`playwright-report/index.html`、`playwright-report/page.htm`、`test-results/trace.zip`、`test-results/a.gz`、`test-results/net.har` 写入或修改后，指纹改变（6 例，可写成表驱动）；
  - 未跟踪的 `test-results/s/serve.log`、`coverage/lcov.info`、`test-results/shot.png`、`test-results/error-context.md` 写入前后指纹不变；
  - 把现有断言「证据扩展名全覆盖」的那条用例改成新名单。
- [ ] **Step 2**：`npx vitest run packages/kernel/src/workspace/fingerprint.test.ts`，预期新增的 6 例失败。
- [ ] **Step 3**：实现。
- [ ] **Step 4**：同一命令通过，再跑 `npx vitest run packages/kernel/src/workspace packages/kernel/src/test-system/candidate.test.ts packages/cli/src/test-settings-lite.integration.test.ts`。其中 test-settings-lite 的指纹用例写的是 `.log`，应当不受影响。

#### 13b 报告里的不可信文本统一转义（security medium + low）

**Files:**
- Modify：`packages/cli/src/test-system/report-md.ts`。
- Test：`packages/cli/src/test-system/report-md.test.ts`。

**要改的位置：**
- `matrixRows` 里 `row.waiver.reason`（登记者自述）改走 `escapedWaiverText`；
- `matrixRows` 里放进反引号代码段的 `test.ref`：先把其中的反引号换成全角（与 `waiverReasonText` 同一规则），再拼进代码段，不能跳出代码段；
- 「失败 / flaky」列表里的 `ref`，以及「仍挡出口的项」里的 `item.message`：改走 `escapedWaiverText`；
- `item.fix` 已在代码段里，同样只做反引号替换。

- [ ] **Step 1：写失败的测试**（`report-md.test.ts`）：
  - 追溯矩阵里一行带豁免，理由是 ``[点我](https://e.x) ![i](https://e.x/a.png) <b>x</b> `y` ``。断言输出里没有 `](https://`、`![`、`<b>`，原文字以转义或全角形式出现，表格列数不变。
  - 一个用例 ref 含反引号 `` a`b ``。断言渲染出的代码段没有被提前闭合：行内反引号成对，且 ref 以全角反引号出现。
  - flaky ref 与阻断 message 里各带一个 `[x](https://e.x)`，断言被转义。
- [ ] **Step 2**：`npx vitest run packages/cli/src/test-system/report-md.test.ts`，预期失败。
- [ ] **Step 3**：实现。
- [ ] **Step 4**：同一命令通过；再跑 `npx vitest run packages/cli/src/test-report packages/cli/src/commands/review-waivers.test.ts packages/cli/src/commands/agent-prompt.test.ts`（存在的就跑）。

#### 13c 信任区分「不是 git 仓库」与「读不出身份」（backend-quality medium）

**Files:**
- Modify：
  - `packages/cli/src/test-system/repo-identity.ts`：返回值改成三态；
  - `packages/cli/src/commands/test-trust.ts`：`trustScope`、`untrustedEntries`、`cmdTestTrust`；
  - `packages/cli/src/commands/statusStepTrust.ts`：如有直接判断 `undefined` 的地方，同步改成三态。
- Test：`packages/cli/src/test-system/repo-identity.test.ts`、`packages/cli/src/test-trust.integration.test.ts`。

**Interfaces：**

```ts
// repo-identity.ts
export type RepoTrustIdentity =
  | { readonly kind: 'repo'; readonly repo: string }   // common dir 的真实路径
  | { readonly kind: 'not-repo' }                      // 检出目录及其所有上级都没有 `.git`
  | { readonly kind: 'unresolved' }                    // 有 `.git` 却读不出身份：git 出错 / 超时 / 不可用、伪造指针、不在 worktree 列表
export async function repoTrustIdentity(cwd: string): Promise<RepoTrustIdentity>
```

- 「有没有 `.git`」：从 `realpath(cwd)` 起逐级向上到文件系统根，`lstat(join(dir, '.git'))` 成功（文件、目录、链接都算）就是有。
  - `realpath` 失败按「有」处理（失败关闭，归 `unresolved`）。
  - 不调用 git，所以 git 不可用时也能判定。
- `test-trust.ts`：

```ts
export type TrustScope =
  | { readonly kind: 'user'; readonly repo: string; readonly stateRoot: string | undefined } // git 仓库；stateRoot 缺失时没有用户级存储
  | { readonly kind: 'checkout' }    // 不是 git 仓库：只认检出旧封存（不做跟踪检查，git 不存在）
  | { readonly kind: 'unresolved' }  // 一律未信任
```

  - `untrustedEntries`：
    - `unresolved` → 返回全部条目；
    - `checkout` → 只看旧封存；
    - `user` → 先查用户级存储（`stateRoot` 有值时）；剩下的条目再看旧封存，前提是 `legacySealIsMachineLocal` 为真。
  - `cmdTestTrust`：
    - `unresolved` → 不写任何东西。调用 `fail`，文案：`当前目录有 .git，但读不出仓库身份（git 出错、超时，或 .git 是不在 git worktree 列表里的伪造指针）：信任既写不进去也不会被认，先修好 git 再试`。
    - `user` 且 `stateRoot` 有值 → 写用户级存储（原行为）。
    - `user` 且没有 `stateRoot` → 写检出旧封存（原行为，本机写下的旧封存被 `legacySealIsMachineLocal` 认可）。
    - `checkout` → 写检出旧封存（原行为），提示文案里的「或检出未被 git 登记」删掉。
  - 文件头与 `untrustedEntries` 的注释同步改写。注释里只写「是什么、为什么」，不写修改历史。

- [ ] **Step 1：写失败的测试**
  - `repo-identity.test.ts`：
    - 临时目录里没有 `.git`、上级也没有 → `{ kind: 'not-repo' }`。临时目录要建在一个确定不在任何 git 仓库下的位置，例如 `os.tmpdir()` 下的新目录；先断言它的上级没有 `.git`，有就 `skip` 并写明原因。
    - 伪造 `.git` 指针 → `{ kind: 'unresolved' }`，原来断言 `undefined` 的用例同步改。
    - 主检出与 worktree → `{ kind: 'repo', repo }`。
    - 有 `.git` 目录、但 `PATH` 里找不到 git（以 `PATH=<空目录>` 跑子进程，或给 `repoTrustIdentity` 注入失败的执行器——两者择其一，以现有测试夹具的做法为准）→ `{ kind: 'unresolved' }`。
  - `test-trust.integration.test.ts`：
    - 伪造 `.git` 指针的检出，带着记有当前摘要的旧封存 → `tenon test run` 以 exit 1 报未信任；
    - 同一检出里 `tenon test trust --yes` 以非零退出、不写 `.tenon/users/<slug>/local/test-seal.json`、也不写用户级存储；
    - 没有 `.git` 的目录带旧封存 → 仍视为已信任（回归）。
- [ ] **Step 2**：`npx vitest run packages/cli/src/test-system/repo-identity.test.ts packages/cli/src/test-trust.integration.test.ts`，预期失败。
- [ ] **Step 3**：实现。
- [ ] **Step 4**：同一命令通过；再跑 `npx vitest run packages/cli/src/test-settings-lite.integration.test.ts packages/cli/src/commands/statusStepTests.test.ts packages/cli/src/test-system/legacy-seal-origin.test.ts`。

#### 13d git 子进程环境清理抽成共享模块（code-size medium）

**Files:**
- Create：`packages/cli/src/test-system/git-exec.ts`
- Modify：`packages/cli/src/test-system/repo-identity.ts`、`packages/cli/src/test-system/legacy-seal-origin.ts`（删掉各自的 `gitEnvironment` 与 `execFile` 包装，改为导入）
- Test：`packages/cli/src/test-system/git-exec.test.ts`

**Interfaces：**

```ts
// git-exec.ts
/** 进程环境去掉全部 GIT_ 变量（名字不分大小写），并固定 LC_ALL=C、LANG=C。 */
export function gitEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
/** git <args>，cwd 固定、带超时与输出上限、环境经 gitEnvironment；失败照常抛出，由调用方决定失败关闭。 */
export async function runGit(cwd: string, args: readonly string[], options?: { readonly maxBuffer?: number; readonly timeoutMs?: number }): Promise<string>
```

- 缺省值：超时 10 秒，`maxBuffer` 4 MiB。`legacy-seal-origin.ts` 原来是 1 MiB，传 `{ maxBuffer: 1024 * 1024 }` 保持原值。
- `repo-identity.ts` 原来的 `-c core.quotePath=false` 前缀留在调用处，不放进 `runGit`。
- kernel `workspace/host-local.ts` 的 `gitEnvironment` 只去掉选择仓库的变量，口径不同，不合并，也不改它。

- [ ] **Step 1：写失败的测试**（`git-exec.test.ts`）：
  - `gitEnvironment({ GIT_DIR: 'x', git_work_tree: 'y', PATH: '/bin', LANG: 'zh' })` 的结果里没有 `GIT_DIR`、`git_work_tree`，`PATH` 保留，`LANG` 与 `LC_ALL` 都是 `C`。
  - `runGit(<临时 git 仓库>, ['rev-parse', '--is-inside-work-tree'])` 返回 `true\n`。
  - `runGit(<非仓库临时目录>, ['rev-parse', '--git-dir'])` 抛错。
- [ ] **Step 2**：`npx vitest run packages/cli/src/test-system/git-exec.test.ts`，预期失败（模块不存在）。
- [ ] **Step 3**：实现，并把两个文件改为导入。
- [ ] **Step 4**：`npx vitest run packages/cli/src/test-system/git-exec.test.ts packages/cli/src/test-system/repo-identity.test.ts packages/cli/src/test-system/legacy-seal-origin.test.ts` 通过。

#### 13e 同处零风险的 low

- `packages/kernel/src/test-system/catalog.ts`：`suiteExecEntry` 的服务排序，以及 `stepTestsExecDigest` 的条目排序，比较器补上相等时返回 `0` 的分支。相等元素内容完全相同，所以摘要不变；用现有的摘要快照测试确认没有变化。
- `packages/kernel/src/test-system/evaluate-suite.ts`：`NODE_TEST_FILE_HINT =` 后面补一个空格。
- 验收：`npx vitest run packages/kernel/src/test-system` 通过，现有的目录摘要快照不变。

#### 13f 文档同步（只改测试相关段落）

- 证据扩展名名单（中英文都改）：
  - `docs/CONTRACT.md`（约 658 行）；
  - `docs/usage/cli-reference.md`（约 293 行）、`docs/usage/zh-CN/cli-reference.md`（约 354 行）；
  - `docs/usage/security-model.md`（约 168 行）、`docs/usage/zh-CN/security-model.md`（约 77 行）；
  - `docs/usage/release-notes.md` 与 `docs/usage/zh-CN/release-notes.md` 本任务的那一节；
  - `CONTEXT.md`（如有名单）。
  - 统一写成新名单，并加一句「json、html、zip、har 这类能被代码或浏览器加载的产物，由测试目录声明为输出」。
- 信任的仓库判定：`docs/CONTRACT.md` 与中英文 `cli-reference.md` 里，上一轮加过「被 git 跟踪的旧封存不认」的那一句。补上「检出目录及上级都没有 `.git` 才退回旧封存；有 `.git` 却读不出身份（git 出错、伪造指针）一律未信任，`tenon test trust` 也拒绝写入」。
- 验收：`npm run check:docs`、`npm run check:document-templates`。

#### 13g 重新生成与全量回归

- `npm run build`；
- 跑 Task 12 列出的全部回归：
  - `npm test`、`npm run test:web`、hooks、adapters、bundle、verify-skills、migration-cas、oracle；
  - e2e chromium 与 webkit；
  - 全部 `check:*` 与 freshness；
  - `test:clean-install`、`test:update-rollback`。
- 全部在 `build-complete` 之前跑完。

### Task 14: 验证第 2 轮评审修复（2 条 medium）

背景：验证第 2 轮 security 报了 2 条 medium。

1. 带真 `.git` 的压缩包可以附带未被跟踪的旧封存与密钥，`legacySealIsMachineLocal` 判为本机写下而认下。任何只看检出内容的检查都能这样伪造。规格已改为：git 仓库里一律不认检出旧封存。
2. 评审请求原样打印豁免理由，计划与目录的理由解码只拒 `\r`、`\n`、`\0`，不拒 ESC 与双向字符，用户确认屏可被改写。

另外更正一处：第 2 轮的报告里写过「计划解码时已拒收含控制字符或双向字符的理由」，这个说法是错的。本轮在报告里如实更正。

#### 14a git 仓库里不认检出旧封存（security medium 1）

**Files:**
- Modify：`packages/cli/src/commands/test-trust.ts`
- Delete：`packages/cli/src/test-system/legacy-seal-origin.ts`、`packages/cli/src/test-system/legacy-seal-origin.test.ts`
- 视引用情况：`packages/cli/src/test-system/repo-identity.ts` 的 `isNotFound` 导出。只剩内部用时去掉 `export`。
- Test：`packages/cli/src/test-trust.integration.test.ts`、`packages/cli/src/test-settings-lite.integration.test.ts`（如果断言了 git 仓库里的旧封存有效），以及其他断言「git 仓库里旧封存有效」的用例。用 Grep 找 `writeLegacyTrust`、`updateTestSeal`、`trusted:`。

**行为**（`TrustScope` 三态不变）：
- `untrustedEntries`：
  - `unresolved`：全部未信任（不变）。
  - `checkout`（不是 git 仓库）：只看检出旧封存（不变）。
  - `user`（git 仓库）：只查用户级存储。`stateRoot` 缺失时为空集，全部未信任。**不再看检出旧封存**。
- `ensureTrusted`：`user` 作用域有未信任命令时，如果检出里的旧封存恰好记着当前摘要，多给一行提示：「检出里的旧信任在 git 仓库里不再被认，请在你自己的终端重新运行 tenon test trust 确认一次」。只读封存，不改它。
- `cmdTestTrust`：
  - `user` 且有 `stateRoot`：写用户级存储（不变）。
  - `user` 且没有 `stateRoot`：在列出命令、确认之前就 `fail`，文案「没有用户级状态目录：git 仓库的信任只记在用户级存储里，写不进去」。删掉 `legacySealWouldBeRecognized`。
  - `checkout`：写检出旧封存（不变，写封存失败的 try/catch 保留）。
  - `unresolved`：拒绝（不变）。
- `seal.ts` 里封存的其他用途（受保护测试配置的审批等）不动，只是 `trusted[]` 在 git 仓库里不再参与信任判定。
- 文件头与 `untrustedEntries` 的注释同步改写：git 仓库只认用户级存储。原因：检出里的任何文件都可能随仓库或压缩包带来。

- [ ] **Step 1：写失败的测试**（`test-trust.integration.test.ts`）：
  - git 仓库主检出里有**未被跟踪**、记着当前摘要的旧封存与密钥（模拟压缩包带来），用户级存储为空 → `tenon test run` exit 1，`trust --status` exit 2，stderr 含「不再被认」与「tenon test trust」。原用例断言「本机写下的旧封存有效」的，改成这个预期。
  - 同上，但旧封存被 git 跟踪 → 同样未信任（回归）。
  - 没有 `.git` 的目录带旧封存 → 已信任（不变）。
  - git 仓库里 `tenon test trust --yes` → 写用户级存储，之后 `tenon test run` 不再要求信任，检出里的旧封存不变。
  - `productPaths` 缺失的 git 仓库，`trust --yes` 非零退出，什么都不写。沿用现有构造方式；没有现成构造就在单测层面注入 `deps`。
- [ ] **Step 2**：`npx vitest run packages/cli/src/test-trust.integration.test.ts`，预期失败。
- [ ] **Step 3**：实现，并删除 `legacy-seal-origin.*`。
- [ ] **Step 4**：`npx vitest run packages/cli/src/test-trust.integration.test.ts packages/cli/src/test-settings-lite.integration.test.ts packages/cli/src/test-system/repo-identity.test.ts packages/cli/src/test-system/git-exec.test.ts` 通过；再跑 `npx vitest run packages/cli/src --reporter=dot`，确认没有别处依赖 git 仓库里的旧封存。

#### 14b 评审请求打印豁免理由前清理（security medium 2）

**Files:**
- Modify：`packages/cli/src/commands/review-waivers.ts`（`reviewItemLines`）
- Test：`packages/cli/src/commands/review-waivers.test.ts`

**行为**：
- `reviewItemLines` 打印的每条待批准豁免改为 `${waiver.key} — ${foldDisplayText(waiver.reason)}`。`foldDisplayText` 从 `@tenon/kernel` 导入，作用是折成单行、去掉控制字符与双向字符。
- 不截短，用户要看全文才能批准。
- 同一函数里打印的其他来自计划或目录的自由文本（如果有），同样处理。

- [ ] **Step 1：写失败的测试**：
  - 理由含 `\u001b[2J`（ESC 清屏）、`‮`（RLO）、`\t`：输出里没有 ESC 与 RLO，制表符折成空格。
  - 理由长 600 字：完整保留。
  - 普通中文理由：逐字不变。
- [ ] **Step 2–4**：`npx vitest run packages/cli/src/commands/review-waivers.test.ts`，先失败，实现后通过。

#### 14c 文档与发布说明（只改测试信任相关段落，中英文都改）

- `docs/CONTRACT.md`、中英文 `cli-reference.md`、`security-model.md`、`release-notes.md` 本任务那一节，以及 `CONTEXT.md`（如果写了旧封存）。
- 写明三点：
  - 旧封存只在不是 git 仓库的项目里有效；
  - git 仓库里不认检出里的旧封存，以前信任过的命令要在自己的终端里重新运行一次 `tenon test trust`；
  - 原因：检出里的封存与密钥可能随压缩包带来。
- 发布说明的升级注意事项里加一条「升级后在 git 仓库里首次运行测试，需要重新信任一次」。
- 删除文档里「被 git 跟踪的旧封存不认」这类已经过时的说法。
- 验收：`npm run check:docs`、`npm run check:document-templates`。

#### 14d 重新生成与全量回归

- `npm run generate:default-workflow`、`npm run build`。
- 跑 Task 12 列出的全部回归。
- 全部在 `build-complete` 之前跑完。

### Task 15: 验证第 3 轮之后（rebase、3 条 medium 与 1 条 high、规格点名的用例、清理类 low）

背景：
- `origin/main` 在验证期间合入了并行任务 `rework-document-mechanism`（`33425ab0`）。它与本任务冲突的源码文件有：
  - `packages/kernel/src/workflow/serialize.ts`
  - `packages/kernel/src/workflow/default-yaml-rules.test.ts`
  - `packages/dashboard-app/src/workflow/GateSection.tsx`
  - `packages/dashboard-app/src/workbench/useStageMutations.ts`
  - `packages/dashboard-app/src/workbench/workflowEditorTypes.ts`
  - `packages/dashboard-app/src/workbench/workbenchDefinition.test.tsx`
  - `templates/skill-sources.yaml`

  此外还有生成物：`packages/cli/dist/tenon.mjs`、`packages/server/dist/dashboard.mjs`、`packages/dashboard-app/dist/**`、`default-workflow.generated.ts`。
- 验证第 3 轮的评审：
  - code-size medium：`catalog.ts` 三处粘贴同一个字符串比较器。
  - backend medium：没写 `covers` 的套件只改源码碰不到，零运行且没有任何提示。
  - spec-consistency：
    - high：「大改动不被代码规模挡住」没有端到端用例；
    - medium：「按需启用上限」没有端到端用例；
    - medium：「只改目录就能改档位含义」没有求值层用例。
- 另有几条 low 一并修：缺的用例、展示给 agent 的不可信文本。规格已经按本轮改过：
  - 互斥报错不再写「退出码 2」；
  - 新增 `suites-without-covers` 提示；
  - 评审请求里的理由不截短但要清理；
  - `tenon init` 不改写已有目录。

执行顺序：15a（主线做 git 操作，冲突由执行者解决）→ 15b → 15c → 15d → 15e → 15f → 15g。会写文件的执行者串行。

#### 15a rebase 到最新 `origin/main`

主线执行，一次一条命令：
1. `git fetch origin main`，确认 `origin/main` 的提交；工作区只有已暂存的改动与三处未跟踪的任务目录。
2. `git commit -q -m "wip(simplify-test-settings): park staged work for rebase"`：临时提交，最后撤回。
3. `git rebase origin/main`：停在冲突处。
4. 冲突解决交给执行者（Sonnet，xhigh），规则如下：
   - **源码文件**：两边都保留。并行任务的改动（文档机制：document-contract、effective-io、`inputs` / `outputs` / `document_contract`）原样保留；本任务的改动（`test` 档位、`test_policy` 兼容、测试设置单选、测试相关的 YAML 规则）也原样保留。
   - **生成物**（dist、`default-workflow.generated.ts`、`templates/skill-sources.yaml`）：先取 `origin/main` 一侧，之后由脚本重新生成，不手工合并。
   - 解决完跑 `npx tsc -p packages/kernel/tsconfig.json --noEmit`、`npx tsc -p packages/cli/tsconfig.json --noEmit`、`npm run typecheck:web`，以及冲突文件对应的测试。
5. 主线审 diff 后执行：
   - `git add <已解决的文件>`；
   - `GIT_EDITOR=true git rebase --continue`；
   - `git reset --soft origin/main`：撤回临时提交，改动回到「已暂存、未提交」。
6. 依次重新生成并暂存：
   - `npm run generate:default-workflow`
   - `npm run sync:skill-provenance`（重写 `templates/skill-sources.yaml` 的哈希）
   - `npm run generate:document-presentation`（存在才跑）
   - `npm run build`
7. 验收：
   - `npm run check:default-workflow-freshness`、`npm run check:dashboard-dist-freshness`、`npm run check:adapter-capabilities-freshness` 通过；
   - `npx vitest run packages/kernel/src/workflow packages/dashboard-app/src/workbench packages/dashboard-app/src/workflow` 通过（Dashboard 用它自己的 vitest 配置）。

#### 15b 共用的字符串比较（code-size medium）

**Files:** Modify `packages/kernel/src/test-system/catalog.ts`；Test `packages/kernel/src/test-system/exec-entries.test.ts`（已有摘要快照）。

```ts
/** 按 UTF-16 码元比较（与 Array.prototype.sort 的缺省口径一致，不受区域设置影响）；摘要排序都用它。 */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
```

- 替换三处：
  - `catalogExecDigest` 的 `byId` 改为 `(left, right) => byCodeUnit(left.id, right.id)`；
  - `stepTestsExecDigest` 的比较器改为 `byCodeUnit(left.id + '\u0000' + left.command, right.id + '\u0000' + right.command)`；
  - `suiteExecEntry` 的服务排序改为 `byCodeUnit(canonicalJson(left), canonicalJson(right))`。
- 摘要必须逐字不变：`exec-entries.test.ts` 已钉住摘要字面值，先跑一遍确认它们通过，改完再跑一遍。
- 验收：`npx vitest run packages/kernel/src/test-system` 通过，摘要快照不变。

#### 15c 没写 `covers` 的套件给出 `suites-without-covers` 提示（backend medium）

**Files:**
- Modify：
  - `packages/kernel/src/test-system/blockers.ts`：`TEST_NOTICE_CODES` 加 `'suites-without-covers'`；`TEST_NOTICE_LABELS` 加 `{ zh: '套件没写 covers', en: 'Suites without covers' }`。
  - `packages/kernel/src/test-system/stage-run-set.ts`：新增导出函数。
  - `packages/kernel/src/test-system/evaluate-v2.ts`：在算运行集之后推入提示。
  - `packages/cli/src/commands/test-run-suites.ts`：`--stage` 打印提示，空运行集与非空都打印。
  - `packages/cli/src/commands/test-status.ts`：文本输出在阻断之后打印 `policy.notices`，用 `noticeLines`。
- Test：`stage-run-set.test.ts`、`evaluate-v2-levels.test.ts`、`packages/cli/src/test-levels.integration.test.ts`（追加）。凡是按 `TestNoticeCode` 穷举的地方（server DTO、Dashboard 文案表）用 Grep 找出来一并补上。

**Interfaces:**

```ts
// stage-run-set.ts
/**
 * 档位策略（changed / full）下，required 或 touched 类里没写 covers、因此没进运行集的套件 id（按目录顺序）。
 * 只在本任务改了源码文件时返回非空：控制目录之外（withoutControlPaths）、hasTestSourceExtension 为真、looksLikeTestFile 为假。
 * 旧策略（policy.level === undefined）、plan 档、changedFiles === undefined 一律返回 []。
 */
export function suitesWithoutCovers(input: {
  readonly policy: StepTestPolicyIR
  readonly catalog: TestCatalog
  readonly changedFiles: readonly string[] | undefined
  readonly runSet: StageRunSet
}): readonly string[]
```

- 提示文案：`套件 ${ids.join('、')} 没写 covers：只改源码碰不到它们，本步没有运行；需要源码改动触发时，在 .tenon/tests/catalog.yaml 给它们写上 covers`。
- `fix` 为 `tenon test catalog set <第一个 id> --covers "<glob>"`。这个命令存在才给，不存在就不带 `fix`，先 `tenon test catalog set --help` 确认。

- [ ] **Step 1：写失败的测试**
  - `stage-run-set.test.ts`：
    - 目录只有 `unit`（`files: ['test/**/*.test.js']`，没有 covers），改动 `['src/a.js']`，`test: changed` → `['unit']`；
    - 改动 `['README.md']` → `[]`；
    - 改动 `['test/a.test.js']`（unit 被碰到、进了运行集）→ `[]`；
    - `unit` 写了 `covers: ['src/**']` → `[]`；
    - `full` 档：required 的 `unit` 总在运行集里不报；touched 的 `e2e`（没有 covers）在只改 `src/a.js` 时报 `['e2e']`；
    - 旧策略、`plan` 档、`changedFiles` 为 undefined → `[]`；
    - 控制目录里的 `openspec/x.ts` 不算源码改动。
  - `evaluate-v2-levels.test.ts`：同第一例，`notices` 里有 `code: 'suites-without-covers'`，message 含 `unit`，`blockers` 为空，`pass` 为真。
  - `test-levels.integration.test.ts`（真临时 git 仓库，沿用文件里现有的夹具）：
    - 只有不带 covers 的 `unit`，只改 `src/a.js`；
    - `tenon test run <c> --stage` 以 0 退出，输出含「没有需要运行的套件」与 `suites-without-covers` 的提示文案（点名 `unit`）；
    - `tenon test status <c> --step <该步>` 文本输出含同一提示，`--json` 的 `policy.notices` 里有它。
- [ ] **Step 2**：跑这三个测试文件，预期新增用例失败。
- [ ] **Step 3**：实现。
- [ ] **Step 4**：同一命令通过；再跑 `npx vitest run packages/kernel/src/test-system packages/cli/src/test-system packages/server/src`。

#### 15d 规格点名但缺的用例（spec-consistency high / medium / low）

全部是测试，生产代码不改。若测试暴露出实现与规格不符，停下报告主线，不擅自改规格。

1. **「大改动不被代码规模挡住」（high）**与**「按需启用上限」（medium）**：在 `packages/cli/src/default-code-size.integration.test.ts` 追加两例。
   - harness 的 PATH 桩（`integration-harness-probe.ts`）对 `tenon test code-size` 恒输出 0 行。仿照 `TENON_TEST_REAL_DIFF=1` 的做法加一个开关 `TENON_TEST_REAL_CODE_SIZE=1`，打开时转交真实 CLI（`exec node '${REAL_CLI}' "$@"`）。
   - 例一：
     - 真 git 仓库里 `tenon init sized --track backend --preset full`，提交基线；
     - 新增一个 5000 行的源码文件（如 `src/big.ts`，每行一条语句）；
     - 设 `TENON_TEST_REAL_CODE_SIZE=1` 运行验证步的 code-size 测试（`tenon test run sized code-size`）；
     - 断言：结果 pass、退出 0；运行记录的 `metrics.lines_added` ≥ 5000，探针会把 init 写出的文件也算进来时，在报告里说明口径；没有任何豁免。
   - 例二：
     - 同上，但项目工作流（`.pipeline/workflows/<名>.yaml`，从 default 复制，只给 code-size 加 `pass.metrics: [{ name: lines_added, max: 3000 }]`）；
     - 断言：结果 fail，`reasons[].code` 为 `metric-threshold`。
   - 用例里的临时目录用完删除，不读写真实用户目录。
2. **「只改目录就能改档位含义」（medium）**：在 `packages/kernel/src/test-system/evaluate-v2-levels.test.ts` 追加。
   - 目录写 `levels.full.coverage: { lines: 80 }`，`unit` 套件声明了覆盖率报告；运行记录的行覆盖率是 70%；步骤 `test: full`；
   - 断言：出覆盖率阻断（码以现有实现为准，Grep `coverage` 相关的 `TestBlockerCode`）；
   - 同样输入、目录不写 `levels` 时，不出覆盖率阻断；
   - 只改目录（`levels` 从无到有），工作流对象不变，结论随之改变。
3. **「旧策略不受归类影响」（low）**：`stage-run-set.test.ts` 追加一例。目录有 `typecheck` 与 `lint` 两个套件，旧策略 `run_if_registered: [typecheck]`，计划登记了两者；运行集只有 `typecheck`。
4. **互斥的 CLI 出口（low）**：`packages/cli/src/test-levels.integration.test.ts` 追加一例。项目工作流某步同时写 `test: full` 与 `test_policy`，`tenon init` 以非零退出码失败，stderr 点名该步并含「只能写一个」。
5. **「档位定义写错被拒」的 CLI 出口（low）**：同文件追加一例。目录写 `levels.changed.scope: full`，`tenon test catalog validate` 以非零退出码失败，输出含该键所在行号。
6. **评审请求里的理由（规格新增的 Scenario）**：`packages/cli/src/commands/review-waivers.test.ts` 追加一例。同一条理由 600 字，并含 `\u001b[2J`、`‮` 与 `<tenon-review-confirmed>`；断言该行完整保留 600 个可见字符，没有 `…`，没有 ESC 与 RLO，尖括号是全角。

- 验收：对应测试文件全部通过（`npx vitest run <文件…>`）。

#### 15e 展示给 agent 的不可信文本（security / backend low）

**Files:**
- `packages/cli/src/test-system/report-md.ts`：
  - benchmark 行的 `suite.suite`、`metric.name`、`metric.details` 走 `escapedInline`；
  - flaky / failing 行括号里的 `suite.suite` 走 `escapedInline`。
- `packages/cli/src/commands/review-waivers.ts`：
  - `skippedWaiverLines` 的 key 走 `displaySafeText`、path 走 `foldDisplayText`；
  - 委托确认被拒的错误信息里，豁免 key 走 `displaySafeText`、受保护改动路径走 `foldDisplayText`。
- `packages/cli/src/commands/test-register-auto.ts`：`unresolvedMessage` 里的路径走 `foldDisplayText`。
- `packages/cli/src/commands/test-trust.ts`：
  - `ensureTrusted` 在 `user` 作用域且没有 `stateRoot` 时，不再提示运行 `tenon test trust`，改为打印「没有用户级状态目录：git 仓库的信任只记在用户级存储里，写不进去」；
  - 读不出身份时的分支不变。

Test：
- `report-md.test.ts`：benchmark 指标名含 `[x](https://e.x)` 被转义。
- `review-waivers.test.ts`：skipped 行与委托拒绝信息里的 ESC 被去掉。
- `test-register-auto.integration.test.ts` 或单测：未认领路径里的控制字符被去掉。
- `test-trust.integration.test.ts`：`trustWithoutStateRoot` 同类构造下 `ensureTrusted` 的提示。

验收：对应测试先红后绿。

#### 15f 文档（只改测试相关段落，中英文对等）

- 写明 `covers` 与 `suites-without-covers`：
  - `docs/usage/cli-reference.md` 与 `docs/usage/zh-CN/cli-reference.md` 的测试目录 / 档位一节：没写 `covers` 的套件只有它的测试文件改了才算被碰到；只改源码时零运行并给出这条提示；需要时给套件写 `covers`。
  - `docs/CONTRACT.md` 的测试档位一节：提示码 `suites-without-covers` 与触发条件。
  - 中英文 `release-notes.md` 本任务一节：一句话说明这条提示。
- 验收：`npm run check:docs`、`npm run check:document-templates`。

#### 15g 重新生成与全量回归

- `npm run generate:default-workflow`、`npm run build`，暂存全部改动。
- 跑 Task 12 列出的全部回归，以及 `test:clean-install`、`test:update-rollback`。
- 全部在 `build-complete` 之前跑完；之后就绪审查（spec / backend / security / code-size 四路，按 `review_bar` 口径，必须完整覆盖）。

---

## 自检

- **Spec 覆盖**：
  - 档位键 → Task 2；
  - 档位定义 → Task 3；
  - 测试类 → Task 1、4；
  - 运行集 → Task 4；
  - 认领 → Task 4；
  - 控制目录与扩展名 → Task 1、4；
  - `--auto` → Task 5；
  - 保留注释 → Task 5；
  - 场景映射 → Task 6；
  - default 选档与 code-size → Task 11；
  - 信任 → Task 7；
  - 相对路径 → Task 8；
  - 在途任务 → Task 4、12；
  - next 动作 → Task 4、11；
  - 豁免实测值 → Task 6；
  - 指纹规则 → Task 9；证据扩展名收窄（「可被加载的数据与页面仍计入」）→ Task 13a。
  - 信任的仓库判定（「git 出错时不退回旧封存」）→ Task 13c；「git 仓库里不认检出里的旧封存」「不是 git 仓库时旧信任仍然有效」→ Task 14a。
  - 评审请求里豁免理由的展示清理 → Task 14b；「评审请求里的理由不截短、也改写不了屏幕」→ Task 15d-6。
  - 报告与评审请求里不可信文本的转义 → Task 13b、15e。
  - 「没写 covers 的套件给出提示」→ Task 15c；「改动没碰到任何套件」不出该提示 → Task 15c。
  - 「大改动不被代码规模挡住」「按需启用上限」的端到端用例 → Task 15d-1；「只改目录就能改档位含义」→ Task 15d-2。
  - 互斥的 CLI 出口、档位定义写错的 CLI 出口、旧策略不受归类影响 → Task 15d-3/4/5。
  - 与 `rework-document-mechanism` 合并 → Task 15a。
- **类型一致**：
  - `resolveStepTestPolicy`、`stageRunSet`、`claimChangedTestFiles`、`ResolvedLevel`、`TestClass`、`TestLevel` 在各任务中同名同形；
  - `StepTestPolicyIR.level` 只在档位派生策略上出现。
- **Review Focus** 五条分别落在 Task 5、8/7、7、4、7 的测试里。
