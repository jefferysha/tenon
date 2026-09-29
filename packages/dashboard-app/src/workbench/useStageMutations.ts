import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { isDefaultWorkflowName } from '@tenon/kernel/workflow/identifier'
import type { DocumentKind } from '@tenon/kernel/workflow/document-contract-model'
import type { WbExecutorRef, WbReviewerRef, WbSkillRef, WbStepDef, WbStepTest, WbTransition, WbWorkflowDef } from '../api/governanceTypes'
import { addDocumentOutputInDef, removeDocumentSlotInDef, setDocumentInputsInDef, setOpenspecInDef } from './documentContractEdits'
import {
  addSkillToDef,
  backTransitionOf,
  displacedBackTransitions,
  removeSkillFromDef,
  removeStageFromDef,
  renameStepInDef,
  reorderStagesInDef,
  setGateInDef,
  setStageBackInDef,
  setStepAgentsInDef,
  setStepSkillsInDef,
  setStepTestsInDef,
} from './workbenchDefinition'

export interface StageMutations {
  renameStep: (stepId: string, label: string) => void
  setGate: (stepId: string, gate: WbStepDef['gate']) => void
  setStageBack: (stepId: string, to: string | null) => void
  removeStage: (stepId: string) => void
  reorderStages: (fromId: string, toId: string, after: boolean) => void
  setSkills: (stepId: string, skills: readonly WbSkillRef[]) => void
  setAgents: (stepId: string, patch: { executors?: readonly WbExecutorRef[]; reviewers?: readonly WbReviewerRef[] }) => void
  setTests: (stepId: string, tests: readonly WbStepTest[]) => void
  addSkill: (stepId: string, skillId: string) => void
  removeSkill: (stepId: string, skillId: string) => void
  setOpenspec: (on: boolean) => void
  addDocumentOutput: (stepId: string, kind: DocumentKind) => void
  removeDocumentSlot: (stepId: string, kind: string, direction: 'inputs' | 'outputs') => void
  setDocumentInputs: (stepId: string, kinds: readonly string[]) => void
}

/**
 * 草稿上的阶段编辑。`mutate` 作用于所选分支视图；`setFullDef` 作用于完整定义（OpenSpec 开关是工作流级）。
 * 退回边的「记忆」也在这里：「不退回」、排序、删阶段摘掉的边记住，重新选退回目标时整条装回。
 */
export function useStageMutations(input: {
  mutate: (update: (previous: WbWorkflowDef) => WbWorkflowDef) => void
  setFullDef: Dispatch<SetStateAction<WbWorkflowDef | null>>
  def: WbWorkflowDef | null
  stageId: string | null
  setStageId: Dispatch<SetStateAction<string | null>>
  branch: string
}): StageMutations {
  const { mutate, setFullDef, def, stageId, setStageId } = input
  const renameStep = useCallback((stepId: string, label: string) => mutate((previous) => renameStepInDef(previous, stepId, label)), [mutate])
  const setGate = useCallback((stepId: string, gate: WbStepDef['gate']) => mutate((previous) => setGateInDef(previous, stepId, gate)), [mutate])
  /**
   * 「不退回」摘掉的那条边先记住，重新选目标时整条装回来（只换 to）。否则来回切一次就把
   * `verify-fail` 降级成 `verify-back` 并丢掉它的 actions——事件名和 actions 都是有运行时语义的。
   * 键带上工作流与轨道，切换后不会串味；重新载入定义时清空。
   */
  const removedBack = useRef<Map<string, WbTransition>>(new Map())
  const branchIdentity = useRef(input.branch)
  branchIdentity.current = input.branch
  const setStageBack = useCallback((stepId: string, to: string | null) => mutate((previous) => {
    const key = `${previous.name}:${branchIdentity.current}:${stepId}`
    if (to === null) {
      const current = backTransitionOf(previous, stepId)
      if (current !== null) removedBack.current.set(key, current)
      return setStageBackInDef(previous, stepId, null)
    }
    const remembered = removedBack.current.get(key)
    removedBack.current.delete(key)
    return setStageBackInDef(previous, stepId, to, remembered)
  }), [mutate])
  // 排序 / 删阶段丢掉的退回边进同一份记忆，重新选退回目标时整条装回。
  const rememberDisplaced = useCallback((previous: WbWorkflowDef, next: WbWorkflowDef): WbWorkflowDef => {
    for (const [stepId, transition] of displacedBackTransitions(previous, next)) {
      removedBack.current.set(`${previous.name}:${branchIdentity.current}:${stepId}`, transition)
    }
    return next
  }, [])
  const removeStage = useCallback((stepId: string): void => {
    mutate((previous) => {
      removedBack.current.delete(`${previous.name}:${branchIdentity.current}:${stepId}`)
      return rememberDisplaced(previous, removeStageFromDef(previous, stepId))
    })
    setStageId((current) => current === stageId ? (def?.steps.filter((step) => step.id !== stepId)[0]?.id ?? null) : current)
  }, [mutate, rememberDisplaced, def, stageId, setStageId])
  const reorderStages = useCallback((fromId: string, toId: string, after: boolean) => mutate((previous) => (
    rememberDisplaced(previous, reorderStagesInDef(previous, fromId, toId, after))
  )), [mutate, rememberDisplaced])
  const setSkills = useCallback((stepId: string, skills: readonly WbSkillRef[]) => mutate((previous) => setStepSkillsInDef(previous, stepId, skills)), [mutate])
  const setAgents = useCallback((stepId: string, patch: { executors?: readonly WbExecutorRef[]; reviewers?: readonly WbReviewerRef[] }) => mutate((previous) => setStepAgentsInDef(previous, stepId, patch)), [mutate])
  const setTests = useCallback((stepId: string, tests: readonly WbStepTest[]) => mutate((previous) => setStepTestsInDef(previous, stepId, tests)), [mutate])
  const addSkill = useCallback((stepId: string, skillId: string) => mutate((previous) => addSkillToDef(previous, stepId, skillId)), [mutate])
  const removeSkill = useCallback((stepId: string, skillId: string) => mutate((previous) => removeSkillFromDef(previous, stepId, skillId)), [mutate])
  const setOpenspec = useCallback((on: boolean): void => {
    setFullDef((previous) => previous === null || (!on && isDefaultWorkflowName(previous.name)) ? previous : setOpenspecInDef(previous, on))
  }, [setFullDef])
  const addDocumentOutput = useCallback((stepId: string, kind: DocumentKind) => mutate((previous) => addDocumentOutputInDef(previous, stepId, kind)), [mutate])
  const removeDocumentSlot = useCallback((stepId: string, kind: string, direction: 'inputs' | 'outputs') => mutate((previous) => removeDocumentSlotInDef(previous, stepId, kind, direction)), [mutate])
  const setDocumentInputs = useCallback((stepId: string, kinds: readonly string[]) => mutate((previous) => setDocumentInputsInDef(previous, stepId, kinds)), [mutate])
  return {
    renameStep, setGate, setStageBack, removeStage, reorderStages, setSkills, setAgents, setTests, addSkill, removeSkill,
    setOpenspec, addDocumentOutput, removeDocumentSlot, setDocumentInputs,
  }
}
