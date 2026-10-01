/**
 * Track CRUD 纯配置变换 + mutate-under-lock 原语 + 引用完整性 + 进程内真实锁并发（T-R3）。
 * 跨进程真实锁竞争另见 crud.crossprocess.integration.test.ts。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withLock } from '../state/lock.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { builtinTrack, BUILTIN_TRACK_IDS } from './builtins.js'
import {
  assertTrackDeletable,
  assertUpdatePreservesReferences,
  BuiltinTrackDeleteError,
  BuiltinTrackPolicyError,
  ChangeScanFailedError,
  createTrack,
  deleteTrack,
  TrackAlreadyExistsError,
  TrackNotFoundError,
  TrackReferencedError,
  TrackReferencesInvalidatedError,
  updateTrack,
  type ChangeRefScan,
} from './crud.js'
import { loadTrackRegistry, mutateTrackRegistry, trackRegistryPath, withTrackRegistryLock } from './registry.js'
import type { CreateTrackSpec, ProjectTrackConfig, TrackValidationContext, UpdateTrackPatch } from './types.js'

const CTX: TrackValidationContext = {
  workflowExists: (id) => ['default', 'wf-a', 'wf-b', 'data-flow'].includes(id),
  skillProfiles: new Set(['pm', 'frontend', 'backend']),
}

/** 合法额外轨规格：绑 default（恒存在）、policy 复用 chat 内建（skills._all、routing off）。 */
function spec(id: string, over: Partial<CreateTrackSpec> = {}): CreateTrackSpec {
  return {
    id,
    label: over.label ?? `L-${id}`,
    workflow: over.workflow ?? { default: 'default', allowed: '*' },
    policyProfile: over.policyProfile ?? structuredClone(builtinTrack('chat').policyProfile),
  }
}

const EMPTY: ProjectTrackConfig = { version: 1 }

// ── 纯配置变换 ────────────────────────────────────────────────────────────────

describe('createTrack — 纯配置变换', () => {
  test('追加额外轨并保留声明序', () => {
    const c1 = createTrack(EMPTY, spec('data'))
    const c2 = createTrack(c1, spec('ops'))
    expect(c2.tracks?.map((t) => t.id)).toEqual(['data', 'ops'])
  })

  test('撞内建 id → TrackAlreadyExistsError(builtin)', () => {
    expect(() => createTrack(EMPTY, spec('backend'))).toThrow(TrackAlreadyExistsError)
    try {
      createTrack(EMPTY, spec('pm'))
    } catch (e) {
      expect((e as TrackAlreadyExistsError).collidesWith).toBe('builtin')
    }
  })

  test('撞已有 custom id → TrackAlreadyExistsError(custom)', () => {
    const c1 = createTrack(EMPTY, spec('data'))
    try {
      createTrack(c1, spec('data'))
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(TrackAlreadyExistsError)
      expect((e as TrackAlreadyExistsError).collidesWith).toBe('custom')
    }
  })
})

describe('deleteTrack — 纯配置变换', () => {
  test('删内建一律拒 → BuiltinTrackDeleteError', () => {
    expect(() => deleteTrack(EMPTY, 'chat')).toThrow(BuiltinTrackDeleteError)
  })

  test('删未注册 custom → TrackNotFoundError', () => {
    expect(() => deleteTrack(EMPTY, 'ghost')).toThrow(TrackNotFoundError)
  })

  test('删存在 custom → 移除且保留其余声明序；清空 → tracks undefined', () => {
    const c = createTrack(createTrack(EMPTY, spec('a')), spec('b'))
    expect(deleteTrack(c, 'a').tracks?.map((t) => t.id)).toEqual(['b'])
    const one = createTrack(EMPTY, spec('only'))
    expect(deleteTrack(one, 'only').tracks).toBeUndefined()
  })
})

