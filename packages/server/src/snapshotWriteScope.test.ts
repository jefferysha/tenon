import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { noteBodyRoot, writeScopeOf } from './snapshotWriteScope.js'

const request = (url: string): IncomingMessage => ({ url }) as IncomingMessage

describe('writeScopeOf —— 一次写可能动到哪些项目', () => {
  it('query 里的 root 与 body 里的 root 都算', () => {
    const req = request('/api/afk/x/cancel?root=/repo/a')
    noteBodyRoot(req, { root: '/repo/b', event: 'go' })
    expect(writeScopeOf(req, '/api/afk/x/cancel')?.sort()).toEqual(['/repo/a', '/repo/b'])
  })

  it('没有点名任何项目 → undefined（视为动到全部）', () => {
    const req = request('/api/user')
    noteBodyRoot(req, { id: 'a@b.c' })
    noteBodyRoot(req, 'not an object')
    noteBodyRoot(req, null)
    noteBodyRoot(req, { root: '' })
    noteBodyRoot(req, { root: 42 })
    expect(writeScopeOf(req, '/api/user')).toBeUndefined()
  })

  it('只算答案、不写状态的 POST → 空（什么都不必失效）', () => {
    expect(writeScopeOf(request('/api/router/preview'), '/api/router/preview')).toEqual([])
    expect(writeScopeOf(request('/api/loops/scope-preview'), '/api/loops/scope-preview')).toEqual([])
  })

  it('不同请求互不串味', () => {
    const one = request('/api/change/a/transition')
    const two = request('/api/change/b/transition')
    noteBodyRoot(one, { root: '/repo/one' })
    expect(writeScopeOf(two, '/api/change/b/transition')).toBeUndefined()
    expect(writeScopeOf(one, '/api/change/a/transition')).toEqual(['/repo/one'])
  })
})
