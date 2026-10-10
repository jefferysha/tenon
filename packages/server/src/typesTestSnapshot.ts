/** 工作台「测试」页签的一项：状态 + 当前用户最近一次运行的摘要。 */
export interface TestItemSnapshot {
  id: string
  label?: string
  direction: string
  required: boolean
  status: 'passed' | 'failed' | 'stale' | 'missing' | 'running'
  /**
   * 失败后计划里有 `test:<id>` 豁免时（`status` 仍是原来的 `failed`）：`waived` = 已经评审批准、放行，
   * `waiver-pending` = 等评审批准（含批准绑定的是另一份代码、或旧批准没有绑定代码）。与 CLI / 门禁同一份判定。
   */
  waiver?: 'waived' | 'waiver-pending'
  run?: {
    runId: string
    user: string
    actor: { id: string; name: string }
    result: 'pass' | 'fail'
    exitCode: number | null
    durationMs: number
    finishedAt: string
    reasons: string[]
  }
}

export interface TestStepSnapshot {
  stepId: string
  items: TestItemSnapshot[]
}
