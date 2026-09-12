import { describe, expect, it } from 'vitest'
import { nodeExec } from '../runner/exec.js'
import { parseCodexSkillOutput, createCodexSkillExecutorV2 } from './codex-skill-executor-v2.js'

const now = '2026-09-12T00:00:00.000Z'

describe('production Codex skill executor v2', () => {
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
})
