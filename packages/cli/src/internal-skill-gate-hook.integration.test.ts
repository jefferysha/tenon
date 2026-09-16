/**
 * 真实 e2e —— hooks/gate.sh 对所有 workflow 的 skill DAG 委托分支（Task 9，GOAL 清单 E）。
 *
 * 只验证 gate.sh 这条新分支本身的接线是否正确（真 bash 子进程 + 真 dist bundle + 真 CLI 落盘 +
 * 真 skill-tracker.sh 记账），不重复 internalSkillGate.test.ts 已经用 mock deps 覆盖过的
 * isSkillUnlocked 判定细节（依赖 DAG 各种组合、"最近一次进入 step" 扫描语义等）——这里只关心
 * "gate.sh 在正确的时机委托、在错误的时机绝不委托，且退出码正确传导"。
 *
 * 依赖 packages/cli/dist/tenon.mjs 是最新构建（gate.sh 生产路径 spawn 的就是这个 bundle）；
 * 本文件不负责触发构建，运行前需先 `npm run build`（同 tools/test-hooks.sh 对 dist 的既有假设，
 * 见该文件 §3 红线自证段的说明）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  documentGovernanceFingerprint,
  loadEffectiveWorkflowPlan,
  type EffectiveWorkflowPlan,
  type WorkflowPlanSnapshotV2,
} from '@tenon/kernel'
import {
  FIXED_CLOCK,
  freshHarness,
  realDeps,
  REPO_ROOT,
  rm,
  type Harness,
} from './integration-harness.js'

const TEST_CREATOR = { id: 'tester@tenon.test', name: 'Tester', trust: 'declared' } as const

const CHANGE = 'skg'

interface HookResult { code: number; stdout: string; stderr: string }

/** 真调用一个 hooks/*.sh（同 workflow-skill-orchestration.integration.test.ts 的驱动方式）。
 *  显式钉死 CLAUDE_PLUGIN_ROOT=REPO_ROOT（而非依赖 gate.sh 内 BASH_SOURCE 兜底）：本文件新增
 *  的分支第一次让 gate.sh 依赖 PLUGIN_ROOT 定位 dist bundle，若测试运行环境恰好残留了别的
 *  CLAUDE_PLUGIN_ROOT（例如本文件本身就跑在一个真实 Claude Code 会话里），不钉死会让 gate.sh
 *  误往其它安装位置找 bundle，产生环境相关的假红/假绿。强制清 TENON_AFK（同款理由：AFK
 *  逃生门会让 gate.sh 无条件放行，不能依赖外层 shell 干净）。 */