describe('updateTrack — custom partial（保留未触字段）', () => {
  const base = createTrack(EMPTY, spec('data', { workflow: { default: 'wf-a', allowed: ['wf-a', 'wf-b'] } }))

  test('只改 label → workflow/policy 原样保留', () => {
    const next = updateTrack(base, 'data', { label: '数据' })
    const t = next.tracks![0]!
    expect(t.label).toBe('数据')
    expect(t.workflow).toEqual({ default: 'wf-a', allowed: ['wf-a', 'wf-b'] })
    expect(t.policyProfile).toEqual(base.tracks![0]!.policyProfile)
  })

  test('只改 workflow.allowed → default/label/policy 保留', () => {
    const next = updateTrack(base, 'data', { workflowAllowed: ['wf-a'] })
    const t = next.tracks![0]!
    expect(t.workflow).toEqual({ default: 'wf-a', allowed: ['wf-a'] })
    expect(t.label).toBe('L-data')
  })

  test('改 policyProfile → 展开成完整结构落盘', () => {
    const p = structuredClone(builtinTrack('frontend').policyProfile)
    const next = updateTrack(base, 'data', { policyProfile: p })
    expect(next.tracks![0]!.policyProfile?.coverageProfile).toBe('frontend')
  })

  test('update 未注册 → TrackNotFoundError', () => {
    expect(() => updateTrack(EMPTY, 'ghost', { label: 'x' })).toThrow(TrackNotFoundError)
  })
})

describe('updateTrack — builtin 可变面 + 差异覆盖归一化（D1）', () => {
  test('改 policyProfile → BuiltinTrackPolicyError', () => {
    expect(() =>
      updateTrack(EMPTY, 'chat', { policyProfile: structuredClone(builtinTrack('pm').policyProfile) }),
    ).toThrow(BuiltinTrackPolicyError)
  })

  test('改 label → 只存差异覆盖层', () => {
    const next = updateTrack(EMPTY, 'chat', { label: '会话' })
    expect(next.builtins).toEqual({ chat: { label: '会话' } })
  })

  test('改 workflow.allowed → 覆盖层写 workflow.allowed（default 不变则不写）', () => {
    const next = updateTrack(EMPTY, 'pm', { workflowAllowed: ['wf-a', 'default'] })
    expect(next.builtins).toEqual({ pm: { workflow: { allowed: ['wf-a', 'default'] } } })
  })

  test('把 label 改回代码默认 → 从覆盖层移除该字段，整节点空 → 移除节点', () => {
    const withOv = updateTrack(EMPTY, 'chat', { label: '会话' })
    const back = updateTrack(withOv, 'chat', { label: builtinTrack('chat').label })
    expect(back.builtins).toBeUndefined()
  })

  test('label 改回默认但 workflow 覆盖仍在 → 只留 workflow 覆盖', () => {
    let c = updateTrack(EMPTY, 'pm', { label: '产品' })
    c = updateTrack(c, 'pm', { workflowAllowed: ['wf-a', 'default'] })
    const back = updateTrack(c, 'pm', { label: builtinTrack('pm').label })
    expect(back.builtins).toEqual({ pm: { workflow: { allowed: ['wf-a', 'default'] } } })
  })
})

// ── mutate-under-lock 原语（真 fs）────────────────────────────────────────────

