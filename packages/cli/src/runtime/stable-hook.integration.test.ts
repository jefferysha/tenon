import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeStableLaunchers } from './launchers.js'
import { resolveRuntimePaths } from './paths.js'
import { RuntimeReleaseStore } from './release-store.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function freshRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `pipeline-stable-hook-${label}-`)))
  roots.push(root)
  return root
}

async function candidateCopy(root: string): Promise<string> {
  const candidate = join(root, 'candidate')
  const entries = [
    '.agents/plugins/marketplace.json',
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'adapters',
    'hooks',
    'packages/cli/dist/tenon.mjs',
    'packages/dashboard-app/dist',
    'packages/server/dist/dashboard.mjs',
    'runtime/tenon-bootstrap.mjs',
    'skills',
    'templates',
    'tools/verify-skills.sh',
  ]
  for (const entry of entries) await cp(join(repoRoot, entry), join(candidate, entry), { recursive: true, preserveTimestamps: false })
  return candidate
}

async function run(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => resolveResult({ code: 1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe('stable host-hook ABI', () => {
  it('keeps native PostToolUse evidence broad and adds a narrow Codex receipt bridge', async () => {
    const config = JSON.parse(await readFile(join(repoRoot, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string
          hooks: Array<{ command: string }>
        }>
        PostToolUse: Array<{
          matcher: string
          hooks: Array<{ command: string }>
        }>
      }
    }

    const evidenceGroup = config.hooks.PostToolUse.find((group) =>
      group.hooks.some((hook) => hook.command.includes('skill-tracker')),
    )

    expect(evidenceGroup).toBeDefined()
    // Native PostToolUse is still the fastest and most complete evidence path wherever the host
    // emits it. Keep its subscription broad; Codex's missing callback on one exec path is handled
    // by the separate, transcript-verified PreToolUse receipt rather than narrowing future hosts.
    expect(evidenceGroup?.matcher).toBe('*')
    expect(evidenceGroup?.hooks.map((hook) => hook.command)).toEqual([
      expect.stringContaining('skill-tracker'),
      expect.stringContaining('interactive-skill-gate'),
      expect.stringContaining('terminal-activity'),
      expect.stringContaining('test-nudge'),
    ])

    // Codex host versions have reported command work as `command_execution` and `exec`, unlike
    // Claude's `Bash` / `Edit` matcher names. Subscribe the lightweight gate to every pre-tool
    // event, then let gate.sh itself decide whether an active marker should block it.
    const gateGroup = config.hooks.PreToolUse.find((group) =>
      group.hooks.some((hook) => hook.command.includes(' gate')),
    )
    expect(gateGroup).toBeDefined()
    expect(gateGroup?.matcher).toBe('*')
    expect(gateGroup?.hooks.map((hook) => hook.command)).toEqual([
      expect.stringContaining(' gate'),
      expect.stringContaining('codex-skill-receipt'),
      expect.stringContaining('terminal-activity'),
    ])

    const humanDecisionGroup = config.hooks.PostToolUse.find((group) =>
      group.hooks.some((hook) => hook.command.includes(' confirm-clear')),
    )
    expect(humanDecisionGroup).toBeDefined()
    expect(humanDecisionGroup?.matcher).toBe('AskUserQuestion|request_user_input')
    expect(humanDecisionGroup?.hooks.map((hook) => hook.command)).toEqual([
      expect.stringContaining(' confirm-clear'),
      expect.stringContaining(' decision-recorder'),
    ])
  })

  it('routes a normal conversation through tenon-hook into the selected verified payload', async () => {
    const root = await freshRoot('router')
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: home, platform: 'linux' })
    const candidate = await candidateCopy(root)
    await new RuntimeReleaseStore({ paths }).stageAndActivate(candidate, 'codex')
    const launchers = await writeStableLaunchers(paths, home)
    const input = JSON.stringify({ prompt: '我现在想要调研一个新的工具项目', cwd: project })

    const result = await run('bash', [launchers.hook, 'router'], input, {
      ...process.env,
      HOME: home,
      TENON_ROUTER_CACHE: join(project, '.pipeline-router-cache'),
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('<tenon-dispatch>')
    expect(result.stdout).toContain('workflow: default')
    expect(result.stdout).toContain('intent: new')
    expect(result.stdout).toContain('phase: open')
  }, 30_000)

  it('records OpenSpec evidence only after a stable PreTool receipt is confirmed by a completed Codex transcript call', async () => {
    const root = await freshRoot('documents')
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: home, platform: 'linux' })
    const candidate = await candidateCopy(root)
    const pluginManifest = JSON.parse(
      await readFile(join(candidate, '.codex-plugin', 'plugin.json'), 'utf8'),
    ) as { version: string }
    const hostVersion = `${pluginManifest.version}-host-current`
    const hostCache = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', hostVersion)
    await cp(candidate, hostCache, { recursive: true, preserveTimestamps: false })
    await writeFile(
      join(hostCache, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify({ ...pluginManifest, version: hostVersion }, null, 2)}\n`,
      'utf8',
    )
    const activation = await new RuntimeReleaseStore({ paths }).stageAndActivate(candidate, 'codex')
    const launchers = await writeStableLaunchers(paths, home)
    // Codex does not promise PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT to a command hook. It does, however,
    // load the active plugin's assets from its standard per-user cache. Keep that cache distinct
    // from the verified runtime payload, deliberately omit those two generic roots, and pass the
    // exact host-selected Codex cache root that the stable bootstrap must preserve.
    const env = { ...process.env, HOME: home, TENON_CODEX_PLUGIN_ROOT: hostCache }
    delete env.PLUGIN_ROOT
    delete env.CLAUDE_PLUGIN_ROOT
    delete env.TENON_HOST_PLUGIN_ROOT
    const change = 'document-proof'
    const proposal = `openspec/changes/${change}/proposal.md`
    const design = `openspec/changes/${change}/design.md`
    const tasks = `openspec/changes/${change}/tasks.md`

    expect((await run('bash', [launchers.tenon, 'init', change, '--track', 'backend', '--preset', 'full'], '', env, project)).code).toBe(0)
    expect((await run('bash', [launchers.tenon, 'session', 'activate', change], '', env, project)).code).toBe(0)
    const beforeEvidence = await run(
      'bash', [launchers.tenon, 'document', 'record', change, 'proposal', proposal, '--producer', 'openspec-propose'], '', env, project,
    )
    expect(beforeEvidence.code).toBe(1)
    expect(beforeEvidence.stderr).toContain('current StepVisit lacks exact host confirmation')

    const skillPath = join(hostCache, 'skills', 'openspec-propose', 'SKILL.md')
    const transcript = join(home, '.codex', 'sessions', '2026', '07', '24', 'receipt.jsonl')
    const turnId = 'turn-receipt-1'
    // Current-visit evidence is intentionally fail-closed: real Codex response_item rows carry
    // top-level timestamps, and a timestamp-less historical row must not be reusable after init.
    const eventTimestamp = new Date().toISOString()
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: eventTimestamp,
        payload: { cwd: project, session_id: 'session-receipt-1', id: 'session-receipt-1' },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: eventTimestamp,
        payload: { turn_id: turnId },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: eventTimestamp,
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call-skill-read',
          name: 'exec',
          input: `const r = await tools.exec_command(${JSON.stringify({ cmd: `cat ${skillPath}` })}); text(r);`,
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: eventTimestamp,
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-skill-read',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: 'stable-hook-receipt',
                exit_code: 0,
                original_token_count: 0,
                output: await readFile(skillPath, 'utf8'),
                wall_time_seconds: 0.1,
              }),
            },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      }),
    ].join('\n') + '\n', 'utf8')
    const skillEvent = JSON.stringify({
      cwd: project,
      // 当前正常 Codex 对话把 tools.exec_command 上报为 `exec`，部分宿主版本把命令字段命名为
      // `cmd`。Receipt 必须在这条真实 ABI 上工作，并要求完整 literal cat；随后 document record
      // 仍要核对 transcript 中的 completed custom_tool_call + output 才会得到 CodexSkillRead history。
      tool_name: 'exec',
      tool_input: { cmd: `cat ${skillPath}` },
      transcript_path: transcript,
      session_id: 'session-receipt-1',
      turn_id: turnId,
      tool_use_id: 'call-skill-read',
    })
    expect((await run('bash', [launchers.hook, 'codex-skill-receipt'], skillEvent, env, project)).code).toBe(0)
    for (const [kind, path] of [['proposal', proposal], ['openspec-design', design], ['tasks', tasks]] as const) {
      const recorded = await run(
        'bash', [launchers.tenon, 'document', 'record', change, kind, path, '--producer', 'openspec-propose'], '', env, project,
      )
      expect(recorded.code, `${kind}: ${recorded.stderr}`).toBe(0)
    }
    const status = await run('bash', [launchers.tenon, 'document', 'status', change, '--json'], '', env, project)
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ governed: true, pass: true })

    // Preserve the original no-override compatibility path too: when the host has not selected a
    // newer cache, the bootstrap may derive the active payload's cache identity, but only after
    // that cache independently passes the same ordinary-layout and manifest checks.
    const derivedCache = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', pluginManifest.version)
    await cp(candidate, derivedCache, { recursive: true, preserveTimestamps: false })
    const derivedEnv = { ...env }
    delete derivedEnv.TENON_CODEX_PLUGIN_ROOT
    const derivedReceipt = await run(
      'bash',
      [
        launchers.tenon,
        'internal-codex-skill-receipt',
        'derived-cache-proof',
        'openspec-propose',
        join(derivedCache, 'skills', 'openspec-propose', 'SKILL.md'),
        join(home, '.codex', 'sessions', 'derived-receipt.jsonl'),
        'session-derived-proof',
        'turn-derived-proof',
        'call-derived-proof',
      ],
      '',
      derivedEnv,
      project,
    )
    expect(derivedReceipt.code).toBe(0)
    expect(derivedReceipt.stderr).toBe('')
  }, 30_000)

  it('rejects inherited Codex cache roots with version, manifest identity, or symlink drift', async () => {
    const root = await freshRoot('cache-rejection')
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const paths = resolveRuntimePaths({ env: { TENON_RUNTIME_HOME: join(root, 'runtime') }, homeDir: home, platform: 'linux' })
    const candidate = await candidateCopy(root)
    const pluginManifest = JSON.parse(
      await readFile(join(candidate, '.codex-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown> & { version: string }
    await new RuntimeReleaseStore({ paths }).stageAndActivate(candidate, 'codex')
    const launchers = await writeStableLaunchers(paths, home)
    const cacheBase = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon')

    const wrongVersion = join(cacheBase, `${pluginManifest.version}-folder-drift`)
    await cp(candidate, wrongVersion, { recursive: true, preserveTimestamps: false })

    const identityDrift = join(cacheBase, `${pluginManifest.version}-identity-drift`)
    await cp(candidate, identityDrift, { recursive: true, preserveTimestamps: false })
    await writeFile(
      join(identityDrift, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify({ ...pluginManifest, version: `${pluginManifest.version}-identity-drift` }, null, 2)}\n`,
      'utf8',
    )
    const driftedMarketplace = JSON.parse(
      await readFile(join(identityDrift, '.agents', 'plugins', 'marketplace.json'), 'utf8'),
    ) as Record<string, unknown>
    await writeFile(
      join(identityDrift, '.agents', 'plugins', 'marketplace.json'),
      `${JSON.stringify({ ...driftedMarketplace, name: 'other-marketplace' }, null, 2)}\n`,
      'utf8',
    )

    const symlinkVersion = `${pluginManifest.version}-symlink`
    const symlinkTarget = join(root, 'symlink-cache-target')
    const symlinkCache = join(cacheBase, symlinkVersion)
    await cp(candidate, symlinkTarget, { recursive: true, preserveTimestamps: false })
    await writeFile(
      join(symlinkTarget, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify({ ...pluginManifest, version: symlinkVersion }, null, 2)}\n`,
      'utf8',
    )
    await mkdir(dirname(symlinkCache), { recursive: true })
    await symlink(symlinkTarget, symlinkCache)

    for (const cacheRoot of [wrongVersion, identityDrift, symlinkCache]) {
      const result = await run(
        'bash',
        [
          launchers.tenon,
          'internal-codex-skill-receipt',
          'cache-proof',
          'openspec-propose',
          join(cacheRoot, 'skills', 'openspec-propose', 'SKILL.md'),
          join(home, '.codex', 'sessions', 'receipt.jsonl'),
          'session-cache-proof',
          'turn-cache-proof',
          'call-cache-proof',
        ],
        '',
        { ...process.env, HOME: home, TENON_CODEX_PLUGIN_ROOT: cacheRoot },
        project,
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('收到不可信的 Codex skill receipt')
    }
  }, 30_000)
})
