/**
 * session activate / route-context —— 真实端到端集成测试（BACKLOG #17，GOAL C9：无伪测试）。
 *
 * 零 mock：freshHarness 真临时项目 + 真 `init`（走 buildProgram 真路径）+ 真 `set` 落 related_files +
 * realDeps 构造真 kernel deps（createStateStore）+ 真调 cmdSession（默认 REAL_FS：真读
 * .pipeline-project.yaml、真写当前用户的 .tenon/users/<slug>/local/active-change）。断言真实副作用：
 * activate 按声明身份真落盘指针文件；route-context 真读盘 related_files + 真解析 packages 声明 + 真路由输出。
 *
 * 覆盖（C10）：activate happy（真落盘）+ 两个用户互不覆盖 + 退役指针清理 + 身份缺失 + 缺 change（exit 1）
 *   + degraded（写失败不炸）；route-context 单仓（全未归属）+ monorepo（真 .pipeline-project.yaml 路由）+ 空集 + --json + 缺 change。
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, realDeps, rm, type Harness } from './integration-harness.js'
import { cmdSession, type SessionFs } from './commands/session.js'

interface Run {
  code: number
  out: string[]
  err: string[]
}

/** 真调 cmdSession（realDeps 真 kernel + 真 fs；默认 REAL_FS 走真 loadPackages/bindPointer）；`env` 切换声明身份。 */
async function session(h: Harness, sub: string, args: string[], fs?: SessionFs, env?: Record<string, string>): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await cmdSession(realDeps(h.cwd, out, err, env === undefined ? process.env : { ...process.env, ...env }), sub, args, fs)
  return { code, out, err }
}

function userLocal(h: Harness, slug = 'tester-at-tenon.test'): string {
  return join(h.cwd, '.tenon', 'users', slug, 'local')
}

