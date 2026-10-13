import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readSkillInvocationEvidence } from '@tenon/kernel'
import { freshHarness, REPO_ROOT, rm, type Harness } from './integration-harness.js'

interface HookResult { readonly code: number; readonly stderr: string }

describe('production Skill and question hook invocation lifecycle', () => {
  let h: Harness
  let hookEnv: Record<string, string>

  beforeEach(async () => {
    h = await freshHarness()
    const bin = join(h.cwd, '.test-bin')
    await mkdir(bin, { recursive: true })
    const date = join(bin, 'date')
    await writeFile(date, '#!/bin/sh\nprintf "%s\\n" "2026-07-07T00:00:00Z"\n', 'utf8')
    await chmod(date, 0o755)
    hookEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
    delete hookEnv.TENON_AFK
  })

  afterEach(async () => rm(h.cwd, { recursive: true, force: true }))

  function runHook(script: string, payload: unknown): HookResult {
    const result = spawnSync('bash', [join(REPO_ROOT, 'hooks', script)], {
      cwd: REPO_ROOT,
      env: hookEnv,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    })
    if (result.error) throw result.error
    return { code: result.status ?? -1, stderr: result.stderr ?? '' }
  }

  test('persists one native PostToolUse start, actual question/answer, document completion and artifact', async () => {
    const change = 'native-hook-proof'
    // 技能调用与文档产物的绑定（document record → artifacts: bound）只存在于契约模式：升级前创建的 default 任务。
    expect(await h.initLegacyContractDefault(change, 'backend')).toBe(0)
    expect(await h.run(['session', 'activate', change])).toBe(0)
    const proposal = join(h.cwd, 'openspec', 'changes', change, 'proposal.md')
    await writeFile(proposal, '# Native hook proof\n', 'utf8')

    const skill = runHook('skill-tracker.sh', {
      cwd: h.cwd,
      tool_name: 'Skill',
      tool_input: { skill: 'openspec-propose' },
      session_id: 'native-session-production',
      tool_use_id: 'native-skill-call-production',
    })
    expect(skill.code, skill.stderr).toBe(0)

    const interaction = runHook('decision-recorder.sh', {
      cwd: h.cwd,
      tool_name: 'AskUserQuestion',
      session_id: 'native-session-production',
      turn_id: 'native-turn-production',
      tool_use_id: 'native-question-call-production',
      tool_input: { questions: [{
        header: 'Scope',
        question: 'Should the canonical proposal be recorded?',
        options: [
          { label: 'Record', description: 'Record the canonical artifact.' },
          { label: 'Stop', description: 'Do not record it.' },
        ],
      }] },
      tool_response: { answers: { Scope: 'Record' } },
    })
    expect(interaction.code, interaction.stderr).toBe(0)

    expect(await h.run([
      'document', 'record', change, 'proposal',
      `openspec/changes/${change}/proposal.md`, '--producer', 'openspec-propose',
    ])).toBe(0)

    const changeDir = join(h.cwd, 'openspec', 'changes', change)
    const evidence = await readSkillInvocationEvidence(changeDir)
    expect(evidence).toMatchObject({
      state: 'ready',
      items: [expect.objectContaining({
        skill: { id: 'openspec-propose', version: '1' },
        status: 'completed',
        questions: [expect.objectContaining({
          key: 'host.scope', requiredness: 'hard-gate', shown: true,
        })],
        decisions: [expect.objectContaining({ mode: 'user-answer' })],
        artifacts: [expect.objectContaining({
          ref: `openspec/changes/${change}/proposal.md`, state: 'bound',
        })],
      })],
    })
    const persisted = await readFile(join(changeDir, '.pipeline-skill-invocations.jsonl'), 'utf8')
    expect(persisted).not.toContain('Should the canonical proposal be recorded?')
    expect(persisted).not.toContain('Record the canonical artifact')
    const history = await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('HostInteractionRecorded')
    expect(history).not.toContain('Should the canonical proposal be recorded?')
    expect(history).not.toContain('Record the canonical artifact')
  })
})
