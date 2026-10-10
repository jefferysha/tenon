import { describe, expect, test } from 'vitest'
import { GATE_MARKERS } from '../types.js'
import {
  formatReviewMarker, interactionSessionMarkerId, INTERACTION_MARKER_SESSION_PREFIX, parseReviewMarker, REVIEW_MARKER_PROTOCOL, reviewHint,
} from './markers.js'

describe('交互标记按会话分文件', () => {
  test('分文件名 = 单文件名 + "." + 会话 id', () => {
    expect(INTERACTION_MARKER_SESSION_PREFIX).toBe(`${GATE_MARKERS[2]}.`)
  })
  test('interactionSessionMarkerId 只认合法会话 id（[A-Za-z0-9_-]、1-128 位），其余返回 undefined', () => {
    expect(interactionSessionMarkerId('.pipeline-pending-interaction.session-a_0001')).toBe('session-a_0001')
    expect(interactionSessionMarkerId(`.pipeline-pending-interaction.${'a'.repeat(128)}`)).toBe('a'.repeat(128))
    expect(interactionSessionMarkerId(`.pipeline-pending-interaction.${'a'.repeat(129)}`)).toBeUndefined()
    // 单文件本身不是分文件。
    expect(interactionSessionMarkerId('.pipeline-pending-interaction')).toBeUndefined()
    expect(interactionSessionMarkerId('.pipeline-pending-interaction.')).toBeUndefined()
    // hook 的临时文件（原子写 / 认领）带点号后缀，不是标记。
    expect(interactionSessionMarkerId('.pipeline-pending-interaction.sess-a.tmp.123')).toBeUndefined()
    expect(interactionSessionMarkerId('.pipeline-pending-interaction.claim.123')).toBeUndefined()
    expect(interactionSessionMarkerId('.pipeline-pending-interaction.has space')).toBeUndefined()
    expect(interactionSessionMarkerId('.pipeline-pending-review.sess-a')).toBeUndefined()
    expect(interactionSessionMarkerId('x.pipeline-pending-interaction.sess-a')).toBeUndefined()
  })
})

/**
 * reviewHint 的逐字映射独立锚定（G1 REFACTOR 第二轮 codex review 指出：server.test.ts 的
 * "精确格式"断言用 reviewHint('explore') 拼期望值，与生产实现同源自证——若这个函数的文案被
 * 误改，产物和期望会一起漂移、测试仍绿。这里用硬编码字面量钉死，充当独立 oracle。
 */
describe('reviewHint —— review 相位的 marker 指引文案（老内核 state-transition.sh 同款三行格式第二行）', () => {
  test('explore → design_doc 指引', () => {
    expect(reviewHint('explore')).toBe('design_doc（深度设计 / 调研 + 关键决策）')
  })
  test('spec → plan 指引', () => {
    expect(reviewHint('spec')).toBe('plan / 用户旅程 / delta spec（实施计划）')
  })
  test('verify → verification_report 指引', () => {
    expect(reviewHint('verify')).toBe('verification_report（验证结论）')
  })
  test('非复核相位（open/build/ship/archive）→ 通用兜底文案', () => {
    expect(reviewHint('open')).toBe('（待复核）')
    expect(reviewHint('build')).toBe('（待复核）')
    expect(reviewHint('ship')).toBe('（待复核）')
    expect(reviewHint('archive')).toBe('（待复核）')
  })
})

describe('review marker v2 —— canonical review request 的短时 hook projection', () => {
  test('格式化与解析保留 exact phase / Change identity / request timestamp', () => {
    const raw = formatReviewMarker({
      phase: 'custom-review', event: 'accept', changeName: 'catalog-flow', requestedAt: '2026-07-24T12:00:00Z',
    })
    expect(raw).toMatch(new RegExp(`^${REVIEW_MARKER_PROTOCOL}\\n`))
    expect(parseReviewMarker(raw)).toEqual({
      phase: 'custom-review', event: 'accept', changeName: 'catalog-flow', requestedAt: '2026-07-24T12:00:00Z',
    })
  })

  test('旧三行 entry-time marker 与缺少 identity 的伪 v2 一律不能成为 receipt', () => {
    expect(parseReviewMarker('explore\n旧提示\ndemo\n')).toBeNull()
    expect(parseReviewMarker(`${REVIEW_MARKER_PROTOCOL}\nphase=explore\nchange=\nrequested_at=x\n`)).toBeNull()
    expect(parseReviewMarker(`${REVIEW_MARKER_PROTOCOL}\nphase=explore\nchange=demo\n`)).toBeNull()
  })

  test('旧 v2 marker 仍可识别 Change identity，但没有 event 不能授权转换', () => {
    expect(parseReviewMarker(`${REVIEW_MARKER_PROTOCOL}\nphase=verify\nchange=demo\nrequested_at=x\n提示\n`)).toEqual({
      phase: 'verify', changeName: 'demo', event: '', requestedAt: 'x',
    })
  })
})
