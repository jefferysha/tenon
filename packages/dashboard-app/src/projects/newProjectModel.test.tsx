import { describe, expect, it } from 'vitest'
import { applyEvent } from './useProjectCreateRun'
import { FOLDER_NAME, filesForClients, instructionsInput, joinPath, projectInput, splitClients, stepLabelKey } from './newProjectModel'

describe('newProjectModel', () => {
  it('splitClients：检测到的在主列表；检测为空或未知时回落 Claude Code + Codex', () => {
    expect(splitClients(['codex']).primary.map((client) => client.id)).toEqual(['codex'])
    expect(splitClients([]).primary.map((client) => client.id)).toEqual(['claude', 'codex'])
    expect(splitClients(['nope']).more.some((client) => client.id === 'claude')).toBe(false)
  })

  it('filesForClients：正文只进 AGENTS.md，CLAUDE.md / GEMINI.md 是引用；什么都没选 = 只登记', () => {
    expect(filesForClients(new Set(['cursor', 'codex', 'claude']))).toEqual({ targets: ['AGENTS.md', 'CLAUDE.md'], references: ['CLAUDE.md'] })
    expect(filesForClients(new Set(['gemini']), false)).toEqual({ targets: ['AGENTS.md', 'GEMINI.md'], references: ['GEMINI.md'] })
    expect(filesForClients(new Set(), true)).toEqual({ targets: ['AGENTS.md'], references: [] })
    expect(filesForClients(new Set(), false)).toEqual({ targets: [], references: [] })
  })

  it('instructionsInput：预检保留跳过的文件，执行去掉；缺省追加', () => {
    const files = { targets: ['AGENTS.md', 'CLAUDE.md'], references: ['CLAUDE.md'] }
    expect(instructionsInput(files, '# x\n', { 'AGENTS.md': 'skip' }, false)).toMatchObject({ targets: ['AGENTS.md', 'CLAUDE.md'], append: ['CLAUDE.md'] })
    expect(instructionsInput(files, '# x\n', { 'AGENTS.md': 'skip' }, true)).toMatchObject({ targets: ['CLAUDE.md'], references: ['CLAUDE.md'] })
    expect(instructionsInput(files, '# x\n', { 'AGENTS.md': 'skip', 'CLAUDE.md': 'skip' }, true)).toBeNull()
    expect(instructionsInput(files, '# x\n', { 'AGENTS.md': 'replace' }, true)).toMatchObject({ append: ['CLAUDE.md'] })
  })

  it('projectInput：已有目录只在开启时带 git_init', () => {
    const location = { mode: 'existing' as const, path: '/a', parent: '', name: '', gitInit: false }
    expect(projectInput(location, [], null)).toEqual({ mode: 'existing', path: '/a', instructions: null })
    expect(projectInput({ ...location, gitInit: true }, [], null, ['codex'])).toEqual({ mode: 'existing', path: '/a', instructions: null, git_init: true, clients: ['codex'] })
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
