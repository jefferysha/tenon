/**
 * 迁移就绪（readiness）的快照形状——逐字镜像 server 的 readinessByTransition。
 * 从 types.ts 拆出：阻断种类随 kernel 的判定增长（宿主不符、测试完整性……），不该把共享类型文件撑过长度上限。
 */

export interface TransitionReadinessSnapshot {
  ready: boolean
  blockers: TransitionReadinessBlockerSnapshot[]
}

export type TransitionReadinessBlockerSnapshot =
  | {
      kind: 'verify-build-revision-untrusted'
      code: 'verify-build-revision-untrusted'
      reason:
        | 'missing' | 'null' | 'ambiguous' | 'malformed' | 'isolation-mismatch'
        | 'capability-unavailable' | 'provenance-missing' | 'provenance-mismatch'
        | 'state-stale' | 'revision-stale' | 'project-mismatch' | 'worktree-mismatch'
        | 'evaluation-error'
      remediation: 'return-to-build-and-capture-current-revision'
      stateHash?: string
      revisionHash?: string
    }
  | {
      kind: 'guard-failed'
      guardType: string
      field?: string
      actual?: string
      expected?: string[]
    }
  | {
      kind: 'capability-unavailable'
      guardType: string
      capability: string
    }
  | {
      kind: 'evaluation-error'
      guardType: string
      capability?: string
    }
  | {
      kind: 'agents-incomplete'
      agents: { agent: string; reason: string }[]
    }
  | {
      /** `tenon status` exits 里出边 guard 之外的阻断；message 与 CLI 同一份文案。 */
      kind: 'step-exit'
      source: StepExitBlockerSource
      code: string
      message: string
      items?: string[]
      /** 服务端的结构化描述（对象 / 状态 / 未勾项数）：展示按 code + 这三项分类，不解析 message；缺席 = 展示整句。 */
      subject?: string
      state?: string
      count?: number
    }

export type StepExitBlockerSource = 'guard' | 'document' | 'skill' | 'test' | 'reviewer' | 'revision' | 'spec' | 'tasks'
