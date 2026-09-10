import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUILTIN_TRACK_DEFINITIONS, type TrackRegistry, type WorkflowDef } from '@tenon/kernel'
import {
  captureWorkflowDeletePermit, captureWorkflowRootAnchor, closeWorkflowRootAnchor, deleteWorkflowForApi,
  listWorkflowNames, MAX_WORKFLOW_DEFINITION_BYTES, readBoundedWorkflowSource, readWorkflowForApi,
  scanWorkflowReferencesForApi, writeWorkflowForApi,
  WorkflowDeleteConflictError, WorkflowNotFoundError, WorkflowPathError, WorkflowReadError,
} from './workflows.js'

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wf-server-'))
}

function builtinTrackRegistry(): TrackRegistry {
  const ordered = [...BUILTIN_TRACK_DEFINITIONS]
  return {
    ordered,
    byId: new Map(ordered.map((track) => [track.id, track])),
    revision: 'test',
    source: 'builtin-only',
  }
}

const VALID_WF = `name: onboarding
steps:
  - id: intake
    label: intake
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('listWorkflowNames', () => {
  it('无 .pipeline/workflows 目录 → 空数组（不抛错）', async () => {
    const root = await tempRoot()
    expect(listWorkflowNames(root)).toEqual([])
  })

  it('真扫 *.yaml 文件名（去扩展名），default 的项目覆盖文件一并列出', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'onboarding.yaml'), VALID_WF, 'utf8')
    await writeFile(join(dir, 'release.yaml'), VALID_WF.replace('onboarding', 'release'), 'utf8')
    await writeFile(join(dir, 'default.yaml'), VALID_WF.replace('onboarding', 'default'), 'utf8')
    expect(listWorkflowNames(root).sort()).toEqual(['default', 'onboarding', 'release'])
  })

  it('.pipeline 换成指向 root 外的 symlink → 拒绝，绝不列出外部 workflow', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await mkdir(join(outside, 'workflows'))
    await writeFile(join(outside, 'workflows', 'outside.yaml'), VALID_WF.replace('onboarding', 'outside'), 'utf8')
    await symlink(outside, join(root, '.pipeline'), 'dir')

    expect(() => listWorkflowNames(root)).toThrow()
  })
})

describe('readWorkflowForApi', () => {
  it('真读 + 解析，返回 WorkflowDef', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'onboarding.yaml'), VALID_WF, 'utf8')
    const wf = readWorkflowForApi(root, 'onboarding')
    expect(wf.name).toBe('onboarding')
    expect(wf.steps.map((s) => s.id)).toEqual(['intake', 'done'])
  })

  it('在 parse 前拒绝超过硬上限的 workflow 文件', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'onboarding.yaml'), Buffer.alloc(MAX_WORKFLOW_DEFINITION_BYTES + 1, 0x61))

    expect(() => readWorkflowForApi(root, 'onboarding')).toThrow(WorkflowReadError)
  })

  it('workflow 在 fstat 后增长时仍由 max + 1 fd 读取拒绝', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    const target = join(dir, 'onboarding.yaml')
    await mkdir(dir, { recursive: true })
    await writeFile(target, VALID_WF, 'utf8')

    expect(() => readWorkflowForApi(root, 'onboarding', (fd, maxBytes) => {
      writeFileSync(target, Buffer.alloc(maxBytes + 1, 0x61))
      return readBoundedWorkflowSource(fd, maxBytes)
    })).toThrow(WorkflowReadError)
  })

  it('workflow 目标换成指向 root 外文件的 symlink → 拒绝，绝不读取外部 YAML', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    const outsideFile = join(outside, 'victim.yaml')
    await mkdir(dir, { recursive: true })
    await writeFile(outsideFile, VALID_WF.replace('onboarding', 'victim'), 'utf8')
    await symlink(outsideFile, join(dir, 'victim.yaml'), 'file')

    expect(() => readWorkflowForApi(root, 'victim')).toThrow(WorkflowPathError)
  })

  it.runIf(process.getuid?.() !== 0)('in-root workflow 不可读时归类为 read error，不误报 path violation', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    const target = join(dir, 'onboarding.yaml')
    await mkdir(dir, { recursive: true })
    await writeFile(target, VALID_WF, 'utf8')
    await chmod(target, 0o000)
    try {
      expect(() => readWorkflowForApi(root, 'onboarding')).toThrow(WorkflowReadError)
    } finally {
      await chmod(target, 0o600)
    }
  })

  it('workflow FIFO 非阻塞地拒绝为不可信普通文件', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await execFileAsync('mkfifo', [join(dir, 'onboarding.yaml')])

    expect(() => readWorkflowForApi(root, 'onboarding')).toThrow(WorkflowPathError)
  })

  it('文件不存在 → 抛错（路由层负责转 404）', async () => {
    const root = await tempRoot()
    expect(() => readWorkflowForApi(root, 'ghost')).toThrow()
  })

  it('文件不存在 → 抛的具体是 WorkflowNotFoundError（round 2 review fix：路由层靠 instanceof 判 404，不再摸错误文本子串）', async () => {
    const root = await tempRoot()
    expect(() => readWorkflowForApi(root, 'ghost')).toThrow(WorkflowNotFoundError)
  })

  it('非法 workflow 文件（transitions.to 指向不存在的 step）→ 安全读后 validateWorkflow 抛错，路由层负责转 500', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'broken.yaml'),
      `name: broken\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions:\n      - event: go\n        to: does-not-exist\n`,
      'utf8',
    )
    expect(() => readWorkflowForApi(root, 'broken')).toThrow(/does-not-exist/)
  })

  it('非法 workflow 文件且错误信息恰好含"未找到"字样（用户自起的 transition 目标名）→ 抛的不是 WorkflowNotFoundError（round 2 review fix：证明分类不能靠子串匹配，只能靠类型）', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'broken2.yaml'),
      `name: broken2\nsteps:\n  - id: s1\n    label: x\n    gate: null\n    skills: []\n    inputs: []\n    outputs: []\n    guards: []\n    transitions:\n      - event: go\n        to: 未找到\n`,
      'utf8',
    )
    let caught: unknown
    try {
      readWorkflowForApi(root, 'broken2')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('未找到') // 校验错误消息恰好含这个子串（用户自己起的 transition 目标名）
    expect(caught).not.toBeInstanceOf(WorkflowNotFoundError) // 但类型上不是"未找到"错误——它是一次真实的校验失败
  })
})

const VALID_DEF: WorkflowDef = {
  name: 'onboarding',
  steps: [
    { id: 'intake', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 'done' }] },
    { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
  ],
}

const INVALID_DEF: WorkflowDef = {
  name: 'broken',
  steps: [
    { id: 's1', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'go', to: 'does-not-exist' }] },
  ],
}

function workflowWithTrackReferences(
  name: string,
  stepTrack: string,
  edgeTrack: string,
  artifactTrack: string,
): WorkflowDef {
  return {
    name,
    steps: [
      {
        id: 'build',
        label: '',
        gate: null,
        skills: [],
        inputs: [],
        outputs: [{ field: 'plan', type: 'file_path' }],
        artifacts: [{
          field: 'plan',
          type: 'file_path',
          producerPolicy: 'effective-step-skills',
          requiredWhen: { kind: 'track-in', values: [artifactTrack] },
        }],
        guards: [{ type: 'full-direct-override', when: { kind: 'track-in', values: [stepTrack] } }],
        transitions: [{
          event: 'done',
          to: 'done',
          guards: [{
            type: 'field-nonempty',
            field: 'plan',
            when: { kind: 'track-not-in', values: [edgeTrack] },
          }],
        }],
      },
      { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
    ],
  }
}

describe('writeWorkflowForApi', () => {
  it('安全完整 definition API 原子往返 decomposition/interaction', async () => {
    const root = await tempRoot()
    const policyDefinition: WorkflowDef = {
      ...VALID_DEF,
      decomposition: {
        version: 'v1', mode: 'auto-safe', target: 'child-pipelines', strategy: 'depth-first',
        max_items: 6, max_depth: 3,
        auto_when: ['independent-work-items', 'context-budget-risk'],
        ask_when: ['hard-boundary', 'missing-authorization'],
      },
      interaction: { version: 'v1', mode: 'recommended-defaults' },
    }

    expect(writeWorkflowForApi(root, 'onboarding', policyDefinition)).toEqual({ ok: true })
    expect(readWorkflowForApi(root, 'onboarding')).toEqual(policyDefinition)
  })

  it('非法 policy 拒绝且现有 definition 字节不变', async () => {
    const root = await tempRoot()
    expect(writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toEqual({ ok: true })
    const target = join(root, '.pipeline', 'workflows', 'onboarding.yaml')
    const before = await readFile(target, 'utf8')
    const invalid = {
      ...VALID_DEF,
      decomposition: { version: 'v1', mode: 'auto-safe', max_items: 99, surprise: true },
    } as unknown as WorkflowDef

    const result = writeWorkflowForApi(root, 'onboarding', invalid)

    expect(result).toMatchObject({ ok: false })
    expect(await readFile(target, 'utf8')).toBe(before)
  })

  it('T-R7 create：step guard、edge guard、artifact requiredWhen 引用未知动态 track → 聚合拒写', async () => {
    const root = await tempRoot()
    const result = writeWorkflowForApi(
      root,
      'dynamic-refs',
      workflowWithTrackReferences('dynamic-refs', 'ghost-step', 'ghost-edge', 'ghost-artifact'),
    )

    expect(result).toEqual({
      ok: false,
      errors: [
        "workflow.steps[0].guards[0].when.values[0]: 未知 track 'ghost-step'",
        "workflow.steps[0].transitions[0].guards[0].when.values[0]: 未知 track 'ghost-edge'",
        "workflow.steps[0].artifacts[0].requiredWhen.values[0]: 未知 track 'ghost-artifact'",
      ],
    })
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, '.pipeline', 'workflows', 'dynamic-refs.yaml'))).toBe(false)
  })

  it('T-R7 create：三个引用路径都指向 tracks.yaml 中真实动态 track → 保存成功', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: mobile
    label: Mobile
    workflow:
      default: default
      allowed: '*'
    policy_profile:
      review_seed: pending
      automation_eligible: true
      coverage_profile: backend
      routing:
        enabled: false
      skills:
        matrix: true
        profile: backend
`, 'utf8')

    expect(writeWorkflowForApi(
      root,
      'dynamic-refs',
      workflowWithTrackReferences('dynamic-refs', 'mobile', 'mobile', 'mobile'),
    )).toEqual({ ok: true })
    expect(await readFile(join(root, '.pipeline', 'workflows', 'dynamic-refs.yaml'), 'utf8')).toContain(
      'track_in: [mobile]',
    )
  })

  it('T-R7 create：tracks.yaml 无法形成可信 track-id 快照 → fail-loud 且不落 workflow', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'tracks.yaml'), `version: 1
tracks:
  - id: half-configured
`, 'utf8')

    const result = writeWorkflowForApi(root, 'onboarding', VALID_DEF)

    expect(result.ok).toBe(false)
    expect((result as { ok: false; errors: string[] }).errors).toEqual(expect.arrayContaining([
      expect.stringContaining('.pipeline/tracks.yaml'),
      expect.stringContaining('policy_profile'),
    ]))
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, '.pipeline', 'workflows', 'onboarding.yaml'))).toBe(false)
  })

  it('T-R7 update：新定义出现未知动态 track → 拒绝且旧 workflow 字节不变', async () => {
    const root = await tempRoot()
    expect(writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toEqual({ ok: true })
    const target = join(root, '.pipeline', 'workflows', 'onboarding.yaml')
    const before = await readFile(target, 'utf8')

    const result = writeWorkflowForApi(
      root,
      'onboarding',
      workflowWithTrackReferences('onboarding', 'backend', 'frontend', 'removed-track'),
    )

    expect(result).toEqual({
      ok: false,
      errors: ["workflow.steps[0].artifacts[0].requiredWhen.values[0]: 未知 track 'removed-track'"],
    })
    expect(await readFile(target, 'utf8')).toBe(before)
  })

  it('当前 schema 不允许伪造 workflow→workflow 边：transition.to 即使等于现存 workflow 名也须是本表 step', async () => {
    const root = await tempRoot()
    expect(writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toEqual({ ok: true })
    const caller: WorkflowDef = {
      name: 'caller',
      steps: [{
        id: 'start', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [],
        transitions: [{ event: 'delegate', to: 'onboarding' }],
      }],
    }

    const result = writeWorkflowForApi(root, 'caller', caller)

    expect(result.ok).toBe(false)
    expect((result as { ok: false; errors: string[] }).errors).toContain(
      "step 'start' 的 transitions 里 event 'delegate' 的 to 'onboarding' 不存在",
    )
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, '.pipeline', 'workflows', 'caller.yaml'))).toBe(false)
    expect(existsSync(join(root, '.pipeline', 'workflows', 'onboarding.yaml'))).toBe(true)
  })

  it('合法 WorkflowDef → 真原子写入 .pipeline/workflows/<name>.yaml，{ok:true}', async () => {
    const root = await tempRoot()
    const result = writeWorkflowForApi(root, 'onboarding', VALID_DEF)
    expect(result).toEqual({ ok: true })
    const content = await readFile(join(root, '.pipeline', 'workflows', 'onboarding.yaml'), 'utf8')
    expect(content).toContain('name: onboarding')
    expect(content).toContain('- id: intake')
  })

  it('重复提交同一 create/update 请求保持既有覆盖语义：两次均 {ok:true}，规范化字节一致', async () => {
    const root = await tempRoot()
    expect(writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toEqual({ ok: true })
    const target = join(root, '.pipeline', 'workflows', 'onboarding.yaml')
    const first = await readFile(target, 'utf8')

    expect(writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toEqual({ ok: true })
    expect(await readFile(target, 'utf8')).toBe(first)
  })

  it('非法 WorkflowDef（validateWorkflow 拒绝）→ {ok:false, errors} + 不落盘', async () => {
    const root = await tempRoot()
    const result = writeWorkflowForApi(root, 'broken', INVALID_DEF)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; errors: string[] }).errors.some((e) => e.includes('does-not-exist'))).toBe(true)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, '.pipeline', 'workflows', 'broken.yaml'))).toBe(false)
  })

  it('已存在的 workflow → 覆盖（新建和编辑共用同一函数）', async () => {
    const root = await tempRoot()
    writeWorkflowForApi(root, 'onboarding', VALID_DEF)
    const updated: WorkflowDef = { ...VALID_DEF, name: 'onboarding', steps: [...VALID_DEF.steps, { id: 'extra', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }] }
    // extra 挂在末尾、done 仍是最后一个真正的终态——为了合法（非终态必须有 transitions），
    // 这里改成 done 指向 extra，extra 作真正终态
    const updatedValid: WorkflowDef = {
      name: 'onboarding',
      steps: [
        { id: 'intake', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'complete', to: 'done' }] },
        { id: 'done', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [{ event: 'next', to: 'extra' }] },
        { id: 'extra', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] },
      ],
    }
    const result = writeWorkflowForApi(root, 'onboarding', updatedValid)
    expect(result).toEqual({ ok: true })
    const content = await readFile(join(root, '.pipeline', 'workflows', 'onboarding.yaml'), 'utf8')
    expect(content).toContain('- id: extra')
  })

  it('临时文件创建后发现正式目标不安全 → 失败且目标目录/sentinel 不变、无 tmp 残留', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pipeline', 'workflows')
    const target = join(dir, 'onboarding.yaml')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'sentinel'), 'keep target', 'utf8')

    expect(() => writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toThrow()
    expect((await lstat(target)).isDirectory()).toBe(true)
    expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('keep target')
    expect((await readdir(dir)).some((entry) => entry.includes('.tmp.'))).toBe(false)
  })
})

