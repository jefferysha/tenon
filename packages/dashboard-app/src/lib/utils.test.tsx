import { describe, expect, it } from 'vitest'

import { cn, shortPath } from './utils'

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

describe('shortPath', () => {
  it('家目录写成 ~，两段以内原样', () => {
    expect(shortPath('/Users/me/code/repo')).toBe('~/code/repo')
    expect(shortPath('/home/me')).toBe('~')
    expect(shortPath('/srv/app')).toBe('/srv/app')
  })

  it('超过两段时只留末两段，中间写 …', () => {
    expect(shortPath('/Users/me/Documents/code-manager/projects/tenon-local')).toBe('~/…/projects/tenon-local')
    expect(shortPath('/opt/a/b/c')).toBe('/…/b/c')
    expect(shortPath('/private/tmp/claude-501/-Users-a1234-x/stepdemo')).toBe('/…/-Users-a1234-x/stepdemo')
  })

  it('末尾斜杠不算一段；空串原样', () => {
    expect(shortPath('/Users/me/work/repo/')).toBe('~/work/repo')
    expect(shortPath('/repo')).toBe('/repo')
    expect(shortPath('')).toBe('')
  })
})
