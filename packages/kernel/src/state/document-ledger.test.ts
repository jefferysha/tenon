import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DocumentLedgerError,
  ensureDocumentLedger,
  MAX_DOCUMENT_LEDGER_BYTES,
  MAX_DOCUMENT_LEDGER_RECORDS,
  migrateLegacyDeltaDocument,
  parseDocumentLedger,
  readDocumentLedger,
  recordDocumentReads as recordDocumentReadsWithPolicy,
} from './document-ledger.js'
import { recordDocument as recordDocumentState } from '../documents/document-recording.js'
import { evaluateDocumentEvidence as evaluateDocumentEvidenceWithPolicy } from './document-evidence.js'
import {
  MAX_DOCUMENT_SOURCE_BYTES,
  readBoundedFileHandle,
  resolveDocument,
} from './document-path.js'
import { emptyFields } from './parse.js'
import type { DocumentGovernancePolicy } from '../workflow/document-contract.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from '../workflow/migrations/openspec-v1-document-policy.js'
import {
  publishInitialRunRevision,
  publishRunRevision,
  readCurrentRunRevision,
} from './run-revision-store.js'
import { createTransitionRecordStore } from './transition-record-store.js'
import type { TransitionRecord } from '../workflow/run-types.js'
import { recordNativeDocumentSkillConfirmation } from '../skill-invocation/document-confirmation.js'
import { recordCanonicalDocumentSkillInvocation } from '../skill-invocation/document-producer.js'
import { artifactSubjectId, type ArtifactSubjectRef } from '../artifacts/subject.js'

const NOW = '2026-07-23T00:00:00Z'
const dirs: string[] = []
let nativeReceiptSequence = 0
const declaredSkills = new Map<string, Set<string>>()

type WithDefaultPolicy<T> = Omit<T, 'policy'> & { readonly policy?: DocumentGovernancePolicy }

/** Fixtures default to the openspec-v1 table that default declares in YAML. */
const recordDocumentReads = (input: WithDefaultPolicy<Parameters<typeof recordDocumentReadsWithPolicy>[0]>) =>
  recordDocumentReadsWithPolicy({ ...input, policy: input.policy ?? LEGACY_DOCUMENT_GOVERNANCE_POLICY })

const evaluateDocumentEvidence = (
  repoRoot: string,
  changeDir: string,
  phase: string,
  scope: Parameters<typeof evaluateDocumentEvidenceWithPolicy>[3] = {},
  policy: DocumentGovernancePolicy = LEGACY_DOCUMENT_GOVERNANCE_POLICY,
) => evaluateDocumentEvidenceWithPolicy(repoRoot, changeDir, phase, scope, policy)

const recordDocument = async (input: WithDefaultPolicy<Parameters<typeof recordDocumentState>[0]>) => {
  if (input.allowBackfill !== true && declaredSkills.get(input.changeDir)?.has(input.producer)) {
    await confirmFixtureSkill(input.changeDir, input.phase, input.producer)
  }
  const ledger = await recordDocumentState({ ...input, policy: input.policy ?? LEGACY_DOCUMENT_GOVERNANCE_POLICY })
  if (input.allowBackfill !== true) {
    const canonicalRecord = [...ledger.records].reverse().find((record) =>
      record.kind === input.kind
      && record.producer === input.producer
      && record.recordedAt === input.recordedAt)
    if (canonicalRecord === undefined) throw new Error('fixture canonical document record missing')
    const invocation = await recordCanonicalDocumentSkillInvocation(
      input.changeDir, input.kind, input.recordedAt, { record: canonicalRecord },
    )
    if (invocation === undefined) throw new Error('fixture canonical document invocation missing')
  }
  return ledger
}

async function fixture(): Promise<{ root: string; changeDir: string; name: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pl-document-ledger-'))
  dirs.push(root)
  const name = 'governed-change'
  const changeDir = join(root, 'openspec', 'changes', name)
  await mkdir(changeDir, { recursive: true })
  const fields = emptyFields()
  fields.phase = 'open'
  fields.workflow = 'default'
  await publishInitialRunRevision(changeDir, {
    fields,
    runMetadata: {
      runId: 'run-governed-change',
      transitionSequence: 0,
      transitionHead: undefined,
    },
    opaqueTail: '',
  }, NOW)
  await ensureDocumentLedger(changeDir, NOW)
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
    ts: NOW, kind: 'init', raw: 'init',
  })}\n`, 'utf8')
  return { root, changeDir, name }
}

async function writeDoc(root: string, relativePath: string, content = '# evidence\n'): Promise<void> {
  const target = join(root, relativePath)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

test('document ledger 在解析和磁盘读取前执行条目/字节硬上限', async () => {
  const { changeDir } = await fixture()
  const records = Array.from({ length: MAX_DOCUMENT_LEDGER_RECORDS + 1 }, (_, index) => ({
    kind: 'proposal',
    path: `docs/${index}.md`,
    sha256: 'a'.repeat(64),
    producer: 'tenon-spec',
    recordedAt: NOW,
    reads: [],
  }))
  expect(() => parseDocumentLedger(JSON.stringify({
    version: 1,
    contract: 'openspec-v1',
    createdAt: NOW,
    records,
  }))).toThrow(/records 超过/)
  await writeFile(
    join(changeDir, '.pipeline-documents.json'),
    Buffer.alloc(MAX_DOCUMENT_LEDGER_BYTES + 1, 0x20),
  )
  await expect(readDocumentLedger(changeDir)).rejects.toThrow(/bytes 上限/)
})

test('document record 在 digest 前拒绝超过单文档硬上限的来源', async () => {
  const { root, changeDir } = await fixture()
  const relativePath = 'docs/oversized.md'
  await writeDoc(root, relativePath, 'x'.repeat(MAX_DOCUMENT_SOURCE_BYTES + 1))
  await expect(recordDocumentState({ policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
    repoRoot: root,
    changeDir,
    phase: 'open',
    kind: 'proposal',
    path: relativePath,
    producer: 'tenon-spec',
    recordedAt: NOW,
  })).rejects.toThrow(/document 超过/)
})

test('document ledger 在 fstat 后增长时仍由 max + 1 fd 读取拒绝', async () => {
  const { changeDir } = await fixture()
  const target = join(changeDir, '.pipeline-documents.json')
  await expect(readDocumentLedger(changeDir, async (handle, maxBytes) => {
    await appendFile(target, Buffer.alloc(maxBytes + 1, 0x20))
    return readBoundedFileHandle(handle, maxBytes)
  })).rejects.toThrow(/bytes 上限|读取期间变化/)
})

test('document source 在 fstat 后增长时仍由 max + 1 fd 读取拒绝', async () => {
  const { root } = await fixture()
  const relativePath = 'docs/growing.md'
  const target = join(root, relativePath)
  await writeDoc(root, relativePath)
  await expect(resolveDocument(root, relativePath, async (handle, maxBytes) => {
    await appendFile(target, Buffer.alloc(maxBytes + 1, 0x78))
    return readBoundedFileHandle(handle, maxBytes)
  })).rejects.toThrow(/bytes 上限|读取期间变化/)
})

test('normal document record rejects bare current-visit Skill history when confirmation bridge is missing', async () => {
  const { root, changeDir, name } = await fixture()
  const proposal = `openspec/changes/${name}/proposal.md`
  await writeDoc(root, proposal)
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
    ts: NOW, kind: 'tool', raw: 'Skill: openspec-propose',
  })}\n`)
  await expect(recordDocumentState({ policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
    repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: proposal,
    producer: 'openspec-propose', recordedAt: NOW,
  })).rejects.toThrow(/exact host confirmation/u)
})

