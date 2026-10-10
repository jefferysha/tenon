import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineState } from '../types.js'
import type { AgentBlocker } from '../workflow/agent-verdict.js'
import {
  REVIEW_WAIVERS_FILE, approveFrozenWaivers, boundReviewWaiverSelection, clearReviewWaiverSelection,
  readReviewWaiverSelection, writeReviewWaiverSelection,
} from './review-waivers.js'
import {
  MAX_ACCEPTED_RESIDUALS, RESIDUAL_SUMMARY_MAX, acceptedForEvaluation, residualAcceptedRaw, residualAgent, residualFromBlockers,
  residualKey, residualLines, type FrozenResidual,
} from './review-residual.js'

// 双向覆盖（U+202A–U+202E）与隔离（U+2066–U+2069）字符按码点构造：源码里不出现这些不可见字符。
const LRE = String.fromCodePoint(0x202a)
const RLO = String.fromCodePoint(0x202e)
const LRI = String.fromCodePoint(0x2066)
const PDI = String.fromCodePoint(0x2069)

/** 含 C0 / C1 控制字符或双向覆盖 / 隔离字符。 */
function hasUnsafeChars(value: string): boolean {
  return [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  })
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenon-review-residual-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const CAND = `workspace:sha256:${'a'.repeat(64)}`
const CAND_B = `workspace:sha256:${'b'.repeat(64)}`
const ACTOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' as const }
const STAMP = '2026-10-09T10:00:00.000Z'
const LATER = '2026-10-09T11:00:00.000Z'

const REQUEST = { phase: 'verify', event: 'verify-pass', requestedAt: '2026-10-09T09:00:00.000Z' }

const SECURITY: FrozenResidual = {
  key: 'reviewer:security', runId: 'run-sec-1', candidate: CAND, findings: 2,
  summary: ['high src/a.ts:3 SQL 拼接', 'medium src/b.ts:9 未校验输入'],
}

const failed = (over: Partial<Extract<AgentBlocker, { kind: 'reviewer-failed' }>> = {}): AgentBlocker => ({
  kind: 'reviewer-failed', agent: 'security', blockAt: 'medium', runId: 'run-sec-1', candidate: CAND,
  blocking: [
    { severity: 'high', location: 'src/a.ts:3', message: 'SQL 拼接' },
    { severity: 'medium', location: 'src/b.ts:9', message: '未校验输入' },
  ],
  ...over,
})

function reviewState(over: { phase?: string; event?: string; requestedAt?: string } = {}): PipelineState {
  return {
    fields: {
      review_gate_phase: over.phase ?? REQUEST.phase,
      review_gate_event: over.event ?? REQUEST.event,
      review_requested_at: over.requestedAt ?? REQUEST.requestedAt,
    },
    opaqueTail: '',
  } as unknown as PipelineState
}

const approve = (state: PipelineState = reviewState(), recordedAt = STAMP) =>
  approveFrozenWaivers({ repoRoot: dir, dir, change: 'demo', state, actor: ACTOR, recordedAt })

