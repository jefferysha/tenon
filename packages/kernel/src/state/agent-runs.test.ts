import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_RUN_META_FILE } from './agent-run-meta.js'
import { HOST_SUBAGENT_REASONS } from '../agents/host-native.js'
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
const metaPath = (): string => join(changeDir, AGENT_RUN_META_FILE)

/** 上一个发行版（v0.2.1）的台账读取器认得的键：必填加上唯一的可选键 subagent，多一个键就判整份台账损坏。 */
const N_MINUS_ONE_ROW_KEYS = [
  'actor', 'agent', 'agent_digest', 'candidate', 'findings', 'finished_at', 'report_digest', 'report_path', 'result', 'role',
  'run_id', 'schema', 'started_at', 'status', 'step', 'step_visit', 'subagent',
]

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

  it('subagent 可选：旧行没有，新行记宿主、子代理类型与是否专属', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'old' }))
    await appendAgentRunRow(changeDir, row({ run_id: 'new', subagent: { host: 'claude', type: 'tenon-security', native: true } }))
    const runs = await readAgentRuns(changeDir)
    expect(runs[0]?.subagent).toBeUndefined()
    expect(runs[1]?.subagent).toEqual({ host: 'claude', type: 'tenon-security', native: true })
  })

  it('subagent.reason 走旁注：台账行里的 subagent 保持旧三键形状，旁注记 subagent_reason，读回叠加成 subagent.reason', async () => {
    expect(HOST_SUBAGENT_REASONS).toEqual(expect.arrayContaining([
      'not-installed', 'definition-mismatch', 'shadowed', 'project-agent', 'not-dispatched',
    ]))
    for (const reason of HOST_SUBAGENT_REASONS) {
      await appendAgentRunRow(changeDir, row({ run_id: reason, subagent: { host: 'claude', type: 'general-purpose', native: false, reason } }))
    }
    // 台账原文：不出现 reason，subagent 的键集合是 v0.2.1 读得了的 host,native,type（键序也与以前一致）。
    const raw = await readFile(runsPath(), 'utf8')
    expect(raw).not.toContain('reason')
    for (const line of raw.trim().split('\n')) {
      expect(Object.keys((JSON.parse(line) as { subagent: object }).subagent), line).toEqual(['host', 'type', 'native'])
    }
    // 旁注：每个原因各一行 subagent_reason。
    const meta = (await readFile(metaPath(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(meta).toEqual(HOST_SUBAGENT_REASONS.map((reason) => ({ schema: 'agent-run-meta/v1', run_id: reason, subagent_reason: reason })))
    // 读回：叠加成 subagent.reason。
    expect((await readAgentRuns(changeDir)).map((item) => item.subagent)).toEqual(HOST_SUBAGENT_REASONS.map((reason) =>
      ({ host: 'claude', type: 'general-purpose', native: false, reason })))
  })

  it('subagent_reason 取闭集之外的值、空串、非字符串 → 旁注损坏并点名行号（失败关闭）', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a', subagent: { host: 'claude', type: 'general-purpose', native: false } }))
    const good = JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', subagent_reason: 'shadowed' })
    for (const bad of ['whatever', '', 'Not-Installed', 7, null, ['shadowed']]) {
      await writeFile(metaPath(), `${good}\n${JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', subagent_reason: bad })}\n`)
      await expect(readAgentRuns(changeDir), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'runs-corrupt', message: expect.stringContaining('第 2 行'),
      })
    }
    await writeFile(metaPath(), `${good}\n`)
    expect((await readAgentRuns(changeDir))[0]?.subagent).toEqual({ host: 'claude', type: 'general-purpose', native: false, reason: 'shadowed' })
  })

  it('subagent_reason 只贴在通用子代理上：改写成专属类型后旁注里遗留的原因不再叠加；行里没有 subagent 时忽略；行自带的 reason 优先', async () => {
    // prompt 时记下 not-installed；record --subagent 改写成专属类型，新行的 subagent 没有 reason，旁注里的旧原因不能贴到它身上。
    await appendAgentRunRow(changeDir, row({ run_id: 'r1', subagent: { host: 'claude', type: 'general-purpose', native: false, reason: 'not-installed' } }))
    await appendAgentRunRow(changeDir, row({ run_id: 'r1', status: 'finished', result: 'pass', subagent: { host: 'claude', type: 'tenon-security', native: true } }))
    expect((await readAgentRuns(changeDir))[0]?.subagent).toEqual({ host: 'claude', type: 'tenon-security', native: true })
    // 台账行没有 subagent（终端里开始的运行）：旁注里的原因无处可贴，也不凭空造出 subagent。
    await appendAgentRunRow(changeDir, row({ run_id: 'r2' }))
    await writeFile(metaPath(), `${JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'r2', subagent_reason: 'shadowed' })}\n`)
    expect((await readAgentRuns(changeDir))[1]).not.toHaveProperty('subagent')
    // 本地构建写过的四键行（subagent 里自带 reason）仍读得了，且自带的优先于旁注。
    await writeFile(runsPath(), `${JSON.stringify({ ...row({ run_id: 'r3' }), subagent: { host: 'claude', type: 'general-purpose', native: false, reason: 'shadowed' } })}\n`)
    await writeFile(metaPath(), `${JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'r3', subagent_reason: 'not-installed' })}\n`)
    expect((await readAgentRuns(changeDir))[0]?.subagent).toEqual({ host: 'claude', type: 'general-purpose', native: false, reason: 'shadowed' })
  })

  it('台账行自带四键 subagent（本地构建写过）时 reason 仍只取闭集；键集合其余部分仍是闭集；台账行不认顶层 subagent_reason', async () => {
    const good = { host: 'claude', type: 'general-purpose', native: false }
    for (const reason of ['whatever', '', 'Not-Installed', 7, null, ['shadowed']]) {
      await writeFile(runsPath(), `${JSON.stringify({ ...row(), subagent: { ...good, reason } })}\n`)
      await expect(readAgentRuns(changeDir), JSON.stringify(reason)).rejects.toMatchObject({ code: 'runs-corrupt' })
    }
    await writeFile(runsPath(), `${JSON.stringify({ ...row(), subagent: { ...good, reason: 'shadowed', extra: 1 } })}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toMatchObject({ code: 'runs-corrupt' })
    // subagent_reason 只活在旁注里：出现在台账行顶层，上一个发行版不认，这里同样判损坏。
    await writeFile(runsPath(), `${JSON.stringify({ ...row(), subagent: good, subagent_reason: 'shadowed' })}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toMatchObject({ code: 'runs-corrupt' })
  })

  it('不带 reason 的 subagent 逐字不变：台账行与以前一致，不产生旁注文件，旧行照常读回', async () => {
    const subagent = { host: 'claude', type: 'tenon-security', native: true } as const
    await appendAgentRunRow(changeDir, row({ run_id: 'native', subagent }))
    const line = (await readFile(runsPath(), 'utf8')).trim()
    expect(line).toContain('"subagent":{"host":"claude","type":"tenon-security","native":true}')
    expect(line).not.toContain('reason')
    await expect(readFile(metaPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(runsPath(), `${JSON.stringify({ ...row({ run_id: 'old' }), subagent: { host: 'claude', native: false, type: 'general-purpose' } })}\n`)
    expect((await readAgentRuns(changeDir))[0]?.subagent).toEqual({ host: 'claude', type: 'general-purpose', native: false })
  })

  it('rerun_reason 可选：旧行没有，新行记下原因（与 subagent 可同时出现）；空、多行、超长 → 损坏', async () => {
    const good = row({ rerun_reason: '第一轮提示词没带 DESIGN.md', subagent: { host: 'claude', type: 'tenon-security', native: true } })
    await writeFile(join(changeDir, AGENT_RUNS_FILE), `${JSON.stringify(good)}\n`)
    expect((await readAgentRuns(changeDir))[0]).toEqual(good)
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(301)]) {
      await writeFile(join(changeDir, AGENT_RUNS_FILE), `${JSON.stringify({ ...good, rerun_reason: bad })}\n`)
      await expect(readAgentRuns(changeDir), JSON.stringify(bad)).rejects.toMatchObject({ code: 'runs-corrupt' })
    }
    await writeFile(join(changeDir, AGENT_RUNS_FILE), `${JSON.stringify({ ...good, rerun_reason: 7 })}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toMatchObject({ code: 'runs-corrupt' })
  })

  it('host / host_source 可选：旧行没有；新行记登记时的宿主与来源；来源缺宿主、值非法 → 损坏', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'old' }))
    await appendAgentRunRow(changeDir, row({ run_id: 'det', host: 'codex', host_source: 'detected' }))
    await appendAgentRunRow(changeDir, row({ run_id: 'dec', host: 'codex', host_source: 'declared' }))
    await appendAgentRunRow(changeDir, row({ run_id: 'bare', host: 'claude' }))
    const runs = await readAgentRuns(changeDir)
    expect(runs[0]).not.toHaveProperty('host')
    expect(runs[1]).toMatchObject({ host: 'codex', host_source: 'detected' })
    expect(runs[2]).toMatchObject({ host: 'codex', host_source: 'declared' })
    expect(runs[3]).toMatchObject({ host: 'claude' })
    expect(runs[3]).not.toHaveProperty('host_source')
    for (const bad of [{ host: '' }, { host: 'Codex' }, { host: 7 }, { host: 'codex', host_source: 'guessed' }, { host_source: 'detected' }]) {
      await writeFile(runsPath(), `${JSON.stringify({ ...row(), ...bad })}\n`)
      await expect(readAgentRuns(changeDir), JSON.stringify(bad)).rejects.toMatchObject({ code: 'runs-corrupt' })
    }
  })

  it('host / host_source / rerun_reason 写进旁注，台账行保持上一个发行版读得了的形状；读出来仍是合并后的整行', async () => {
    const running = row({ run_id: 'r1', rerun_reason: '补充了设计稿后重跑', subagent: { host: 'claude', type: 'tenon-security', native: true } })
    await appendAgentRunRow(changeDir, running)
    const finished = row({ ...running, status: 'finished', result: 'pass', finished_at: '2026-09-20T01:05:00Z', host: 'codex', host_source: 'declared' })
    await appendAgentRunRow(changeDir, finished)
    await appendAgentRunRow(changeDir, row({ run_id: 'plain' }))
    // 台账：每一行的键都在 N-1 的闭集里，没有 host / host_source / rerun_reason。
    for (const line of (await readFile(runsPath(), 'utf8')).trim().split('\n')) {
      const keys = Object.keys(JSON.parse(line) as Record<string, unknown>)
      expect(keys.filter((key) => !N_MINUS_ONE_ROW_KEYS.includes(key)), line).toEqual([])
    }
    // 旁注：只为有这三项的运行写；没有就不创建文件内容里的无关行。
    const meta = (await readFile(metaPath(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(meta).toEqual([
      { schema: 'agent-run-meta/v1', run_id: 'r1', rerun_reason: '补充了设计稿后重跑' },
      { schema: 'agent-run-meta/v1', run_id: 'r1', rerun_reason: '补充了设计稿后重跑', host: 'codex', host_source: 'declared' },
    ])
    const runs = await readAgentRuns(changeDir)
    expect(runs.map((item) => item.run_id)).toEqual(['r1', 'plain'])
    expect(runs[0]).toEqual({ ...finished, rerun_reason: '补充了设计稿后重跑' })
    expect(runs[1]).not.toHaveProperty('host')
    expect(runs[1]).not.toHaveProperty('rerun_reason')
  })

  it('没有这三项的运行不产生旁注文件', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    await expect(readFile(metaPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('台账行自带这三项（本地 integ 构建写过的旧行）照样读得了，旁注只补行里缺的项', async () => {
    await writeFile(runsPath(), `${JSON.stringify(row({ run_id: 'legacy', host: 'claude', host_source: 'detected', rerun_reason: '旧行里的原因' }))}\n`)
    await writeFile(metaPath(), `${JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'legacy', host: 'codex', host_source: 'declared', rerun_reason: '旁注' })}\n`)
    expect((await readAgentRuns(changeDir))[0]).toMatchObject({ host: 'claude', host_source: 'detected', rerun_reason: '旧行里的原因' })
    await writeFile(runsPath(), `${JSON.stringify(row({ run_id: 'legacy', host: 'claude', host_source: 'detected' }))}\n`)
    expect((await readAgentRuns(changeDir))[0]).toMatchObject({ host: 'claude', host_source: 'detected', rerun_reason: '旁注' })
  })

  it('旁注先于台账行写入：没有对应台账行的旁注（写到一半崩溃）不影响读取，也不会凭空出现运行', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    await writeFile(metaPath(), `${JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'orphan', host: 'codex', host_source: 'declared' })}\n`)
    const runs = await readAgentRuns(changeDir)
    expect(runs.map((item) => item.run_id)).toEqual(['a'])
  })

  it('旁注里同一 run_id 的多行逐项叠加，后写的覆盖先写的', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    await writeFile(metaPath(), [
      { schema: 'agent-run-meta/v1', run_id: 'a', rerun_reason: '先' },
      { schema: 'agent-run-meta/v1', run_id: 'a', host: 'claude', host_source: 'detected', rerun_reason: '后' },
    ].map((item) => `${JSON.stringify(item)}\n`).join(''))
    expect((await readAgentRuns(changeDir))[0]).toMatchObject({ host: 'claude', host_source: 'detected', rerun_reason: '后' })
  })

  it('旁注的畸形行 → runs-corrupt 并点名行号；末尾写到一半的行忽略；超大 → runs-limit', async () => {
    await appendAgentRunRow(changeDir, row({ run_id: 'a' }))
    const good = JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', host: 'codex', host_source: 'declared' })
    for (const bad of [
      '{not json}', JSON.stringify({ schema: 'agent-run-meta/v1' }), JSON.stringify({ schema: 'other', run_id: 'a' }),
      JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', extra: 1 }), JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', host_source: 'declared' }),
      JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', rerun_reason: ' ' }), JSON.stringify({ schema: 'agent-run-meta/v1', run_id: 'a', host: 'Codex' }),
    ]) {
      await writeFile(metaPath(), `${good}\n${bad}\n`)
      await expect(readAgentRuns(changeDir), bad).rejects.toMatchObject({ code: 'runs-corrupt', message: expect.stringContaining('第 2 行') })
    }
    await writeFile(metaPath(), `${good}\n{"schema":"agent-run-meta/v1","run_`)
    expect((await readAgentRuns(changeDir))[0]).toMatchObject({ host: 'codex' })
    await writeFile(metaPath(), `${'x'.repeat(1024 * 1024 + 1)}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toMatchObject({ code: 'runs-limit' })
  })

  it('subagent 形状非法 → 损坏', async () => {
    await writeFile(runsPath(), `${JSON.stringify({ ...row(), subagent: { host: 'claude', type: '', native: true } })}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toThrowError(AgentRunError)
    await writeFile(runsPath(), `${JSON.stringify({ ...row(), subagent: { host: 'claude', type: 't', native: 'yes' } })}\n`)
    await expect(readAgentRuns(changeDir)).rejects.toThrowError(/形状非法/u)
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
