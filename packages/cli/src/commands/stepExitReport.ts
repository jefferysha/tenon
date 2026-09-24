/**
 * 当前步骤每条出边的就绪判定：组合规则归 kernel（`evaluateStepExitReport`），Dashboard 快照读同一份。
 * CLI 这里只把自己的读取能力（文件面、身份、历史与宿主回执、agent 台账）交进去。
 */
import {
  evaluateStepExitReport as evaluateKernelStepExitReport,
  type EffectiveWorkflowPlan, type PipelineState, type StepExitReport,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { stepAgentBlockersFor } from '../agentGate.js'
import { judgeStepSkills } from '../stepSkillGate.js'
import { testEvidenceContextFor, testEvidenceReaderFor } from '../testEvidenceContext.js'
import { resolveBuildRevisionAssessor } from './buildRevisionAssessor.js'

export type { StepBlocker, StepBlockerSource as BlockerSource, StepExit, StepExitReport } from '@tenon/kernel'

export async function evaluateStepExitReport(
  deps: CliDeps,
  name: string,
  dir: string,
  state: PipelineState,
  plan: EffectiveWorkflowPlan,
): Promise<StepExitReport> {
  const fileContext = deps.guardCtx?.(name)
  const workspaceFingerprint = deps.workspaceFingerprint
  const phase = state.fields.phase
  const stepId = Array.isArray(phase) ? phase.join(',') : (phase ?? '')
  return evaluateKernelStepExitReport({
    repoRoot: deps.cwd,
    changeName: name,
    changeDir: dir,
    state,
    plan,
    guardCheck: (target, ctx) => deps.flow.guardCheck(target, ctx),
    guardContext: {
      fileExists: fileContext?.fileExists,
      gitHeadSha: deps.gitHeadSha,
      workspaceFingerprint: workspaceFingerprint === undefined ? undefined : () => workspaceFingerprint(name),
      assessBuildRevision: resolveBuildRevisionAssessor(deps, name, dir),
    },
    fileContext,
    ...(deps.documentEvidence === undefined ? {} : { documentEvidence: deps.documentEvidence }),
    testEvidence: { reader: testEvidenceReaderFor(deps), context: testEvidenceContextFor(deps, name) },
    skills: () => judgeStepSkills({
      deps, changeDir: dir, stepId, capability: plan.capabilities.skills, recordEvidence: false,
      documentPolicy: plan.capabilities.documents.policy,
    }),
    agentBlockers: () => stepAgentBlockersFor({ deps, name, dir, stepId, plan, state }),
  })
}