describe('剩余阻断的键与冻结项', () => {
  it('键是 reviewer:<agent>，能还原出 agent；别的键不是剩余阻断', () => {
    expect(residualKey('security')).toBe('reviewer:security')
    expect(residualAgent('reviewer:security')).toBe('security')
    expect(residualAgent('test:size')).toBeUndefined()
    expect(residualAgent('reviewer:')).toBeUndefined()
  })

  it('从阻断里取 reviewer-failed：带运行 id、候选、阻断级发现数与单行摘要；其余阻断不是剩余阻断', () => {
    const items = residualFromBlockers([
      { kind: 'reviewer-missing', agent: 'other' },
      failed(),
      { kind: 'reviewer-stale', agent: 'third' },
    ])
    expect(items).toEqual([SECURITY])
  })

  it('没有运行 id 或候选的 reviewer-failed 无从绑定，不冻结', () => {
    expect(residualFromBlockers([failed({ runId: undefined })])).toEqual([])
    expect(residualFromBlockers([failed({ candidate: undefined })])).toEqual([])
  })

  it('摘要最多 5 条，每条折成单行、截短，反引号与尖括号换全角（评审者的话不能伪造标签）', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      severity: 'high' as const, location: `f.ts:${index}`, message: `问题 ${index}`,
    }))
    const [item] = residualFromBlockers([failed({ blocking: many })])
    expect(item?.findings).toBe(8)
    expect(item?.summary).toHaveLength(5)
    const [nasty] = residualFromBlockers([failed({
      blocking: [{ severity: 'high', location: 'a.ts', message: `第一行\n第二行 <script>\`rm\`${'字'.repeat(300)}` }],
    })])
    const line = nasty?.summary[0] ?? ''
    expect(line).not.toMatch(/[\n`<>]/u)
    expect([...line].length).toBeLessThanOrEqual(220)
  })

  it('摘要去掉 C0 / C1 控制字符与双向覆盖 / 隔离字符：评审者的话带不进终端转义序列或文字方向反转', () => {
    const [item] = residualFromBlockers([failed({
      blocking: [
        { severity: 'high', location: 'a.ts:1', message: `清屏\u001b[2K完成${RLO}反转${LRI}隔离${PDI}\u0085\u007f\u0000` },
        { severity: 'low', location: 'b.ts:2\u0007', message: '响铃' },
      ],
    })])
    expect(item?.summary).toEqual(['high a.ts:1 清屏[2K完成反转隔离', 'low b.ts:2 响铃'])
    expect(hasUnsafeChars(item?.summary.join('') ?? '')).toBe(false)
  })

  it('历史里的接受行：review.residual-accepted，带评审者、运行、候选、发现数与确认者，单行可 grep', () => {
    expect(residualAcceptedRaw({ key: 'reviewer:security', runId: 'run-sec-1', candidate: CAND, findings: 2 }, ACTOR.id))
      .toBe(`review.residual-accepted reviewer=security run=run-sec-1 candidate=${CAND} findings=2 by=${ACTOR.id}`)
  })

  it('历史接受行带上冻结时的发现摘要：summary= 后各条用 | 连接，条内空白折成 _、| 换全角，仍是一行', () => {
    const raw = residualAcceptedRaw({ key: 'reviewer:security', runId: 'run-sec-1', candidate: CAND, findings: 2, summary: SECURITY.summary }, ACTOR.id)
    expect(raw).toBe(
      `review.residual-accepted reviewer=security run=run-sec-1 candidate=${CAND} findings=2 by=${ACTOR.id}`
      + ' summary=high_src/a.ts:3_SQL_拼接|medium_src/b.ts:9_未校验输入',
    )
    const piped = residualAcceptedRaw({ key: 'reviewer:security', runId: 'r', candidate: CAND, findings: 1, summary: ['high a.ts 用 a|b 拼接'] }, ACTOR.id)
    expect(piped).toContain('summary=high_a.ts_用_a｜b_拼接')
    expect(piped.split('summary=')[1]).not.toContain('|')
  })

  it('历史接受行的摘要最多 5 条、再清洗一遍：控制字符与超长都去掉，整行不超过 4 KiB', () => {
    const nasty = `字\u001b[2K${RLO}`.repeat(120)
    const raw = residualAcceptedRaw({
      key: 'reviewer:security', runId: 'run-sec-1', candidate: CAND, findings: 9,
      summary: Array.from({ length: 8 }, (_, index) => `high f.ts:${index} ${nasty}`),
    }, ACTOR.id)
    expect(hasUnsafeChars(raw)).toBe(false)
    expect(raw.split('summary=')[1]?.split('|')).toHaveLength(RESIDUAL_SUMMARY_MAX)
    expect(Buffer.byteLength(JSON.stringify({ ts: STAMP, kind: 'tool', raw }), 'utf8')).toBeLessThan(4096)
  })

  it('历史接受行没有摘要时与以前逐字相同（不带 summary= 键）', () => {
    const raw = residualAcceptedRaw({ key: 'reviewer:security', runId: 'run-sec-1', candidate: CAND, findings: 2, summary: [] }, ACTOR.id)
    expect(raw).not.toContain('summary=')
  })

  it('逐条列给用户的行带键、运行 id、候选和发现摘要', () => {
    const lines = residualLines([SECURITY])
    expect(lines.join('\n')).toContain('reviewer:security')
    expect(lines.join('\n')).toContain('run-sec-1')
    expect(lines.join('\n')).toContain(CAND)
    expect(lines.join('\n')).toContain('SQL 拼接')
    expect(lines.join('\n')).toContain('未校验输入')
  })
})

describe('冻结清单里的 residual', () => {
  it('写入后原样读回；只有 residual 没有豁免的请求也算绑定了这次请求', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    expect(await readReviewWaiverSelection(dir)).toEqual({ version: 1, ...REQUEST, waivers: [], residual: [SECURITY] })
    const bound = await boundReviewWaiverSelection(dir, reviewState())
    expect(bound.selection?.residual).toEqual([SECURITY])
    expect(await boundReviewWaiverSelection(dir, reviewState({ requestedAt: '2026-01-01T00:00:00.000Z' })))
      .toEqual({ selection: undefined, unbound: true })
  })

  it('解码是严格的：键名、候选、运行 id、发现数、摘要的形状不对，整份当作没有清单（失败关闭）', async () => {
    const head = `{"version":1,"phase":"verify","event":"verify-pass","requestedAt":"t","waivers":[],"residual":`
    const item = (over: Record<string, unknown>) => JSON.stringify([{ ...SECURITY, ...over }])
    const bad = [
      item({ key: 'security' }),
      item({ key: 'test:size' }),
      item({ candidate: 'not-a-candidate' }),
      item({ candidate: '' }),
      item({ runId: '' }),
      item({ runId: 'a b' }),
      item({ findings: 0 }),
      item({ findings: -1 }),
      item({ findings: 1.5 }),
      item({ summary: 'x' }),
      item({ summary: [1] }),
      item({ extra: 1 }),
      '[{"key":"reviewer:security"}]',
      '{}',
    ]
    for (const residual of bad) {
      await writeFile(join(dir, REVIEW_WAIVERS_FILE), `${head}${residual}}`, 'utf8')
      expect(await readReviewWaiverSelection(dir), residual).toBeUndefined()
    }
    await writeFile(join(dir, REVIEW_WAIVERS_FILE), `${head}${item({})}}`, 'utf8')
    expect(await readReviewWaiverSelection(dir)).toMatchObject({ residual: [SECURITY] })
  })

  it('手工写进清单的摘要含控制字符或双向字符：整份拒收（失败关闭），不读成待接受项', async () => {
    const head = `{"version":1,"phase":"verify","event":"verify-pass","requestedAt":"t","waivers":[],"residual":`
    const marks = ['\u0000', '\u001b[2K', '\u0007', '\u007f', '\u0085', '\u009f', LRE, RLO, LRI, PDI]
    for (const mark of marks) {
      const body = JSON.stringify([{ ...SECURITY, summary: [`high a.ts:1 ok${mark}x`] }])
      await writeFile(join(dir, REVIEW_WAIVERS_FILE), `${head}${body}}`, 'utf8')
      expect(await readReviewWaiverSelection(dir), JSON.stringify(mark)).toBeUndefined()
    }
    await writeFile(join(dir, REVIEW_WAIVERS_FILE), `${head}${JSON.stringify([{ ...SECURITY, summary: ['high a.ts:1 干净的一行'] }])}}`, 'utf8')
    expect(await readReviewWaiverSelection(dir)).toMatchObject({ residual: [{ summary: ['high a.ts:1 干净的一行'] }] })
  })
})

describe('approveFrozenWaivers 接受剩余阻断', () => {
  it('确认时接受冻结的 residual：写进清单的 accepted（带运行、候选、发现数、确认者与时间），结果里列出', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    const outcome = await approve()
    const accepted = { key: 'reviewer:security', runId: 'run-sec-1', candidate: CAND, findings: 2, acceptedBy: ACTOR.id, acceptedAt: STAMP }
    // 结果里多带冻结时的发现摘要（审计行用），边车里的接受记录仍是不带摘要的固定形状。
    expect(outcome.residualAccepted).toEqual([{ ...accepted, summary: SECURITY.summary }])
    expect((await readReviewWaiverSelection(dir))?.accepted).toEqual([accepted])
    expect(acceptedForEvaluation((await readReviewWaiverSelection(dir))?.accepted))
      .toEqual([{ agent: 'security', runId: 'run-sec-1', candidate: CAND }])
  })

  it('确认通道没有把待接受项展示给用户（acceptResidual: false，如 Dashboard）：不接受，边车里不落 accepted', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    const outcome = await approveFrozenWaivers({
      repoRoot: dir, dir, change: 'demo', state: reviewState(), actor: ACTOR, recordedAt: STAMP, acceptResidual: false,
    })
    expect(outcome.residualAccepted).toBeUndefined()
    expect((await readReviewWaiverSelection(dir))?.accepted).toBeUndefined()
  })

  it('清单不属于这一次请求（请求时间对不上）：什么都不接受', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    const outcome = await approve(reviewState({ requestedAt: '2026-01-01T00:00:00.000Z' }))
    expect(outcome.residualAccepted).toBeUndefined()
    expect((await readReviewWaiverSelection(dir))?.accepted).toBeUndefined()
  })

  it('没有 residual 的确认：结果里没有 residualAccepted，行为与以前逐字相同', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [{ key: 'kind:benchmark', reason: '纯文案改动' }] })
    expect((await approve()).residualAccepted).toBeUndefined()
  })

  it('接受是持久的：清掉待批准清单后 accepted 仍在，待批准的豁免与 residual 都清空', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    await approve()
    await clearReviewWaiverSelection(dir)
    const kept = await readReviewWaiverSelection(dir)
    expect(kept?.accepted).toHaveLength(1)
    expect(kept?.waivers).toEqual([])
    expect(kept?.residual).toBeUndefined()
    expect(await boundReviewWaiverSelection(dir, reviewState())).toEqual({ selection: undefined, unbound: false })
  })

  it('没有 accepted 时清除仍是删文件（既有行为）', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [{ key: 'kind:benchmark', reason: 'x' }] })
    await clearReviewWaiverSelection(dir)
    await expect(readFile(join(dir, REVIEW_WAIVERS_FILE), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('之后的新请求重新冻结清单，已有的 accepted 照旧保留', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    await approve()
    await clearReviewWaiverSelection(dir)
    await writeReviewWaiverSelection(dir, {
      ...REQUEST, requestedAt: '2026-10-09T12:00:00.000Z', waivers: [], residual: [{ ...SECURITY, runId: 'run-sec-2', candidate: CAND_B }],
    })
    const selection = await readReviewWaiverSelection(dir)
    expect(selection?.residual).toEqual([{ ...SECURITY, runId: 'run-sec-2', candidate: CAND_B }])
    expect(selection?.accepted).toEqual([expect.objectContaining({ key: 'reviewer:security', runId: 'run-sec-1' })])
  })

  it('同一评审者再次被接受时替换旧的接受（每个评审者只留最新一条）；重试同一次确认是幂等的', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    await approve()
    await approve()
    expect((await readReviewWaiverSelection(dir))?.accepted).toHaveLength(1)
    const second: FrozenResidual = { ...SECURITY, runId: 'run-sec-2', candidate: CAND_B, findings: 1 }
    await writeReviewWaiverSelection(dir, { ...REQUEST, requestedAt: '2026-10-09T12:00:00.000Z', waivers: [], residual: [second, { ...SECURITY, key: 'reviewer:quality', runId: 'run-q-1' }] })
    await approve(reviewState({ requestedAt: '2026-10-09T12:00:00.000Z' }), LATER)
    const accepted = (await readReviewWaiverSelection(dir))?.accepted ?? []
    expect(accepted.map((item) => [item.key, item.runId])).toEqual([['reviewer:security', 'run-sec-2'], ['reviewer:quality', 'run-q-1']])
    expect(accepted[0]).toMatchObject({ acceptedAt: LATER, candidate: CAND_B, findings: 1 })
  })

  it('accepted 的解码也是严格的：坏形状整份读不出（失败关闭，不会读成已接受）', async () => {
    await writeReviewWaiverSelection(dir, { ...REQUEST, waivers: [], residual: [SECURITY] })
    await approve()
    const raw = JSON.parse(await readFile(join(dir, REVIEW_WAIVERS_FILE), 'utf8')) as { accepted: Record<string, unknown>[] }
    const unsafe = [{ acceptedBy: 'a\u001b[2Kb@x.test' }, { acceptedBy: `a${RLO}b@x.test` }, { acceptedAt: '2026\u0000' }]
    for (const over of [{ key: 'security' }, { candidate: 'x' }, { acceptedBy: '' }, { acceptedAt: '' }, { findings: 0 }, { extra: true }, ...unsafe]) {
      await writeFile(join(dir, REVIEW_WAIVERS_FILE), JSON.stringify({ ...raw, accepted: [{ ...raw.accepted[0], ...over }] }), 'utf8')
      expect(await readReviewWaiverSelection(dir), JSON.stringify(over)).toBeUndefined()
    }
  })

  it(`accepted 最多保留 ${MAX_ACCEPTED_RESIDUALS} 条（最旧的先丢），文件不会无界增长`, async () => {
    for (let index = 0; index < MAX_ACCEPTED_RESIDUALS + 3; index += 1) {
      const requestedAt = `2026-10-09T12:00:${String(index).padStart(2, '0')}.000Z`
      await writeReviewWaiverSelection(dir, {
        ...REQUEST, requestedAt, waivers: [], residual: [{ ...SECURITY, key: `reviewer:agent-${index}`, runId: `run-${index}` }],
      })
      await approve(reviewState({ requestedAt }), requestedAt)
    }
    const accepted = (await readReviewWaiverSelection(dir))?.accepted ?? []
    expect(accepted).toHaveLength(MAX_ACCEPTED_RESIDUALS)
    expect(accepted.map((item) => item.key)).not.toContain('reviewer:agent-0')
    expect(accepted.map((item) => item.key)).toContain(`reviewer:agent-${MAX_ACCEPTED_RESIDUALS + 2}`)
  })
})
