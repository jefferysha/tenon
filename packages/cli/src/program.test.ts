import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createLoopsYamlText, type FieldName, type GuardResult, type PipelineState } from '@tenon/kernel'
import { buildProgram, CliExit } from './program.js'
import type { TriageCommandRuntime } from './commands/triage.js'
import { makeDeps, mockState, spy, type TestDeps } from './test-support.js'

async function run(deps: TestDeps, args: string[]): Promise<number> {
  try {
    await buildProgram(deps).parseAsync(args, { from: 'user' })
    return 0
  } catch (e) {
    if (e instanceof CliExit) return e.code
    throw e
  }
}

describe('program —— commander 装配与 exit code 逐格对齐', () => {
  test('setup 命令声明显式单宿主安装，而不是过时的无参数安装', () => {
    const deps = makeDeps()
    const setup = buildProgram(deps).commands.find((command) => command.name() === 'setup')
    expect(setup?.description()).toContain('--codex')
    expect(setup?.options.some((option) => option.long === '--claude')).toBe(true)
  })

  test('update --codex --dry-run 保留宿主选择并只打印原生更新计划', async () => {
    const deps = makeDeps()
    expect(await run(deps, ['update', '--codex', '--dry-run'])).toBe(0)
    const out = deps.outLines.join('\n')
    expect(out).toContain('codex plugin marketplace add jefferysha/tenon --ref <latest-stable> --json')
    expect(out).not.toContain('--ref main')
    expect(out).toContain('未刷新 marketplace')
  })

  test('host-target-plan help 明示只读 catalog 与单目标 JSON 计划参数', async () => {
    const deps = makeDeps()
    const program = buildProgram(deps)
    const command = program.commands.find((candidate) => candidate.name() === 'host-target-plan')

    expect(command?.description()).toContain('只读')
    expect(command?.options.map(({ long }) => long)).toEqual(
      expect.arrayContaining(['--host', '--operation', '--json']),
    )
    await expect(
      program.parseAsync(['host-target-plan', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' })
    expect(deps.outLines.join('\n')).toContain('--operation <operation>')
  })

  test('host-target-plan 通过 Commander 输出白名单单目标计划', async () => {
    const deps = makeDeps()

    expect(await run(deps, [
      'host-target-plan',
      '--host',
      'codex',
      '--operation',
      'setup',
      '--json',
    ])).toBe(0)
    expect(JSON.parse(deps.outLines[0]!)).toMatchObject({
      schema_version: 'host-target-plan/v1',
      side_effects: 'none',
      host: { id: 'codex', kind: 'native' },
      operation: 'setup',
      command: { display: 'tenon setup --codex' },
    })
  })

  test.each([
    {
      name: '重复 --host',
      flag: '--host',
      args: ['--host', 'claude', '--host', 'codex', '--operation', 'setup'],
    },
    {
      name: '非法首值不能被后续合法 --host 洗白',
      flag: '--host',
      args: ['--host', '.foo', '--host', 'codex', '--operation', 'setup'],
    },
    {
      name: '重复 --operation',
      flag: '--operation',
      args: ['--host', 'codex', '--operation', 'update', '--operation', 'setup'],
    },
    {
      name: '非法首值不能被后续合法 --operation 洗白',
      flag: '--operation',
      args: ['--host', 'codex', '--operation', 'remove', '--operation', 'setup'],
    },
  ])('host-target-plan 在 action 前拒绝 $name', async ({ args, flag }) => {
    const deps = makeDeps()

    await expect(
      buildProgram(deps).parseAsync(['host-target-plan', ...args, '--json'], { from: 'user' }),
    ).rejects.toMatchObject({
      code: 'commander.invalidArgument',
      exitCode: 1,
    })
    expect(deps.errLines.join('\n')).toContain(`不得重复指定 ${flag}`)
    expect(deps.outLines).toEqual([])
    expect(deps.store.write.calls).toHaveLength(0)
    expect(deps.store.set.calls).toHaveLength(0)
    expect(deps.store.setMany.calls).toHaveLength(0)
    expect(deps.store.cas.calls).toHaveLength(0)
  })

  test('完整插件只有一个 update 入口，不再暴露第二套 --self-update', () => {
    const deps = makeDeps()
    const update = buildProgram(deps).commands.find((command) => command.name() === 'update')
    expect(update?.options.some((option) => option.long === '--self-update')).toBe(false)
  })

  test('runtime 是稳定启动器的可诊断和精确恢复入口', () => {
    const deps = makeDeps()
    const runtime = buildProgram(deps).commands.find((command) => command.name() === 'runtime')
    expect(runtime?.description()).toContain('managed runtime')
    expect(runtime?.options.some((option) => option.long === '--rollback')).toBe(true)
    expect(runtime?.options.some((option) => option.long === '--json')).toBe(true)
  })

  test('dashboard 是完整插件的一等入口，声明单端口与显式兼容端口参数', () => {
    const deps = makeDeps()
    const dashboard = buildProgram(deps).commands.find((command) => command.name() === 'dashboard')
    expect(dashboard?.description()).toContain('18765')
    expect(dashboard?.options.some((option) => option.long === '--port')).toBe(true)
    expect(dashboard?.options.some((option) => option.long === '--dry-run')).toBe(true)
  })

  test('workflow plan 是在途 Change 的冻结编排读取入口', () => {
    const deps = makeDeps()
    const workflow = buildProgram(deps).commands.find((command) => command.name() === 'workflow')
    expect(workflow?.description()).toContain('冻结快照')
    expect(workflow?.commands.find((command) => command.name() === 'plan')).toBeDefined()
  })

  test('handoff --budget-bytes 严格拒绝小数、尾随字符和超出安全整数的值', async () => {
    for (const value of ['1.5', '12bytes', '0', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const deps = makeDeps()
      await expect(buildProgram(deps).parseAsync(
        ['handoff', 'demo', '--bundle', '--budget-bytes', value],
        { from: 'user' },
      )).rejects.toThrow(/budget-bytes 必须是正安全整数/)
    }
  })

  test('get 走通：stdout 裸值，code 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'build' }) })
    const code = await run(deps, ['get', 'demo', 'phase'])
    expect(code).toBe(0)
    expect(deps.outLines).toEqual(['build'])
  })

  test('get 未知字段：空行 + code 0（oracle 实测回写）', async () => {
    const deps = makeDeps()
    expect(await run(deps, ['get', 'demo', 'nope'])).toBe(0)
    expect(deps.outLines).toEqual([''])
  })

  test('set 走通：code 0，无 stdout', async () => {
    const deps = makeDeps()
    const code = await run(deps, ['set', 'demo', 'plan', 'docs/p.md'])
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    // P6：plan 在默认空 phase 非有效 artifact → 放行；锁内 write（不走 store.set）
    expect(deps.store.write.calls).toHaveLength(1)
  })

  test('set-many 变长参数路由', async () => {
    const deps = makeDeps()
    const code = await run(deps, ['set-many', 'demo', 'build_mode=direct', 'isolation=branch'])
    expect(code).toBe(0)
    const w = deps.store.write.calls[0]?.[1].fields
    expect(w?.build_mode).toBe('direct')
    expect(w?.isolation).toBe('branch')
  })

  test('cas 不匹配：code 3', async () => {
    const deps = makeDeps()
    deps.store.cas = spy(async (_d: string, _f: FieldName, _e: string, _n: string) => false)
    expect(await run(deps, ['cas', 'demo', 'automation', 'queued', 'scheduled'])).toBe(3)
  })

  test('transition 非法：code 1（oracle 实测回写）', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    expect(await run(deps, ['transition', 'demo', 'verify-pass'])).toBe(1)
  })

  test('transition 合法：stdout 空、[TRANSITION] 走 stderr，code 0', async () => {
    const deps = makeDeps({ state: mockState({ phase: 'open' }) })
    expect(await run(deps, ['transition', 'demo', 'open-complete'])).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toContain('[TRANSITION] demo: open -> explore')
  })

  test('check 不过：code 2', async () => {
    // R4：default check 先从 effective track registry 解析 coverage policy；给出合法 track，
    // 让本用例继续只验证 guard failure → exit 2，而不是误测 orphan track 配置错 → exit 1。
    const deps = makeDeps({ state: mockState({ phase: 'spec', track: 'backend' }) })
    deps.flow.guardCheck = spy((_s: PipelineState): GuardResult => ({ pass: false, failures: ['x'] }))
    expect(await run(deps, ['check', 'demo'])).toBe(2)
  })

  test('init 缺 --track（非交互）：fail-loud exit 1（向导引入后 track/preset 改 option）', async () => {
    // 交互向导（BT6）落地后 --track/--preset 由 requiredOption 改 option：commander 不再抢在
    // action 前抛 missingMandatoryOptionValue；非 TTY（agent/CI，含 vitest）缺参由 cmdInit 接管
    // fail-loud（exit 1 + 明确 err），脚本可依赖的 exit 1 契约不变；TTY 下则走交互向导。
    const deps = makeDeps()
    const code = await run(deps, ['init', 'demo', '--preset', 'full'])
    expect(code).toBe(1)
    expect(deps.errLines.join('\n')).toContain('非交互模式缺少必填项')
  })

  test('init 全参：stdout 空、[INIT] 走 stderr', async () => {
    const deps = makeDeps()
    const code = await run(deps, ['init', 'demo', '--track', 'backend', '--preset', 'full'])
    expect(code).toBe(0)
    expect(deps.outLines).toEqual([])
    expect(deps.errLines).toContain('[INIT] /repo/openspec/changes/demo')
  })

  test('status --json 路由', async () => {
    const deps = makeDeps({ states: { 'demo-a': mockState({ track: 'backend', phase: 'build' }) } })
    expect(await run(deps, ['status', '--json'])).toBe(0)
    expect(deps.outLines[0]).toContain('"active_changes"')
  })

  test('status <name> 路由', async () => {
    const deps = makeDeps({ states: { 'demo-a': mockState({ track: 'backend', phase: 'build' }) } })
    expect(await run(deps, ['status', 'demo-a'])).toBe(0)
    expect(deps.outLines[0]).toContain('demo-a')
  })

  test('list --json 路由', async () => {
    const deps = makeDeps({ changes: [] })
    expect(await run(deps, ['list', '--json'])).toBe(0)
    expect(deps.outLines).toEqual(['{"changes":[]}'])
  })

  test('未知子命令：commander 报错', async () => {
    const deps = makeDeps()
    await expect(
      buildProgram(deps).parseAsync(['frobnicate'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.unknownCommand' })
  })

  test('loops --help 与真实 init 默认一致：runner 缺省 codex', async () => {
    const deps = makeDeps()
    await expect(
      buildProgram(deps).parseAsync(['loops', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' })
    const help = deps.outLines.join('\n')
    expect(help).toContain('--runner <claude-code|codex>')
    expect(help).toContain('缺省 codex')
    expect(help).not.toContain('缺省 claude-code')
  })

  test('H11 loops --help 可发现七个 v1 starter 与显式 workflow/skill binding flags', async () => {
    const deps = makeDeps()
    await expect(
      buildProgram(deps).parseAsync(['loops', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' })

    const help = deps.outLines.join('\n')
    expect(help).toContain('--template <id>')
    expect(help).toContain('--workflow <id>')
    expect(help).toContain('--skill-bundle <profile>')
    for (const id of [
      'pr-babysitter', 'daily-triage', 'ci-sweeper', 'post-merge-cleanup',
      'dependency-sweeper', 'changelog-drafter', 'issue-triage',
    ]) expect(help).toContain(id)
  })

  test('H13 loops --help 可发现 sync 的显式 dry-run/apply 与双 SHA 前置条件', async () => {
    const deps = makeDeps()
    await expect(
      buildProgram(deps).parseAsync(['loops', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' })

    const help = deps.outLines.join('\n')
    expect(help).toContain('sync <loop-id>')
    expect(help).toContain('--dry-run')
    expect(help).toContain('--apply')
    expect(help).toContain('--expected-registry-sha')
    expect(help).toContain('--expected-workflow-sha')
    expect(help).toContain('必须显式二选一')
  })

  test('H13 commander 保留 sync 参数并路由到真实 reconciliation dry-run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-program-loop-sync-'))
    try {
      await mkdir(join(root, '.pipeline'), { recursive: true })
      const created = createLoopsYamlText({
        id: 'sync-loop', name: 'Sync loop', kind: 'orchestrator', goal: 'Keep loop documents synchronized.',
        cadence: '1h', risk: 'low', runner: 'codex', change_prefix: 'sync-loop-',
        phases: ['decide', 'record'], human_gates: ['destructive changes'], state: 'docs/loops/progress.md',
        design_doc: 'LOOP.md', status: 'paused',
        budget: { max_runs_per_day: 4, max_in_flight: 1, on_exceed: 'pause' },
        kill_criteria: ['goal reached'],
      })
      expect(created.error).toBeNull()
      expect(created.text).not.toBeNull()
      await writeFile(join(root, '.pipeline', 'loops.yaml'), created.text!, 'utf8')
      await writeFile(join(root, 'LOOP.md'), '# Human notes\n', 'utf8')
      const before = await readFile(join(root, 'LOOP.md'), 'utf8')
      const deps = makeDeps({ cwd: root })

      const code = await run(deps, ['loops', 'sync', 'sync-loop', '--dry-run', '--json'])

      expect(code).toBe(0)
      expect(deps.errLines).toEqual([])
      expect(JSON.parse(deps.outLines[0]!)).toMatchObject({
        command: 'loop-sync',
        mode: 'dry-run',
        status: 'planned',
      })
      expect(await readFile(join(root, 'LOOP.md'), 'utf8')).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('H12 triage --help 可发现生产 source、Codex 默认与有界恢复参数', async () => {
    const deps = makeDeps()
    await expect(
      buildProgram(deps).parseAsync(['triage', '--help'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.helpDisplayed' })

    const help = deps.outLines.join('\n')
    expect(help).toContain('git-commits')
    expect(help).toContain('loop-run-terminals')
    expect(help).toContain('--provider <provider>')
    expect(help).toContain('默认 codex')
    expect(help).toContain('--page-size <n>')
    expect(help).toContain('--max-pages <n>')
    expect(help).toContain('--max-high-candidates <n>')
  })

  test('H12 commander 原样保留 triage source/options 并路由到注入 runtime', async () => {
    const deps = makeDeps()
    const runtime = {
      run: spy(async () => ({
        pagesProcessed: 1,
        observationsProcessed: 0,
        materializations: [],
        checkpoint: {
          schemaVersion: 1 as const,
          sourceId: 'loop-ledger',
          actionKind: 'loop-run-terminals' as const,
          cursor: 'opaque',
        },
        checkpointCommit: 'committed' as const,
        hasMore: false,
        limitReached: false,
      })),
    } satisfies TriageCommandRuntime

    await buildProgram(deps, { triage: runtime }).parseAsync([
      'triage', 'loop-run-terminals',
      '--provider', 'codex',
      '--model', 'gpt-5.6-terra',
      '--page-size', '7',
      '--max-pages', '2',
      '--max-high-candidates', '0',
      '--json',
    ], { from: 'user' })

    expect(runtime.run.calls).toEqual([[{
      source: 'loop-run-terminals',
      provider: 'codex',
      model: 'gpt-5.6-terra',
      pageSize: 7,
      maxPages: 2,
      maxHighCandidates: 0,
    }]])
    expect(JSON.parse(deps.outLines[0]!)).toMatchObject({
      command: 'triage',
      source: 'loop-run-terminals',
      checkpoint: { actionKind: 'loop-run-terminals', limitReached: false },
    })
  })
})
