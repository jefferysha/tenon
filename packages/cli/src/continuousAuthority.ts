/**
 * Change-bound continuous-execution authority projection.
 *
 * The projection is written only after a user explicitly delegates continued execution for an
 * exact Change.  It is policy metadata rather than a privilege boundary (the workspace belongs to
 * the user), but strict parsing keeps an incomplete, stale, or cross-Change file fail-closed.
 */
import { lstat, readFile } from 'node:fs/promises'
import { readActiveChange, userProjectPaths } from '@tenon/kernel'

export const INTERACTION_AUTHORITY_PROTOCOL = 'pipeline-interaction-authority-v2'

export type ContinuousReviewMode = 'required' | 'delegated'

export interface ContinuousAuthority {
  readonly changeName: string
  readonly hostSessionId: string
  readonly review: ContinuousReviewMode
  readonly issuedAt: string
}

function isValidChangeName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function isValidHostSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

async function readRegularFile(path: string): Promise<string | null> {
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Parse exactly the same compact v2 grammar as hooks/interaction-authority.sh. */
export function parseContinuousAuthority(raw: string): ContinuousAuthority | null {
  const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n')
  if (lines.length !== 6 || lines[0] !== INTERACTION_AUTHORITY_PROTOCOL) return null

  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const separator = line.indexOf('=')
    if (separator <= 0) return null
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!['change', 'host_session', 'scope', 'review', 'issued_at'].includes(key) || fields.has(key)) return null
    fields.set(key, value)
  }

  const changeName = fields.get('change') ?? ''
  const hostSessionId = fields.get('host_session') ?? ''
  const scope = fields.get('scope') ?? ''
  const review = fields.get('review') ?? ''
  const issuedAt = fields.get('issued_at') ?? ''
  if (!isValidChangeName(changeName)
    || !isValidHostSessionId(hostSessionId)
    || scope !== 'interactive-skills') return null
  if (review !== 'required' && review !== 'delegated') return null
  if (!/^[0-9TZ:.-]+$/.test(issuedAt)) return null
  return { changeName, hostSessionId, review, issuedAt }
}

/**
 * A delegated review acknowledgement is valid only for the exact Change the same user currently selects
 * (`.tenon/users/<slug>/local/active-change`).  A stale authority for a previous Change, or another user's
 * authority, cannot unlock its review exit.
 */
export async function readDelegatedReviewAuthority(
  cwd: string,
  slug: string,
  name: string,
  hostSessionId: string | undefined,
): Promise<ContinuousAuthority | null> {
  if (!isValidChangeName(name) || hostSessionId === undefined || !isValidHostSessionId(hostSessionId)) return null
  const [rawAuthority, activeChange] = await Promise.all([
    readRegularFile(userProjectPaths(cwd, slug).authority),
    readActiveChange(cwd, slug),
  ])
  if (rawAuthority === null || activeChange !== name) return null
  const authority = parseContinuousAuthority(rawAuthority)
  if (authority === null || authority.review !== 'delegated' || authority.changeName !== name) return null
  if (authority.hostSessionId !== hostSessionId) return null
  return authority
}
