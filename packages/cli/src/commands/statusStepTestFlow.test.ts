import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { replaceTestReportBlock, type SuiteVerdict, type TestPolicyReport } from '@tenon/kernel'
import { makeDeps } from '../test-support.js'
import { emptyStepDocuments, type StepDocumentsView } from './statusStepParts.js'
import { buildStepTestFlow } from './statusStepTestFlow.js'

const CHANGE = 'demo'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const suite = (run_id: string): SuiteVerdict => ({
  suite: 'unit', origin: 'catalog', kind: 'unit', reason: 'run', state: 'passed', run_id,
})

/** 一份只带一个新鲜通过套件的策略报告：追溯矩阵要写进验证报告。 */
function evidence(runId = 'run-1'): { readonly policy: TestPolicyReport; readonly items: readonly [] } {
  return {
    policy: {
      stepId: 'verify', pass: true, blockers: [], notices: [], suites: [suite(runId)], trace: [],
      files: { checked: false, unregistered: [], orphans: [] }, chain: 'empty', notApplicable: [],
    },
    items: [],
  }
}

async function project(files: Readonly<Record<string, string>> = {}): Promise<ReturnType<typeof makeDeps>> {
  const root = await mkdtemp(join(tmpdir(), 'step-test-flow-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return makeDeps({ cwd: root })
}

const observed = (required: readonly { readonly path: string; readonly status: 'produced' | 'missing' }[]): StepDocumentsView =>
  ({ ...emptyStepDocuments('observed'), required })

const REPORT = `docs/superpowers/reports/${CHANGE}-verify.md`

describe('验证报告路径：观察模式取必须产出里唯一不含通配符的那条', () => {
  test('报告已写出但没带最新运行 → test-report 动作指向 docs/superpowers/reports/<change>-verify.md', async () => {
    const deps = await project({ [REPORT]: '# 验证报告\n' })
    const documents = observed([
      { path: 'docs/superpowers/plans/*.md', status: 'produced' },
      { path: REPORT, status: 'missing' },
    ])
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), documents, null)
    expect(flow?.report).toEqual({ path: REPORT, command: `tenon test report ${CHANGE} --write ${REPORT}` })
  })

  test('报告已经带上最新运行 → 没有待写的报告', async () => {
    const deps = await project({ [REPORT]: replaceTestReportBlock('# 验证报告\n', '- run-1 passed') })
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence('run-1'), observed([{ path: REPORT, status: 'produced' }]), null)
    expect(flow?.report).toBeNull()
  })

  test('报告文件还没写出 → 没有待写的报告（先产出文件，再谈追溯矩阵）', async () => {
    const deps = await project()
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), observed([{ path: REPORT, status: 'missing' }]), null)
    expect(flow?.report).toBeNull()
  })

  test('没有不含通配符的必须产出 → 没有报告路径', async () => {
    const deps = await project({ [REPORT]: '# 验证报告\n' })
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), observed([{ path: 'docs/superpowers/reports/*.md', status: 'produced' }]), null)
    expect(flow?.report).toBeNull()
    expect((await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), observed([]), null))?.report).toBeNull()
  })

  test('不止一个不含通配符的必须产出 → 认不出哪个是报告，没有报告路径', async () => {
    const deps = await project({ [REPORT]: '# 验证报告\n', 'docs/other.md': '# 其他\n' })
    const documents = observed([{ path: REPORT, status: 'produced' }, { path: 'docs/other.md', status: 'produced' }])
    expect((await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), documents, null))?.report).toBeNull()
  })

  test('问号也是通配符', async () => {
    const deps = await project({ 'docs/report-1.md': '# r\n' })
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), observed([{ path: 'docs/report-?.md', status: 'produced' }]), null)
    expect(flow?.report).toBeNull()
  })
})

describe('验证报告路径：契约模式照旧取 verification-report 记录', () => {
  test('记录的路径就是报告路径', async () => {
    const deps = await project({ 'reports/vr.md': '# 验证报告\n' })
    const documents: StepDocumentsView = {
      mode: 'contract', reads: [], updates: [],
      records: [{ kind: 'verification-report', path: 'reports/vr.md', path_template: '', producers: [], status: 'recorded' }],
    }
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), documents, null)
    expect(flow?.report).toEqual({ path: 'reports/vr.md', command: `tenon test report ${CHANGE} --write reports/vr.md` })
  })

  test('没有 verification-report 记录 → 没有报告路径', async () => {
    const deps = await project()
    const flow = await buildStepTestFlow(deps, CHANGE, '/unused', evidence(), emptyStepDocuments('contract'), null)
    expect(flow?.report).toBeNull()
  })
})