describe('mutateTrackRegistry — 锁内 read-modify-validate-write（真 fs）', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'pl-crud-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  const file = () => trackRegistryPath(repoRoot)

  test('空仓首次 create → 生成 version:1，四内建轨不写盘，load 回读为 4 内建 + custom', async () => {
    const { registry } = await mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({
      next: createTrack(config, spec('data')),
      result: undefined,
    }))
    const text = await readFile(file(), 'utf8')
    expect(text.startsWith('version: 1\n')).toBe(true)
    expect(text).not.toContain('chat') // 内建轨无需完整复制进文件
    expect(registry.ordered.map((t) => t.id)).toEqual([...BUILTIN_TRACK_IDS, 'data'])
    // 同 context 回读一致
    expect(loadTrackRegistry(repoRoot, CTX).ordered.map((t) => t.id)).toEqual([...BUILTIN_TRACK_IDS, 'data'])
  })

  test('next 校验失败（allowed 空数组）→ 抛错、不写盘', async () => {
    await expect(
      mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({
        next: createTrack(config, spec('bad', { workflow: { default: 'wf-a', allowed: [] } })),
        result: undefined,
      })),
    ).rejects.toThrow(/allowed: 数组不能为空|未过完整校验/)
    await expect(readFile(file(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('callback 抛错 → 文件不变（已有内容 byte 不变）', async () => {
    await mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: createTrack(config, spec('data')), result: 0 }))
    const before = await readFile(file(), 'utf8')
    await expect(
      mutateTrackRegistry(repoRoot, CTX, async () => {
        throw new Error('boom in callback')
      }),
    ).rejects.toThrow('boom in callback')
    expect(await readFile(file(), 'utf8')).toBe(before)
  })

  test('损坏 registry → 普通 CRUD 默认拒（fail-loud），文件 byte 不变（不隐式 repair）', async () => {
    await mkdir(path.dirname(file()), { recursive: true })
    await writeFile(file(), 'version: 1\ntracks:\n  - id: broken\n    label: X\n', 'utf8') // 缺 workflow/policy
    const before = await readFile(file(), 'utf8')
    await expect(
      mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: createTrack(config, spec('data')), result: 0 })),
    ).rejects.toThrow(/校验失败/)
    expect(await readFile(file(), 'utf8')).toBe(before)
  })

  test('mutate update builtin allowed → 持久化覆盖层，load 回读 effective 生效', async () => {
    await mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({
      next: updateTrack(config, 'pm', { workflowAllowed: ['wf-a', 'default'] }),
      result: 0,
    }))
    const reg = loadTrackRegistry(repoRoot, CTX)
    expect(reg.byId.get('pm')!.workflow.allowed).toEqual(['wf-a', 'default'])
  })

  test('mutate delete custom → 移除，load 回读不含该轨', async () => {
    await mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: createTrack(config, spec('data')), result: 0 }))
    await mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: deleteTrack(config, 'data'), result: 0 }))
    expect(loadTrackRegistry(repoRoot, CTX).byId.has('data')).toBe(false)
  })
})

// ── 引用完整性（注入 scan）─────────────────────────────────────────────────────

describe('引用完整性 — assertTrackDeletable', () => {
  const scanOf = (refs: ChangeRefScan['refs'], unreadable: ChangeRefScan['unreadable'] = []) => async () => ({ refs, unreadable })

  test('无引用 → 放行', async () => {
    await expect(assertTrackDeletable('data', scanOf([{ name: 'c1', track: 'chat', workflow: 'default' }]))).resolves.toBeUndefined()
  })

  test('单/多引用 → TrackReferencedError 并按名排序列出', async () => {
    const scan = scanOf([
      { name: 'zeta', track: 'data', workflow: 'default' },
      { name: 'alpha', track: 'data', workflow: 'wf-a' },
      { name: 'other', track: 'chat', workflow: 'default' },
    ])
    try {
      await assertTrackDeletable('data', scan)
      throw new Error('should reject')
    } catch (e) {
      expect(e).toBeInstanceOf(TrackReferencedError)
      expect((e as TrackReferencedError).references).toEqual(['alpha', 'zeta'])
    }
  })

  test('change 读不了 → fail-closed（ChangeScanFailedError）', async () => {
    await expect(assertTrackDeletable('data', scanOf([], ['broken1']))).rejects.toBeInstanceOf(ChangeScanFailedError)
  })
})

