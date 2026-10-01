/**
 * The wire form of the list snapshot (`GET /api/snapshot?view=list`, `GET /api/stream?view=list`).
 *
 * A project is serialized on its own, so a rebuilt project replaces exactly its own bytes and an SSE delta is just the
 * projects whose bytes changed. Inside a project, sub-trees that many changes share are written once in a `shared`
 * table and a change points at its entry with an integer:
 *
 *   workflowRules      every change on one frozen plan carries the same rules
 *   workflowExecution  the readiness blockers of the current step, identical for changes stuck on the same thing
 *   stage statuses    the `todo` stages, identical for changes in the same phase of the same plan
 *   user               the owner / creator references, a handful of people per project
 *
 * The client expands the integers back into the same objects before it validates anything (see the dashboard's
 * `snapshotWire.ts`), so nothing downstream of the decoder knows the table exists. `fields` is narrowed to the keys a
 * list row reads; the full field set is detail-tier data.
 */
import type { ArchivedChangeListSnapshot, ChangeListSnapshot, ProjectListSnapshot } from './snapshotListTypes.js'

/** The `.pipeline.yaml` fields a list row, the progress board and the inbox read. */
export const LIST_FIELD_KEYS = ['workflow', 'automation'] as const

export type WireTableName = 'workflowRules' | 'workflowExecution' | 'todo' | 'user'

class InternTable {
  private readonly index = new Map<unknown, number>()
  readonly entries: unknown[] = []

  /** Identity keys (objects the scan already shares) or JSON strings (equal values built separately). */
  intern(key: unknown, value: unknown): number {
    const known = this.index.get(key)
    if (known !== undefined) return known
    const next = this.entries.length
    this.index.set(key, next)
    this.entries.push(value)
    return next
  }
}

function listFields(fields: ChangeListSnapshot['fields']): Record<string, string | string[]> {
  const picked: Record<string, string | string[]> = {}
  for (const key of LIST_FIELD_KEYS) {
    const value = fields[key]
    if (value !== undefined) picked[key] = value
  }
  return picked
}

/** Serialize one project of the list tier. `revs` stamps each change with the identity of the inputs it was read from. */
export function encodeListProject(project: ProjectListSnapshot, revs: ReadonlyMap<string, string>): string {
  const tables: Record<WireTableName, InternTable> = {
    workflowRules: new InternTable(), workflowExecution: new InternTable(), todo: new InternTable(), user: new InternTable(),
  }
  const user = (ref: ChangeListSnapshot['owner']): number | null =>
    ref === null ? null : tables.user.intern(`${ref.id}\u0000${ref.name}\u0000${ref.slug}`, ref)
  const wire = (change: ChangeListSnapshot): Record<string, unknown> => {
    const { workflowRules, workflowExecution, todo, owner, creator, fields, ...rest } = change
    const rev = revs.get(change.name)
    return {
      ...rest,
      fields: listFields(fields),
      ...(rev === undefined ? {} : { rev }),
      owner: user(owner),
      creator: user(creator),
      workflowRules: tables.workflowRules.intern(workflowRules, workflowRules),
      workflowExecution: tables.workflowExecution.intern(JSON.stringify(workflowExecution), workflowExecution),
      ...(todo === undefined ? {} : { todo: tables.todo.intern(JSON.stringify(todo), todo) }),
    }
  }
  const { changes, archived, ...envelope } = project
  const wiredChanges = changes.map(wire)
  const wiredArchived = archived?.map((entry: ArchivedChangeListSnapshot) => wire(entry))
  return JSON.stringify({
    ...envelope,
    changes: wiredChanges,
    ...(wiredArchived === undefined ? {} : { archived: wiredArchived }),
    shared: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, table.entries])),
  })
}
