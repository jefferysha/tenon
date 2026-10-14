import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readStepOutputLedger,
  StepOutputLedgerError,
  STEP_OUTPUT_LEDGER_FILE,
  upsertVisit,
  writeStepOutputLedger,
  type StepOutputLedger,
  type StepOutputRecord,
  type StepVisitRecord,
} from './step-output-ledger.js'

const dirs: string[] = []
function changeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'step-ledger-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const SHA = 'a'.repeat(64)
const HEAD = 'b'.repeat(40)
const AT = '2026-10-12T00:00:00.000Z'

function visit(sequence: number, overrides: Partial<StepVisitRecord> = {}): StepVisitRecord {
  return {
    run_id: 'run-1', sequence, step: `step-${sequence}`, entered_at: AT, checkpoint: null,
    exit: { event: 'next', to: `step-${sequence + 1}`, at: AT, observation: 'observed' },
    outputs: [], reads: [], ...overrides,
  }
}
function ledgerOf(...visits: StepVisitRecord[]): StepOutputLedger {
  return { version: 1, visits }
}
function outputs(count: number, pathLength = 20): StepOutputRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `${String(index).padStart(pathLength - 3, 'p')}.md`, change: 'added' as const, sha256: SHA, skill: null,
  }))
}
function writeRaw(dir: string, content: string): void {
  writeFileSync(join(dir, STEP_OUTPUT_LEDGER_FILE), content)
}

describe('读写', () => {
  test('文件名固定为 .pipeline-step-outputs.json；文件不存在读出空账本', async () => {
    expect(STEP_OUTPUT_LEDGER_FILE).toBe('.pipeline-step-outputs.json')
    expect(await readStepOutputLedger(changeDir())).toEqual({ version: 1, visits: [] })
  })

  test('写后读回深等价（含检查点、离开记录、产出、读取回执）', async () => {
    const dir = changeDir()
    const full = ledgerOf(
      visit(0, {
        outputs: [{ path: 'docs/a.md', change: 'modified', sha256: SHA, skill: 'brainstorming' }, { path: 'old.md', change: 'deleted', sha256: null, skill: null }],
        reads: [{ path: 'docs/in.md', sha256: SHA, read_at: AT }],
      }),
      visit(1, { exit: null, checkpoint: { head: HEAD, files: { 'a.md': SHA, 'gone.md': null } } }),
    )
    await writeStepOutputLedger(dir, full)
    expect(await readStepOutputLedger(dir)).toEqual(full)
    expect(readFileSync(join(dir, STEP_OUTPUT_LEDGER_FILE), 'utf8').endsWith('\n')).toBe(true)
  })

  test('原子写：目录里不留临时文件', async () => {
    const dir = changeDir()
    await writeStepOutputLedger(dir, ledgerOf(visit(0)))
    await writeStepOutputLedger(dir, ledgerOf(visit(0), visit(1)))
    expect(readdirSync(dir)).toEqual([STEP_OUTPUT_LEDGER_FILE])
  })

  test('名叫 __proto__ 的文件也能原样往返（按自有属性存取）', async () => {
    const dir = changeDir()
    const files = Object.fromEntries([['__proto__', SHA]])
    await writeStepOutputLedger(dir, ledgerOf(visit(0, { exit: null, checkpoint: { head: null, files } })))
    const back = await readStepOutputLedger(dir)
    expect(Object.keys(back.visits[0]?.checkpoint?.files ?? {})).toEqual(['__proto__'])
  })
})

