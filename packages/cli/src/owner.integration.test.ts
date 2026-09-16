import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStateStore, createTransitionRecordStore } from '@tenon/kernel'
import { freshHarness, type Harness } from './integration-harness.js'

const A = { TENON_USER: 'a@x.io', TENON_USER_NAME: 'A' }
const B = { TENON_USER: 'b@x.io', TENON_USER_NAME: 'B' }
const cleanups: string[] = []

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function owned(): Promise<Harness> {
  const h = await freshHarness()
  cleanups.push(h.cwd)
  expect(await h.run(['init', 'x', '--track', 'backend', '--preset', 'full'], { env: A })).toBe(0)
  await h.seedGovernedDocumentEvidence('x')
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
