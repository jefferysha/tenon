/**
 * Real host-hook contract for normal-conversation liveness.  The key safety property is not just
 * that a heartbeat appears: it may appear only after the root skill explicitly binds the native
 * host session to an exact Change.  A repo-global recovery pointer must never be enough.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WORKFLOW_STATE_GITIGNORE } from '@tenon/kernel'
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

  test('.pipeline 的本地运行态由嵌套 .gitignore 忽略：router 冷生成与 session activate 都会补上', async () => {
    const ignore = join(h.cwd, '.pipeline', '.gitignore')
    // Router cold generation writes the default cache (no TENON_ROUTER_CACHE override).
    const routed = runHook('router.sh', { prompt: '帮我实现一个响应式 React 页面', cwd: h.cwd, session_id: SESSION_ID })
    expect(routed.code, routed.stderr).toBe(0)
    expect(await readFile(ignore, 'utf8')).toBe(WORKFLOW_STATE_GITIGNORE)

    await rm(ignore)
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo', '--host-session', SESSION_ID])).toBe(0)
    expect(await readFile(ignore, 'utf8')).toBe(WORKFLOW_STATE_GITIGNORE)

    // git itself agrees: local state is ignored, shared configuration and the ignore file are not.
    spawnSync('git', ['init', '-q'], { cwd: h.cwd })
    await writeFile(join(h.cwd, '.pipeline', 'tracks.yaml'), 'tracks: {}\n', 'utf8')
    const checked = spawnSync('git', ['check-ignore', '--no-index', '-v', '--stdin'], {
      cwd: h.cwd,
      input: [
        `.pipeline/terminal-sessions/${SESSION_ID}.json`, '.pipeline/cache/router.v5.data',
        '.pipeline/codex-skill-receipts.jsonl', '.tenon/users/someone-at-x.io/local/active-change',
        '.pipeline/tracks.yaml', '.pipeline/.gitignore', '.tenon/.gitignore',
      ].join('\n'),
      encoding: 'utf8',
    })
    const ignored = checked.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')[1])
    expect(ignored).toEqual([
      `.pipeline/terminal-sessions/${SESSION_ID}.json`, '.pipeline/cache/router.v5.data',
      '.pipeline/codex-skill-receipts.jsonl', '.tenon/users/someone-at-x.io/local/active-change',
    ])
  })

  test('router 的激活指引带上本会话 host session id', async () => {
    const routed = runHook('router.sh', {
      prompt: '帮我实现一个响应式 React 页面', cwd: h.cwd, session_id: SESSION_ID,
    }, { TENON_ROUTER_CACHE: join(h.cwd, '.router-cache') })
    expect(routed.code, routed.stderr).toBe(0)
    expect(routed.stdout).toContain(`tenon session activate <change> --host-session ${SESSION_ID}`)
  })

  test('「确认继续」回应本用户已请求的评审时是续轮，即使会话从未绑定', async () => {
    // v0.1.1 acceptance: the entry skill activated without --host-session, so the second turn's
    // 「确认继续」 was routed as an independent new task.
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    expect(await h.run(['check', 'demo'])).toBe(0)
    const env = { TENON_ROUTER_CACHE: join(h.cwd, '.router-cache') }
    const confirm = { prompt: '确认继续，按你的推荐实现响应式 React 页面', cwd: h.cwd, session_id: SESSION_ID }

    // No review requested: an unbound conversation is not resumed through the repo pointer.
    const before = runHook('router.sh', confirm, env)
    expect(before.code, before.stderr).toBe(0)
    expect(before.stdout).toContain('intent: new')

    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    const pending = runHook('router.sh', confirm, env)
    expect(pending.code, pending.stderr).toBe(0)
    expect(pending.stdout).toContain('intent: resume')
    expect(pending.stdout).toContain('change: demo')
    expect(pending.stdout).not.toContain('独立新任务')

    // confirm-clear-prompt may acknowledge (and drop the marker) before the router reads it; the
    // acknowledged receipt still marks the same continuation.
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    const acknowledged = runHook('router.sh', confirm, env)
    expect(acknowledged.stdout).toContain('intent: resume')
    expect(acknowledged.stdout).toContain('change: demo')

    // A request for new work is never folded into the pending review.
    const fresh = runHook('router.sh', { ...confirm, prompt: '确认继续，新建一个任务实现响应式 React 页面' }, env)
    expect(fresh.stdout).toContain('intent: new')
  })
})
