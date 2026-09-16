/** snapshot.test —— 真 fs：注册表读取 / 聚合 build / 指纹变化检测。 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { appendFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  builtinTrack,
  compileEffectiveWorkflowPlan,
  effectiveWorkflowPlanFromSnapshot,
  effectiveWorkflowPlanBinding,
  ensureDocumentLedger,
  isCurrentTaskPlanProjectionForChange,
  loadEffectiveWorkflowPlan,
  publishTaskPlanRevision,
  TERMINAL_ACTIVITY_TTL_MS,
  type TaskPlanRevisionV1,
  workflowPlanSnapshot,
  parseWorkflow,
  DEFAULT_WORKFLOW_SOURCE,
} from '@tenon/kernel'
import { ArtifactScopeMigrationError } from '@tenon/automation'
import { buildSnapshot, computeFingerprint } from './snapshot.js'
import { ensureUserLocalDir, serializeTaskArchive, type TenonUserResolution } from '@tenon/kernel'
import { snapshotWorkflowRules } from './workflowSnapshot.js'
import { readTasksMarkdown } from './snapshotTasks.js'
import {
  MAX_TASKS_MARKDOWN_BYTES,
  readAnchoredTasksMarkdown,
  readChangeSnapshot,
} from './changeSnapshot.js'
import { captureChangePathAnchor } from './contextBundlePreviewSupport.js'
import { readRegistry } from './registry.js'
import { initChange, makeProject, makeTempHome, newStore, sleep } from './test-support.js'
import { captureWorkflowRootAnchor, closeWorkflowRootAnchor } from './workflows.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const execFileAsync = promisify(execFile)

describe('readRegistry', () => {
  it('JSON 字符串数组 → 路径数组', async () => {
    const home = await makeTempHome()
    const p = join(home, 'pipeline-projects.json')
    await writeFile(p, JSON.stringify(['/a', '/b']), 'utf8')
    expect(readRegistry(p)).toEqual(['/a', '/b'])
  })
  it('缺文件 → []', async () => {
    expect(readRegistry(join(await makeTempHome(), 'missing.json'))).toEqual([])
  })
  it('损坏 JSON → []', async () => {
    const home = await makeTempHome()
    const p = join(home, 'pipeline-projects.json')
    await writeFile(p, '{ not json', 'utf8')
    expect(readRegistry(p)).toEqual([])
  })
})

describe('snapshotWorkflowRules policy diagnostics', () => {
  it('artifact scope migration conflict remains a visible change with a compatibility issue', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'migration-conflict')
    const snapshot = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
      artifactServiceForRoot: async () => { throw new ArtifactScopeMigrationError('openspec/changes/migration-conflict/.pipeline-artifacts/runtime-artifacts') },
    })
    const project = snapshot.projects[0]
    expect(project.changes.map((change) => change.name)).toEqual(['migration-conflict'])
    expect(project.compatibilityIssues).toEqual([{
      severity: 'warning',
      kind: 'legacy-scope-unmerged',
      change: 'migration-conflict',
      legacyScopePath: 'openspec/changes/migration-conflict/.pipeline-artifacts/runtime-artifacts',
      action: 'merge-or-remove-legacy-scope',
    }])
    expect(project.error).toBeUndefined()
  })

  it('separates configured, frozen, and fail-closed effective authority', () => {
    const plan = compileEffectiveWorkflowPlan('default')
    const rules = snapshotWorkflowRules(plan, {
      status: 'available',
      workflowFingerprint: plan.workflowFingerprint,
      decomposition: plan.decomposition,
      interaction: plan.interaction,
    })

    expect(rules.policy).toMatchObject({
      schema: 'workflow-policy/v1',
      configured: {
        status: 'available',
        workflowFingerprint: plan.workflowFingerprint,
        decomposition: { mode: 'off' },
        interaction: { mode: 'interactive' },
      },
      frozen: {
        workflowFingerprint: plan.workflowFingerprint,
        decomposition: { mode: 'off' },
        interaction: { mode: 'interactive' },
        workflowCeiling: { status: 'valid', grants: [] },
      },
      effective: {
        status: 'unavailable',
        reason: 'authority-input-unavailable',
      },
      drift: { status: 'current', fingerprintChanged: false, policyChanged: false },
    })
  })

  it('reports current-definition drift without replacing frozen run policy', () => {
    const plan = compileEffectiveWorkflowPlan('default')
    const rules = snapshotWorkflowRules(plan, {
      status: 'available',
      workflowFingerprint: 'changed-definition-fingerprint',
      decomposition: { ...plan.decomposition, mode: 'suggest' },
      interaction: plan.interaction,
    })

    expect(rules.policy.configured).toMatchObject({
      status: 'available',
      workflowFingerprint: 'changed-definition-fingerprint',
      decomposition: { mode: 'suggest' },
    })
    expect(rules.policy.frozen).toMatchObject({
      workflowFingerprint: plan.workflowFingerprint,
      decomposition: { mode: 'off' },
    })
    expect(rules.policy.drift).toEqual({
      status: 'changed', fingerprintChanged: true, policyChanged: true,
    })
  })

  it('keeps missing configured state distinct from permission grants', () => {
    const rules = snapshotWorkflowRules(compileEffectiveWorkflowPlan('default'), { status: 'missing' })

    expect(rules.policy.configured).toEqual({ status: 'missing' })
    expect(rules.policy.drift).toEqual({
      status: 'missing', fingerprintChanged: null, policyChanged: null,
    })
    expect(rules.policy.effective).toEqual({
      status: 'unavailable', reason: 'authority-input-unavailable',
    })
  })

  it('projects actual grants only when all dynamic authority layers are supplied', () => {
    const plan = compileEffectiveWorkflowPlan('authority-policy', {
      name: 'authority-policy',
      interaction: { version: 'v1', mode: 'afk' },
      steps: [{
        id: 'run', label: 'Run', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
      }],
    })
    const grant = { status: 'valid', grants: ['enter-afk'] } as const
    const rules = snapshotWorkflowRules(plan, { status: 'unavailable' }, {
      layers: { platform: grant, skill: grant, project: grant, run: grant },
    })

    expect(rules.policy.effective).toMatchObject({
      status: 'available', grants: ['enter-afk'],
    })
  })
})

describe('buildSnapshot —— 真读多项目 .pipeline.yaml', () => {
  it('registered root 变成外部 symlink 时 fail closed 且不读取目标 Change', async () => {
    const store = newStore()
    const outside = await makeProject()
    await initChange(store, outside, 'outside-change')
    const root = `${outside}-registered-link`
    await symlink(outside, root)

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 'now',
    })

    expect(snapshot.projects[0]).toMatchObject({ root, ok: false, changes: [] })
    expect(snapshot.change_count).toBe(0)
  })

  it('registered root 的祖先 symlink 在启动后换位时拒绝重新信任外部项目', async () => {
    const store = newStore()
    const container = await makeTempHome()
    const trustedParent = join(container, 'trusted')
    const outsideParent = join(container, 'outside')
    const trustedRoot = join(trustedParent, 'project')
    const outsideRoot = join(outsideParent, 'project')
    const parentLink = join(container, 'registered-parent')
    const root = join(parentLink, 'project')
    await mkdir(trustedRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await initChange(store, trustedRoot, 'trusted-change')
    await initChange(store, outsideRoot, 'outside-secret')
    await symlink(trustedParent, parentLink, 'dir')
    const anchor = captureWorkflowRootAnchor(root)
    const anchorWithoutFdPath = { ...anchor, fdPath: undefined }

    try {
      await unlink(parentLink)
      await symlink(outsideParent, parentLink, 'dir')
      const snapshot = await buildSnapshot({
        registry: () => [root],
        store,
        version: '1',
        clock: () => 'now',
        rootAnchor: () => anchorWithoutFdPath,
      })

      expect(snapshot.projects[0]).toMatchObject({ root, ok: false, changes: [] })
      expect(JSON.stringify(snapshot)).not.toContain('outside-secret')
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('Git identity 探测期间祖先路径被换位时只使用目录 fd 并丢弃整个项目结果', async () => {
    const store = newStore()
    const container = await makeTempHome()
    const trustedParent = join(container, 'trusted')
    const outsideParent = join(container, 'outside')
    const trustedRoot = join(trustedParent, 'project')
    const outsideRoot = join(outsideParent, 'project')
    const parentLink = join(container, 'registered-parent')
    const root = join(parentLink, 'project')
    await mkdir(trustedRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await initChange(store, trustedRoot, 'trusted-change')
    await initChange(store, outsideRoot, 'outside-secret')
    await symlink(trustedParent, parentLink, 'dir')
    const anchor = captureWorkflowRootAnchor(root)
    const anchorWithoutFdPath = { ...anchor, fdPath: undefined }
    let probedRoot = ''

    try {
      const snapshot = await buildSnapshot({
        registry: () => [root],
        store,
        version: '1',
        clock: () => 'now',
        rootAnchor: () => anchorWithoutFdPath,
        repositoryIdentity: async (probeRoot) => {
          probedRoot = probeRoot
          await unlink(parentLink)
          await symlink(outsideParent, parentLink, 'dir')
          return { id: 'c'.repeat(64), label: 'trusted', workspace_kind: 'primary' }
        },
      })

      expect(probedRoot).toBe(anchor.realPath)
      expect(snapshot.projects[0]).toMatchObject({ root, ok: false, changes: [] })
      expect(JSON.stringify(snapshot)).not.toContain('outside-secret')
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('Changes 目录枚举返回时 root 已换位，不得被空项目降级 catch 误报为健康', async () => {
    const store = newStore()
    const container = await makeTempHome()
    const trustedParent = join(container, 'trusted')
    const outsideParent = join(container, 'outside')
    const trustedRoot = join(trustedParent, 'project')
    const outsideRoot = join(outsideParent, 'project')
    const parentLink = join(container, 'registered-parent')
    const root = join(parentLink, 'project')
    await mkdir(trustedRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await initChange(store, trustedRoot, 'trusted-change')
    await initChange(store, outsideRoot, 'outside-secret')
    await symlink(trustedParent, parentLink, 'dir')
    const anchor = captureWorkflowRootAnchor(root)
    const anchorWithoutFdPath = { ...anchor, fdPath: undefined }

    try {
      const snapshot = await buildSnapshot({
        registry: () => [root],
        store,
        version: '1',
        clock: () => 'now',
        rootAnchor: () => anchorWithoutFdPath,
        readChangesDirectory: async () => {
          await unlink(parentLink)
          await symlink(outsideParent, parentLink, 'dir')
          return []
        },
      })

      expect(snapshot.projects[0]).toMatchObject({ root, ok: false, changes: [] })
      expect(JSON.stringify(snapshot)).not.toContain('outside-secret')
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('Changes 目录真实读取故障不得降级成健康空项目', async () => {
    const root = await makeProject()
    const snapshot = await buildSnapshot({
      registry: () => [root],
      store: newStore(),
      version: '1',
      clock: () => 'now',
      readChangesDirectory: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    })

    expect(snapshot.projects[0]).toMatchObject({ root, ok: false, changes: [] })
  })

  it('adds repository identity to a reachable empty project snapshot', async () => {
    const store = newStore()
    const root = await makeProject()
    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 'now',
      repositoryIdentity: async () => ({
        id: 'a'.repeat(64),
        label: 'repository',
        workspace_kind: 'primary' as const,
      }),
    })

    expect(snapshot.projects[0]?.repository).toEqual({
      id: 'a'.repeat(64),
      label: 'repository',
      workspace_kind: 'primary',
    })
  })

  it('projects the primary repository directory label onto every linked workspace independent of registry order', async () => {
    const linked = await makeProject()
    const primary = await makeProject()
    const primaryReal = await realpath(primary)
    const id = 'b'.repeat(64)
    const snapshot = await buildSnapshot({
      registry: () => [linked, primary],
      store: newStore(),
      version: '1',
      clock: () => 'now',
      repositoryIdentity: async (root) => ({
        id,
        label: await realpath(root) === primaryReal ? 'repository' : 'metadata',
        workspace_kind: await realpath(root) === primaryReal ? 'primary' : 'worktree',
      }),
    })

    expect(snapshot.projects.map((project) => project.repository)).toEqual([
      { id, label: 'repository', workspace_kind: 'worktree' },
      { id, label: 'repository', workspace_kind: 'primary' },
    ])
  })

  it('bounds concurrent project scans so repository probes cannot create an unbounded Git process fan-out', async () => {
    const roots = await Promise.all(Array.from({ length: 9 }, () => makeProject()))
    let active = 0
    let maxActive = 0
    await buildSnapshot({
      registry: () => roots,
      store: newStore(),
      version: '1',
      clock: () => 'now',
      repositoryIdentity: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await sleep(5)
        active -= 1
        return undefined
      },
    })

    expect(maxActive).toBe(4)
  })

  it('聚合快照在 tasks leaf 的 lstat→open 竞态中不跟随替换后的 symlink', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'raced-tasks')
    const outsideRoot = await makeProject()
    const outsideTasks = join(outsideRoot, 'outside-secret.md')
    await writeFile(outsideTasks, 'outside secret\n', 'utf8')
    let readAttempted = false

    const source = await readTasksMarkdown(changeDir, {
      beforeOpen: () => {
        unlinkSync(join(changeDir, 'tasks.md'))
        symlinkSync(outsideTasks, join(changeDir, 'tasks.md'), 'file')
      },
      readSource: () => {
        readAttempted = true
        return 'must not be read'
      },
    })

    expect(source).toBeUndefined()
    expect(readAttempted).toBe(false)
  })

  it('聚合快照在读取回调前拒绝超出硬上限的 tasks.md', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'oversized-tasks')
    await writeFile(join(changeDir, 'tasks.md'), Buffer.alloc(MAX_TASKS_MARKDOWN_BYTES + 1, 0x61))
    let readAttempted = false

    const source = await readTasksMarkdown(changeDir, {
      readSource: () => {
        readAttempted = true
        return 'must not be read'
      },
    })

    expect(source).toBeUndefined()
    expect(readAttempted).toBe(false)
  })

  it('聚合快照省略非法 UTF-8 tasks.md，不暴露 replacement text', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'invalid-utf8-tasks')
    await writeFile(join(changeDir, 'tasks.md'), Buffer.from([0xc3, 0x28]))

    await expect(readTasksMarkdown(changeDir)).resolves.toBeUndefined()
  })

  it('聚合快照读取超过 legacy 256 KiB、仍在 canonical 上限内的 TaskPlan 投影', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'large-canonical-tasks')
    const prefix = '# Tasks\n\n<!-- tenon-task-plan revision=r1 digest=sha256:abc -->\n'
    const source = `${prefix}${'a'.repeat(256 * 1024 + 1 - Buffer.byteLength(prefix))}`
    expect(Buffer.byteLength(source)).toBe(256 * 1024 + 1)
    await writeFile(join(changeDir, 'tasks.md'), source, 'utf8')

    await expect(readTasksMarkdown(changeDir)).resolves.toBeUndefined()
    await expect(readTasksMarkdown(changeDir, {
      authorizeCanonicalProjection: () => true,
    })).resolves.toBe(source)
  })

  it('聚合快照在 canonical 授权窗口替换 tasks 时拒绝旧 fd 与新 pathname', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'canonical-auth-race')
    const target = join(changeDir, 'tasks.md')
    const prefix = '# Tasks\n\n<!-- tenon-task-plan revision=r1 digest=sha256:abc -->\n'
    const before = `${prefix}${'a'.repeat(256 * 1024 + 1 - Buffer.byteLength(prefix))}`
    const after = before.replace(/a$/u, 'b')
    await writeFile(target, before, 'utf8')

    const result = await readTasksMarkdown(changeDir, {
      authorizeCanonicalProjection: (source) => {
        expect(source).toBe(before)
        writeFileSync(target, after, 'utf8')
        return true
      },
    })
    expect(result).toBeUndefined()
  })

  it('聚合快照把大型投影授权绑定已读 source，拒绝完整 Change-dir ABA', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'canonical-auth-full-aba')
    const legitimateDir = `${changeDir}.legitimate`
    const spoofDir = `${changeDir}.spoof`
    const ids = Array.from({ length: 40 }, (_, index) => `aba-${index}`)
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-auth-aba',
      revision_id: 'revision-auth-aba',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-03T00:00:00.000Z',
      requirements: [],
      acceptance_criteria: [],
      groups: [{ id: 'group-auth-aba', title: 'Build', parent_id: null, work_item_ids: ids }],
      work_items: ids.map((id, index) => ({
        id,
        title: `${index}-${'l'.repeat(7_000)}`,
        group_id: 'group-auth-aba',
        requirement_refs: [],
        acceptance_refs: [],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      })),
    }
    await publishTaskPlanRevision(changeDir, revision, { expected_current_revision_id: null })
    await rename(changeDir, legitimateDir)
    await mkdir(changeDir)
    const prefix = '# Tasks\n\n<!-- tenon-task-plan revision=spoof digest=spoof -->\n'
    const spoof = `${prefix}${'x'.repeat(256 * 1024 + 1 - Buffer.byteLength(prefix))}`
    await writeFile(join(changeDir, 'tasks.md'), spoof, 'utf8')

    const result = await readTasksMarkdown(changeDir, {
      authorizeCanonicalProjection: async (source, anchoredChangeDir) => {
        await rename(changeDir, spoofDir)
        await rename(legitimateDir, changeDir)
        try {
          const { hasCurrentCanonicalTaskPlanProjection } = await import('./snapshotTasks.js')
          return await hasCurrentCanonicalTaskPlanProjection(anchoredChangeDir, source)
        } finally {
          await rename(changeDir, legitimateDir)
          await rename(spoofDir, changeDir)
        }
      },
    })
    expect(result).toBeUndefined()
  })

  it('大型投影授权绑定 registered root，拒绝授权窗口中的完整 root ABA', async () => {
    const parent = await makeTempHome()
    const root = join(parent, 'root')
    const legitimateRoot = join(parent, 'legitimate-root')
    const attackRoot = join(parent, 'attack-root')
    const changeDir = join(root, 'openspec', 'changes', 'demo')
    const attackChange = join(attackRoot, 'openspec', 'changes', 'demo')
    const ids = Array.from({ length: 40 }, (_, index) => `root-aba-${index}`)
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-root-aba',
      revision_id: 'revision-root-aba',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-03T00:00:00.000Z',
      requirements: [],
      acceptance_criteria: [],
      groups: [{ id: 'group-root-aba', title: 'Notes', parent_id: null, work_item_ids: ids }],
      work_items: ids.map((id, index) => ({
        id,
        title: `${index}-${'x'.repeat(7_000)}`,
        group_id: 'group-root-aba',
        requirement_refs: [],
        acceptance_refs: [],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      })),
    }
    await mkdir(changeDir, { recursive: true })
    await mkdir(attackChange, { recursive: true })
    await publishTaskPlanRevision(attackChange, revision, { expected_current_revision_id: null })
    const source = await readFile(join(attackChange, 'tasks.md'), 'utf8')
    await writeFile(join(changeDir, 'tasks.md'), source, 'utf8')
    const anchor = captureWorkflowRootAnchor(root)
    try {
      const result = await readTasksMarkdown(changeDir, {
        authorizeCanonicalProjection: async (readSource, anchoredChangeDir) => {
          await rename(root, legitimateRoot)
          await rename(attackRoot, root)
          try {
            const { hasCurrentCanonicalTaskPlanProjection } = await import('./snapshotTasks.js')
            return await hasCurrentCanonicalTaskPlanProjection(anchoredChangeDir, readSource)
          } finally {
            await rename(root, attackRoot)
            await rename(legitimateRoot, root)
          }
        },
      }, anchor)
      expect(result).toBeUndefined()
    } finally {
      closeWorkflowRootAnchor(anchor)
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('真实 canonical current 授权大型投影，聚合与单 Change snapshot 都读取且不显示 marker', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'large-canonical-current')
    const ids = Array.from({ length: 40 }, (_, index) => `wi-${index}`)
    const revision: TaskPlanRevisionV1 = {
      schema_version: 'task-plan/v1',
      plan_id: 'plan-large',
      revision_id: 'revision-large',
      revision_number: 1,
      status: 'frozen',
      created_at: '2026-08-03T00:00:00.000Z',
      requirements: [],
      acceptance_criteria: [],
      groups: [{ id: 'group-large', title: 'Verify', parent_id: null, work_item_ids: ids }],
      work_items: ids.map((id, index) => ({
        id,
        title: `${String(index).padStart(2, '0')}-${'a'.repeat(7_000)}`,
        group_id: 'group-large',
        requirement_refs: [],
        acceptance_refs: [],
        depends_on: [],
        resource_claims: [],
        expected_outputs: [],
        validators: [],
      })),
    }
    await publishTaskPlanRevision(changeDir, revision, { expected_current_revision_id: null })
    const source = await readFile(join(changeDir, 'tasks.md'), 'utf8')
    expect(Buffer.byteLength(source)).toBeGreaterThan(256 * 1024)
    await expect(isCurrentTaskPlanProjectionForChange(changeDir, source)).resolves.toBe(true)

    await expect(readTasksMarkdown(changeDir)).resolves.toBe(source)
    const snapshot = await readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 'now' },
      root,
      'large-canonical-current',
      0,
    )
    const tasks = (snapshot?.todo.stages.flatMap((stage) => stage.tasks) ?? [])
      .filter((task) => /^\d{2}-a/u.test(task.text))
    expect(tasks).toHaveLength(40)
    expect(tasks.every((task) => !task.text.includes('<!-- work-item:'))).toBe(true)
  })

  it('聚合快照继续拒绝超过 256 KiB 的 legacy tasks.md', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'large-legacy-tasks')
    const source = `# Tasks\n${'a'.repeat(256 * 1024 + 1)}`
    await writeFile(join(changeDir, 'tasks.md'), source, 'utf8')

    await expect(readTasksMarkdown(changeDir)).resolves.toBeUndefined()
  })

  it('聚合快照非阻塞地拒绝 FIFO tasks.md', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'fifo-tasks')
    await unlink(join(changeDir, 'tasks.md'))
    await execFileAsync('mkfifo', [join(changeDir, 'tasks.md')])

    await expect(readTasksMarkdown(changeDir)).resolves.toBeUndefined()
  })

  it('聚合快照在 fd 读取期间增长时不发布已过期内容', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'growing-tasks')

    const source = await readTasksMarkdown(changeDir, {
      readSource: () => {
        appendFileSync(join(changeDir, 'tasks.md'), '\n- [ ] raced growth\n')
        return '- [ ] stale bytes\n'
      },
    })

    expect(source).toBeUndefined()
  })

  it('聚合快照在同 inode 同长度覆写时不发布已过期内容', async () => {
    const store = newStore()
    const root = await makeProject()
    const changeDir = await initChange(store, root, 'same-size-raced-tasks')
    const target = join(changeDir, 'tasks.md')
    const before = '- [ ] before\n'
    const after = '- [x] after!\n'
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before))
    await writeFile(target, before, 'utf8')

    const source = await readTasksMarkdown(changeDir, {
      readSource: () => {
        writeFileSync(target, after, 'utf8')
        return before
      },
    })

    expect(source).toBeUndefined()
  })

  it('明确未来 canonical 版本投影为有界 issue，并与可读 Change 共存且不泄露路径', async () => {
    const store = newStore()
    const root = await makeProject()
    const futureDir = await initChange(store, root, 'future-state')
    await initChange(store, root, 'readable-state')
    const currentPath = join(futureDir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    await writeFile(currentPath, JSON.stringify({
      ...current,
      schemaVersion: 2,
      futureOnly: { sourcePath: currentPath },
    }), 'utf8')

    const snapshot = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    const project = snapshot.projects[0] as typeof snapshot.projects[number] & {
      compatibilityIssues?: Array<{
        severity: 'blocking'
        kind: string
        change: string
        foundVersion: number
        supportedVersion: number
        action: string
      }>
    }

    expect(project.ok).toBe(false)
    expect(project.changes.map((change) => change.name)).toEqual(['readable-state'])
    expect(snapshot.change_count).toBe(1)
    expect(project.compatibilityIssues).toEqual([{
      severity: 'blocking',
      kind: 'unsupported-canonical-version',
      change: 'future-state',
      foundVersion: 2,
      supportedVersion: 1,
      action: 'upgrade-runtime',
    }])
    expect(project.error).toBeUndefined()
    expect(JSON.stringify(project.compatibilityIssues)).not.toContain(root)
    expect(JSON.stringify(project.compatibilityIssues)).not.toContain('futureOnly')
  })

  it('canonical current 损坏必须在项目快照 fail-loud，不得静默把 change 隐藏成空项目', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'broken-current')
    await writeFile(join(dir, '.pipeline-run', 'current.json'), '{broken', 'utf8')

    const snap = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(snap.projects[0].ok).toBe(false)
    expect(snap.projects[0].error).toMatch(/broken-current.*current|current.*broken-current/i)
    expect(snap.change_count).toBe(0)
  })

  it('未来版本与普通损坏并存时同时保留有界兼容信息和 corruption error', async () => {
    const store = newStore()
    const root = await makeProject()
    const futureDir = await initChange(store, root, 'future-state')
    const brokenDir = await initChange(store, root, 'broken-current')
    await initChange(store, root, 'readable-state')
    const futureCurrentPath = join(futureDir, '.pipeline-run', 'current.json')
    const futureCurrent = JSON.parse(await readFile(futureCurrentPath, 'utf8')) as Record<string, unknown>
    await writeFile(futureCurrentPath, JSON.stringify({ ...futureCurrent, schemaVersion: 2 }), 'utf8')
    await writeFile(join(brokenDir, '.pipeline-run', 'current.json'), '{broken', 'utf8')

    const snapshot = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    const project = snapshot.projects[0]
    expect(project.ok).toBe(false)
    expect(project.changes.map((change) => change.name)).toEqual(['readable-state'])
    expect(project.compatibilityIssues?.map((issue) => issue.change)).toEqual(['future-state'])
    expect(project.error).toMatch(/broken-current/)
  })

  it('兼容问题数组最多返回 100 项，超限时用 typed 截断信号且保留可读 sibling', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'readable-state')
    for (let index = 0; index < 101; index += 1) {
      const dir = await initChange(store, root, `future-${String(index).padStart(3, '0')}`)
      const currentPath = join(dir, '.pipeline-run', 'current.json')
      const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
      await writeFile(currentPath, JSON.stringify({ ...current, schemaVersion: 2 }), 'utf8')
    }

    const snapshot = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    const project = snapshot.projects[0]
    expect(project.compatibilityIssues).toHaveLength(100)
    expect(project.compatibilityIssues?.at(0)?.change).toBe('future-000')
    expect(project.compatibilityIssues?.at(-1)?.change).toBe('future-099')
    expect(project.compatibilityIssuesTruncated).toBe(true)
    expect(project.error).toBeUndefined()
    expect(project.changes.map((change) => change.name)).toEqual(['readable-state'])
    expect(snapshot.change_count).toBe(1)
  }, 15_000)

  it('server 扫描自动重建缺失的 YAML projection，但 canonical 仍是读取真相', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'repair-on-scan')
    await unlink(join(dir, '.pipeline.yaml'))

    const snap = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(snap.projects[0].changes[0].name).toBe('repair-on-scan')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current' })
  })

  it('单 Change 直读不修复缺失 projection，也不扫描其他 Change', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const otherDir = await initChange(store, root, 'other')
    await unlink(join(targetDir, '.pipeline.yaml'))
    await unlink(join(otherDir, '.pipeline.yaml'))

    const change = await readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 't' },
      root,
      'target',
      0,
    )

    expect(change?.name).toBe('target')
    expect(await store.inspectProjection(targetDir)).toMatchObject({ status: 'missing' })
    expect(await store.inspectProjection(otherDir)).toMatchObject({ status: 'missing' })
  })

  it('单 Change 直读拒绝指向 registered root 外的 Change 目录 symlink', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const outsideRoot = await makeProject()
    const outsideDir = await initChange(store, outsideRoot, 'target')
    await rename(targetDir, `${targetDir}.original`)
    await symlink(outsideDir, targetDir, 'dir')
    const anchor = captureWorkflowRootAnchor(root)

    try {
      await expect(readChangeSnapshot(
        { registry: () => [root], store, version: '1', clock: () => 't' },
        anchor,
        'target',
        0,
      )).rejects.toThrow(/路径|symlink|真实目录|registered root/i)
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  })

  it('单 Change 直读拒绝指向外部状态的 legacy projection symlink', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const outsideRoot = await makeProject()
    const outsideDir = await initChange(store, outsideRoot, 'outside')
    await rename(join(targetDir, '.pipeline-run'), join(targetDir, '.pipeline-run.original'))
    await unlink(join(targetDir, '.pipeline.yaml'))
    await symlink(join(outsideDir, '.pipeline.yaml'), join(targetDir, '.pipeline.yaml'), 'file')

    await expect(readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 't' },
      root,
      'target',
      0,
    )).rejects.toThrow(/symlink|普通文件/i)
  })

  it('单 Change legacy custom workflow fallback 拒绝读取 root 外的 workflow symlink', async () => {
    const store = newStore()
    const root = await makeProject()
    const workflowDir = join(root, '.pipeline', 'workflows')
    const outsideRoot = await makeProject()
    const outsideWorkflow = join(outsideRoot, 'legacy.yaml')
    await mkdir(workflowDir, { recursive: true })
    await writeFile(outsideWorkflow, [
      'name: legacy',
      'steps:',
      '  - id: external',
      '    label: External secret label',
      '    gate: null',
      '    skills: []',
      '    inputs: []',
      '    outputs: []',
      '    guards: []',
      '    transitions: []',
      '',
    ].join('\n'), 'utf8')
    await symlink(outsideWorkflow, join(workflowDir, 'legacy.yaml'), 'file')
    await initChange(store, root, 'legacy-change', {
      legacyWithoutRunIdentity: true,
      initialWorkflow: { workflow: 'legacy', phase: 'external' },
    })

    await expect(readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 't' },
      root,
      'legacy-change',
      0,
    )).rejects.toThrow(/workflow|可信|symlink|普通文件/i)
  })

  it('单 Change 直读不跟随 root 外的 tasks.md leaf symlink', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const outsideRoot = await makeProject()
    const outsideTasks = join(outsideRoot, 'tasks.md')
    await writeFile(outsideTasks, '- [ ] External secret task\n', 'utf8')
    await unlink(join(targetDir, 'tasks.md'))
    await symlink(outsideTasks, join(targetDir, 'tasks.md'), 'file')

    await expect(readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 't' },
      root,
      'target',
      0,
    )).rejects.toThrow(/tasks|路径|可信/i)
  })

  it('单 Change 直读拒绝非法 UTF-8 tasks.md，不暴露 replacement text', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'invalid-utf8')
    await writeFile(join(targetDir, 'tasks.md'), Buffer.from([0xc3, 0x28]))

    await expect(readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 't' },
      root,
      'invalid-utf8',
      0,
    )).rejects.toThrow(/UTF-8/u)
  })

  it('单 Change 目录被换到 root 外时，在读取 tasks 字节前拒绝', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const parkedTargetDir = `${targetDir}.parked`
    const outsideRoot = await makeProject()
    const outsideChange = join(outsideRoot, 'outside-change')
    await mkdir(outsideChange)
    await writeFile(join(outsideChange, 'tasks.md'), 'external secret task\n', 'utf8')
    const workflowAnchor = captureWorkflowRootAnchor(root)
    try {
      const changeAnchor = captureChangePathAnchor(workflowAnchor, 'target')
      await rename(targetDir, parkedTargetDir)
      await symlink(outsideChange, targetDir, 'dir')
      let readAttempted = false

      await expect(readAnchoredTasksMarkdown(changeAnchor, () => {
        readAttempted = true
        return 'should not be read'
      })).rejects.toThrow(/Change|tasks|路径|可信|读取期间变化/i)
      expect(readAttempted).toBe(false)
    } finally {
      closeWorkflowRootAnchor(workflowAnchor)
    }
  })

  it('单 Change 的 FIFO tasks 非阻塞地拒绝为非普通文件', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    await unlink(join(targetDir, 'tasks.md'))
    await execFileAsync('mkfifo', [join(targetDir, 'tasks.md')])

    await expect(readChangeSnapshot(
      { registry: () => [root], store, version: '1', clock: () => 't' },
      root,
      'target',
      0,
    )).rejects.toThrow(/tasks|普通文件|路径|可信/i)
  })

  it('单 Change 的 tasks 在读取回调前执行硬字节上限', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    await writeFile(join(targetDir, 'tasks.md'), Buffer.alloc(MAX_TASKS_MARKDOWN_BYTES + 1, 0x61))
    const workflowAnchor = captureWorkflowRootAnchor(root)
    try {
      const changeAnchor = captureChangePathAnchor(workflowAnchor, 'target')
      let readAttempted = false
      await expect(readAnchoredTasksMarkdown(changeAnchor, () => {
        readAttempted = true
        return 'should not be read'
      })).rejects.toThrow(/tasks.*上限/i)
      expect(readAttempted).toBe(false)
    } finally {
      closeWorkflowRootAnchor(workflowAnchor)
    }
  })

  it('单 Change reader 接受超过 legacy 256 KiB、仍在 canonical 上限内的 TaskPlan 投影', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'large-canonical-target')
    const prefix = '# Tasks\n\n<!-- tenon-task-plan revision=r1 digest=sha256:abc -->\n'
    const source = `${prefix}${'a'.repeat(256 * 1024 + 1 - Buffer.byteLength(prefix))}`
    await writeFile(join(targetDir, 'tasks.md'), source, 'utf8')
    const workflowAnchor = captureWorkflowRootAnchor(root)
    try {
      const changeAnchor = captureChangePathAnchor(workflowAnchor, 'large-canonical-target')
      await expect(readAnchoredTasksMarkdown(changeAnchor)).rejects.toThrow(/Legacy Change tasks.*262144/u)
      await expect(readAnchoredTasksMarkdown(changeAnchor, undefined, () => true)).resolves.toBe(source)
    } finally {
      closeWorkflowRootAnchor(workflowAnchor)
    }
  })

  it('单 Change reader 在 canonical 授权窗口替换 tasks 时拒绝旧 fd 与新 pathname', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'canonical-auth-target-race')
    const target = join(targetDir, 'tasks.md')
    const prefix = '# Tasks\n\n<!-- tenon-task-plan revision=r1 digest=sha256:abc -->\n'
    const before = `${prefix}${'a'.repeat(256 * 1024 + 1 - Buffer.byteLength(prefix))}`
    const after = before.replace(/a$/u, 'b')
    await writeFile(target, before, 'utf8')
    const workflowAnchor = captureWorkflowRootAnchor(root)
    try {
      const changeAnchor = captureChangePathAnchor(workflowAnchor, 'canonical-auth-target-race')
      await expect(readAnchoredTasksMarkdown(changeAnchor, undefined, (source) => {
        expect(source).toBe(before)
        writeFileSync(target, after, 'utf8')
        return true
      })).rejects.toThrow(/tasks|路径|读取期间变化/iu)
    } finally {
      closeWorkflowRootAnchor(workflowAnchor)
    }
  })

  it('单 Change reader 继续拒绝超过 256 KiB 的 legacy tasks.md', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'large-legacy-target')
    const source = `# Tasks\n${'a'.repeat(256 * 1024 + 1)}`
    await writeFile(join(targetDir, 'tasks.md'), source, 'utf8')
    const workflowAnchor = captureWorkflowRootAnchor(root)
    try {
      const changeAnchor = captureChangePathAnchor(workflowAnchor, 'large-legacy-target')
      await expect(readAnchoredTasksMarkdown(changeAnchor)).rejects.toThrow(/Legacy Change tasks.*262144/u)
    } finally {
      closeWorkflowRootAnchor(workflowAnchor)
    }
  })

  it('单 Change 的 tasks 在同 inode 同长度覆写时 fail closed', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'same-size-target')
    const target = join(targetDir, 'tasks.md')
    const before = '- [ ] before\n'
    const after = '- [x] after!\n'
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before))
    await writeFile(target, before, 'utf8')
    const workflowAnchor = captureWorkflowRootAnchor(root)
    try {
      const changeAnchor = captureChangePathAnchor(workflowAnchor, 'same-size-target')
      await expect(readAnchoredTasksMarkdown(changeAnchor, () => {
        writeFileSync(target, after, 'utf8')
        return before
      })).rejects.toThrow(/tasks|路径|读取期间变化/i)
    } finally {
      closeWorkflowRootAnchor(workflowAnchor)
    }
  })

  it('单 Change 受信 reader 不把状态 pathname 委托给注入的 StateStore', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const racingStore = {
      read: async () => { throw new Error('untrusted pathname read must not run') },
    } as typeof store

    await expect(readChangeSnapshot(
      { registry: () => [root], store: racingStore, version: '1', clock: () => 't' },
      root,
      'target',
      0,
    )).resolves.toMatchObject({ name: 'target' })
  })

  it('单 Change legacy 读取不受注入 StateStore 的状态源切换影响', async () => {
    const store = newStore()
    const root = await makeProject()
    const targetDir = await initChange(store, root, 'target')
    const runDir = join(targetDir, '.pipeline-run')
    const parkedRunDir = join(targetDir, '.pipeline-run.parked')
    await rename(runDir, parkedRunDir)
    let delegated = false
    const racingStore = {
      read: async () => {
        delegated = true
        await rename(parkedRunDir, runDir)
        return store.read(targetDir)
      },
    } as typeof store

    await expect(readChangeSnapshot(
      { registry: () => [root], store: racingStore, version: '1', clock: () => 't' },
      root,
      'target',
      0,
    )).resolves.toMatchObject({ name: 'target', phase: 'open' })
    expect(delegated).toBe(false)
  })

  it('聚合两个注册项目、计数与相位真实', async () => {
    const store = newStore()
    const a = await makeProject()
    const b = await makeProject()
    await initChange(store, a, 'alpha')
    await initChange(store, b, 'beta', { track: 'pm' })
    const snap = await buildSnapshot({
      registry: () => [a, b], store, version: '1.2.3', clock: () => '2026-07-07T00:00:00Z',
    })
    expect(snap.version).toBe('1.2.3')
    expect(snap.project_count).toBe(2)
    expect(snap.change_count).toBe(2)
    const beta = snap.projects.find((p) => p.root === b)!.changes[0]
    expect(beta.name).toBe('beta')
    expect(beta.phase).toBe('open')
    expect(beta.track).toBe('pm')
    expect(beta.workflowRules).toMatchObject({
      steps: ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'],
      gateByStep: { explore: 'review', spec: 'review', verify: 'review' },
      policy: {
        schema: 'workflow-policy/v1',
        configured: {
          status: 'available',
          decomposition: { mode: 'off' },
          interaction: { mode: 'interactive' },
        },
        frozen: {
          decomposition: { mode: 'off' },
          interaction: { mode: 'interactive' },
          workflowCeiling: { status: 'valid', grants: [] },
        },
        effective: { status: 'unavailable', reason: 'authority-input-unavailable' },
        drift: { status: 'current', fingerprintChanged: false, policyChanged: false },
      },
    })
    expect(Object.keys(beta.workflowExecution.readinessByTransition)).toEqual(['open'])
    expect(beta.workflowExecution.readinessByTransition.open).toEqual({
      'open-complete': { ready: true, blockers: [] },
    })
    expect((snap.projects.find((p) => p.root === b) as unknown as {
      workflowRules: Record<string, { nonemptyOutputByStep: Record<string, boolean> }>
    }).workflowRules.default.nonemptyOutputByStep).toHaveProperty('open')
  })

  it('从 canonical receipt 投影未请求、待确认和已批准的 exact-event handshake', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'review-handshake')
    await store.set(dir, 'phase', 'verify')

    const idle = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    expect(idle.projects[0]?.changes[0]?.reviewHandshake).toEqual({
      status: 'not-requested',
    })

    await store.setMany(dir, {
      review_gate_phase: 'verify',
      review_gate_status: 'pending',
      review_gate_event: 'verify-pass',
      review_requested_at: '2026-07-30T02:00:00Z',
      review_acknowledged_at: '',
    })
    const pending = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    expect(pending.projects[0]?.changes[0]?.reviewHandshake).toEqual({
      status: 'pending',
      event: 'verify-pass',
      requestedAt: '2026-07-30T02:00:00Z',
    })

    await store.setMany(dir, {
      review_gate_status: 'approved',
      review_acknowledged_at: '2026-07-30T02:01:00Z',
    })
    const approved = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    expect(approved.projects[0]?.changes[0]?.reviewHandshake).toEqual({
      status: 'approved',
      event: 'verify-pass',
      requestedAt: '2026-07-30T02:00:00Z',
      acknowledgedAt: '2026-07-30T02:01:00Z',
    })
  })

  it('非法或漂移的 canonical receipt 必须 fail-loud，不能美化成未请求', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'invalid-review-handshake')
    await store.setMany(dir, {
      phase: 'verify',
      review_gate_phase: 'verify',
      review_gate_status: 'pending',
      review_gate_event: 'spec-complete',
      review_requested_at: '2026-07-30T02:00:00Z',
      review_acknowledged_at: '',
    })

    const snapshot = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    expect(snapshot.projects[0]?.ok).toBe(false)
    expect(snapshot.projects[0]?.error).toMatch(/invalid-review-handshake.*review handshake/i)
    expect(snapshot.change_count).toBe(0)
  })

  it('default Build readiness 投影 pre-Verify 全量收敛门，pending 不得显示可冻结', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'pre-verify-readiness')
    await store.setMany(dir, {
      phase: 'build',
      build_mode: 'direct',
      isolation: 'in-place',
      direct_override: 'true',
    })

    const blocked = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    expect(
      blocked.projects[0]?.changes[0]?.workflowExecution
        .readinessByTransition.build?.['build-complete'],
    ).toEqual({
      ready: false,
      blockers: [{
        kind: 'guard-failed',
        guardType: 'field-equals',
        field: 'pre_verify_review_result',
        actual: 'pending',
        expected: ['pass'],
      }],
    })

    await store.set(dir, 'pre_verify_review_result', 'pass')
    const ready = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't',
    })
    expect(
      ready.projects[0]?.changes[0]?.workflowExecution
        .readinessByTransition.build?.['build-complete'],
    ).toEqual({ ready: true, blockers: [] })
  })

  it('非当前 phase 不求值 workspace fingerprint，当前求值异常只投影 blocker 而不让项目离线', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'fingerprint-read-model')
    await store.setMany(dir, {
      isolation: 'in-place',
      build_sha: `workspace:sha256:${'a'.repeat(64)}`,
    })
    let calls = 0
    const fingerprint = async () => {
      calls += 1
      throw new Error('workspace changed during traversal')
    }

    const open = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
      workspaceFingerprint: fingerprint,
    })
    expect(calls).toBe(0)
    expect(open.projects[0]?.ok).toBe(true)

    await store.set(dir, 'phase', 'verify')
    const verify = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
      workspaceFingerprint: fingerprint,
    })
    // Legacy raw workspace SHA is rejected before capability evaluation. A
    // trustworthy build token must be captured by the build action first.
    expect(calls).toBe(0)
    expect(verify.projects[0]?.ok).toBe(true)
    expect(
      verify.projects[0]?.changes[0]?.workflowExecution.readinessByTransition.verify?.['verify-pass'],
    ).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining([{
        kind: 'verify-build-revision-untrusted',
        code: 'verify-build-revision-untrusted',
        reason: 'malformed',
        remediation: 'return-to-build-and-capture-current-revision',
        stateHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }]),
    })
  })

  it('条件 nonempty guard 只为适用 Track 投影必需输出', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'conditional-output.yaml'), `name: conditional-output
steps:
  - id: shape
    label: Shape
    gate: review
    skills: []
    inputs: []
    outputs:
      - field: plan
        type: file_path
      - field: scope
        type: string
    guards:
      - type: nonempty-output
        when:
          track_in: [backend]
    transitions:
      - event: continue
        to: shape
`, 'utf8')
    await initChange(store, root, 'conditional-backend', {
      track: 'backend',
      initialWorkflow: { workflow: 'conditional-output', phase: 'shape' },
    })
    await initChange(store, root, 'conditional-pm', {
      track: 'pm',
      initialWorkflow: { workflow: 'conditional-output', phase: 'shape' },
    })

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
    })
    const byName = new Map(snapshot.projects[0]?.changes.map((change) => [change.name, change]))

    // `shape` only loops back to itself, so it also exposes the implicit `archived` completion exit,
    // which is gated by the same conditional step guard.
    const backendBlockers = [
      { kind: 'guard-failed', guardType: 'field-nonempty', field: 'plan', actual: 'null' },
      { kind: 'guard-failed', guardType: 'output-present', field: 'scope', actual: 'null' },
    ]
    expect(byName.get('conditional-backend')?.workflowExecution.readinessByTransition.shape)
      .toEqual({
        continue: { ready: false, blockers: backendBlockers },
        archived: { ready: false, blockers: backendBlockers },
      })
    expect(byName.get('conditional-pm')?.workflowExecution.readinessByTransition.shape)
      .toEqual({ continue: { ready: true, blockers: [] }, archived: { ready: true, blockers: [] } })
    expect(byName.get('conditional-backend')?.workflowRules)
      .toEqual(byName.get('conditional-pm')?.workflowRules)
  })

  it('workflow label 投影覆盖每个 step；未声明展示名时用 step id 保持边界契约完整', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'partial-labels.yaml'), `name: partial-labels
steps:
  - id: draft
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: finish
        to: done
  - id: done
    label: 完成
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    await initChange(store, root, 'partial-labels', {
      initialWorkflow: { workflow: 'partial-labels', phase: 'draft' },
    })

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
    })

    expect(snapshot.projects[0]?.changes[0]?.workflowRules.labelByStep).toEqual({
      draft: 'draft',
      done: '完成',
    })
  })

  it('逐 event 投影 step + edge guard，多个出口不得合并成 step 级并集', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'edge-evidence.yaml'), `name: edge-evidence
steps:
  - id: review
    label: Review
    gate: review
    skills: []
    inputs: []
    outputs:
      - field: plan
        type: file_path
      - field: scope
        type: string
    guards:
      - type: nonempty-output
    transitions:
      - event: accept
        to: done
        guards:
          - type: field-nonempty
            field: verification_report
      - event: revise
        to: done
  - id: done
    label: Done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    await initChange(store, root, 'edge-evidence', {
      track: 'backend',
      initialWorkflow: { workflow: 'edge-evidence', phase: 'review' },
    })

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
    })

    expect(snapshot.projects[0]?.changes[0]?.workflowExecution.readinessByTransition).toEqual({
      review: {
        accept: {
          ready: false,
          blockers: [
            { kind: 'guard-failed', guardType: 'field-nonempty', field: 'plan', actual: 'null' },
            { kind: 'guard-failed', guardType: 'output-present', field: 'scope', actual: 'null' },
            { kind: 'guard-failed', guardType: 'field-nonempty', field: 'verification_report', actual: 'null' },
          ],
        },
        revise: {
          ready: false,
          blockers: [
            { kind: 'guard-failed', guardType: 'field-nonempty', field: 'plan', actual: 'null' },
            { kind: 'guard-failed', guardType: 'output-present', field: 'scope', actual: 'null' },
          ],
        },
      },
    })
  })

  it('逐 event readiness 复用 canonical guard 语义，不得把非空字段误判为谓词通过', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'semantic-readiness.yaml'), `name: semantic-readiness
steps:
  - id: review
    label: Review
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards:
      - type: tasks-at-least
        n: 2
    transitions:
      - event: accept
        to: done
        guards:
          - type: field-equals
            field: branch_status
            value: handled
          - type: field-in
            field: verify_result
            values: [pass]
          - type: file-exists
            field: verification_report
  - id: done
    label: Done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    const dir = await initChange(store, root, 'semantic-readiness', {
      track: 'backend',
      initialWorkflow: { workflow: 'semantic-readiness', phase: 'review' },
    })
    await store.setMany(dir, {
      branch_status: 'pending',
      verify_result: 'fail',
      verification_report: 'docs/missing.md',
    })
    await writeFile(join(dir, 'tasks.md'), '- [x] only-one\n', 'utf8')

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
    })
    expect(snapshot.projects[0]?.error).toBeUndefined()
    const execution = snapshot.projects[0]?.changes[0]?.workflowExecution as unknown as {
      readinessByTransition: Record<string, Record<string, {
        ready: boolean
        blockers: Array<{ guardType: string; field?: string; actual?: string; expected?: readonly string[] }>
      }>>
    }

    expect(execution.readinessByTransition.review.accept).toEqual({
      ready: false,
      blockers: [
        { kind: 'guard-failed', guardType: 'tasks-at-least', actual: '1', expected: ['2'] },
        {
          kind: 'guard-failed',
          guardType: 'field-equals',
          field: 'branch_status',
          actual: 'pending',
          expected: ['handled'],
        },
        {
          kind: 'guard-failed',
          guardType: 'field-in',
          field: 'verify_result',
          actual: 'fail',
          expected: ['pass'],
        },
        {
          kind: 'guard-failed',
          guardType: 'file-exists',
          field: 'verification_report',
          actual: 'docs/missing.md',
        },
      ],
    })
  })

  it('无法取得 Git capability 时 readiness 失败关闭，取得后仍按 canonical SHA 谓词求值', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'sha-readiness.yaml'), `name: sha-readiness
steps:
  - id: verify
    label: Verify
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: pass
        to: done
        guards:
          - type: build-head-unchanged
            field: build_sha
  - id: done
    label: Done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    const dir = await initChange(store, root, 'sha-readiness', {
      track: 'backend',
      initialWorkflow: { workflow: 'sha-readiness', phase: 'verify' },
    })
    await store.set(dir, 'build_sha', 'abc123')

    const unavailable = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
    })
    expect(
      unavailable.projects[0]?.changes[0]?.workflowExecution.readinessByTransition.verify?.pass,
    ).toEqual({
      ready: false,
      blockers: [{
        kind: 'verify-build-revision-untrusted',
        code: 'verify-build-revision-untrusted',
        reason: 'malformed',
        remediation: 'return-to-build-and-capture-current-revision',
        stateHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }],
    })

    const mismatch = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
      gitHeadSha: async () => 'def456',
    })
    expect(
      mismatch.projects[0]?.changes[0]?.workflowExecution.readinessByTransition.verify?.pass,
    ).toEqual({
      ready: false,
      blockers: [{
        kind: 'verify-build-revision-untrusted',
        code: 'verify-build-revision-untrusted',
        reason: 'malformed',
        remediation: 'return-to-build-and-capture-current-revision',
        stateHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }],
    })
  })

  it('custom Verify-like snapshot keeps success blocked while explicit rollback stays ready', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'edge-revision.yaml'), `name: edge-revision
steps:
  - id: implement-anything
    label: Implement
    gate: null
    skills: []
    inputs: []
    outputs:
      - field: build_sha
        type: string
    guards: []
    transitions:
      - event: ready
        to: assure-anything
  - id: assure-anything
    label: Assure
    gate: review
    skills: []
    inputs:
      - field: build_sha
        type: string
    outputs: []
    guards:
      - type: build-head-unchanged
        field: build_sha
    transitions:
      - event: pass
        to: ship-anything
      - event: rollback
        to: implement-anything
        actions:
          - type: mark-verification-failed
  - id: ship-anything
    label: Ship
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    const dir = await initChange(store, root, 'edge-revision', {
      track: 'backend',
      initialWorkflow: { workflow: 'edge-revision', phase: 'assure-anything' },
    })
    await store.setMany(dir, { build_sha: 'legacy-sha', isolation: 'branch' })

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1',
      clock: () => 't',
    })
    const readiness = snapshot.projects[0]?.changes[0]?.workflowExecution.readinessByTransition
    expect(readiness?.['assure-anything']?.pass).toMatchObject({
      ready: false,
      blockers: [{ code: 'verify-build-revision-untrusted', reason: 'malformed' }],
    })
    expect(readiness?.['assure-anything']?.rollback).toEqual({ ready: true, blockers: [] })
  })

  it('automation_current_phase 经 fields 全量透传（T4 决策 G：进度详情「沙箱内阶段」数据源）', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'afk-run')
    // init 缺省空串（run 外无沙箱内阶段）
    const snap0 = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(snap0.projects[0].changes[0].fields.automation_current_phase).toBe('')
    // automation runner 运行期写入 → snapshot 原值透传（server 不加工、不改名）
    await store.set(dir, 'automation_current_phase', 'verify')
    const snap1 = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(snap1.projects[0].changes[0].fields.automation_current_phase).toBe('verify')
  })

  it('显式绑定的 host heartbeat 才投影为终端运行中；过期、错 change 或链接一律不显示', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'terminal-live')
    const now = Date.parse('2026-07-24T06:00:00.000Z')
    const sidecar = join(dir, '.pipeline-terminal-activity.json')
    await writeFile(sidecar, JSON.stringify({
      protocol: 'pipeline-terminal-activity-v1',
      change: 'terminal-live',
      session_id: '019f92c7-6e66-7290-9352-f9d915266f14',
      heartbeat_at: '2026-07-24T05:59:30.000Z',
      turn_id: 'turn-live',
    }), 'utf8')

    const live = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't', now: () => now })
    expect(live.projects[0].changes[0].terminalActivity).toMatchObject({
      sessionId: '019f92c7-6e66-7290-9352-f9d915266f14', turnId: 'turn-live',
    })
    const stale = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't', now: () => now + TERMINAL_ACTIVITY_TTL_MS,
    })
    expect(stale.projects[0].changes[0].terminalActivity).toBeUndefined()

    await unlink(sidecar)
    await symlink('outside.json', sidecar)
    const linked = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't', now: () => now })
    expect(linked.projects[0].changes[0].terminalActivity).toBeUndefined()
  })

  it('OpenSpec tasks.md 按 default 七阶段投影到 snapshot，而不是由原始会话提示词另造 Todo', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'todo-source')
    await store.set(dir, 'phase', 'build')
    await writeFile(join(dir, 'tasks.md'), `# Tasks

## Open
- [x] Confirm scope

## Build
- [ ] Implement the endpoint
`, 'utf8')

    const snapshot = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    const todo = snapshot.projects[0]?.changes[0]?.todo
    expect(todo?.hasTaskSource).toBe(true)
    expect(todo?.stages.map((stage) => stage.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(todo?.stages.find((stage) => stage.id === 'open')?.tasks).toEqual([
      { text: '[document] proposal', completed: false },
      { text: '[document] openspec-design', completed: false },
      { text: '[document] tasks', completed: false },
      { text: 'Confirm scope', completed: true },
    ])
    expect(todo?.stages.find((stage) => stage.id === 'build')?.tasks).toEqual([{ text: 'Implement the endpoint', completed: false }])
  })

  it('三步 document-v1 workflow 只投影真实 step，并把文档挂到声明的 owner step', async () => {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'compact-governed.yaml'), `name: compact-governed
openspec: true
document_contract:
  version: v1
  slots:
    - kind: proposal
      owner_step: shape
      producers: [writer]
  reads:
    - step: implement
      kinds: [proposal]
steps:
  - id: shape
    label: Shape
    gate: null
    skills:
      - id: writer
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: shaped
        to: implement
  - id: implement
    label: Implement
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: implemented
        to: verify
  - id: verify
    label: Verify
    gate: review
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`, 'utf8')
    const changeDir = await store.init({
      repoRoot: root,
      name: 'compact-change',
      track: 'backend',
      reviewSeed: builtinTrack('backend').policyProfile.reviewSeed,
      creator: TEST_CREATOR, preset: 'full',
      runId: 'compact-run',
      clock: () => '2026-07-07T00:00:00Z',
      initialWorkflow: {
        workflow: 'compact-governed',
        phase: 'shape',
        documentContract: true,
        documentProfile: 'document-v1',
      },
    })
    await ensureDocumentLedger(changeDir, '2026-07-07T00:00:00Z')

    const snapshot = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    const change = snapshot.projects[0]?.changes[0]
    expect(change?.todo?.stages.map((stage) => stage.id)).toEqual(['shape', 'implement', 'verify'])
    expect(change?.todo?.stages[0]?.tasks).toEqual([{ text: '[document] proposal', completed: false }])
    expect(change?.todo?.stages.some((stage) => stage.id === 'open')).toBe(false)
    expect(change?.documents).toMatchObject({
      governed: true,
      phase: 'shape',
      ledgerPresent: true,
      pass: false,
    })
  })

  it('已冻结 document-v1 workflow 后删除当前定义，snapshot 仍按初始化快照投影', async () => {
    const store = newStore()
    const root = await makeProject()
    const workflows = join(root, '.pipeline', 'workflows')
    await mkdir(workflows, { recursive: true })
    const target = join(workflows, 'bound.yaml')
    const governed = `name: bound
openspec: true
document_contract:
  version: v1
  slots:
    - kind: proposal
      owner_step: shape
      producers: [writer]
  reads: []
steps:
  - id: shape
    label: Shape
    gate: null
    skills:
      - id: writer
    inputs: []
    outputs: []
    guards: []
    transitions: []
`
    await writeFile(target, governed, 'utf8')
    const plan = loadEffectiveWorkflowPlan(root, 'bound')
    const changeDir = await store.init({
      repoRoot: root,
      name: 'bound-change',
      track: 'backend',
      reviewSeed: builtinTrack('backend').policyProfile.reviewSeed,
      creator: TEST_CREATOR, preset: 'full',
      runId: 'bound-run',
      clock: () => '2026-07-07T00:00:00Z',
      initialWorkflow: {
        workflow: 'bound',
        phase: 'shape',
        ...effectiveWorkflowPlanBinding(plan),
        workflowPlanSnapshot: workflowPlanSnapshot(plan),
      },
    })
    expect(await readdir(changeDir)).toContain('.pipeline-workflow-plan.json')
    expect((await store.read(changeDir)).runMetadata?.workflowPlanSnapshot).toBeDefined()
    await writeFile(target, governed.replace(/document_contract:[\s\S]*?(?=steps:)/, ''), 'utf8')

    const snapshot = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(snapshot.projects[0]?.ok, JSON.stringify(snapshot.projects[0])).toBe(true)
    expect(snapshot.projects[0]?.changes[0]?.todo?.stages.map((stage) => stage.id)).toEqual(['shape'])
    expect(snapshot.projects[0]?.changes[0]?.documents?.governed).toBe(true)
    expect(snapshot.change_count).toBe(1)
  })

  it('Tenon server 继续投影身份迁移前冻结的 default v1 workflow snapshot', async () => {
    const store = newStore()
    const root = await makeProject()
    // 分支化之前的 default：frontend 分支 × 驱动技能 × spec plan artifact 的 PM 豁免谓词（与 kernel test-support 同口径）。
    const branched = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
    const legacyDef = {
      ...branched,
      tracks: undefined,
      steps: (branched.tracks?.frontend?.steps ?? []).map((step) => ({
        ...step,
        skills: step.skills.filter((skill) => skill.id.startsWith('tenon-')),
        ...(step.id === 'spec' && step.artifacts !== undefined
          ? { artifacts: step.artifacts.map((artifact) => artifact.field === 'plan' ? { ...artifact, requiredWhen: { kind: 'track-not-in' as const, values: ['pm'] } } : artifact) }
          : {}),
      })),
    }
    const currentWorkflow = compileEffectiveWorkflowPlan('default', legacyDef).workflow
    const {
      decomposition: _decomposition,
      interaction: _interaction,
      reviewBudget: _reviewBudget,
      // Historical bytes predate the openspec key and YAML-declared document contracts.
      openspec: _openspec,
      documentContract: _documentContract,
      ...legacyBase
    } = currentWorkflow
    const legacyWorkflow = {
      ...legacyBase,
      // Historical bytes also predate step prompts (the frontend branch gained them with DESIGN.md).
      steps: legacyBase.steps.map((step) => {
        // Historical bytes also predate step tests (2026-09 per-step test evidence) and step prompts.
        const { reviewLanes: _reviewLanes, tests: _tests, prompt: _prompt, ...legacyStep } = step
        return {
          ...legacyStep,
          // The last step was labelled 归档 before the 完结 wording.
          label: step.id === 'archive' ? '归档' : step.label,
          // This fixture represents a pre-issue#43 default snapshot: phase Skills were not
          // persisted yet, so historical fingerprint validation must use empty declarations.
          // It also predates the 2026-09 ship/archive inputs/outputs (pr_url / archived).
          skills: [],
          inputs: step.id === 'ship' || step.id === 'archive' ? [] : step.inputs,
          outputs: step.id === 'ship' || step.id === 'archive' ? [] : step.outputs,
          guards: step.id === 'build'
            ? step.guards.filter((guard) =>
                !(guard.type === 'field-equals' && guard.field === 'pre_verify_review_result'))
            : step.guards,
          transitions: step.transitions.map((transition) => ({
            ...transition,
            actions: transition.actions.filter((action) =>
              action.type !== 'reset-pre-verify-review'
                && !(step.id === 'verify'
                  && transition.event === 'verify-fail'
                  && action.type === 'mark-verification-failed')),
          })),
        }
      }),
    }
    const legacyChangeDir = await store.init({
      repoRoot: root,
      name: 'legacy-v1-live',
      track: 'frontend',
      reviewSeed: builtinTrack('frontend').policyProfile.reviewSeed,
      creator: TEST_CREATOR, preset: 'full',
      runId: 'legacy-v1-run',
      clock: () => '2026-07-26T00:00:00Z',
      initialWorkflow: {
        workflow: 'default',
        phase: 'verify',
        documentProfile: 'legacy-full',
        documentGovernanceFingerprint:
          '9238b11b7f0c0e7102eceddb5cb688c030e1a919fb5aef93ed5ba33ab7c2ec68',
        workflowPlanFingerprint:
          'c9a829b12b12138522532a9127efb8b93a551b1f28922a53dc174ad13e35b7dd',
        workflowPlanSnapshot: {
          version: 1,
          workflowId: 'default',
          executionModel: 'phase-manifest',
          workflow: legacyWorkflow,
          workflowFingerprint:
            'c9a829b12b12138522532a9127efb8b93a551b1f28922a53dc174ad13e35b7dd',
        },
      },
    })
    const legacyState = await store.read(legacyChangeDir)
    expect(legacyState.runMetadata?.workflowPlanSnapshot).toBeDefined()
    expect(effectiveWorkflowPlanFromSnapshot(legacyState.runMetadata!.workflowPlanSnapshot!)
      .workflowFingerprint).toBe(
      'c9a829b12b12138522532a9127efb8b93a551b1f28922a53dc174ad13e35b7dd',
    )

    const snapshot = await buildSnapshot({
      registry: () => [root],
      store,
      version: '1.0.0',
      clock: () => '2026-07-26T00:00:00Z',
    })

    expect(snapshot.projects[0]?.ok, snapshot.projects[0]?.error).toBe(true)
    expect(snapshot.projects[0]?.changes[0]).toMatchObject({
      name: 'legacy-v1-live',
      phase: 'verify',
    })
  })

  it('simple workflow 投影自己的 change→verify→done/escalated 骨架，不伪造七阶段或 OpenSpec 文档', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'tiny-fix', { track: 'simple', preset: 'tweak' })

    const snapshot = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    const change = snapshot.projects[0]?.changes[0]
    expect(change?.phase).toBe('change')
    expect(change?.fields.workflow).toBe('simple')
    expect(change?.todo).toEqual({
      hasTaskSource: false,
      stages: [
        { id: 'change', label: 'Change', status: 'current', tasks: [] },
        { id: 'verify', label: 'Verify', status: 'pending', tasks: [] },
        { id: 'done', label: 'Done', status: 'pending', tasks: [] },
        { id: 'escalated', label: 'Escalated', status: 'pending', tasks: [] },
      ],
    })
    expect(change?.documents).toEqual({ governed: false, blockers: [], items: [] })

    const dir = join(root, 'openspec', 'changes', 'tiny-fix')
    await store.set(dir, 'phase', 'escalated')
    const escalated = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(escalated.projects[0]?.changes[0]?.todo?.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ['change', 'done'],
      ['verify', 'pending'],
      ['done', 'pending'],
      ['escalated', 'current'],
    ])
  })

  it('不存在的注册路径 → ok:false 不炸', async () => {
    const snap = await buildSnapshot({
      registry: () => ['/definitely/not/here'], store: newStore(), version: '0', clock: () => 'x',
    })
    expect(snap.project_count).toBe(1)
    expect(snap.projects[0].ok).toBe(false)
    expect(snap.change_count).toBe(0)
  })
})

describe('computeFingerprint —— 变更检测', () => {
  it('changes 目录在空、不可读与恢复之间切换时改变指纹，SSE 不保留旧健康状态', async () => {
    const root = await makeProject()
    const empty = await computeFingerprint([root], 1, undefined, async () => [])
    const denied = await computeFingerprint([root], 1, undefined, async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const recovered = await computeFingerprint([root], 1, undefined, async () => [])
    const missing = await computeFingerprint([root], 1, undefined, async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })

    expect(denied).not.toBe(empty)
    expect(denied).toContain(`unreadable:${root}`)
    expect(recovered).toBe(empty)
    expect(missing).toBe(empty)
  })

  it('registry 增加空的非 Git 项目也改变指纹', async () => {
    const root = await makeProject()
    expect(await computeFingerprint([root])).not.toBe(await computeFingerprint([]))
  })

  it('已登记的空项目 root 被删除时改变指纹', async () => {
    const root = await makeProject()
    const before = await computeFingerprint([root])

    await rm(root, { recursive: true, force: true })

    expect(await computeFingerprint([root])).not.toBe(before)
  })

  it('已登记 root 变成 symlink 时不穿透目标的 Git metadata', async () => {
    const target = await makeProject()
    await execFileAsync('git', ['init'], { cwd: target })
    const root = `${target}-link`
    await symlink(target, root)

    const fingerprint = await computeFingerprint([root])

    expect(fingerprint).toContain(`registry:${root}`)
    expect(fingerprint).not.toContain(`${root}/.git`)
  })

  it('项目顶层无关文件变化不触发 fingerprint', async () => {
    const root = await makeProject()
    const before = await computeFingerprint([root])

    await writeFile(join(root, 'irrelevant.txt'), 'not snapshot input', 'utf8')

    expect(await computeFingerprint([root])).toBe(before)
  })

  it('普通 Git index 更新不触发 repository topology fingerprint', async () => {
    const root = await makeProject()
    await execFileAsync('git', ['init'], { cwd: root })
    const before = await computeFingerprint([root])

    await writeFile(join(root, 'ordinary.txt'), 'ordinary workspace content', 'utf8')
    await execFileAsync('git', ['add', 'ordinary.txt'], { cwd: root })

    expect(await computeFingerprint([root])).toBe(before)
  })

  it('已登记 root 初始化为 Git 时改变指纹并触发 repository 分组刷新', async () => {
    const root = await makeProject()
    const before = await computeFingerprint([root])
    expect(before).toContain(':directory:')

    await execFileAsync('git', ['init'], { cwd: root })

    const after = await computeFingerprint([root])
    expect(after).not.toBe(before)
    expect(after).toContain('.git')
  })

  it('fd 风格的目录 symlink 根会被遍历而非按 other 提前返回', async () => {
    const root = await makeProject()
    const fdPath = `${root}-fd`
    await symlink(root, fdPath, 'dir')
    const anchor = captureWorkflowRootAnchor(root)
    const anchored = { ...anchor, fdPath }

    try {
      const before = await computeFingerprint([root], 1, () => anchored)
      expect(before).toContain(':directory:')

      await execFileAsync('git', ['init'], { cwd: root })

      const after = await computeFingerprint([root], 1, () => anchored)
      expect(after).not.toBe(before)
      expect(after).toContain(`${fdPath}/.git`)
    } finally {
      closeWorkflowRootAnchor(anchor)
      await unlink(fdPath)
    }
  })

  it('dangling canonical current 仍进入 fingerprint，不能因 stat 跟随失败而消失', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'dangling-current')
    const current = join(dir, '.pipeline-run', 'current.json')
    await unlink(current)
    await symlink('missing.json', current)

    expect(await computeFingerprint([root])).toContain('.pipeline-run/current.json')
  })

  it('YAML projection 缺失时仍以 canonical current 追踪 change 与 revision 变化', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'canonical-only')
    await unlink(join(dir, '.pipeline.yaml'))

    const fp0 = await computeFingerprint([root])
    expect(fp0).toContain('.pipeline-run/current.json')
    await sleep(5)
    await store.set(dir, 'phase', 'explore')
    const fp1 = await computeFingerprint([root])
    expect(fp1).not.toBe(fp0)
  })

  it('写盘后指纹改变（SSE 推送的触发源）', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'c1')
    const fp0 = await computeFingerprint([root])
    await sleep(5)
    await store.set(dir, 'phase', 'explore')
    const fp1 = await computeFingerprint([root])
    expect(fp1).not.toBe(fp0)
  })

  it('tasks.md 变更也改变指纹，SSE 会推送新的 Todo 投影', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'todo-fingerprint')
    const tasks = join(dir, 'tasks.md')
    await writeFile(tasks, '- [ ] First task\n', 'utf8')
    const fp0 = await computeFingerprint([root])
    await sleep(5)
    await writeFile(tasks, '- [x] First task\n', 'utf8')
    const fp1 = await computeFingerprint([root])
    expect(fp1).not.toBe(fp0)
  })

  it('terminal activity 到 TTL 会令指纹切换，SSE 不会把停止的普通会话永久显示为运行中', async () => {
    const store = newStore()
    const root = await makeProject()
    const dir = await initChange(store, root, 'terminal-expiry')
    const heartbeat = Date.parse('2026-07-24T06:00:00.000Z')
    await writeFile(join(dir, '.pipeline-terminal-activity.json'), JSON.stringify({
      protocol: 'pipeline-terminal-activity-v1',
      change: 'terminal-expiry',
      session_id: 'session-expiry',
      heartbeat_at: '2026-07-24T06:00:00.000Z',
    }), 'utf8')
    const fresh = await computeFingerprint([root], heartbeat)
    const expired = await computeFingerprint([root], heartbeat + TERMINAL_ACTIVITY_TTL_MS)
    expect(fresh).not.toBe(expired)
  })
})

describe('归档划分与未提交删除（查看者视角）', () => {
  const alice: TenonUserResolution = { id: 'a@x.io', name: 'A', slug: 'a-at-x.io', source: 'env', trust: 'declared' }
  const bob: TenonUserResolution = { id: 'b@x.io', name: 'B', slug: 'b-at-x.io', source: 'env', trust: 'declared' }

  async function archiveFor(root: string, slug: string, change: string, phase = 'build'): Promise<string> {
    const paths = await ensureUserLocalDir(root, slug)
    await writeFile(paths.archived, serializeTaskArchive({
      version: 1,
      changes: { [change]: { archivedAt: '2026-09-15T12:00:00.000Z', phase, actor: { id: 'a@x.io', name: 'A', trust: 'declared' } } },
    }), 'utf8')
    return paths.archived
  }

  it('把查看者已归档的 change 从 changes 划到 archived，其他查看者不受影响', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'hidden')
    await initChange(store, root, 'shown')
    await archiveFor(root, alice.slug, 'hidden')

    const forAlice = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't', viewer: () => alice,
    })
    const project = forAlice.projects[0]!
    expect(project.changes.map((change) => change.name)).toEqual(['shown'])
    expect(project.archived?.map((change) => change.name)).toEqual(['hidden'])
    expect(project.archived?.[0]?.archive).toEqual({
      archivedAt: '2026-09-15T12:00:00.000Z', phase: 'build', actor: { id: 'a@x.io', name: 'A', trust: 'declared' },
    })
    expect(forAlice.change_count).toBe(1)

    const forBob = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't', viewer: () => bob,
    })
    expect(forBob.projects[0]?.changes.map((change) => change.name)).toEqual(['hidden', 'shown'])
    expect(forBob.projects[0]?.archived).toBeUndefined()
    expect(forBob.change_count).toBe(2)
  })

  it('无查看者或归档记录损坏时不隐藏任何 change', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'hidden')
    const archivePath = await archiveFor(root, alice.slug, 'hidden')

    const anonymous = await buildSnapshot({ registry: () => [root], store, version: '1', clock: () => 't' })
    expect(anonymous.projects[0]?.changes.map((change) => change.name)).toEqual(['hidden'])

    await writeFile(archivePath, 'not json', 'utf8')
    const corrupt = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't', viewer: () => alice,
    })
    expect(corrupt.projects[0]?.changes.map((change) => change.name)).toEqual(['hidden'])
    expect(corrupt.projects[0]?.archived).toBeUndefined()
  })

  it('未提交删除数按项目注入；null 时字段缺省', async () => {
    const store = newStore()
    const root = await makeProject()
    await initChange(store, root, 'one')
    const counted = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't', countDeletions: async () => 2,
    })
    expect(counted.projects[0]?.uncommittedDeletions).toBe(2)
    const absent = await buildSnapshot({
      registry: () => [root], store, version: '1', clock: () => 't', countDeletions: async () => null,
    })
    expect(absent.projects[0]?.uncommittedDeletions).toBeUndefined()
  })

  it('指纹在查看者 archived.json 写入后与提交日志变化后都改变', async () => {
    const root = await makeProject()
    const store = newStore()
    await initChange(store, root, 'one')
    const before = await computeFingerprint([root], 1, undefined, undefined, () => alice)
    await archiveFor(root, alice.slug, 'one')
    const afterArchive = await computeFingerprint([root], 1, undefined, undefined, () => alice)
    expect(afterArchive).not.toBe(before)

    await mkdir(join(root, '.git', 'logs'), { recursive: true })
    await writeFile(join(root, '.git', 'logs', 'HEAD'), 'commit one\n', 'utf8')
    const afterCommit = await computeFingerprint([root], 1, undefined, undefined, () => alice)
    expect(afterCommit).not.toBe(afterArchive)
    // Another viewer's store is not part of this viewer's fingerprint.
    await archiveFor(root, bob.slug, 'one')
    expect(await computeFingerprint([root], 1, undefined, undefined, () => alice)).toBe(afterCommit)
  })
})
