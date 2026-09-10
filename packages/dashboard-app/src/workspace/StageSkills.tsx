import { useT } from '../i18n'
import { StatusPill, type PillTone } from '../shell/ThreeColumns'
import type { SkillRunsSnapshot, SkillRunStatus } from '../types'

const TONE: Record<SkillRunStatus, PillTone> = {
  idle: 'neutral',
  running: 'running',
  done: 'done',
}

export interface StageSkillsProps {
  runs: SkillRunsSnapshot[number] | undefined
}

/** 所选阶段的技能：一列一个波次（同列并行），每个技能一枚状态标签。无技能或旧服务端无字段 → 不渲染。 */
export function StageSkills({ runs }: StageSkillsProps): JSX.Element | null {
  const { t } = useT()
  if (runs === undefined || runs.skills.length === 0) return null
  const waves = new Map<number, typeof runs.skills[number][]>()
  for (const skill of runs.skills) waves.set(skill.wave, [...(waves.get(skill.wave) ?? []), skill])
  const columns = [...waves.entries()].sort(([a], [b]) => a - b)
  const done = runs.skills.filter((skill) => skill.status === 'done').length
  return (
    <section
      className="mb-6"
      aria-label={t('workspace.skills_label', { done, total: runs.skills.length })}
      data-testid="stage-skills"
    >
      <h2 className="mb-3 text-section font-bold text-text">{t('workspace.skills')}</h2>
      <ol className="flex gap-2 overflow-x-auto pb-1" data-testid="stage-skill-waves">
        {columns.map(([wave, skills]) => (
          <li key={wave} className="flex min-w-0 flex-none flex-col gap-2" data-testid={`stage-skill-wave-${wave}`}>
            {skills.map((skill) => (
              <span
                key={skill.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                data-testid={`stage-skill-${skill.id}`}
                data-status={skill.status}
              >
                <span className="truncate font-mono text-base text-text">{skill.id}</span>
                <StatusPill tone={TONE[skill.status]}>{t(`workspace.skill_${skill.status}`)}</StatusPill>
              </span>
            ))}
          </li>
        ))}
      </ol>
    </section>
  )
}
