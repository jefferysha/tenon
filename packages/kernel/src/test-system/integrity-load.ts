/**
 * 一个任务当前的测试完整性报告（不经步骤策略的「该不该判」闸）：`tenon test integrity` 与 CI 校验读它。
 * 运行记录取本 workflow run 里完好链上的记录；读不出改动行时只给运行记录类信号并标 unavailable。
 */
import { readCurrentRunRevision } from '../state/run-revision-store.js'
import { loadCatalogInput } from './load.js'
import {
  evaluateIntegrity, integrityRunSamples, unavailableIntegrity, type IntegrityMode, type TestIntegrityReport,
} from './integrity.js'
import { integrityPathFilter, integritySuiteOf, type IntegrityDiffSource } from './integrity-diff.js'
import { readRecordChain } from './record-chain.js'

export async function loadIntegrityReport(input: {
  readonly repoRoot: string
  readonly changeDir: string
  readonly changeName: string
  readonly slug: string
  readonly mode: IntegrityMode
  readonly integrityDiff: IntegrityDiffSource
}): Promise<TestIntegrityReport> {
  const [catalog, chain, runId] = await Promise.all([
    loadCatalogInput(input.repoRoot),
    readRecordChain(input.repoRoot, input.slug, input.changeName),
    readCurrentRunRevision(input.changeDir).then((current) => current?.state.runMetadata?.runId, () => undefined),
  ])
  const known = catalog.state === 'ok' ? catalog.catalog : undefined
  const runs = integrityRunSamples(chain.state === 'intact' && runId !== undefined
    ? chain.active.filter((record) => record.workflow_run_id === runId)
    : [])
  try {
    const diff = await input.integrityDiff(integrityPathFilter(known))
    return evaluateIntegrity({ diff, runs, suiteOf: integritySuiteOf(known) }, input.mode)
  } catch (error) {
    return unavailableIntegrity(input.mode, error instanceof Error ? error.message.slice(0, 200) : '读取失败', runs)
  }
}
