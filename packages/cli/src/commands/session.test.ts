/**
 * session 子命令 —— mock 层快速分支回归（TEST-REALITY.md：真实对位在 session.integration.test.ts）。
 * 覆盖 dispatch / activate（OK·degraded·缺状态·非法名）/ route-context（单仓·monorepo·空·--json·错误）。
 * fs 面（loadPackages/bindPointer）经注入 fake，避免真 fs——真 fs 面在 integration。
 */
import { describe, expect, test } from 'vitest'
import { makeDeps, mockState, spy } from '../test-support.js'
import { cmdSession, resumeOccurredAt, type SessionFs } from './session.js'
import type { PackageDecl } from '@tenon/kernel'

const MONO: PackageDecl[] = [
  { name: 'web', path: 'apps/web' },
  { name: 'api', path: 'services/api' },
]

function fakeFs(over: Partial<SessionFs> = {}): SessionFs & {
  bind: ReturnType<typeof spy<[string, string], Promise<void>>>
  grant: ReturnType<typeof spy<[string, string, string], Promise<void>>>
  bindTerminal: ReturnType<typeof spy<[string, string, string], Promise<void>>>
} {
  const bind = spy(async (_cwd: string, _name: string): Promise<void> => {})
  const grant = spy(async (_cwd: string, _name: string, _sessionId: string): Promise<void> => {})
  const bindTerminal = spy(async (_cwd: string, _name: string, _sessionId: string): Promise<void> => {})
  return {
    loadPackages: async () => null,
    bindPointer: bind,
    writeInteractionAuthority: grant,
    bindTerminalSession: bindTerminal,
    bind,
    grant,
    bindTerminal,
    ...over,
  }
}

describe('dispatch', () => {
  test('未知子命令 → stderr + exit 1', async () => {
    const deps = makeDeps()
    expect(await cmdSession(deps, 'bogus', [], fakeFs())).toBe(1)
    expect(deps.errLines.join('\n')).toContain('未知 session 子命令')
  })
})

describe('resume timing', () => {
  test('preserves a genuinely later activation clock', () => {
    expect(resumeOccurredAt('2026-08-10T00:00:05.000Z', '2026-08-10T00:00:00.000Z'))
      .toBe('2026-08-10T00:00:05.000Z')
  })

  test('raises a rollback/fixed clock to one millisecond after the effect', () => {
    expect(resumeOccurredAt('2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'))
      .toBe('2026-08-10T00:00:00.001Z')
    expect(resumeOccurredAt('not-a-time', '2026-08-10T00:00:00.000Z'))
      .toBe('not-a-time')
  })
})

