import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectRegistry, writeProjectRegistry } from '@tenon/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { handleProjectCreate, runGitCommand, type GitRunner, type ProjectCreateDeps } from './projectCreate.js'
import { closeWorkflowRootAnchor, type WorkflowRootAnchor } from './workflowRootAnchor.js'

const dirs: string[] = []
const anchorMaps: Map<string, WorkflowRootAnchor>[] = []

afterEach(async () => {
  for (const anchors of anchorMaps.splice(0)) for (const anchor of anchors.values()) closeWorkflowRootAnchor(anchor)
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `tenon-project-create-${label}-`))
  dirs.push(dir)
  return dir
}

async function deps(runGit: GitRunner = runGitCommand): Promise<ProjectCreateDeps & { registryPath: string }> {
  const config = await tempDir('config')
  const anchors = new Map<string, WorkflowRootAnchor>()
  anchorMaps.push(anchors)
  const registryPath = join(config, 'projects.json')
  return {
    paths: { registryPath, configRoot: config }, workflowRootAnchors: anchors, runGit, registryPath,
    actor: { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' },
  }
}

const instructions = (targets: string[], baseDigests: Record<string, string> = {}) =>
  ({ text: '# shop\n\n## 前端\n', targets, base_digests: baseDigests })

type Body = Record<string, unknown>

describe('POST /api/projects/create — empty directory', () => {
  it('dry run 只返回计划，不创建目录', async () => {
    const parent = await tempDir('parent')
    const d = await deps()
    const result = await handleProjectCreate({
      mode: 'empty', parent, name: 'shop', directories: ['frontend/', 'backend/', 'sql/'],
      instructions: instructions(['CLAUDE.md', 'AGENTS.md']), dry_run: true,
    }, d)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      root: join(parent, 'shop'), git: 'init', registration: 'add',
      directories: [{ path: 'frontend/', exists: false }, { path: 'backend/', exists: false }, { path: 'sql/', exists: false }],
    })
    expect(((result.body as Body).files as { id: string; current: null; next: string }[]).map((file) => [file.id, file.current, file.next]))
      .toEqual([['CLAUDE.md', null, '# shop\n\n## 前端\n'], ['AGENTS.md', null, '# shop\n\n## 前端\n']])
    expect(existsSync(join(parent, 'shop'))).toBe(false)
  })

  it('执行：创建目录、git init、骨架目录 .gitkeep、指令文件一致、登记并保存锚', async () => {
    const parent = await tempDir('parent')
    const d = await deps()
    const result = await handleProjectCreate({
      mode: 'empty', parent, name: 'shop', directories: ['frontend/', 'backend/', 'sql/'],
      instructions: instructions(['CLAUDE.md', 'AGENTS.md']), dry_run: false,
    }, d)
    expect(result.status).toBe(200)
    const root = join(parent, 'shop')
    expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true)
    for (const dir of ['frontend', 'backend', 'sql']) expect(statSync(join(root, dir, '.gitkeep')).size).toBe(0)
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(await readFile(join(root, 'AGENTS.md'), 'utf8'))
    expect(readProjectRegistry(d.registryPath)).toContain(root)
    expect(d.workflowRootAnchors.get(root)?.path).toBe(root)
    expect(result.body).toMatchObject({ git: 'init', registration: 'add', directories: ['frontend/', 'backend/', 'sql/'] })
  })

  it('目录已存在 → 409，什么都不写', async () => {
    const parent = await tempDir('parent')
    await mkdir(join(parent, 'shop'))
    await writeFile(join(parent, 'shop', 'keep.txt'), 'x')
    const d = await deps()
    const result = await handleProjectCreate({ mode: 'empty', parent, name: 'shop', directories: ['sql/'], instructions: instructions(['CLAUDE.md']) }, d)
    expect(result.status).toBe(409)
    expect((result.body as Body).code).toBe('project-path-exists')
    expect(readdirSync(join(parent, 'shop'))).toEqual(['keep.txt'])
  })

  it('git 不可用 → 422，mkdir 之前就拒绝', async () => {
    const parent = await tempDir('parent')
    const d = await deps(async () => ({ code: 127, stderr: 'not found' }))
    const result = await handleProjectCreate({ mode: 'empty', parent, name: 'shop', directories: [], instructions: null }, d)
    expect(result.status).toBe(422)
    expect((result.body as Body).code).toBe('git-unavailable')
    expect(existsSync(join(parent, 'shop'))).toBe(false)
  })

  it('mkdir 之后失败：删除本次创建的目录，500 带 step', async () => {
    const parent = await tempDir('parent')
    const d = await deps(async (args) => (args[0] === 'init' ? { code: 1, stderr: 'boom' } : { code: 0, stderr: '' }))
    const result = await handleProjectCreate({ mode: 'empty', parent, name: 'shop', directories: ['sql/'], instructions: null }, d)
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ code: 'project-create-failed', step: 'git-init' })
    expect(existsSync(join(parent, 'shop'))).toBe(false)
    expect(readProjectRegistry(d.registryPath)).toEqual([])
  })

  it('非法输入：相对路径、非法名称、骨架目录名、父目录缺失或是符号链接', async () => {
    const parent = await tempDir('parent')
    const d = await deps()
    expect((await handleProjectCreate({ mode: 'empty', parent: 'relative', name: 'shop' }, d)).status).toBe(400)
    expect((await handleProjectCreate({ mode: 'empty', parent, name: '../x' }, d)).status).toBe(400)
    expect((await handleProjectCreate({ mode: 'empty', parent, name: 'shop', directories: ['a/b/'] }, d)).status).toBe(400)
    expect((await handleProjectCreate({ mode: 'empty', parent: join(parent, 'missing'), name: 'shop' }, d)).body).toMatchObject({ code: 'parent-missing' })
    await symlink(parent, join(parent, 'link'))
    expect((await handleProjectCreate({ mode: 'empty', parent: join(parent, 'link'), name: 'shop' }, d)).body).toMatchObject({ code: 'path-unsafe' })
  })
})

