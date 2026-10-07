import { AGENT_RERUN_REASON_MAX, type AgentRunRow } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import { parseRerunReason, rerunNote, rerunRefusal } from '../commands/agent-rerun.js'
import { hostNote } from '../commands/agent-route.js'
import { formatMessage, MESSAGE_CODES, MESSAGES, placeholdersOf, type MessageCode } from './messages.js'

const CJK = /[㐀-鿿＀-￯　-〿]/u
const zh = (code: MessageCode, params: Record<string, string | number> = {}): string => formatMessage('zh', code, params)

/** 这一批迁移新增的码：`agent next` 的人读行、prompt / record 的其余错误、重跑防刷，以及 review request / acknowledge 的成功行与警告。 */
const NEW_CODES = MESSAGE_CODES.filter((code) =>
  code.startsWith('agent.next.') || code.startsWith('agent.rerun.') || code.startsWith('review.acknowledged.')
  || code.startsWith('review.warn.') || code.startsWith('review.verifyFail.') || code.startsWith('review.requested.')
  || code.startsWith('review.request.') || [
    'agent.notDeclared', 'agent.notFrozen', 'agent.waiting', 'agent.record.subagentInvalid', 'agent.record.runNotRunning',
    'agent.record.reportTooLarge', 'agent.record.reportUnreadable', 'agent.record.reportInvalid', 'agent.record.candidateChanged',
    'review.waiversApproved', 'review.protectedApproved', 'review.usage', 'list.separator',
  ].includes(code))

