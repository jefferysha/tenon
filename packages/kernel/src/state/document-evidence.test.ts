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

/**
 * An ended task's directory moves into `archive/`, while its ledger keeps the paths it was recorded under. A caller
 * that reads the moved task says where those paths are now; the ledger and the digests it holds stay as they were.
 */
describe('evaluateDocumentEvidence with a relocated change directory', () => {
  const ARCHIVED = 'openspec/changes/archive/2026-10-05-demo'
  const MOVED_PROPOSAL = `${ARCHIVED}/proposal.md`
  const MOVED_DELTA = `${ARCHIVED}/specs/auth/spec.md`
  const locate = (path: string): string =>
    path.startsWith('openspec/changes/demo/') ? `${ARCHIVED}/${path.slice('openspec/changes/demo/'.length)}` : path

  async function movedFixture(files: Readonly<Record<string, string>>, records: readonly Record<string, unknown>[]): Promise<{ root: string; changeDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'tenon-document-evidence-'))
    roots.push(root)
    const changeDir = join(root, ARCHIVED)
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

  const evaluate = (root: string, changeDir: string, kind: 'proposal' | 'delta-spec', options?: Parameters<typeof evaluateDocumentEvidence>[5]) =>
    evaluateDocumentEvidence(root, changeDir, 'shape', { recordKinds: [kind], readKinds: [] }, WRITERS, options)

  it('the document at its new place with an unchanged digest is recorded; without the locator the old path reads as stale', async () => {
    const { root, changeDir } = await movedFixture({ [MOVED_PROPOSAL]: '# proposal\n' }, [record({})])

    expect((await evaluate(root, changeDir, 'proposal', { locate })).items).toMatchObject([{ kind: 'proposal', status: 'recorded' }])
    expect((await evaluate(root, changeDir, 'proposal')).items).toMatchObject([{ kind: 'proposal', status: 'stale', reason: 'changed' }])
  })

  it('a document edited after the move is stale (changed), and a missing one is stale too', async () => {
    const edited = await movedFixture({ [MOVED_PROPOSAL]: '# edited later\n' }, [record({})])
    expect((await evaluate(edited.root, edited.changeDir, 'proposal', { locate })).items).toMatchObject([{ status: 'stale', reason: 'changed' }])

    const gone = await movedFixture({}, [record({})])
    expect((await evaluate(gone.root, gone.changeDir, 'proposal', { locate })).items).toMatchObject([{ status: 'stale', reason: 'changed' }])
  })

  it('a recorded path the locator leaves alone is judged where it was recorded', async () => {
    const outside = record({ path: 'docs/notes/demo.md', sha256: sha('# note\n') })
    const intact = await movedFixture({ 'docs/notes/demo.md': '# note\n' }, [outside])
    expect((await evaluate(intact.root, intact.changeDir, 'proposal', { locate })).items).toMatchObject([{ status: 'recorded' }])

    const changed = await movedFixture({ 'docs/notes/demo.md': '# note edited\n' }, [outside])
    expect((await evaluate(changed.root, changed.changeDir, 'proposal', { locate })).items).toMatchObject([{ status: 'stale', reason: 'changed' }])

    // The old place still holds the file, but the locator moved this path: the old copy is not the document.
    const stale = await movedFixture({ 'openspec/changes/demo/proposal.md': '# proposal\n' }, [record({})])
    expect((await evaluate(stale.root, stale.changeDir, 'proposal', { locate })).items).toMatchObject([{ status: 'stale', reason: 'changed' }])
  })

  it('a delta-spec of the moved change is not a legacy path; one outside the change still is', async () => {
    const delta = record({ kind: 'delta-spec', path: 'openspec/changes/demo/specs/auth/spec.md', sha256: sha('# delta\n') })
    const moved = await movedFixture({ [MOVED_DELTA]: '# delta\n' }, [delta])
    expect((await evaluate(moved.root, moved.changeDir, 'delta-spec', { locate })).items).toMatchObject([{ kind: 'delta-spec', status: 'recorded' }])

    const legacy = record({ kind: 'delta-spec', path: 'openspec/changes/demo/delta.md', sha256: sha('# delta\n') })
    const old = await movedFixture({ [`${ARCHIVED}/delta.md`]: '# delta\n' }, [legacy])
    expect((await evaluate(old.root, old.changeDir, 'delta-spec', { locate })).items).toMatchObject([{ status: 'stale', reason: 'legacy-path' }])
  })

  it('the report keeps naming the paths the ledger recorded', async () => {
    const { root, changeDir } = await movedFixture({ [MOVED_PROPOSAL]: '# proposal\n' }, [record({})])

    expect((await evaluate(root, changeDir, 'proposal', { locate })).items[0]?.paths).toEqual([PROPOSAL])
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

/**
 * `role: update` 槽位此前完全不进证据面：kinds 只由 record/read/require 三类拼出来，
 * 于是「已登记的可更新文档」在 status 投影里恒为 missing，运行器照着 next 永远做不完。
 */
describe('role update mutable slots', () => {
  const UPDATE = policyOf([{ kind: 'design-md', ownerStep: 'build', role: 'update', producers: ['hue'] }])
  const DESIGN = 'DESIGN.md'
  const designRecord = record({ kind: 'design-md', path: DESIGN, sha256: sha('# design\n'), producer: 'hue' })

  it('已登记的 update 槽位：recorded，不再被投影成 missing', async () => {
    const { root, changeDir } = await fixture({ [DESIGN]: '# design\n' }, [designRecord])
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', {}, UPDATE)
    expect(report.items).toMatchObject([{ kind: 'design-md', status: 'recorded', producers: ['hue'] }])
    expect(report.pass).toBe(true)
  })

  it('未登记的 update 槽位：missing 但不阻断（update 是许可，不是出口前置）', async () => {
    const { root, changeDir } = await fixture({ [DESIGN]: '# design\n' }, [])
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', {}, UPDATE)
    expect(report.items).toMatchObject([{ kind: 'design-md', status: 'missing' }])
    expect(report.blockers).toEqual([])
    expect(report.pass).toBe(true)
  })

  it('内容变化的 update 槽位：stale 但不阻断', async () => {
    const { root, changeDir } = await fixture({ [DESIGN]: '# edited\n' }, [designRecord])
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', {}, UPDATE)
    expect(report.items).toMatchObject([{ kind: 'design-md', status: 'stale', reason: 'changed' }])
    expect(report.blockers).toEqual([])
  })

  it('收窄 record scope（回退边）时不投影 update 槽位', async () => {
    const { root, changeDir } = await fixture({ [DESIGN]: '# design\n' }, [designRecord])
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', { recordKinds: [], readKinds: [] }, UPDATE)
    expect(report.items).toEqual([])
  })
})
