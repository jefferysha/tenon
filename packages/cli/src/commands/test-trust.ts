/**
 * `tenon test trust [change] [--yes] [--status] [--json]` 与执行前的信任校验（R6）。
 *
 * 测试目录（`.tenon/tests/catalog.yaml`）里的 `command` / `services[].start`，以及任务冻结工作流里的步骤内联测试命令，
 * 都是仓库带来的、`tenon test run` 会在本机直接执行的文字。克隆来的仓库可以在里面写任何命令，所以用户在本机
 * 首次执行之前必须确认一次。信任按「用户 + 仓库 + 单条命令」记在用户级状态目录（kernel trust-store.ts）：同一仓库的
 * 所有 worktree 共享，只有新增或改动的命令要重新确认，只改标签、tags、covers 不会。
 *
 * 判定顺序（每条要执行的命令）：
 *   1. `TENON_TEST_TRUST=1`（CI 显式信任，每次运行在 stderr 留一行说明）；
 *   2. 有仓库身份（repo-identity.ts：git common dir，且检出被 git 登记）时，用户级存储里有 (仓库, 命令摘要)；
 *   3. 不是 git 仓库时，检出里旧封存（kernel seal.ts）的 `trusted[]` 含当前整份可执行摘要 → 整份信任；
 *   4. 否则列出未信任的命令，以退出码 1 拒绝，不执行任何命令。
 * git 仓库只认用户级存储，不认检出里的旧封存：检出里的任何文件（包括封存与它的密钥）都可能随仓库提交或压缩包一起带来，
 * 能算好封印自带信任，不论是否被 git 跟踪。以前在检出里信任过的命令，要在自己的终端里重新运行一次 `tenon test trust`。
 * 退回检出旧封存只发生在「不是 git 仓库」：检出目录及其所有上级都没有 `.git`，这时 `tenon test trust` 也写检出里的旧封存。
 * 有 `.git` 却读不出仓库身份（git 出错、超时、不可用，或 `.git` 是不在 worktree 列表里的伪造指针）一律未信任，既不查用户级存储
 * 也不看旧封存，`tenon test trust` 同样拒绝写入：否则克隆来的仓库只要让 git 出错，自带的封存与密钥就能自行授信。
 *
 * 信任只能由用户给：
 *   · 交互终端上逐条列出将要信任的命令，回答 y 才记；非交互必须 `--yes`；
 *   · 宿主 hook（gate.sh）拒绝 agent 的 Bash 里出现 `tenon test trust` 与 `TENON_TEST_TRUST`，也拒绝写任何 test-trust 目录下的路径，
 *     所以 agent 替用户点不了这个头；
 *   · CI 环境由运行器显式设置 `TENON_TEST_TRUST=1` 预先信任。
 */