describe('agent next / prompt / record 与 review request / acknowledge 的消息目录', () => {
  it('这一批的码一共 60 条，每条两种语言的占位符一致、英文里没有中文', () => {
    expect(NEW_CODES).toHaveLength(60)
    for (const code of NEW_CODES) {
      expect(placeholdersOf(MESSAGES[code].en), code).toEqual(placeholdersOf(MESSAGES[code].zh))
      expect(CJK.test(MESSAGES[code].en), `${code}: ${MESSAGES[code].en}`).toBe(false)
    }
  })

  it('zh 与这些命令原有的中文输出逐字一致（prompt / record 的错误）', () => {
    expect(zh('agent.notDeclared', { agent: 'a', step: 'build' })).toBe("agent 'a' 未在步骤 'build' 声明")
    expect(zh('agent.notFrozen', { agent: 'a' })).toBe("agent 'a' 未随本任务冻结；重新创建任务或改工作流")
    expect(zh('agent.waiting', { agent: 'a', needs: 'agent:b, agent:c' })).toBe("agent 'a' 还需等待：agent:b, agent:c")
    expect(zh('agent.rerun.reasonInvalid', { max: 300 })).toBe('--rerun-reason 需要一行不超过 300 字的原因')
    expect(zh('agent.record.subagentInvalid', { subagent: '!!' })).toBe("--subagent '!!' 非法")
    expect(zh('agent.record.runNotRunning', { run: 'r1' })).toBe("run 'r1' 不是本次步骤访问中进行中的运行")
    expect(zh('agent.record.reportTooLarge', { max: 262144 })).toBe('报告无效：超过 262144 字节')
    expect(zh('agent.record.reportUnreadable', { path: 'p/r.md' })).toBe('报告无效：p/r.md 读不到')
    expect(zh('agent.record.reportInvalid', { error: 'boom' })).toBe('报告无效：boom')
    expect(zh('agent.record.candidateChanged', { change: 'c', agent: 'a' })).toBe('评审期间候选已变化；重跑：tenon agent prompt c a')
  })

  it('zh 与 agent next 原有的人读行逐字一致（角色、状态、结果、问题数、下一波、进行中、等待、全部完成）', () => {
    expect([zh('agent.next.role.executor'), zh('agent.next.role.reviewer')]).toEqual(['执行者', '评审者'])
    expect(['idle', 'running', 'done', 'stale'].map((state) => zh(`agent.next.state.${state}` as MessageCode)))
      .toEqual(['未运行', '进行中', '已完成', '过期'])
    expect(['pass', 'fail', 'done', 'failed'].map((result) => zh(`agent.next.result.${result}` as MessageCode)))
      .toEqual(['通过', '不通过', '完成', '失败'])
    expect(zh('agent.next.findings', { count: 2 })).toBe('问题 2')
    expect(zh('agent.next.wave', { agents: 'a, b' })).toBe('下一波：a, b')
    expect(zh('agent.next.running', { agent: 'a', change: 'c', run: 'r1' })).toBe('进行中：a；完成后 tenon agent record c r1')
    expect(zh('agent.next.waiting', { agent: 'a', needs: 'test:unit' })).toBe('等待：a ← test:unit')
    expect(zh('agent.next.allDone')).toBe('全部完成')
    expect(zh('agent.next.unfinished', { blocker: 'x' })).toBe('未完成：x')
  })

  it('hostNote：zh 与原来的一行末尾说明逐字一致，en 是英文，缺省 locale 等同 zh', () => {
    const wrong = { requiredHost: 'codex', host: 'claude', wrongHost: true } as const
    const wrongUnknown = { requiredHost: null, host: null, wrongHost: true } as const
    const recorded = { requiredHost: 'codex', host: 'codex', wrongHost: false } as const
    const required = { requiredHost: 'codex', host: null, wrongHost: false } as const
    const none = { requiredHost: null, host: null, wrongHost: false } as const
    expect(hostNote({ locale: 'zh' }, wrong)).toBe(' 宿主不符：要求 codex，登记 claude，结论无效')
    expect(hostNote({ locale: 'zh' }, wrongUnknown)).toBe(' 宿主不符：要求 —，登记 无，结论无效')
    expect(hostNote({ locale: 'zh' }, recorded)).toBe(' 宿主 codex')
    expect(hostNote({ locale: 'zh' }, required)).toBe(' 要求宿主 codex')
    expect(hostNote({ locale: 'zh' }, none)).toBe('')
    expect(hostNote({}, wrong)).toBe(hostNote({ locale: 'zh' }, wrong))

    expect(hostNote({ locale: 'en' }, wrong)).toBe(' host mismatch: requires codex, recorded claude, result invalid')
    expect(hostNote({ locale: 'en' }, wrongUnknown)).toBe(' host mismatch: requires —, recorded none, result invalid')
    expect(hostNote({ locale: 'en' }, recorded)).toBe(' host codex')
    expect(hostNote({ locale: 'en' }, required)).toBe(' requires host codex')
    expect(hostNote({ locale: 'en' }, none)).toBe('')
  })

  it('rerunNote：zh 逐字不变，en 是英文（次数、翻转、原因各自可有可无）', () => {
    expect(rerunNote({ locale: 'zh' }, { reruns: 0, flipped: true, rerunReason: 'x' })).toBe('')
    expect(rerunNote({ locale: 'zh' }, { reruns: 1, flipped: false, rerunReason: null })).toBe(' 重跑 1 次')
    expect(rerunNote({ locale: 'zh' }, { reruns: 2, flipped: true, rerunReason: null })).toBe(' 重跑 2 次（结论翻转）')
    expect(rerunNote({ locale: 'zh' }, { reruns: 2, flipped: true, rerunReason: '补充了设计稿' })).toBe(' 重跑 2 次（结论翻转）：补充了设计稿')
    expect(rerunNote({ locale: 'en' }, { reruns: 0, flipped: true, rerunReason: 'x' })).toBe('')
    expect(rerunNote({ locale: 'en' }, { reruns: 1, flipped: false, rerunReason: null })).toBe(' reran 1 time(s)')
    expect(rerunNote({ locale: 'en' }, { reruns: 2, flipped: true, rerunReason: null })).toBe(' reran 2 time(s) (verdict flipped)')
    expect(rerunNote({ locale: 'en' }, { reruns: 2, flipped: true, rerunReason: 'added the design' })).toBe(' reran 2 time(s) (verdict flipped): added the design')
  })

  it('rerunRefusal：zh 与原来的整句逐字一致（结论列表用「、」），en 是整句英文（用「, 」）', () => {
    const prior = [{ result: 'fail' }, { result: 'pass' }, { result: null }] as unknown as readonly AgentRunRow[]
    expect(rerunRefusal({ locale: 'zh' }, 'demo', 'security', prior)).toBe(
      "ERROR: 评审者 'security' 在当前候选上已经有 3 次结论（fail、pass、?）：同一份代码不能靠重跑换结论。"
      + '改代码换候选后再重跑；确有需要（例如上次的提示缺上下文）用 tenon agent prompt demo security --rerun-reason <原因> 写明并留痕，'
      + '判定会把同一候选上的所有运行一并看（没有原因的重跑取最严结论，有原因的以最后一次为准）',
    )
    const en = rerunRefusal({ locale: 'en' }, 'demo', 'security', prior)
    expect(en.startsWith("ERROR: reviewer 'security' already has 3 verdict(s) on the current candidate (fail, pass, ?): ")).toBe(true)
    expect(en).toContain('tenon agent prompt demo security --rerun-reason <reason>')
    expect(CJK.test(en)).toBe(false)
  })

  it('parseRerunReason：非法原因按语言打印，合法原因原样规整返回', () => {
    const run = (locale: 'zh' | 'en' | undefined, raw: string | undefined): { value: string | undefined | null; err: string[] } => {
      const err: string[] = []
      const value = parseRerunReason({ io: { out: () => undefined, err: (line: string) => { err.push(line) } }, ...(locale === undefined ? {} : { locale }) }, raw)
      return { value, err }
    }
    expect(run('zh', undefined)).toEqual({ value: undefined, err: [] })
    expect(run('en', '  why  ')).toEqual({ value: 'why', err: [] })
    expect(run('zh', '  ')).toEqual({ value: null, err: [`ERROR: --rerun-reason 需要一行不超过 ${AGENT_RERUN_REASON_MAX} 字的原因`] })
    expect(run(undefined, 'a\nb').err).toEqual([`ERROR: --rerun-reason 需要一行不超过 ${AGENT_RERUN_REASON_MAX} 字的原因`])
    expect(run('en', 'a\nb')).toEqual({ value: null, err: [`ERROR: --rerun-reason needs a one-line reason of at most ${AGENT_RERUN_REASON_MAX} characters`] })
  })

  it('zh 与 review request / acknowledge 原有的中文输出逐字一致（成功行、豁免收尾、警告、verify-fail 回退检查、用法）', () => {
    expect(zh('review.acknowledged.owner')).toBe('已确认')
    expect(zh('review.acknowledged.delegated')).toBe('已按用户委托的持续授权确认')
    expect(zh('review.acknowledged.by', { reviewer: 'B <b@x.io>', owner: 'A <a@x.io>' })).toBe('（评审人 B <b@x.io>，负责人 A <a@x.io>）')
    expect(zh('review.acknowledged.noOwner')).toBe('无')
    expect(zh('review.acknowledged.retransition')).toBe('，可重发 transition')
    expect(zh('review.waiversApproved', { count: 2, list: 'kind:unit、kind:lint' })).toBe('已批准豁免 2 项：kind:unit、kind:lint')
    expect(zh('review.protectedApproved', { count: 1, list: 'a.yaml' })).toBe('已批准测试配置改动 1 项：a.yaml')
    expect(zh('review.warn.idempotencyLedger')).toBe('decision idempotency ledger 写入失败（approval receipt 已提交；重试会按当前状态重新判定）')
    expect(zh('review.warn.interaction')).toBe('interaction projection 写入失败（canonical review acknowledgement 已提交）')
    expect(zh('review.warn.history')).toBe('history 写入失败（canonical review acknowledgement 已提交）')
    expect(zh('review.warn.markerClear')).toBe('review marker 清理失败（approval receipt 已提交，可重试 acknowledge）')
    expect(zh('review.usage')).toBe('用法：tenon review request <change> [--event <event>] | acknowledge <change> [--delegated] [--as reviewer]')
    expect(zh('review.request.delegatedOnAcknowledge')).toBe('--delegated 只可用于 review acknowledge；request 仍必须先完成真实 review 证据')
    expect(zh('review.request.asOnAcknowledge')).toBe('--as 只可用于 review acknowledge；request 只有负责人能发起')
    expect(zh('review.requested.new')).toBe('已请求人工确认')
    expect(zh('review.requested.pending')).toBe('仍待确认')
    expect(zh('review.warn.projectionPendingFailed', { error: 'e' })).toBe('interaction projection 写入失败（canonical review pending 已存在）: e')
    expect(zh('review.warn.projectionPendingSkipped')).toBe('interaction projection 未写入（缺 canonical run/workflow/state anchor；canonical review pending 未改变）')
    expect(zh('review.warn.projectionRequestFailed', { error: 'e' })).toBe('interaction projection 写入失败（canonical review request 已提交）: e')
    expect(zh('review.warn.projectionRequestSkipped')).toBe('interaction projection 未写入（缺 canonical run/workflow/state anchor；canonical review request 已提交）')
    expect(zh('review.verifyFail.reportEmpty', { current: 'null' })).toBe("verify-fail 决策要求 verification_report 非空（当前='null'）")
    expect(zh('review.verifyFail.reportMissing', { current: 'r.md' })).toBe("verify-fail 决策要求 verification_report 文件存在（当前='r.md'）")
    expect(zh('review.verifyFail.phaseInvalid', { phase: zh('review.verifyFail.empty') })).toBe("受 OpenSpec 文档契约治理的 workflow 当前 phase 非法（当前='空'）")
    expect(zh('review.verifyFail.ready')).toBe('verify-fail 回退证据已就绪')
    expect(zh('list.separator')).toBe('、')
  })
})
