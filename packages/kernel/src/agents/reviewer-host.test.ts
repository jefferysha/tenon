import { describe, expect, it } from 'vitest'
import { hostRunValid, reviewerHostRequirement } from './reviewer-host.js'

describe('reviewerHostRequirement', () => {
  it('步骤声明的优先：claude / codex 是硬要求，any 盖过 agent 的建议', () => {
    expect(reviewerHostRequirement('codex', 'claude')).toEqual({ host: 'codex', source: 'step', enforced: true })
    expect(reviewerHostRequirement('claude', undefined)).toEqual({ host: 'claude', source: 'step', enforced: true })
    expect(reviewerHostRequirement('any', 'codex')).toEqual({ host: 'any', source: 'step', enforced: false })
  })

  it('步骤没写：agent 定义的建议只路由、不强制；两处都没有 = 不限', () => {
    expect(reviewerHostRequirement(undefined, 'codex')).toEqual({ host: 'codex', source: 'agent', enforced: false })
    expect(reviewerHostRequirement(undefined, 'any')).toEqual({ host: 'any', source: 'none', enforced: false })
    expect(reviewerHostRequirement(undefined, undefined)).toEqual({ host: 'any', source: 'none', enforced: false })
  })
})

describe('hostRunValid', () => {
  it('没有硬要求恒成立；有硬要求必须登记过且相符', () => {
    expect(hostRunValid(undefined, undefined)).toBe(true)
    expect(hostRunValid('any', 'claude')).toBe(true)
    expect(hostRunValid('codex', 'codex')).toBe(true)
    expect(hostRunValid('codex', 'claude')).toBe(false)
    expect(hostRunValid('codex', undefined)).toBe(false)
  })
})
