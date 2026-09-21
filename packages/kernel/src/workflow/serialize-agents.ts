/**
 * `agents:` 块的写回（parse-agents.ts 的反向），只写块形态。
 * 键序固定 `agent, required, block_at, depends_on, reads_tests`；缺省键不写。
 * 两个身份列表都空的块在 parse 阶段已归一为缺省，所以这里只在非空时写出。
 */
import type { StepAgentsDef, StepExecutorRef, StepReviewerRef } from './types.js'

function serializeExecutor(ref: StepExecutorRef, pad: string): string[] {
  return [
    `${pad}- agent: ${ref.agent}`,
    ...(ref.depends_on === undefined ? [] : [`${pad}  depends_on: [${ref.depends_on.join(', ')}]`]),
  ]
}

function serializeReviewer(ref: StepReviewerRef, pad: string): string[] {
  return [
    `${pad}- agent: ${ref.agent}`,
    `${pad}  required: ${ref.required}`,
    `${pad}  block_at: ${ref.block_at}`,
    ...(ref.depends_on === undefined ? [] : [`${pad}  depends_on: [${ref.depends_on.join(', ')}]`]),
    ...(ref.reads_tests === undefined ? [] : [`${pad}  reads_tests: [${ref.reads_tests.join(', ')}]`]),
  ]
}

export function serializeStepAgents(agents: StepAgentsDef | undefined): string[] {
  if (agents === undefined) return []
  const lines = ['    agents:']
  if (agents.executors.length > 0) {
    lines.push('      executors:', ...agents.executors.flatMap((ref) => serializeExecutor(ref, '        ')))
  }
  if (agents.reviewers.length > 0) {
    lines.push('      reviewers:', ...agents.reviewers.flatMap((ref) => serializeReviewer(ref, '        ')))
  }
  return lines
}