async function init(h: Harness, name: string): Promise<void> {
  expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('真实 e2e —— session activate（当前用户的 active-change 真落盘）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
    await init(h, 'feat')
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('activate 存在 change → 真写 .tenon/users/<slug>/local/active-change、[OK] 走 stderr、无 stdout、exit 0', async () => {
    const r = await session(h, 'activate', ['feat'])
    expect(r.code).toBe(0)
    expect(r.out).toEqual([])
    expect(r.err.join('\n')).toContain('[OK] activate feat')
    expect(await readFile(join(userLocal(h), 'active-change'), 'utf8')).toBe('feat\n')
    expect(await readFile(join(h.cwd, '.tenon', '.gitignore'), 'utf8')).toBe('users/*/local/\n')
  })

  test('两个用户各自激活，指针互不覆盖', async () => {
    await init(h, 'other')
    expect((await session(h, 'activate', ['feat'])).code).toBe(0)
    expect((await session(h, 'activate', ['other'], undefined, { TENON_USER: 'b@x.io' })).code).toBe(0)
    expect(await readFile(join(userLocal(h), 'active-change'), 'utf8')).toBe('feat\n')
    expect(await readFile(join(userLocal(h, 'b-at-x.io'), 'active-change'), 'utf8')).toBe('other\n')
  })

  test('activate 删除退役的仓库级指针与授权文件', async () => {
    await writeFile(join(h.cwd, '.pipeline-active'), 'feat\n', 'utf8')
    await writeFile(join(h.cwd, '.pipeline-interaction-authority'), 'stale\n', 'utf8')
    expect((await session(h, 'activate', ['feat'])).code).toBe(0)
    expect(await exists(join(h.cwd, '.pipeline-active'))).toBe(false)
    expect(await exists(join(h.cwd, '.pipeline-interaction-authority'))).toBe(false)
  })

  test('身份缺失 → exit 1 + 设置提示，不落任何用户目录', async () => {
    const r = await session(h, 'activate', ['feat'], undefined, { TENON_USER: 'not-an-email' })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('ERROR: 未设置用户身份')
    expect(await exists(join(h.cwd, '.tenon'))).toBe(false)
  })

  test('activate 缺 change → exit 1、未落指针（ensure_state_exists 硬门）', async () => {
    const r = await session(h, 'activate', ['ghost'])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('状态文件不存在')
    expect(await exists(join(userLocal(h), 'active-change'))).toBe(false)
  })

  test('activate 指针写失败 → degraded、exit 0（degraded-safe，绝不炸）', async () => {
    const degraded: SessionFs = {
      loadPackages: async () => null,
      bindPointer: async () => {
        throw new Error('EACCES: simulated pointer store failure')
      },
    }
    const r = await session(h, 'activate', ['feat'], degraded)
    expect(r.code).toBe(0)
    expect(r.err.join('\n')).toContain('degraded')
    expect(await exists(join(userLocal(h), 'active-change'))).toBe(false)
  })

  test('activate --continuous → 原子写 Change 绑定授权并留下隐私最小化审计行', async () => {
    const sessionId = '019f92c7-6e66-7290-9352-f9d915266f14'
    const r = await session(h, 'activate', ['feat', '--continuous', '--host-session', sessionId])
    expect(r.code).toBe(0)
    expect(r.err.join('\n')).toContain('持续交互授权')
    const authority = await readFile(join(userLocal(h), 'authority'), 'utf8')
    expect(authority).toContain('pipeline-interaction-authority-v2')
    expect(authority).toContain('change=feat')
    expect(authority).toContain(`host_session=${sessionId}`)
    expect(authority).toContain('scope=interactive-skills')
    expect(authority).toContain('review=delegated')
    const history = await readFile(join(h.cwd, 'openspec/changes/feat/.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('interaction-authority:enabled')
    expect(history).toContain('"actor":{"id":"tester@tenon.test","name":"Tester","trust":"declared"}')
    expect(history).toContain('review=delegated')
    expect(history).toContain(`host_session=${sessionId}`)
  })

  test('activate --host-session → 真写会话到 Change 的非 canonical 绑定，供 host hook 精确投影运行心跳', async () => {
    const sessionId = '019f92c7-6e66-7290-9352-f9d915266f14'
    const r = await session(h, 'activate', ['feat', '--host-session', sessionId])
    expect(r.code).toBe(0)
    const binding = JSON.parse(await readFile(join(h.cwd, '.pipeline', 'terminal-sessions', `${sessionId}.json`), 'utf8')) as {
      protocol: string
      session_id: string
      change: string
    }
    expect(binding).toMatchObject({ protocol: 'pipeline-terminal-session-v1', session_id: sessionId, change: 'feat' })
  })
})

describe('真实 e2e —— session route-context 单仓（无 .pipeline-project.yaml → 全未归属）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
    await init(h, 'feat')
    // 真写 related_files（走真 set 命令，CSV → 块序列列表落盘）
    expect(await h.run(['set', 'feat', 'related_files', 'apps/web/a.ts,services/api/b.py'])).toBe(0)
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('route-context 单仓 → header + [(未归属)] 分组（真读盘 related_files）', async () => {
    const r = await session(h, 'route-context', ['feat'])
    expect(r.code).toBe(0)
    expect(r.out).toEqual([
      '[ROUTE-CONTEXT] feat related_files 按 package 归属：',
      '  [(未归属)]',
      '    - apps/web/a.ts',
      '    - services/api/b.py',
    ])
  })

  test('route-context --json 单仓 → {"null":[...]}（真读盘）', async () => {
    const r = await session(h, 'route-context', ['feat', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out.join('\n'))).toEqual({ null: ['apps/web/a.ts', 'services/api/b.py'] })
  })
})

describe('真实 e2e —— session route-context monorepo（真 .pipeline-project.yaml 路由）', () => {
  let h: Harness
  const MONO_CFG =
    'packages:\n' +
    '  web:\n' +
    '    path: apps/web\n' +
    '  api:\n' +
    '    path: services/api\n' +
    '  webadmin:\n' +
    '    path: apps/web/admin\n' +
    'default_package: web\n'
  beforeEach(async () => {
    h = await freshHarness()
    await init(h, 'feat')
    // 真写项目根 .pipeline-project.yaml packages 声明（REAL_FS.loadPackages 真读真解析）
    await writeFile(join(h.cwd, '.pipeline-project.yaml'), MONO_CFG, 'utf8')
    expect(
      await h.run([
        'set',
        'feat',
        'related_files',
        'apps/web/src/App.tsx,services/api/main.py,apps/web/admin/panel.tsx,docs/readme.md',
      ]),
    ).toBe(0)
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('route-context --json → 按声明 path 最长前缀真路由 + 未归属 null 桶', async () => {
    const r = await session(h, 'route-context', ['feat', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out.join('\n'))).toEqual({
      web: ['apps/web/src/App.tsx'],
      api: ['services/api/main.py'],
      webadmin: ['apps/web/admin/panel.tsx'], // 最长前缀最具体子树赢（非 web）
      null: ['docs/readme.md'],
    })
  })

  test('route-context 文本 → null 桶排最后 + 其余字典序 header 分组', async () => {
    const r = await session(h, 'route-context', ['feat'])
    expect(r.code).toBe(0)
    expect(r.out).toEqual([
      '[ROUTE-CONTEXT] feat related_files 按 package 归属：',
      '  [api]',
      '    - services/api/main.py',
      '  [web]',
      '    - apps/web/src/App.tsx',
      '  [webadmin]',
      '    - apps/web/admin/panel.tsx',
      '  [(未归属)]',
      '    - docs/readme.md',
    ])
  })
})

describe('真实 e2e —— session route-context 空集 / 错误路径', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
    await init(h, 'feat')
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('空 related_files → header + 未配置提示', async () => {
    const r = await session(h, 'route-context', ['feat'])
    expect(r.code).toBe(0)
    expect(r.out).toEqual([
      '[ROUTE-CONTEXT] feat related_files 按 package 归属：',
      '  (no related files / 未配置 package — 全未归属)',
    ])
  })

  test('缺 change → exit 1', async () => {
    const r = await session(h, 'route-context', ['ghost'])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('状态文件不存在')
  })
})