function runHook(script: string, payload: unknown, extraEnv: Record<string, string> = {}): HookResult {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...extraEnv }
  delete env.TENON_AFK
  const res = spawnSync('bash', [join(REPO_ROOT, 'hooks', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
  })
  if (res.error) throw res.error
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** 一个最小单 step workflow：s1 声明一个依赖同 step 内 'a' 的 skill 'needs-a'（无出边，本文件
 *  不测 transition）。'a' 必须作为 s1 自己的 skills 列表里的独立条目声明（即便它自己没有
 *  depends_on）——`validateWorkflow`（Task 3，GOAL E5）硬性要求 depends_on 只能引用同一个
 *  step 内已声明的 skill id，此前这里省略了 'a' 的独立声明，`loadWorkflow` 尚未接入校验时
 *  这个 fixture 能"恰好跑通"（isSkillUnlocked 只关心 completedSinceStepEntry 集合里有没有
 *  'a'，从不检查 'a' 是否被声明），接入校验后会被真实拒绝为悬空引用——修正为同
 *  parse.test.ts 的合法写法，不改变本文件任何一条断言（都只查询 'needs-a'，从不查询 'a'
 *  自身是否解锁）。 */
const WF = `name: skgwf
steps:
  - id: s1
    label: step-one
    gate: null
    skills:
      - id: a
      - id: needs-a
        depends_on: [a]
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

/** Codex 没有 first-class Skill tool；它读取已打包的 SKILL.md。这个 fixture 因此必须使用
 * 仓库中真实存在的两个 bundled skill，才能同时覆盖 gate.sh 的受控路径识别、skill-tracker 的
 * CodexSkillRead 留痕，以及串行依赖的后续解锁。 */
const CODEX_WF = `name: codex-skgwf
steps:
  - id: s1
    label: codex-step-one
    gate: null
    skills:
      - id: tenon-open
      - id: browser-qa
        depends_on: [tenon-open]
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: s2
  - id: s2
    label: codex-step-two
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

function legacyV2Snapshot(plan: EffectiveWorkflowPlan): WorkflowPlanSnapshotV2 {
  const { decomposition: _decomposition, interaction: _interaction, ...workflow } = plan.workflow
  const documentPolicy = structuredClone(plan.documentPolicy ?? null)
  const fingerprintPayload = {
    schema: 'effective-workflow-plan-v1',
    id: plan.id,
    executionModel: plan.executionModel,
    workflow,
    documentPolicy: documentPolicy === null
      ? null
      : { id: documentPolicy.id, fingerprint: documentGovernanceFingerprint(documentPolicy) },
    skillPolicy: plan.executionModel === 'phase-manifest' ? 'manifest-overlay' : 'step-declared',
    reviewSteps: workflow.steps.filter((step) => step.gate === 'review').map((step) => step.id),
    projectionSteps: workflow.steps.map((step) => ({ id: step.id, label: step.label })),
  }
  return {
    version: 2,
    workflowId: plan.id,
    executionModel: plan.executionModel,
    workflow,
    documentPolicy,
    workflowFingerprint: createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex'),
  }
}

describe('真实 e2e —— hooks/gate.sh 委托 internal-skill-gate（Task 9）', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    // The trust boundary deliberately rejects paths reached through symlinked ancestors. macOS
    // exposes tmpdir through /var -> /private/var, so normalize this test-only project fixture
    // before placing its path in host-owned transcript metadata.
    h.cwd = await realpath(h.cwd)
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  /** 真落 workflow 定义文件 + 真跑 `init --workflow` 把 change 直接摆到自定义 workflow 的
   *  首个 step 上（whole-branch review 补的 init --workflow，见
   *  init-workflow.integration.test.ts——此前这里手改 .pipeline.yaml 的 phase 行，因为
   *  `set phase` 被默认 7 相位枚举挡下，现在有了一条不必绕开它的路）。 */
  async function setupHistoricalCustomChange(workflowName: string, source: string): Promise<void> {
    const wfDir = join(h.cwd, '.pipeline', 'workflows')
    await mkdir(wfDir, { recursive: true })
    await writeFile(join(wfDir, `${workflowName}.yaml`), source, 'utf8')
    const deps = realDeps(h.cwd, [], [])
    const track = deps.loadRegistry().byId.get('backend')
    if (track === undefined) throw new Error('backend track fixture missing')
    const plan = loadEffectiveWorkflowPlan(h.cwd, workflowName, track)
    const snapshot = legacyV2Snapshot(plan)
    const { changeDir } = await deps.runRepo.initChange({
      repoRoot: h.cwd,
      name: CHANGE,
      track: track.id,
      reviewSeed: track.policyProfile.reviewSeed,
      creator: TEST_CREATOR, preset: 'full',
      clock: deps.clock,
      initialWorkflow: {
        workflow: workflowName,
        phase: plan.workflow.steps[0]?.id ?? 's1',
        workflowPlanFingerprint: snapshot.workflowFingerprint,
        workflowPlanSnapshot: snapshot,
      },
    })
    await writeFile(
      join(changeDir, '.pipeline-history.jsonl'),
      `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'init' })}\n`,
      'utf8',
    )
  }

  async function setupCustomChange(): Promise<void> {
    await setupHistoricalCustomChange('skgwf', WF)
  }

  async function setupCodexCustomChange(): Promise<void> {
    await setupHistoricalCustomChange('codex-skgwf', CODEX_WF)
  }

  test('init 落地的 change 缺省 workflow: default（回归锚，防 gate.sh 的 yget 解析假设漂移）', async () => {
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.read(CHANGE)).toMatch(/^workflow: default$/m)
  })

  test('workflow=default + 当前 phase Skill 可首调用，overlay receipt 缺失时不能绕过', async () => {
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const blocked = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'openspec-propose' } },
    )
    expect(blocked.code, `stderr=${blocked.stderr}`).toBe(2)
    expect(blocked.stderr).toContain('tenon-open')
    const phase = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'tenon-open' } },
    )
    expect(phase.code, `stderr=${phase.stderr}`).toBe(0)
  })

  test('workflow=default + phase 已完成时，matrix mandatory 未完成不应阻断未声明 optional Skill', async () => {
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const phase = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'tenon-open' } },
    )
    expect(phase.code, `stderr=${phase.stderr}`).toBe(0)
    const tracker = runHook(
      'skill-tracker.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'tenon-open' } },
    )
    expect(tracker.code, `stderr=${tracker.stderr}`).toBe(0)

    // backend 的 open overlay 仍缺 openspec-propose；该缺口不能把一个未声明的
    // optional Skill 重新变成 mandatory。Issue #43 只扩大了 phase-first hard gate。
    const optional = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'undeclared-optional-skill' } },
    )
    expect(optional.code, `stderr=${optional.stderr}`).toBe(0)
  })

  test('workflow=default + free/matrix=false 仍要求 phase Skill，未声明 Skill 不能先行', async () => {
    expect(await h.run(['init', CHANGE, '--track', 'free', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const blocked = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'free-optional-skill' } },
    )
    expect(blocked.code, `stderr=${blocked.stderr}`).toBe(2)
    expect(blocked.stderr).toContain('tenon-open')
    const phase = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'tenon-open' } },
    )
    expect(phase.code, `stderr=${phase.stderr}`).toBe(0)
  })

  test('workflow=default → 真实委托 node；委托进程自身异常仍按 hook 总纲 fail-open', async () => {
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const poisonDir = await mkdtemp(join(tmpdir(), 'poison-node-'))
    await writeFile(join(poisonDir, 'node'), '#!/usr/bin/env bash\nprintf \'POISONED\\n\' >&2\nexit 99\n', 'utf8')
    await chmod(join(poisonDir, 'node'), 0o755)
    const gate = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'needs-a' } },
      { PATH: `${poisonDir}:${process.env.PATH ?? ''}` },
    )
    expect(gate.code, `stderr=${gate.stderr}`).toBe(0)
    expect(gate.stderr).toContain('POISONED')
    await rm(poisonDir, { recursive: true, force: true })
  })

  test('非 default workflow + 非 Skill 调用（Bash）→ 即便当前 step 的 skill 被锁定也不受影响', async () => {
    await setupCustomChange()
    const gate = runHook('gate.sh', { cwd: h.cwd, tool_name: 'Bash' })
    expect(gate.code, `stderr=${gate.stderr}`).toBe(0)
  })

  test('非 default workflow + Skill 调用 + 依赖未满足 → gate 真拦截 exit 2，stderr 点名依赖', async () => {
    await setupCustomChange()
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const gate = runHook('gate.sh', { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'needs-a' } })
    expect(gate.code, `stderr=${gate.stderr}`).toBe(2)
    expect(gate.stderr).toContain('needs-a')
    expect(gate.stderr).toContain('a')
  })

  test('非 default workflow + Skill 调用 + 依赖已满足（真跑 skill-tracker.sh 记一次 a）→ gate 真放行', async () => {
    await setupCustomChange()
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    // 真触发一次 skill-tracker.sh（同 workflow-skill-orchestration.integration.test.ts 的驱动
    // 方式），让依赖 "a" 的完成记录真落进 .pipeline-history.jsonl，而非手搭 fixture 绕过真实
    // 写入路径——本行连带验证了 internalSkillGate.ts 对 raw="Skill: a" 前缀格式的解析假设
    // 与 skill-tracker.sh 的真实落盘格式一致（这条假设在 mock 单测里没有真落盘可验证）。
    const tracker = runHook('skill-tracker.sh', { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'a' } })
    expect(tracker.code, `skill-tracker stderr=${tracker.stderr}`).toBe(0)
    const histPath = join(h.cwd, 'openspec', 'changes', CHANGE, '.pipeline-history.jsonl')
    expect(await readFile(histPath, 'utf8')).toContain('"raw":"Skill: a"')

    const gate = runHook('gate.sh', { cwd: h.cwd, tool_name: 'Skill', tool_input: { skill: 'needs-a' } })
    expect(gate.code, `stderr=${gate.stderr}`).toBe(0)
  })

  test('Codex 缺 PostToolUse 时，只有 transcript 完成态核验后的 receipt 能解锁串行 skill', async () => {
    await setupCodexCustomChange()
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const home = join(h.cwd, 'fake-home')
    const hostCache = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', '0.2.0')
    await cp(join(REPO_ROOT, 'skills'), join(hostCache, 'skills'), { recursive: true, preserveTimestamps: false })
    await mkdir(join(hostCache, '.codex-plugin'), { recursive: true })
    await mkdir(join(home, '.codex', 'plugins', 'cache', 'tenon'), { recursive: true })
    await writeFile(join(hostCache, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'tenon', version: '0.2.0' }), 'utf8')
    await mkdir(join(hostCache, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(hostCache, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon' }] }), 'utf8')
    await cp(join(REPO_ROOT, 'templates'), join(hostCache, 'templates'), { recursive: true, preserveTimestamps: false })
    const cacheBundle = join(hostCache, 'packages', 'cli', 'dist', 'tenon.mjs')
    await mkdir(dirname(cacheBundle), { recursive: true })
    await cp(join(REPO_ROOT, 'packages', 'cli', 'dist', 'tenon.mjs'), cacheBundle, { preserveTimestamps: false })

    const commonEnv = { HOME: home, TENON_CODEX_PLUGIN_ROOT: hostCache, PLUGIN_ROOT: REPO_ROOT }
    // Receipt evidence deliberately accepts only a complete literal cat. Partial readers and
    // wrapper shells cannot prove that the model received the whole trusted Skill document.
    const orchestrationRead = `cat ${hostCache}/skills/tenon/SKILL.md`
    const pipelineOpenRead = `cat ${hostCache}/skills/tenon-open/SKILL.md`
    const browserQaRead = `cat ${hostCache}/skills/browser-qa/SKILL.md`
    const batchedLockedRead = `cat ${hostCache}/skills/tenon-open/SKILL.md && cat ${hostCache}/skills/browser-qa/SKILL.md`
    const batchedReceiptRead = `cat ${hostCache}/skills/tenon-open/SKILL.md && cat ${hostCache}/skills/tenon/SKILL.md`

    // `tenon` 是正常对话进入 custom workflow 前必经的编排入口，不是该 step 的工作
    // 节点；DAG 只能约束阶段实际 skill，不能因此把入口本身锁死。
    const orchestrationGate = runHook(
      'gate.sh', { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: orchestrationRead } }, commonEnv,
    )
    expect(orchestrationGate.code, `stderr=${orchestrationGate.stderr}`).toBe(0)

    // 在根节点完成前，PreToolUse 必须识别同一种包装形式并真拦串行节点；若只是不识别
    // `exec` 而 fail-open，本断言会抓到“看似通过、实际未执行 DAG”的假绿。
    const blockedGate = runHook(
      'gate.sh', { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: browserQaRead } }, commonEnv,
    )
    expect(blockedGate.code, `stderr=${blockedGate.stderr}`).toBe(2)

    // One Codex exec can load multiple skills.  The first root node is available, but the second
    // serial node is not; gate.sh must inspect both rather than allowing the whole batch merely
    // because tenon-open appeared first.
    const batchedGate = runHook(
      'gate.sh', { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: batchedLockedRead } }, commonEnv,
    )
    expect(batchedGate.code, `stderr=${batchedGate.stderr}`).toBe(2)
    expect(batchedGate.stderr).toContain('browser-qa')

    // 真实 Codex PreToolUse：根节点可先读取。
    const firstGate = runHook(
      'gate.sh', { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: pipelineOpenRead } }, commonEnv,
    )
    expect(firstGate.code, `stderr=${firstGate.stderr}`).toBe(0)

    // Intentionally omit skill-tracker/PostToolUse.  The receipt hook sees only the actual
    // PreToolUse payload; its later consumer must prove this exact completed host call in the
    // transcript before it writes CodexSkillRead.
    const transcript = join(home, '.codex', 'sessions', '2026', '07', '24', 'dag-receipt.jsonl')
    await mkdir(dirname(transcript), { recursive: true })
    const transcriptTimestamp = new Date().toISOString()
    await writeFile(transcript, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: transcriptTimestamp,
        payload: { cwd: h.cwd, session_id: 'session-dag-1', id: 'session-dag-1' },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: transcriptTimestamp,
        payload: { turn_id: 'turn-dag-1' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: transcriptTimestamp,
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call-tenon-open',
          name: 'exec',
          input: `const r = await tools.exec_command(${JSON.stringify({ cmd: batchedReceiptRead })}); text(r);`,
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-dag-1' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: transcriptTimestamp,
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-tenon-open',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: 'dag-receipt',
                exit_code: 0,
                original_token_count: 0,
                output: await readFile(join(hostCache, 'skills', 'tenon-open', 'SKILL.md'), 'utf8')
                  + await readFile(join(hostCache, 'skills', 'tenon', 'SKILL.md'), 'utf8'),
                wall_time_seconds: 0.1,
              }),
            },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-dag-1' },
        },
      }),
    ].join('\n') + '\n', 'utf8')
    const receipt = runHook('codex-skill-receipt.sh', {
      cwd: h.cwd,
      tool_name: 'exec',
      tool_input: { cmd: batchedReceiptRead },
      transcript_path: transcript,
      session_id: 'session-dag-1',
      turn_id: 'turn-dag-1',
      tool_use_id: 'call-tenon-open',
    }, commonEnv)
    expect(receipt.code, `stderr=${receipt.stderr}`).toBe(0)
    const receiptJournal = join(h.cwd, '.pipeline', 'codex-skill-receipts.jsonl')
    expect(await readFile(receiptJournal, 'utf8')).toContain('tenon-open')
    expect(await readFile(receiptJournal, 'utf8')).toContain('"skillId":"tenon"')

    const histPath = join(h.cwd, 'openspec', 'changes', CHANGE, '.pipeline-history.jsonl')
    expect(await readFile(histPath, 'utf8')).not.toContain('CodexSkillRead: tenon-open')

    // 浏览器验收 skill 是串行节点；下一次 PreToolUse 的 gate 在同一 change lock 内先完成
    // transcript 核验，再读取 DAG，所以无需依赖缺失的 PostToolUse 或让用户重试。
    const secondGate = runHook(
      'gate.sh', { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: browserQaRead } }, commonEnv,
    )
    expect(secondGate.code, `stderr=${secondGate.stderr}`).toBe(0)
    expect(await readFile(histPath, 'utf8')).toContain('"raw":"CodexSkillRead: tenon-open"')
  })

  test('Codex 省略 PreToolUse transcript 标识时，当前项目的完成会话仍可解锁串行 skill', async () => {
    await setupCodexCustomChange()
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const home = join(h.cwd, 'abi-omitted-home')
    const hostCache = join(home, '.codex', 'plugins', 'cache', 'tenon', 'tenon', '0.2.0')
    await cp(join(REPO_ROOT, 'skills'), join(hostCache, 'skills'), { recursive: true, preserveTimestamps: false })
    await mkdir(join(hostCache, '.codex-plugin'), { recursive: true })
    await mkdir(join(home, '.codex', 'plugins', 'cache', 'tenon'), { recursive: true })
    await writeFile(join(hostCache, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'tenon', version: '0.2.0' }), 'utf8')
    await mkdir(join(hostCache, '.agents', 'plugins'), { recursive: true })
    await writeFile(join(hostCache, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'tenon', plugins: [{ name: 'tenon' }] }), 'utf8')
    const cacheBundle = join(hostCache, 'packages', 'cli', 'dist', 'tenon.mjs')
    await mkdir(dirname(cacheBundle), { recursive: true })
    await cp(join(REPO_ROOT, 'packages', 'cli', 'dist', 'tenon.mjs'), cacheBundle, { preserveTimestamps: false })

    const commonEnv = {
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      TENON_CODEX_PLUGIN_ROOT: hostCache,
      PLUGIN_ROOT: REPO_ROOT,
    }
    const browserQaRead = `cat ${hostCache}/skills/browser-qa/SKILL.md`
    const transcript = join(home, '.codex', 'sessions', '2026', '07', '24', 'abi-omitted.jsonl')
    await mkdir(dirname(transcript), { recursive: true })
    const transcriptTimestamp = new Date().toISOString()
    await writeFile(transcript, [
      JSON.stringify({
        type: 'session_meta',
        timestamp: transcriptTimestamp,
        payload: { cwd: h.cwd, session_id: 'session-omitted-1', id: 'session-omitted-1' },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: transcriptTimestamp,
        payload: { turn_id: 'turn-omitted-1' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: transcriptTimestamp,
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call-tenon-open',
          name: 'exec',
          input: `const r = await tools.exec_command(${JSON.stringify({ cmd: `cat ${hostCache}/skills/tenon-open/SKILL.md` })}); text(r);`,
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: transcriptTimestamp,
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-tenon-open',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
            {
              type: 'input_text',
              text: JSON.stringify({
                chunk_id: 'omitted-receipt',
                exit_code: 0,
                original_token_count: 0,
                output: await readFile(join(hostCache, 'skills', 'tenon-open', 'SKILL.md'), 'utf8'),
                wall_time_seconds: 0.1,
              }),
            },
          ],
        },
      }),
    ].join('\n') + '\n', 'utf8')
    const bindingsDir = join(h.cwd, '.pipeline', 'terminal-sessions')
    await mkdir(bindingsDir, { recursive: true })
    await writeFile(join(bindingsDir, 'session-omitted-1.json'), `${JSON.stringify({
      protocol: 'pipeline-terminal-session-v1',
      session_id: 'session-omitted-1',
      change: CHANGE,
      bound_at: transcriptTimestamp,
    })}\n`, 'utf8')

    // There is deliberately no call to codex-skill-receipt.sh: this mirrors the current host ABI
    // that gives PreToolUse only cwd/tool_input.  The next serial gate must reconcile the same
    // host-owned, same-project session rather than making the user retry or accepting a marker.
    const gate = runHook(
      'gate.sh', { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: browserQaRead } }, commonEnv,
    )
    expect(gate.code, `stderr=${gate.stderr}`).toBe(0)
    const histPath = join(h.cwd, 'openspec', 'changes', CHANGE, '.pipeline-history.jsonl')
    expect(await readFile(histPath, 'utf8')).toContain('"raw":"CodexSkillRead: tenon-open"')
  })

  test('已激活 Change 时，同名全局 SKILL.md 不能抢占 tenon 打包 skill', async () => {
    await setupCodexCustomChange()
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    const home = join(h.cwd, 'shadowed-skill-home')
    const foreignSkill = join(home, '.agents', 'skills', 'tenon-open', 'SKILL.md')
    await mkdir(dirname(foreignSkill), { recursive: true })
    await writeFile(foreignSkill, '# foreign tenon-open\n', 'utf8')

    const shadowedRead = `cat ${foreignSkill}`
    const gate = runHook(
      'gate.sh',
      { cwd: h.cwd, tool_name: 'exec', tool_input: { cmd: shadowedRead } },
      { HOME: home, PLUGIN_ROOT: REPO_ROOT },
    )

    expect(gate.code, `stderr=${gate.stderr}`).toBe(2)
    expect(gate.stderr).toContain("skill 'tenon-open'")
    expect(gate.stderr).toContain('tenon:tenon-open')
  })
})
