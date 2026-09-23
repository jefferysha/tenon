/**
 * `tenon spec apply` 的真实彩排：跑仓库 devDependency 里的 OpenSpec CLI，不做任何 mock。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, test } from 'vitest'
import { cmdSpecApply } from './commands/specApply.js'
import { realDeps, REPO_ROOT, freshHarness, rm, type Harness } from './integration-harness.js'

const MAIN_SPEC = 'openspec/specs/capability/spec.md'
const MAIN_BODY = `# capability

## Purpose

The capability under test keeps the rules this integration suite exercises end to end.

## Requirements

### Requirement: Existing rule
The system SHALL keep the existing rule.

#### Scenario: Existing rule holds
- **WHEN** the rule applies
- **THEN** the system keeps it
`

function deltaBody(strict: boolean): string {
  return `## ADDED Requirements

### Requirement: New rule
The system ${strict ? 'SHALL keep' : 'keeps'} the new rule.

#### Scenario: New rule holds
- **WHEN** the new rule applies
- **THEN** the system keeps it
`
}

const PROPOSAL_WITH_CAPABILITY = `# Proposal

## Why

The runner needs a new rule.

## Capabilities

### New Capabilities

- \`capability\`: Keeps the new rule observable for every caller.

### Modified Capabilities

None.
`

let originalPath: string | undefined

beforeAll(() => {
  originalPath = process.env.PATH
  process.env.PATH = `${join(REPO_ROOT, 'node_modules', '.bin')}:${originalPath ?? ''}`
})

afterAll(() => {
  process.env.PATH = originalPath
})

async function write(root: string, rel: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), body, 'utf8')
}

async function seed(strict = true): Promise<{ h: Harness; name: string; delta: string }> {
  const h = await freshHarness()
  const name = 'spec-apply-demo'
  expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
  await h.seedGovernedDocumentEvidence(name)
  const delta = `openspec/changes/${name}/specs/capability/spec.md`
  await write(h.cwd, MAIN_SPEC, MAIN_BODY)
  await write(h.cwd, delta, deltaBody(strict))
  return { h, name, delta }
}

function apply(h: Harness, name: string, opts: Parameters<typeof cmdSpecApply>[2], hooks?: Parameters<typeof cmdSpecApply>[3]) {
  h.out.length = 0
  h.err.length = 0
  return cmdSpecApply(realDeps(h.cwd, h.out, h.err), name, opts, hooks)
}

describe('tenon spec apply', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    if (harness) await rm(harness.cwd, { recursive: true, force: true })
    harness = undefined
  })

  test('dry-run 不动主规格，只落回执', async () => {
    const { h, name } = await seed()
    harness = h
    expect(await apply(h, name, { dryRun: true, json: true }), h.out.join('')).toBe(0)
    expect(await readFile(join(h.cwd, MAIN_SPEC), 'utf8')).toBe(MAIN_BODY)
    const out = JSON.parse(h.out.join('')) as {
      mode: string; result: string; targets: { path: string; change: string }[]; receipt_path: string
    }
    expect(out.mode).toBe('dry-run')
    expect(out.result).toBe('pass')
    expect(out.targets.map((target) => target.change)).toEqual(['changed'])
    const receipt = JSON.parse(await h.readIn(name, '.pipeline-spec-apply.json')) as { schema: string; mode: string }
    expect(receipt.schema).toBe('tenon-spec-apply-v1')
    expect(receipt.mode).toBe('dry-run')
  })

  test('apply 写主规格与 applied-spec.md；再跑一次是 no-op', async () => {
    const { h, name } = await seed()
    harness = h
    expect(await apply(h, name, { json: true })).toBe(0)
    const merged = await readFile(join(h.cwd, MAIN_SPEC), 'utf8')
    expect(merged).toContain('### Requirement: New rule')
    expect(merged).toContain('### Requirement: Existing rule')
    expect(await h.readIn(name, 'applied-spec.md')).toContain(MAIN_SPEC)

    expect(await apply(h, name, { json: true })).toBe(0)
    const second = JSON.parse(h.out.join('')) as { targets: { change: string }[] }
    expect(second.targets.map((target) => target.change)).toEqual(['no-op'])
    expect(await readFile(join(h.cwd, MAIN_SPEC), 'utf8')).toBe(merged)
  })

  test('新 capability：主规格目录还不存在时 apply 仍要真的落盘（彩排说 created，真写不能 ENOENT）', async () => {
    const { h, name } = await seed()
    harness = h
    // 每一条 `## ADDED Requirements` delta 都在引入一个新 capability：它的主规格目录此刻不存在。
    await rm(join(h.cwd, 'openspec', 'specs'), { recursive: true, force: true })
    await write(h.cwd, `openspec/changes/${name}/proposal.md`, PROPOSAL_WITH_CAPABILITY)

    expect(await apply(h, name, { dryRun: true, json: true }), h.err.join('\n')).toBe(0)
    const rehearsal = JSON.parse(h.out.join('')) as { targets: { path: string; change: string }[] }
    expect(rehearsal.targets.map((target) => target.change)).toEqual(['created'])

    expect(await apply(h, name, { json: true }), h.err.join('\n')).toBe(0)
    expect(await readFile(join(h.cwd, MAIN_SPEC), 'utf8')).toContain('### Requirement: New rule')
  })

  /**
   * 真机：新 capability 的主规格 Purpose 是上游 `openspec archive` 写的
   * `TBD - created by archiving change …`，ship 门禁没拦。Purpose 取自 proposal：
   * New Capabilities 点名的那一条优先，否则 ## Why 第一段；都没有就拒绝应用。
   */
  test('新 capability 的 Purpose 取自 proposal，不留上游 TBD 占位', async () => {
    const { h, name } = await seed()
    harness = h
    await rm(join(h.cwd, 'openspec', 'specs'), { recursive: true, force: true })
    await write(h.cwd, `openspec/changes/${name}/proposal.md`, PROPOSAL_WITH_CAPABILITY)
    expect(await apply(h, name, { json: true }), h.err.join('\n')).toBe(0)
    const created = await readFile(join(h.cwd, MAIN_SPEC), 'utf8')
    expect(created).not.toContain('TBD')
    expect(created).toMatch(/## Purpose\n+Keeps the new rule observable for every caller\./u)
    // 再跑一次仍是 no-op：回执里的 after 摘要就是盘上这份填好 Purpose 的字节。
    expect(await apply(h, name, { json: true })).toBe(0)
    expect((JSON.parse(h.out.join('')) as { targets: { change: string }[] }).targets.map((t) => t.change))
      .toEqual(['no-op'])
  })

  test('proposal 没有 capability 条目时退回 ## Why 第一段', async () => {
    const { h, name } = await seed()
    harness = h
    await rm(join(h.cwd, 'openspec', 'specs'), { recursive: true, force: true })
    await write(h.cwd, `openspec/changes/${name}/proposal.md`,
      '# Proposal\n\n## Why\n\nCallers need the new rule\nto hold everywhere.\n\nSecond paragraph.\n')
    expect(await apply(h, name, { json: true }), h.err.join('\n')).toBe(0)
    expect(await readFile(join(h.cwd, MAIN_SPEC), 'utf8'))
      .toMatch(/## Purpose\n+Callers need the new rule to hold everywhere\.\n/u)
  })

  test('proposal 只有骨架占位：拒绝应用（exit 2），主规格不落盘，错误点名要填哪里', async () => {
    const { h, name } = await seed()
    harness = h
    await rm(join(h.cwd, 'openspec', 'specs'), { recursive: true, force: true })
    await write(h.cwd, `openspec/changes/${name}/proposal.md`,
      '# 提案\n\n## Why\n\n> [待填写:open] 用中文说明问题。\n')
    expect(await apply(h, name, { dryRun: true, json: true })).toBe(2)
    expect(await apply(h, name, { json: true })).toBe(2)
    const out = JSON.parse(h.out.join('')) as { result: string; errors: string[] }
    expect(out.result).toBe('fail')
    expect(out.errors.join('\n')).toContain("purpose-missing：新 capability 'capability'")
    expect(existsSync(join(h.cwd, MAIN_SPEC))).toBe(false)
  })

  test('缺 SHALL/MUST 的需求：exit 2，主规格不动，错误里带 OpenSpec 原话', async () => {
    const { h, name } = await seed(false)
    harness = h
    expect(await apply(h, name, { json: true })).toBe(2)
    const out = JSON.parse(h.out.join('')) as { result: string; errors: string[] }
    expect(out.result).toBe('fail')
    expect(out.errors.join('\n')).toContain('must contain SHALL or MUST')
    expect(await readFile(join(h.cwd, MAIN_SPEC), 'utf8')).toBe(MAIN_BODY)
  })

  test('彩排期间主规格被改：exit 4，不写任何目标', async () => {
    const { h, name } = await seed()
    harness = h
    const tampered = `${MAIN_BODY}\n<!-- edited -->\n`
    expect(await apply(h, name, { json: true }, {
      afterRehearsal: () => write(h.cwd, MAIN_SPEC, tampered),
    })).toBe(4)
    expect(await readFile(join(h.cwd, MAIN_SPEC), 'utf8')).toBe(tampered)
  })

  test('没有登记 delta-spec：exit 1', async () => {
    const h = await freshHarness()
    harness = h
    const name = 'spec-apply-empty'
    expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await apply(h, name, {})).toBe(1)
    expect(h.err.join('\n')).toContain('delta-spec-unrecorded')
  })

  test('PATH 上没有 openspec：exit 3', async () => {
    const { h, name } = await seed()
    harness = h
    const saved = process.env.PATH
    process.env.PATH = join(h.cwd, 'no-such-bin')
    try {
      expect(await apply(h, name, {})).toBe(3)
      expect(h.err.join('\n')).toContain('openspec-cli-missing')
    } finally {
      process.env.PATH = saved
    }
  })
})
