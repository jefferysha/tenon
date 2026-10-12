import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HISTORY_FILE,
  aliasesForSkill,
  dependencyWaves,
  type EffectiveWorkflowPlan,
} from '@tenon/kernel'
import type { SkillRunStatus, SkillRunsSnapshot } from './types.js'

interface HistoryLine {
  readonly kind: string
  readonly raw: string
  readonly to: string
  readonly field: string
}

async function readHistoryLines(changeDir: string): Promise<HistoryLine[]> {
  let text: string
  try {
    text = await readFile(join(changeDir, HISTORY_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const lines: HistoryLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const value = parsed as Record<string, unknown>
      if (typeof value.kind !== 'string') continue
      lines.push({
        kind: value.kind,
        raw: typeof value.raw === 'string' ? value.raw : '',
        to: typeof value.to === 'string' ? value.to : '',
        field: typeof value.field === 'string' ? value.field : '',
      })
    } catch {
      // 单行损坏只丢该行；文件级读失败仍向上抛。
    }
  }
  return lines
}

/** 只看进入当前阶段之后的记录：最后一条 phase → 当前阶段 的 transition 之后。 */
function sinceCurrentStep(lines: readonly HistoryLine[], phase: string): readonly HistoryLine[] {
  let start = 0
  lines.forEach((line, index) => {
    if (line.kind === 'transition' && line.to === phase && (line.field === '' || line.field === 'phase')) start = index + 1
  })
  return lines.slice(start)
}

/**
 * `Skill: <token>` 里的技能标识：原样一份（`opsx:propose` 这类带冒号的别名 id），
 * 再加最后一个冒号后的短名一份（`superpowers:brainstorming` → `brainstorming`）。
 */
function skillNamesOf(raw: string): readonly string[] {
  const match = /Skill:\s*([^\s|]+)/u.exec(raw)
  if (match === null) return []
  const token = match[1] ?? ''
  return [...new Set([token, token.slice(token.lastIndexOf(':') + 1)])]
}

/** manifest 的 `a|b` 备选记法 + 技能别名（opsx:propose ≡ openspec-propose）：任一有证据即算该槽位。 */
function alternativesOf(token: string): readonly string[] {
  return token.split('|').map((part) => part.trim()).filter((part) => part !== '').flatMap((part) => [part, ...aliasesForSkill(part)])
}

/**
 * 每步技能的执行态投影：步序早于当前 → done；晚于当前 → idle；当前步按 history 判定
 * （tool = 完成证据 → done；只有 tool-start → running；无记录 → idle）。wave 由 depends_on 拓扑深度得出。
 * 技能就是计划里每步声明的技能（计划已按任务的轨道选了分支），不叠加 manifest 矩阵。
 */
export async function projectSkillRuns(
  changeDir: string,
  plan: EffectiveWorkflowPlan,
  phase: string,
): Promise<SkillRunsSnapshot> {
  const capability = plan.capabilities.skills
  const stepIds = plan.workflow.steps.map((step) => step.id)
  const currentIndex = stepIds.indexOf(phase)
  const window = currentIndex < 0 ? [] : sinceCurrentStep(await readHistoryLines(changeDir), phase)
  const started = new Set<string>()
  const finished = new Set<string>()
  for (const line of window) {
    for (const name of skillNamesOf(line.raw)) {
      if (line.kind === 'tool') finished.add(name)
      else if (line.kind === 'tool-start') started.add(name)
    }
  }
  const any = (set: ReadonlySet<string>, token: string): boolean => alternativesOf(token).some((id) => set.has(id))
  return stepIds.map((stepId, index) => {
    const step = capability.steps.find((candidate) => candidate.stepId === stepId)
    const dependsOn = new Map((step?.declared ?? []).map((skill) => [skill.id, skill.dependsOn]))
    const ids = [...new Set(step?.requiredSkillIds ?? [])]
    // 波次只有 kernel 的 dependencyWaves 一个算法（编排、技能门、画布都用它）；前置指向图外的名字不计。
    const waves = dependencyWaves(ids.map((id) => ({ id, dependsOn: dependsOn.get(id) ?? [] })))
    const skills = ids.map((id) => {
      let status: SkillRunStatus
      if (index < currentIndex) status = 'done'
      else if (index > currentIndex) status = 'idle'
      else status = any(finished, id) ? 'done' : any(started, id) ? 'running' : 'idle'
      return { id, status, wave: waves.get(id) ?? 0 }
    })
    return { stepId, skills }
  })
}
