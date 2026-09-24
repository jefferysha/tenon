import { describe, expect, it } from 'vitest'
import { applyEvent } from './useProjectCreateRun'
import { FOLDER_NAME, filesForClients, joinPath, splitClients, stepLabelKey } from './newProjectModel'

describe('newProjectModel', () => {
  it('splitClients：检测到的在主列表；检测为空或未知时回落 Claude Code + Codex', () => {
    expect(splitClients(['codex']).primary.map((client) => client.id)).toEqual(['codex'])
    expect(splitClients([]).primary.map((client) => client.id)).toEqual(['claude', 'codex'])
    expect(splitClients(['nope']).more.some((client) => client.id === 'claude')).toBe(false)
  })

  it('filesForClients：按协议文件顺序去重', () => {
    expect(filesForClients(new Set(['cursor', 'codex', 'claude']))).toEqual(['CLAUDE.md', 'AGENTS.md'])
    expect(filesForClients(new Set())).toEqual([])
  })

  it('joinPath / FOLDER_NAME / stepLabelKey', () => {
    expect(joinPath('/code', 'shop')).toBe('/code/shop')
    expect(joinPath('/', 'shop')).toBe('/shop')
    expect(joinPath('C:\\code', 'shop')).toBe('C:\\code\\shop')
    expect(FOLDER_NAME.test('shop-1.x')).toBe(true)
    expect(FOLDER_NAME.test('.hidden')).toBe(false)
    expect(stepLabelKey('file:AGENTS.md')).toEqual({ key: 'projects.action_file', vars: { file: 'AGENTS.md' } })
    expect(stepLabelKey('git')).toEqual({ key: 'projects.action_git' })
  })

  it('applyEvent：plan 建行，step 更新对应行', () => {
    const rows = applyEvent([], { type: 'plan', steps: ['git', 'register'] })
    const failed = applyEvent(applyEvent(rows, { type: 'step', id: 'git', state: 'running' }), { type: 'step', id: 'git', state: 'failed', error: 'boom' })
    expect(failed).toEqual([{ id: 'git', state: 'failed', error: 'boom' }, { id: 'register', state: 'pending' }])
  })
})
