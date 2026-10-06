import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStateStore, createTransitionRecordStore, reviewerRequiredMessage } from '@tenon/kernel'
import { freshHarness, type Harness } from './integration-harness.js'

const A = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const B = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }
const cleanups: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function owned(): Promise<Harness> {
  const h = await freshHarness()
  cleanups.push(h.cwd)
  expect(await h.run(['init', 'x', '--track', 'backend', '--preset', 'full'], { env: A })).toBe(0)
  await h.seedGovernedDocumentEvidence('x')
  return h
}

/** A owns x; it has left Open and A has asked for the Explore review (the first review gate of the default flow). */
async function exploreReviewRequested(): Promise<Harness> {
  // The harness helpers that run a step's tests and agents take no per-call identity: they run as the process user.
  vi.stubEnv('TENON_USER', A.TENON_USER)
  vi.stubEnv('TENON_USER_NAME', A.TENON_USER_NAME)
  const h = await owned()
  expect(await h.run(['transition', 'x', 'open-complete'], { env: A }), h.err.join('\n')).toBe(0)
  await h.seedArtifact('x', 'design_doc', 'openspec/changes/x/design.md')
  await h.satisfyStepTests('x', 'explore')
  await h.satisfyStepAgents('x')
  expect(await h.run(['review', 'request', 'x', '--event', 'explore-complete'], { env: A }), h.err.join('\n')).toBe(0)
  return h
}

function history(h: Harness): Promise<string> {
  return readFile(join(h.cwd, 'openspec', 'changes', 'x', '.pipeline-history.jsonl'), 'utf8').catch(() => '')
}