import {
  addTrustEntries, catalogExecDigest, catalogExecEntries, isTrusted, readTestSeal, readTrustStore, stepTestExecEntries,
  stepTestsExecDigest, updateTestSeal, userSlug,
  type EffectiveWorkflowPlan, type ExecEntry, type TestCatalog,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { readCatalogFile } from '../test-system/project-files.js'
import { repoTrustIdentity } from '../test-system/repo-identity.js'
import { requireUser } from '../userIdentity.js'
import { REAL_INIT_WIZARD_ENV, type InitWizardEnv } from './init.js'
import { resolveTestCommand } from './test-context.js'

export const TRUST_ENV = 'TENON_TEST_TRUST'

export type TrustTargetKind = 'catalog' | 'step-tests'

export interface TrustTarget {
  readonly kind: TrustTargetKind
  /** 整份可执行摘要：检出旧封存里记着它，就整份视为已信任（兼容）。 */
  readonly digest: string
  /** 本次要校验的命令，逐条（含给用户确认用的一行）。 */
  readonly entries: readonly ExecEntry[]
}

/** 目录里的命令；`suiteIds` 给出时只校验这些套件（本次要执行的），缺省 = 整个目录。 */
export function catalogTrustTarget(catalog: TestCatalog, suiteIds?: readonly string[]): TrustTarget {
  return { kind: 'catalog', digest: catalogExecDigest(catalog), entries: catalogExecEntries(catalog, suiteIds) }
}

/** 任务冻结工作流里的步骤内联测试；`testIds` 给出时只校验这些测试（本次要执行的），缺省 = 全部。没有步骤测试 = undefined。 */
export function stepTestsTrustTarget(plan: EffectiveWorkflowPlan, testIds?: readonly string[]): TrustTarget | undefined {
  const tests = plan.workflow.steps.flatMap((step) => (step.tests ?? []).map((test) => ({ step: step.id, ...test })))
  if (tests.length === 0) return undefined
  const wanted = tests.filter((test) => testIds === undefined || testIds.includes(test.id))
  return { kind: 'step-tests', digest: stepTestsExecDigest(tests), entries: stepTestExecEntries(wanted) }
}

const KIND_WORD: Readonly<Record<TrustTargetKind, string>> = { catalog: '测试目录', 'step-tests': '任务的步骤测试' }

const UNRESOLVED_REASON = '当前目录有 .git，但读不出仓库身份（git 出错、超时，或 .git 是不在 git worktree 列表里的伪造指针）'

/** git 仓库的信任只记在用户级存储里；没有用户级状态目录就没有地方可写，`tenon test trust` 与执行前的校验都据此拒绝。 */
const NO_USER_STATE_ROOT = '没有用户级状态目录：git 仓库的信任只记在用户级存储里，写不进去'

/** 用户级信任的作用域，由仓库身份（repo-identity.ts）三态推出。 */
export type TrustScope =
  /** git 仓库；`stateRoot` 经 deps.productPaths（测试注入临时目录），缺失时没有用户级存储。 */
  | { readonly kind: 'user'; readonly repo: string; readonly stateRoot: string | undefined }
  /** 不是 git 仓库：没有仓库身份可记，只认检出旧封存。 */
  | { readonly kind: 'checkout' }
  /** 有 `.git` 却读不出身份：一律未信任。 */
  | { readonly kind: 'unresolved' }

/** 取一次、传给同一次命令里的所有 `untrustedEntries`（身份要起两个 git 进程）。 */
export async function trustScope(deps: CliDeps): Promise<TrustScope> {
  const identity = await repoTrustIdentity(deps.cwd)
  if (identity.kind === 'not-repo') return { kind: 'checkout' }
  if (identity.kind === 'unresolved') return { kind: 'unresolved' }
  return { kind: 'user', repo: identity.repo, stateRoot: deps.productPaths?.().stateRoot }
}

/** 用户级存储里这个仓库已经记下的命令摘要；没有用户级存储 = 空。 */
async function storedDigests(slug: string, scope: Extract<TrustScope, { kind: 'user' }>): Promise<ReadonlySet<string>> {
  if (scope.stateRoot === undefined) return new Set()
  return new Set((await readTrustStore(scope.stateRoot, slug)).filter((entry) => entry.repo === scope.repo).map((entry) => entry.digest))
}

/**
 * 本次要校验的命令里还没有得到信任的那几条（判定顺序 2、3）；全部信任 = 空。
 *   · `unresolved`（有 `.git` 却读不出身份）：全部未信任，不查存储也不看旧封存；
 *   · `checkout`（不是 git 仓库）：只看检出旧封存，按规格有效；
 *   · `user`（git 仓库）：只查用户级存储；不看检出里的旧封存，它可能随仓库或压缩包一起带来，不论是否被 git 跟踪。
 */
export async function untrustedEntries(
  deps: CliDeps,
  slug: string,
  target: TrustTarget,
  scope: TrustScope,
): Promise<readonly ExecEntry[]> {
  if (target.entries.length === 0) return []
  if (scope.kind === 'unresolved') return target.entries
  if (scope.kind === 'user') {
    const stored = await storedDigests(slug, scope)
    return target.entries.filter((entry) => !stored.has(entry.digest))
  }
  const { seal } = await readTestSeal(deps.cwd, slug)
  return isTrusted(seal, target.digest) ? [] : target.entries
}

/** 检出里的旧封存恰好记着当前整份摘要：这份旧信任在 git 仓库里不再被认。只读；读不出就当没有，提示本身不能抛错。 */
async function legacyTrustIgnored(deps: CliDeps, slug: string, target: TrustTarget): Promise<boolean> {
  try {
    return isTrusted((await readTestSeal(deps.cwd, slug)).seal, target.digest)
  } catch {
    return false
  }
}

/**
 * 执行前的信任校验。本次要执行的命令都已信任，或环境显式信任，返回 true；否则只列出未信任的命令与确认办法，
 * 返回 false，调用方以 exit 1 收尾、不执行任何命令、不写记录。
 */
export async function ensureTrusted(
  deps: CliDeps,
  slug: string,
  target: TrustTarget,
  change: string,
): Promise<boolean> {
  if (deps.env?.(TRUST_ENV) === '1') {
    deps.io.err(`NOTE: ${KIND_WORD[target.kind]}的命令按环境变量 ${TRUST_ENV}=1 视为已信任（CI 显式信任）`)
    return true
  }
  const scope = await trustScope(deps)
  const pending = await untrustedEntries(deps, slug, target, scope)
  if (pending.length === 0) return true
  deps.io.err(`ERROR: ${KIND_WORD[target.kind]}里的命令还没有得到你的信任：它们来自仓库（可能是克隆来的），首次执行前需要你在本机确认一次。`)
  deps.io.err('未信任的命令：')
  for (const entry of pending.slice(0, 20)) deps.io.err(`  ${entry.line}`)
  if (pending.length > 20) deps.io.err(`  … 另有 ${pending.length - 20} 条`)
  if (scope.kind === 'unresolved') {
    deps.io.err(`${UNRESOLVED_REASON}：此时运行 tenon test trust 也写不进去，先修好 git 再试；CI 由运行器设置 ${TRUST_ENV}=1 显式信任`)
    return false
  }
  if (scope.kind === 'user' && scope.stateRoot === undefined) {
    deps.io.err(`${NO_USER_STATE_ROOT}：此时运行 tenon test trust 也写不进去；CI 由运行器设置 ${TRUST_ENV}=1 显式信任`)
    return false
  }
  deps.io.err(`请你在自己的终端里运行 tenon test trust ${change} 逐条确认（agent 不能替你确认）；CI 由运行器设置 ${TRUST_ENV}=1 显式信任`)
  if (scope.kind === 'user' && await legacyTrustIgnored(deps, slug, target)) {
    deps.io.err(`检出里的旧信任在 git 仓库里不再被认，请在你自己的终端重新运行 tenon test trust ${change} 确认一次`)
  }
  return false
}

export interface TrustOptions {
  readonly yes?: boolean
  readonly status?: boolean
  readonly json?: boolean
}

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

interface TargetState {
  readonly target: TrustTarget
  readonly pending: readonly ExecEntry[]
}

function printStatus(deps: CliDeps, states: readonly TargetState[], json: boolean): void {
  if (json) {
    deps.io.out(JSON.stringify(states.map(({ target, pending }) => ({
      kind: target.kind,
      digest: target.digest,
      trusted: pending.length === 0,
      commands: target.entries.map((entry) => entry.line),
      entries: target.entries.map((entry) => ({ digest: entry.digest, line: entry.line, trusted: !pending.includes(entry) })),
    })), null, 2))
    return
  }
  for (const { target, pending } of states) {
    deps.io.out(`[TEST] ${KIND_WORD[target.kind]}：${pending.length === 0 ? '已信任' : '未信任'}（${target.digest}）`)
    for (const entry of target.entries) deps.io.out(`  ${pending.includes(entry) ? '未信任' : '已信任'}  ${entry.line}`)
  }
}

async function confirm(deps: CliDeps, env: InitWizardEnv, count: number): Promise<boolean> {
  const prompter = env.makePrompter()
  let answer: string
  try {
    answer = (await prompter.ask(`信任以上 ${count} 条命令，并允许 tenon test run 在本机执行？[y/N] `)).trim()
  } finally {
    prompter.close()
  }
  if (/^y(es)?$/iu.test(answer)) return true
  deps.io.err('未信任，什么都没有执行')
  return false
}

export async function cmdTestTrust(
  deps: CliDeps,
  change: string | undefined,
  opts: TrustOptions,
  env: InitWizardEnv = REAL_INIT_WIZARD_ENV,
): Promise<number> {
  const user = requireUser(deps)
  if (user === null) return 1
  const slug = userSlug(user.id)
  const targets: TrustTarget[] = []
  const catalogFile = await readCatalogFile(deps.cwd)
  if (catalogFile.state === 'invalid') return fail(deps, `catalog.yaml 无效：${catalogFile.issues.slice(0, 3).join('；')}`)
  if (catalogFile.state === 'ok' && (catalogFile.catalog.suites.length > 0 || catalogFile.catalog.services.length > 0)) {
    targets.push(catalogTrustTarget(catalogFile.catalog))
  }
  if (change !== undefined) {
    const context = await resolveTestCommand(deps, change, { requireOwner: false })
    if (typeof context === 'number') return context
    const steps = stepTestsTrustTarget(context.plan)
    if (steps !== undefined) targets.push(steps)
  }
  if (targets.length === 0) {
    deps.io.out('[TEST] 没有需要信任的测试命令')
    return 0
  }
  const scope = await trustScope(deps)
  const states: TargetState[] = []
  for (const target of targets) states.push({ target, pending: await untrustedEntries(deps, slug, target, scope) })
  if (opts.json === true || opts.status === true) {
    printStatus(deps, states, opts.json === true)
    // 列表模式只看不写：全部已信任 exit 0，有未信任的 exit 2。
    return states.every((item) => item.pending.length === 0) ? 0 : 2
  }
  const open = states.filter((item) => item.pending.length > 0)
  if (open.length === 0) {
    deps.io.out('[TEST] 已信任，无需再确认')
    return 0
  }
  // 读不出身份就没有地方可写：用户级存储要仓库身份，检出旧封存又不被认。先拒绝，不让用户为写不进去的东西确认。
  if (scope.kind === 'unresolved') {
    return fail(deps, `${UNRESOLVED_REASON}：信任既写不进去也不会被认，先修好 git 再试`)
  }
  // git 仓库不认检出旧封存，没有用户级状态目录就没有地方可写：同样先拒绝，不让用户为写不进去的东西确认。
  if (scope.kind === 'user' && scope.stateRoot === undefined) {
    return fail(deps, NO_USER_STATE_ROOT)
  }
  for (const { target, pending } of open) {
    deps.io.out(`[TEST] ${KIND_WORD[target.kind]}将被信任的命令（${pending.length} 条）：`)
    for (const entry of pending) deps.io.out(`  ${entry.line}`)
  }
  const total = open.reduce((sum, item) => sum + item.pending.length, 0)
  if (opts.yes !== true) {
    if (!env.isInteractive()) {
      return fail(deps, '信任需要你本人确认：在交互终端里运行本命令回答 y，或在你自己的终端 / CI 里加 --yes')
    }
    if (!(await confirm(deps, env, total))) return 1
  }
  const at = deps.clock()
  if (scope.kind === 'user' && scope.stateRoot !== undefined) {
    const { repo, stateRoot } = scope
    try {
      await addTrustEntries(stateRoot, slug, open.flatMap(({ pending }) => pending).map((entry) => ({
        repo, digest: entry.digest, command: entry.line, by: user.id, at,
      })))
    } catch (error) {
      return fail(deps, `无法写入用户级信任存储：${errMsg(error)}`)
    }
    deps.io.out(`[TEST] 已信任 ${total} 条命令（本仓库的所有 worktree 共享）；之后只有新增或改动的命令需要重新确认`)
    return 0
  }
  try {
    await updateTestSeal(deps.cwd, slug, (current) => ({
      ...current,
      trusted: [
        ...current.trusted,
        ...open.filter(({ target }) => !isTrusted(current, target.digest)).map(({ target }) => ({ digest: target.digest, by: user.id, at })),
      ],
    }))
  } catch (error) {
    return fail(deps, `无法写入检出里的旧封存：${errMsg(error)}`)
  }
  deps.io.out(`[TEST] 已信任 ${open.map(({ target }) => KIND_WORD[target.kind]).join('、')}（当前目录不是 git 仓库，信任只记在本检出里）；命令改动（摘要变化）后需要重新确认`)
  return 0
}
