/**
 * loadTrackRegistry / requireTrack / assertWorkflowAllowed / writeTrackRegistry /
 * registryRevision —— 真实 fs + mkdtemp 集成测试：
 * 缺文件 → builtin-only 内建 Track（与「没有本功能」逐字一致）；有文件 → effective 合成
 * （覆写只影响 label/workflow）；原子写 + 目录锁 + revision 冲突拒绝；并发写不撕裂。
 * writer 合同（codex R1 review 裁定）：写盘前对 next 强制完整 validateTrackRegistry；
 * 现存文件损坏默认拒绝覆写，重建走显式 { repairCorrupt: true }（与 expectedRevision 互斥）；
 * write 成功过的文件 loadTrackRegistry 同 context 读回永不 fail-loud。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ProjectTrackConfig, TrackValidationContext } from './types.js'
import { BUILTIN_TRACK_DEFINITIONS } from './builtins.js'
import { TrackConfigParseError } from './parse.js'
import { serializeTrackRegistry } from './serialize.js'
import {
  assertWorkflowAllowed,
  loadTrackRegistry,
  registryRevision,
  RegistryCorruptFileError,
  RegistryRevisionConflictError,
  requireTrack,
  trackRegistryPath,
  writeTrackRegistry,
} from './registry.js'

const CTX: TrackValidationContext = {
  workflowExists: (id) => ['default', 'data-pipeline', 'wf-a'].includes(id),
  skillProfiles: new Set(['pm', 'frontend', 'backend']),
}

const DATA_TRACK = {
  id: 'data',
  label: 'Data',
  workflow: { default: 'data-pipeline', allowed: ['data-pipeline', 'default'] },
  policyProfile: {
    reviewSeed: 'pending',
    automationEligible: true,
    coverageProfile: 'backend',
    routing: { enabled: true, pattern: '(数据|ETL|warehouse)', priority: 150 },
    skills: { matrix: true, profile: 'backend' },
  },
} satisfies NonNullable<ProjectTrackConfig['tracks']>[number]

const PROJECT_FILE = `version: 1
builtins:
  chat:
    label: 会话
  pm:
    workflow:
      default: wf-a
      allowed: [wf-a, default]
tracks:
  - id: data
    label: Data
    workflow:
      default: data-pipeline
      allowed: [data-pipeline, default]
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: backend
      routing:
        enabled: true
        pattern: '(数据|ETL|warehouse)'
        priority: 150
      skills:
        matrix: true
        profile: backend
  - id: ops
    label: Ops
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: skipped
      automation_eligible: false
      coverage_profile: none
      routing:
        enabled: false
      skills:
        matrix: false
        profile: _all
`

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'pl-tracks-'))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function seedProjectFile(text: string): Promise<void> {
  await mkdir(path.join(repoRoot, '.pipeline'), { recursive: true })
  await writeFile(trackRegistryPath(repoRoot), text, 'utf8')
}

describe('loadTrackRegistry —— 缺文件 fallback', () => {
  test('无 .pipeline 目录 → 纯内建六轨 builtin-only，revision = 空配置 hash', () => {
    const reg = loadTrackRegistry(repoRoot, CTX)
    expect(reg.source).toBe('builtin-only')
    expect(reg.ordered).toEqual(BUILTIN_TRACK_DEFINITIONS)
    expect(reg.ordered.map((t) => t.id)).toEqual(['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free'])
    expect(reg.revision).toBe(registryRevision({ version: 1 }))
    expect(reg.revision).toMatch(/^[0-9a-f]{16}$/)
    expect(reg.byId.get('pm')?.policyProfile.reviewSeed).toBe('skipped')
  })

  test('.pipeline 目录在但无 tracks.yaml → 同样 builtin-only', async () => {
    await mkdir(path.join(repoRoot, '.pipeline'), { recursive: true })
    expect(loadTrackRegistry(repoRoot, CTX).source).toBe('builtin-only')
  })
})

describe('loadTrackRegistry —— 项目文件合成', () => {
  test('effective：覆写只影响 label/workflow；额外 track 追加在内建之后（builtin:false）', async () => {
    await seedProjectFile(PROJECT_FILE)
    const reg = loadTrackRegistry(repoRoot, CTX)
    expect(reg.source).toBe('project-file')
    expect(reg.ordered.map((t) => t.id)).toEqual(['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free', 'data', 'ops'])

    const builtinChat = BUILTIN_TRACK_DEFINITIONS[0]!
    const builtinPm = BUILTIN_TRACK_DEFINITIONS.find((track) => track.id === 'pm')!
    expect(reg.byId.get('chat')).toEqual({ ...builtinChat, label: '会话' })
    expect(reg.byId.get('pm')).toEqual({
      ...builtinPm,
      workflow: { default: 'wf-a', allowed: ['wf-a', 'default'] },
    })
    // policyProfile 覆写被 v1 锁死：合成结果必须与内建逐字段一致
    expect(reg.byId.get('pm')?.policyProfile).toEqual(builtinPm.policyProfile)
    expect(reg.byId.get('frontend')).toEqual(BUILTIN_TRACK_DEFINITIONS.find((track) => track.id === 'frontend'))

    expect(reg.byId.get('data')).toEqual({
      id: 'data',
      label: 'Data',
      builtin: false,
      workflow: { default: 'data-pipeline', allowed: ['data-pipeline', 'default'] },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'backend',
        routing: { enabled: true, pattern: '(数据|ETL|warehouse)', priority: 150 },
        skills: { matrix: true, profile: 'backend' },
      },
    })
    // allowed 全放行必须显式写 '*'（省略是校验错误——codex R1 裁定）
    expect(reg.byId.get('ops')).toEqual({
      id: 'ops',
      label: 'Ops',
      builtin: false,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'skipped',
        automationEligible: false,
        coverageProfile: 'none',
        routing: { enabled: false },
        skills: { matrix: false, profile: '_all' },
      },
    })
  })

  test('坏 YAML → fail-loud 抛带行号解析错误', async () => {
    await seedProjectFile('version: 2\n')
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(TrackConfigParseError)
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(/tracks\.yaml:1/)
  })

  test('校验失败（引用不存在的 workflow）→ fail-loud 抛错误清单', async () => {
    await seedProjectFile(PROJECT_FILE.replace('default: data-pipeline', 'default: ghost'))
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(/校验失败/)
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(/ghost/)
  })
})

describe('requireTrack / assertWorkflowAllowed', () => {
  test('requireTrack：命中返回定义；未注册抛错并列出已注册 id', () => {
    const reg = loadTrackRegistry(repoRoot, CTX)
    expect(requireTrack(reg, 'frontend').label).toBe('Frontend')
    expect(() => requireTrack(reg, 'data')).toThrow(/未注册的 track 'data'/)
    expect(() => requireTrack(reg, 'data')).toThrow(/chat, simple, standard, pm, frontend, backend/)
  })

  test("assertWorkflowAllowed：'*' 全放行；数组按 membership；拒绝时列出允许值", async () => {
    await seedProjectFile(PROJECT_FILE)
    const reg = loadTrackRegistry(repoRoot, CTX)
    expect(() => assertWorkflowAllowed(requireTrack(reg, 'chat'), 'anything')).not.toThrow()
    expect(() => assertWorkflowAllowed(requireTrack(reg, 'data'), 'data-pipeline')).not.toThrow()
    expect(() => assertWorkflowAllowed(requireTrack(reg, 'data'), 'wf-a')).toThrow(
      /不允许绑定 workflow 'wf-a'.*data-pipeline, default/,
    )
  })
})

describe('writeTrackRegistry —— 原子写 + revision 冲突', () => {
  const NEXT: ProjectTrackConfig = { version: 1, tracks: [DATA_TRACK] }

  test('全新仓（无 .pipeline）写入：建目录、落文件、返回 effective，与读回一致', async () => {
    const written = await writeTrackRegistry(repoRoot, NEXT, CTX)
    expect(written.source).toBe('project-file')
    expect(written.ordered.map((t) => t.id)).toEqual(['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free', 'data'])

    const onDisk = await readFile(trackRegistryPath(repoRoot), 'utf8')
    expect(onDisk).toBe(serializeTrackRegistry(NEXT))

    const readBack = loadTrackRegistry(repoRoot, CTX)
    expect(readBack.ordered).toEqual(written.ordered)
    expect(readBack.revision).toBe(written.revision)
    expect(written.revision).toBe(registryRevision(NEXT))
  })

  test('expectedRevision 流转：缺文件时以 builtin-only revision 起步；陈旧 revision 被 409 语义拒绝', async () => {
    const rev0 = loadTrackRegistry(repoRoot, CTX).revision
    const reg1 = await writeTrackRegistry(repoRoot, NEXT, CTX, rev0)
    expect(reg1.revision).toBe(registryRevision(NEXT))

    const next2: ProjectTrackConfig = { version: 1, builtins: { chat: { label: '会话' } } }
    await expect(writeTrackRegistry(repoRoot, next2, CTX, rev0)).rejects.toBeInstanceOf(RegistryRevisionConflictError)
    await expect(writeTrackRegistry(repoRoot, next2, CTX, rev0)).rejects.toThrow(/revision 冲突/)
    // 冲突拒绝后文件内容保持第一次写入
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(serializeTrackRegistry(NEXT))

    const reg2 = await writeTrackRegistry(repoRoot, next2, CTX, reg1.revision)
    expect(reg2.byId.get('chat')?.label).toBe('会话')
  })

  test('校验不过的 next（与内建重名）→ 拒写，不产生文件', async () => {
    const bad: ProjectTrackConfig = { version: 1, tracks: [{ ...DATA_TRACK, id: 'pm' }] }
    await expect(writeTrackRegistry(repoRoot, bad, CTX)).rejects.toThrow(/完整校验/)
    await expect(readFile(trackRegistryPath(repoRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('写后目录干净：只有 tracks.yaml（无 tmp 残留、无锁目录残留）', async () => {
    await writeTrackRegistry(repoRoot, NEXT, CTX)
    const entries = await readdir(path.join(repoRoot, '.pipeline'))
    expect(entries).toEqual(['tracks.yaml'])
  })

  test('并发两路 write（Promise.all）在锁下串行不撕裂：最终文件是两候选之一的完整序列化', async () => {
    const cfgA: ProjectTrackConfig = { version: 1, tracks: [DATA_TRACK] }
    const cfgB: ProjectTrackConfig = { version: 1, builtins: { chat: { label: 'A' } } }
    await Promise.all([writeTrackRegistry(repoRoot, cfgA, CTX), writeTrackRegistry(repoRoot, cfgB, CTX)])
    const onDisk = await readFile(trackRegistryPath(repoRoot), 'utf8')
    expect([serializeTrackRegistry(cfgA), serializeTrackRegistry(cfgB)]).toContain(onDisk)
    const entries = await readdir(path.join(repoRoot, '.pipeline'))
    expect(entries).toEqual(['tracks.yaml'])
  })
})

describe('writeTrackRegistry —— 完整校验合同 + 损坏文件语义（codex R1 review 裁定）', () => {
  const NEXT: ProjectTrackConfig = { version: 1, tracks: [DATA_TRACK] }
  const GHOST_WORKFLOW: ProjectTrackConfig = {
    version: 1,
    tracks: [{ ...DATA_TRACK, workflow: { default: 'ghost', allowed: '*' } }],
  }
  const GHOST_PROFILE: ProjectTrackConfig = {
    version: 1,
    tracks: [
      { ...DATA_TRACK, policyProfile: { ...DATA_TRACK.policyProfile, skills: { matrix: true, profile: 'ghost' } } },
    ],
  }
  /** parse 层即坏（流式列表未闭合）。 */
  const CORRUPT_PARSE = 'version: 1\nbuiltins: [\n'
  /** parse 得过、语义校验不过（ghost workflow 引用）。 */
  const CORRUPT_SEMANTIC = PROJECT_FILE.replace('default: data-pipeline', 'default: ghost')

  test('ghost workflow 的 next → 拒写（结构子集挡不住的引用错，错误清单进异常），不产生文件', async () => {
    await expect(writeTrackRegistry(repoRoot, GHOST_WORKFLOW, CTX)).rejects.toThrow(/完整校验/)
    await expect(writeTrackRegistry(repoRoot, GHOST_WORKFLOW, CTX)).rejects.toThrow(/ghost/)
    await expect(readFile(trackRegistryPath(repoRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('ghost skills.profile 的 next → 拒写', async () => {
    await expect(writeTrackRegistry(repoRoot, GHOST_PROFILE, CTX)).rejects.toThrow(/完整校验/)
    await expect(writeTrackRegistry(repoRoot, GHOST_PROFILE, CTX)).rejects.toThrow(/ghost/)
  })

  test('合同自洽：write 成功过的文件，loadTrackRegistry 同 context 读回永不 fail-loud', async () => {
    const written = await writeTrackRegistry(repoRoot, NEXT, CTX)
    const back = loadTrackRegistry(repoRoot, CTX)
    expect(back.revision).toBe(written.revision)
    expect(back.ordered).toEqual(written.ordered)
  })

  test('现存文件 parse 损坏 → 默认拒绝覆写（文件保持原样），错误指明已损坏', async () => {
    await seedProjectFile(CORRUPT_PARSE)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX)).rejects.toThrow(/已损坏/)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(CORRUPT_PARSE)
  })

  test('现存文件语义损坏（parse 得过、校验不过）→ 同样默认拒绝覆写', async () => {
    await seedProjectFile(CORRUPT_SEMANTIC)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX)).rejects.toThrow(/已损坏/)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(CORRUPT_SEMANTIC)
  })

  test('现存损坏 + expectedRevision → 仍按已损坏拒绝（revision 无从比对）', async () => {
    await seedProjectFile(CORRUPT_PARSE)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX, registryRevision({ version: 1 }))).rejects.toThrow(/已损坏/)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(CORRUPT_PARSE)
  })

  test('repairCorrupt：现存损坏 → 用完整校验过的 next 重建，读回不再 fail-loud', async () => {
    await seedProjectFile(CORRUPT_PARSE)
    const reg = await writeTrackRegistry(repoRoot, NEXT, CTX, undefined, { repairCorrupt: true })
    expect(reg.byId.get('data')?.label).toBe('Data')
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(serializeTrackRegistry(NEXT))
    expect(() => loadTrackRegistry(repoRoot, CTX)).not.toThrow()
  })

  test('repairCorrupt 不豁免 next 校验：坏 next + 坏现存 → 仍拒写', async () => {
    await seedProjectFile(CORRUPT_PARSE)
    await expect(
      writeTrackRegistry(repoRoot, GHOST_WORKFLOW, CTX, undefined, { repairCorrupt: true }),
    ).rejects.toThrow(/完整校验/)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(CORRUPT_PARSE)
  })

  test('repairCorrupt 与 expectedRevision 互斥 → 拒（前提矛盾）', async () => {
    await seedProjectFile(CORRUPT_PARSE)
    await expect(
      writeTrackRegistry(repoRoot, NEXT, CTX, registryRevision({ version: 1 }), { repairCorrupt: true }),
    ).rejects.toThrow(/互斥/)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(CORRUPT_PARSE)
  })

  test('repairCorrupt 但现存文件缺失/健康 → 拒（repair 前提不成立，不当 force 用）', async () => {
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX, undefined, { repairCorrupt: true })).rejects.toThrow(
      /不存在/,
    )
    await writeTrackRegistry(repoRoot, NEXT, CTX)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX, undefined, { repairCorrupt: true })).rejects.toThrow(
      /健康/,
    )
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(serializeTrackRegistry(NEXT))
  })
})

