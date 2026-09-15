import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDocumentLedger, readDocumentLedger } from '../state/document-ledger.js'
import { recordDocument as recordDocumentWithPolicy } from '../documents/document-recording.js'
import { evaluateDocumentEvidence as evaluateDocumentEvidenceWithPolicy } from '../state/document-evidence.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from '../workflow/migrations/openspec-v1-document-policy.js'
import { emptyFields } from '../state/parse.js'
import { publishInitialRunRevision } from '../state/run-revision-store.js'
import { readSkillInvocationEvidence } from './repository.js'
import { recordCanonicalDocumentSkillInvocation } from './document-producer.js'
import { recordNativeDocumentSkillConfirmation } from './document-confirmation.js'
import { readDocumentSkillConfirmations } from './document-confirmation-store.js'

const roots: string[] = []
const producer = 'openspec-propose'

/** Fixtures use the openspec-v1 table that default declares in YAML. */
const recordDocument = (input: Omit<Parameters<typeof recordDocumentWithPolicy>[0], 'policy'>) =>
  recordDocumentWithPolicy({ ...input, policy: LEGACY_DOCUMENT_GOVERNANCE_POLICY })
const evaluateDocumentEvidence = (
  repoRoot: string,
  changeDir: string,
  phase: string,
  scope: Parameters<typeof evaluateDocumentEvidenceWithPolicy>[3],
) => evaluateDocumentEvidenceWithPolicy(repoRoot, changeDir, phase, scope, LEGACY_DOCUMENT_GOVERNANCE_POLICY)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(sequence = 0) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-document-invocation-'))
  roots.push(root)
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
  const fields = emptyFields()
  fields.phase = 'spec'
  fields.workflow = 'default'
  await publishInitialRunRevision(changeDir, {
    fields,
    runMetadata: { runId: 'run-1', transitionSequence: sequence, transitionHead: undefined },
    opaqueTail: '',
  }, '2026-08-04T00:00:00.000Z')
  await ensureDocumentLedger(changeDir, '2026-08-04T00:00:00.000Z')
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
    ts: '2026-08-04T00:00:00.000Z', kind: 'init', to: 'spec',
  })}\n`)
  return { root, changeDir, fields }
}

async function confirm(changeDir: string, recordedAt: string, sequence: number) {
  const receiptDigest = createHash('sha256')
    .update('demo').update('\0').update(producer).update('\0').update(recordedAt)
    .update('\0').update('run-1').update('\0').update(String(sequence)).digest('hex')
  const proofRef = `codex-transcript-${receiptDigest}`
  const invocationId = `invocation-${createHash('sha256')
    .update('codex-document-skill').update('\0').update('run-1').update('\0').update(String(sequence))
    .update('\0').update(producer).update('\0').update(proofRef).digest('hex')}`
  await appendFile(join(changeDir, '.pipeline-skill-confirmations.jsonl'), `${JSON.stringify({
    schema_version: 'document-skill-confirmation/v1',
    invocation_id: invocationId,
    producer, confirmed_at: recordedAt,
    evidence_scope: 'spec', step_visit: { run_id: 'run-1', transition_sequence: sequence },
    adapter: { kind: 'codex', proof_ref: proofRef },
  })}\n`)
  await appendFile(join(changeDir, '.pipeline-history.jsonl'), [
    { ts: recordedAt, kind: 'tool', raw: `CodexSkillRead: ${producer}` },
    { ts: recordedAt, kind: 'tool', raw: `CodexSkillReadBinding: ${producer} run-1 ${sequence}` },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
}

describe('canonical document SkillInvocation producer', () => {
  it('records native PostToolUse proof with the same canonical artifact binding', async () => {
    const { root, changeDir } = await fixture()
    const path = 'openspec/changes/demo/specs/cap-native/spec.md'
    await mkdir(join(root, 'openspec/changes/demo/specs/cap-native'), { recursive: true })
    await writeFile(join(root, path), '# cap-native\n')
    const confirmedAt = '2026-08-04T00:00:59.000Z'
    const recordedAt = '2026-08-04T00:01:00.000Z'
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: confirmedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await expect(recordNativeDocumentSkillConfirmation(
      changeDir, producer, 'spec', {
        sessionId: 'native-session-1', toolUseId: 'native-tool-1', observedAt: confirmedAt,
      },
    )).resolves.toBe(true)
    await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt })

    await expect(evaluateDocumentEvidence(root, changeDir, 'spec', {
      recordKinds: ['delta-spec'], readKinds: [],
    })).resolves.toMatchObject({
      pass: false,
      blockers: [expect.stringMatching(/producer invocation\/artifact 尚未原子完成/u)],
    })

    await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt))
      .resolves.toBeDefined()
    await expect(evaluateDocumentEvidence(root, changeDir, 'spec', {
      recordKinds: ['delta-spec'], readKinds: [],
    })).resolves.toMatchObject({ pass: true, blockers: [] })
    await expect(readSkillInvocationEvidence(changeDir)).resolves.toMatchObject({
      items: [expect.objectContaining({
        skill: { id: producer, version: '1' },
        status: 'completed',
        artifacts: [expect.objectContaining({ ref: path, state: 'bound' })],
      })],
    })
  })

  it('keeps a completed document bound to its exact confirmation across adjacent timestamp collisions', async () => {
    const { root, changeDir } = await fixture()
    const path = 'openspec/changes/demo/specs/cap-timestamp/spec.md'
    await mkdir(join(root, 'openspec/changes/demo/specs/cap-timestamp'), { recursive: true })
    await writeFile(join(root, path), '# cap-timestamp\n')
    const confirmedAt = '2026-08-04T00:00:59.000Z'
    const recordedAt = '2026-08-04T00:01:00.000Z'
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: confirmedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await expect(recordNativeDocumentSkillConfirmation(
      changeDir, producer, 'spec', {
        sessionId: 'native-session-original', toolUseId: 'native-tool-original', observedAt: confirmedAt,
      },
    )).resolves.toBe(true)
    await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt })
    await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt))
      .resolves.toBeDefined()

    // A later invocation by the same producer can legitimately start in the document record's
    // timestamp bucket. It must not replace the exact confirmation that minted the artifact.
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: recordedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await expect(recordNativeDocumentSkillConfirmation(
      changeDir, producer, 'spec', {
        sessionId: 'native-session-adjacent', toolUseId: 'native-tool-adjacent', observedAt: recordedAt,
      },
    )).resolves.toBe(true)

    await expect(evaluateDocumentEvidence(root, changeDir, 'spec', {
      recordKinds: ['delta-spec'], readKinds: [],
    })).resolves.toMatchObject({ pass: true, blockers: [] })
  })

  it('rejects a previous StepVisit invocation when the record anchor names a later visit', async () => {
    const { root, changeDir } = await fixture()
    const path = 'openspec/changes/demo/specs/cap-replay/spec.md'
    await mkdir(join(root, 'openspec/changes/demo/specs/cap-replay'), { recursive: true })
    await writeFile(join(root, path), '# cap-replay\n')
    const recordedAt = '2026-08-04T00:01:00.000Z'
    await confirm(changeDir, recordedAt, 0)
    await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt })
    await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt)).resolves.toBeDefined()

    const replayAt = '2026-08-04T00:02:00.000Z'
    await confirm(changeDir, replayAt, 1)
    const ledger = await readDocumentLedger(changeDir)
    expect(ledger).toBeDefined()
    const confirmation = (await readDocumentSkillConfirmations(changeDir))
      .find((row) => row.step_visit.transition_sequence === 1)
    expect(confirmation).toBeDefined()
    await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
      ...ledger,
      records: ledger?.records.map((record) => ({
        ...record,
        producerInvocation: {
          confirmationInvocationId: confirmation?.invocation_id,
          evidenceScope: 'spec',
          stepVisit: { runId: 'run-1', transitionSequence: 1 },
        },
      })),
    }, null, 2)}\n`)

    await expect(evaluateDocumentEvidence(root, changeDir, 'spec', {
      recordKinds: ['delta-spec'], readKinds: [],
    })).resolves.toMatchObject({
      pass: false,
      blockers: [expect.stringMatching(/producer invocation\/artifact 尚未原子完成/u)],
    })
  })

  it('rejects an old artifact binding after the same path is recorded with a new digest', async () => {
    const { root, changeDir } = await fixture()
    const path = 'openspec/changes/demo/specs/cap-digest/spec.md'
    await mkdir(join(root, 'openspec/changes/demo/specs/cap-digest'), { recursive: true })
    await writeFile(join(root, path), '# digest-v1\n')
    const firstAt = '2026-08-04T00:01:00.000Z'
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: firstAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await recordNativeDocumentSkillConfirmation(changeDir, producer, 'spec', {
      sessionId: 'native-session-digest-1', toolUseId: 'native-tool-digest-1', observedAt: firstAt,
    })
    await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt: firstAt })
    await recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', firstAt)

    const secondAt = '2026-08-04T00:02:00.000Z'
    await writeFile(join(root, path), '# digest-v2\n')
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: secondAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await recordNativeDocumentSkillConfirmation(changeDir, producer, 'spec', {
      sessionId: 'native-session-digest-2', toolUseId: 'native-tool-digest-2', observedAt: secondAt,
    })
    await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt: secondAt })

    await expect(evaluateDocumentEvidence(root, changeDir, 'spec', {
      recordKinds: ['delta-spec'], readKinds: [],
    })).resolves.toMatchObject({
      pass: false,
      blockers: [expect.stringMatching(/producer invocation\/artifact 尚未原子完成/u)],
    })
  })

  it('keeps the gate open when unchanged bytes are recorded again at a later time', async () => {
    const { root, changeDir } = await fixture()
    const path = 'openspec/changes/demo/specs/cap-rerecord/spec.md'
    await mkdir(join(root, 'openspec/changes/demo/specs/cap-rerecord'), { recursive: true })
    await writeFile(join(root, path), '# cap-rerecord\n')
    const confirmedAt = '2026-08-04T00:00:59.000Z'
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: confirmedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await recordNativeDocumentSkillConfirmation(changeDir, producer, 'spec', {
      sessionId: 'native-session-rerecord', toolUseId: 'native-tool-rerecord', observedAt: confirmedAt,
    })

    for (const recordedAt of ['2026-08-04T00:01:00.000Z', '2026-08-04T00:02:00.000Z']) {
      await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt })
      await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt)).resolves.toBeDefined()
      await expect(evaluateDocumentEvidence(root, changeDir, 'spec', {
        recordKinds: ['delta-spec'], readKinds: [],
      })).resolves.toMatchObject({ pass: true, blockers: [] })
    }
  })

  it('binds multiple native documents without reusing one declared output', async () => {
    const { root, changeDir } = await fixture()
    const confirmedAt = '2026-08-04T00:01:00.000Z'
    await appendFile(join(changeDir, '.pipeline-history.jsonl'), `${JSON.stringify({
      ts: confirmedAt, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`)
    await expect(recordNativeDocumentSkillConfirmation(
      changeDir, producer, 'spec', {
        sessionId: 'native-session-multi', toolUseId: 'native-tool-multi', observedAt: confirmedAt,
      },
    )).resolves.toBe(true)

    for (const [capability, recordedAt] of [
      ['cap-native-a', '2026-08-04T00:02:00.000Z'],
      ['cap-native-b', '2026-08-04T00:03:00.000Z'],
    ] as const) {
      const path = `openspec/changes/demo/specs/${capability}/spec.md`
      await mkdir(join(root, `openspec/changes/demo/specs/${capability}`), { recursive: true })
      await writeFile(join(root, path), `# ${capability}\n`)
      await recordDocument({
        repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt,
      })
      const result = await recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt)
      expect(result).toBeDefined()
      await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt))
        .resolves.toEqual(result)
    }

    const evidence = await readSkillInvocationEvidence(changeDir)
    expect(evidence.items).toHaveLength(2)
    expect(evidence.items.every((item) => item.status === 'completed')).toBe(true)
    expect(evidence.items.flatMap((item) => item.artifacts.map((artifact) => artifact.ref)).sort()).toEqual([
      'openspec/changes/demo/specs/cap-native-a/spec.md',
      'openspec/changes/demo/specs/cap-native-b/spec.md',
    ])
  })

  it('rejects a confirmation replayed across a later visit to the same phase', async () => {
    const { root, changeDir } = await fixture(3)
    const path = 'openspec/changes/demo/specs/cap-a/spec.md'
    await mkdir(join(root, 'openspec/changes/demo/specs/cap-a'), { recursive: true })
    await writeFile(join(root, path), '# cap-a\n')
    const recordedAt = '2026-08-04T00:01:00.000Z'
    await confirm(changeDir, recordedAt, 1)
    await expect(recordDocument({
      repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt,
    })).rejects.toThrow(/exact host confirmation/u)
    await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt))
      .resolves.toBeUndefined()
    await expect(readSkillInvocationEvidence(changeDir)).resolves.toMatchObject({ state: 'empty' })
  })

  it('records each canonical delta-spec by its exact record time without kind ambiguity', async () => {
    const { root, changeDir } = await fixture()
    for (const [capability, recordedAt] of [
      ['cap-a', '2026-08-04T00:01:00.000Z'],
      ['cap-b', '2026-08-04T00:02:00.000Z'],
    ] as const) {
      const path = `openspec/changes/demo/specs/${capability}/spec.md`
      await mkdir(join(root, `openspec/changes/demo/specs/${capability}`), { recursive: true })
      await writeFile(join(root, path), `# ${capability}\n`)
      await confirm(changeDir, recordedAt, 0)
      await recordDocument({ repoRoot: root, changeDir, phase: 'spec', kind: 'delta-spec', path, producer, recordedAt })
      await expect(recordCanonicalDocumentSkillInvocation(changeDir, 'delta-spec', recordedAt)).resolves.toBeDefined()
    }
    const evidence = await readSkillInvocationEvidence(changeDir)
    expect(evidence.items).toHaveLength(2)
    expect(evidence.items.map((item) => item.artifacts[0]?.ref).sort()).toEqual([
      'openspec/changes/demo/specs/cap-a/spec.md',
      'openspec/changes/demo/specs/cap-b/spec.md',
    ])
  })
})
