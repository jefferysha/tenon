/**
 * `tenon evidence export`：Agent Trace、OTel GenAI span、git notes、提交尾注四种格式，以及链头锚定与 `verify --ci` 的核对。
 * 每个输出都用对应的 JSON Schema 校验（Agent Trace 是公开规范原样入库的 schema）；`--apply` 真的写进临时 git 仓库。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { git } from './integration-harness-tests.js'
import { validateAgainst } from './schema-validation-fixture.js'
import { ciCheckout, devProject, rewriteRecords, type CiCheckout, type Dev } from './verify-ci-fixture.js'

interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: Record<string, string | number | boolean> }>
  status: { code: number }
}

function attr(span: Span, key: string): string | number | boolean | undefined {
  const entry = span.attributes.find((item) => item.key === key)
  return entry === undefined ? undefined : Object.values(entry.value)[0]
}

describe('tenon evidence export', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function dev(): Promise<Dev> {
    const project = await devProject()
    cleanups.push(project.cleanup)
    return project
  }

  const head = (project: Dev): string => git(project.dir, ['rev-parse', 'HEAD']).trim()

  test('agent-trace：符合公开规范的 schema；文件与新增行来自任务 diff；contributor 缺省 unknown，显式断言才写 ai', async () => {
    const project = await dev()
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'agent-trace']), project.err()).toBe(0)
    const record = JSON.parse(project.out()) as Record<string, any>
    const verdict = validateAgainst('agentTrace', record)
    expect(verdict.valid, verdict.errors).toBe(true)
    expect(record.vcs).toEqual({ type: 'git', revision: head(project) })
    expect(record.tool.name).toBe('tenon')
    expect(record.files).toHaveLength(1)
    expect(record.files[0].path).toBe('src/feature.js')
    expect(record.files[0].conversations[0].ranges).toEqual([{ start_line: 1, end_line: 1 }])
    expect(record.files[0].conversations[0].contributor).toEqual({ type: 'unknown' })
    expect(record.files[0].conversations[0].related[0].url).toMatch(/^tenon:evidence\/demo\?head=sha256:/u)
    expect(record.metadata['dev.tenon'].evidence.records).toBe(1)

    // 同一份证据重复导出得到同一个 id。
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'agent-trace']), project.err()).toBe(0)
    expect((JSON.parse(project.out()) as { id: string }).id).toBe(record.id)

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'agent-trace', '--contributor', 'ai', '--model', 'anthropic/claude-opus-4-5']), project.err()).toBe(0)
    const asserted = JSON.parse(project.out()) as Record<string, any>
    expect(validateAgainst('agentTrace', asserted).valid).toBe(true)
    expect(asserted.files[0].conversations[0].contributor).toEqual({ type: 'ai', model_id: 'anthropic/claude-opus-4-5' })

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'agent-trace', '--contributor', 'robot'])).toBe(1)
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'otel', '--model', 'x/y'])).toBe(1)
  }, 180_000)

  test('otel：OTLP/JSON 的 schema 与 GenAI span 约定（invoke_workflow / execute_tool 的名字与属性、父子关系、时间序）', async () => {
    const project = await dev()
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'otel']), project.err()).toBe(0)
    const exported = JSON.parse(project.out()) as { resourceSpans: Array<{ resource: { attributes: Span['attributes'] }; scopeSpans: Array<{ spans: Span[] }> }> }
    const verdict = validateAgainst('otlp', exported)
    expect(verdict.valid, verdict.errors).toBe(true)
    const spans = exported.resourceSpans[0]?.scopeSpans[0]?.spans ?? []
    const ids = new Set(spans.map((span) => span.spanId))
    expect(ids.size).toBe(spans.length)
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1)
    for (const span of spans) {
      if (span.parentSpanId !== undefined) expect(ids.has(span.parentSpanId), `${span.name} 的父 span 存在`).toBe(true)
      expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true)
    }
    const root = spans.find((span) => span.parentSpanId === undefined)
    expect(root?.name).toBe('invoke_workflow trusted')
    expect(attr(root as Span, 'gen_ai.operation.name')).toBe('invoke_workflow')
    expect(attr(root as Span, 'gen_ai.workflow.name')).toBe('trusted')
    expect(attr(root as Span, 'tenon.change')).toBe('demo')
    const tool = spans.find((span) => attr(span, 'gen_ai.operation.name') === 'execute_tool')
    expect(tool?.name).toBe('execute_tool tenon.test.unit')
    expect(attr(tool as Span, 'gen_ai.tool.name')).toBe('tenon.test.unit')
    expect(attr(tool as Span, 'gen_ai.tool.type')).toBe('function')
    expect(tool?.parentSpanId).toBe(root?.spanId)
    expect(tool?.status.code).toBe(1)
    for (const span of spans) {
      // 自定义属性只用 tenon. 前缀，不借用 gen_ai.* 名字。
      for (const entry of span.attributes) {
        expect(/^(gen_ai\.(operation\.name|workflow\.name|agent\.name|provider\.name|tool\.(name|type|call\.id))|tenon\.|error\.type|vcs\.ref\.head\.revision)/u.test(entry.key), entry.key).toBe(true)
      }
    }
    const again = await project.tenon(['evidence', 'export', 'demo', '--format', 'otel'])
    expect(again).toBe(0)
    expect((JSON.parse(project.out()) as typeof exported).resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.spanId)).toEqual(spans.map((span) => span.spanId))
  }, 180_000)

  test('git-notes：默认只打印；--apply 写 refs/notes/tenon；同提交再导出合并替换；别人的 note 不覆盖', async () => {
    const project = await dev()
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'git-notes']), project.err()).toBe(0)
    const printed = JSON.parse(project.out()) as { changes: Array<{ chain: { head: string }; anchor?: unknown }> }
    expect(validateAgainst('evidenceNote', printed).valid).toBe(true)
    expect(printed.changes[0]?.anchor).toBeUndefined()
    expect(git(project.dir, ['notes', '--ref=tenon', 'list']).trim()).toBe('')

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'git-notes', '--apply']), project.err()).toBe(0)
    expect(project.out()).toContain('refs/notes/tenon')
    const written = JSON.parse(git(project.dir, ['notes', '--ref=tenon', 'show', 'HEAD'])) as typeof printed
    expect(validateAgainst('evidenceNote', written).valid).toBe(true)
    expect(written.changes).toHaveLength(1)
    expect(written.changes[0]?.chain.head).toBe(printed.changes[0]?.chain.head)

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'git-notes', '--anchor', '--apply']), project.err()).toBe(0)
    const anchored = JSON.parse(git(project.dir, ['notes', '--ref=tenon', 'show', 'HEAD'])) as typeof printed
    expect(anchored.changes).toHaveLength(1)
    expect(anchored.changes[0]?.anchor).toEqual({ kind: 'chain-head', head: printed.changes[0]?.chain.head })
    expect(validateAgainst('evidenceNote', anchored).valid).toBe(true)

    git(project.dir, ['notes', '--ref=tenon', 'add', '-f', '-m', 'someone else wrote this', 'HEAD'])
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'git-notes', '--apply'])).toBe(1)
    expect(project.err()).toContain('不是 Tenon 证据 note')
    expect(git(project.dir, ['notes', '--ref=tenon', 'show', 'HEAD']).trim()).toBe('someone else wrote this')

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'agent-trace', '--apply'])).toBe(1)
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'git-notes', '--contributor', 'ai'])).toBe(1)
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'trailer', '--anchor'])).toBe(1)
  }, 180_000)

  test('trailer：默认只打印；--apply 才 amend HEAD（替换同名尾注、拒绝暂存改动与非 HEAD 提交）', async () => {
    const project = await dev()
    const before = head(project)
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'trailer']), project.err()).toBe(0)
    const lines = project.out().split('\n')
    expect(lines).toEqual(['Tenon-Change: demo', expect.stringMatching(/^Tenon-Evidence: sha256:[a-f0-9]{64}$/u)])
    expect(head(project)).toBe(before)

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'trailer', '--commit', 'HEAD~1', '--apply'])).toBe(1)
    expect(project.err()).toContain('不是 HEAD')
    await writeFile(join(project.dir, 'staged.txt'), 'x\n', 'utf8')
    git(project.dir, ['add', 'staged.txt'])
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'trailer', '--apply'])).toBe(1)
    expect(project.err()).toContain('已暂存')
    expect(head(project)).toBe(before)
    git(project.dir, ['reset', '-q', 'staged.txt'])

    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'trailer', '--apply']), project.err()).toBe(0)
    const amended = head(project)
    expect(amended).not.toBe(before)
    const message = git(project.dir, ['log', '-1', '--format=%B'])
    expect(message).toContain('Tenon-Change: demo')
    expect(message).toContain(lines[1] ?? '')
    expect(git(project.dir, ['show', '-s', '--format=%an', 'HEAD']).trim()).toBe('t')
    // 再来一次：同名尾注被替换，不重复。
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'trailer', '--apply']), project.err()).toBe(0)
    expect(git(project.dir, ['log', '-1', '--format=%B']).match(/Tenon-Evidence:/gu)).toHaveLength(1)
  }, 180_000)

  test('同一份证据重复导出：四种格式逐字节相同，时间戳取证据里最晚一条记录的完成时间，不是导出时刻', async () => {
    const project = await dev()
    const finished = (await project.records()).map((record) => record.finished_at).sort().at(-1)
    expect(finished).toBeDefined()
    async function exported(...args: string[]): Promise<string> {
      expect(await project.tenon(['evidence', 'export', 'demo', ...args]), project.err()).toBe(0)
      return project.out()
    }
    // 夹具的时钟每读一次前进一秒：两次导出的「导出时刻」一定不同，输出却必须相同。
    const trace = await exported('--format', 'agent-trace')
    expect((JSON.parse(trace) as { timestamp: string }).timestamp).toBe(finished)
    expect(await exported('--format', 'agent-trace')).toBe(trace)
    expect(await exported('--format', 'agent-trace', '--contributor', 'ai', '--model', 'anthropic/claude-opus-4-5'))
      .toBe(await exported('--format', 'agent-trace', '--contributor', 'ai', '--model', 'anthropic/claude-opus-4-5'))
    const otel = await exported('--format', 'otel')
    expect(await exported('--format', 'otel')).toBe(otel)
    const notes = await exported('--format', 'git-notes', '--anchor')
    expect((JSON.parse(notes) as { changes: Array<{ created_at: string }> }).changes[0]?.created_at).toBe(finished)
    expect(await exported('--format', 'git-notes', '--anchor')).toBe(notes)
    const trailer = await exported('--format', 'trailer')
    expect(await exported('--format', 'trailer')).toBe(trailer)
  }, 180_000)

  test('记录链断了拒绝导出；缺 --format、未知格式是用法错误', async () => {
    const project = await dev()
    expect(await project.tenon(['evidence', 'export', 'demo'])).toBe(1)
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'xml'])).toBe(1)
    expect(await project.tenon(['evidence', 'export', 'nope', '--format', 'trailer'])).toBe(1)
    await rewriteRecords(project.dir, (record) => ({ ...record, machine_label: 'forged' }), { rechain: false })
    expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'otel'])).toBe(2)
    expect(project.err()).toContain('拒绝导出')
  }, 180_000)

  describe('锚定与 verify --ci', () => {
    async function anchored(): Promise<{ project: Dev; ci: CiCheckout }> {
      const project = await dev()
      expect(await project.tenon(['evidence', 'export', 'demo', '--format', 'git-notes', '--anchor', '--apply']), project.err()).toBe(0)
      return { project, ci: await fresh(project) }
    }

    async function fresh(project: Dev): Promise<CiCheckout> {
      const ci = await ciCheckout(project)
      cleanups.push(ci.cleanup)
      return ci
    }

    async function verify(ci: CiCheckout, ...args: string[]): Promise<{ code: number; report: CiVerifyReport }> {
      const run = await ci.verify(['--change', 'demo', '--format', 'json', ...args])
      return { code: run.code, report: JSON.parse(run.out) as CiVerifyReport }
    }

    test('锚点：CI 拉到 notes 后链头一致；没拉到就是未锚定，--require-anchor 才算失败', async () => {
      const { ci } = await anchored()
      const without = await verify(ci)
      expect(without.code).toBe(0)
      expect(without.report.changes[0]?.anchor).toBe('none')
      const required = await verify(ci, '--require-anchor')
      expect(required.code).toBe(2)
      expect(required.report.changes[0]?.findings.map((item) => item.code)).toContain('anchor-missing')

      git(ci.dir, ['fetch', '-q', 'origin', 'refs/notes/tenon:refs/notes/tenon'])
      const withNotes = await verify(ci, '--require-anchor')
      expect(withNotes.code, JSON.stringify(withNotes.report.changes[0]?.findings)).toBe(0)
      expect(withNotes.report.changes[0]?.anchor).toBe('verified')
    }, 240_000)

    test('把整条链重写并重算每个摘要：链自洽，但锚定的链头不在链里，CI 失败', async () => {
      const { ci } = await anchored()
      git(ci.dir, ['fetch', '-q', 'origin', 'refs/notes/tenon:refs/notes/tenon'])
      await rewriteRecords(ci.dir, (record) => ({ ...record, machine_label: 'forged' }), { rechain: true })
      ci.commit('rewrite the whole chain')
      const result = await verify(ci)
      expect(result.report.changes[0]?.chains[0]?.state).toBe('intact')
      expect(result.report.changes[0]?.anchor).toBe('mismatch')
      expect(result.code).toBe(2)
      expect(result.report.changes[0]?.findings.map((item) => item.code)).toContain('anchor-mismatch')
      const finding = result.report.changes[0]?.findings.find((item) => item.code === 'anchor-mismatch')
      expect(finding?.fix).toBeUndefined()
    }, 240_000)

    test('锚点之后又追加了记录：警告 anchor-behind；--require-anchor 升为失败', async () => {
      const { project } = await anchored()
      expect(await project.tenon(['test', 'run', 'demo', '--stage']), project.err()).toBe(0)
      project.commit('run the tests again after anchoring')
      const ci = await fresh(project)
      git(ci.dir, ['fetch', '-q', 'origin', 'refs/notes/tenon:refs/notes/tenon'])
      const lenient = await verify(ci)
      expect(lenient.code, JSON.stringify(lenient.report.changes[0]?.findings)).toBe(0)
      expect(lenient.report.changes[0]?.anchor).toBe('behind')
      expect(lenient.report.changes[0]?.findings.filter((item) => item.severity === 'warning').map((item) => item.code)).toEqual(['anchor-behind'])
      const strict = await verify(ci, '--require-anchor')
      expect(strict.code).toBe(2)
    }, 240_000)

    test('json 与 sarif 输出符合各自的 schema（含失败发现）', async () => {
      const { ci } = await anchored()
      await rewriteRecords(ci.dir, (record) => ({ ...record, machine_label: 'forged' }), { rechain: false })
      ci.commit('tamper')
      const json = await ci.verify(['--change', 'demo', '--format', 'json'])
      expect(json.code).toBe(2)
      const report = JSON.parse(json.out) as CiVerifyReport
      expect(validateAgainst('verifyReport', report).errors).toBe('')
      const sarif = await ci.verify(['--change', 'demo', '--format', 'sarif'])
      expect(sarif.code).toBe(2)
      const log = JSON.parse(sarif.out) as { runs: Array<{ results: Array<{ ruleId: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }> }
      const verdict = validateAgainst('sarif', log)
      expect(verdict.valid, verdict.errors).toBe(true)
      const result = log.runs[0]?.results.find((item) => item.ruleId === 'tenon/record-chain-broken')
      expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toMatch(/^\.tenon\/users\/.+\/tests\/demo\/.+\.json$/u)
      const markdown = await ci.verify(['--change', 'demo', '--format', 'markdown'])
      expect(markdown.out).toContain('## FAIL')
      expect(markdown.out).toContain('record-chain-broken')
    }, 240_000)
  })
})
