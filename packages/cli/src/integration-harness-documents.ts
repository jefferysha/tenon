/**
 * 受治理文档取证夹具（从 integration-harness.ts 拆出，保持单文件在 500 行以内）。
 * 真 ledger API、真摘要、真 producer 历史校验与真读取回执；只在结束时还原临时 Skill 历史行。
 */
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  compileEffectiveWorkflowPlan,
  createStateStore,
  ensureDocumentLedger,
  recordDocument,
  recordDocumentReads,
  recordedDeltaSpecPaths,
  sha256Hex,
  SPEC_APPLY_RECEIPT_FILE,
} from '@tenon/kernel'
import {
  recordCanonicalDocumentSkillInvocation,
  recordNativeDocumentSkillConfirmation,
} from './test-support.js'

export const FIXED_CLOCK = '2026-07-07T00:00:00Z'

const GOVERNED_DESIGN = `# governed design

\`\`\`coverage
touches:
L1_api: filled
L2_data: filled
L3_rules: filled
L4_state: filled
L5_errors: filled
L6_security: filled
L7_perf: filled
L8_deps: filled
L10_terms: filled
\`\`\`
`

/**
 * Test fixture for transition/HTTP behavior that is intentionally orthogonal to document authoring.
 * It uses the real ledger API, real digests, real producer-history validation, and real read receipts;
 * only the temporary Skill history lines are restored afterwards so history-focused assertions keep
 * their original, narrow fixture contract.
 */
export async function seedGovernedDocumentEvidence(
  root: string,
  changeDir: string,
  name: string,
  overrides: {
    readonly design?: string
    readonly tasks?: string
    readonly autoSkills?: boolean
  } = {},
): Promise<void> {
  const docs = {
    proposal: `openspec/changes/${name}/proposal.md`,
    design: `openspec/changes/${name}/design.md`,
    tasks: `openspec/changes/${name}/tasks.md`,
    superpowerDesign: `docs/superpowers/specs/${name}-design.md`,
    adr: `docs/adr/${name}.md`,
    delta: `openspec/changes/${name}/specs/capability/spec.md`,
    plan: `docs/superpowers/plans/${name}.md`,
    report: `docs/superpowers/reports/${name}.md`,
    applied: 'openspec/specs/capability/spec.md',
  }
  const contents: Readonly<Record<keyof typeof docs, string>> = {
    proposal: '# proposal\n',
    design: overrides.design ?? GOVERNED_DESIGN,
    tasks: overrides.tasks ?? '- [x] scope\n- [x] implementation\n- [x] verification\n',
    superpowerDesign: '# Superpower design\n',
    adr: '# ADR\n',
    delta: '# Delta spec\n',
    plan: '# Superpower plan\n',
    report: '# Verification report\n',
    applied: '# Applied spec\n',
  }
  for (const key of Object.keys(docs) as Array<keyof typeof docs>) {
    const target = join(root, docs[key])
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents[key], 'utf8')
  }

  const historyPath = join(changeDir, '.pipeline-history.jsonl')
  let originalHistory: string | undefined
  try {
    originalHistory = await readFile(historyPath, 'utf8')
  } catch {
    // A newly initialized change normally has no history file yet.
  }
  const skillLines = [
    'openspec-propose', 'brainstorming', 'writing-plans', 'verification-before-completion', 'tenon',
  ].map((skill) => JSON.stringify({ kind: 'tool', raw: `Skill: ${skill}` })).join('\n')
  await writeFile(historyPath, `${originalHistory ?? ''}${skillLines}\n`, 'utf8')

  const store = createStateStore()
  const originalPhase = String((await store.read(changeDir)).fields.phase)
  let receiptSequence = 0
  const record = async (
    phase: string,
    kind: Parameters<typeof recordDocument>[0]['kind'],
    path: string,
    producer: string,
  ): Promise<void> => {
    await store.set(changeDir, 'phase', phase)
    receiptSequence += 1
    await appendFile(historyPath, `${JSON.stringify({
      ts: FIXED_CLOCK, kind: 'init', raw: `fixture visit ${phase}`,
    })}\n${JSON.stringify({
      ts: FIXED_CLOCK, kind: 'tool', raw: `Skill: ${producer}`,
    })}\n`, 'utf8')
    const confirmed = await recordNativeDocumentSkillConfirmation(changeDir, producer, phase, {
      sessionId: `integration-harness-${name}`,
      toolUseId: `document-${receiptSequence}`,
      observedAt: FIXED_CLOCK,
    })
    if (!confirmed) throw new Error(`fixture native confirmation rejected for ${producer}`)
    const ledger = await recordDocument({
      repoRoot: root, changeDir, phase, policy: defaultDocumentPolicy(), kind, path, producer, recordedAt: FIXED_CLOCK,
    })
    const canonicalRecord = [...ledger.records].reverse().find((candidate) =>
      candidate.kind === kind && candidate.path === path && candidate.recordedAt === FIXED_CLOCK)
    if (canonicalRecord === undefined) throw new Error(`fixture canonical record missing for ${path}`)
    const invocation = await recordCanonicalDocumentSkillInvocation(
      changeDir, kind, FIXED_CLOCK, { record: canonicalRecord },
    )
    if (invocation === undefined) throw new Error(`fixture canonical invocation missing for ${path}`)
  }

  try {
    const recordedAt = FIXED_CLOCK
    // CLI init currently creates this sidecar, but keep the harness fixture valid for callers
    // that initialize through the StateStore seam rather than the CLI command.
    await ensureDocumentLedger(changeDir, recordedAt)
    await record('open', 'proposal', docs.proposal, 'openspec-propose')
    await record('open', 'openspec-design', docs.design, 'openspec-propose')
    await record('open', 'tasks', docs.tasks, 'openspec-propose')
    await record('explore', 'superpower-design', docs.superpowerDesign, 'brainstorming')
    await record('explore', 'adr', docs.adr, 'brainstorming')
    await record('spec', 'delta-spec', docs.delta, 'openspec-propose')
    await record('spec', 'superpower-plan', docs.plan, 'writing-plans')
    await record('spec', 'plan', docs.plan, 'writing-plans')
    await record('verify', 'verification-report', docs.report, 'verification-before-completion')
    await record('ship', 'applied-spec', docs.applied, 'tenon')
    await store.set(changeDir, 'phase', originalPhase)
    await readGovernedDocumentsForCurrentVisit(root, changeDir, recordedAt)
  } finally {
    if (originalHistory === undefined) {
      await rm(historyPath, { force: true })
    } else {
      await writeFile(historyPath, originalHistory, 'utf8')
    }
  }
}

