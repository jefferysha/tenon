import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createStateStore } from './store.js'
import { createTransitionRecordStore } from './transition-record-store.js'
import { createWorkflowRunRepository } from './workflow-run-repository.js'
import {
  publishRunRevision,
  readCurrentRunRevision,
  readCurrentRunRevisionSync,
  stateStorageSourcePathSync,
} from './run-revision-store.js'
import { readValidatedTransitionHeadFromSync } from './run-revision-head-reader.js'
import { hydratePreVerifyReviewFromSync } from './pre-verify-review-store.js'
import { parseRunRevision } from './run-revision-codec.js'
import { REVIEW_GATE_FIELDS } from '../types.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const roots: string[] = []
const clock = () => '2026-07-19T00:00:00Z'

async function fresh(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pl-run-revision-'))
  roots.push(root)
  const dir = await createStateStore().init({
    repoRoot: root, name: 'demo', track: 'backend', reviewSeed: 'pending', creator: TEST_CREATOR, preset: 'full', clock,
    runId: 'run-1',
  })
  return { root, dir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function rehash(record: Record<string, unknown>): void {
  const { stateDigest: _old, ...body } = record
  record.stateDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function transitionHeadAnchorLine(record: Record<string, unknown>): string | undefined {
  const state = record.state as { opaqueTail: string }
  return state.opaqueTail.match(/^# tenon-internal-transition-head-v1: [A-Za-z0-9_-]+\n/m)?.[0]
}

function replaceTransitionHeadAnchor(
  record: Record<string, unknown>,
  replacement = '',
): void {
  const state = record.state as { opaqueTail: string }
  state.opaqueTail = state.opaqueTail.replace(
    /^# tenon-internal-transition-head-v1: [A-Za-z0-9_-]+\n/m,
    replacement,
  )
  rehash(record)
}

function companionPath(
  dir: string,
  record: { readonly revision?: unknown; readonly revisionId?: unknown },
): string {
  return join(
    dir,
    '.pipeline-run',
    'pre-verify-review',
    `${String(record.revision).padStart(6, '0')}-${String(record.revisionId)}.json`,
  )
}

async function dropCompanion(dir: string, record: Record<string, unknown>): Promise<void> {
  await unlink(companionPath(dir, record)).catch(() => {})
}

async function rebindCompanion(dir: string, record: Record<string, unknown>): Promise<void> {
  const pathname = companionPath(dir, record)
  const companion = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>
  companion.stateDigest = record.stateDigest
  await writeFile(pathname, `${JSON.stringify(companion)}\n`, 'utf8')
}

describe('G1 canonical revision 对抗校验', () => {
  test('明确未来 schemaVersion 即使含未知顶层字段也给出稳定版本边界，不误报 corruption', () => {
    let thrown: unknown
    try {
      parseRunRevision(JSON.stringify({
        schemaVersion: 2,
        futureField: { mustNotBeRead: true },
      }), '/private/worktree/openspec/changes/future/.pipeline-run/current.json')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      _tag: 'UnsupportedRunStateVersionError',
      foundVersion: 2,
      supportedVersion: 1,
    })
  })

  test.each([
    ['字符串', '2'],
    ['分数', 1.5],
    ['不安全整数', Number.MAX_SAFE_INTEGER + 1],
    ['低版本', 0],
  ])('无法证明为未来版本的 schemaVersion（%s）仍按 corruption 失败关闭', (_label, schemaVersion) => {
    expect(() => parseRunRevision(JSON.stringify({ schemaVersion }), 'current'))
      .toThrow(/顶层字段闭集非法|canonical revision 字段非法/)
  })

  test('pre-Verify 逻辑 canonical 值由 revision companion 恢复，wire 对 N-1 保持旧闭集', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    await store.set(dir, 'pre_verify_review_result', 'pass')

    expect(await store.get(dir, 'pre_verify_review_result')).toBe('pass')
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    expect((current.state as { fields: Record<string, unknown> }).fields)
      .not.toHaveProperty('pre_verify_review_result')
    expect((current.state as { opaqueTail: string }).opaqueTail)
      .toContain('# tenon-internal-pre-verify-review-v1: ')
    const projection = await readFile(join(dir, '.pipeline.yaml'), 'utf8')
    expect(projection).not.toContain('pre_verify_review_result:')
    expect(projection).toContain('tenon-internal-pre-verify-review-v1')
    expect(JSON.parse(await readFile(companionPath(dir, current), 'utf8')))
      .toMatchObject({
        revision: current.revision,
        revisionId: current.revisionId,
        stateDigest: current.stateDigest,
        result: 'pass',
      })
    await store.set(dir, 'scope', 'after-pass')
    expect(await store.get(dir, 'pre_verify_review_result')).toBe('pass')
    expect(await store.get(dir, 'scope')).toBe('after-pass')
  })

  test('pre-Verify companion 缺失按 pending 失败关闭，不继承上一代 pass', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    await store.set(dir, 'pre_verify_review_result', 'pass')
    const current = JSON.parse(
      await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8'),
    ) as Record<string, unknown>
    await unlink(companionPath(dir, current))

    expect(await store.get(dir, 'pre_verify_review_result')).toBe('pending')
  })

  test('pre-Verify companion 身份或 revision digest 被篡改时 fail-loud', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const current = JSON.parse(
      await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8'),
    ) as Record<string, unknown>
    const pathname = companionPath(dir, current)
    const companion = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>
    companion.stateDigest = 'f'.repeat(64)
    await writeFile(pathname, `${JSON.stringify(companion)}\n`, 'utf8')

    await expect(store.read(dir)).rejects.toThrow(/companion.*摘要|revision.*摘要/i)
  })

  test('pre-Verify companion 结果被单独篡改时 async/sync 都拒绝，不能把 pending 变成 pass', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const current = JSON.parse(
      await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8'),
    ) as Record<string, unknown>
    const pathname = companionPath(dir, current)
    const companion = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>
    companion.result = 'pass'
    await writeFile(pathname, `${JSON.stringify(companion)}\n`, 'utf8')

    await expect(store.read(dir)).rejects.toThrow(/companion 内容.*anchor 摘要/i)
    expect(() => readCurrentRunRevisionSync(dir)).toThrow(/companion 内容.*anchor 摘要/i)
  })

  test('旧 runtime 保留上一 revision anchor 时失败关闭为 pending，不继承旧 pass', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    await store.set(dir, 'pre_verify_review_result', 'pass')
    const raw = await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8')
    const parsed = parseRunRevision(raw, 'current')
    const stale = {
      ...parsed,
      revision: parsed.revision + 1,
      revisionId: 'old-runtime-next',
      previousRevisionId: parsed.revisionId,
    }

    const hydrated = hydratePreVerifyReviewFromSync(() => undefined, stale)
    expect(hydrated.state.fields.pre_verify_review_result).toBe('pending')
    expect(hydrated.state.opaqueTail).not.toContain('tenon-internal-pre-verify-review-v1')
  })

  test('读取缺少 review_acknowledged_via 的历史 receipt 时补 unknown 并保持 fail-closed', async () => {
    const { dir } = await fresh()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const state = current.state as { fields: Record<string, unknown> }
    state.fields.review_gate_phase = 'verify'
    state.fields.review_gate_event = 'verify-pass'
    state.fields.review_gate_status = 'approved'
    state.fields.review_requested_at = clock()
    state.fields.review_acknowledged_at = clock()
    delete state.fields.review_acknowledged_via
    rehash(current)
    await writeFile(currentPath, `${JSON.stringify(current)}\n`, 'utf8')
    const parsed = parseRunRevision(await readFile(currentPath, 'utf8'), 'current')
    expect(parsed.state.fields.review_acknowledged_via).toBe('unknown')
  })

  test('publish 在落任何新 canonical bytes 前拒绝非 transition 改写 head/sequence', async () => {
    const { dir } = await fresh()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const before = await readFile(currentPath, 'utf8')
    const current = await readCurrentRunRevision(dir)
    if (current?.state.runMetadata === undefined) throw new Error('fixture run metadata missing')

    await expect(publishRunRevision(dir, current, {
      ...current.state,
      runMetadata: {
        ...current.state.runMetadata,
        transitionSequence: current.state.runMetadata.transitionSequence + 1,
        transitionHead: 'forged-head',
      },
    }, {
      kind: 'set',
      observedAt: clock(),
    })).rejects.toThrow(/非 transition revision.*head|runMetadata head/)
    expect(await readFile(currentPath, 'utf8')).toBe(before)
  })

  test('状态来源选择以 canonical current 为先；只有 current 不存在才兼容 legacy YAML', async () => {
    const { dir } = await fresh()
    const current = join(dir, '.pipeline-run', 'current.json')
    const yaml = join(dir, '.pipeline.yaml')

    expect(stateStorageSourcePathSync(dir)).toBe(current)
    await writeFile(current, '{ malformed current still owns precedence', 'utf8')
    expect(stateStorageSourcePathSync(dir)).toBe(current)
    await unlink(current)
    expect(stateStorageSourcePathSync(dir)).toBe(yaml)
    await unlink(yaml)
    expect(stateStorageSourcePathSync(dir)).toBeUndefined()
  })

  test('dangling current symlink 仍算 canonical 已出现并 fail-loud，不得按 ENOENT 回退 YAML', async () => {
    const { dir } = await fresh()
    const current = join(dir, '.pipeline-run', 'current.json')
    await unlink(current)
    await symlink('missing-target.json', current)

    expect(stateStorageSourcePathSync(dir)).toBe(current)
    await expect(createStateStore().read(dir)).rejects.toThrow(/canonical|current|symlink|符号链接/i)
  })

  test('自动更新兼容：仅缺 review-gate v2 尾字段的旧 canonical/projection 可读，并在下一次写入时升级', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const fields = (current.state as { fields: Record<string, unknown> }).fields
    for (const field of REVIEW_GATE_FIELDS) delete fields[field]
    rehash(current)
    await dropCompanion(dir, current)
    const legacyRaw = JSON.stringify(current)
    await writeFile(currentPath, legacyRaw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions', `000000-${String(current.revisionId)}.json`,
    ), legacyRaw, 'utf8')

    const yamlPath = join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    const legacyYaml = REVIEW_GATE_FIELDS.reduce(
      (next, field) => next.replace(new RegExp(`^${field}:.*\\n`, 'm'), ''),
      yaml,
    ).replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${String(current.stateDigest)}`)
    await writeFile(yamlPath, legacyYaml, 'utf8')

    const recovered = await store.read(dir)
    for (const field of REVIEW_GATE_FIELDS) expect(recovered.fields[field]).toBe(field === 'review_acknowledged_via' ? 'unknown' : '')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current', revision: 0 })

    await store.set(dir, 'phase', 'explore')
    const upgraded = JSON.parse(await readFile(currentPath, 'utf8')) as {
      revision: number
      state: { fields: Record<string, unknown> }
    }
    expect(upgraded.revision).toBe(1)
    for (const field of REVIEW_GATE_FIELDS) {
      if (field === 'review_acknowledged_via') expect(upgraded.state.fields).not.toHaveProperty(field)
      else expect(upgraded.state.fields).toHaveProperty(field, '')
    }
    expect((await store.read(dir)).fields.review_acknowledged_via).toBe('unknown')
    // 空 receipt 保留在 canonical schema，但不扰动兼容 YAML projection；真正 request 时会整组出现。
    const upgradedYaml = await readFile(yamlPath, 'utf8')
    for (const field of REVIEW_GATE_FIELDS) expect(upgradedYaml).not.toContain(`${field}:`)
  })

  test('自动更新兼容：精确缺 pre-Verify 尾字段的上一版本 canonical/projection 可读并升级为 pending', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const fields = (current.state as { fields: Record<string, unknown> }).fields
    delete fields.pre_verify_review_result
    rehash(current)
    await dropCompanion(dir, current)
    const legacyRaw = JSON.stringify(current)
    await writeFile(currentPath, legacyRaw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions', `000000-${String(current.revisionId)}.json`,
    ), legacyRaw, 'utf8')

    const yamlPath = join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    await writeFile(
      yamlPath,
      yaml
        .replace(/^pre_verify_review_result:.*\n/m, '')
        .replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${String(current.stateDigest)}`),
      'utf8',
    )

    const recovered = await store.read(dir)
    expect(recovered.fields.pre_verify_review_result).toBe('pending')
    expect(await store.inspectProjection(dir)).toMatchObject({ status: 'current', revision: 0 })

    await store.set(dir, 'phase', 'explore')
    const upgraded = JSON.parse(await readFile(currentPath, 'utf8')) as {
      revision: number
      revisionId: string
      stateDigest: string
      state: { fields: Record<string, unknown> }
    }
    expect(upgraded.state.fields).not.toHaveProperty('pre_verify_review_result')
    expect(JSON.parse(await readFile(companionPath(dir, upgraded), 'utf8')))
      .toMatchObject({ result: 'pending', stateDigest: upgraded.stateDigest })
    expect(await readFile(yamlPath, 'utf8')).not.toContain('pre_verify_review_result:')
  })

  test('缺 pre-Verify 尾字段时再缺任一普通字段仍拒绝，不泛化为缺字段默认', async () => {
    const { dir } = await fresh()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const fields = (current.state as { fields: Record<string, unknown> }).fields
    delete fields.pre_verify_review_result
    delete fields.branch_status
    rehash(current)
    await dropCompanion(dir, current)
    const raw = JSON.stringify(current)
    await writeFile(currentPath, raw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions', `000000-${String(current.revisionId)}.json`,
    ), raw, 'utf8')

    await expect(createStateStore().read(dir)).rejects.toThrow(/FIELD_ORDER 闭集|canonical/i)
  })

  test('自动更新兼容：早期四字段 receipt 缺 exact event 且 receipt 为空时可读并在下一次写入升级', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const fields = (current.state as { fields: Record<string, unknown> }).fields
    delete fields.review_gate_event
    rehash(current)
    await dropCompanion(dir, current)
    const legacyRaw = JSON.stringify(current)
    await writeFile(currentPath, legacyRaw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions', `000000-${String(current.revisionId)}.json`,
    ), legacyRaw, 'utf8')

    const yamlPath = join(dir, '.pipeline.yaml')
    const yaml = await readFile(yamlPath, 'utf8')
    await writeFile(
      yamlPath,
      yaml.replace(/pipeline_state_digest: [0-9a-f]{64}/, `pipeline_state_digest: ${String(current.stateDigest)}`),
      'utf8',
    )

    const recovered = await store.read(dir)
    expect(recovered.fields.review_gate_event).toBe('')
    await store.set(dir, 'phase', 'explore')
    const upgraded = JSON.parse(await readFile(currentPath, 'utf8')) as {
      state: { fields: Record<string, unknown> }
    }
    expect(upgraded.state.fields).toHaveProperty('review_gate_event', '')
  })

  test('缺 exact event 的旧非空 receipt 必须拒绝，不能把未知批准绑定到任意 transition', async () => {
    const { dir } = await fresh()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const fields = (current.state as { fields: Record<string, unknown> }).fields
    fields.review_gate_phase = 'spec'
    fields.review_gate_status = 'approved'
    fields.review_requested_at = '2026-07-24T00:00:00Z'
    fields.review_acknowledged_at = '2026-07-24T00:01:00Z'
    delete fields.review_gate_event
    rehash(current)
    const legacyRaw = JSON.stringify(current)
    await writeFile(currentPath, legacyRaw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions', `000000-${String(current.revisionId)}.json`,
    ), legacyRaw, 'utf8')

    await expect(createStateStore().read(dir)).rejects.toThrow(/FIELD_ORDER 闭集|review.*event|canonical/i)
  })

  test('effects 即便攻击者同步重算 digest 并改写 current+twin，未知 shape 仍 fail-loud', async () => {
    const { dir } = await fresh()
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const record = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const mutation = record.mutation as Record<string, unknown>
    mutation.effects = [{ kind: 'evil', field: 'phase', from: 'open', to: 'ship' }]
    rehash(record)
    const raw = JSON.stringify(record)
    await writeFile(currentPath, raw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions',
      `000000-${String(record.revisionId)}.json`,
    ), raw, 'utf8')

    await expect(createStateStore().read(dir)).rejects.toThrow(/effect|canonical revision|字段非法/i)
  })

  test('effects 即便 shape 合法且攻击者同步重算 current+twin digest，也必须等于 previous→current 的真实 diff', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    await store.set(dir, 'phase', 'explore')
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const record = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const mutation = record.mutation as Record<string, unknown>
    mutation.effects = []
    rehash(record)
    await rebindCompanion(dir, record)
    const raw = JSON.stringify(record)
    await writeFile(currentPath, raw, 'utf8')
    await writeFile(join(
      dir, '.pipeline-run', 'revisions',
      `000001-${String(record.revisionId)}.json`,
    ), raw, 'utf8')

    await expect(store.read(dir)).rejects.toThrow(/effects.*diff|effect.*previous|真实.*diff/i)
  })

  test('current 引用的直接 previous revision 缺失 → fail-loud，不采信仍完整的 YAML', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    await store.set(dir, 'phase', 'explore')
    const current = JSON.parse(await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8')) as {
      previousRevisionId: string
    }
    await unlink(join(
      dir, '.pipeline-run', 'revisions', `000000-${current.previousRevisionId}.json`,
    ))

    await expect(store.read(dir)).rejects.toThrow(/previous|revision.*缺失/i)
  })

  test('transition revision 引用的 immutable TransitionRecord 缺失 → fail-loud，不采信 YAML head', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const records = createTransitionRecordStore()
    const repo = createWorkflowRunRepository({ store, recordStore: records, clock, newId: () => 'record-1' })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await unlink(join(dir, '.pipeline-transitions', '000001-record-1.json'))

    await expect(store.read(dir)).rejects.toThrow(/TransitionRecord|record.*缺失/i)
  })

  test('current 是 set 时也校验直接 previous transition 的 record，缺失即 fail-loud', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const records = createTransitionRecordStore()
    const repo = createWorkflowRunRepository({ store, recordStore: records, clock, newId: () => 'record-previous' })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await store.set(dir, 'scope', 'post-transition-set')
    await unlink(join(dir, '.pipeline-transitions', '000001-record-previous.json'))

    await expect(readCurrentRunRevision(dir)).rejects.toThrow(/TransitionRecord|record.*缺失/i)
    expect(() => readCurrentRunRevisionSync(dir)).toThrow(/TransitionRecord|record.*缺失/i)
  })

  test('同步可信读取在 transition 后连续两次 set 仍校验 canonical head record，缺失即 fail-loud', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const repo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock,
      newId: () => 'record-two-sets-missing',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await store.set(dir, 'scope', 'first-set')
    await store.set(dir, 'assignee', 'second-set')
    await unlink(join(dir, '.pipeline-transitions', '000001-record-two-sets-missing.json'))

    expect(() => readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readFileSync(join(dir, relativePath), 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : (() => { throw error })()
      }
    }, dir)).toThrow(/TransitionRecord|record.*缺失/i)
  })

  test('同步可信读取在 transition 后连续两次 set 仍以提交 revision digest 拒绝 head 篡改', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const repo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock,
      newId: () => 'record-two-sets-tampered',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await store.set(dir, 'scope', 'first-set')
    await store.set(dir, 'assignee', 'second-set')
    const transitionPath = join(
      dir, '.pipeline-transitions', '000001-record-two-sets-tampered.json',
    )
    const transition = JSON.parse(await readFile(transitionPath, 'utf8')) as Record<string, unknown>
    transition.event = 'tampered-after-two-sets'
    await writeFile(transitionPath, JSON.stringify(transition), 'utf8')

    expect(() => readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readFileSync(join(dir, relativePath), 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : (() => { throw error })()
      }
    }, dir)).toThrow(/TransitionRecord.*digest|审计.*绑定/i)
  })

  test('pre-anchor canonical revision 继续由有界 committing-revision fallback 验证', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const repo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock,
      newId: () => 'record-pre-anchor',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await store.set(dir, 'scope', 'first-set')
    await store.set(dir, 'assignee', 'second-set')

    const revisionsDir = join(dir, '.pipeline-run', 'revisions')
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const revision2 = JSON.parse(await readFile(join(
      revisionsDir, `000002-${String(current.previousRevisionId)}.json`,
    ), 'utf8')) as Record<string, unknown>
    const revision1 = JSON.parse(await readFile(join(
      revisionsDir, `000001-${String(revision2.previousRevisionId)}.json`,
    ), 'utf8')) as Record<string, unknown>
    for (const [record, pathname] of [
      [revision1, join(revisionsDir, `000001-${String(revision1.revisionId)}.json`)],
      [revision2, join(revisionsDir, `000002-${String(revision2.revisionId)}.json`)],
      [current, join(revisionsDir, `000003-${String(current.revisionId)}.json`)],
    ] as const) {
      replaceTransitionHeadAnchor(record)
      await rebindCompanion(dir, record)
      await writeFile(pathname, JSON.stringify(record), 'utf8')
    }
    await writeFile(currentPath, JSON.stringify(current), 'utf8')

    const validated = readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readFileSync(join(dir, relativePath), 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : (() => { throw error })()
      }
    }, dir)
    expect(validated?.record?.id).toBe('record-pre-anchor')
  })

  test('legacy head fallback 在 64 revisions 边界 fail-closed，不无界阻塞同步 reader', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const repo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock,
      newId: () => 'record-beyond-legacy-cap',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    for (let index = 0; index < 65; index++) {
      await store.set(dir, 'assignee', `set-${index}`)
    }
    const revisionsDir = join(dir, '.pipeline-run', 'revisions')
    for (const name of await readdir(revisionsDir)) {
      if (name.startsWith('000000-')) continue
      const pathname = join(revisionsDir, name)
      const record = JSON.parse(await readFile(pathname, 'utf8')) as Record<string, unknown>
      replaceTransitionHeadAnchor(record)
      await rebindCompanion(dir, record)
      await writeFile(pathname, JSON.stringify(record), 'utf8')
      if (record.revision === 66) {
        await writeFile(join(dir, '.pipeline-run', 'current.json'), JSON.stringify(record), 'utf8')
      }
    }

    expect(() => readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readFileSync(join(dir, relativePath), 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : (() => { throw error })()
      }
    }, dir)).toThrow(/64 revisions|兼容校验上限/i)
  })

  test('同步可信 reader 在解析前执行 8 MiB canonical 总字节上限', async () => {
    const { dir } = await fresh()
    expect(() => readValidatedTransitionHeadFromSync((relativePath) => {
      if (relativePath === join('.pipeline-run', 'current.json')) {
        return ' '.repeat(8 * 1024 * 1024 + 1)
      }
      return undefined
    }, dir)).toThrow(/8 MiB.*上限/i)
  })

  test('N-1 保留 stale anchor 后提交新 transition，升级读取走有界 fallback 而不误判损坏', async () => {
    const { dir } = await fresh()
    const ids = ['record-anchor-old', 'record-anchor-new']
    const store = createStateStore()
    const repo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock,
      newId: () => ids.shift() ?? 'unexpected-record',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    const first = JSON.parse(
      await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8'),
    ) as Record<string, unknown>
    const oldAnchor = transitionHeadAnchorLine(first)
    expect(oldAnchor).toBeDefined()

    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'spec' }, {
        event: 'explore-complete', from: 'explore', to: 'spec',
      })
    })
    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    replaceTransitionHeadAnchor(current, oldAnchor)
    await rebindCompanion(dir, current)
    const immutablePath = join(
      dir,
      '.pipeline-run',
      'revisions',
      `000002-${String(current.revisionId)}.json`,
    )
    await writeFile(immutablePath, JSON.stringify(current), 'utf8')
    await writeFile(currentPath, JSON.stringify(current), 'utf8')

    const validated = readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readFileSync(join(dir, relativePath), 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : (() => { throw error })()
      }
    }, dir)
    expect(validated?.record?.id).toBe('record-anchor-new')

    const encoded = oldAnchor
      ?.slice('# tenon-internal-transition-head-v1: '.length)
      .trim()
    const forgedAnchor = JSON.parse(
      Buffer.from(encoded ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    forgedAnchor.recordDigest = 'f'.repeat(64)
    const forgedLine = `# tenon-internal-transition-head-v1: ${
      Buffer.from(JSON.stringify(forgedAnchor), 'utf8').toString('base64url')
    }\n`
    replaceTransitionHeadAnchor(current, forgedLine)
    await rebindCompanion(dir, current)
    await writeFile(immutablePath, JSON.stringify(current), 'utf8')
    await writeFile(currentPath, JSON.stringify(current), 'utf8')

    expect(() => readValidatedTransitionHeadFromSync((relativePath) => {
      try {
        return readFileSync(join(dir, relativePath), 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : (() => { throw error })()
      }
    }, dir)).toThrow(/stale transition head anchor|不得改写 transition head anchor/i)
  })

  test('current 是 set 时拒绝一致篡改 previous transition 与 record 的 predecessor 链', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const records = createTransitionRecordStore()
    const repo = createWorkflowRunRepository({ store, recordStore: records, clock, newId: () => 'record-forged' })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await store.set(dir, 'scope', 'post-transition-set')

    const transitionPath = join(dir, '.pipeline-transitions', '000001-record-forged.json')
    const transition = JSON.parse(await readFile(transitionPath, 'utf8')) as Record<string, unknown>
    transition.previousRecordId = 'forged-predecessor'
    const transitionRaw = JSON.stringify(transition)
    await writeFile(transitionPath, transitionRaw, 'utf8')

    const revisionPath = join(dir, '.pipeline-run', 'revisions')
    const current = JSON.parse(
      await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8'),
    ) as { previousRevisionId: string }
    const previousPath = join(revisionPath, `000001-${current.previousRevisionId}.json`)
    const previous = JSON.parse(await readFile(previousPath, 'utf8')) as Record<string, unknown>
    const mutation = previous.mutation as Record<string, unknown>
    mutation.transitionRecordDigest = createHash('sha256').update(transitionRaw).digest('hex')
    rehash(previous)
    await rebindCompanion(dir, previous)
    await writeFile(previousPath, JSON.stringify(previous), 'utf8')

    await expect(readCurrentRunRevision(dir)).rejects.toThrow(/TransitionRecord|previous|连续|不一致/i)
    expect(() => readCurrentRunRevisionSync(dir)).toThrow(/TransitionRecord|previous|连续|不一致/i)
  })

  test('current 是 set 时拒绝同步清空 previous transition 与 record 的 effects', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const records = createTransitionRecordStore()
    const repo = createWorkflowRunRepository({ store, recordStore: records, clock, newId: () => 'record-effects' })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    await store.set(dir, 'scope', 'post-transition-set')

    const transitionPath = join(dir, '.pipeline-transitions', '000001-record-effects.json')
    const transition = JSON.parse(await readFile(transitionPath, 'utf8')) as Record<string, unknown>
    transition.effects = []
    const transitionRaw = JSON.stringify(transition)
    await writeFile(transitionPath, transitionRaw, 'utf8')

    const current = JSON.parse(
      await readFile(join(dir, '.pipeline-run', 'current.json'), 'utf8'),
    ) as { previousRevisionId: string }
    const previousPath = join(
      dir,
      '.pipeline-run',
      'revisions',
      `000001-${current.previousRevisionId}.json`,
    )
    const previous = JSON.parse(await readFile(previousPath, 'utf8')) as Record<string, unknown>
    const mutation = previous.mutation as Record<string, unknown>
    mutation.effects = []
    mutation.transitionRecordDigest = createHash('sha256').update(transitionRaw).digest('hex')
    rehash(previous)
    await rebindCompanion(dir, previous)
    await writeFile(previousPath, JSON.stringify(previous), 'utf8')

    await expect(readCurrentRunRevision(dir)).rejects
      .toThrow(/effects.*diff|真实.*diff|TransitionRecord digest/i)
    expect(() => readCurrentRunRevisionSync(dir))
      .toThrow(/effects.*diff|真实.*diff|TransitionRecord digest/i)
  })

  test('transition revision 必须绑定 TransitionRecord 精确字节；只篡改 event 也 fail-loud', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const records = createTransitionRecordStore()
    const repo = createWorkflowRunRepository({ store, recordStore: records, clock, newId: () => 'record-digest' })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    const transitionPath = join(dir, '.pipeline-transitions', '000001-record-digest.json')
    const transition = JSON.parse(await readFile(transitionPath, 'utf8')) as Record<string, unknown>
    transition.event = 'tampered-but-shape-valid'
    await writeFile(transitionPath, JSON.stringify(transition), 'utf8')

    await expect(store.read(dir)).rejects.toThrow(/TransitionRecord.*digest|record.*摘要|审计.*绑定/i)
  })

  test('即使同步重算 digest，closed-schema 外的 TransitionRecord 字段仍 fail-loud', async () => {
    const { dir } = await fresh()
    const store = createStateStore()
    const repo = createWorkflowRunRepository({
      store,
      recordStore: createTransitionRecordStore(),
      clock,
      newId: () => 'record-schema-corrupt',
    })
    await repo.transact(dir, async (tx) => {
      await tx.commit({ ...tx.state.fields, phase: 'explore' }, {
        event: 'open-complete', from: 'open', to: 'explore',
      })
    })
    const transitionPath = join(
      dir, '.pipeline-transitions', '000001-record-schema-corrupt.json',
    )
    const transition = JSON.parse(await readFile(transitionPath, 'utf8')) as Record<string, unknown>
    transition.unexpected = 'digest-bound-but-not-canonical'
    const transitionRaw = JSON.stringify(transition)
    await writeFile(transitionPath, transitionRaw, 'utf8')
    const digest = createHash('sha256').update(transitionRaw).digest('hex')

    const currentPath = join(dir, '.pipeline-run', 'current.json')
    const current = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>
    const mutation = current.mutation as Record<string, unknown>
    mutation.transitionRecordDigest = digest
    const anchorLine = transitionHeadAnchorLine(current)
    const encoded = anchorLine
      ?.slice('# tenon-internal-transition-head-v1: '.length)
      .trim()
    const anchor = JSON.parse(
      Buffer.from(encoded ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    anchor.recordDigest = digest
    replaceTransitionHeadAnchor(
      current,
      `# tenon-internal-transition-head-v1: ${
        Buffer.from(JSON.stringify(anchor), 'utf8').toString('base64url')
      }\n`,
    )
    await rebindCompanion(dir, current)
    await writeFile(join(
      dir,
      '.pipeline-run',
      'revisions',
      `000001-${String(current.revisionId)}.json`,
    ), JSON.stringify(current), 'utf8')
    await writeFile(currentPath, JSON.stringify(current), 'utf8')

    await expect(readCurrentRunRevision(dir)).rejects
      .toThrow(/TransitionRecord schema|schema invalid/i)
    expect(() => readCurrentRunRevisionSync(dir))
      .toThrow(/TransitionRecord schema|schema invalid/i)
  })
})