describe('owner rule across two declared users', () => {
  it('B is refused on A\'s task with the take-over hint and zero writes', async () => {
    const h = await owned()
    expect(await h.read('x')).toMatch(/^assignee: A <a@x\.io>$/m)
    const yaml = await h.read('x')
    const ledgerPath = join(h.cwd, 'openspec', 'changes', 'x', '.pipeline-documents.json')
    const ledger = await readFile(ledgerPath, 'utf8')
    expect(await h.run(['transition', 'x', 'open-complete'], { env: B })).toBe(1)
    expect(h.err.join('\n')).toContain('任务 x 的负责人是 A <a@x.io>；先接手：tenon owner take x')
    expect(await h.run(['review', 'request', 'x', '--event', 'open-complete'], { env: B })).toBe(1)
    expect(h.err.join('\n')).toContain('tenon owner take x')
    expect(await h.run([
      'document', 'record', 'x', 'proposal', 'openspec/changes/x/proposal.md', '--producer', 'openspec-propose',
    ], { env: B })).toBe(1)
    expect(h.err.join('\n')).toContain('tenon owner take x')
    expect(await h.read('x')).toBe(yaml)
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledger)
    // The harness itself appends phase Skill rows before each command; refused commands add no operation rows.
    expect(await history(h)).not.toContain('"kind":"transition"')
    expect(await history(h)).not.toContain('review:request')
  })

  it('after B takes over, B advances with actor B and A is refused', async () => {
    const h = await owned()
    expect(await h.run(['owner', 'take', 'x'], { env: B })).toBe(0)
    expect(h.out).toEqual(['B <b@x.io>'])
    expect(await h.read('x')).toMatch(/^assignee: B <b@x\.io>$/m)
    expect(await h.read('x')).toMatch(/^created_by: A <a@x\.io>$/m)
    const setRow = (await history(h)).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.kind === 'set' && row.field === 'assignee')
    expect(setRow).toMatchObject({ from: 'A <a@x.io>', to: 'B <b@x.io>', actor: { id: 'b@x.io', name: 'B', trust: 'declared' } })

    expect(await h.run(['transition', 'x', 'open-complete'], { env: B })).toBe(0)
    const dir = join(h.cwd, 'openspec', 'changes', 'x')
    const state = await createStateStore().read(dir)
    const meta = state.runMetadata
    if (meta?.transitionHead === undefined) throw new Error('transition head missing')
    const chain = await createTransitionRecordStore().readChain(dir, meta.transitionSequence, meta.transitionHead, meta.runId)
    expect(chain.at(-1)?.actor).toBe('B <b@x.io>')
    expect(await history(h)).toContain('"kind":"transition"')

    expect(await h.run(['transition', 'x', 'explore-complete'], { env: A })).toBe(1)
    expect(h.err.join('\n')).toContain('任务 x 的负责人是 B <b@x.io>')
  })

  it('review acknowledge: only the owner confirms; a non-owner reviewer must say --as reviewer (F16)', async () => {
    const h = await exploreReviewRequested()

    // B is not the owner: refused with the rule and both ways forward, and the receipt stays pending.
    expect(await h.run(['review', 'acknowledge', 'x'], { env: B })).toBe(1)
    const refusal = h.err.join('\n')
    expect(refusal).toContain('任务 x 的负责人是 A <a@x.io>')
    expect(refusal).toContain('--as reviewer')
    expect(refusal).toContain('tenon owner take x')
    expect(await h.read('x')).toMatch(/^review_gate_status: pending$/m)
    expect(await history(h)).not.toContain('review:acknowledge')

    // Only the documented role is accepted, and it never replaces the delegated authority check.
    expect(await h.run(['review', 'acknowledge', 'x', '--as', 'owner'], { env: B })).toBe(1)
    expect(h.err.join('\n')).toContain('--as 只支持 reviewer')

    // Explicit reviewer role: confirmed, and the history row says who confirmed and in which role.
    expect(await h.run(['review', 'acknowledge', 'x', '--as', 'reviewer'], { env: B }), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('评审人 B <b@x.io>')
    expect(await h.read('x')).toMatch(/^review_gate_status: approved$/m)
    const ack = (await history(h)).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => typeof row.raw === 'string' && row.raw.startsWith('review:acknowledge'))
    expect(ack).toMatchObject({ actor: { id: 'b@x.io' } })
    expect(String(ack?.raw)).toContain('as=reviewer')
    expect(String(ack?.raw)).toContain('owner=a@x.io')

    // The owner advances on the confirmation given by the reviewer.
    expect(await h.run(['transition', 'x', 'explore-complete'], { env: A }), h.err.join('\n')).toBe(0)
  })

  it('review acknowledge refusals follow TENON_LANG: en is English, zh stays byte-identical to the kernel text', async () => {
    const h = await exploreReviewRequested()
    const EN = { TENON_LANG: 'en' }

    expect(await h.run(['review', 'acknowledge', 'x'], { env: { ...B, ...EN } })).toBe(1)
    const refusal = h.err.join('\n')
    expect(refusal).toContain('ERROR: task x is owned by A <a@x.io>, and a review confirmation is owner-only by default')
    expect(refusal).toContain('add --as reviewer')
    expect(refusal).toContain('tenon owner take x')
    expect(/[㐀-鿿]/u.test(refusal)).toBe(false)

    expect(await h.run(['review', 'acknowledge', 'x', '--as', 'owner'], { env: { ...B, ...EN } })).toBe(1)
    expect(h.err.join('\n')).toBe("ERROR: --as supports only reviewer (got 'owner')")

    expect(await h.run(['review', 'acknowledge', 'x'], { env: { ...B, TENON_LANG: 'zh' } })).toBe(1)
    expect(h.err.join('\n')).toBe(`ERROR: ${reviewerRequiredMessage('x', { id: 'a@x.io', name: 'A' })}`)
    expect(await h.read('x')).toMatch(/^review_gate_status: pending$/m)
  })

  it('review acknowledge by a reviewer prints who confirmed: zh stays byte-identical, en is English', async () => {
    const line = (h: Harness): string | undefined => h.out.find((entry) => entry.startsWith('[REVIEW] x phase='))
    const zh = await exploreReviewRequested()
    expect(await zh.run(['review', 'acknowledge', 'x', '--as', 'reviewer'], { env: { ...B, TENON_LANG: 'zh' } }), zh.err.join('\n')).toBe(0)
    expect(line(zh)).toBe('[REVIEW] x phase=explore event=explore-complete 已确认（评审人 B <b@x.io>，负责人 A <a@x.io>），可重发 transition')

    const en = await exploreReviewRequested()
    expect(await en.run(['review', 'acknowledge', 'x', '--as', 'reviewer'], { env: { ...B, TENON_LANG: 'en' } }), en.err.join('\n')).toBe(0)
    expect(line(en)).toBe('[REVIEW] x phase=explore event=explore-complete confirmed (reviewer B <b@x.io>, owner A <a@x.io>); you can re-issue the transition')

    const owner = await exploreReviewRequested()
    expect(await owner.run(['review', 'acknowledge', 'x'], { env: { ...A, TENON_LANG: 'en' } }), owner.err.join('\n')).toBe(0)
    expect(line(owner)).toBe('[REVIEW] x phase=explore event=explore-complete confirmed; you can re-issue the transition')
  })

  it('review request and acknowledge flags refused outside their command follow TENON_LANG', async () => {
    const h = await exploreReviewRequested()
    expect(await h.run(['review', 'request', 'x', '--delegated'], { env: { ...A, TENON_LANG: 'zh' } })).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: --delegated 只可用于 review acknowledge；request 仍必须先完成真实 review 证据')
    expect(await h.run(['review', 'request', 'x', '--delegated'], { env: { ...A, TENON_LANG: 'en' } })).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: --delegated applies to review acknowledge only; request still needs the real review evidence first')
    expect(await h.run(['review', 'request', 'x', '--as', 'reviewer'], { env: { ...A, TENON_LANG: 'zh' } })).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: --as 只可用于 review acknowledge；request 只有负责人能发起')
    expect(await h.run(['review', 'request', 'x', '--as', 'reviewer'], { env: { ...A, TENON_LANG: 'en' } })).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: --as applies to review acknowledge only; only the owner can start a request')
    expect(await h.run(['review', 'bogus', 'x'], { env: { ...A, TENON_LANG: 'zh' } })).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: 用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer]')
    expect(await h.run(['review', 'bogus', 'x'], { env: { ...A, TENON_LANG: 'en' } })).toBe(1)
    expect(h.err.join('\n')).toBe('ERROR: usage: tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer]')
  })

  it('review acknowledge by the owner needs no flag and records no role', async () => {
    const h = await exploreReviewRequested()
    expect(await h.run(['review', 'acknowledge', 'x'], { env: A }), h.err.join('\n')).toBe(0)
    expect(await history(h)).not.toContain('as=reviewer')
  })

  it('assignee is not a generic field; hand-over is owner-only; missing identity is refused', async () => {
    const h = await owned()
    expect(await h.run(['set', 'x', 'assignee', 'B <b@x.io>'], { env: A })).toBe(1)
    expect(h.err.join('\n')).toContain("字段 'assignee' 由 tenon owner 管理")
    expect(await h.run(['owner', 'set', 'x', 'c@x.io', '--name', 'C'], { env: B })).toBe(1)
    expect(h.err.join('\n')).toContain('任务 x 的负责人是 A <a@x.io>')
    expect(await h.run(['owner', 'set', 'x', 'c@x.io', '--name', 'C'], { env: A })).toBe(0)
    expect(await h.read('x')).toMatch(/^assignee: C <c@x\.io>$/m)
    expect(await h.run(['owner', 'take', 'x'], { env: { TENON_USER: 'not-an-email' } })).toBe(1)
    expect(h.err.join('\n')).toContain('ERROR: 未设置用户身份')
  })
})