/** Fixtures record the built-in default document table (identical in every default branch). */
function defaultDocumentPolicy() { const policy = compileEffectiveWorkflowPlan('default').documentPolicy; if (!policy) throw new Error('default must be document-governed'); return policy }

export async function readGovernedDocumentsForCurrentVisit(
  root: string,
  changeDir: string,
  readAt = FIXED_CLOCK,
): Promise<void> {
  const state = await createStateStore().read(changeDir)
  await recordDocumentReads({
    repoRoot: root,
    changeDir,
    phase: String(state.fields.phase),
    policy: defaultDocumentPolicy(),
    kind: 'all',
    readAt,
  })
}

/**
 * Ship-phase fixture for tests whose subject is transition orchestration rather than spec
 * application. It leaves behind exactly what a real `tenon spec apply <change>` leaves behind: the
 * main spec on disk plus a `mode: "apply"` receipt whose delta and target digests are taken from
 * the bytes actually present. It deliberately does not fabricate `mode`, does not touch the main
 * spec's bytes (the ledger's `applied-spec` digest is bound to them), and does nothing when the
 * change has no recorded delta spec — a test that wants the unapplied state simply does not call it.
 */
export async function seedAppliedSpec(root: string, changeDir: string, change: string): Promise<void> {
  const deltas = await recordedDeltaSpecPaths(changeDir)
  if (deltas.length === 0) return
  const prefix = `openspec/changes/${change}/specs/`
  const targets: { path: string; before_sha256: string | null; after_sha256: string; change: string }[] = []
  const deltaRefs: { path: string; sha256: string }[] = []
  for (const delta of deltas) {
    if (!delta.startsWith(prefix)) throw new Error(`fixture seedAppliedSpec: 非预期的 delta 路径 ${delta}`)
    deltaRefs.push({ path: delta, sha256: sha256Hex(await readFile(join(root, delta), 'utf8')) })
    const mainPath = `openspec/specs/${delta.slice(prefix.length)}`
    const target = join(root, mainPath)
    await mkdir(dirname(target), { recursive: true })
    let body: string
    try {
      body = await readFile(target, 'utf8')
    } catch {
      body = '# applied\n'
      await writeFile(target, body, 'utf8')
    }
    targets.push({
      path: mainPath, before_sha256: null, after_sha256: sha256Hex(body), change: 'created',
    })
  }
  await writeFile(join(changeDir, SPEC_APPLY_RECEIPT_FILE), `${JSON.stringify({
    schema: 'tenon-spec-apply-v1',
    change,
    mode: 'apply',
    result: 'pass',
    openspec_version: 'integration-harness',
    deltas: deltaRefs,
    targets,
    at: FIXED_CLOCK,
  }, null, 2)}\n`, 'utf8')
}