describe('writer 自洽合同回归 —— priority 数域（R2 阻断 1）', () => {
  function withPriority(priority: number): ProjectTrackConfig {
    return {
      version: 1,
      tracks: [
        {
          ...DATA_TRACK,
          policyProfile: { ...DATA_TRACK.policyProfile, routing: { enabled: true, pattern: 'x', priority } },
        },
      ],
    }
  }

  test('1e21 在写闸被 validate 拒，不产生文件（旧破口：写成 priority: 1e+21，load 报「应为整数」自毁）', async () => {
    await expect(writeTrackRegistry(repoRoot, withPriority(1e21), CTX)).rejects.toThrow(/完整校验/)
    await expect(writeTrackRegistry(repoRoot, withPriority(1e21), CTX)).rejects.toThrow(/安全整数/)
    await expect(readFile(trackRegistryPath(repoRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('数域闭合证明：0 / 1 / MAX_SAFE_INTEGER 全链路 write→load 往返成功（收紧后不存在「validate 放行、serialize 防御闸拦」的值）', async () => {
    for (const priority of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const written = await writeTrackRegistry(repoRoot, withPriority(priority), CTX)
      const back = loadTrackRegistry(repoRoot, CTX)
      expect(back.revision).toBe(written.revision)
      expect(back.byId.get('data')?.policyProfile.routing).toEqual({ enabled: true, pattern: 'x', priority })
    }
  })
})

describe('writer 自洽合同回归 —— 可表示域与 revision 归类（R2 阻断 2）', () => {
  const NEXT: ProjectTrackConfig = { version: 1, tracks: [DATA_TRACK] }
  /**
   * parse 接受（裸标量）、serialize 拒写（同含单双引号）的手写文件。修复前 validate 对它零报错
   * ——按文档算「健康」，但 inspectExistingUnderLock 里 registryRevision 内部 serialize 裸抛，
   * 三种参数路径全部失守。构造手法是临时绕过 writer 直接落盘：修复后 validate 会拒它，
   * writer 主闸自己已写不出这种文件。
   */
  const BOTH_QUOTES_FILE = `version: 1\nbuiltins:\n  chat:\n    label: a'b"c\n`
  const TAB_FILE = 'version: 1\nbuiltins:\n  chat:\n    label: a\tb\n'

  test('同含单双引号的现存文件：无参数覆写 → RegistryCorruptFileError（非裸 serialize 异常外泄），文件保持原样', async () => {
    await seedProjectFile(BOTH_QUOTES_FILE)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX)).rejects.toBeInstanceOf(RegistryCorruptFileError)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX)).rejects.toThrow(/已损坏/)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(BOTH_QUOTES_FILE)
  })

  test('同文件 + expectedRevision → 仍按损坏拒绝（revision 无从比对）', async () => {
    await seedProjectFile(BOTH_QUOTES_FILE)
    await expect(
      writeTrackRegistry(repoRoot, NEXT, CTX, registryRevision({ version: 1 })),
    ).rejects.toBeInstanceOf(RegistryCorruptFileError)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(BOTH_QUOTES_FILE)
  })

  test('同文件 + repairCorrupt:true → 用完整校验过的 next 重建成功，读回不再 fail-loud', async () => {
    await seedProjectFile(BOTH_QUOTES_FILE)
    const reg = await writeTrackRegistry(repoRoot, NEXT, CTX, undefined, { repairCorrupt: true })
    expect(reg.byId.get('data')?.label).toBe('Data')
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(serializeTrackRegistry(NEXT))
    expect(() => loadTrackRegistry(repoRoot, CTX)).not.toThrow()
  })

  test('loadTrackRegistry 对该文件 fail-loud：走 validate 拒绝路径（错误点名单双引号），不是裸 serialize 异常', async () => {
    await seedProjectFile(BOTH_QUOTES_FILE)
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(/校验失败/)
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(/单双引号/)
  })

  test('内嵌 tab 的裸标量同病同修：load 走 validate 拒；无参数覆写按损坏拒，文件保持原样', async () => {
    await seedProjectFile(TAB_FILE)
    expect(() => loadTrackRegistry(repoRoot, CTX)).toThrow(/校验失败/)
    await expect(writeTrackRegistry(repoRoot, NEXT, CTX)).rejects.toBeInstanceOf(RegistryCorruptFileError)
    expect(await readFile(trackRegistryPath(repoRoot), 'utf8')).toBe(TAB_FILE)
  })

  test('不可表示值的 next 在写闸被拒（错误清单，而非落盘瞬间 serialize 裸抛），不产生文件', async () => {
    const bad: ProjectTrackConfig = { version: 1, builtins: { chat: { label: `a'b"c` } } }
    await expect(writeTrackRegistry(repoRoot, bad, CTX)).rejects.toThrow(/完整校验/)
    await expect(writeTrackRegistry(repoRoot, bad, CTX)).rejects.toThrow(/单双引号/)
    await expect(readFile(trackRegistryPath(repoRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('registryRevision —— 规范化内容 hash', () => {
  test('16 位 hex；结构等价（插入序不同/空数组 vs 省略）同 hash；不同配置不同 hash', () => {
    expect(registryRevision({ version: 1 })).toMatch(/^[0-9a-f]{16}$/)
    expect(registryRevision({ version: 1, tracks: [] })).toBe(registryRevision({ version: 1 }))
    const a: ProjectTrackConfig = { version: 1, builtins: { pm: { label: 'P' }, chat: { label: 'C' } } }
    const b: ProjectTrackConfig = { version: 1, builtins: { chat: { label: 'C' }, pm: { label: 'P' } } }
    expect(registryRevision(a)).toBe(registryRevision(b))
    expect(registryRevision({ version: 1, tracks: [DATA_TRACK] })).not.toBe(registryRevision({ version: 1 }))
  })
})
