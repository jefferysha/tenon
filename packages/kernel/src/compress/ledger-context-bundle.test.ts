import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { DocumentKind } from '../workflow/document-contract.js'
import {
  DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
  LedgerContextBundleError,
  type LedgerContextBundleErrorCode,
} from './ledger-context-bundle.js'
import { compileLedgerContextBundle as compileWithPolicy } from './ledger-context-bundle-node-adapter.js'
import { nodeLedgerContextBundlePrimitives } from './ledger-context-bundle-node-adapter.js'
import { compileLedgerContextBundleWithPorts as compileWithPortsAndPolicy } from './ledger-context-bundle.js'
import type { DocumentLedger } from '../state/document-ledger.js'
import { documentGovernancePolicy, type DocumentGovernancePolicy } from '../workflow/document-contract.js'
import { LEGACY_DOCUMENT_GOVERNANCE_POLICY } from '../workflow/migrations/openspec-v1-document-policy.js'

type WithDefaultPolicy<T> = Omit<T, 'policy'> & { readonly policy?: DocumentGovernancePolicy }
/** Fixtures default to the openspec-v1 table that default declares in YAML. */
const compileLedgerContextBundle = (input: WithDefaultPolicy<Parameters<typeof compileWithPolicy>[0]>) =>
  compileWithPolicy({ ...input, policy: input.policy ?? LEGACY_DOCUMENT_GOVERNANCE_POLICY })
const compileLedgerContextBundleWithPorts = (input: WithDefaultPolicy<Parameters<typeof compileWithPortsAndPolicy>[0]>) =>
  compileWithPortsAndPolicy({ ...input, policy: input.policy ?? LEGACY_DOCUMENT_GOVERNANCE_POLICY })

interface FixtureDocument {
  readonly kind: DocumentKind
  readonly path: string
  readonly content: string
  readonly ledgerContent?: string
  readonly omitFile?: boolean
}