describe('upsertVisit', () => {
  test('按 (run_id, sequence) 覆盖，没有就追加', () => {
    const base = ledgerOf(visit(0), visit(1))
    const replaced = upsertVisit(base, visit(1, { step: 'rewritten' }))
    expect(replaced.visits.map((v) => [v.sequence, v.step])).toEqual([[0, 'step-0'], [1, 'rewritten']])
    const appended = upsertVisit(replaced, visit(2))
    expect(appended.visits.map((v) => v.sequence)).toEqual([0, 1, 2])
    expect(upsertVisit(base, visit(0, { run_id: 'run-2' })).visits).toHaveLength(3)
  })

  test('超过 512 次访问：丢最旧的已离开访问，当前未离开的访问不丢', () => {
    const visits = Array.from({ length: 512 }, (_, index) => visit(index, index === 0 ? { exit: null } : {}))
    const next = upsertVisit(ledgerOf(...visits), visit(512, { exit: null }))
    expect(next.visits).toHaveLength(512)
    expect(next.visits[0]?.sequence).toBe(0) // 最旧但未离开，保留
    expect(next.visits[0]?.exit).toBeNull()
    expect(next.visits.some((v) => v.sequence === 1)).toBe(false) // 丢的是最旧的已离开访问
    expect(next.visits.at(-1)?.sequence).toBe(512)
  })

  test('总大小超过 4 MiB：先丢最旧的已离开访问，直到放得下', async () => {
    const heavy = Array.from({ length: 20 }, (_, index) => visit(index, { outputs: outputs(2000, 120) }))
    const next = upsertVisit(ledgerOf(...heavy), visit(20, { exit: null }))
    expect(next.visits.at(-1)?.sequence).toBe(20)
    expect(next.visits.length).toBeLessThan(21)
    expect(next.visits[0]?.sequence).toBeGreaterThan(0)
    await expect(writeStepOutputLedger(changeDir(), next)).resolves.toBeUndefined()
  })

  test('只剩一个未离开的访问仍放不下：丢它的检查点而不是卡住转换', async () => {
    const files = Object.fromEntries(Array.from({ length: 20000 }, (_, index) => [`${String(index).padStart(200, 'd')}.md`, SHA]))
    const next = upsertVisit(ledgerOf(visit(0)), visit(1, { exit: null, checkpoint: { head: HEAD, files } }))
    expect(next.visits.find((v) => v.sequence === 1)?.checkpoint).toBeNull()
    await expect(writeStepOutputLedger(changeDir(), next)).resolves.toBeUndefined()
  })
})

