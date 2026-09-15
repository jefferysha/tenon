/**
 * Owner transfer use case shared by `tenon owner` and `POST /api/change/:name/owner`. Take over (`to` omitted) is open
 * to anyone; hand-over (`to` present) is owner-only. The owner change and its decision happen under the Change lock;
 * the history row is appended afterwards as a best-effort projection.
 */
import type { HistoryWriter, StateStore } from '../types.js'
import { ownerDecision, ownerOf } from './owner.js'
import { formatUserRef, userSlug, type RecordActor, type UserRef } from './user.js'

export type OwnerTransferResult =
  | { readonly kind: 'changed'; readonly from: UserRef | null; readonly to: UserRef; readonly historyError?: unknown }
  | { readonly kind: 'unchanged'; readonly to: UserRef }
  | { readonly kind: 'owner-required'; readonly owner: UserRef | null }

export async function transferOwner(
  deps: { readonly store: StateStore; readonly history?: HistoryWriter; readonly clock: () => string },
  input: { readonly changeDir: string; readonly change: string; readonly actor: RecordActor; readonly to?: RecordActor },
): Promise<OwnerTransferResult> {
  const target = input.to ?? input.actor
  const to: UserRef = { id: target.id, name: target.name, slug: userSlug(target.id) }
  const outcome = await deps.store.withLock(input.changeDir, async () => {
    const state = await deps.store.read(input.changeDir)
    const from = ownerOf(state.fields)
    if (input.to !== undefined) {
      const decision = ownerDecision(state.fields, input.actor)
      if (!decision.allowed) return { kind: 'owner-required', owner: decision.owner } as const
    }
    if (from !== null && from.slug === to.slug) return { kind: 'unchanged', to } as const
    const previous = state.fields.assignee
    const ref = formatUserRef(target)
    await deps.store.writeUnderLock(input.changeDir, { ...state, fields: { ...state.fields, assignee: ref } }, { kind: 'set' })
    return { kind: 'changed', from, to, previous: Array.isArray(previous) ? previous.join(',') : previous, ref } as const
  })
  if (outcome.kind !== 'changed') return outcome
  try {
    await deps.history?.append(input.changeDir, {
      ts: deps.clock(), kind: 'set', field: 'assignee', from: outcome.previous, to: outcome.ref, actor: input.actor,
    })
  } catch (historyError) {
    return { kind: 'changed', from: outcome.from, to, historyError }
  }
  return { kind: 'changed', from: outcome.from, to }
}