describe('activate（老仓 cmd_activate state-session.sh:33-45）', () => {
  test('存在 change → 绑定指针、[OK] 走 stderr、无 stdout、exit 0', async () => {
    const deps = makeDeps({ state: mockState() })
    const fs = fakeFs()
    expect(await cmdSession(deps, 'activate', ['chg'], fs)).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(fs.bind.calls).toHaveLength(1)
    expect(fs.bind.calls[0]).toEqual(['/repo', 'tester-at-tenon.test', 'chg'])
    expect(deps.errLines.join('\n')).toContain('[OK] activate chg')
  })

  test('非法 change 名 → exit 1、不绑定', async () => {
    const deps = makeDeps()
    const fs = fakeFs()
    expect(await cmdSession(deps, 'activate', ['bad/../x'], fs)).toBe(1)
    expect(fs.bind.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain('非法字符')
  })

  test('空 change 名 → exit 1', async () => {
    const deps = makeDeps()
    expect(await cmdSession(deps, 'activate', [], fakeFs())).toBe(1)
    expect(deps.errLines.join('\n')).toContain('不能为空')
  })

  test('状态文件缺失（read 抛）→ exit 1、不绑定', async () => {
    const deps = makeDeps({ states: {} })
    const fs = fakeFs()
    expect(await cmdSession(deps, 'activate', ['chg'], fs)).toBe(1)
    expect(fs.bind.calls).toHaveLength(0)
    expect(deps.errLines.join('\n')).toContain('状态文件不存在')
  })

  test('指针写入失败 → degraded WARN、exit 0（degraded-safe，绝不 exit 1）', async () => {
    const deps = makeDeps({ state: mockState() })
    const fs = fakeFs({ bindPointer: async () => { throw new Error('EACCES') } })
    expect(await cmdSession(deps, 'activate', ['chg'], fs)).toBe(0)
    expect(deps.errLines.join('\n')).toContain('degraded')
  })

  test('activate --continuous 缺少 host session 时不生成可跨会话复用的授权', async () => {
    const deps = makeDeps({ state: mockState() })
    const fs = fakeFs()
    expect(await cmdSession(deps, 'activate', ['chg', '--continuous'], fs)).toBe(0)
    expect(fs.bind.calls).toEqual([['/repo', 'tester-at-tenon.test', 'chg']])
    expect(fs.grant.calls).toEqual([])
    expect(deps.errLines.join('\n')).toContain('缺少 --host-session')
  })

  test('activate --continuous --host-session → 授权与精确 host session 同时绑定', async () => {
    const deps = makeDeps({ state: mockState() })
    const fs = fakeFs()
    const sessionId = '019f92c7-6e66-7290-9352-f9d915266f14'
    expect(await cmdSession(
      deps,
      'activate',
      ['chg', '--continuous', '--host-session', sessionId],
      fs,
    )).toBe(0)
    expect(fs.bind.calls).toEqual([['/repo', 'tester-at-tenon.test', 'chg']])
    expect(fs.bindTerminal.calls).toEqual([['/repo', 'chg', sessionId]])
    expect(fs.grant.calls).toEqual([['/repo', 'tester-at-tenon.test', 'chg', sessionId, { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' }]])
  })

  test('activate --host-session 仅绑定精确 host session，不改 phase 或复用 repo 级指针推断', async () => {
    const deps = makeDeps({ state: mockState() })
    const fs = fakeFs()
    expect(await cmdSession(deps, 'activate', ['chg', '--host-session', '019f92c7-6e66-7290-9352-f9d915266f14'], fs)).toBe(0)
    expect(fs.bind.calls).toEqual([['/repo', 'tester-at-tenon.test', 'chg']])
    expect(fs.bindTerminal.calls).toEqual([['/repo', 'chg', '019f92c7-6e66-7290-9352-f9d915266f14']])
    expect(fs.grant.calls).toEqual([])
  })

  test('host session id 非法、缺值或重复 flag → 用法错误且不绑定', async () => {
    const cases = [
      ['chg', '--host-session'],
      ['chg', '--host-session', 'escape/../x'],
      ['chg', '--host-session', 'one', '--host-session', 'two'],
    ]
    for (const args of cases) {
      const deps = makeDeps({ state: mockState() })
      const fs = fakeFs()
      expect(await cmdSession(deps, 'activate', args, fs)).toBe(1)
      expect(fs.bind.calls).toEqual([])
      expect(fs.bindTerminal.calls).toEqual([])
    }
  })
})

describe('route-context（老仓 cmd_route_context state-session.sh:198-236）', () => {
  test('单仓（loadPackages=null）→ 全落未归属桶、header+分组走 stdout、exit 0', async () => {
    const deps = makeDeps({ state: mockState({ related_files: ['apps/web/a.ts', 'services/api/b.py'] }) })
    expect(await cmdSession(deps, 'route-context', ['chg'], fakeFs())).toBe(0)
    expect(deps.outLines).toEqual([
      '[ROUTE-CONTEXT] chg related_files 按 package 归属：',
      '  [(未归属)]',
      '    - apps/web/a.ts',
      '    - services/api/b.py',
    ])
  })

  test('--json 单仓 → {"null":[...]} 走 stdout', async () => {
    const deps = makeDeps({ state: mockState({ related_files: ['apps/web/a.ts', 'services/api/b.py'] }) })
    expect(await cmdSession(deps, 'route-context', ['chg', '--json'], fakeFs())).toBe(0)
    expect(JSON.parse(deps.outLines.join('\n'))).toEqual({ null: ['apps/web/a.ts', 'services/api/b.py'] })
  })

  test('空 related_files → header + 未配置提示', async () => {
    const deps = makeDeps({ state: mockState({ related_files: 'null' }) })
    expect(await cmdSession(deps, 'route-context', ['chg'], fakeFs())).toBe(0)
    expect(deps.outLines).toEqual([
      '[ROUTE-CONTEXT] chg related_files 按 package 归属：',
      '  (no related files / 未配置 package — 全未归属)',
    ])
  })

  test('空 related_files --json → {}', async () => {
    const deps = makeDeps({ state: mockState({ related_files: 'null' }) })
    expect(await cmdSession(deps, 'route-context', ['chg', '--json'], fakeFs())).toBe(0)
    expect(deps.outLines.join('\n')).toBe('{}')
  })

  test('monorepo（注入 loadPackages 声明）→ 按包分桶 + 未归属', async () => {
    const deps = makeDeps({
      state: mockState({ related_files: ['services/api/x.py', 'apps/web/a.ts', 'docs/z.md'] }),
    })
    const fs = fakeFs({ loadPackages: async () => MONO })
    expect(await cmdSession(deps, 'route-context', ['chg', '--json'], fs)).toBe(0)
    expect(JSON.parse(deps.outLines.join('\n'))).toEqual({
      api: ['services/api/x.py'],
      web: ['apps/web/a.ts'],
      null: ['docs/z.md'],
    })
  })

  test('非法 change 名 → exit 1', async () => {
    const deps = makeDeps()
    expect(await cmdSession(deps, 'route-context', ['bad/../x'], fakeFs())).toBe(1)
  })

  test('状态文件缺失 → exit 1', async () => {
    const deps = makeDeps({ states: {} })
    expect(await cmdSession(deps, 'route-context', ['chg'], fakeFs())).toBe(1)
    expect(deps.errLines.join('\n')).toContain('状态文件不存在')
  })
})
