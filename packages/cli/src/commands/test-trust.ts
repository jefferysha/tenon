/**
 * `tenon test trust [change] [--yes] [--status] [--json]` 与执行前的信任校验（R6）。
 *
 * 测试目录（`.tenon/tests/catalog.yaml`）里的 `command` / `services[].start`，以及任务冻结工作流里的步骤内联测试命令，
 * 都是仓库带来的、`tenon test run` 会在本机直接执行的文字。克隆来的仓库可以在里面写任何命令，所以用户在本机
 * 首次执行之前必须确认一次：确认记在用户本地的封存文件里（kernel seal.ts，按可执行摘要），摘要变了（任何一条命令变了）
 * 要重新确认，只改标签、tags、covers 不会。
 *
 * 信任只能由用户给：
 *   · 交互终端上逐条列出将要信任的命令，回答 y 才记；非交互必须 `--yes`；
 *   · 宿主 hook（gate.sh）拒绝 agent 的 Bash 里出现 `tenon test trust` 与 `TENON_TEST_TRUST`，所以 agent 替用户点不了这个头；
 *   · CI 环境由运行器显式设置 `TENON_TEST_TRUST=1` 预先信任（每次运行都会在 stderr 留一行说明信任来自环境）。
 */
import {
  catalogExecDigest, isTrusted, readTestSeal, stepTestsExecDigest, updateTestSeal, userSlug,
  type EffectiveWorkflowPlan, type TestCatalog,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { readCatalogFile } from '../test-system/project-files.js'
import { requireUser } from '../userIdentity.js'
import { REAL_INIT_WIZARD_ENV, type InitWizardEnv } from './init.js'
import { resolveTestCommand } from './test-context.js'

export const TRUST_ENV = 'TENON_TEST_TRUST'

export type TrustTargetKind = 'catalog' | 'step-tests'

export interface TrustTarget {
  readonly kind: TrustTargetKind
  readonly digest: string
  /** 将要执行的命令，一条一行（给用户确认用）。 */
  readonly lines: readonly string[]
}

export function catalogTrustTarget(catalog: TestCatalog): TrustTarget {
  return {
    kind: 'catalog',
    digest: catalogExecDigest(catalog),
    lines: [
      ...catalog.suites.map((suite) => `套件 ${suite.id}（${suite.kind}）  $ ${suite.command}${suite.cwd === '.' ? '' : `  [cwd=${suite.cwd}]`}`),
      ...catalog.suites.flatMap((suite) => [
        ...(suite.select?.files === undefined ? [] : [`套件 ${suite.id} 按文件运行  $ ${suite.select.files}`]),
        ...(suite.select?.grep === undefined ? [] : [`套件 ${suite.id} 按用例名运行  $ ${suite.select.grep}`]),
      ]),
      ...catalog.services.map((service) => `服务 ${service.id}  $ ${service.start}${service.cwd === '.' ? '' : `  [cwd=${service.cwd}]`}`),
    ],
  }
}

export function stepTestsTrustTarget(plan: EffectiveWorkflowPlan): TrustTarget | undefined {
  const tests = plan.workflow.steps.flatMap((step) => (step.tests ?? []).map((test) => ({ step: step.id, ...test })))
  if (tests.length === 0) return undefined
  return {
    kind: 'step-tests',
    digest: stepTestsExecDigest(tests),
    lines: tests.map((test) => `步骤 ${test.step} 的测试 ${test.id}  $ ${test.command}${test.cwd === '.' ? '' : `  [cwd=${test.cwd}]`}`),
  }
}

const KIND_WORD: Readonly<Record<TrustTargetKind, string>> = { catalog: '测试目录', 'step-tests': '任务的步骤测试' }

/**
 * 执行前的信任校验。已信任（封存里有这个摘要）或环境显式信任返回 true；否则打印将执行的命令与确认办法，返回 false，
 * 调用方以 exit 1 收尾、不执行任何命令、不写记录。
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
  const { seal } = await readTestSeal(deps.cwd, slug)
  if (isTrusted(seal, target.digest)) return true
  deps.io.err(`ERROR: ${KIND_WORD[target.kind]}里的命令还没有得到你的信任：它们来自仓库（可能是克隆来的），首次执行前需要你在本机确认一次。`)
  deps.io.err('将要执行的命令：')
  for (const line of target.lines.slice(0, 20)) deps.io.err(`  ${line}`)
  if (target.lines.length > 20) deps.io.err(`  … 另有 ${target.lines.length - 20} 条`)
  deps.io.err(`请你在自己的终端里运行 tenon test trust ${change} 逐条确认（agent 不能替你确认）；CI 由运行器设置 ${TRUST_ENV}=1 显式信任`)
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
  const { seal } = await readTestSeal(deps.cwd, slug)
  const states = targets.map((target) => ({ target, trusted: isTrusted(seal, target.digest) }))
  if (opts.json === true || opts.status === true) {
    if (opts.json === true) {
      deps.io.out(JSON.stringify(states.map((item) => ({ kind: item.target.kind, digest: item.target.digest, trusted: item.trusted, commands: item.target.lines })), null, 2))
    } else {
      for (const item of states) deps.io.out(`[TEST] ${KIND_WORD[item.target.kind]}：${item.trusted ? '已信任' : '未信任'}（${item.target.digest}）`)
    }
    // 列表模式只看不写：全部已信任 exit 0，有未信任的 exit 2。
    return states.every((item) => item.trusted) ? 0 : 2
  }
  const pending = states.filter((item) => !item.trusted).map((item) => item.target)
  if (pending.length === 0) {
    deps.io.out('[TEST] 已信任，无需再确认')
    return 0
  }
  for (const target of pending) {
    deps.io.out(`[TEST] ${KIND_WORD[target.kind]}将被信任的命令（${target.digest}）：`)
    for (const line of target.lines) deps.io.out(`  ${line}`)
  }
  if (opts.yes !== true) {
    if (!env.isInteractive()) {
      return fail(deps, '信任需要你本人确认：在交互终端里运行本命令回答 y，或在你自己的终端 / CI 里加 --yes')
    }
    const prompter = env.makePrompter()
    let answer: string
    try {
      answer = (await prompter.ask(`信任以上 ${pending.reduce((sum, target) => sum + target.lines.length, 0)} 条命令，并允许 tenon test run 在本机执行？[y/N] `)).trim()
    } finally {
      prompter.close()
    }
    if (!/^y(es)?$/iu.test(answer)) {
      deps.io.err('未信任，什么都没有执行')
      return 1
    }
  }
  const at = deps.clock()
  await updateTestSeal(deps.cwd, slug, (current) => ({
    ...current,
    trusted: [
      ...current.trusted,
      ...pending.filter((target) => !isTrusted(current, target.digest)).map((target) => ({ digest: target.digest, by: user.id, at })),
    ],
  }))
  deps.io.out(`[TEST] 已信任 ${pending.map((target) => KIND_WORD[target.kind]).join('、')}；命令改动（摘要变化）后需要重新确认`)
  return 0
}
