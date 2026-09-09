import type { ReactNode } from 'react'
import type { WbSkillEntry } from '../api/client'
import type { HooksConfigState } from './hooksConfig'
import type { BoardLane, LanePatch } from './boardLane'

export interface TimelineSkillMove {
  skillId: string
  fromStage: string
  toStage: string
  refSkillId: string | null
  after: boolean
}

export interface ExecutionTimelineComposerProps {
  workflowName: string
  lanes: BoardLane[]
  selectedId: string | null
  readonly: boolean
  hooks: HooksConfigState
  skillRegistry?: WbSkillEntry[] | null
  selectedSkillZone?: ReactNode
  prompt?: string
  onSelect: (id: string) => void
  onSkillMove?: (move: TimelineSkillMove) => void
  onSkillAdd?: (stageId: string, skillId: string) => void
  onSkillRemove?: (stageId: string, skillId: string) => void
  onPromptChange?: (prompt: string) => void
  onLaneEdit?: (stageId: string, patch: LanePatch) => void
  onLaneGuard?: (stageId: string, enabled: boolean) => void
  onRemoveStage?: (stageId: string) => void
  onAddStage?: () => void
  onStageReorder?: (fromId: string, toId: string, after: boolean) => void
  onOpenAdvanced?: () => void
  onOpenSkillEditor?: () => void
}
