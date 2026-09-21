import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_RUNS_FILE, AgentRunError,
  appendAgentRunRow, parseAgentReport, readAgentRuns, severityRank, type AgentRunRow,
} from './agent-runs.js'
import { withLock } from './lock.js'

const ACTOR = { id: 'a@x.com', name: 'A', trust: 'declared' } as const

function row(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    schema: 'agent-run/v1',
    run_id: '6f0c0000-0000-4000-8000-000000000001',
    agent: 'security',
    agent_digest: `sha256:${'0'.repeat(64)}`,
    role: 'reviewer',
    step: 'verify',
    step_visit: '["run-1",7]',
    candidate: `sha256:${'1'.repeat(64)}`,
    status: 'running',
    result: null,
    findings: [],
    report_path: 'openspec/changes/c/.pipeline-agent-reports/x.md',
    report_digest: null,
    actor: ACTOR,
    started_at: '2026-09-20T01:00:00Z',
    finished_at: null,
    ...overrides,
  }
}

let changeDir: string
const runsPath = (): string => join(changeDir, AGENT_RUNS_FILE)

beforeEach(async () => {
  changeDir = await mkdtemp(join(tmpdir(), 'tenon-agent-runs-'))
})

afterEach(async () => {
  await rm(changeDir, { recursive: true, force: true })
})

describe('readAgentRuns', () => {
  it('文件不存在 → 空', async () => {
    expect(await readAgentRuns(changeDir)).toEqual([])
  })

  it('同 run_id 以最后一行为准，顺序按首次出现', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    await appendAgentRunRow(changeDir, row({ run_id: 'b' }))
    await appendAgentRunRow(changeDir, row({ run_id: 'a', status: 'finished', result: 'pass' }))
    const runs = await readAgentRuns(changeDir)
    expect(runs.map((item) => item.run_id)).toEqual(['a', 'b'])
    expect(runs[0]).toMatchObject({ status: 'finished', result: 'pass' })
  })

  it('末尾写到一半的行忽略', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    await writeFile(runsPath(), `${await readFile(runsPath(), 'utf8')}{"schema":"agent-r`)
    expect((await readAgentRuns(changeDir)).map((item) => item.run_id)).toEqual(['a'])
  })

  it('中间的畸形行 → runs-corrupt 并点名行号', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    await writeFile(runsPath(), `${await readFile(runsPath(), 'utf8')}not json\n`)
    await appendAgentRunRow(changeDir, row({ run_id: 'b' }))
    await expect(readAgentRuns(changeDir)).rejects.toThrowError(/第 2 行/u)
  })

  it('闭集之外的键 / 越界级别 / 多行 message 都算形状非法', async () => {
    for (const bad of [
      { ...row(), extra: 1 },
      { ...row(), role: 'observer' },
      { ...row(), findings: [{ severity: 'blocker', location: 'a', message: 'b' }] },
      { ...row(), findings: [{ severity: 'high', location: 'a', message: 'b\nc' }] },
      { ...row(), actor: { id: 'a@x.com' } },
    ]) {
      await writeFile(runsPath(), `${JSON.stringify(bad)}\n`)
      await expect(readAgentRuns(changeDir)).rejects.toMatchObject({ code: 'runs-corrupt' })
    }
  })

  it('超过行数上限 → runs-limit', async () => {
    const lines: string[] = []
    for (let index = 0; index <= 512; index++) lines.push(JSON.stringify(row({ run_id: `r${index}` })))
    await writeFile(runsPath(), `${lines.join('\n')}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toMatchObject({ code: 'runs-limit' })
  })
})

describe('appendAgentRunRow', () => {
  it('同一把 Change 锁下的并发追加保住每一行', async () => {
    await Promise.all(Array.from({ length: 12 }, (_unused, index) =>
      withLock(changeDir, () => appendAgentRunRow(changeDir, row({ run_id: `r${index}` })))))
    expect((await readAgentRuns(changeDir)).length).toBe(12)
  })
})

describe('parseAgentReport', () => {
  const report = (body: string): string => `# 标题\n\n说明\n\n\`\`\`tenon-result\n${body}\n\`\`\`\n`

  it('评审者只读 findings', () => {
    expect(parseAgentReport(report('{"findings":[{"severity":"high","location":"a.ts:1","message":"坏"}]}'), 'reviewer'))
      .toEqual({ findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }] })
    expect(parseAgentReport(report('{"findings":[]}'), 'reviewer')).toEqual({ findings: [] })
    expect(parseAgentReport(report('{}'), 'reviewer')).toEqual({ findings: [] })
  })

  it('评审者自报结论被拒', () => {
    expect(() => parseAgentReport(report('{"result":"pass"}'), 'reviewer'))
      .toThrowError(/评审者不自报结论/u)
  })

  it('执行者必须给 result', () => {
    expect(parseAgentReport(report('{"result":"failed","findings":[]}'), 'executor'))
      .toEqual({ findings: [], result: 'failed' })
    expect(() => parseAgentReport(report('{"findings":[]}'), 'executor')).toThrowError(/必须自报 result/u)
    expect(() => parseAgentReport(report('{"result":"pass"}'), 'executor')).toThrowError(/必须自报 result/u)
  })

  it('缺块 / 非 JSON / 非对象 / 未知字段 / 畸形 finding 都是 report-invalid', () => {
    for (const text of [
      '# 没有块\n',
      report('{'),
      report('[]'),
      report('{"surprise":1}'),
      report('{"findings":[{"severity":"high"}]}'),
    ]) {
      expect(() => parseAgentReport(text, 'reviewer')).toThrowError(AgentRunError)
    }
  })

  it('只认最后一个围栏块', () => {
    const text = '```tenon-result\n{"findings":[{"severity":"low","location":"a","message":"旧"}]}\n```\n'
      + '\n中间还有别的内容\n\n'
      + '```tenon-result\n{"findings":[{"severity":"high","location":"b","message":"新"}]}\n```\n'
    expect(parseAgentReport(text, 'reviewer').findings).toEqual([{ severity: 'high', location: 'b', message: '新' }])
  })
})

describe('severityRank', () => {
  it('low < medium < high < critical', () => {
    expect([severityRank('low'), severityRank('medium'), severityRank('high'), severityRank('critical')])
      .toEqual([1, 2, 3, 4])
  })
})
