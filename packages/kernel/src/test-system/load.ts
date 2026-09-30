/**
 * 策略判定的 IO 装配：读目录、计划（含台账校验）、记录链、已知失败、基线、delta spec 场景与 tasks.md，
 * 再调用纯函数 evaluateTestPolicy。宿主能力（候选指纹、diff 文件列表）由调用方注入；
 * 候选指纹惰性求值且只在有记录可判时求一次（它要遍历整棵实现树）。
 *
 * 读取失败的口径：目录读不了 = 目录无效（挡）；已知失败清单读不了或格式错 = 按空清单处理
 * （失败不被豁免，失败关闭）；delta spec / tasks.md 缺失 = 没有可追溯的条目。
 */
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readTestBaselineV2, type TestBaselineV2 } from './baseline-v2.js'
import { formatCatalogIssues, parseTestCatalog } from './catalog.js'
import { evaluateTestPolicy } from './evaluate-v2.js'
import {
  baselineKey, type CatalogInput, type ChangedFilesReport, type ChangedFilesSource, type InlineSuiteStatus, type PlanInput,
  type TestPolicyEvaluationInput, type TestPolicyReport,
} from './evaluate-types.js'
import { parseKnownFailures, type KnownFailure } from './known-failures.js'
import { extractScenarios, extractTaskItems, type OpenSpecScenario, type TaskItem } from './openspec-trace.js'
import { baselineV2Path, testSystemPaths } from './paths.js'
import { readTestPlanState } from './plan-ledger.js'
import { readRecordChain, type ChainReport, type RecordChainCache } from './record-chain.js'
import type { StepTestPolicyIR } from '../workflow/ir.js'
import type { PipelineTodoStageDefinition } from '../workflow/todo-projection.js'

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_CAPABILITIES = 256

