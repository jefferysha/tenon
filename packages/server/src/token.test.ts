/** token.test —— 写 token：生成 / header 解析 / 常量时间比较。 */
import { describe, expect, it } from 'vitest'
import { generateToken, tokenFromHeaders, tokensMatch } from './token.js'

describe('generateToken', () => {
  it('64 位十六进制（256-bit）且两次不同', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('tokenFromHeaders', () => {
  it('Authorization: Bearer <t>', () => {
    expect(tokenFromHeaders({ authorization: 'Bearer abc' })).toBe('abc')
  })
  it('X-Pipeline-Token: <t>', () => {
    expect(tokenFromHeaders({ 'x-pipeline-token': 'xyz' })).toBe('xyz')
  })
  it('缺失 → null', () => {
    expect(tokenFromHeaders({})).toBeNull()
  })
})

describe('tokensMatch —— 常量时间比较', () => {
  it('相等 → true', () => {
    expect(tokensMatch('deadbeef', 'deadbeef')).toBe(true)
  })
  it('不等 → false', () => {
    expect(tokensMatch('deadbeef', 'deadbee0')).toBe(false)
  })
  it('长度不同 → false（不抛）', () => {
    expect(tokensMatch('short', 'longer-token')).toBe(false)
  })
  it('空串 → false', () => {
    expect(tokensMatch('', 'x')).toBe(false)
  })
})