describe('deleteWorkflowForApi', () => {
  it('真删存在的文件 → true', async () => {
    const root = await tempRoot()
    writeWorkflowForApi(root, 'onboarding', VALID_DEF)
    expect(deleteWorkflowForApi(root, 'onboarding')).toBe(true)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, '.pipeline', 'workflows', 'onboarding.yaml'))).toBe(false)
  })

  it('文件不存在 → false（不抛错）', async () => {
    const root = await tempRoot()
    expect(deleteWorkflowForApi(root, 'ghost')).toBe(false)
  })

  it('重复删除保持既有幂等分类：第一次 true，第二次 false', async () => {
    const root = await tempRoot()
    expect(writeWorkflowForApi(root, 'onboarding', VALID_DEF)).toEqual({ ok: true })

    expect(deleteWorkflowForApi(root, 'onboarding')).toBe(true)
    expect(deleteWorkflowForApi(root, 'onboarding')).toBe(false)
  })

  it('T-R7 inode CAS：扫描前 permit 钉住旧目标；扫描期间被原子覆盖 → 拒删新 inode', async () => {
    const root = await tempRoot()
    writeWorkflowForApi(root, 'onboarding', VALID_DEF)
    const permit = captureWorkflowDeletePermit(root, 'onboarding')
    expect(permit).not.toBeNull()

    const replacement: WorkflowDef = {
      ...VALID_DEF,
      steps: [{ id: 'replacement', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }
    expect(writeWorkflowForApi(root, 'onboarding', replacement)).toEqual({ ok: true })

    expect(() => deleteWorkflowForApi(root, 'onboarding', permit!)).toThrow(WorkflowDeleteConflictError)
    expect(readWorkflowForApi(root, 'onboarding').steps[0]!.id).toBe('replacement')
  })
})