async function appendSkillHistory(changeDir: string, ...skills: string[]): Promise<void> {
  const declared = declaredSkills.get(changeDir) ?? new Set<string>()
  skills.forEach((skill) => declared.add(skill))
  declaredSkills.set(changeDir, declared)
  const jsonl = skills.map((skill) => JSON.stringify({ ts: NOW, kind: 'tool', raw: `Skill: ${skill}` })).join('\n')
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${jsonl}\n`, 'utf8')
}

async function confirmFixtureSkill(changeDir: string, phase: string, skill: string): Promise<void> {
  let current = await readCurrentRunRevision(changeDir)
  if (!current?.state.runMetadata) throw new Error('fixture canonical run identity missing')
  if (current.state.fields.phase !== phase) {
    await publishRunRevision(changeDir, current, {
      ...current.state,
      fields: { ...current.state.fields, phase },
      runMetadata: {
        ...current.state.runMetadata,
        transitionSequence: 0,
        transitionHead: undefined,
      },
    }, { kind: 'set', observedAt: NOW })
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: NOW, kind: 'init', raw: `fixture visit ${phase}`,
    })}\n`, 'utf8')
    current = await readCurrentRunRevision(changeDir)
  }
  nativeReceiptSequence += 1
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
    ts: NOW, kind: 'tool', raw: `Skill: ${skill}`,
  })}\n`, 'utf8')
  const confirmed = await recordNativeDocumentSkillConfirmation(changeDir, skill, phase, {
    sessionId: `document-ledger-session-${nativeReceiptSequence}`,
    toolUseId: `document-ledger-tool-${nativeReceiptSequence}`,
    observedAt: NOW,
  })
  if (!confirmed) throw new Error(`fixture native confirmation rejected for ${skill}`)
}

async function enterVisit(changeDir: string, phase: string, transitionSequence: number): Promise<void> {
  const current = await readCurrentRunRevision(changeDir)
  if (!current?.state.runMetadata) throw new Error('fixture canonical run identity missing')
  await publishRunRevision(changeDir, current, {
    ...current.state,
    fields: { ...current.state.fields, phase },
    runMetadata: { ...current.state.runMetadata, transitionSequence },
  }, {
    kind: 'set',
    observedAt: NOW,
  })
}

async function commitCanonicalTransition(
  changeDir: string,
  from: string,
  to: string,
  event: string,
): Promise<void> {
  let current = await readCurrentRunRevision(changeDir)
  if (!current?.state.runMetadata) throw new Error('fixture canonical run identity missing')
  if (current.state.fields.phase !== from) {
    await enterVisit(changeDir, from, current.state.runMetadata.transitionSequence)
    current = await readCurrentRunRevision(changeDir)
  }
  if (!current?.state.runMetadata) throw new Error('fixture canonical run identity missing')
  const metadata = current.state.runMetadata
  const sequence = metadata.transitionSequence + 1
  const id = `${event}-${sequence}`
  const record = {
    schemaVersion: 1,
    id,
    runId: metadata.runId,
    sequence,
    previousRecordId: metadata.transitionHead,
    workflowId: current.state.fields.workflow || 'default',
    event,
    from,
    to,
    effects: [{ kind: 'state-field-change', field: 'phase', from, to }],
    observedAt: NOW,
  } satisfies TransitionRecord
  await createTransitionRecordStore().write(changeDir, record)
  await publishRunRevision(changeDir, current, {
    ...current.state,
    fields: { ...current.state.fields, phase: to },
    runMetadata: {
      ...metadata,
      transitionSequence: sequence,
      transitionHead: id,
    },
  }, {
    kind: 'transition',
    transitionRecordId: id,
    observedAt: NOW,
  })
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
    ts: NOW,
    kind: 'transition',
    from,
    to,
    event,
    transitionRecordId: id,
  })}\n`, 'utf8')
}

