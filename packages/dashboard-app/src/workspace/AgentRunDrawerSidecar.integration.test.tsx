/**
 * 抽屉宿主一行的端到端：v0.3 把 host / host_source / rerun_reason 写在旁注 `.pipeline-agent-run-meta.jsonl`，
 * 不写进台账行。Dashboard 经 server 读 agent 运行——这里用真写入器写盘（appendAgentRunRow，与 `tenon agent record`
 * 同一个），经 server 的 projectAgentRuns（readAgentRuns 把旁注叠回行）、JSON 往返（HTTP 快照的线上形态）、
 * Dashboard 的 decodeAgentRuns，最后真渲染 AgentRunDrawer，断言宿主行、「声明」标记与重跑原因都到了。
 */
import { render, screen, waitFor, within, cleanup } from '@testing-library/react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_RUN_META_FILE, AGENT_RUNS_FILE, appendAgentRunRow, compileEffectiveWorkflowPlan, ensureAgentFreeze,
  type AgentRunRow, type PipelineState, type WorkflowDef,
} from '@tenon/kernel'
import { projectAgentRuns } from '../../../server/src/agentRuns.js'
import { TooltipProvider } from '@/components/ui/tooltip'
import { decodeAgentRuns } from '../api/snapshotEvidenceDecoders'
import { I18nProvider } from '../i18n'
import type { AgentRunView } from '../types'
import { AgentRunDrawer } from './AgentRunDrawer'

vi.mock('../api/documentsClient', () => ({
  fetchDocument: vi.fn(async () => ({ text: '# 评审报告\n' })),
}))

const RUN_ID = 'run-1'
const ROOT = '/Users/me/code/repo'
const CANDIDATE = `sha256:${'1'.repeat(64)}`
const REASON = '提示词缺上下文，补全后重跑'

const DEFINITION: WorkflowDef = {
  name: 'hosted',
  steps: [{
    id: 'verify', label: '验证', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [],
    agents: { executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'medium', host: 'codex' }] },
  }],
}

const agentFile = ['---', 'name: security', 'description: security 说明', 'tools: [Read]', '---', '', '正文', ''].join('\n')

function row(over: Partial<AgentRunRow>): AgentRunRow {
  return {
    schema: 'agent-run/v1',
    run_id: 'r-1',
    agent: 'security',
    agent_digest: `sha256:${'0'.repeat(64)}`,
    role: 'reviewer',
    step: 'verify',
    step_visit: '["run-1",7]',
    candidate: CANDIDATE,
    status: 'finished',
    result: 'pass',
    findings: [],
    report_path: 'r.md',
    report_digest: `sha256:${'3'.repeat(64)}`,
    actor: { id: 'a@x.com', name: 'A', trust: 'declared' },
    started_at: '2026-09-20T01:00:00Z',
    finished_at: '2026-09-20T01:10:00Z',
    ...over,
  }
}

let changeDir: string

beforeEach(async () => {
  changeDir = await mkdtemp(join(tmpdir(), 'tenon-drawer-sidecar-'))
})

afterEach(async () => {
  cleanup()
  window.localStorage.clear()
  await rm(changeDir, { recursive: true, force: true })
})

/** server 投影 → JSON 线上形态 → Dashboard 解码，取 verify 步骤的 security 评审者。 */
async function viewFromServer(): Promise<AgentRunView> {
  const plan = compileEffectiveWorkflowPlan('hosted', DEFINITION)
  await ensureAgentFreeze({
    changeDir, runId: RUN_ID, workflowFingerprint: plan.workflowFingerprint, workflow: plan.workflow,
    resolve: () => ({ source: 'custom', content: agentFile }),
  })
  await appendAgentRunRow(changeDir, row({
    run_id: 'r-1', host: 'codex', host_source: 'detected',
    findings: [{ severity: 'high', location: 'a.ts:1', message: '坏' }],
  }))
  await appendAgentRunRow(changeDir, row({
    run_id: 'r-2', host: 'codex', host_source: 'declared', rerun_reason: REASON,
    started_at: '2026-09-20T02:00:00Z', finished_at: '2026-09-20T02:10:00Z',
  }))
  const state = { fields: { phase: 'verify' }, runMetadata: { runId: RUN_ID, transitionSequence: 7 } } as unknown as PipelineState
  const projected = await projectAgentRuns({ changeDir, plan, state, phase: 'verify', candidate: async () => CANDIDATE })
  const decoded = decodeAgentRuns(JSON.parse(JSON.stringify(projected)))
  const agent = decoded?.find((step) => step.stepId === 'verify')?.agents[0]
  if (agent === undefined) throw new Error('verify 步骤的评审者没有出现在解码后的 agentRuns 里')
  return agent
}

describe('AgentRunDrawer · 宿主与重跑原因来自旁注（server → 快照 → 解码 → 渲染）', () => {
  it('台账行里没有这三项，旁注里有；抽屉宿主行仍显示宿主 + 「声明」，重跑原因在摘要行的 title 上', async () => {
    const agent = await viewFromServer()

    expect(await readFile(join(changeDir, AGENT_RUNS_FILE), 'utf8')).not.toMatch(/"host"|"host_source"|"rerun_reason"/u)
    expect(await readFile(join(changeDir, AGENT_RUN_META_FILE), 'utf8')).toContain('"host_source":"declared"')
    expect(agent).toMatchObject({
      state: 'done', result: 'pass', requiredHost: 'codex', host: 'codex', hostSource: 'declared',
      rerunReason: REASON, reruns: 1, flipped: true, wrongHost: false,
    })

    render(
      <I18nProvider>
        <TooltipProvider>
          <AgentRunDrawer root={ROOT} change="add-login" runnable agent={agent} onClose={() => {}} />
        </TooltipProvider>
      </I18nProvider>,
    )
    const host = screen.getByTestId('agent-run-host')
    expect(host).toHaveTextContent('宿主codex要求 · 声明')
    expect(within(host).getByTestId('agent-run-host-declared')).toBeInTheDocument()
    expect(within(host).queryByTestId('agent-run-host-mismatch')).toBeNull()
    expect(screen.getByTestId('agent-run-facts')).toHaveAttribute('title', REASON)
    // 要求的宿主上已有有效运行：不再给启动命令。
    expect(screen.queryByTestId('agent-run-command-row')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('agent-run-report')).toBeInTheDocument())
  })
})
