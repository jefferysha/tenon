/**
 * task lifecycle 依赖图 —— 纯逻辑 + 真 fs 树加载单元测试（老仓 state-task.sh 语义对位）。
 * 纯函数无需 mock（本就是真实断言）；loadTaskTree/resolveChangeDir 真跑临时 fs + 真 store。
 */
import { mkdtemp, rename, rm, mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createStateStore } from './store.js'
import { serializePipeline, emptyFields } from './parse.js'
import type { PipelineState } from '../types.js'
import {
  normalizeDeps,
  addDependency,
  removeDependency,
  taskNameMatches,
  directChildren,
  cascadeDependents,
  projectCanonical,
  loadTaskTree,
  resolveChangeDir,
  type ChangeNode,
} from './tasks.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

describe('normalizeDeps —— depends_on 三态归一（老仓 _deps_read state-task.sh:141-145）', () => {
  test('"null" / "" / undefined / [] → 空集', () => {
    expect(normalizeDeps('null')).toEqual([])
    expect(normalizeDeps('')).toEqual([])
    expect(normalizeDeps(undefined)).toEqual([])
    expect(normalizeDeps([])).toEqual([])
  })
  test('CSV 标量 → split + trim + 去空（兼容老仓 CSV 存储）', () => {
    expect(normalizeDeps('a,b,c')).toEqual(['a', 'b', 'c'])
    expect(normalizeDeps(' a , b ,, c ')).toEqual(['a', 'b', 'c'])
  })
  test('数组（新仓 list 存储）→ trim + 去空', () => {
    expect(normalizeDeps(['a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeDeps([' a ', '', 'b'])).toEqual(['a', 'b'])
  })
})

describe('addDependency —— 去重幂等 + 尾接保序（老仓 cmd_add_dep state-task.sh:147-172）', () => {
  test('空集追加', () => {
    expect(addDependency([], 'x')).toEqual({ deps: ['x'], added: true })
  })
  test('尾接保序', () => {
    expect(addDependency(['a', 'b'], 'c')).toEqual({ deps: ['a', 'b', 'c'], added: true })
  })
  test('已含 → 幂等 added=false，原样返回', () => {
    expect(addDependency(['a', 'b'], 'b')).toEqual({ deps: ['a', 'b'], added: false })
  })
})

describe('removeDependency —— 精确移除保序（老仓 cmd_remove_dep state-task.sh:174-183）', () => {
  test('移除存在项', () => {
    expect(removeDependency(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
  test('移除末项 → 空集', () => {
    expect(removeDependency(['a'], 'a')).toEqual([])
  })
  test('移除不存在项 → 原样（无副作用）', () => {
    expect(removeDependency(['a', 'b'], 'z')).toEqual(['a', 'b'])
  })
})

describe('taskNameMatches —— 宽松名匹配（老仓 _tree_name_matches state-task.sh:233-241）', () => {
  test('精确相等', () => {
    expect(taskNameMatches('foo', 'foo')).toBe(true)
  })
  test('target 目录名带前缀、dep 短名：target 尾 -dep', () => {
    expect(taskNameMatches('foo', '01-02-foo')).toBe(true)
  })
  test('dep 带前缀、target 短名：dep 尾 -target', () => {
    expect(taskNameMatches('01-02-foo', 'foo')).toBe(true)
  })
  test('不匹配', () => {
    expect(taskNameMatches('foobar', 'foo')).toBe(false)
    expect(taskNameMatches('bar', 'foo')).toBe(false)
  })
})

function node(name: string, deps: string[], archived = false): ChangeNode {
  return { name, archived, deps }
}

describe('directChildren —— 反查直接子（老仓 _tree_direct_children state-task.sh:243-261）', () => {
  const tree: ChangeNode[] = [
    node('a', []),
    node('b', ['a']),
    node('c', ['a', 'b']),
    node('d', ['x']),
    node('01-02-a', ['a']), // 依赖 a 但自身带前缀（不与 a 混淆）
  ]
  test('反查 depends_on 含 target 的 change（不含自身）', () => {
    const kids = directChildren(tree, 'a').map((c) => c.name).sort()
    expect(kids).toEqual(['01-02-a', 'b', 'c'])
  })
  test('无子 → 空（c 被谁都不依赖）', () => {
    expect(directChildren(tree, 'c')).toEqual([])
  })
  test('archived 标记随节点', () => {
    const t = [node('p', []), node('q', ['p'], true), node('r', ['p'], false)]
    const kids = directChildren(t, 'p')
    expect(kids.find((c) => c.name === 'q')?.archived).toBe(true)
    expect(kids.find((c) => c.name === 'r')?.archived).toBe(false)
  })
})

describe('cascadeDependents —— BFS 传递闭包防环（老仓 cmd_cascade state-task.sh:299-325）', () => {
  test('传递后代（a → b → c 链）', () => {
    const tree = [node('a', []), node('b', ['a']), node('c', ['b']), node('d', ['c'])]
    const names = cascadeDependents(tree, 'a').map((c) => c.name)
    expect(names).toEqual(['b', 'c', 'd'])
  })
  test('分叉：a 的直接子 b,c + b 的子 d', () => {
    const tree = [node('a', []), node('b', ['a']), node('c', ['a']), node('d', ['b'])]
    const names = cascadeDependents(tree, 'a').map((c) => c.name).sort()
    expect(names).toEqual(['b', 'c', 'd'])
  })
  test('环防护：a→b→a 不死循环', () => {
    const tree = [node('a', ['b']), node('b', ['a'])]
    const names = cascadeDependents(tree, 'a').map((c) => c.name)
    expect(names).toEqual(['b'])
  })
  test('无后代 → 空', () => {
    expect(cascadeDependents([node('a', []), node('b', [])], 'a')).toEqual([])
  })
})

describe('projectCanonical —— Tenon contract 24 字段投影（老仓 cmd_canonical state-task.sh:341-422）', () => {
  test('全字段映射 + nz 空/null 归一', () => {
    const fields = emptyFields()
    fields.phase = 'build'
    fields.track = 'backend'
    fields.scope = ['api']
    fields.created_by = 'alice'
    fields.assignee = 'bob'
    fields.created_at = '2026-01-01T00:00:00Z'
    fields.archived_at = 'null'
    fields.branch = 'feat/foo'
    fields.base_branch = 'main'
    fields.automation_worktree = ''
    fields.build_sha = 'abc123'
    fields.pr_url = 'null'
    const rec = projectCanonical({
      name: 'foo',
      fields,
      subtasks: ['dep-a', 'dep-b'],
      children: ['kid-x'],
      relatedFiles: ['src/a.ts'],
    })
    expect(rec).toEqual({
      id: 'foo',
      name: 'foo',
      title: 'foo',
      description: '',
      status: 'build',
      dev_type: 'backend',
      scope: 'api',
      package: null,
      priority: 'normal',
      creator: 'alice',
      assignee: 'bob',
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      branch: 'feat/foo',
      base_branch: 'main',
      worktree_path: null,
      commit: 'abc123',
      pr_url: null,
      subtasks: ['dep-a', 'dep-b'],
      children: ['kid-x'],
      parent: null,
      relatedFiles: ['src/a.ts'],
      notes: '',
      meta: {},
    })
  })
  test('字段序即 schema（键序固定，24 字段）', () => {
    const rec = projectCanonical({ name: 'x', fields: emptyFields(), subtasks: [], children: [], relatedFiles: [] })
    expect(Object.keys(rec)).toEqual([
      'id', 'name', 'title', 'description', 'status', 'dev_type', 'scope', 'package',
      'priority', 'creator', 'assignee', 'createdAt', 'completedAt', 'branch', 'base_branch',
      'worktree_path', 'commit', 'pr_url', 'subtasks', 'children', 'parent', 'relatedFiles',
      'notes', 'meta',
    ])
  })
})

// === 真 fs：loadTaskTree / resolveChangeDir（真 store + 真临时目录） ===

describe('loadTaskTree / resolveChangeDir —— 真 fs 树枚举（老仓 _tree_all_changes state-task.sh:201-221）', () => {
  let root: string
  const store = createStateStore()

  async function writeChange(dir: string, deps: string | string[]): Promise<void> {
    await mkdir(dir, { recursive: true })
    const fields = emptyFields()
    fields.phase = 'open'
    fields.depends_on = deps
    const state: PipelineState = { fields, opaqueTail: '' }
    await writeFile(join(dir, '.pipeline.yaml'), serializePipeline(state), 'utf8')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tasks-tree-'))
    const changes = join(root, 'openspec', 'changes')
    await writeChange(join(changes, 'a'), 'null')
    await writeChange(join(changes, 'b'), ['a'])
    await writeChange(join(changes, 'c'), ['a', 'b'])
    // 归档区（任意深度）
    await writeChange(join(changes, 'archive', '2026-07', '99-old'), ['a'])
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('活跃 + 归档全枚举，archived 标记正确，depends_on 真读', async () => {
    const tree = await loadTaskTree(root, store)
    const byName = Object.fromEntries(tree.map((n) => [n.name, n]))
    expect(Object.keys(byName).sort()).toEqual(['99-old', 'a', 'b', 'c'])
    expect(byName.a!.archived).toBe(false)
    expect(byName.a!.deps).toEqual([])
    expect(byName.b!.deps).toEqual(['a'])
    expect(byName.c!.deps).toEqual(['a', 'b'])
    expect(byName['99-old']!.archived).toBe(true)
    expect(byName['99-old']!.deps).toEqual(['a'])
  })

  test('真 fs 反查：a 的直接子 = b, c, 99-old(archived)', async () => {
    const tree = await loadTaskTree(root, store)
    const kids = directChildren(tree, 'a')
    expect(kids.map((c) => c.name).sort()).toEqual(['99-old', 'b', 'c'])
    expect(kids.find((c) => c.name === '99-old')?.archived).toBe(true)
  })

  test('G1：归档 change 仅保留 canonical current 时仍进入依赖树', async () => {
    const dir = await store.init({
      repoRoot: root, name: 'canonical-old', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full',
      clock: () => '2026-07-19T00:00:00Z',
    })
    await store.set(dir, 'depends_on', ['a'])
    const archived = join(root, 'openspec', 'changes', 'archive', '2026-08', '100-canonical-old')
    await mkdir(join(root, 'openspec', 'changes', 'archive', '2026-08'), { recursive: true })
    await rename(dir, archived)
    await unlink(join(archived, '.pipeline.yaml'))

    const tree = await loadTaskTree(root, store)
    expect(tree).toContainEqual({ name: '100-canonical-old', archived: true, deps: ['a'] })
  })

  test('resolveChangeDir：精确命中', async () => {
    const dir = await resolveChangeDir(root, 'a')
    expect(dir).toBe(join(root, 'openspec', 'changes', 'a'))
  })

  test('resolveChangeDir：*-<name> 前缀回退', async () => {
    const changes = join(root, 'openspec', 'changes')
    await writeChange(join(changes, '07-08-widget'), 'null')
    const dir = await resolveChangeDir(root, 'widget')
    expect(dir).toBe(join(changes, '07-08-widget'))
  })

  test('resolveChangeDir：都不中 → 回退精确路径', async () => {
    const dir = await resolveChangeDir(root, 'nope')
    expect(dir).toBe(join(root, 'openspec', 'changes', 'nope'))
  })
})
