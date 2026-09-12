import { describe, expect, it } from 'vitest'
import { nodeExec } from '../runner/exec.js'
import { decodeCodexToolCompletion, parseCodexSkillOutput, createCodexSkillExecutorV2 } from './codex-skill-executor-v2.js'

const now = '2026-09-12T00:00:00.000Z'

describe('production Codex skill executor v2', () => {
  it('decodes supported Codex completion shapes and enforces the workspace scope', () => {
    expect(decodeCodexToolCompletion({
      type: 'item.completed',
      item: { type: 'file_change', id: 'call-file', changes: [{ path: 'artifacts/report.md' }, { path: 'artifacts/report.json' }] },
    }, '/tmp/change')).toEqual({
      kind: 'file_change', paths: ['artifacts/report.md', 'artifacts/report.json'], rejectedPathCount: 0, toolCallId: 'call-file',
    })
    expect(decodeCodexToolCompletion({
      type: 'write.completed', item: { file_path: '/tmp/change/artifacts/summary.txt', tool_call_id: 'call-write' },
    }, '/tmp/change')).toEqual({ kind: 'write.completed', paths: ['artifacts/summary.txt'], rejectedPathCount: 0, toolCallId: 'call-write' })
    expect(decodeCodexToolCompletion({
      type: 'item.completed', item: { type: 'command_execution', command: 'echo hi > artifacts/ignored.txt' },
    }, '/tmp/change')).toMatchObject({ kind: 'command_execution', paths: [], rejectedPathCount: 0 })
    expect(decodeCodexToolCompletion({
      type: 'item.completed', item: { type: 'file_change', changes: [{ path: '../outside.txt' }, { path: '.orchestration-v2/ledger.json' }] },
    }, '/tmp/change')).toMatchObject({ kind: 'file_change', paths: [], rejectedPathCount: 2 })
    expect(decodeCodexToolCompletion({ type: 'item.completed', item: { type: 'tool_result', path: 'artifacts/not-managed.md' } }, '/tmp/change')).toBeUndefined()
  })

  it('parses the latest JSON envelope and preserves consumed declarations', () => {
    const result = parseCodexSkillOutput([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<output>{"output":"old"}</output>' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<output>{"output":"new","consumed":[{"ref":"input.txt","version":"v1"}]}</output>' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ].join('\n'))
    expect(result.value).toEqual({ output: 'new', consumed: [{ ref: 'input.txt', version: 'v1' }] })
  })

  it('runs a real child process through the production nodeExec boundary', async () => {
    const reconciled: string[] = []
    const executor = createCodexSkillExecutorV2({
      change_dir: '/tmp', codex_executable: process.execPath,
      exec: (_file, _args, options) => nodeExec(process.execPath, ['-e', "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution'}})+'\\n'+JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'<output>{\"output\":\"child\"}</output>'}}))"], options),
    })
    const result = await executor.execute({
      run_id: 'run-child', work_item_id: 'item-child', skill_id: 'skill', skill_version: '1', mcp_ids: [], input_refs: [],
      input_bundle: { schema_version: 'skill-input-bundle/v2', bundle_id: 'bundle:child', run_id: 'run-child', work_item_id: 'item-child', items: [], bundle_digest: `sha256:${'a'.repeat(64)}`, byte_length: 0 },
      signal: new AbortController().signal,
      artifact_runtime: { async reconcile() { reconciled.push('child'); return [] } },
    })
    expect(result).toMatchObject({ output: 'child' })
    expect(reconciled).toEqual(['child'])
  })

  it('connects tool completion to reconcile and envelope files to publish', async () => {
    const reconciled: string[] = []
    const published: string[] = []
    const executor = createCodexSkillExecutorV2({
      change_dir: '/tmp/change',
      codex_executable: 'fake-codex',
      exec: async (_file, _args, options) => {
        options?.onLine?.(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'printf hi' } }))
        return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<output>{"output":"ok","artifacts":[{"ref":"report.md"}]}</output>' } }), stderr: '', exitCode: 0 }
      },
    })
    const input = {
      run_id: 'run-1', work_item_id: 'item-1', skill_id: 'skill-1', skill_version: '1.0.0', mcp_ids: [], input_refs: [],
      input_bundle: { schema_version: 'skill-input-bundle/v2' as const, bundle_id: 'bundle:1', run_id: 'run-1', work_item_id: 'item-1', items: [], bundle_digest: 'sha256:' + 'a'.repeat(64) as `sha256:${string}`, byte_length: 0 },
      signal: new AbortController().signal,
      artifact_runtime: {
        async reconcile() { reconciled.push('reconcile'); return [] },
        async publish(path: string) { published.push(path); return {} as never },
      },
    }
    const result = await executor.execute(input)
    expect(result).toMatchObject({ output: 'ok', artifacts: [{ ref: 'report.md' }] })
    expect(reconciled).toHaveLength(1)
    expect(published).toEqual(['report.md'])
    void now
  })

  it('observes validated managed-tool paths and emits bounded event diagnostics', async () => {
    const observed: Array<{ path: string; source?: string; toolCallId?: string }> = []
    const reconciled: string[] = []
    const executor = createCodexSkillExecutorV2({
      change_dir: '/tmp/change', codex_executable: 'fake-codex',
      exec: async (_file, _args, options) => {
        options?.onLine?.(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', id: 'call-1', changes: [{ path: 'artifacts/a.md' }] } }))
        options?.onLine?.(JSON.stringify({ type: 'item.completed', item: { type: 'tool_result', path: 'artifacts/not-managed.md' } }))
        options?.onLine?.(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } }))
        return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<output>{"output":"ok"}</output>' } }), stderr: '', exitCode: 0 }
      },
    })
    const result = await executor.execute({
      run_id: 'run-managed', work_item_id: 'item-managed', skill_id: 'skill', skill_version: '1', mcp_ids: [], input_refs: [],
      input_bundle: { schema_version: 'skill-input-bundle/v2', bundle_id: 'bundle:managed', run_id: 'run-managed', work_item_id: 'item-managed', items: [], bundle_digest: `sha256:${'a'.repeat(64)}`, byte_length: 0 },
      signal: new AbortController().signal,
      artifact_runtime: {
        async observePath(path: string, options?: { source?: 'managed-tool'; toolCallId?: string }) { observed.push({ path, source: options?.source, toolCallId: options?.toolCallId }); return {} as never },
        async reconcile() { reconciled.push('fallback'); return [] },
      },
    })
    expect(observed).toEqual([{ path: 'artifacts/a.md', source: 'managed-tool', toolCallId: 'call-1' }])
    expect(reconciled).toEqual(['fallback'])
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      'codex-managed-tool-completions:2', 'codex-managed-tool-paths:1', 'codex-managed-observations:1',
    ]))
    expect(result.diagnostics?.some((entry) => entry.includes('tool_result'))).toBe(false)
  })

  it('coalesces path-unresolved reconciles within one turn', async () => {
    const reconciled: string[] = []
    const executor = createCodexSkillExecutorV2({
      change_dir: '/tmp/change', codex_executable: 'fake-codex',
      exec: async (_file, _args, options) => {
        const command = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'printf hi' } })
        options?.onLine?.(command); options?.onLine?.(command); options?.onLine?.(JSON.stringify({ type: 'turn.completed' })); options?.onLine?.(command)
        return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '<output>{"output":"ok"}</output>' } }), stderr: '', exitCode: 0 }
      },
    })
    await executor.execute({
      run_id: 'run-throttle', work_item_id: 'item-throttle', skill_id: 'skill', skill_version: '1', mcp_ids: [], input_refs: [],
      input_bundle: { schema_version: 'skill-input-bundle/v2', bundle_id: 'bundle:throttle', run_id: 'run-throttle', work_item_id: 'item-throttle', items: [], bundle_digest: 'sha256:' + 'a'.repeat(64), byte_length: 0 },
      signal: new AbortController().signal,
      artifact_runtime: { async reconcile() { reconciled.push('reconcile'); return [] } },
    })
    expect(reconciled).toHaveLength(2)
  })
})