describe('写入被拒', () => {
  test('单次访问 outputs 超过 2000 条', async () => {
    await expect(writeStepOutputLedger(changeDir(), ledgerOf(visit(0, { outputs: outputs(2001) }))))
      .rejects.toBeInstanceOf(StepOutputLedgerError)
    await expect(writeStepOutputLedger(changeDir(), ledgerOf(visit(0, { outputs: outputs(2000) })))).resolves.toBeUndefined()
  })

  test('写出文件超过 4 MiB', async () => {
    const files = Object.fromEntries(Array.from({ length: 20000 }, (_, index) => [`${String(index).padStart(200, 'd')}.md`, SHA]))
    const dir = changeDir()
    await expect(writeStepOutputLedger(dir, ledgerOf(visit(0, { exit: null, checkpoint: { head: HEAD, files } }))))
      .rejects.toThrow(/4 MiB/u)
    expect(readdirSync(dir)).toEqual([]) // 拒绝时不动盘
  })

  test('字段不合法的账本写不进去（写出的永远读得回来）', async () => {
    const bad = ledgerOf(visit(0, { outputs: [{ path: '../escape.md', change: 'added', sha256: SHA, skill: null }] }))
    await expect(writeStepOutputLedger(changeDir(), bad)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })
})

describe('读取校验：损坏即抛 StepOutputLedgerError', () => {
  const valid = JSON.parse(JSON.stringify(ledgerOf(visit(0, {
    exit: null, checkpoint: { head: HEAD, files: { 'a.md': SHA } },
    outputs: [{ path: 'a.md', change: 'added', sha256: SHA, skill: 'x' }],
    reads: [{ path: 'a.md', sha256: SHA, read_at: AT }],
  })))) as unknown

  function mutate(edit: (copy: Record<string, unknown>) => void): string {
    const copy: Record<string, unknown> = JSON.parse(JSON.stringify(valid))
    edit(copy)
    return JSON.stringify(copy)
  }
  function firstVisit(copy: Record<string, unknown>): Record<string, unknown> {
    const visits = copy.visits
    if (!Array.isArray(visits)) throw new Error('fixture')
    return visits[0]
  }

  test('合法账本读得回来', async () => {
    const dir = changeDir()
    writeRaw(dir, JSON.stringify(valid))
    expect((await readStepOutputLedger(dir)).visits).toHaveLength(1)
  })

  test.each([
    ['不是 JSON', '{not json'],
    ['顶层不是对象', '[]'],
    ['未知版本', JSON.stringify({ version: 2, visits: [] })],
    ['缺 visits', JSON.stringify({ version: 1 })],
    ['visits 不是数组', JSON.stringify({ version: 1, visits: {} })],
  ])('%s', async (_name, raw) => {
    const dir = changeDir()
    writeRaw(dir, raw)
    await expect(readStepOutputLedger(dir)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })

  test.each<[string, (visit: Record<string, unknown>) => void]>([
    ['sequence 不是整数', (v) => { v.sequence = '0' }],
    ['sequence 为负', (v) => { v.sequence = -1 }],
    ['run_id 为空', (v) => { v.run_id = '' }],
    ['entered_at 不是时间', (v) => { v.entered_at = 'yesterday' }],
    ['检查点 head 不是提交号', (v) => { v.checkpoint = { head: '--output=x', files: {} } }],
    ['检查点摘要不是 sha256', (v) => { v.checkpoint = { head: null, files: { 'a.md': 'zz' } } }],
    ['检查点路径越界', (v) => { v.checkpoint = { head: null, files: { '../a.md': SHA } } }],
    ['检查点路径是绝对路径', (v) => { v.checkpoint = { head: null, files: { '/etc/passwd': SHA } } }],
    ['exit 的 observation 非法', (v) => { v.exit = { event: 'e', to: 't', at: AT, observation: 'guess' } }],
    ['exit 缺 to', (v) => { v.exit = { event: 'e', at: AT, observation: 'observed' } }],
    ['产出 change 非法', (v) => { v.outputs = [{ path: 'a.md', change: 'renamed', sha256: SHA, skill: null }] }],
    ['产出路径越界', (v) => { v.outputs = [{ path: 'a/../../b.md', change: 'added', sha256: SHA, skill: null }] }],
    ['产出路径带空段', (v) => { v.outputs = [{ path: 'a//b.md', change: 'added', sha256: SHA, skill: null }] }],
    ['产出新增却没有摘要', (v) => { v.outputs = [{ path: 'a.md', change: 'added', sha256: null, skill: null }] }],
    ['产出删除却带摘要', (v) => { v.outputs = [{ path: 'a.md', change: 'deleted', sha256: SHA, skill: null }] }],
    ['产出 skill 不是字符串', (v) => { v.outputs = [{ path: 'a.md', change: 'added', sha256: SHA, skill: 3 }] }],
    ['产出超过 2000 条', (v) => { v.outputs = outputs(2001) }],
    ['回执摘要不是 sha256', (v) => { v.reads = [{ path: 'a.md', sha256: 'abc', read_at: AT }] }],
    ['回执缺 read_at', (v) => { v.reads = [{ path: 'a.md', sha256: SHA }] }],
    ['outputs 不是数组', (v) => { v.outputs = 'none' }],
  ])('访问字段：%s', async (_name, edit) => {
    const dir = changeDir()
    writeRaw(dir, mutate((copy) => { edit(firstVisit(copy)) }))
    await expect(readStepOutputLedger(dir)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })

  test('同一 (run_id, sequence) 出现两次', async () => {
    const dir = changeDir()
    writeRaw(dir, JSON.stringify(ledgerOf(visit(0), visit(0))))
    await expect(readStepOutputLedger(dir)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })

  test('访问数超过 512', async () => {
    const dir = changeDir()
    writeRaw(dir, JSON.stringify(ledgerOf(...Array.from({ length: 513 }, (_, index) => visit(index)))))
    await expect(readStepOutputLedger(dir)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })

  test('文件超过 4 MiB，或是符号链接', async () => {
    const big = changeDir()
    writeRaw(big, ' '.repeat(4 * 1024 * 1024 + 1))
    await expect(readStepOutputLedger(big)).rejects.toBeInstanceOf(StepOutputLedgerError)

    const linked = changeDir()
    const target = join(linked, 'elsewhere.json')
    writeFileSync(target, JSON.stringify(ledgerOf()))
    symlinkSync(target, join(linked, STEP_OUTPUT_LEDGER_FILE))
    await expect(readStepOutputLedger(linked)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })

  test('任务目录里的账本是个目录', async () => {
    const dir = changeDir()
    mkdirSync(join(dir, STEP_OUTPUT_LEDGER_FILE))
    await expect(readStepOutputLedger(dir)).rejects.toBeInstanceOf(StepOutputLedgerError)
  })
})
