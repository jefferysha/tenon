import { describe, expect, it } from 'vitest'
import { shortPath } from './shortPath'

describe('shortPath', () => {
  it('家目录折成 ~，长路径只留父目录与目录名', () => {
    expect(shortPath('/Users/a1234/Documents/code-manager/projects/tenon-local')).toBe('…/projects/tenon-local')
    expect(shortPath('/private/tmp/claude-501/-Users-a1234-x/stepdemo')).toBe('…/-Users-a1234-x/stepdemo')
    expect(shortPath('/home/me/repo')).toBe('~/repo')
    expect(shortPath('/Users/me/work/repo/')).toBe('~/work/repo')
  })

  it('两段以内的路径原样显示', () => {
    expect(shortPath('/repo')).toBe('/repo')
    expect(shortPath('/srv/repo')).toBe('/srv/repo')
    expect(shortPath('')).toBe('')
  })
})
