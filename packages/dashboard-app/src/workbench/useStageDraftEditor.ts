import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { slugifyStageName } from './workbenchApiDecoders'
import type { WbStepDef, WbWorkflowDef } from './workbenchDefinition'

interface StageDraftInput {
  def: WbWorkflowDef | null
  stageId: string | null
  setDef: Dispatch<SetStateAction<WbWorkflowDef | null>>
  setStageId: Dispatch<SetStateAction<string | null>>
}

interface StageDraftController {
  addStageOpen: boolean
  setAddStageOpen: Dispatch<SetStateAction<boolean>>
  stageDraftName: string
  setStageDraftName: Dispatch<SetStateAction<string>>
  addStageNameRef: RefObject<HTMLInputElement>
  canSubmitStage: boolean
  closeAddStage: () => void
  confirmAddStage: () => void
  draftDirty: boolean
}

/**
 * 阶段 id 由名称自动生成：ASCII slug（小写、非 [a-z0-9_-] 折成 -），slug 为空（纯中文等）时用 `stage`；
 * 与已有 id 重名就依次加 -2、-3……直到唯一。
 */
export function autoStageId(name: string, existing: readonly string[]): string {
  const base = slugifyStageName(name) || 'stage'
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/** 添加阶段只填名称；id 在确认时由 autoStageId 生成，新阶段插在所选阶段之后并接上流程。 */
export function useStageDraftEditor(input: StageDraftInput): StageDraftController {
  const [addStageOpen, setAddStageOpen] = useState(false)
  const [stageDraftName, setStageDraftName] = useState('')
  const addStageNameRef = useRef<HTMLInputElement>(null)
  const canSubmitStage = stageDraftName.trim().length > 0

  function closeAddStage(): void {
    setAddStageOpen(false)
    setStageDraftName('')
  }

  function confirmAddStage(): void {
    if (!canSubmitStage || !input.def) return
    const label = stageDraftName.trim()
    const id = autoStageId(label, input.def.steps.map((step) => step.id))
    input.setDef((current) => {
      if (!current || current.steps.some((step) => step.id === id)) return current
      const selectedIndex = input.stageId ? current.steps.findIndex((step) => step.id === input.stageId) : -1
      const insertIndex = selectedIndex >= 0 ? selectedIndex + 1 : current.steps.length
      const previous = insertIndex > 0 ? current.steps[insertIndex - 1] : undefined
      const next = current.steps[insertIndex]
      let transitions: WbStepDef['transitions'] = []
      let steps = current.steps
      if (previous && next) {
        const transitionIndex = previous.transitions.findIndex((transition) => transition.to === next.id)
        if (transitionIndex >= 0) {
          transitions = [{ event: `${id}-complete`, to: next.id }]
          steps = current.steps.map((step, index) => index === insertIndex - 1
            ? { ...step, transitions: step.transitions.map((transition, position) => position === transitionIndex ? { ...transition, to: id } : transition) }
            : step)
        }
      } else if (previous) {
        steps = current.steps.map((step, index) => index === insertIndex - 1
          ? { ...step, transitions: [...step.transitions, { event: `${step.id}-complete`, to: id }] }
          : step)
      }
      const nextSteps = [...steps]
      nextSteps.splice(insertIndex, 0, {
        id, label, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions,
      })
      return { ...current, steps: nextSteps }
    })
    input.setStageId(id)
    closeAddStage()
  }

  return {
    addStageOpen, setAddStageOpen, stageDraftName, setStageDraftName, addStageNameRef, canSubmitStage,
    closeAddStage, confirmAddStage,
    draftDirty: addStageOpen && stageDraftName !== '',
  }
}
