import { describe, expect, test } from 'vitest'
import { GATE_TTL_MS } from '@tenon/kernel'
import { cmdDoctor, type DoctorCheck } from './doctor.js'
import { buildProgram, CliExit } from '../program.js'
import type { UpstreamSkillView, UpstreamSkillViewRow } from '@tenon/kernel'
import { makeDeps, mockDoctorProbes, mockState, type TestDeps } from '../test-support.js'

/** --json 稳定 schema（BACKLOG #26b）：{checks:[{id,status,detail,hint}],summary:{green,yellow,red}} */
interface DoctorJson {
  checks: DoctorCheck[]
  summary: { green: number; yellow: number; red: number }
}

/** 检查面全集——id 即对用户的稳定契约，顺序固定（skills/Codex/AFK 均只增不改） */
const EXPECTED_IDS = [
  'env:node',
  'env:git',
  'asset:manifest',
  'asset:hooks',
  'guard:gate',
  'guard:statusline',
  'security:tap',
  'project:cwd',
  'project:changes',
  'project:markers',
  'quality:verify-skills',
  'skills:workflow-phase',
  'identity:release',
  'skills:mandatory',
  'skills:recommended',
  'integration:codex-project-skills',
  'auth:codex',
  'afk:docker',
  'afk:image',
  'afk:credential-claude-code',
  'afk:credential-codex',
  'skills:upstream',
] as const

async function runJson(deps: TestDeps): Promise<{ code: number; payload: DoctorJson }> {
  const code = await cmdDoctor(deps, { json: true })
  return { code, payload: JSON.parse(deps.outLines.join('\n')) as DoctorJson }
}

function byId(payload: DoctorJson, id: string): DoctorCheck {
  const c = payload.checks.find((x) => x.id === id)
  if (!c) throw new Error(`check 缺失: ${id}`)
  return c
}

function upstreamRow(id: string, status: UpstreamSkillViewRow['status'] = 'unchanged', reason?: UpstreamSkillViewRow['reason']): UpstreamSkillViewRow {
  return {
    id, origin: 'upstream', status, repo: 'obra/superpowers', path: `skills/${id}`, commit: '1'.repeat(40),
    previousCommit: null, license: 'MIT', fetchedAt: '2026-09-15T08:00:00.000Z', ...(reason === undefined ? {} : { reason }),
  }
}

function upstreamView(rows: readonly UpstreamSkillViewRow[]): UpstreamSkillView {
  return {
    updatedAt: '2026-09-15T08:00:00.000Z',
    lastRunAt: '2026-09-15T08:00:00.000Z',
    rows: [{ id: 'tenon', origin: 'tenon', status: 'bundled' }, ...rows],
  }
}

describe('doctor skills:upstream', () => {
  const missingRow: UpstreamSkillViewRow = { id: 'web-design-guidelines', origin: 'upstream', status: 'failed', repo: 'vercel-labs/agent-skills', path: 'skills/web-design-guidelines', reason: 'license-missing' }
  test.each([
    ['no source list', () => ({ updatedAt: null, lastRunAt: null, rows: [] }), 'green', '无上游技能来源清单', ''],
    ['invalid list', () => ({ error: "skills/sources.yaml: 技能 'hue' ref 'main' 只能是 default-branch" }), 'red', '上游技能清单无效：skills/sources.yaml', 'tools/verify-skills.sh'],
    ['source not in lock', () => upstreamView([upstreamRow('hue'), missingRow]), 'red', '缺 1 个上游技能：web-design-guidelines(license-missing)', 'tenon update --claude'],
    ['kept after a failed run', () => upstreamView([upstreamRow('hue', 'failed', 'unreachable')]), 'yellow', '1 个上游技能获取失败，保留旧版本：hue(unreachable)', '网络恢复后运行 tenon update --claude'],
    ['installed', () => upstreamView([upstreamRow('hue', 'changed'), upstreamRow('brainstorming')]), 'green', '2 个上游技能已安装，自上次更新变化 1 个', ''],
  ] as const)('%s', async (_label, probe, status, detail, hint) => {
    const deps = makeDeps({ doctor: { upstreamSkillView: probe } })
    const { code, payload } = await runJson(deps)
    expect(payload.checks.at(-1)?.id).toBe('skills:upstream')
    const check = byId(payload, 'skills:upstream')
    expect(check.status).toBe(status)
    expect(check.detail).toContain(detail)
    expect(check.hint).toContain(hint)
    expect(code).toBe(status === 'red' ? 1 : 0)
  })

  test('--json --skills adds the view next to checks and summary', async () => {
    const view = upstreamView([upstreamRow('hue', 'changed')])
    const deps = makeDeps({ doctor: { upstreamSkillView: () => view } })
    expect(await cmdDoctor(deps, { json: true, skills: true })).toBe(0)
    const payload = JSON.parse(deps.outLines.join('\n')) as DoctorJson & { skills: UpstreamSkillView }
    expect(Object.keys(payload).sort()).toEqual(['checks', 'skills', 'summary'])
    expect(payload.skills.rows.map((row) => row.id)).toEqual(['tenon', 'hue'])
  })

  test('--skills prints one padded row per skill after the checks', async () => {
    const deps = makeDeps({ doctor: { upstreamSkillView: () => upstreamView([upstreamRow('hue', 'failed', 'unreachable')]) } })
    await cmdDoctor(deps, { skills: true })
    const header = deps.outLines.findIndex((line) => line.startsWith('技能'))
    expect(header).toBeGreaterThan(0)
    expect(deps.outLines[header]).toMatch(/^技能\s+来源\s+提交\s+许可证\s+更新\s+状态$/u)
    expect(deps.outLines[header + 1]).toMatch(/^tenon\s+tenon\s+—\s+—\s+—\s+—$/u)
    expect(deps.outLines[header + 2]).toMatch(/^hue\s+obra\/superpowers:skills\/hue\s+1111111\s+MIT\s+2026-09-15 08:00\s+失败 unreachable$/u)
    const plain = makeDeps({ doctor: { upstreamSkillView: () => upstreamView([upstreamRow('hue')]) } })
    await cmdDoctor(plain, {})
    expect(plain.outLines.some((line) => line.startsWith('技能'))).toBe(false)
  })
})

