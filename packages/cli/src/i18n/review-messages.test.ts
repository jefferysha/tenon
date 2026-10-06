import { reviewerRequiredMessage } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import { routeLines, type HostRoute } from '../commands/agent-route.js'
import { formatMessage, MESSAGE_CODES, MESSAGES, placeholdersOf } from './messages.js'

const CJK = /[㐀-鿿＀-￯　-〿]/u

const STEP_ROUTE: HostRoute = {
  required: 'codex',
  source: 'step',
  enforced: true,
  current: 'claude',
  runOn: { host: 'codex', command: 'codex exec - < p.md', promptFile: 'p.md', record: 'tenon agent record c r --host codex' },
}

describe('跨厂商评审与评审确认的消息目录', () => {
  it('zh 与这些命令原有的中文输出逐字一致', () => {
    expect(routeLines({ locale: 'zh' }, 'security', STEP_ROUTE)).toEqual([
      "[ROUTE] 评审者 'security' 须在 codex 上运行（工作流步骤要求，登记的宿主不符则结论无效）；当前宿主：claude",
      '提示词：p.md',
      '运行：codex exec - < p.md',
      '登记（评审写完报告后）：tenon agent record c r --host codex',
    ])
    expect(routeLines({}, 'a', { ...STEP_ROUTE, source: 'agent', enforced: false, current: null })[0])
      .toBe("[ROUTE] 评审者 'a' 须在 codex 上运行（agent 定义建议）；当前宿主：终端")
    expect(formatMessage('zh', 'review.ownerRequired.none', { name: 'x' })).toBe(reviewerRequiredMessage('x', null))
    expect(formatMessage('zh', 'review.ownerRequired.other', { name: 'x', owner: 'A <a@x.io>' }))
      .toBe(reviewerRequiredMessage('x', { id: 'a@x.io', name: 'A', slug: 'a-at-x.io' }))
    expect(formatMessage('zh', 'review.asRoleInvalid', { role: 'reviewer', got: 'owner' })).toBe("--as 只支持 reviewer（收到 'owner'）")
    expect(formatMessage('zh', 'agent.hostUnsupported', { agent: 'a', host: 'h' })).toBe("agent 'a' 不支持宿主 'h'")
    expect(formatMessage('zh', 'agent.record.hostFlagUnknown', { host: 'nope', known: 'claude | codex' })).toBe("--host 'nope' 不是已知宿主（claude | codex）")
    expect(formatMessage('zh', 'agent.record.wrongHost', {
      agent: 'security', required: 'codex', host: formatMessage('zh', 'agent.record.hostUnknown'), run: 'RUN', record: 'REC',
    })).toBe("评审者 'security' 须在 codex 上运行，这次登记的宿主是 未知（终端里请用 --host 声明），结论无效、未登记；在 codex 上运行：RUN；评审写完报告后：REC")
    expect(formatMessage('zh', 'agent.record.declared')).toBe('(声明)')
    expect(formatMessage('zh', 'agent.record.generic')).toBe('(通用)')
  })

  it('en 的路由说明没有中文，每条的占位符与 zh 一致', () => {
    const lines = routeLines({ locale: 'en' }, 'security', STEP_ROUTE)
    expect(lines).toHaveLength(4)
    expect(CJK.test(lines.join('\n'))).toBe(false)
    const codes = MESSAGE_CODES.filter((code) => code.startsWith('agent.route.') || code.startsWith('agent.record.') || code.startsWith('review.'))
    expect(codes.length).toBeGreaterThanOrEqual(14)
    for (const code of codes) {
      expect(placeholdersOf(MESSAGES[code].en), code).toEqual(placeholdersOf(MESSAGES[code].zh))
      expect(CJK.test(MESSAGES[code].en), code).toBe(false)
    }
  })
})
