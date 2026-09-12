import path from 'node:path'
import { createHash } from 'node:crypto'

/** Stable change-local namespace shared by document, field, and runtime adapters. */
export function artifactNamespaceForChange(changeDir: string): string {
  const normalized = path.resolve(changeDir)
  const changeName = normalized.split(path.sep).at(-1) ?? 'change'
  const safe = changeName.toLowerCase().replace(/[^a-z0-9._/-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'change'
  const identity = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `change-${safe}-${identity}`
}
