import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DocumentKind } from '@tenon/kernel'
import { cmdHandoff } from './commands/handoff.js'
import { freshHarness, realDeps, rm, type Harness } from './integration-harness.js'

interface Doc {
  kind: DocumentKind
  path: string
  content: string
}

let h: Harness

beforeEach(async () => {
  h = await freshHarness()
  expect(await h.run(['init', 'bundle-demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

async function writeBundleFixture(): Promise<Doc[]> {
  const change = 'openspec/changes/bundle-demo'
  const plan = 'docs/superpowers/plans/bundle-plan.md'
  const docs: Doc[] = [
    { kind: 'proposal', path: `${change}/proposal.md`, content: '# Proposal\nGoal: deterministic bundle\n' },
    { kind: 'openspec-design', path: `${change}/design.md`, content: '# Design\nDecision: ledger is authoritative\n' },
    { kind: 'tasks', path: `${change}/tasks.md`, content: '# Tasks\n- [ ] compile the bundle\n' },
    { kind: 'superpower-design', path: 'docs/superpowers/specs/bundle-design.md', content: '# Deep Design\nConstraint: fail closed\n' },
    { kind: 'adr', path: 'docs/adr/bundle.md', content: '# ADR\nDecision: one compiler\n' },
    { kind: 'delta-spec', path: `${change}/specs/a/spec.md`, content: '# A\nRequirement: A\n' },
    { kind: 'delta-spec', path: `${change}/specs/b/spec.md`, content: '# B\nRequirement: B\n' },
    { kind: 'superpower-plan', path: plan, content: '# Plan\n- [ ] implement\n' },
    { kind: 'plan', path: plan, content: '# Plan\n- [ ] implement\n' },
  ]
  for (const doc of docs) {
    const abs = join(h.cwd, doc.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, doc.content, 'utf8')
  }
  const records = docs.map((doc) => ({
    kind: doc.kind,
    path: doc.path,
    sha256: createHash('sha256').update(doc.content, 'utf8').digest('hex'),
    producer: 'test-fixture',
    recordedAt: '2026-07-26T00:00:00Z',
    reads: [],
  }))
  await writeFile(
    join(h.cwd, change, '.pipeline-documents.json'),
    `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: '2026-07-26T00:00:00Z',
      records,
    }, null, 2)}\n`,
    'utf8',
  )
  return docs
}

async function bundle(opts: { budgetBytes?: number } = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const code = await cmdHandoff(realDeps(h.cwd, out, err), 'bundle-demo', {
    bundle: true,
    target: 'build',
    budgetBytes: opts.budgetBytes,
    json: true,
  })
  return { code, out, err }
}

describe('handoff Context Bundle v1', () => {
  test('按 document policy 顺序生成 ledger-bound deterministic bundle', async () => {
    await writeBundleFixture()
    const one = await bundle()
    const two = await bundle()
    expect(one.code).toBe(0)
    expect(two.out).toEqual(one.out)
    const payload = JSON.parse(one.out.join('\n')) as {
      schemaVersion: string
      from: string
      to: string
      inputs: Array<{ kind: string; path: string; digest: string; reason: string; mode: string; content?: string }>
      budget: { maxBytes: number; usedBytes: number }
      aggregateDigest: string
    }
    expect(payload.schemaVersion).toBe('context-bundle/v1')
    expect(payload.from).toBe('open')
    expect(payload.to).toBe('build')
    expect(payload.inputs.map((item) => item.kind)).toEqual([
      'proposal',
      'openspec-design',
      'tasks',
      'superpower-design',
      'adr',
      'delta-spec',
      'delta-spec',
      'superpower-plan',
      'plan',
    ])
    expect(payload.inputs.every((item) => item.reason.length > 0)).toBe(true)
    expect(payload.inputs.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.digest))).toBe(true)
    expect(payload.inputs.at(-1)?.mode).toBe('reference')
    expect(payload.inputs.at(-1)?.content).toBeUndefined()
    expect(payload.budget.usedBytes).toBeGreaterThan(0)
    expect(payload.aggregateDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('源文件漂移后 fail closed 并指出 re-record/read', async () => {
    const docs = await writeBundleFixture()
    const design = docs.find((doc) => doc.kind === 'openspec-design')!
    await writeFile(join(h.cwd, design.path), `${design.content}changed\n`, 'utf8')
    const result = await bundle()
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('stale')
    expect(result.err.join('\n')).toContain(design.path)
    expect(result.err.join('\n')).toContain('document record')
  })

  test('mandatory content 超预算时不输出有效 bundle', async () => {
    await writeBundleFixture()
    const result = await bundle({ budgetBytes: 4 })
    expect(result.code).toBe(1)
    expect(result.out).toEqual([])
    expect(result.err.join('\n')).toMatch(/required=.*available=4/)
  })
})
