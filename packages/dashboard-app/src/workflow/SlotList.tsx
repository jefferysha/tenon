import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, FileText, Hash, Lock } from 'lucide-react'
import type { WbIoSlot, WbSkillEntry } from '../api/governanceTypes'
import { useT } from '../i18n'
import { slotLabel } from '../workspace/taskModel'
import { SkillSourceIcon } from './SkillSourceIcon'

/** 一个槽位的展示行：槽位本体 + 产出它的技能 + 关联阶段（输出：读取它的阶段；输入：产出它的阶段）+ YAML 位置。 */
export interface SlotRow {
  slot: WbIoSlot
  skills: readonly string[]
  stages: readonly string[]
  path: string
}

function SlotIcon({ slot }: { slot: WbIoSlot }): JSX.Element {
  const Icon = slot.kind === 'field' && slot.type !== 'file_path' ? Hash : FileText
  return <Icon className="size-4 flex-none text-text-3" aria-hidden="true" />
}

/** 只读槽位清单：来源全是推导出来的，这里不提供增删。 */
export function SlotList({ rows, direction, registry, empty }: {
  rows: readonly SlotRow[]
  direction: 'outputs' | 'inputs'
  registry: readonly WbSkillEntry[] | null
  empty: ReactNode
}): JSX.Element {
  const { t } = useT()
  if (rows.length === 0) return <>{empty}</>
  const StageArrow = direction === 'outputs' ? ArrowRight : ArrowLeft
  return (
    <ul className="grid gap-2" data-testid={`slot-list-${direction}`}>
      {rows.map(({ slot, skills, stages, path }) => {
        const key = `${slot.kind}:${slot.id}`
        const locked = slot.kind === 'document' && slot.locked
        return (
          <li key={key} className="grid gap-3 rounded-md border border-border bg-card px-4 py-3.5" title={path} data-testid={`slot-${slot.kind}-${slot.id}`} data-locked={locked}>
            <div className="flex items-center gap-2.5">
              <SlotIcon slot={slot} />
              <span className="min-w-0 flex-1 truncate text-base font-semibold text-text">{slotLabel(slot, t)}</span>
              {locked && <Lock className="size-3.5 flex-none text-text-3" aria-label={t('workflow.locked')} data-testid={`slot-lock-${slot.id}`} />}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <span className="flex flex-wrap items-center gap-1" aria-label={t('workflow.from')} data-testid={`slot-skills-${slot.id}`}>
                {skills.length === 0
                  ? <span className="text-caption text-text-3">—</span>
                  : skills.map((skill) => {
                    const entry = registry?.find((candidate) => candidate.name === skill)
                    return (
                      <span key={skill} className="inline-flex items-center gap-1 rounded-sm border border-border bg-bg px-1.5 py-0.5 font-mono text-caption text-text-2">
                        {entry !== undefined && <SkillSourceIcon source={entry.source} className="size-3" />}
                        {skill}
                      </span>
                    )
                  })}
              </span>
              {stages.length > 0 && (
                <span className="flex flex-wrap items-center gap-1" aria-label={direction === 'outputs' ? t('workflow.read_by') : t('workflow.from')} data-testid={`slot-stages-${slot.id}`}>
                  <StageArrow className="size-3.5 text-text-3" aria-hidden="true" />
                  {stages.map((stage) => <span key={stage} className="rounded-full bg-fill px-2 py-0.5 text-caption text-text-2">{stage}</span>)}
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
