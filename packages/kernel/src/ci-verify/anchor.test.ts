import { describe, expect, it } from 'vitest'
import type { EvidenceNoteEntry } from '../evidence-export/note.js'
import { fixtureChain, fixtureRecordDraft } from '../test-system/test-support.js'
import { verifyRecordChain, type ChainReport } from '../test-system/record-chain.js'
import { evaluateAnchor } from './anchor.js'
import { ciKeyText } from './text.js'

const COMMIT = 'a'.repeat(40)

function chainOf(count: number): ChainReport {
  const records = fixtureChain(Array.from({ length: count }, () => fixtureRecordDraft()))
  return verifyRecordChain({ records: records.map((record) => ({ file: `${record.run_id}.json`, record })), problems: [] })
}

function entry(head: string, user = 'u-at-x.io'): EvidenceNoteEntry {
  return {
    change: 'demo', user, chain: { head, records: 1, last_run: 'r', last_finished_at: 't' }, plan_digest: null,
    last_result: 'pass', anchor: { kind: 'chain-head', head }, tenon: '0.2.0', created_at: 't',
  }
}

const input = (chain: ChainReport | undefined, anchors: Parameters<typeof evaluateAnchor>[0]['anchors'], extra: Partial<Parameters<typeof evaluateAnchor>[0]> = {}) => ({
  change: 'demo', user: 'u-at-x.io', anchors, chain, baseDigest: undefined, requireAnchor: false, text: ciKeyText, ...extra,
})

describe('evaluateAnchor', () => {
  const chain = chainOf(3)
  const digests = chain.state === 'intact' ? chain.active.map((record) => record.digest) : []

  it('没有锚点：none；--require-anchor 才是 error', () => {
    expect(evaluateAnchor(input(chain, []))).toEqual({ state: 'none', findings: [] })
    const required = evaluateAnchor(input(chain, [], { requireAnchor: true }))
    expect(required.findings).toEqual([expect.objectContaining({ code: 'anchor-missing', severity: 'error' })])
  })

  it('链头等于锚点：verified', () => {
    expect(evaluateAnchor(input(chain, [{ commit: COMMIT, entry: entry(digests[2] ?? '') }]))).toEqual({ state: 'verified', findings: [] })
  })

  it('锚点之后追加了记录：behind（警告；--require-anchor 升为 error），并说明追加了几条', () => {
    const anchors = [{ commit: COMMIT, entry: entry(digests[0] ?? '') }]
    const lenient = evaluateAnchor(input(chain, anchors))
    expect(lenient.state).toBe('behind')
    expect(lenient.findings).toEqual([expect.objectContaining({ code: 'anchor-behind', severity: 'warning', message: expect.stringContaining('"behind":2') })])
    expect(evaluateAnchor(input(chain, anchors, { requireAnchor: true })).findings[0]?.severity).toBe('error')
  })

  it('锚定的链头不在链里：mismatch（error，不给重新锚定的修复命令）；链被清理过则只是 unverifiable', () => {
    const forged = [{ commit: COMMIT, entry: entry(`sha256:${'9'.repeat(64)}`) }]
    const mismatch = evaluateAnchor(input(chain, forged))
    expect(mismatch.state).toBe('mismatch')
    expect(mismatch.findings[0]).toMatchObject({ code: 'anchor-mismatch', severity: 'error' })
    expect(mismatch.findings[0]?.fix).toBeUndefined()
    const pruned = evaluateAnchor(input(chain, forged, { baseDigest: `sha256:${'8'.repeat(64)}` }))
    expect(pruned).toMatchObject({ state: 'unverifiable', findings: [expect.objectContaining({ code: 'anchor-unverifiable', severity: 'warning' })] })
  })

  it('只看判定用的用户的锚点；空链有锚点是 mismatch；断链不重复报', () => {
    expect(evaluateAnchor(input(chain, [{ commit: COMMIT, entry: entry(digests[2] ?? '', 'other-at-x.io') }])).state).toBe('none')
    expect(evaluateAnchor(input({ state: 'empty' }, [{ commit: COMMIT, entry: entry(digests[2] ?? '') }])).state).toBe('mismatch')
    expect(evaluateAnchor(input({ state: 'broken', reason: 'x', files: [] }, [{ commit: COMMIT, entry: entry(digests[2] ?? '') }])))
      .toEqual({ state: 'mismatch', findings: [] })
  })

  it('链基点正好是锚定的链头：之后的记录都算追加', () => {
    const base = digests[0] ?? ''
    const rest = chainOf(2)
    const result = evaluateAnchor(input(rest, [{ commit: COMMIT, entry: entry(base) }], { baseDigest: base }))
    expect(result.state).toBe('behind')
  })
})