describe('doctor —— 统一健康面（BACKLOG #26b，GOAL B8 降级可见 / D10 > tenon doctor）', () => {
  test('全绿基线：22 项检查全 green，exit 0，人读输出含汇总行、无 WARN/FAIL', async () => {
    const deps = makeDeps()
    const code = await cmdDoctor(deps, {})
    expect(code).toBe(0)
    const text = deps.outLines.join('\n')
    expect(text).toContain('[DOCTOR]')
    expect(text).toContain('绿 22')
    expect(text).not.toContain('[WARN]')
    expect(text).not.toContain('[FAIL]')
    expect(text).not.toContain('fix:')
  })

  test('default phase Skill 缺失时 skills:workflow-phase 必须 red，不能被其他健康项掩盖', async () => {
    const deps = makeDeps({ doctor: {
      fileExists: (path) => !path.endsWith('skills/tenon-build/SKILL.md'),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const phase = byId(payload, 'skills:workflow-phase')
    expect(phase.status).toBe('red')
    expect(phase.detail).toContain('tenon-build')
    expect(phase.hint).toContain('tenon-build')
  })

  test('--json schema 稳定：checks 四键齐全、id 顺序固定、summary 计数一致', async () => {
    const { code, payload } = await runJson(makeDeps())
    expect(code).toBe(0)
    expect(Object.keys(payload).sort()).toEqual(['checks', 'summary'])
    expect(payload.checks.map((c) => c.id)).toEqual([...EXPECTED_IDS])
    for (const c of payload.checks) {
      expect(Object.keys(c).sort()).toEqual(['detail', 'hint', 'id', 'status'])
      expect(['green', 'yellow', 'red']).toContain(c.status)
      expect(typeof c.detail).toBe('string')
      expect(typeof c.hint).toBe('string')
    }
    expect(payload.summary).toEqual({ green: 22, yellow: 0, red: 0 })
  })

  test('native host/runtime/Dashboard 任一版本漂移时 identity:release red', async () => {
    const releaseId = `sha256-${'a'.repeat(64)}`
    const deps = makeDeps({ doctor: {
      productIdentity: async () => ({
        state: 'native' as const,
        expectedVersion: '1.0.2',
        host: 'codex' as const,
        hostPluginVersion: '1.0.1',
        hostPluginRoot: '/native/tenon',
        stableTargetTag: 'v1.0.2',
        stableTargetCommit: 'a'.repeat(40),
        hostTargetExact: false,
        hostPayloadDigest: 'b'.repeat(64),
        runtimePluginVersion: '1.0.2',
        runtimeReleaseId: releaseId,
        runtimePayloadDigest: 'b'.repeat(64),
        payloadDigestExact: true,
        dashboardServerVersion: '1.0.2',
        dashboardReleaseId: releaseId,
      }),
    } })

    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const identity = byId(payload, 'identity:release')
    expect(identity.status).toBe('red')
    expect(identity.detail).toContain('host=1.0.1')
    expect(identity.detail).toContain('expected=1.0.2')
  })

  test('版本字符串相等但 stable tag/commit 或 payload digest 漂移时 identity:release red', async () => {
    const releaseId = `sha256-${'a'.repeat(64)}`
    const deps = makeDeps({ doctor: {
      productIdentity: async () => ({
        state: 'native' as const,
        expectedVersion: '1.0.2',
        host: 'codex' as const,
        hostPluginVersion: '1.0.2',
        hostPluginRoot: '/native/tenon',
        stableTargetTag: 'v1.0.2',
        stableTargetCommit: 'a'.repeat(40),
        hostTargetExact: false,
        hostPayloadDigest: 'c'.repeat(64),
        runtimePluginVersion: '1.0.2',
        runtimeReleaseId: releaseId,
        runtimePayloadDigest: 'b'.repeat(64),
        payloadDigestExact: false,
        dashboardServerVersion: '1.0.2',
        dashboardReleaseId: releaseId,
      }),
    } })

    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const identity = byId(payload, 'identity:release')
    expect(identity.status).toBe('red')
    expect(identity.detail).toContain('target=v1.0.2@aaaaaaaaaaaa:drift')
    expect(identity.detail).toContain('payload=cccccccccccc/bbbbbbbbbbbb:drift')
  })

  test('Codex runtime 未登录 → auth:codex yellow 且一次给全两类账号登录路径', async () => {
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'codex',
      codexAuthStatus: async () => ({ state: 'unauthenticated' }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const auth = byId(payload, 'auth:codex')
    expect(auth.status).toBe('yellow')
    expect(auth.hint).toContain('codex login')
    expect(auth.hint).toContain('codex login --device-auth')
    expect(auth.hint).toContain('platform.openai.com/api-keys')
    expect(auth.hint).toContain('codex login --with-api-key')
    expect(auth.hint).toContain('codex login status')
  })

  test('Codex 认证探针异常使用固定 detail，不把异常或 secret-like 内容写入 JSON', async () => {
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'codex',
      codexAuthStatus: async () => {
        throw new Error('OPENAI_API_KEY=sk-must-not-leak')
      },
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('must-not-leak')
    expect(byId(payload, 'auth:codex').detail).toBe('Codex 登录检查自身异常')
  })

  test('宿主已登录但 AFK 无凭证时，两类状态独立呈现', async () => {
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'codex',
      codexAuthStatus: async () => ({ state: 'authenticated' }),
      afkReadiness: async () => ({
        ok: true,
        docker: { available: true },
        image: { configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' },
        credentials: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } },
          codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: false } },
        },
      }),
    } })
    const { payload } = await runJson(deps)
    expect(byId(payload, 'auth:codex').status).toBe('green')
    expect(byId(payload, 'afk:credential-codex').status).toBe('yellow')
  })

  test('AFK 有 API Key 但宿主未登录时，两类状态独立呈现', async () => {
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'codex',
      codexAuthStatus: async () => ({ state: 'unauthenticated' }),
      afkReadiness: async () => ({
        ok: true,
        docker: { available: true },
        image: { configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' },
        credentials: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } },
          codex: {
            OPENAI_API_KEY: { set: true, source: 'secrets-file' },
            CODEX_HOME: { set: false },
          },
        },
      }),
    } })
    const { payload } = await runJson(deps)
    expect(byId(payload, 'auth:codex').status).toBe('yellow')
    expect(byId(payload, 'afk:credential-codex').status).toBe('green')
  })

  test('env:node 红灯：node < 22 → red + 升级指引，exit 1', async () => {
    const deps = makeDeps({ doctor: { nodeVersion: () => 'v20.19.0' } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'env:node')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('v20.19.0')
    expect(c.hint).toContain('22')
  })

  test('env:git 红灯：git 不可用 → Build/Verify revision fail-closed，要求重新 Build', async () => {
    const deps = makeDeps({ doctor: { gitAvailable: async () => false } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'env:git')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('fail-closed')
    expect(c.hint).toContain('不得手动回填')
    expect(payload.summary.red).toBe(1)
  })

  test('asset:manifest 红灯：解析失败 → red 带错误消息', async () => {
    const deps = makeDeps({ doctor: { manifestError: () => 'transitions 缺 open 条目' } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'asset:manifest')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('transitions 缺 open 条目')
  })

  test('asset:hooks 红灯：gate.sh 不可执行 → red 列出具体文件', async () => {
    const deps = makeDeps({
      doctor: { fileExecutable: (p) => !p.endsWith('gate.sh') },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'asset:hooks')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('gate.sh')
    expect(c.detail).toContain('不可执行')
    expect(c.hint).toContain('chmod +x')
  })

  test('guard:gate 红灯：hooks.json 缺失 → 三门不会真拦', async () => {
    const deps = makeDeps({
      doctor: { fileExists: (p) => !p.endsWith('hooks.json') },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'guard:gate')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('hooks.json')
  })

  test('guard:gate 黄灯：TENON_AFK=1 → 三门旁路中（资产完好也降级可见），exit 0', async () => {
    const deps = makeDeps({
      doctor: { env: (n) => (n === 'TENON_AFK' ? '1' : undefined) },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'guard:gate')
    expect(c.status).toBe('yellow')
    expect(c.detail).toContain('三门旁路中')
  })

  test('guard:statusline 黄灯：未接入 settings → 黄灯带接入命令', async () => {
    const deps = makeDeps({ doctor: { statuslineConfigured: () => false } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'guard:statusline')
    expect(c.status).toBe('yellow')
    expect(c.hint).toContain('statusLine')
    expect(c.hint).toContain('statusline.sh')
  })

  test('guard:statusline：Codex runtime 不把 Claude 专属 statusline 误报为降级', async () => {
    const deps = makeDeps({
      doctor: {
        statuslineConfigured: () => false,
        nativeRuntimeHost: async () => 'codex',
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'guard:statusline')
    expect(c.status).toBe('green')
    expect(c.detail).toContain('Codex')
    expect(c.detail).toContain('不适用')
    expect(c.hint).toBe('')
  })

  test('security:tap 黄灯：tap 正在拦截 → 明示提醒（#34e 敏感能力可见）', async () => {
    const deps = makeDeps({
      doctor: { tapStatus: () => ({ intercepting: true, captureEnabled: true, message: 'tap 正在拦截流量：2 个端口' }) },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'security:tap')
    expect(c.status).toBe('yellow')
    expect(c.detail).toContain('正在拦截')
    expect(c.hint).toContain('不外发')
  })

  test('security:tap 绿灯：未拦截（默认 OFF）', async () => {
    const deps = makeDeps({
      doctor: { tapStatus: () => ({ intercepting: false, captureEnabled: false, message: 'tap 未拦截（默认 OFF）' }) },
    })
    const { payload } = await runJson(deps)
    expect(byId(payload, 'security:tap').status).toBe('green')
  })

  test('project:cwd 黄灯：cwd 不是 pipeline 项目（openspec/changes 不存在）', async () => {
    const deps = makeDeps({ doctor: { dirExists: () => false } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'project:cwd')
    expect(c.status).toBe('yellow')
    expect(c.hint).toContain('tenon init')
  })

  test('project:changes 绿灯：活跃 change 计数进 detail', async () => {
    const deps = makeDeps({
      states: {
        'ok-change': mockState({ phase: 'build' }),
        'archived-change': mockState({ phase: 'done', archived: 'true' }),
      },
    })
    const { payload } = await runJson(deps)
    const c = byId(payload, 'project:changes')
    expect(c.status).toBe('green')
    expect(c.detail).toContain('1 个活跃 change')
  })

  test('project:changes 红灯：坏 .pipeline.yaml 抽查 → red 列出坏 change 名', async () => {
    const deps = makeDeps({
      states: { 'ok-change': mockState({ phase: 'build' }) },
      changes: ['ok-change', 'broken-change'],
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'project:changes')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('broken-change')
    expect(c.detail).not.toContain('ok-change')
  })

  test('project:markers 黄灯：陈旧门 marker（age > 分级 TTL）→ 自动清理/重新请求指引；新鲜 marker → 绿灯', async () => {
    const stale = makeDeps({
      // review 分级 TTL=1800s；超一点即陈旧（#13 分级，非旧统一 15min）
      gateMarkers: [{ kind: 'review', ageMs: GATE_TTL_MS.review + 1, raw: 'spec\nx\ndemo\n' }],
    })
    const { code, payload } = await runJson(stale)
    expect(code).toBe(0)
    const c = byId(payload, 'project:markers')
    expect(c.status).toBe('yellow')
    expect(c.detail).toContain('.pipeline-pending-review')
    expect(c.hint).toContain('自动清理')
    expect(c.hint).toContain('不要手动删除')

    const fresh = makeDeps({
      gateMarkers: [{ kind: 'confirm', ageMs: 60_000, raw: 'build\nx\ndemo\n' }],
    })
    const freshRun = await runJson(fresh)
    expect(byId(freshRun.payload, 'project:markers').status).toBe('green')
    expect(byId(freshRun.payload, 'project:markers').detail).toContain('生效')
  })

  test('quality:verify-skills 红灯：子进程非 0 → red 带输出摘要', async () => {
    const deps = makeDeps({
      doctor: {
        runVerifySkills: async () => ({
          code: 1,
          output: '[verify-skills] FAIL — 发现 2 处悬空引用/缺失',
        }),
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'quality:verify-skills')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('发现 2 处悬空引用')
    expect(c.hint).toContain('verify-skills')
  })

  test('Codex skills 黄灯：只在 cache 不能替代原生插件或项目 adapter 的实际发现', async () => {
    const deps = makeDeps({ doctor: { codexProjectSkillNames: () => new Set(['tenon']) } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('yellow')
    expect(c.detail).toContain('openspec-propose')
    expect(c.detail).toContain('全局 cache 不算')
    expect(c.hint).toContain('tenon setup --codex')
  })

  test('Codex native selected root 单独满足 contract，不要求项目 Skill 投影', async () => {
    const contract = mockDoctorProbes().codexProjectSkillNames?.() ?? new Set<string>()
    const selected = new Map([...contract].map((id) => [id, `digest-${id}`]))
    const deps = makeDeps({ doctor: {
      codexSkillDiscovery: async () => ({
        selectedRoot: '/native/tenon',
        projectRoot: '/repo/.agents/skills',
        selected,
        project: new Map(),
      }),
    } })
    const { payload } = await runJson(deps)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('green')
    expect(c.detail).toContain('Selected Skill Root')
    expect(c.detail).toContain('/native/tenon')
  })

  test('Codex 旧工作流插件仍启用时红灯，修复只走宿主插件管理器', async () => {
    const deps = makeDeps({ doctor: {
      hostPluginInventory: async () => ({
        kind: 'native',
        host: 'codex',
        enabledIds: new Set(['pipeline-lite@pipeline-lite', 'tenon@tenon']),
      }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('旧工作流插件')
    expect(c.hint).toContain('tenon setup --codex')
    expect(c.hint).not.toContain('.codex/.tmp')
  })

  test('Codex 宿主 inventory 不可用或畸形时红灯，不得跳过唯一身份检查后误报 green', async () => {
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'codex',
      hostPluginInventory: async () => ({ kind: 'unavailable', host: 'codex', detail: 'bad json' }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('inventory')
    expect(c.hint).toContain('codex plugin list --json')
  })

  test('Codex inventory 可读但没有 Tenon 登记时红灯，不以磁盘 Skill 根替代宿主登记', async () => {
    const deps = makeDeps({ doctor: {
      hostPluginInventory: async () => ({ kind: 'native', host: 'codex', enabledIds: new Set() }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('tenon@tenon')
  })

  test('doctor 以 active Claude runtime 的 inventory 为准并给出 Claude 修复命令', async () => {
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'claude',
      hostPluginInventory: async () => ({ kind: 'native', host: 'claude', enabledIds: new Set() }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.detail).toContain('Claude')
    expect(c.hint).toContain('tenon setup --claude')
    expect(c.hint).not.toContain('setup --codex')
  })

  test('Claude inventory 登记了 Tenon 但报告加载失败时红灯，不以已启用登记误报 green', async () => {
    const loadError = 'Hook load failed: Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file'
    const deps = makeDeps({ doctor: {
      nativeRuntimeHost: async () => 'claude',
      hostPluginInventory: async () => ({
        kind: 'native',
        host: 'claude',
        enabledIds: new Set(['tenon@tenon']),
        tenonLoadErrors: [loadError],
      }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('加载失败')
    expect(c.detail).toContain('Duplicate hooks file')
    expect(c.hint).toContain('tenon setup --claude')
  })

  test('Codex 同摘要多根报告 duplicate-projection，不误称 healthy', async () => {
    const contract = mockDoctorProbes().codexProjectSkillNames?.() ?? new Set<string>()
    const selected = new Map([...contract].map((id) => [id, `digest-${id}`]))
    const deps = makeDeps({ doctor: {
      codexSkillDiscovery: async () => ({
        selectedRoot: '/native/tenon',
        projectRoot: '/repo/.agents/skills',
        selected,
        project: new Map([['tenon', 'digest-tenon']]),
      }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('yellow')
    expect(c.detail).toContain('duplicate-projection')
    expect(c.detail).toContain('tenon')
  })

  test('Codex 同 ID 不同摘要报告 shadow-conflict 并 fail closed', async () => {
    const contract = mockDoctorProbes().codexProjectSkillNames?.() ?? new Set<string>()
    const selected = new Map([...contract].map((id) => [id, `digest-${id}`]))
    const deps = makeDeps({ doctor: {
      codexSkillDiscovery: async () => ({
        selectedRoot: '/native/tenon',
        projectRoot: '/repo/.agents/skills',
        selected,
        project: new Map([['tenon', 'user-digest']]),
      }),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'integration:codex-project-skills')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('shadow-conflict')
    expect(c.detail).toContain('tenon')
  })

  test('探针自身异常不炸命令：该项折算 red（fail-loud 可见），其余检查照常', async () => {
    const deps = makeDeps({
      doctor: {
        nodeVersion: () => {
          throw new Error('boom')
        },
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'env:node')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('boom')
    expect(payload.checks).toHaveLength(EXPECTED_IDS.length)
  })

  test('人读输出：非绿项带 [WARN]/[FAIL] 标记与 fix: 指引行', async () => {
    const deps = makeDeps({
      doctor: {
        statuslineConfigured: () => false,
        nodeVersion: () => 'v18.0.0',
      },
    })
    const code = await cmdDoctor(deps, {})
    expect(code).toBe(1)
    const text = deps.outLines.join('\n')
    expect(text).toContain('[FAIL] env:node')
    expect(text).toContain('[WARN] guard:statusline')
    expect(text).toMatch(/fix: /)
  })

  test('doctor 探针未装配：报错 exit 1（doctor 自己不许静默降级）', async () => {
    const deps = makeDeps()
    deps.doctor = undefined
    expect(await cmdDoctor(deps, {})).toBe(1)
    expect(deps.errLines.join('\n')).toContain('探针未装配')
  })

  test('program 路由：tenon doctor --json 注册可达', async () => {
    const deps = makeDeps()
    let code = 0
    try {
      await buildProgram(deps).parseAsync(['doctor', '--json'], { from: 'user' })
    } catch (e) {
      if (e instanceof CliExit) code = e.code
      else throw e
    }
    expect(code).toBe(0)
    const payload = JSON.parse(deps.outLines.join('\n')) as DoctorJson
    expect(payload.summary).toEqual({ green: 22, yellow: 0, red: 0 })
  })
})

describe('doctor —— AFK 运行时就绪四检（full-install R1：afk:docker / afk:image / afk:credential-*）', () => {
  // 缺省 makeDeps 的 afkReadiness = 全就绪（docker 可用/镜像在位/两 runner 凭证已配）→ 四绿基线；
  // 单测只覆写 afkReadiness 返回值制造 docker 缺 / 镜像缺 / 凭证缺 各态。AFK 是可选能力：一律 yellow 不 red。

  test('① docker 不可用 → afk:docker yellow（AFK 可选，降级不阻断 exit 0）;镜像因 docker 缺也 yellow', async () => {
    const deps = makeDeps({
      doctor: {
        afkReadiness: async () => ({
          ok: true as const,
          docker: { available: false },
          image: { configured: 'sandcastle:local', present: false, build_hint: 'bash tools/sandcastle/build.sh' },
          credentials: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: true, source: 'host-env' as const } },
            codex: { OPENAI_API_KEY: { set: true, source: 'host-env' as const }, CODEX_HOME: { set: false } },
          },
        }),
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0) // yellow 不阻断
    expect(byId(payload, 'afk:docker').status).toBe('yellow')
    expect(byId(payload, 'afk:docker').detail).toContain('docker')
    // FI·G1:hint 不光说「装 docker」,还引导怎么装——OrbStack / Docker Desktop,明示不自动装
    const dockerHint = byId(payload, 'afk:docker').hint
    expect(dockerHint).toContain('OrbStack')
    expect(dockerHint).toContain('Docker Desktop')
    expect(dockerHint).toContain('不自动装')
    expect(byId(payload, 'afk:image').status).toBe('yellow')
  })

  test('② docker 在但镜像缺 → afk:image yellow + hint 含 build_hint（bash tools/sandcastle/build.sh）', async () => {
    const deps = makeDeps({
      doctor: {
        afkReadiness: async () => ({
          ok: true as const,
          docker: { available: true },
          image: { configured: 'sandcastle:local', present: false, build_hint: 'bash tools/sandcastle/build.sh' },
          credentials: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: true, source: 'host-env' as const } },
            codex: { OPENAI_API_KEY: { set: true, source: 'host-env' as const }, CODEX_HOME: { set: true, source: 'host-env' as const } },
          },
        }),
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const c = byId(payload, 'afk:image')
    expect(c.status).toBe('yellow')
    expect(c.detail).toContain('sandcastle:local')
    expect(c.hint).toContain('bash tools/sandcastle/build.sh')
    expect(byId(payload, 'afk:docker').status).toBe('green')
  })

  test('③ 凭证缺 → afk:credential-claude-code / afk:credential-codex 各自 yellow + 去配指引（值永不回显）', async () => {
    const deps = makeDeps({
      doctor: {
        afkReadiness: async () => ({
          ok: true as const,
          docker: { available: true },
          image: { configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' },
          credentials: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } },
            codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: false } },
          },
        }),
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    const cc = byId(payload, 'afk:credential-claude-code')
    expect(cc.status).toBe('yellow')
    expect(cc.hint).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    // FI·G1:claude-code 缺 → hint 引导怎么拿（生成长期 OAuth token）
    expect(cc.hint).toContain('claude setup-token')
    const cx = byId(payload, 'afk:credential-codex')
    expect(cx.status).toBe('yellow')
    expect(cx.hint).toContain('OPENAI_API_KEY')
    // FI·G1:codex 缺 → hint 引导两条路（codex login 走 ChatGPT / platform.openai.com/api-keys 建 key）
    expect(cx.hint).toContain('codex login')
    expect(cx.hint).toContain('platform.openai.com/api-keys')
  })

  test('④ 两 runner 凭证对称:codex 缺席不得——OPENAI_API_KEY 与 CODEX_HOME 都在 codex 灯里呈现', async () => {
    // claude-code 已配、codex 的 OPENAI_API_KEY 已配但 CODEX_HOME 缺 → codex 仍 green（API key 决胜），
    // 但 CODEX_HOME 状态随行在 detail 里可见（对称呈现，不因决胜键已配就隐藏另一键）
    const deps = makeDeps({
      doctor: {
        afkReadiness: async () => ({
          ok: true as const,
          docker: { available: true },
          image: { configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' },
          credentials: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: true, source: 'secrets-file' as const } },
            codex: { OPENAI_API_KEY: { set: true, source: 'secrets-file' as const }, CODEX_HOME: { set: false } },
          },
        }),
      },
    })
    const { payload } = await runJson(deps)
    expect(byId(payload, 'afk:credential-claude-code').status).toBe('green')
    const cx = byId(payload, 'afk:credential-codex')
    expect(cx.status).toBe('green')
    expect(cx.detail).toContain('CODEX_HOME') // 对称:CODEX_HOME 恒随行呈现
  })

  test('Codex-first：API key 缺席但默认 Codex home 登录可用 → codex 检查仍为 green', async () => {
    const deps = makeDeps({
      doctor: {
        afkReadiness: async () => ({
          ok: true as const,
          docker: { available: true },
          image: { configured: 'sandcastle:local', present: true, build_hint: 'bash tools/sandcastle/build.sh' },
          credentials: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: false } },
            codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: true, source: 'default-home' as const } },
          },
        }),
      },
    })
    const { payload } = await runJson(deps)
    const cx = byId(payload, 'afk:credential-codex')
    expect(cx.status).toBe('green')
    expect(cx.detail).toContain('默认 ~/.codex 登录')
  })

  test('⑤ 全就绪基线 → afk:* 四项 green', async () => {
    const { payload } = await runJson(makeDeps())
    expect(byId(payload, 'afk:docker').status).toBe('green')
    expect(byId(payload, 'afk:image').status).toBe('green')
    expect(byId(payload, 'afk:credential-claude-code').status).toBe('green')
    expect(byId(payload, 'afk:credential-codex').status).toBe('green')
  })

  test('⑥ 探针自身抛异常 → afk:* 四项各折算 red，不炸命令', async () => {
    const deps = makeDeps({
      doctor: {
        afkReadiness: async () => {
          throw new Error('probe boom')
        },
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1) // red 阻断
    for (const id of ['afk:docker', 'afk:image', 'afk:credential-claude-code', 'afk:credential-codex']) {
      expect(byId(payload, id).status).toBe('red')
      expect(byId(payload, id).detail).toContain('boom')
    }
    expect(payload.checks).toHaveLength(EXPECTED_IDS.length)
  })
})

describe('doctor 缺技能检测（full-install 批2 A1：skills:mandatory / skills:recommended）', () => {
  // registry 走 checkSkills 侧真读 templates/skill-sources.yaml；默认项全部 bundled。缺失态必须用
  // 自定义 workflow 的非 registry token，证明 doctor 不会把外部扩展误称为 setup 自动可得。

  test('① 自定义 workflow 缺强制 skill → skills:mandatory red，exit 1', async () => {
    const deps = makeDeps({ doctor: {
      manifestSkills: () => ({
        mandatory: { build: { frontend: ['custom-required'] } } as never,
        recommended: {} as never,
      }),
      installedSkillNames: () => new Set(),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(1)
    const c = byId(payload, 'skills:mandatory')
    expect(c.status).toBe('red')
    expect(c.detail).toContain('custom-required')
    expect(c.hint).toContain('custom-required')
    expect(c.hint).toContain('自定义插件')
  })

  test('② 自定义 workflow 缺推荐不缺强制 → mandatory green、recommended yellow（缺名进 detail），exit 0', async () => {
    const deps = makeDeps({ doctor: {
      manifestSkills: () => ({
        mandatory: { build: { frontend: ['custom-required'] } } as never,
        recommended: { build: { frontend: ['custom-recommended'] } } as never,
      }),
      installedSkillNames: () => new Set(['custom-required']),
    } })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0)
    expect(byId(payload, 'skills:mandatory').status).toBe('green')
    const r = byId(payload, 'skills:recommended')
    expect(r.status).toBe('yellow')
    expect(r.detail).toContain('custom-recommended')
  })

  test('③ 全在位 → 两项 green（缺省基线）', async () => {
    const { payload } = await runJson(makeDeps())
    expect(byId(payload, 'skills:mandatory').status).toBe('green')
    expect(byId(payload, 'skills:recommended').status).toBe('green')
  })

  test('④ bundled token（默认流程全部如此）恒算在位——即便 installedSkillNames 全空也不进缺失名单', async () => {
    const deps = makeDeps({ doctor: { installedSkillNames: () => new Set<string>() } })
    const { payload } = await runJson(deps)
    const c = byId(payload, 'skills:mandatory')
    expect(c.status).toBe('green')
    expect(c.detail).not.toContain('test-driven-development')
    expect(c.detail).not.toContain('openspec-propose')
  })

  test('⑤ registry 缺失（fileExists 报无 skill-sources.yaml）→ 两项 yellow 不 green，exit 0（S1 concern #3 回归）', async () => {
    const deps = makeDeps({
      doctor: {
        installedSkillNames: () => new Set<string>(), // 空——若误报 green 才是真 bug
        fileExists: (p) => !p.endsWith('skill-sources.yaml'),
      },
    })
    const { code, payload } = await runJson(deps)
    expect(code).toBe(0) // yellow 不影响 exit（不阻断）
    const m = byId(payload, 'skills:mandatory')
    const r = byId(payload, 'skills:recommended')
    expect(m.status).toBe('yellow')
    expect(r.status).toBe('yellow')
    expect(m.detail).toContain('registry 未就绪')
  })

  test('⑥ 自定义 a|b 备选任一侧在位即算满足该项（两侧都缺才 red）', async () => {
    const mk = (installed: string[]) =>
      makeDeps({
        doctor: {
          manifestSkills: () => ({
            mandatory: { build: { frontend: ['custom-a|custom-b'] } } as never,
            recommended: {} as never,
          }),
          installedSkillNames: () => new Set(installed),
        },
      })
    expect(byId((await runJson(mk(['custom-a']))).payload, 'skills:mandatory').status).toBe('green')
    expect(byId((await runJson(mk(['custom-b']))).payload, 'skills:mandatory').status).toBe('green')
    expect(byId((await runJson(mk([]))).payload, 'skills:mandatory').status).toBe('red')
  })

  test('⑦ manifest 不可用（manifestSkills 返回 null）→ 两项 yellow，不误报 green', async () => {
    const deps = makeDeps({ doctor: { manifestSkills: () => null } })
    const { payload } = await runJson(deps)
    expect(byId(payload, 'skills:mandatory').status).toBe('yellow')
    expect(byId(payload, 'skills:recommended').status).toBe('yellow')
  })

  test('⑧ 只在 skills.lock.json 中的强制技能算在位；锁里缺失则 red', async () => {
    const manifestSkills = () => ({ mandatory: { build: { frontend: ['shadcn'] } } as never, recommended: {} as never })
    const locked = makeDeps({ doctor: { manifestSkills, installedSkillNames: () => new Set(), upstreamSkillView: () => upstreamView([upstreamRow('shadcn')]) } })
    expect(byId((await runJson(locked)).payload, 'skills:mandatory').status).toBe('green')
    const missing = makeDeps({ doctor: {
      manifestSkills,
      installedSkillNames: () => new Set(),
      upstreamSkillView: () => upstreamView([{ id: 'shadcn', origin: 'upstream', status: 'failed', repo: 'shadcn-ui/ui', path: 'skills/shadcn' }]),
    } })
    expect(byId((await runJson(missing)).payload, 'skills:mandatory').status).toBe('red')
  })

  test('人读输出：缺自定义强制技能 → [FAIL] skills:mandatory + fix: 行含打包指引', async () => {
    const deps = makeDeps({ doctor: {
      manifestSkills: () => ({
        mandatory: { build: { frontend: ['custom-required'] } } as never,
        recommended: {} as never,
      }),
      installedSkillNames: () => new Set(),
    } })
    const code = await cmdDoctor(deps, {})
    expect(code).toBe(1)
    const text = deps.outLines.join('\n')
    expect(text).toContain('[FAIL] skills:mandatory')
    expect(text).toMatch(/fix: .*自定义插件/)
  })
})
