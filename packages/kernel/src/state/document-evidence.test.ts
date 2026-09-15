import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { documentGovernancePolicy } from '../workflow/document-contract.js'
import type { WorkflowDocumentSlot } from '../workflow/types.js'
import { evaluateDocumentEvidence } from './document-evidence.js'

const NOW = '2026-09-15T00:00:00Z'
const roots: string[] = []
const PROPOSAL = 'openspec/changes/demo/proposal.md'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function policyOf(slots: WorkflowDocumentSlot[]) {
  const policy = documentGovernancePolicy('custom', {
    openspec: true,
    documentContract: { version: 'v1', slots, reads: [] },
    steps: [{ id: 'shape' }, { id: 'build' }],
  })
  if (policy === undefined) throw new Error('expected document-v1 policy')
  return policy
}

const WRITERS = policyOf([
  { kind: 'proposal', ownerStep: 'shape', producers: ['openspec-propose'] },
  { kind: 'delta-spec', ownerStep: 'shape', producers: ['openspec-propose'] },
])

async function fixture(files: Readonly<Record<string, string>>, records: readonly Record<string, unknown>[]): Promise<{ root: string; changeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-document-evidence-'))
  roots.push(root)
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
  await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
    version: 1, contract: 'openspec-v1', createdAt: NOW, records,
  }, null, 2)}\n`, 'utf8')
  return { root, changeDir }
}

const record = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'proposal', path: PROPOSAL, sha256: sha('# proposal\n'), producer: 'openspec-propose', recordedAt: NOW, reads: [], ...over,
})

describe('evaluateDocumentEvidence stale reasons', () => {
  it.each([
    ['changed', { [PROPOSAL]: '# edited\n' }, record({}), 'proposal'],
    ['producer', { [PROPOSAL]: '# proposal\n' }, record({ producer: 'intruder' }), 'proposal'],
    ['legacy-path', { 'openspec/changes/demo/delta.md': '# delta\n' }, record({ kind: 'delta-spec', path: 'openspec/changes/demo/delta.md', sha256: sha('# delta\n') }), 'delta-spec'],
    ['invocation', { [PROPOSAL]: '# proposal\n' }, record({
      producerInvocation: {
        confirmationInvocationId: `invocation-${'a'.repeat(64)}`,
        evidenceScope: 'native',
        stepVisit: { runId: 'run-1', transitionSequence: 0 },
      },
    }), 'proposal'],
  ] as const)('%s', async (reason, files, entry, kind) => {
    const { root, changeDir } = await fixture(files, [entry])
    const report = await evaluateDocumentEvidence(root, changeDir, 'shape', { recordKinds: [kind], readKinds: [] }, WRITERS)
    expect(report.pass).toBe(false)
    expect(report.items).toMatchObject([{ kind, status: 'stale', reason }])
  })

  it('recorded / missing items carry no reason', async () => {
    const { root, changeDir } = await fixture({}, [])
    const report = await evaluateDocumentEvidence(root, changeDir, 'shape', { recordKinds: ['proposal'], readKinds: [] }, WRITERS)
    expect(report.items[0]?.status).toBe('missing')
    expect(report.items[0]).not.toHaveProperty('reason')
  })
})

describe('role require project documents', () => {
  const REQUIRE = policyOf([{ kind: 'design-md', ownerStep: 'build', role: 'require', producers: [] }])

  it('DESIGN.md 存在且非空：recorded，不检查 producer 与 invocation', async () => {
    const { root, changeDir } = await fixture({ 'DESIGN.md': '# Design system\n' }, [])
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', {}, REQUIRE)
    expect(report).toMatchObject({ pass: true, blockers: [] })
    expect(report.items).toEqual([{ kind: 'design-md', status: 'recorded', requiredRead: false, paths: ['DESIGN.md'], producers: [], timeline: [] }])
  })

  it('DESIGN.md 缺失：missing + 项目文档 blocker（E16）；收窄 record scope 时不检查 require', async () => {
    const { root, changeDir } = await fixture({}, [])
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', {}, REQUIRE)
    expect(report.pass).toBe(false)
    expect(report.blockers).toEqual(["缺少项目文档 'design-md'（DESIGN.md）"])
    expect(report.items).toMatchObject([{ kind: 'design-md', status: 'missing' }])
    const narrowed = await evaluateDocumentEvidence(root, changeDir, 'build', { recordKinds: [], readKinds: [] }, REQUIRE)
    expect(narrowed.items).toEqual([])
    const shape = await evaluateDocumentEvidence(root, changeDir, 'shape', {}, REQUIRE)
    expect(shape.items).toEqual([])
  })
})
