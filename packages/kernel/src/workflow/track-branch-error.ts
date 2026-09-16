export class WorkflowTrackBranchError extends Error {
  constructor(workflow: string, track: string) {
    super(`工作流 '${workflow}' 没有轨道 '${track}' 的分支`)
    this.name = 'WorkflowTrackBranchError'
  }
}