const roots: string[] = []

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function fixture(documents: readonly FixtureDocument[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-ledger-bundle-'))
  roots.push(root)
  const changeDir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(changeDir, { recursive: true })
  for (const document of documents) {
    if (document.omitFile) continue
    const absolute = join(root, document.path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, document.content, 'utf8')
  }
  await writeFile(
    join(changeDir, '.pipeline-documents.json'),
    `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: '2026-07-28T00:00:00Z',
      records: documents.map((document) => ({
        kind: document.kind,
        path: document.path,
        sha256: digest(document.ledgerContent ?? document.content),
        producer: 'test-fixture',
        recordedAt: '2026-07-28T00:00:00Z',
        reads: [],
      })),
    }, null, 2)}\n`,
    'utf8',
  )
  return root
}

function exploreDocuments(): FixtureDocument[] {
  return [
    {
      kind: 'proposal',
      path: 'openspec/changes/demo/proposal.md',
      content: '# Proposal\n目标：确定性预算预览\n',
    },
    {
      kind: 'openspec-design',
      path: 'openspec/changes/demo/design.md',
      content: '# Design\nBackground prose is omitted.\nDecision: ledger is authoritative.\n',
    },
    {
      kind: 'tasks',
      path: 'openspec/changes/demo/tasks.md',
      content: '# Tasks\n- [ ] compile bundle\n',
    },
  ]
}

async function expectLedgerError(
  action: () => Promise<unknown>,
  code: LedgerContextBundleErrorCode,
): Promise<LedgerContextBundleError> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerContextBundleError)
    const typed = error as LedgerContextBundleError
    expect(typed.code).toBe(code)
    expect(typed.repairAction.length).toBeGreaterThan(0)
    return typed
  }
  throw new Error(`expected ${code}`)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ledger-bound Context Bundle compiler', () => {
  test('按 policy 顺序生成兼容 bundle，并独立报告 source/materialized bytes', async () => {
    const documents = exploreDocuments()
    const root = await fixture(documents)
    const result = await compileLedgerContextBundle({
      root,
      change: 'demo',
      from: 'open',
      target: 'explore',
      budgetBytes: 120_000,
    })

    expect(result.bundle.schemaVersion).toBe('context-bundle/v1')
    expect(result.bundle.inputs.map((input) => input.kind)).toEqual([
      'proposal',
      'openspec-design',
      'tasks',
    ])
    expect(result.preview.inputs.map((input) => input.path)).toEqual(
      result.bundle.inputs.map((input) => input.path),
    )
    expect(result.preview.documentCount).toBe(3)
    expect(result.preview.budget).toEqual(result.bundle.budget)
    expect(result.preview.inputs[0]).toMatchObject({
      mode: 'full',
      reasonCode: 'context-bundle.reason.proposal',
      sourceBytes: Buffer.byteLength(documents[0]!.content, 'utf8'),
      materializedBytes: Buffer.byteLength(documents[0]!.content, 'utf8'),
    })
    expect(result.preview.inputs[1]!.sourceBytes).toBe(
      Buffer.byteLength(documents[1]!.content, 'utf8'),
    )
    expect(result.preview.inputs[1]!.materializedBytes).toBe(
      Buffer.byteLength(result.bundle.inputs[1]!.content!, 'utf8'),
    )
    expect(result.preview).not.toHaveProperty('aggregateDigest')
    expect(JSON.stringify(result.preview)).not.toContain('ledger is authoritative')
  })

  test('CLI Node adapter 保留合法 UTF-8 BOM 与完整 source bytes', async () => {
    const documents = exploreDocuments()
    documents[0] = {
      ...documents[0]!,
      content: '\uFEFF# Proposal\n目标：保留 BOM\n',
    }
    const root = await fixture(documents)
    const result = await compileLedgerContextBundle({
      root,
      change: 'demo',
      from: 'open',
      target: 'explore',
      budgetBytes: 120_000,
    })

    expect(result.bundle.inputs[0]!.content?.charCodeAt(0)).toBe(0xFEFF)
    expect(result.preview.inputs[0]!.sourceBytes).toBe(
      Buffer.byteLength(documents[0]!.content, 'utf8'),
    )
  })

  test('CLI 默认不继承 Dashboard source 上限，保持既有高预算 handoff 兼容', async () => {
    const documents = exploreDocuments()
    documents[0] = {
      ...documents[0]!,
      content: 'x'.repeat(DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument + 1),
    }
    const root = await fixture(documents)
    const result = await compileLedgerContextBundle({
      root,
      change: 'demo',
      from: 'open',
      target: 'explore',
      budgetBytes: 400_000,
    })

    expect(result.preview.inputs[0]?.sourceBytes).toBe(
      DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument + 1,
    )
  })

  test('port service 在任何 source read 前拒绝超过 64 条的 required records', async () => {
    const records: DocumentLedger['records'] = [
      ...Array.from({ length: 65 }, (_, index) => ({
        kind: 'proposal' as const,
        path: `docs/proposal-${index}.md`,
        sha256: digest(`# proposal ${index}`),
        producer: 'test-fixture',
        recordedAt: '2026-07-28T00:00:00Z',
        reads: [],
      })),
      ...(['openspec-design', 'tasks'] as const).map((kind) => ({
        kind,
        path: `docs/${kind}.md`,
        sha256: digest(`# ${kind}`),
        producer: 'test-fixture',
        recordedAt: '2026-07-28T00:00:00Z',
        reads: [],
      })),
    ]
    let sourceReads = 0
    const error = await expectLedgerError(
      () => compileLedgerContextBundleWithPorts({
        root: '/repo',
        change: 'demo',
        from: 'open',
        target: 'explore',
        ledgerRepository: {
          read: async () => ({
            version: 1,
            contract: 'openspec-v1',
            createdAt: '2026-07-28T00:00:00Z',
            records,
          }),
        },
        sourceReader: {
          read: async () => {
            sourceReads += 1
            return { text: '', sourceBytes: 0 }
          },
        },
        primitives: nodeLedgerContextBundlePrimitives,
        resourceLimits: DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
      }),
      'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
    )
    expect(error).toMatchObject({ metric: 'records', limit: 64, actual: 67 })
    expect(sourceReads).toBe(0)
  })

  test('port service 把累计剩余额度传给下一次 source read，超限正文读取前失败', async () => {
    const contents = new Map([
      ['docs/proposal.md', '123456'],
      ['docs/design.md', 'abcdef'],
      ['docs/tasks.md', 'task'],
    ])
    const records: DocumentLedger['records'] = [
      ['proposal', 'docs/proposal.md'],
      ['openspec-design', 'docs/design.md'],
      ['tasks', 'docs/tasks.md'],
    ].map(([kind, path]) => ({
      kind: kind as DocumentKind,
      path: path!,
      sha256: digest(contents.get(path!)!),
      producer: 'test-fixture',
      recordedAt: '2026-07-28T00:00:00Z',
      reads: [],
    }))
    const limitsSeen: Array<{ metric?: string; maxBytes?: number }> = []
    const error = await expectLedgerError(
      () => compileLedgerContextBundleWithPorts({
        root: '/repo',
        change: 'demo',
        from: 'open',
        target: 'explore',
        ledgerRepository: {
          read: async () => ({
            version: 1,
            contract: 'openspec-v1',
            createdAt: '2026-07-28T00:00:00Z',
            records,
          }),
        },
        sourceReader: {
          read: async (path, limit) => {
            limitsSeen.push({ metric: limit?.metric, maxBytes: limit?.maxBytes })
            const text = contents.get(path)!
            const sourceBytes = Buffer.byteLength(text)
            if (limit && sourceBytes > limit.maxBytes) {
              throw new LedgerContextBundleError(
                'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
                'bounded source read rejected before body materialization',
                {
                  path,
                  metric: limit.metric,
                  limit: limit.limit,
                  actual: limit.actualOffset + sourceBytes,
                  repairAction: 'split source',
                },
              )
            }
            return { text, sourceBytes }
          },
        },
        primitives: nodeLedgerContextBundlePrimitives,
        resourceLimits: {
          maxRecords: 64,
          maxSourceBytesPerDocument: 10,
          maxTotalSourceBytes: 10,
        },
      }),
      'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
    )
    expect(limitsSeen).toEqual([
      { metric: 'sourceBytesPerDocument', maxBytes: 10 },
      { metric: 'totalSourceBytes', maxBytes: 4 },
    ])
    expect(error).toMatchObject({ metric: 'totalSourceBytes', limit: 10, actual: 12 })
  })

  test('open 没有 required reads，缺 ledger 也返回真实 policy-empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-ledger-bundle-empty-'))
    roots.push(root)
    const result = await compileLedgerContextBundle({
      root,
      change: 'demo',
      from: 'archive',
      target: 'open',
      budgetBytes: 32,
    })
    expect(result.preview.inputs).toEqual([])
    expect(result.preview.documentCount).toBe(0)
    expect(result.preview.budget).toEqual({ maxBytes: 32, usedBytes: 0 })
    expect(result.bundle.inputs).toEqual([])
    expect(result.bundle.aggregateDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test.each([
    [{ change: '../bad', target: 'explore', budgetBytes: 100 }, 'CONTEXT_BUNDLE_INVALID_REQUEST'],
    [{ change: 'demo', target: 'future', budgetBytes: 100 }, 'CONTEXT_BUNDLE_INVALID_REQUEST'],
    [{ change: 'demo', target: 'explore', budgetBytes: 0 }, 'CONTEXT_BUNDLE_INVALID_REQUEST'],
  ] as const)('非法请求使用稳定 code：%#', async (overrides, code) => {
    const root = await fixture(exploreDocuments())
    await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: overrides.change,
        from: 'open',
        target: overrides.target,
        budgetBytes: overrides.budgetBytes,
      }),
      code,
    )
  })

  test('required reads 有值但 ledger 缺失时 fail closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-ledger-bundle-missing-ledger-'))
    roots.push(root)
    const error = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 120_000,
      }),
      'CONTEXT_BUNDLE_LEDGER_MISSING',
    )
    expect(error.path).toContain('.pipeline-documents.json')
  })

  test('CLI ledger adapter 错误只暴露相对 ledger path，不泄露 root 绝对路径', async () => {
    const root = await fixture(exploreDocuments())
    const ledger = join(root, 'openspec', 'changes', 'demo', '.pipeline-documents.json')
    const outside = join(await mkdtemp(join(tmpdir(), 'tenon-ledger-outside-')), 'ledger.json')
    roots.push(dirname(outside))
    await writeFile(outside, '{}', 'utf8')
    await rm(ledger)
    await symlink(outside, ledger)

    const error = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
      }),
      'CONTEXT_BUNDLE_LEDGER_MISSING',
    )
    expect(error.path).toBe('openspec/changes/demo/.pipeline-documents.json')
    expect(error.message).not.toContain(root)
    expect(error.message).not.toContain(outside)
  })

  test('缺 ledger kind 或源文件使用 DOCUMENT_MISSING 且带修复上下文', async () => {
    const withoutDesign = exploreDocuments().filter((document) => document.kind !== 'openspec-design')
    const root = await fixture(withoutDesign)
    const missingKind = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 120_000,
      }),
      'CONTEXT_BUNDLE_DOCUMENT_MISSING',
    )
    expect(missingKind.kind).toBe('openspec-design')

    const absent = exploreDocuments()
    absent[1] = { ...absent[1]!, omitFile: true }
    const absentRoot = await fixture(absent)
    const missingFile = await expectLedgerError(
      () => compileLedgerContextBundle({
        root: absentRoot,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 120_000,
      }),
      'CONTEXT_BUNDLE_DOCUMENT_MISSING',
    )
    expect(missingFile.kind).toBe('openspec-design')
    expect(missingFile.path).toBe(absent[1]!.path)
    expect(missingFile.cause).toBeInstanceOf(Error)
  })

  test('SHA 漂移使用 DOCUMENT_STALE，绝不接受旧 digest', async () => {
    const documents = exploreDocuments()
    documents[1] = { ...documents[1]!, ledgerContent: '# old design\n' }
    const root = await fixture(documents)
    const error = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 120_000,
      }),
      'CONTEXT_BUNDLE_DOCUMENT_STALE',
    )
    expect(error.kind).toBe('openspec-design')
    expect(error.path).toBe(documents[1]!.path)
    expect(error.message).toContain('document record')
  })

  test('登记后的源文件被换成 root 外同 digest symlink 也 fail closed', async () => {
    const documents = exploreDocuments()
    const root = await fixture(documents)
    const outside = await mkdtemp(join(tmpdir(), 'tenon-ledger-bundle-outside-'))
    roots.push(outside)
    const external = join(outside, 'proposal.md')
    await writeFile(external, documents[0]!.content, 'utf8')
    const proposal = join(root, documents[0]!.path)
    await rm(proposal)
    await symlink(external, proposal)

    const error = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 120_000,
      }),
      'CONTEXT_BUNDLE_DOCUMENT_MISSING',
    )
    expect(error.kind).toBe('proposal')
    expect(error.path).toBe(documents[0]!.path)
    expect(error.message).toContain('symlink')
  })

  test('同路径的不同 kind 只物化一次，后续 alias 为零字节 reference', async () => {
    const change = 'openspec/changes/demo'
    const sharedPlan = 'docs/superpowers/plans/demo.md'
    const documents: FixtureDocument[] = [
      ...exploreDocuments(),
      { kind: 'superpower-design', path: 'docs/superpowers/specs/demo.md', content: '# Deep\nDecision: shared\n' },
      { kind: 'adr', path: 'docs/adr/demo.md', content: '# ADR\nDecision: shared\n' },
      { kind: 'delta-spec', path: `${change}/specs/demo/spec.md`, content: '# Requirement\nMUST preview\n' },
      { kind: 'superpower-plan', path: sharedPlan, content: '# Plan\n- [ ] build\n' },
      { kind: 'plan', path: sharedPlan, content: '# Plan\n- [ ] build\n' },
    ]
    const root = await fixture(documents)
    const result = await compileLedgerContextBundle({
      root,
      change: 'demo',
      from: 'spec',
      target: 'build',
      budgetBytes: 120_000,
    })
    expect(result.bundle.inputs.at(-1)).toMatchObject({ kind: 'plan', mode: 'reference' })
    expect(result.bundle.inputs.at(-1)).not.toHaveProperty('content')
    expect(result.preview.inputs.at(-1)).toMatchObject({
      kind: 'plan',
      mode: 'reference',
      sourceBytes: Buffer.byteLength('# Plan\n- [ ] build\n', 'utf8'),
      materializedBytes: 0,
    })
  })

  test('预算不足抛 422 对应 typed error，safe preview 无 content/aggregate', async () => {
    const root = await fixture(exploreDocuments())
    const error = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 1,
      }),
      'CONTEXT_BUNDLE_BUDGET_EXCEEDED',
    )
    expect(error.requiredBytes).toBeGreaterThan(1)
    expect(error.availableBytes).toBe(1)
    expect(error.preview?.budget).toEqual({
      maxBytes: 1,
      usedBytes: error.requiredBytes,
    })
    expect(error.preview?.inputs).toHaveLength(3)
    expect(error).not.toHaveProperty('aggregateDigest')
    expect(error.preview).not.toHaveProperty('aggregateDigest')
    expect(JSON.stringify(error.preview)).not.toContain('ledger is authoritative')
  })

  test('低 materialized budget 也会在读取超大 source 前按固定资源上限 fail closed', async () => {
    const documents = exploreDocuments()
    documents[0] = {
      ...documents[0]!,
      content: 'x'.repeat(DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument + 1),
    }
    const root = await fixture(documents)
    const error = await expectLedgerError(
      () => compileLedgerContextBundle({
        root,
        change: 'demo',
        from: 'open',
        target: 'explore',
        budgetBytes: 1,
        resourceLimits: DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS,
      }),
      'CONTEXT_BUNDLE_RESOURCE_LIMIT_EXCEEDED',
    )
    expect(error).toMatchObject({
      metric: 'sourceBytesPerDocument',
      limit: DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument,
      path: documents[0]!.path,
    })
    expect(error.actual).toBe(DEFAULT_LEDGER_CONTEXT_BUNDLE_RESOURCE_LIMITS.maxSourceBytesPerDocument + 1)
    expect(error.preview).toBeUndefined()
  })
})