describe('引用完整性 — assertUpdatePreservesReferences', () => {
  const scanOf = (refs: ChangeRefScan['refs'], unreadable: ChangeRefScan['unreadable'] = []) => async () => ({ refs, unreadable })
  // next：data 轨 allowed 收窄为 [wf-a]（不含 wf-b）
  const next = createTrack(EMPTY, spec('data', { workflow: { default: 'wf-a', allowed: ['wf-a'] } }))

  test('缩 allowed 排除了在用 workflow 的 change → TrackReferencesInvalidatedError', async () => {
    const scan = scanOf([{ name: 'c1', track: 'data', workflow: 'wf-b' }])
    await expect(assertUpdatePreservesReferences(next, 'data', scan)).rejects.toBeInstanceOf(TrackReferencesInvalidatedError)
  })

  test('缩 allowed 但在用 workflow 仍在白名单内 → 放行', async () => {
    const scan = scanOf([{ name: 'c1', track: 'data', workflow: 'wf-a' }])
    await expect(assertUpdatePreservesReferences(next, 'data', scan)).resolves.toBeUndefined()
  })

  test('allowed=* （如改 label 不动 workflow）→ 无 change 会失效，直接放行', async () => {
    const wide = createTrack(EMPTY, spec('data')) // allowed '*'
    const scan = scanOf([{ name: 'c1', track: 'data', workflow: 'anything' }])
    await expect(assertUpdatePreservesReferences(wide, 'data', scan)).resolves.toBeUndefined()
  })

  test('change 读不了 → fail-closed', async () => {
    await expect(assertUpdatePreservesReferences(next, 'data', scanOf([], ['x']))).rejects.toBeInstanceOf(ChangeScanFailedError)
  })
})

// ── 进程内真实锁并发 ───────────────────────────────────────────────────────────

describe('并发（进程内真实 .pipeline 锁）', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'pl-crud-cc-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('两并发 create 同 id → 仅一成功，另一 TrackAlreadyExistsError；最终恰一条', async () => {
    const mk = () =>
      mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: createTrack(config, spec('dup')), result: 0 }))
    const results = await Promise.allSettled([mk(), mk()])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(bad).toHaveLength(1)
    expect(bad[0]!.reason).toBeInstanceOf(TrackAlreadyExistsError)
    const dupCount = loadTrackRegistry(repoRoot, CTX).ordered.filter((t) => t.id === 'dup').length
    expect(dupCount).toBe(1)
  })

  test('两并发 create 不同 id → 均成功、无丢更新（最终两条都在）', async () => {
    const mk = (id: string) =>
      mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: createTrack(config, spec(id)), result: 0 }))
    await Promise.all([mk('alpha'), mk('beta')])
    const ids = loadTrackRegistry(repoRoot, CTX).ordered.map((t) => t.id)
    expect(ids).toContain('alpha')
    expect(ids).toContain('beta')
  })

  test('update/delete 同轨竞争 → 串行、无陈旧覆写（最终该轨消失、文件仍可 load）', async () => {
    await mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: createTrack(config, spec('x')), result: 0 }))
    const upd = mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: updateTrack(config, 'x', { label: 'X2' }), result: 0 }))
    const del = mutateTrackRegistry(repoRoot, CTX, async ({ config }) => ({ next: deleteTrack(config, 'x'), result: 0 }))
    const settled = await Promise.allSettled([upd, del])
    // delete 必成功（无论先后：先删→update 报 not-found；先 update→再删成功）
    const rejected = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    for (const r of rejected) expect(r.reason).toBeInstanceOf(TrackNotFoundError)
    const reg = loadTrackRegistry(repoRoot, CTX) // 文件未损坏、可重 load
    expect(reg.byId.has('x')).toBe(false)
  })
})

describe('锁序回归 — withTrackRegistryLock 内嵌 change 锁不死锁', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'pl-crud-lockorder-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('registry 锁 → change 锁（不同锁目录）嵌套完成并返回值', async () => {
    const changeDir = path.join(repoRoot, 'openspec', 'changes', 'demo')
    await mkdir(changeDir, { recursive: true })
    const got = await withTrackRegistryLock(repoRoot, CTX, async ({ registry }) => {
      return withLock(changeDir, async () => `${registry.ordered.length}-inner`)
    })
    expect(got).toBe('7-inner')
  })

  test('并发两个 registry→change 嵌套 job 串行完成（不互相死锁）', async () => {
    const cd = path.join(repoRoot, 'openspec', 'changes', 'd')
    await mkdir(cd, { recursive: true })
    const job = () => withTrackRegistryLock(repoRoot, CTX, async () => withLock(cd, async () => 'ok'))
    await expect(Promise.all([job(), job()])).resolves.toEqual(['ok', 'ok'])
  })
})