afterEach(async () => {
  declaredSkills.clear()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('OpenSpec document ledger', () => {
  test('read receipt 只满足当前 step visit；verify→build→verify 时旧 digest 回执不可重放', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    await writeDoc(root, proposal, '# stable proposal\n')
    await appendSkillHistory(changeDir, 'openspec-propose')
    await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'open',
      kind: 'proposal',
      path: proposal,
      producer: 'openspec-propose',
      recordedAt: NOW,
    })

    await commitCanonicalTransition(changeDir, 'open', 'verify', 'enter-verify')
    await recordDocumentReads({
      repoRoot: root,
      changeDir,
      phase: 'verify',
      kind: 'proposal',
      readAt: NOW,
    })
    expect(await evaluateDocumentEvidence(root, changeDir, 'verify', {
      recordKinds: [],
      readKinds: ['proposal'],
    })).toMatchObject({ pass: true, blockers: [] })

    await commitCanonicalTransition(changeDir, 'verify', 'build', 'verify-fail')
    await commitCanonicalTransition(changeDir, 'build', 'verify', 'build-complete')
    const replayed = await evaluateDocumentEvidence(root, changeDir, 'verify', {
      recordKinds: [],
      readKinds: ['proposal'],
    })
    expect(replayed.pass).toBe(false)
    expect(replayed.items).toContainEqual(expect.objectContaining({
      kind: 'proposal',
      status: 'unread',
    }))

    await recordDocumentReads({
      repoRoot: root,
      changeDir,
      phase: 'verify',
      kind: 'proposal',
      readAt: '2026-07-23T00:03:00Z',
    })
    expect(await evaluateDocumentEvidence(root, changeDir, 'verify', {
      recordKinds: [],
      readKinds: ['proposal'],
    })).toMatchObject({ pass: true, blockers: [] })
  })

  test('旧 ledger 中没有 visit identity 的 read receipt 可审计读取但必须 fail-closed', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    await writeDoc(root, proposal, '# legacy receipt\n')
    await appendSkillHistory(changeDir, 'openspec-propose')
    const recorded = await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'open',
      kind: 'proposal',
      path: proposal,
      producer: 'openspec-propose',
      recordedAt: NOW,
    })
    const proposalRecord = recorded.records.find((record) => record.kind === 'proposal')
    if (!proposalRecord) throw new Error('fixture proposal record missing')
    await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
      ...recorded,
      records: [{
        ...proposalRecord,
        reads: [{ phase: 'verify', sha256: proposalRecord.sha256, readAt: NOW }],
      }],
    }, null, 2)}\n`, 'utf8')
    await commitCanonicalTransition(changeDir, 'open', 'verify', 'enter-verify')

    const legacy = await evaluateDocumentEvidence(root, changeDir, 'verify', {
      recordKinds: [],
      readKinds: ['proposal'],
    })
    expect(legacy).toMatchObject({
      pass: false,
      items: [expect.objectContaining({ kind: 'proposal', status: 'unread' })],
    })

    await recordDocumentReads({
      repoRoot: root,
      changeDir,
      phase: 'verify',
      kind: 'proposal',
      readAt: '2026-07-23T00:01:00Z',
    })
    expect(await evaluateDocumentEvidence(root, changeDir, 'verify', {
      recordKinds: [],
      readKinds: ['proposal'],
    })).toMatchObject({ pass: true, blockers: [] })
  })

  test('真实 producer history + hash-bound read receipt 使 explore 通过；文件变更立即变 stale', async () => {
    const { root, changeDir, name } = await fixture()
    const paths = {
      proposal: `openspec/changes/${name}/proposal.md`,
      design: `openspec/changes/${name}/design.md`,
      tasks: `openspec/changes/${name}/tasks.md`,
      superpowerDesign: `docs/superpowers/specs/${name}-design.md`,
      adr: `docs/adr/${name}.md`,
    }
    await Promise.all(Object.values(paths).map((path) => writeDoc(root, path)))
    await appendSkillHistory(changeDir, 'openspec-propose', 'brainstorming')

    await recordDocument({ repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: paths.proposal, producer: 'openspec-propose', recordedAt: NOW })
    await recordDocument({ repoRoot: root, changeDir, phase: 'open', kind: 'openspec-design', path: paths.design, producer: 'openspec-propose', recordedAt: NOW })
    await recordDocument({ repoRoot: root, changeDir, phase: 'open', kind: 'tasks', path: paths.tasks, producer: 'openspec-propose', recordedAt: NOW })
    await recordDocument({ repoRoot: root, changeDir, phase: 'explore', kind: 'superpower-design', path: paths.superpowerDesign, producer: 'brainstorming', recordedAt: NOW })
    await recordDocument({ repoRoot: root, changeDir, phase: 'explore', kind: 'adr', path: paths.adr, producer: 'brainstorming', recordedAt: NOW })

    await recordDocumentReads({ repoRoot: root, changeDir, phase: 'explore', kind: 'all', readAt: NOW })
    expect(await evaluateDocumentEvidence(root, changeDir, 'explore')).toMatchObject({ pass: true, blockers: [] })

    await writeDoc(root, paths.proposal, '# changed after read\n')
    const stale = await evaluateDocumentEvidence(root, changeDir, 'explore')
    expect(stale.pass).toBe(false)
    expect(stale.items.find((item) => item.kind === 'proposal')?.status).toBe('stale')
    expect(stale.blockers.join('\n')).toContain("document 'proposal' 已缺失或内容变化")
  })

  test('verify-fail 可只校验新鲜 verification report，旧文档 stale 不会锁死回炉路径', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    const report = `docs/superpowers/reports/${name}-verify.md`
    await Promise.all([writeDoc(root, proposal), writeDoc(root, report, '# failed verification\n')])
    await appendSkillHistory(changeDir, 'openspec-propose')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await writeFile(
      join(changeDir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ kind: 'transition', from: 'build', to: 'verify' })}\n`,
      'utf8',
    )
    await appendSkillHistory(changeDir, 'verification-before-completion')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'verify', kind: 'verification-report', path: report,
      producer: 'verification-before-completion', recordedAt: NOW,
    })
    await writeDoc(root, proposal, '# stale after failed verification\n')

    expect(await evaluateDocumentEvidence(root, changeDir, 'verify')).toMatchObject({ pass: false })
    expect(await evaluateDocumentEvidence(root, changeDir, 'verify', {
      recordKinds: ['verification-report'],
      readKinds: [],
    })).toMatchObject({
      pass: true,
      blockers: [],
      items: [expect.objectContaining({ kind: 'verification-report', status: 'recorded' })],
    })
  })

  test('不允许凭空声明 producer 或将项目外文件登记为 OpenSpec 文档', async () => {
    const { root, changeDir } = await fixture()
    const proposal = 'openspec/changes/governed-change/proposal.md'
    await writeDoc(root, proposal)
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/缺少 Skill 调用证据/)

    await appendSkillHistory(changeDir, 'openspec-propose')
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: '../outside.md',
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toBeInstanceOf(DocumentLedgerError)
  })

  test('同一种 document 移动后重新登记会替换旧路径，不留下永久 stale 记录', async () => {
    const { root, changeDir, name } = await fixture()
    const first = `openspec/changes/${name}/proposal.md`
    const moved = `openspec/changes/${name}/proposal-v2.md`
    await Promise.all([writeDoc(root, first), writeDoc(root, moved, '# moved\n')])
    await appendSkillHistory(changeDir, 'openspec-propose')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: first,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    const ledger = await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: moved,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    expect(ledger.records.filter((record) => record.kind === 'proposal')).toEqual([
      expect.objectContaining({ path: moved }),
    ])
  })

  test('delta-spec 按 capability 保留多个槽，重写一个 capability 不会删除另一个', async () => {
    const { root, changeDir, name } = await fixture()
    const alpha = `openspec/changes/${name}/specs/alpha/spec.md`
    const beta = `openspec/changes/${name}/specs/beta/spec.md`
    await Promise.all([writeDoc(root, alpha, '# alpha v1\n'), writeDoc(root, beta, '# beta\n')])
    await appendSkillHistory(changeDir, 'openspec-propose')

    await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: alpha,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: beta,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    const read = await recordDocumentReads({
      repoRoot: root, changeDir, phase: 'build', kind: 'delta-spec', readAt: NOW,
    })
    const before = read.records.filter((record) => record.kind === 'delta-spec')
    expect(before.map((record) => record.path).sort()).toEqual([alpha, beta])
    expect(before.every((record) => record.reads.some((receipt) => receipt.phase === 'build'))).toBe(true)
    const betaDigest = before.find((record) => record.path === beta)?.sha256

    await writeDoc(root, alpha, '# alpha v2\n')
    const rewritten = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: alpha,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    const after = rewritten.records.filter((record) => record.kind === 'delta-spec')
    expect(after.map((record) => record.path).sort()).toEqual([alpha, beta])
    expect(after.find((record) => record.path === alpha)?.reads).toEqual([])
    expect(after.find((record) => record.path === beta)).toMatchObject({
      sha256: betaDigest,
      reads: [expect.objectContaining({ phase: 'build' })],
    })
  })

  test('delta-spec 拒绝非 canonical 路径，并允许后续 phase backfill 缺失 capability 槽', async () => {
    const { root, changeDir, name } = await fixture()
    const alpha = `openspec/changes/${name}/specs/alpha/spec.md`
    const beta = `openspec/changes/${name}/specs/beta/spec.md`
    const invalid = `docs/specs/${name}-gamma.md`
    await Promise.all([writeDoc(root, alpha), writeDoc(root, beta), writeDoc(root, invalid)])
    await appendSkillHistory(changeDir, 'openspec-propose')

    await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: alpha,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await expect(recordDocumentState({ policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: invalid,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/canonical capability 路径/)

    const backfilled = await recordDocument({
      repoRoot: root, changeDir, phase: 'ship', kind: 'delta-spec', path: beta,
      producer: 'openspec-propose', recordedAt: NOW, allowBackfill: true,
    })
    expect(backfilled.records.filter((record) => record.kind === 'delta-spec').map(
      (record) => record.path,
    ).sort()).toEqual([alpha, beta])
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'ship', kind: 'delta-spec', path: alpha,
      producer: 'openspec-propose', recordedAt: NOW, allowBackfill: true,
    })).rejects.toThrow(/delta-spec:alpha.*已有 record/)
  })

  test('delta-spec 拒绝通过父目录 symlink 将同一物理文件伪装成另一个 capability', async () => {
    const { root, changeDir, name } = await fixture()
    const alpha = `openspec/changes/${name}/specs/alpha/spec.md`
    const beta = `openspec/changes/${name}/specs/beta/spec.md`
    await writeDoc(root, alpha)
    await symlink('alpha', join(root, 'openspec', 'changes', name, 'specs', 'beta'), 'dir')
    await appendSkillHistory(changeDir, 'openspec-propose')

    await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: alpha,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: beta,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/symlink 或路径别名/)
  })

  test('普通登记保留非 canonical 旧 delta，读取和 evidence evaluation 要求显式迁移', async () => {
    const { root, changeDir, name } = await fixture()
    const legacy = `docs/${name}-legacy-delta.md`
    const alpha = `openspec/changes/${name}/specs/alpha/spec.md`
    const legacyContent = '# legacy delta\n'
    await Promise.all([writeDoc(root, legacy, legacyContent), writeDoc(root, alpha, legacyContent)])
    await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: NOW,
      records: [{
        kind: 'delta-spec',
        path: legacy,
        sha256: createHash('sha256').update(legacyContent).digest('hex'),
        producer: 'openspec-propose',
        recordedAt: NOW,
        reads: [],
      }],
    }, null, 2)}\n`, 'utf8')
    await appendSkillHistory(changeDir, 'openspec-propose')

    const recorded = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path: alpha,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    expect(recorded.records.filter((record) => record.kind === 'delta-spec').map(
      (record) => record.path,
    ).sort()).toEqual([alpha, legacy].sort())
    await expect(recordDocumentReads({
      repoRoot: root, changeDir, phase: 'build', kind: 'delta-spec', readAt: NOW,
    })).rejects.toThrow(/旧 delta-spec.*显式迁移/)
    const report = await evaluateDocumentEvidence(root, changeDir, 'build', {
      recordKinds: [],
      readKinds: ['delta-spec'],
    })
    expect(report.pass).toBe(false)
    expect(report.blockers.join('\n')).toMatch(/旧 delta-spec.*显式迁移/)

    const mismatched = `openspec/changes/${name}/specs/mismatched/spec.md`
    await writeDoc(root, mismatched, '# different delta\n')
    const beforeMismatch = await readFile(join(changeDir, '.pipeline-documents.json'), 'utf8')
    await expect(migrateLegacyDeltaDocument({
      repoRoot: root,
      changeDir,
      legacyPath: legacy,
      canonicalPath: mismatched,
    })).rejects.toThrow(/digest 不一致/)
    expect(await readFile(join(changeDir, '.pipeline-documents.json'), 'utf8')).toBe(beforeMismatch)

    const migrated = await migrateLegacyDeltaDocument({
      repoRoot: root,
      changeDir,
      legacyPath: legacy,
      canonicalPath: alpha,
    })
    expect(migrated.records.filter((record) => record.kind === 'delta-spec')).toEqual([
      expect.objectContaining({ path: alpha }),
    ])
    await expect(recordDocumentReads({
      repoRoot: root, changeDir, phase: 'build', kind: 'delta-spec', readAt: NOW,
    })).resolves.toMatchObject({
      records: [expect.objectContaining({
        kind: 'delta-spec',
        path: alpha,
        reads: [expect.objectContaining({ phase: 'build' })],
      })],
    })
  })

  test('旧 delta 与已存在 canonical 槽的 provenance 或同 phase receipt 冲突时拒绝迁移', async () => {
    const { root, changeDir, name } = await fixture()
    const legacy = `docs/${name}-legacy-delta.md`
    const canonical = `openspec/changes/${name}/specs/alpha/spec.md`
    const content = '# same delta\n'
    const digest = createHash('sha256').update(content).digest('hex')
    await Promise.all([writeDoc(root, legacy, content), writeDoc(root, canonical, content)])
    const ledgerPath = join(changeDir, '.pipeline-documents.json')
    const writeConflictLedger = async (
      sourceProducer: string,
      sourceRecordedAt: string,
      sourceReadAt: string,
      targetReadAt: string,
    ): Promise<void> => {
      await writeFile(ledgerPath, `${JSON.stringify({
        version: 1,
        contract: 'openspec-v1',
        createdAt: NOW,
        records: [
          {
            kind: 'delta-spec', path: legacy, sha256: digest, producer: sourceProducer,
            recordedAt: sourceRecordedAt, reads: [{ phase: 'build', sha256: digest, readAt: sourceReadAt }],
          },
          {
            kind: 'delta-spec', path: canonical, sha256: digest, producer: 'openspec-propose',
            recordedAt: NOW, reads: [{ phase: 'build', sha256: digest, readAt: targetReadAt }],
          },
        ],
      }, null, 2)}\n`, 'utf8')
    }

    await writeConflictLedger('opsx:propose', '2026-07-22T00:00:00Z', NOW, NOW)
    const provenanceBytes = await readFile(ledgerPath, 'utf8')
    await expect(migrateLegacyDeltaDocument({
      repoRoot: root, changeDir, legacyPath: legacy, canonicalPath: canonical,
    })).rejects.toThrow(/provenance 冲突/)
    expect(await readFile(ledgerPath, 'utf8')).toBe(provenanceBytes)

    await writeConflictLedger('openspec-propose', NOW, '2026-07-23T01:00:00Z', '2026-07-23T02:00:00Z')
    const receiptBytes = await readFile(ledgerPath, 'utf8')
    await expect(migrateLegacyDeltaDocument({
      repoRoot: root, changeDir, legacyPath: legacy, canonicalPath: canonical,
    })).rejects.toThrow(/read receipt 冲突/)
    expect(await readFile(ledgerPath, 'utf8')).toBe(receiptBytes)

    await writeFile(ledgerPath, `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: NOW,
      records: [
        {
          kind: 'delta-spec', path: legacy, sha256: digest, producer: 'openspec-propose',
          recordedAt: NOW, reads: [{ phase: 'build', sha256: digest, readAt: NOW }],
        },
        {
          kind: 'delta-spec', path: canonical, sha256: digest, producer: 'openspec-propose',
          recordedAt: NOW, reads: [{ phase: 'verify', sha256: digest, readAt: NOW }],
        },
      ],
    }, null, 2)}\n`, 'utf8')
    const merged = await migrateLegacyDeltaDocument({
      repoRoot: root, changeDir, legacyPath: legacy, canonicalPath: canonical,
    })
    expect(merged.records.filter((record) => record.kind === 'delta-spec')).toEqual([
      expect.objectContaining({
        path: canonical,
        producer: 'openspec-propose',
        recordedAt: NOW,
        reads: [
          expect.objectContaining({ phase: 'verify' }),
          expect.objectContaining({ phase: 'build' }),
        ],
      }),
    ])
    const mergedBytes = await readFile(ledgerPath, 'utf8')
    await migrateLegacyDeltaDocument({
      repoRoot: root, changeDir, legacyPath: legacy, canonicalPath: canonical,
    })
    expect(await readFile(ledgerPath, 'utf8')).toBe(mergedBytes)
  })

  test('裸 CodexSkillRead 没有 v2 confirmation 时不能作为 producer 证据', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    await writeDoc(root, proposal)
    await writeFile(
      join(changeDir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ kind: 'tool', raw: 'CodexSkillRead: openspec-propose' })}\n`,
      'utf8',
    )

    await expect(recordDocumentState({ policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/exact host confirmation/u)
  })

  test('旧 Change 可显式 backfill 已存在的前序文档，但不能补登记未来 phase', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    const report = `docs/superpowers/reports/${name}.md`
    await writeDoc(root, proposal)
    await writeDoc(root, report)
    await appendSkillHistory(changeDir, 'openspec-propose', 'verification-before-completion')

    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/当前 spec 允许/)

    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW, allowBackfill: true,
    })).resolves.toMatchObject({ records: [expect.objectContaining({ kind: 'proposal', path: proposal })] })

    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'verification-report', path: report,
      producer: 'verification-before-completion', recordedAt: NOW, allowBackfill: true,
    })).rejects.toThrow(/未来 phase 'verify'/)
  })

  test('活文档只能由当前 phase 的实际 skill 重新登记，backfill 不能覆盖旧证据', async () => {
    const { root, changeDir, name } = await fixture()
    const tasks = `openspec/changes/${name}/tasks.md`
    const design = `docs/superpowers/specs/${name}-design.md`
    await writeDoc(root, tasks, '# open tasks\n')
    await writeDoc(root, design, '# explore design\n')
    await appendSkillHistory(changeDir, 'openspec-propose', 'brainstorming')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'tasks', path: tasks,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'superpower-design', path: design,
      producer: 'brainstorming', recordedAt: NOW,
    })

    await writeDoc(root, tasks, '# spec tasks\n')
    await writeDoc(root, design, '# spec design with coverage\n')
    await expect(recordDocumentState({ policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      repoRoot: root, changeDir, phase: 'spec', kind: 'tasks', path: tasks,
      producer: 'openspec-propose', recordedAt: NOW, allowBackfill: true,
    })).rejects.toThrow(/--backfill 只能首次登记历史 document/)
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'tasks', path: tasks,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/当前 spec 允许: tenon-spec/)

    await appendSkillHistory(changeDir, 'tenon-spec')
    const afterTasks = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'tasks', path: tasks,
      producer: 'tenon-spec', recordedAt: NOW,
    })
    const afterDesign = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'superpower-design', path: design,
      producer: 'tenon-spec', recordedAt: NOW,
    })
    expect(afterTasks.records.find((record) => record.kind === 'tasks')?.producer).toBe('tenon-spec')
    expect(afterDesign.records.find((record) => record.kind === 'superpower-design')?.producer).toBe('tenon-spec')
  })

  test('Explore 回填 OpenSpec proposal/design 时必须由 tenon-explore 重登记并重新读取', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    const design = `openspec/changes/${name}/design.md`
    const tasks = `openspec/changes/${name}/tasks.md`
    await Promise.all([
      writeDoc(root, proposal, '# open proposal\n'),
      writeDoc(root, design, '# open design\n'),
      writeDoc(root, tasks, '# open tasks\n'),
    ])
    await appendSkillHistory(changeDir, 'openspec-propose')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'openspec-design', path: design,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'tasks', path: tasks,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await writeFile(
      join(changeDir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ kind: 'transition', from: 'open', to: 'explore' })}\n`,
      'utf8',
    )
    await appendSkillHistory(changeDir, 'tenon-explore')

    await writeDoc(root, proposal, '# explored proposal\n')
    await writeDoc(root, design, '# explored design\n')
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })).rejects.toThrow(/当前 explore 允许: tenon-explore/)

    const afterProposal = await recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'proposal', path: proposal,
      producer: 'tenon-explore', recordedAt: NOW,
    })
    expect(afterProposal.records.find((record) => record.kind === 'proposal')).toMatchObject({
      producer: 'tenon-explore', reads: [],
    })
    const updated = await recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'openspec-design', path: design,
      producer: 'tenon-explore', recordedAt: NOW,
    })
    expect(updated.records.find((record) => record.kind === 'openspec-design')?.producer).toBe('tenon-explore')

    await recordDocumentReads({ repoRoot: root, changeDir, phase: 'explore', kind: 'all', readAt: NOW })
    const afterRead = await evaluateDocumentEvidence(root, changeDir, 'explore')
    expect(afterRead.pass).toBe(false)
    expect(afterRead.items.find((item) => item.kind === 'proposal')?.status).toBe('recorded')
    expect(afterRead.items.find((item) => item.kind === 'openspec-design')?.status).toBe('recorded')
    expect(afterRead.items.find((item) => item.kind === 'proposal')?.timeline).toEqual([
      { producer: 'tenon-explore', recordedAt: NOW, readAt: NOW },
    ])
    expect(afterRead.blockers).not.toContain("document 'proposal' 的 producer 不符合当前 document contract")
    expect(afterRead.blockers).not.toContain("document 'openspec-design' 的 producer 不符合当前 document contract")
  })

  test('normal re-record evidence must come after the latest entry into the phase', async () => {
    const { root, changeDir, name } = await fixture()
    const tasks = `openspec/changes/${name}/tasks.md`
    await writeDoc(root, tasks, '# changed in current spec visit\n')
    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeFile(
      join(changeDir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ kind: 'transition', from: 'explore', to: 'spec' })}\n`,
      'utf8',
    )
    await expect(recordDocumentState({ policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      repoRoot: root, changeDir, phase: 'spec', kind: 'tasks', path: tasks,
      producer: 'tenon-spec', recordedAt: NOW,
    })).rejects.toThrow(/缺少 Skill 调用证据（当前 phase）/)

    await appendSkillHistory(changeDir, 'tenon-spec')
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'tasks', path: tasks,
      producer: 'tenon-spec', recordedAt: NOW,
    })).resolves.toMatchObject({ records: [expect.objectContaining({ kind: 'tasks', producer: 'tenon-spec' })] })
  })

  test('七阶段 Todo 是活文档：每个 phase 只能用自己的 phase skill 重新登记 tasks', async () => {
    const { root, changeDir, name } = await fixture()
    const tasks = `openspec/changes/${name}/tasks.md`
    await writeDoc(root, tasks, '# Tasks\n\n## Open\n- [x] open\n')
    await appendSkillHistory(changeDir, 'openspec-propose')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'tasks', path: tasks,
      producer: 'openspec-propose', recordedAt: NOW,
    })

    for (const phase of ['explore', 'spec', 'build', 'verify', 'ship', 'archive'] as const) {
      const producer = `tenon-${phase}`
      await appendFile(
        join(changeDir, '.pipeline-history.jsonl'),
        `${JSON.stringify({ kind: 'transition', from: 'previous', to: phase })}\n`,
        'utf8',
      )
      await appendSkillHistory(changeDir, producer)
      await writeDoc(root, tasks, `# Tasks\n\n## ${phase}\n- [x] ${phase}\n`)
      const ledger = await recordDocument({
        repoRoot: root, changeDir, phase, kind: 'tasks', path: tasks,
        producer, recordedAt: NOW,
      })
      expect(ledger.records.find((record) => record.kind === 'tasks')?.producer).toBe(producer)
    }
  })

  test('requirements-changed 回到 spec 后，tenon-spec 可诚实重登记修订后的 proposal/design', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    const design = `openspec/changes/${name}/design.md`
    await writeDoc(root, proposal, '# original proposal\n')
    await writeDoc(root, design, '# original design\n')
    await appendSkillHistory(changeDir, 'openspec-propose')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'proposal', path: proposal,
      producer: 'openspec-propose', recordedAt: NOW,
    })
    await recordDocument({
      repoRoot: root, changeDir, phase: 'open', kind: 'openspec-design', path: design,
      producer: 'openspec-propose', recordedAt: NOW,
    })

    await commitCanonicalTransition(changeDir, 'build', 'spec', 'requirements-changed')
    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeDoc(root, proposal, '# revised proposal\n')
    await writeDoc(root, design, '# revised design\n')

    const proposalLedger = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'proposal', path: proposal,
      producer: 'tenon-spec', recordedAt: NOW,
    })
    expect(proposalLedger.records.find((record) => record.kind === 'proposal')).toMatchObject({
      producer: 'tenon-spec',
    })
    const designLedger = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'openspec-design', path: design,
      producer: 'tenon-spec', recordedAt: NOW,
    })
    expect(designLedger.records.find((record) => record.kind === 'openspec-design')).toMatchObject({
      producer: 'tenon-spec',
    })
  })

  test('requirements-changed 回到 spec 后，只有当前 tenon-spec 可重登记 ADR 新摘要', async () => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    const frozenPolicy = {
      ...LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      mutableByStep: {
        ...LEGACY_DOCUMENT_GOVERNANCE_POLICY.mutableByStep,
        spec: LEGACY_DOCUMENT_GOVERNANCE_POLICY.mutableByStep.spec
          .filter((requirement) => requirement.kind !== 'adr'),
      },
    }
    await writeDoc(root, adr, '# original decision\n')
    await appendSkillHistory(changeDir, 'brainstorming')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'adr', path: adr,
      producer: 'brainstorming', recordedAt: NOW, policy: frozenPolicy,
    })
    await recordDocumentReads({
      repoRoot: root, changeDir, phase: 'build', kind: 'adr', readAt: NOW,
    })

    await commitCanonicalTransition(changeDir, 'build', 'spec', 'requirements-changed')
    await enterVisit(changeDir, 'spec', 1)
    await writeDoc(root, adr, '# revised transaction decision\n')

    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'adr', path: adr,
      producer: 'tenon-spec', recordedAt: NOW, policy: frozenPolicy,
    })).rejects.toThrow(/缺少 Skill 调用证据（当前 phase）/)

    await appendSkillHistory(changeDir, 'brainstorming', 'tenon-spec')
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'adr', path: adr,
      producer: 'brainstorming', recordedAt: NOW, policy: frozenPolicy,
    })).rejects.toThrow(/当前 spec 允许: tenon-spec/)
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'adr', path: adr,
      producer: 'tenon-spec', recordedAt: NOW, allowBackfill: true, policy: frozenPolicy,
    })).rejects.toThrow(/--backfill 只能首次登记历史 document/)

    const revised = await recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'adr', path: adr,
      producer: 'tenon-spec', recordedAt: NOW, policy: frozenPolicy,
    })
    expect(revised.records.find((record) => record.kind === 'adr')).toMatchObject({
      producer: 'tenon-spec',
      reads: [],
    })
  })

  test('document-v1 自定义 workflow 允许 owner=spec 的 ADR 在首次 Spec visit 登记', async () => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    const policy = {
      id: 'document-v1' as const,
      steps: ['open', 'spec'],
      outputsByStep: {
        open: [],
        spec: [{ kind: 'adr' as const, producerCandidates: ['custom-spec-author'] }],
      },
      mutableByStep: { open: [], spec: [] },
      readsByStep: { open: [], spec: [] },
    }
    await enterVisit(changeDir, 'spec', 0)
    await writeDoc(root, adr, '# initial custom spec decision\n')
    await appendSkillHistory(changeDir, 'custom-spec-author')

    const ledger = await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'spec',
      kind: 'adr',
      path: adr,
      producer: 'custom-spec-author',
      recordedAt: NOW,
      policy,
    })

    expect(ledger.records.find((record) => record.kind === 'adr')).toMatchObject({
      producer: 'custom-spec-author',
    })
  })

  test('后续 set revision 不得让被篡改的 head TransitionRecord 伪造 requirements-changed 授权', async () => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    await writeDoc(root, adr, '# original decision\n')
    await appendSkillHistory(changeDir, 'brainstorming')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'adr', path: adr,
      producer: 'brainstorming', recordedAt: NOW,
    })
    await commitCanonicalTransition(changeDir, 'explore', 'spec', 'explore-complete')
    await enterVisit(changeDir, 'spec', 1)

    const transitionPath = join(
      changeDir,
      '.pipeline-transitions',
      '000001-explore-complete-1.json',
    )
    const record = JSON.parse(await readFile(transitionPath, 'utf8')) as Record<string, unknown>
    Object.assign(record, {
      event: 'requirements-changed',
      from: 'build',
      to: 'spec',
    })
    await writeFile(transitionPath, JSON.stringify(record), 'utf8')
    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeDoc(root, adr, '# forged transition rewrite\n')

    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'adr', path: adr,
      producer: 'tenon-spec', recordedAt: NOW,
    })).rejects.toThrow(/TransitionRecord digest|审计绑定/)
  })

  test('set revision 不得把 canonical head 回滚到更早的真实 requirements-changed', async () => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    await writeDoc(root, adr, '# original decision\n')
    await appendSkillHistory(changeDir, 'brainstorming')
    await recordDocument({
      repoRoot: root, changeDir, phase: 'explore', kind: 'adr', path: adr,
      producer: 'brainstorming', recordedAt: NOW,
    })
    await commitCanonicalTransition(changeDir, 'build', 'spec', 'requirements-changed')
    await commitCanonicalTransition(changeDir, 'spec', 'build', 'spec-complete')
    await commitCanonicalTransition(changeDir, 'build', 'spec', 'normal-spec-visit')
    await enterVisit(changeDir, 'spec', 3)

    const currentPath = join(changeDir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const state = current.state as { runMetadata: Record<string, unknown> }
    Object.assign(state.runMetadata, {
      transitionSequence: 1,
      transitionHead: 'requirements-changed-1',
    })
    const { stateDigest: _oldDigest, ...body } = current
    current.stateDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const raw = JSON.stringify(current)
    await writeFile(currentPath, raw, 'utf8')
    await writeFile(join(
      changeDir,
      '.pipeline-run',
      'revisions',
      `${String(current.revision).padStart(6, '0')}-${String(current.revisionId)}.json`,
    ), raw, 'utf8')
    const companionPath = join(
      changeDir,
      '.pipeline-run',
      'pre-verify-review',
      `${String(current.revision).padStart(6, '0')}-${String(current.revisionId)}.json`,
    )
    const companion = JSON.parse(await readFile(companionPath, 'utf8')) as Record<string, unknown>
    companion.stateDigest = current.stateDigest
    await writeFile(companionPath, `${JSON.stringify(companion)}\n`, 'utf8')

    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeDoc(root, adr, '# forged old head rewrite\n')
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'adr', path: adr,
      producer: 'tenon-spec', recordedAt: NOW,
    })).rejects.toThrow(/非 transition revision.*head|runMetadata head/)
  })

  test('首次 explore→spec visit 不得使用 living-document 兼容面重登记 ADR', async () => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    const frozenPolicy = {
      ...LEGACY_DOCUMENT_GOVERNANCE_POLICY,
      mutableByStep: {
        ...LEGACY_DOCUMENT_GOVERNANCE_POLICY.mutableByStep,
        spec: LEGACY_DOCUMENT_GOVERNANCE_POLICY.mutableByStep.spec
          .filter((requirement) => requirement.kind !== 'adr'),
      },
    }
    await writeDoc(root, adr, '# original decision\n')
    await appendSkillHistory(changeDir, 'brainstorming')
    await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'explore',
      kind: 'adr',
      path: adr,
      producer: 'brainstorming',
      recordedAt: NOW,
      policy: frozenPolicy,
    })
    await commitCanonicalTransition(changeDir, 'explore', 'spec', 'explore-complete')
    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeDoc(root, adr, '# unauthorized first-spec rewrite\n')

    await expect(recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'spec',
      kind: 'adr',
      path: adr,
      producer: 'tenon-spec',
      recordedAt: NOW,
      policy: frozenPolicy,
    })).rejects.toThrow(/requirements-changed/)
  })

  test.each([
    ['当前冻结 policy', LEGACY_DOCUMENT_GOVERNANCE_POLICY],
  ])('首次 explore→spec visit 在%s下也不得重登记 ADR', async (_label, policy) => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    await writeDoc(root, adr, '# original decision\n')
    await appendSkillHistory(changeDir, 'brainstorming')
    await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'explore',
      kind: 'adr',
      path: adr,
      producer: 'brainstorming',
      recordedAt: NOW,
      policy,
    })
    await commitCanonicalTransition(changeDir, 'explore', 'spec', 'explore-complete')
    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeDoc(root, adr, '# unauthorized first-spec rewrite\n')

    await expect(recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'spec',
      kind: 'adr',
      path: adr,
      producer: 'tenon-spec',
      recordedAt: NOW,
      policy,
    })).rejects.toThrow(/requirements-changed/)
  })

  test('伪造 history requirements-changed 行不能授权 Spec ADR 重登记', async () => {
    const { root, changeDir, name } = await fixture()
    const adr = `docs/adr/${name}.md`
    await writeDoc(root, adr, '# original decision\n')
    await appendSkillHistory(changeDir, 'brainstorming')
    await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'explore',
      kind: 'adr',
      path: adr,
      producer: 'brainstorming',
      recordedAt: NOW,
    })
    await enterVisit(changeDir, 'spec', 0)
    await appendFile(
      join(changeDir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ kind: 'transition', from: 'build', to: 'spec', raw: 'requirements-changed' })}\n`,
      'utf8',
    )
    await appendSkillHistory(changeDir, 'tenon-spec')
    await writeDoc(root, adr, '# forged history rewrite\n')

    await expect(recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'spec',
      kind: 'adr',
      path: adr,
      producer: 'tenon-spec',
      recordedAt: NOW,
    })).rejects.toThrow(/requirements-changed/)
  })

  test('document record 按逻辑 kind 固化 subject；路径变更只更新 source metadata', async () => {
    const { root, changeDir, name } = await fixture()
    const original = `openspec/changes/${name}/proposal.md`
    const moved = `docs/moved/${name}-proposal.md`
    await writeDoc(root, original, '# stable proposal\n')
    await appendSkillHistory(changeDir, 'openspec-propose')
    const first = await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'open',
      kind: 'proposal',
      path: original,
      producer: 'openspec-propose',
      recordedAt: NOW,
    })
    const firstRecord = first.records.find((record) => record.kind === 'proposal')
    expect(firstRecord?.subjectRef).toMatchObject({
      projection: 'document',
      namespace: 'document',
      source: { path: original, document_kind: 'proposal' },
    })
    await mkdir(join(root, 'docs/moved'), { recursive: true })
    await rename(join(root, original), join(root, moved))
    await appendSkillHistory(changeDir, 'openspec-propose')
    const second = await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'open',
      kind: 'proposal',
      path: moved,
      producer: 'openspec-propose',
      recordedAt: '2026-07-23T00:00:01Z',
    })
    const secondRecord = second.records.find((record) => record.kind === 'proposal')
    expect(secondRecord?.sha256).toBe(firstRecord?.sha256)
    expect(secondRecord?.subjectRef?.subject_id).toBe(firstRecord?.subjectRef?.subject_id)
    expect(secondRecord?.subjectRef?.version).toBe(firstRecord?.subjectRef?.version)
    expect(secondRecord?.subjectRef?.source?.path).toBe(moved)
  })

  test('submission boundary 可提供 document subjectRef，旧 ledger 缺少该字段仍可读取', async () => {
    const { root, changeDir, name } = await fixture()
    const proposal = `openspec/changes/${name}/proposal.md`
    const content = '# explicit subject\n'
    await writeDoc(root, proposal, content)
    const digest = createHash('sha256').update(content).digest('hex')
    const subjectRef: ArtifactSubjectRef = {
      subject_id: artifactSubjectId('document', 'contract:proposal'),
      namespace: 'document',
      version: `sha256:${digest}`,
      projection: 'document',
      content_digest: `sha256:${digest}`,
      source: { document_kind: 'proposal' },
    }
    await appendSkillHistory(changeDir, 'openspec-propose')
    const ledger = await recordDocument({
      repoRoot: root,
      changeDir,
      phase: 'open',
      kind: 'proposal',
      path: proposal,
      producer: 'openspec-propose',
      recordedAt: NOW,
      subjectRef,
    })
    const record = ledger.records.find((item) => item.kind === 'proposal')
    expect(record?.subjectRef?.subject_id).toBe(subjectRef.subject_id)
    expect(record?.subjectRef?.source?.path).toBe(proposal)

    await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
      ...ledger,
      records: ledger.records.map(({ subjectRef: _subjectRef, ...legacy }) => legacy),
    }, null, 2)}\n`, 'utf8')
    const legacy = await readDocumentLedger(changeDir)
    expect(legacy?.records[0]?.subjectRef).toBeUndefined()
  })
})