describe('POST /api/projects/create — existing directory', () => {
  it('已是 git 仓库：不 git init、不建骨架目录，指令文件按 dry run 摘要写入并登记', async () => {
    const root = await tempDir('existing')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const calls: string[][] = []
    const d = await deps(async (args) => { calls.push([...args]); return { code: 0, stderr: '' } })
    const plan = await handleProjectCreate({ mode: 'existing', path: root, instructions: instructions(['AGENTS.md']), dry_run: true }, d)
    expect(plan.body).toMatchObject({ git: 'existing', registration: 'add', directories: [] })
    const baseDigest = ((plan.body as Body).files as { base_digest: string }[])[0]?.base_digest ?? ''
    const result = await handleProjectCreate({ mode: 'existing', path: root, instructions: instructions(['AGENTS.md'], { 'AGENTS.md': baseDigest }) }, d)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ git: 'existing', registration: 'add' })
    expect(calls).toEqual([])
    expect(await readFile(join(root, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(readdirSync(root).sort()).toEqual(['.git', 'AGENTS.md'])
    expect(readProjectRegistry(d.registryPath)).toContain(root)
  })

  it('已登记的项目 → registration: already，不报错', async () => {
    const root = await tempDir('registered')
    const d = await deps()
    await writeProjectRegistry(d.registryPath, [root])
    const result = await handleProjectCreate({ mode: 'existing', path: root, instructions: null }, d)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ git: 'none', registration: 'already' })
  })

  it('本机无声明身份：执行 412 不创建，dry run 仍可用', async () => {
    const parent = await tempDir('parent')
    const d = { ...(await deps()), actor: null }
    const result = await handleProjectCreate({ mode: 'empty', parent, name: 'shop', instructions: null }, d)
    expect(result.status).toBe(412)
    expect((result.body as Body).code).toBe('user-missing')
    expect(existsSync(join(parent, 'shop'))).toBe(false)
    expect(readProjectRegistry(d.registryPath)).toEqual([])
    expect((await handleProjectCreate({ mode: 'empty', parent, name: 'shop', instructions: null, dry_run: true }, d)).status).toBe(200)
  })

  it('已有目录带骨架目录 → 400；路径不存在 → 404', async () => {
    const root = await tempDir('bad-existing')
    const d = await deps()
    expect((await handleProjectCreate({ mode: 'existing', path: root, directories: ['sql/'] }, d)).status).toBe(400)
    expect((await handleProjectCreate({ mode: 'existing', path: join(root, 'missing') }, d)).status).toBe(404)
  })
})
