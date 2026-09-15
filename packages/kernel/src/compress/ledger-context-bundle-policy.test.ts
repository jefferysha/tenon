import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { documentGovernancePolicy } from '../workflow/document-contract.js'
import { LedgerContextBundleError } from './ledger-context-bundle.js'
import { compileLedgerContextBundle } from './ledger-context-bundle-node-adapter.js'

const roots: string[] = []
const PROPOSAL = { kind: 'proposal', path: 'openspec/changes/demo/proposal.md', content: '# Proposal\n目标：自定义阶段\n' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(withProposal: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-ledger-bundle-policy-'))
  roots.push(root)
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
  if (withProposal) {
    await mkdir(dirname(join(root, PROPOSAL.path)), { recursive: true })
    await writeFile(join(root, PROPOSAL.path), PROPOSAL.content, 'utf8')
  }
  await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
    version: 1,
    contract: 'openspec-v1',
    createdAt: '2026-09-15T00:00:00Z',
    records: withProposal
      ? [{
          kind: PROPOSAL.kind,
          path: PROPOSAL.path,
          sha256: createHash('sha256').update(PROPOSAL.content, 'utf8').digest('hex'),
          producer: 'openspec-propose',
          recordedAt: '2026-09-15T00:00:00Z',
          reads: [],
        }]
      : [],
  }, null, 2)}\n`, 'utf8')
  return root
}

const compact = documentGovernancePolicy('compact', {
  openspec: true,
  documentContract: {
    version: 'v1',
    slots: [{ kind: 'proposal', ownerStep: 'shape', producers: ['openspec-propose'] }],
    reads: [{ step: 'implement', kinds: ['proposal'] }],
  },
  steps: [{ id: 'shape' }, { id: 'implement' }, { id: 'verify' }],
})

describe('Context Bundle follows the change document policy', () => {
  test('自定义契约的非 canonical step 作为 target：按该 step 的 reads 取文档', async () => {
    if (compact === undefined) throw new Error('expected document-v1 policy')
    const root = await fixture(true)
    const result = await compileLedgerContextBundle({ root, change: 'demo', from: 'shape', target: 'implement', policy: compact })
    expect(result.preview.inputs.map((input) => input.kind)).toEqual(['proposal'])
    const empty = await compileLedgerContextBundle({ root, change: 'demo', from: 'shape', target: 'verify', policy: compact })
    expect(empty.preview.documentCount).toBe(0)
  })

  test('target 不是 policy step → CONTEXT_BUNDLE_INVALID_REQUEST（E19）', async () => {
    if (compact === undefined) throw new Error('expected document-v1 policy')
    const root = await fixture(false)
    const error = await compileLedgerContextBundle({ root, change: 'demo', from: 'shape', target: 'explore', policy: compact })
      .then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(LedgerContextBundleError)
    expect((error as LedgerContextBundleError).code).toBe('CONTEXT_BUNDLE_INVALID_REQUEST')
    expect((error as LedgerContextBundleError).message).toBe('Context Bundle target 必须是 workflow step: explore')
  })
})
