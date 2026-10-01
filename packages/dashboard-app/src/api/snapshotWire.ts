/**
 * The list snapshot's wire form → the plain project JSON the strict decoder validates.
 *
 * The server writes the sub-trees many changes share (workflow rules, current-step readiness, stage statuses, user
 * references) once per project in a `shared` table and points at them with an integer (see the server's
 * `snapshotWire.ts`). Expansion puts the same objects back where the integers were, so `decodeChange` validates every
 * change exactly as it validates one of the full snapshot; nothing downstream knows a table existed.
 *
 * Expansion is strict: an integer that does not name an entry, or a table that is not an array, makes the project
 * invalid, which the decoder turns into an invalid snapshot rather than a silently emptier one.
 */
import { isRecord } from './transport'

const SHARED_CHANGE_KEYS = [
  ['workflowRules', 'workflowRules'],
  ['workflowExecution', 'workflowExecution'],
  ['todo', 'todo'],
  ['owner', 'user'],
  ['creator', 'user'],
] as const

function expandChange(change: unknown, tables: Record<string, readonly unknown[]>): unknown | null {
  if (!isRecord(change)) return change
  const expanded: Record<string, unknown> = { ...change }
  for (const [key, table] of SHARED_CHANGE_KEYS) {
    const pointer = change[key]
    if (typeof pointer !== 'number') continue
    const entries = tables[table]
    if (entries === undefined || !Number.isInteger(pointer) || pointer < 0 || pointer >= entries.length) return null
    expanded[key] = entries[pointer]
  }
  return expanded
}

function expandChanges(changes: unknown, tables: Record<string, readonly unknown[]>): unknown[] | undefined | null {
  if (changes === undefined) return undefined
  if (!Array.isArray(changes)) return null
  const out: unknown[] = []
  for (const change of changes) {
    const expanded = expandChange(change, tables)
    if (expanded === null) return null
    out.push(expanded)
  }
  return out
}

/** A project as written on the list wire → the project JSON the decoder validates; `null` when the tables do not add up. */
export function expandWireProject(project: unknown): unknown | null {
  if (!isRecord(project) || project.shared === undefined) return project
  const shared = project.shared
  if (!isRecord(shared)) return null
  const tables: Record<string, readonly unknown[]> = {}
  for (const [name, entries] of Object.entries(shared)) {
    if (!Array.isArray(entries)) return null
    tables[name] = entries
  }
  const changes = expandChanges(project.changes, tables)
  const archived = expandChanges(project.archived, tables)
  if (changes === null || archived === null) return null
  const { shared: _shared, ...rest } = project
  return {
    ...rest,
    ...(changes === undefined ? {} : { changes }),
    ...(archived === undefined ? {} : { archived }),
  }
}
