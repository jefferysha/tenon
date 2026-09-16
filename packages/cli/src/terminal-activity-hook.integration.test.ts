/**
 * Real host-hook contract for normal-conversation liveness.  The key safety property is not just
 * that a heartbeat appears: it may appear only after the root skill explicitly binds the native
 * host session to an exact Change.  A repo-global recovery pointer must never be enough.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, REPO_ROOT, rm, type Harness } from './integration-harness.js'

const SESSION_ID = '019f92c7-6e66-7290-9352-f9d915266f14'

function runHook(script: string, payload: unknown, extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [join(REPO_ROOT, 'hooks', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...extraEnv },
  })
  if (result.error) throw result.error
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('真实 e2e —— terminal-activity host hook', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('router 将受控 host session id 交给 pipeline 根 skill，activate 后的工具生命周期才写当前 Change 心跳', async () => {
    expect(await h.run(['init', 'current', '--track', 'frontend', '--preset', 'full'])).toBe(0)
    const routed = runHook('router.sh', {
      prompt: '帮我实现一个响应式 React 页面', cwd: h.cwd, session_id: SESSION_ID,
    }, { TENON_ROUTER_CACHE: join(h.cwd, '.router-cache') })
    expect(routed.code).toBe(0)
    expect(routed.stdout).toContain(`host_session_id: ${SESSION_ID}`)

    expect(await h.run(['session', 'activate', 'current', '--host-session', SESSION_ID])).toBe(0)
    const activity = runHook('terminal-activity.sh', {
      cwd: h.cwd, tool_name: 'command_execution', session_id: SESSION_ID, turn_id: 'turn-current', command: 'tenon status current',
    })
    expect(activity.code, activity.stderr).toBe(0)
    const projection = JSON.parse(await readFile(join(h.cwd, 'openspec/changes/current/.pipeline-terminal-activity.json'), 'utf8')) as {
      protocol: string
      change: string
      session_id: string
      turn_id?: string
    }
    expect(projection).toMatchObject({
      protocol: 'pipeline-terminal-activity-v1', change: 'current', session_id: SESSION_ID, turn_id: 'turn-current',
    })
  })

  test('没有显式会话绑定时，即使当前用户有 active-change 旧指针也绝不把新会话记到旧 Change', async () => {
    expect(await h.run(['init', 'old-change', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', 'old-change'])).toBe(0)
    expect(await h.run(['init', 'new-change', '--track', 'frontend', '--preset', 'full'])).toBe(0)

    const activity = runHook('terminal-activity.sh', {
      cwd: h.cwd, tool_name: 'command_execution', session_id: SESSION_ID, turn_id: 'turn-unbound', command: 'pwd',
    })
    expect(activity.code, activity.stderr).toBe(0)
    await expect(readFile(join(h.cwd, 'openspec/changes/old-change/.pipeline-terminal-activity.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(h.cwd, 'openspec/changes/new-change/.pipeline-terminal-activity.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('同仓多会话恢复优先使用 host session 精确绑定，不受另一个会话覆盖 repo 指针影响', async () => {
    expect(await h.run(['init', 'frontend-docs', '--track', 'frontend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', 'frontend-docs', '--host-session', SESSION_ID])).toBe(0)
    expect(await h.run(['init', 'market-research', '--track', 'pm', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', 'market-research'])).toBe(0)

    const frontendDocsDir = join(h.cwd, 'openspec/changes/frontend-docs')
    const marketResearchDir = join(h.cwd, 'openspec/changes/market-research')
    await mkdir(frontendDocsDir, { recursive: true })
    await mkdir(marketResearchDir, { recursive: true })
    await writeFile(join(frontendDocsDir, '.breadcrumb'), 'FRONTEND_BREADCRUMB\n', 'utf8')
    await writeFile(join(marketResearchDir, '.breadcrumb'), 'RESEARCH_BREADCRUMB\n', 'utf8')

    const payload = { prompt: '继续执行', cwd: h.cwd, session_id: SESSION_ID }
    const routed = runHook('router.sh', payload, { TENON_ROUTER_CACHE: join(h.cwd, '.router-cache') })
    expect(routed.code, routed.stderr).toBe(0)
    expect(routed.stdout).toContain('intent: resume')
    expect(routed.stdout).toContain('change: frontend-docs')
    expect(routed.stdout).not.toContain('change: market-research')

    const breadcrumb = runHook('breadcrumb.sh', payload)
    expect(breadcrumb.code, breadcrumb.stderr).toBe(0)
    expect(breadcrumb.stdout).toContain('FRONTEND_BREADCRUMB')
    expect(breadcrumb.stdout).not.toContain('RESEARCH_BREADCRUMB')
  })
})