async function readBounded(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.size > MAX_TEXT_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export async function loadCatalogInput(repoRoot: string): Promise<CatalogInput> {
  const path = testSystemPaths(repoRoot).catalog
  let text: string
  try {
    const entry = await lstat(path)
    if (!entry.isFile()) return { state: 'invalid', issues: ['catalog.yaml 不是普通文件'] }
    if (entry.size > MAX_TEXT_BYTES) return { state: 'invalid', issues: ['catalog.yaml 超过 1 MiB'] }
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', issues: [`catalog.yaml 无法读取：${(error as Error).message}`] }
  }
  const result = parseTestCatalog(text)
  return result.ok ? { state: 'ok', catalog: result.catalog } : { state: 'invalid', issues: formatCatalogIssues(result.issues) }
}

export async function loadKnownFailures(repoRoot: string): Promise<readonly KnownFailure[]> {
  const text = await readBounded(testSystemPaths(repoRoot).knownFailures)
  if (text === undefined) return []
  const result = parseKnownFailures(text)
  return result.ok ? result.entries : []
}

export async function loadDeltaScenarios(changeDir: string): Promise<readonly OpenSpecScenario[]> {
  let names: string[]
  try {
    names = (await readdir(join(changeDir, 'specs'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_CAPABILITIES)
  } catch {
    return []
  }
  const out: OpenSpecScenario[] = []
  for (const capability of names) {
    const text = await readBounded(join(changeDir, 'specs', capability, 'spec.md'))
    if (text !== undefined) out.push(...extractScenarios(capability, text))
  }
  return out
}

/** `stages` = 任务冻结的工作流阶段（id + 名称），用来认 tasks.md 的阶段小节；缺省 = 默认工作流的七个阶段。 */
export async function loadTaskItems(changeDir: string, stages?: readonly PipelineTodoStageDefinition[]): Promise<readonly TaskItem[]> {
  const text = await readBounded(join(changeDir, 'tasks.md'))
  return text === undefined ? [] : extractTaskItems(text, stages)
}

async function loadBaselines(
  repoRoot: string,
  catalog: CatalogInput,
  chain: ChainReport,
): Promise<ReadonlyMap<string, TestBaselineV2>> {
  const out = new Map<string, TestBaselineV2>()
  if (catalog.state !== 'ok' || chain.state !== 'intact') return out
  const benchmarkSuites = new Set(catalog.catalog.suites.filter((suite) => suite.benchmark !== undefined).map((suite) => suite.id))
  for (const record of chain.active) {
    for (const run of record.suites) {
      if (!benchmarkSuites.has(run.suite)) continue
      const key = baselineKey(run.suite, record.machine_profile)
      if (out.has(key)) continue
      const result = await readTestBaselineV2(baselineV2Path(repoRoot, run.suite, record.machine_profile))
      if (result.state === 'ok' && result.baseline.suite === run.suite && result.baseline.profile === record.machine_profile) {
        out.set(key, result.baseline)
      }
    }
  }
  return out
}

export interface StepTestPolicyLoadInput {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly slug: string
  readonly stepId: string
  readonly policy: StepTestPolicyIR
  /** 任务冻结的工作流阶段；tasks.md 的阶段小节按它识别（缺省 = 默认七阶段）。 */
  readonly stages?: readonly PipelineTodoStageDefinition[]
  readonly inline: readonly InlineSuiteStatus[]
  readonly workflowFingerprint: string
  readonly workflowRunId: string | undefined
  /** undefined = 宿主没有指纹能力；null = 能力在但取不到。 */
  readonly candidate: () => Promise<string | null | undefined>
  /** 纯列表，或带「未跟踪文件被截断」标记的结果；后者让测试策略给出显式提示。 */
  readonly changedFiles?: () => Promise<ChangedFilesSource>
  readonly now: number
  readonly exitEvent?: string
  /** 长驻进程（Dashboard 快照）传入：记录文件指纹没变就不重读、不重算摘要；缺省 = 每次从磁盘完整校验。 */
  readonly recordChainCache?: RecordChainCache
}

export async function evaluateStepTestPolicy(input: StepTestPolicyLoadInput): Promise<TestPolicyReport> {
  const [catalog, plan, chain, knownFailures, scenarios, tasks] = await Promise.all([
    loadCatalogInput(input.repoRoot),
    readTestPlanState(input.changeDir, input.changeName),
    readRecordChain(input.repoRoot, input.slug, input.changeName, input.recordChainCache),
    loadKnownFailures(input.repoRoot),
    loadDeltaScenarios(input.changeDir),
    loadTaskItems(input.changeDir, input.stages),
  ])
  const planInput: PlanInput = plan.state === 'ok' ? { state: 'ok', plan: plan.plan, digest: plan.digest } : plan
  const hasRecords = chain.state === 'intact' && chain.active.length > 0
  const candidate = hasRecords ? await input.candidate() : undefined
  let changedFiles: readonly string[] | undefined
  let changedFilesTruncated: TestPolicyEvaluationInput['changedFilesTruncated']
  let changedFilesError: string | undefined
  if (input.policy.files === 'registered' && input.changedFiles !== undefined) {
    try {
      const source = await input.changedFiles()
      const report: ChangedFilesReport = Array.isArray(source) ? { files: source } : (source as ChangedFilesReport)
      changedFiles = report.files
      changedFilesTruncated = report.untrackedTruncated
    } catch (error) {
      changedFilesError = error instanceof Error ? error.message.slice(0, 200) : '读取失败'
    }
  }
  return evaluateTestPolicy({
    change: input.changeName,
    stepId: input.stepId,
    policy: input.policy,
    inline: input.inline,
    catalog,
    plan: planInput,
    chain,
    knownFailures,
    baselines: await loadBaselines(input.repoRoot, catalog, chain),
    changedFiles,
    ...(changedFilesError === undefined ? {} : { changedFilesError }),
    ...(changedFilesTruncated === undefined ? {} : { changedFilesTruncated }),
    scenarios,
    tasks,
    bindings: { candidate, workflowFingerprint: input.workflowFingerprint, workflowRunId: input.workflowRunId },
    today: new Date(input.now).toISOString().slice(0, 10),
    ...(input.exitEvent === undefined ? {} : { exitEvent: input.exitEvent }),
  })
}
