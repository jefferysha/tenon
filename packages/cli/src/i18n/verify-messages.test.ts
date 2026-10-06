import { CI_TEXT_KEYS } from '@tenon/kernel'
import { describe, expect, it } from 'vitest'
import { formatMessage, MESSAGE_CODES, MESSAGES, placeholdersOf, type MessageCode } from './messages.js'

const KERNEL_CODES = CI_TEXT_KEYS.map((key) => `verify.${key}`)

describe('verify --ci 的消息目录', () => {
  it('kernel 渲染与发现生成用到的每个键（CI_TEXT_KEYS）在目录里都有一条 verify.<键>', () => {
    for (const code of KERNEL_CODES) expect(MESSAGE_CODES as readonly string[], code).toContain(code)
  })

  it('中文与该命令原有的中文输出逐字一致（抽查标题、列名、锚点、批准、信任边界与命令错误）', () => {
    const zh = (code: MessageCode, params: Record<string, string | number> = {}): string => formatMessage('zh', code, params)
    expect(zh('verify.headline', { verdict: zh('verify.verdict.fail'), changes: 1, errors: 2, warnings: 3, selector: '--change demo' }))
      .toBe('Tenon CI 校验 未通过：1 个任务，2 个失败，3 个警告（--change demo）')
    expect(zh('verify.fixSuffix', { fix: 'tenon x' })).toBe('；执行 tenon x')
    expect(zh('verify.changeLine', { change: 'demo', step: 'build', policy: zh('verify.policy.pass'), chains: 'a:1 条*', anchor: 'none' }))
      .toBe('任务 demo  步骤 build  策略通过  记录链 a:1 条*  锚点 none')
    expect(zh('verify.anchor.behind', { commit: 'abc', head: 'sha256:x', behind: 2 })).toBe('提交 abc 锚定了链头 sha256:x，之后又追加了 2 条记录；这些记录没有被锚定')
    expect(zh('verify.protected.line', { kind: zh('verify.protected.kind.catalog'), path: 'p', status: zh('verify.protected.status.added'), digest: 'd' })).toBe('测试目录 p（新增，d）')
    expect(zh('verify.trust.verified.anchorNone')).toBe('锚点：没有找到锚点 note，未核对')
    expect(zh('verify.trust.unverifiable.identity')).toBe('用户身份属实：身份是声明的，不是认证的')
    expect(zh('verify.ciOnly')).toBe('目前只有 CI 模式：请加 --ci（在没有用户本机封存的环境里对已提交内容独立校验）')
    expect(zh('verify.ownerChainMissingMany', { owner: 'a-at-x.io', count: 2 })).toBe('任务负责人 a-at-x.io 没有测试记录，而有 2 个用户各有一条记录链，无法决定用哪条判定')
    expect(zh('verify.ownerUnknownChainMany', { count: 2 })).toBe('任务负责人未知，而有 2 个用户各有一条记录链，无法决定用哪条判定')
  })

  it('每个 verify.* 码两种语言的占位符一致、英文里没有中文', () => {
    for (const code of MESSAGE_CODES.filter((item) => item.startsWith('verify.'))) {
      const entry = MESSAGES[code]
      expect(placeholdersOf(entry.en), code).toEqual(placeholdersOf(entry.zh))
      expect(/[㐀-鿿＀-￯　-〿]/u.test(entry.en), `${code}: ${entry.en}`).toBe(false)
    }
  })
})
