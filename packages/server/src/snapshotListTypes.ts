/**
 * The list tier of the snapshot: rows without the per-change evidence. A full `Snapshot` / `ProjectSnapshot` /
 * `ChangeSnapshot` is assignable to its list counterpart, so code that only reads rows accepts both.
 */
import type { ArchivedChangeSnapshot, ChangeSnapshot, ProjectSnapshot, Snapshot, WorkflowRulesSnapshot } from './types.js'

/** The plan-derived rules a list row needs; the `policy` block is detail-tier data. */
export type ListWorkflowRulesSnapshot = Omit<WorkflowRulesSnapshot, 'policy'>

/**
 * The list tier of a change: everything a row, the progress board and the inbox render, without the
 * per-change evidence (documents, skill / agent runs, tests, test policy) that only the open task reads
 * through `GET /api/change/:name/snapshot`. `rev` identifies the inputs the detail was built from; a list
 * row whose `rev` moved on tells the reader its detail is stale.
 */
export type ChangeListSnapshot = Omit<
  ChangeSnapshot,
  'workflowRules' | 'documents' | 'skillRuns' | 'agentRuns' | 'tests' | 'testPolicy' | 'testPlan' | 'testUser' | 'testDiagnostics'
> & { workflowRules: ListWorkflowRulesSnapshot }

export type ArchivedChangeListSnapshot = ChangeListSnapshot & { archive: ArchivedChangeSnapshot['archive'] }

/** One project in the list tier. A full `ProjectSnapshot` is assignable to it. */
export interface ProjectListSnapshot extends Omit<ProjectSnapshot, 'changes' | 'archived' | 'workflowRules'> {
  changes: ChangeListSnapshot[]
  archived?: ArchivedChangeListSnapshot[]
}

/** The list-tier aggregate: what the Dashboard loads first. A full `Snapshot` is assignable to it. */
export interface ListSnapshot extends Omit<Snapshot, 'projects'> {
  /** Marks the tier on the wire; a full snapshot carries no view. */
  view?: 'list'
  projects: ProjectListSnapshot[]
}
