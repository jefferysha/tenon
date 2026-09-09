import { describe, expect, it } from 'vitest'

import { cn } from './utils'

describe('cn 对自定义字号刻度去冲突', () => {
  it('同为字号刻度时后者胜，不会两条同时留下', () => {
    expect(cn('text-caption', 'text-base')).toBe('text-base')
    expect(cn('text-base', 'text-caption')).toBe('text-caption')
    expect(cn('text-page', 'text-micro')).toBe('text-micro')
  })

  it('字号刻度不会被误判成文字颜色，故不与 text-text-2 之类互相顶掉', () => {
    expect(cn('text-caption', 'text-text-2')).toBe('text-caption text-text-2')
  })

  it('圆角刻度沿用内置词表，冲突照常收敛', () => {
    expect(cn('rounded-md', 'rounded-lg')).toBe('rounded-lg')
    expect(cn('rounded-xs', 'rounded-full')).toBe('rounded-full')
  })
})
