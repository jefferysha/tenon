import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUILTIN_TRACK_IDS,
  HISTORY_FILE,
  builtinTrack,
  isBuiltinTrackId,
  loadTrackRegistry,
  skillAppliesToTrack,
  skillsFor,
  type EffectiveWorkflowPlan,
  type Phase,
  type SkillTable,
  type TrackDefinition,
} from '@tenon/kernel'
import type { SkillRunStatus, SkillRunsSnapshot } from './types.js'

interface HistoryLine {
  readonly kind: string
  readonly raw: string
  readonly to: string
  readonly field: string
}

const BUILTIN_SKILL_PROFILES: ReadonlySet<string> = new Set(
  BUILTIN_TRACK_IDS.map((id) => builtinTrack(id).policyProfile.skills.profile).filter((profile) => profile !== '_all'),
)

/**
 * change 所属轨道的定义：内建直接查表；项目额外轨道读 registry（校验失败 / 未知 → undefined，
 * 投影退化为只显示无条件技能，绝不让 snapshot 因轨道配置问题整体失败）。
 */
export function resolveSnapshotTrack(root: string, trackId: string): TrackDefinition | undefined {
  if (trackId === '') return undefined
  if (isBuiltinTrackId(trackId)) return builtinTrack(trackId)
  try {
    return loadTrackRegistry(root, { workflowExists: () => true, skillProfiles: BUILTIN_SKILL_PROFILES }).byId.get(trackId)
  } catch {
    return undefined
  }
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
      const value = JSON.parse(line) as Record<string, unknown>
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

function waveOf(id: string, dependsOn: ReadonlyMap<string, readonly string[]>, seen: Set<string> = new Set()): number {
  const deps = dependsOn.get(id) ?? []
  if (deps.length === 0 || seen.has(id)) return 0
  seen.add(id)
  return 1 + Math.max(...deps.map((dependency) => waveOf(dependency, dependsOn, seen)))
}

/** 轨道叠加层：定义内嵌矩阵（YAML `when`）按轨道求值；老快照未内嵌时退回机器级 manifest mandatory 表（同 resolver 口径）。 */
function overlaySkills(
  capability: EffectiveWorkflowPlan['capabilities']['skills'],
  stepId: string,
  track: TrackDefinition | undefined,
  mandatorySkills: SkillTable | undefined,
): readonly string[] {
  const step = capability.steps.find((candidate) => candidate.stepId === stepId)
  if (capability.matrixEmbedded) {
    if (track === undefined) return []
    return (step?.conditional ?? []).filter((skill) => skillAppliesToTrack(skill, track)).map((skill) => skill.id)
  }
  if (capability.source !== 'manifest-overlay' || mandatorySkills === undefined) return []
  return skillsFor(mandatorySkills, stepId as Phase, track?.policyProfile.skills.profile ?? '_all')
}

/** manifest 的 `a|b` 备选记法：任一备选有证据即算该槽位。 */
function alternativesOf(token: string): readonly string[] {
  return token.split('|').map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * 每步技能的执行态投影：步序早于当前 → done；晚于当前 → idle；当前步按 history 判定
 * （tool = 完成证据 → done；只有 tool-start → running；无记录 → idle）。wave 由 depends_on 拓扑深度得出。
 * 矩阵技能按 change 的轨道过滤；无轨道定义时只列无条件技能。
 */
export async function projectSkillRuns(
  changeDir: string,
  plan: EffectiveWorkflowPlan,
  phase: string,
  track: TrackDefinition | undefined,
  mandatorySkills?: SkillTable,
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
    const ids = [...new Set([...(step?.requiredSkillIds ?? []), ...overlaySkills(capability, stepId, track, mandatorySkills)])]
    const skills = ids.map((id) => {
      let status: SkillRunStatus
      if (index < currentIndex) status = 'done'
      else if (index > currentIndex) status = 'idle'
      else status = any(finished, id) ? 'done' : any(started, id) ? 'running' : 'idle'
      return { id, status, wave: waveOf(id, dependsOn) }
    })
    return { stepId, skills }
  })
}