describe('scanWorkflowReferencesForApi', () => {
  it('T-R7 delete：loops.yaml 的持久 workflow_id binding 被列为删除引用', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.pipeline'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'loops.yaml'), `version: 1
loops:
  - id: release-loop
    name: Release loop
    kind: orchestrator
    goal: Keep releases moving
    cadence: 1h
    risk: medium
    runner: codex
    change_prefix: release-
    phases: [build, verify]
    human_gates: [manual-review]
    state: .superpowers/loops/progress.md
    design_doc: docs/release.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 1
      on_exceed: skip
    kill_criteria: [manual-stop]
    autonomy_level: L2
    template_id: daily-triage
    template_version: 1
    workflow_id: onboarding
`, 'utf8')
    const anchor = captureWorkflowRootAnchor(root)
    try {
      const scan = scanWorkflowReferencesForApi(anchor, 'onboarding', builtinTrackRegistry())

      expect(scan).toEqual({
        references: [{ kind: 'loop-binding', source: 'loop:release-loop' }],
        blockers: [],
      })
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('T-R7 delete：automation policy template 的 recommendedWorkflow 进入统一引用图', async () => {
    const root = await tempRoot()
    const anchor = captureWorkflowRootAnchor(root)
    try {
      const scan = scanWorkflowReferencesForApi(anchor, 'default', builtinTrackRegistry())
      const templates = scan.references.filter((reference) => reference.kind === 'policy-template-recommended')

      expect(scan.blockers).toEqual([])
      expect(templates).toHaveLength(7)
      expect(templates).toEqual(expect.arrayContaining([
        { kind: 'policy-template-recommended', source: 'template:daily-triage' },
        { kind: 'policy-template-recommended', source: 'template:pr-babysitter' },
      ]))
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })
})

describe('production dist smoke', () => {
  it('T-R7/Codex r1：真实 Node 可加载 server dist/workflows.js，不残留跨包 src/*.js 路径', async () => {
    await expect(execFileAsync(process.execPath, [
      '-e', "import('./packages/server/dist/workflows.js')",
    ], { cwd: REPO_ROOT })).resolves.toMatchObject({ stderr: '' })
  })
})
