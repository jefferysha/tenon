/**
 * Creator, owner and the owner rule (pure). Both live in the existing `created_by` / `assignee` fields as user refs;
 * legacy values (`unknown`, `null`, a bare name) project as `null` and an unowned task must be taken over first.
 * The rule prevents mistakes between declared identities; it is not an authorization boundary.
 */
import type { FieldName } from '../types.js'
import { formatUserRef, parseUserRef, userSlug, type RecordActor, type UserRef } from './user.js'

type ChangeFields = Readonly<Record<FieldName, string | string[]>>

export type OwnerDecision = { readonly allowed: true } | { readonly allowed: false; readonly owner: UserRef | null }

export function ownerOf(fields: ChangeFields): UserRef | null {
  return parseUserRef(fields.assignee)
}

export function creatorOf(fields: ChangeFields): UserRef | null {
  return parseUserRef(fields.created_by)
}

/** Owners compare by slug, the same key the per-user directories use. */
export function ownerDecision(fields: ChangeFields, actor: RecordActor): OwnerDecision {
  const owner = ownerOf(fields)
  return owner !== null && owner.slug === userSlug(actor.id) ? { allowed: true } : { allowed: false, owner }
}

export function ownerRequiredMessage(change: string, owner: UserRef | null): string {
  return owner === null
    ? `任务 ${change} 没有负责人；先接手：tenon owner take ${change}`
    : `任务 ${change} 的负责人是 ${formatUserRef(owner)}；先接手：tenon owner take ${change}`
}

export class OwnerRequiredError extends Error {
  readonly code = 'owner-required' as const

  constructor(readonly change: string, readonly owner: UserRef | null) {
    super(ownerRequiredMessage(change, owner))
    this.name = 'OwnerRequiredError'
  }
}

export function assertOwner(change: string, fields: ChangeFields, actor: RecordActor): void {
  const decision = ownerDecision(fields, actor)
  if (!decision.allowed) throw new OwnerRequiredError(change, decision.owner)
}
