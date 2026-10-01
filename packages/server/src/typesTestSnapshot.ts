/** 工作台「测试」页签的一项：状态 + 当前用户最近一次运行的摘要。 */
export interface TestItemSnapshot {
  id: string
  label?: string
  direction: string
  required: boolean
  status: 'passed' | 'failed' | 'stale' | 'missing' | 'running'
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
