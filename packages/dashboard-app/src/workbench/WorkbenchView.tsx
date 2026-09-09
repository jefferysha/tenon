/**
 * 工作流定义的领域导出（helpers 与类型）。编辑状态机住在 useWorkflowEditor，三列视图住在
 * workflow/WorkflowView；本文件不再渲染任何界面，只保留既有 import 路径（StepEditor /
 * skillChainModel / 测试夹具）继续可用。
 */
export {
  addSkillToDef,
  moveSkillInDef,
  removeSkillFromDef,
  removeStageFromDef,
  reorderStagesInDef,
  setLaneGuardInDef,
  setSkillDepInDef,
  stageCounts,
} from './workbenchDefinition'
export type {
  SkillMove,
  StageAmbient,
  WbActionConfig,
  WbArtifactConfig,
  WbDocumentContract,
  WbFieldRef,
  WbGuardConfig,
  WbSkillRef,
  WbStepDef,
  WbTrackPredicate,
  WbTransition,
  WbWorkflowDef,
} from './workbenchDefinition'
