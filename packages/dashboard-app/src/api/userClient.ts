/** Declared identity and 接手. The server resolves identity; the Dashboard only reads and posts it. */
import type { UserRefView } from '../types'
import { ApiError, getToken, isRecord, readJson, throwDetailedApiError, wrapNetwork } from './transport'

export type UserSource = 'env' | 'config' | 'git'

export interface CurrentUser extends UserRefView {
  source: UserSource
}

export type CurrentUserState = { kind: 'set'; user: CurrentUser } | { kind: 'missing'; invalid?: UserSource }

function isSource(value: unknown): value is UserSource {
  return value === 'env' || value === 'config' || value === 'git'
}

export function decodeUserRef(value: unknown): UserRefView | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.slug !== 'string') return null
  return { id: value.id, name: value.name, slug: value.slug }
}

export function decodeCurrentUser(body: unknown): CurrentUserState | null {
  if (!isRecord(body) || body.ok !== true) return null
  if (body.user === null) {
    if (body.invalid === undefined) return { kind: 'missing' }
    return isSource(body.invalid) ? { kind: 'missing', invalid: body.invalid } : null
  }
  const ref = decodeUserRef(body.user)
  const source = isRecord(body.user) ? body.user.source : undefined
  return ref === null || !isSource(source) ? null : { kind: 'set', user: { ...ref, source } }
}

async function readUser(response: Response, fallback: string): Promise<CurrentUserState> {
  if (!response.ok) await throwDetailedApiError(response, fallback)
  const state = decodeCurrentUser(await readJson(response))
  if (state === null) throw new ApiError('user response is invalid')
  return state
}

function writeHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }
}

export async function fetchCurrentUser(root: string, signal?: AbortSignal): Promise<CurrentUserState> {
  let response: Response
  try {
    // The aggregate view asks for the machine user without a root, so it never looks like a per-root request.
    const url = root === '' ? '/api/user' : `/api/user?root=${encodeURIComponent(root)}`
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  } catch (error) {
    wrapNetwork(error)
  }
  return readUser(response, '用户获取失败')
}

export async function saveUser(input: { id: string; name: string }): Promise<CurrentUserState> {
  let response: Response
  try {
    response = await fetch('/api/user', { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ id: input.id, name: input.name }) })
  } catch (error) {
    wrapNetwork(error)
  }
  return readUser(response, '用户保存失败')
}

export async function takeOwner(root: string, change: string): Promise<{ owner: UserRefView; changed: boolean }> {
  let response: Response
  try {
    response = await fetch(`/api/change/${encodeURIComponent(change)}/owner`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ root }) })
  } catch (error) {
    wrapNetwork(error)
  }
  if (!response.ok) await throwDetailedApiError(response, '接手失败')
  const body = await readJson(response)
  const owner = isRecord(body) ? decodeUserRef(body.owner) : null
  if (!isRecord(body) || body.ok !== true || owner === null || typeof body.changed !== 'boolean') {
    throw new ApiError('owner response is invalid')
  }
  return { owner, changed: body.changed }
}
