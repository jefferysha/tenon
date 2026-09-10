import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureDocumentLedger, recordDocumentLedger } from '../state/document-ledger.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from '../workflow/document-contract.js'
import { autoRegisterDocuments } from './auto-register.js'
import { canonicalDocumentPaths, documentPathTemplates } from './document-paths.js'

async function project(): Promise<{ root: string; changeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'auto-register-'))
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
  return { root, changeDir }
}

describe('canonicalDocumentPaths', () => {
  it('按模板替换 {change}，只返回存在的文件；{capability} 展开成每个 capability 目录', async () => {
    const { root, changeDir } = await project()
    expect(documentPathTemplates('proposal')).toEqual(['openspec/changes/{change}/proposal.md'])
    expect(await canonicalDocumentPaths(root, 'demo', 'proposal')).toEqual([])
    await writeFile(join(changeDir, 'proposal.md'), '# p\n', 'utf8')
    expect(await canonicalDocumentPaths(root, 'demo', 'proposal')).toEqual(['openspec/changes/demo/proposal.md'])
    await mkdir(join(changeDir, 'specs', 'auth'), { recursive: true })
    await mkdir(join(changeDir, 'specs', 'billing'), { recursive: true })
    await writeFile(join(changeDir, 'specs', 'auth', 'spec.md'), '# a\n', 'utf8')
    await writeFile(join(changeDir, 'specs', 'billing', 'spec.md'), '# b\n', 'utf8')
    expect(await canonicalDocumentPaths(root, 'demo', 'delta-spec')).toEqual([
      'openspec/changes/demo/specs/auth/spec.md',
      'openspec/changes/demo/specs/billing/spec.md',
    ])
    expect(await canonicalDocumentPaths(root, 'demo', 'verification-report')).toEqual([])
  })
})

describe('autoRegisterDocuments', () => {
  it('只登记当前阶段归该技能产出、存在且未登记的规范文件；非候选技能不登记', async () => {
    const { root, changeDir } = await project()
    await ensureDocumentLedger(changeDir, '2026-09-10T00:00:00Z')
    await writeFile(join(changeDir, 'proposal.md'), '# p\n', 'utf8')
    await writeFile(join(changeDir, 'tasks.md'), '# t\n', 'utf8')
    const record = vi.fn(async () => ({ version: 1 as const, contract: 'openspec-v1' as const, createdAt: '', records: [] }))
    const outcome = await autoRegisterDocuments({
      repoRoot: root, changeDir, changeName: 'demo', phase: 'open', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, producer: 'openspec-propose', recordedAt: '2026-09-10T00:01:00Z',
    }, { record })
    expect(outcome.recorded).toEqual([
      { kind: 'proposal', path: 'openspec/changes/demo/proposal.md' },
      { kind: 'tasks', path: 'openspec/changes/demo/tasks.md' },
    ])
    expect(record).toHaveBeenCalledTimes(2)
    expect(record.mock.calls[0]?.[0]).toMatchObject({ kind: 'proposal', producer: 'openspec-propose', phase: 'open' })
    const none = await autoRegisterDocuments({
      repoRoot: root, changeDir, changeName: 'demo', phase: 'open', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, producer: 'brainstorming', recordedAt: 'x',
    }, { record })
    expect(none.recorded).toEqual([])
    expect(record).toHaveBeenCalledTimes(2)
  })

  it('已登记且内容未变 → skip(up-to-date)；内容变了 → 重新登记；别名产出者也算候选', async () => {
    const { root, changeDir } = await project()
    await ensureDocumentLedger(changeDir, '2026-09-10T00:00:00Z')
    await writeFile(join(changeDir, 'proposal.md'), '# p\n', 'utf8')
    await recordDocumentLedger({
      repoRoot: root, changeDir, phase: 'open', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, kind: 'proposal', path: 'openspec/changes/demo/proposal.md', producer: 'openspec-propose', recordedAt: '2026-09-10T00:00:30Z',
    })
    const record = vi.fn(async () => ({ version: 1 as const, contract: 'openspec-v1' as const, createdAt: '', records: [] }))
    const same = await autoRegisterDocuments({
      repoRoot: root, changeDir, changeName: 'demo', phase: 'open', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, producer: 'opsx:propose', recordedAt: 'x',
    }, { record })
    expect(same.recorded).toEqual([])
    expect(same.skipped).toEqual([{ kind: 'proposal', path: 'openspec/changes/demo/proposal.md', reason: 'up-to-date' }])
    await writeFile(join(changeDir, 'proposal.md'), '# p v2\n', 'utf8')
    const changed = await autoRegisterDocuments({
      repoRoot: root, changeDir, changeName: 'demo', phase: 'open', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, producer: 'openspec-propose', recordedAt: 'y',
    }, { record })
    expect(changed.recorded).toEqual([{ kind: 'proposal', path: 'openspec/changes/demo/proposal.md' }])
  })

  it('登记失败只进 skipped，不抛', async () => {
    const { root, changeDir } = await project()
    await ensureDocumentLedger(changeDir, '2026-09-10T00:00:00Z')
    await writeFile(join(changeDir, 'proposal.md'), '# p\n', 'utf8')
    const record = vi.fn(async () => { throw new Error('缺少 Skill 调用证据') })
    const outcome = await autoRegisterDocuments({
      repoRoot: root, changeDir, changeName: 'demo', phase: 'open', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, producer: 'openspec-propose', recordedAt: 'x',
    }, { record })
    expect(outcome.recorded).toEqual([])
    expect(outcome.skipped[0]).toMatchObject({ kind: 'proposal', reason: '缺少 Skill 调用证据' })
  })

  it('活文档：explore 阶段 tenon-explore 可重登 open 产出的 proposal（mutableByStep）', async () => {
    const { root, changeDir } = await project()
    await ensureDocumentLedger(changeDir, '2026-09-10T00:00:00Z')
    await writeFile(join(changeDir, 'proposal.md'), '# p\n', 'utf8')
    const record = vi.fn(async () => ({ version: 1 as const, contract: 'openspec-v1' as const, createdAt: '', records: [] }))
    const outcome = await autoRegisterDocuments({
      repoRoot: root, changeDir, changeName: 'demo', phase: 'explore', policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY, producer: 'tenon-explore', recordedAt: 'x',
    }, { record })
    expect(outcome.recorded.map((entry) => entry.kind)).toEqual(['proposal'])
  })
})
