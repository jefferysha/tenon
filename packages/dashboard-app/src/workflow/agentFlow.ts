/**
 * agent 段落与技能画布之间的换算。画布只认 `{ id, depends_on }`，所以 agent 引用按名字进出，
 * 身份自己的设置（必需 / 阻断 / 读哪些测试）在回写时按名字找回，画布不碰它们。
 */
import type { AgentSummary } from '../api/agentClient'
import type { WbExecutorRef, WbReviewerRef, WbSkillEntry, WbSkillRef } from '../api/governanceTypes'

/** 新评审者的缺省，与 kernel 解析器的缺省逐字一致。 */
export const REVIEWER_DEFAULTS = { required: true, block_at: 'high' } as const

export function agentEntries(agents: readonly AgentSummary[] | null): WbSkillEntry[] | null {
  return agents === null ? null : agents.map((agent) => ({
    name: agent.name,
    installed: true,
    source: agent.source === 'builtin' ? 'builtin' : 'user',
    ...(agent.description === '' ? {} : { description: agent.description }),
  }))
}

export function refsToSkills(refs: readonly { agent: string; depends_on?: string[] }[]): WbSkillRef[] {
  return refs.map((ref) => ({
    id: ref.agent,
    ...(ref.depends_on === undefined ? {} : { depends_on: [...ref.depends_on] }),
  }))
}

export function skillsToExecutors(skills: readonly WbSkillRef[]): WbExecutorRef[] {
  return skills.map((skill) => ({
    agent: skill.id,
    ...(skill.depends_on === undefined ? {} : { depends_on: [...skill.depends_on] }),
  }))
}

export function skillsToReviewers(skills: readonly WbSkillRef[], previous: readonly WbReviewerRef[]): WbReviewerRef[] {
  return skills.map((skill) => {
    const before = previous.find((ref) => ref.agent === skill.id)
    return {
      agent: skill.id,
      required: before?.required ?? REVIEWER_DEFAULTS.required,
      block_at: before?.block_at ?? REVIEWER_DEFAULTS.block_at,
      ...(skill.depends_on === undefined ? {} : { depends_on: [...skill.depends_on] }),
      ...(before?.reads_tests === undefined ? {} : { reads_tests: [...before.reads_tests] }),
    }
  })
}
