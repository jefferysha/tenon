import {
  copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QuoteGateError, type StateStore } from '../types.js'
import {
  WORKFLOW_GOVERNANCE_BINDING_FILE,
  atomicWriteFile,
  createStateStore,
  ensureDocumentLocalePin,
} from './index.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const CLOCK = () => '2026-07-06T00:00:00Z'

let repoRoot: string
let store: StateStore

async function seedChange(name: string, fixture: string): Promise<string> {
  const changeDir = path.join(repoRoot, 'openspec', 'changes', name)
  await mkdir(changeDir, { recursive: true })
  await copyFile(path.join(FIXTURES, fixture), path.join(changeDir, '.pipeline.yaml'))
  return changeDir
}

function stripProjectionMetadata(raw: string): string {
  return raw.replace(
    /^pipeline_state_revision: \d+\npipeline_state_revision_id: [A-Za-z0-9_-]+\npipeline_state_digest: [0-9a-f]{64}\n/m,
    '',
  )
}

function stripRollbackProjectionEnvelope(raw: string): string {
  return stripProjectionMetadata(raw).replace(
    /^# tenon-internal-pre-verify-review-v1: [A-Za-z0-9_-]+\n/m,
    '',
  )
}

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(tmpdir(), 'pl-store-'))
  store = createStateStore()
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('read / write / get', () => {
  it('init 提交点出现空目录竞态时 fail-loud，且不得用 POSIX rename 静默替换竞态方目录', async () => {
    const raced = createStateStore({
      beforeInitialPublish: async (_staging, finalChangeDir) => {
        await mkdir(finalChangeDir)
      },
    })

    await expect(raced.init({
      repoRoot,
      name: 'empty-directory-race',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock: CLOCK,
      initialFiles: [{ relativePath: 'proposal.md', content: '# 不得发布\n' }],
    })).rejects.toThrow(/已存在|拒绝覆盖/)

    expect(await readdir(path.join(
      repoRoot, 'openspec', 'changes', 'empty-directory-race',
    ))).toEqual([])
  })

  it('init 完整候选遇到提交点竞态 symlink 时 fail-loud，外部目录保持零写入', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'pl-store-outside-'))
    const raced = createStateStore({
      beforeInitialPublish: async (_staging, finalChangeDir) => {
        await symlink(outside, finalChangeDir)
      },
    })

    await expect(raced.init({
      repoRoot,
      name: 'atomic-envelope',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      clock: CLOCK,
      initialFiles: [
        { relativePath: 'proposal.md', content: '# 提案\n' },
        { relativePath: 'nested/tasks.md', content: '# 任务\n' },
      ],
    })).rejects.toThrow(/已存在|拒绝覆盖/)

    expect((await lstat(path.join(repoRoot, 'openspec', 'changes', 'atomic-envelope')))
      .isSymbolicLink()).toBe(true)
    expect(await readdir(outside)).toEqual([])
    await rm(outside, { recursive: true, force: true })
  })

  it('read 解析 legacy 文件；write 迁入 canonical 后用 rollback envelope 保持其余字节等价', async () => {
    const dir = await seedChange('rt', 'dashboard-interaction-fixes.pipeline.yaml')
    const before = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    const state = await store.read(dir)
    await store.write(dir, state)
    const after = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    expect(stripRollbackProjectionEnvelope(after)).toBe(before)
  })

  it('get 返回裸值（去引号后）；列表字段返回数组', async () => {
    const dir = await seedChange('g', 'synthetic-lists.pipeline.yaml')
    expect(await store.get(dir, 'track')).toBe('backend')
    expect(await store.get(dir, 'automation_sandbox')).toBe('')
    expect(await store.get(dir, 'scope')).toEqual(['packages/kernel', 'packages/cli'])
    expect(await store.get(dir, 'spec_scope')).toEqual([])
  })

  it('read 不存在的 change → 抛 ENOENT', async () => {
    await expect(store.read(path.join(repoRoot, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('set / setMany / cas', () => {
  it('G1 崩溃点：current 已提交但 YAML projection 写失败 → mutation 仍成功可读、状态标 stale；repair 幂等前滚', async () => {
    let failProjection = false
    const injected = createStateStore({
      writeProjection: async (target, content) => {
        if (failProjection) throw new Error('injected projection failure')
        await atomicWriteFile(target, content)
      },
    })
    const dir = await injected.init({
      repoRoot, name: 'projection-failure', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: CLOCK,
    })
    const yamlPath = path.join(dir, '.pipeline.yaml')
    const beforeYaml = await readFile(yamlPath, 'utf8')

    failProjection = true
    const state = await injected.read(dir)
    state.fields.phase = 'explore'
    const outcome = await injected.write(dir, state, { kind: 'set' })

    expect(outcome.projection).toMatchObject({ status: 'pending' })
    expect(await injected.get(dir, 'phase')).toBe('explore')
    expect(await readFile(yamlPath, 'utf8')).toBe(beforeYaml)
    expect(await injected.inspectProjection(dir)).toMatchObject({ status: 'stale' })

    failProjection = false
    await expect(injected.repairProjection(dir)).resolves.toMatchObject({ status: 'current' })
    expect(await readFile(yamlPath, 'utf8')).toContain('phase: explore\n')
    await expect(injected.repairProjection(dir)).resolves.toMatchObject({ status: 'current' })
  })

  it('G1 双主处置：未知 YAML drift 默认拒修；legacy import 保留 transition-controlled fields', async () => {
    const dir = await store.init({
      repoRoot, name: 'projection-import', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: CLOCK,
    })
    const yamlPath = path.join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    await writeFile(yamlPath, yaml.replace('phase: open\n', 'phase: explore\n'), 'utf8')

    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'drift' })
    await expect(store.repairProjection(dir)).rejects.toThrow(/drift|漂移/i)
    const imported = await store.importLegacyProjection(dir)

    expect(imported.projection).toMatchObject({ status: 'updated' })
    expect(imported.ignoredProtectedFields).toEqual(['phase'])
    expect(await store.get(dir, 'phase')).toBe('open')
    const current = JSON.parse(await readFile(path.join(dir, '.pipeline-run', 'current.json'), 'utf8')) as {
      revision: number
      mutation: { kind: string }
    }
    expect(current.revision).toBe(1)
    expect(current.mutation.kind).toBe('legacy-import')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
  })

  it('G1 canonical mutation：legacy YAML 首次 set 先固化 migration revision 0，再以 revision 1 提交并刷新投影', async () => {
    const dir = await seedChange('canonical-set', 'zz-container-e2e.pipeline.yaml')
    await store.set(dir, 'phase', 'verify')

    const runDir = path.join(dir, '.pipeline-run')
    const current = JSON.parse(await readFile(path.join(runDir, 'current.json'), 'utf8')) as {
      revision: number
      revisionId: string
      previousRevisionId?: string
      mutation: { kind: string }
      state: { fields: { phase: string } }
    }
    expect(current).toMatchObject({
      revision: 1,
      mutation: { kind: 'set' },
      state: { fields: { phase: 'verify' } },
    })
    expect(current.previousRevisionId).toMatch(/^[A-Za-z0-9_-]+$/)
    const revisionFiles = (await readdir(path.join(runDir, 'revisions'))).sort()
    expect(revisionFiles).toHaveLength(2)
    expect(revisionFiles[0]).toMatch(/^000000-/)
    expect(revisionFiles[1]).toBe(`000001-${current.revisionId}.json`)
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toContain('phase: verify\n')
  })

  it('G1 写兼容断代：YAML projection 带 revision/id/digest；旧 writer 篡改后下一次官方写 fail-loud 且 canonical 零推进', async () => {
    const dir = await store.init({
      repoRoot, name: 'projection-drift', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: CLOCK, runId: 'run-projection-drift',
    })
    const currentPath = path.join(dir, '.pipeline-run', 'current.json')
    const beforeCurrent = await readFile(currentPath, 'utf8')
    const current = JSON.parse(beforeCurrent) as { revision: number; revisionId: string; stateDigest: string }
    const yamlPath = path.join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    expect(yaml).toContain(`pipeline_state_revision: ${current.revision}\n`)
    expect(yaml).toContain(`pipeline_state_revision_id: ${current.revisionId}\n`)
    expect(yaml).toContain(`pipeline_state_digest: ${current.stateDigest}\n`)

    await writeFile(yamlPath, yaml.replace('phase: open\n', 'phase: ship\n'), 'utf8')
    await expect(store.set(dir, 'plan', 'must-not-land')).rejects.toThrow(/projection.*drift|投影.*漂移/i)
    expect(await readFile(currentPath, 'utf8')).toBe(beforeCurrent)
    expect(await store.get(dir, 'plan')).toBe('null')
  })

  it('set 只改目标字段，历史区与其余字段逐字保留', async () => {
    const dir = await seedChange('s', 'zz-container-e2e.pipeline.yaml')
    const before = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    await store.set(dir, 'phase', 'verify')
    const after = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    expect(stripRollbackProjectionEnvelope(after)).toBe(
      before.replace('phase: build\n', 'phase: verify\n'),
    )
  })

  it('set 列表字段为数组 → 块序列；空数组 → []', async () => {
    const dir = await seedChange('sl', 'zz-container-e2e.pipeline.yaml')
    await store.set(dir, 'scope', ['a', 'b'])
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toContain('scope:\n  - a\n  - b\n')
    await store.set(dir, 'scope', [])
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toContain('scope: []\n')
  })

  it.each([
    ['冒号+空格', 'x: y'],
    ['空格+井号', 'x #y'],
    ['换行', 'x\ny'],
    ['首字符引号', '"x'],
  ])('四闸注入 set（%s）→ throw QuoteGateError 且文件零改动', async (_label, bad) => {
    const dir = await seedChange('gate', 'zz-container-e2e.pipeline.yaml')
    const before = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    await expect(store.set(dir, 'plan', bad)).rejects.toThrow(QuoteGateError)
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toBe(before)
  })

  it('setMany 原子批量；任一值触闸 → 整批拒绝零落盘', async () => {
    const dir = await seedChange('sm', 'zz-container-e2e.pipeline.yaml')
    await store.setMany(dir, { phase: 'verify', verify_result: 'pass' })
    expect(await store.get(dir, 'phase')).toBe('verify')
    expect(await store.get(dir, 'verify_result')).toBe('pass')

    const before = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    await expect(store.setMany(dir, { phase: 'ship', plan: 'bad: value' })).rejects.toThrow(QuoteGateError)
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toBe(before)
  })

  it('cas：expect 命中 → 写入返回 true；不命中 → 不写返回 false', async () => {
    const dir = await seedChange('cas', 'zz-container-e2e.pipeline.yaml')
    expect(await store.cas(dir, 'phase', 'build', 'verify')).toBe(true)
    expect(await store.get(dir, 'phase')).toBe('verify')
    const before = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    expect(await store.cas(dir, 'phase', 'build', 'ship')).toBe(false)
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toBe(before)
  })

  it('casMany：guard 任一期望值命中时整批原子提交；不命中或触闸时零写入', async () => {
    const dir = await seedChange('cas-many', 'zz-container-e2e.pipeline.yaml')
    await store.set(dir, 'automation', 'scheduled')
    expect(await store.casMany(dir, 'automation', ['running', 'scheduled'], {
      automation: 'paused', automation_cause: 'skill-bundle-snapshot-io', automation_last_error: 'disk full',
    })).toBe(true)
    expect(await store.get(dir, 'automation')).toBe('paused')
    expect(await store.get(dir, 'automation_cause')).toBe('skill-bundle-snapshot-io')
    expect(await store.get(dir, 'automation_last_error')).toBe('disk full')

    const beforeMiss = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    expect(await store.casMany(dir, 'automation', ['running', 'scheduled'], {
      automation: 'failed', automation_cause: 'must-not-land',
    })).toBe(false)
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toBe(beforeMiss)

    await expect(store.casMany(dir, 'automation', ['paused'], {
      automation: 'failed', automation_last_error: 'bad: value',
    })).rejects.toThrow(QuoteGateError)
    expect(await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')).toBe(beforeMiss)
  })
})

describe('init（heredoc 语义）', () => {
  const HEREDOC = `track: backend
preset: full
created_by: Tester <tester@tenon.test>
assignee: Tester <tester@tenon.test>
phase: open
phase_status: pending
design_doc: null
plan: null
verification_report: null
build_mode: null
isolation: null
build_sha: null
agent_review_result: pending
codex_review_result: pending
verify_result: pending
branch_status: pending
direct_override: false
prd_path: null
pr_url: null
automation: off
automation_queued_at: ""
automation_sandbox: ""
automation_worktree: ""
automation_attempts: 0
automation_last_error: ""
automation_preserved_path: ""
branch: null
base_branch: main
scope: null
related_files: null
spec_scope: null
depends_on: null
created_at: 2026-07-06T00:00:00Z
updated_at: 2026-07-06T00:00:00Z
verified_at: null
archived_at: null
archived: false
workflow: default
automation_current_phase: ""
automation_cause: ""
pre_verify_review_result: pending
`

  it('建 change 骨架：目录 + .pipeline.yaml 与老仓 heredoc 逐字节一致（注入时钟）', async () => {
    const dir = await store.init({ repoRoot, name: 'my-change', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    expect(dir).toBe(path.join(repoRoot, 'openspec', 'changes', 'my-change'))
    expect(stripRollbackProjectionEnvelope(
      await readFile(path.join(dir, '.pipeline.yaml'), 'utf8'),
    )).toBe(HEREDOC.replace('pre_verify_review_result: pending\n', ''))
  })

  it('运行时缺 reviewSeed 不得发布一份下一次读必坏的 canonical current', async () => {
    const malformed = {
      repoRoot, name: 'missing-review-seed', track: 'backend', creator: TEST_CREATOR, preset: 'full', clock: CLOCK,
    } as unknown as Parameters<StateStore['init']>[0]
    await expect(store.init(malformed)).rejects.toThrow('canonical state.fields.agent_review_result 类型非法')
    await expect(readFile(path.join(
      repoRoot, 'openspec', 'changes', 'missing-review-seed', '.pipeline-run', 'current.json',
    ), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('G1 canonical cutover：init 同时发布 revision 0/current；YAML 后续被旧 writer 篡改也不反向覆盖官方读', async () => {
    const dir = await store.init({
      repoRoot, name: 'canonical-init', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: CLOCK, runId: 'run-canonical-init',
    })
    const currentPath = path.join(dir, '.pipeline-run', 'current.json')
    const currentRaw = await readFile(currentPath, 'utf8')
    const current = JSON.parse(currentRaw) as {
      schemaVersion: number
      revision: number
      revisionId: string
      state: { fields: { phase: string } }
    }
    expect(current).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      state: { fields: { phase: 'open' } },
    })
    expect(await readFile(path.join(
      dir, '.pipeline-run', 'revisions', `000000-${current.revisionId}.json`,
    ), 'utf8')).toBe(currentRaw)

    const yamlPath = path.join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    await writeFile(yamlPath, yaml.replace('phase: open\n', 'phase: ship\n'), 'utf8')
    expect(await store.get(dir, 'phase')).toBe('open')
  })

  it('pm track → agent/codex review 种为 skipped', async () => {
    const dir = await store.init({ repoRoot, name: 'pm-change', track: 'pm', reviewSeed: 'skipped', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    expect(await store.get(dir, 'agent_review_result')).toBe('skipped')
    expect(await store.get(dir, 'codex_review_result')).toBe('skipped')
  })

  it('reviewSeed=skipped 与 track id 无关：动态 track 的双 review 初值也为 skipped', async () => {
    const dir = await store.init({
      repoRoot,
      name: 'policy-skipped',
      track: 'data',
      creator: TEST_CREATOR, preset: 'full',
      reviewSeed: 'skipped',
      clock: CLOCK,
    })
    expect(await store.get(dir, 'agent_review_result')).toBe('skipped')
    expect(await store.get(dir, 'codex_review_result')).toBe('skipped')
  })

  it('creator 同时写入 created_by 与 assignee（Name <id> 用户引用，随单次原子发布落盘）', async () => {
    const dir = await store.init({ repoRoot, name: 'u1', track: 'backend', reviewSeed: 'pending', preset: 'full', creator: { id: 'host@x.io', name: 'Host Dev', trust: 'declared' }, clock: CLOCK })
    expect(await store.get(dir, 'created_by')).toBe('Host Dev <host@x.io>')
    expect(await store.get(dir, 'assignee')).toBe('Host Dev <host@x.io>')
  })

  it('creator 引用触发 YAML 四闸 → init 失败且不留下 change', async () => {
    await expect(store.init({ repoRoot, name: 'u2', track: 'backend', reviewSeed: 'pending', preset: 'full', creator: { id: 'evil@x.io', name: 'Evil: Dev', trust: 'declared' }, clock: CLOCK })).rejects.toThrow(QuoteGateError)
    await expect(store.get(path.join(repoRoot, 'openspec', 'changes', 'u2'), 'created_by')).rejects.toThrow()
  })

  it('base_branch 读 .git/HEAD 的当前分支；无 git 回退 main', async () => {
    await mkdir(path.join(repoRoot, '.git'), { recursive: true })
    await writeFile(path.join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/feat/wave1\n')
    const dir = await store.init({ repoRoot, name: 'b1', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    expect(await store.get(dir, 'base_branch')).toBe('feat/wave1')
  })

  it('B8：worktree 内 .git 为文件(gitdir 指针)→ 解析指针读真 HEAD（automation 用 worktree，勿静默回退 main）', async () => {
    const gitdir = path.join(repoRoot, 'mainrepo', '.git', 'worktrees', 'wt1')
    await mkdir(gitdir, { recursive: true })
    await writeFile(path.join(gitdir, 'HEAD'), 'ref: refs/heads/afk/wave2\n')
    // worktree 根的 .git 是文件，内容是 `gitdir: <path>` 指针
    await writeFile(path.join(repoRoot, '.git'), `gitdir: ${gitdir}\n`)
    const dir = await store.init({ repoRoot, name: 'wtc', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    expect(await store.get(dir, 'base_branch')).toBe('afk/wave2')
  })

  it('B8：.git 指针 detached（gitdir/HEAD 无 ref:）→ 回退 main（不阻断 init）', async () => {
    const gitdir = path.join(repoRoot, 'mainrepo', '.git', 'worktrees', 'wt2')
    await mkdir(gitdir, { recursive: true })
    await writeFile(path.join(gitdir, 'HEAD'), 'a1b2c3d4e5f6\n') // detached：裸 sha
    await writeFile(path.join(repoRoot, '.git'), `gitdir: ${gitdir}\n`)
    const dir = await store.init({ repoRoot, name: 'wtd', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    expect(await store.get(dir, 'base_branch')).toBe('main')
  })

  it('非法 change 名（空/怪字符/..）→ 拒绝', async () => {
    await expect(store.init({ repoRoot, name: '', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })).rejects.toThrow()
    await expect(store.init({ repoRoot, name: 'a/b', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })).rejects.toThrow()
    await expect(store.init({ repoRoot, name: '..', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })).rejects.toThrow()
  })

  it('已初始化的 change → fail-loud 拒绝（不覆盖既有状态）', async () => {
    await store.init({ repoRoot, name: 'dup', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    await expect(store.init({ repoRoot, name: 'dup', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })).rejects.toThrow()
  })

  it('G1 独占创建：成功后只有 canonical 目录与 YAML projection，current/revision 均无临时文件残留', async () => {
    const dir = await store.init({ repoRoot, name: 'clean-tmp', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    const files = await readdir(dir)
    expect(files.sort()).toEqual(['.pipeline-document-locale.json', '.pipeline-run', '.pipeline.yaml'])
    expect((await readdir(path.join(dir, '.pipeline-run'))).sort())
      .toEqual(['current.json', 'pre-verify-review', 'revisions'])
    expect(await readdir(path.join(dir, '.pipeline-run', 'revisions'))).toHaveLength(1)
  })

  it('重复 init 撞名失败时不发布第二份孤儿 revision，也没有本次失败请求的临时文件残留', async () => {
    await store.init({ repoRoot, name: 'dup-tmp', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    await expect(
      store.init({ repoRoot, name: 'dup-tmp', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK }),
    ).rejects.toThrow()
    const dir = path.join(repoRoot, 'openspec', 'changes', 'dup-tmp')
    const files = await readdir(dir)
    expect(files.sort()).toEqual(['.pipeline-document-locale.json', '.pipeline-run', '.pipeline.yaml'])
    expect(await readdir(path.join(dir, '.pipeline-run', 'revisions'))).toHaveLength(1)
  })

  it('custom workflow 首态（initialWorkflow）随独占创建一次调用整体发布：workflow/phase 直接就是' +
    '目标值，不是先落 default/open 再改（第 7 轮 codex review P1：旧两步之间的窗口会让并发' +
    'transition 对 provisional default/open 提交 canonical record）', async () => {
    const dir = await store.init({
      repoRoot, name: 'wf-once', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK,
      initialWorkflow: { workflow: 'onboarding', phase: 'intake' },
    })
    expect(await store.get(dir, 'workflow')).toBe('onboarding')
    expect(await store.get(dir, 'phase')).toBe('intake')
  })

  it('不提供 initialWorkflow → workflow/phase 仍是老默认值 default/open（回归防护）', async () => {
    const dir = await store.init({ repoRoot, name: 'wf-default', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK })
    expect(await store.get(dir, 'workflow')).toBe('default')
    expect(await store.get(dir, 'phase')).toBe('open')
  })

  it('旧版残留的 locale-only Change 无论 locale 是否相同都 fail-closed，不覆盖既有目录', async () => {
    const reserved = path.join(repoRoot, 'openspec', 'changes', 'reserved-en')
    await mkdir(reserved, { recursive: true })
    await ensureDocumentLocalePin(reserved, 'en')
    await expect(store.init({
      repoRoot,
      name: 'reserved-en',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      documentLocale: 'en',
      clock: CLOCK,
    })).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(path.join(reserved, '.pipeline-run', 'current.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const mismatch = path.join(repoRoot, 'openspec', 'changes', 'reserved-mismatch')
    await mkdir(mismatch, { recursive: true })
    await ensureDocumentLocalePin(mismatch, 'en')
    await expect(store.init({
      repoRoot,
      name: 'reserved-mismatch',
      track: 'backend',
      reviewSeed: 'pending',
      creator: TEST_CREATOR, preset: 'full',
      documentLocale: 'zh-CN',
      clock: CLOCK,
    })).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(path.join(mismatch, '.pipeline-run', 'current.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('document booleans 生成回滚兼容 sidecar；运行时合并身份但 canonical 保持 N-1 闭集', async () => {
    const fingerprint = 'b'.repeat(64)
    const legacy = await store.init({
      repoRoot, name: 'wf-legacy-profile', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      runId: 'run-legacy-profile', clock: CLOCK,
      initialWorkflow: { workflow: 'legacy-governed', phase: 'open', openspecContract: true },
    })
    const declarative = await store.init({
      repoRoot, name: 'wf-document-profile', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      runId: 'run-document-profile', clock: CLOCK,
      initialWorkflow: {
        workflow: 'compact-governed',
        phase: 'shape',
        documentContract: true,
        documentGovernanceFingerprint: fingerprint,
      },
    })

    expect((await store.read(legacy)).runMetadata?.documentProfile).toBe('legacy-full')
    expect((await store.read(declarative)).runMetadata?.documentProfile).toBe('document-v1')
    expect((await store.read(declarative)).runMetadata?.documentGovernanceFingerprint).toBe(fingerprint)
    const current = JSON.parse(await readFile(
      path.join(declarative, '.pipeline-run', 'current.json'),
      'utf8',
    )) as { state: { runMetadata: Record<string, unknown> } }
    expect(current.state.runMetadata).toEqual({
      runId: 'run-document-profile',
      transitionSequence: 0,
    })
    expect(JSON.parse(await readFile(
      path.join(declarative, WORKFLOW_GOVERNANCE_BINDING_FILE),
      'utf8',
    ))).toMatchObject({
      version: 1,
      run_id: 'run-document-profile',
      document_profile: 'document-v1',
      document_governance_fingerprint: fingerprint,
    })
  })
})

describe('并发（20 写锁零丢失）', () => {
  it('G1：20 个公开 write 并发也必须由 store 自己串成单一 revision 链，不产生同代分叉', async () => {
    const dir = await store.init({
      repoRoot, name: 'cc-public-write', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock: CLOCK,
    })
    const initial = await store.read(dir)

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.write(dir, {
        ...initial,
        fields: { ...initial.fields, automation_last_error: `writer-${index}` },
      }, { kind: 'replace' })))

    const current = JSON.parse(await readFile(
      path.join(dir, '.pipeline-run', 'current.json'), 'utf8',
    )) as { revision: number }
    expect(current.revision).toBe(20)
    expect(await readdir(path.join(dir, '.pipeline-run', 'revisions'))).toHaveLength(21)
  })

  it('20 并发 withLock 读改写自增 → 零丢失（最终 =20）', async () => {
    const dir = await seedChange('cc1', 'zz-container-e2e.pipeline.yaml')
    await store.set(dir, 'automation_attempts', '0')
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.withLock(dir, async () => {
          const s = await store.read(dir)
          s.fields.automation_attempts = String(Number(s.fields.automation_attempts) + 1)
          await store.writeUnderLock(dir, s)
        }),
      ),
    )
    expect(await store.get(dir, 'automation_attempts')).toBe('20')
  })

  it('20 并发 set 不同字段 → 全部落盘且历史区完好', async () => {
    const dir = await seedChange('cc2', 'dashboard-interaction-fixes.pipeline.yaml')
    const fields = [
      'assignee', 'design_doc', 'plan', 'verification_report', 'build_mode',
      'isolation', 'build_sha', 'agent_review_result', 'codex_review_result', 'verify_result',
      'branch_status', 'prd_path', 'automation_sandbox', 'automation_worktree', 'automation_last_error',
      'automation_preserved_path', 'branch', 'base_branch', 'created_by', 'phase_status',
    ] as const
    await Promise.all(fields.map((f, i) => store.set(dir, f, `v-${i}`)))
    for (const [i, f] of fields.entries()) {
      expect(await store.get(dir, f)).toBe(`v-${i}`)
    }
    const raw = await readFile(path.join(dir, '.pipeline.yaml'), 'utf8')
    expect(raw).toContain('tools_history:')
    expect(raw.endsWith('coverage_confirmed_by: Host Dev\n')).toBe(true)
  })
})
