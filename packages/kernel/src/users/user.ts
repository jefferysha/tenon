/**
 * Declared user identity (pure). The id is an email-like ASCII string chosen so that bash
 * (`hooks/tenon-user.sh`) and TypeScript derive the same slug; nothing here proves who a person is.
 */
export type UserSource = 'env' | 'config' | 'git'

export interface TenonUser {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly source: UserSource
  readonly trust: 'declared'
}

export interface TenonUserMissing { readonly missing: true; readonly invalid?: UserSource }
export type TenonUserResolution = TenonUser | TenonUserMissing
export interface RecordActor { readonly id: string; readonly name: string; readonly trust: 'declared' }
export interface UserRef { readonly id: string; readonly name: string; readonly slug: string }

export const USER_MISSING_HINT =
  '未设置用户身份；运行 tenon user set <邮箱> --name <名字>，或 git config --global user.email <邮箱>'

const MAX_ID = 200
const MAX_NAME = 100

export function isTenonUser(value: TenonUserResolution): value is TenonUser {
  return !('missing' in value)
}

/**
 * Printable ASCII without spaces, exactly one `@` with both sides non-empty, 3..200 chars.
 * `<`, `>`, `"` and `\` are refused anywhere and a quote may not lead, so the value survives the
 * `Name <id>` user ref, the YAML quote gate and the bash JSON reader unchanged.
 */
export function validateUserId(raw: string): string | null {
  const id = raw.trim()
  if (id.length < 3 || id.length > MAX_ID || !/^[\x21-\x7e]+$/u.test(id)) return null
  if (/[<>"\\]/u.test(id) || id.startsWith("'")) return null
  const at = id.indexOf('@')
  if (at <= 0 || at === id.length - 1 || id.indexOf('@', at + 1) !== -1) return null
  return id
}

function localPart(id: string): string {
  return id.slice(0, id.indexOf('@'))
}

/** A name that could break the user ref or the YAML quote gate falls back to the id's local part. */
export function normalizeUserName(raw: string | undefined, id: string): string {
  const name = (raw ?? '').trim()
  if (name === '' || name.length > MAX_NAME) return localPart(id)
  if (/[<>\u0000-\u001f\u007f]/u.test(name)) return localPart(id)
  const ref = `${name} `
  if (ref.includes(': ') || ref.includes(' #') || name.startsWith('"') || name.startsWith("'")) return localPart(id)
  return name
}

export function userSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/@/gu, '-at-')
    .replace(/[^a-z0-9._-]/gu, '-')
    .replace(/-+/gu, '-')
}

export function actorOf(user: Pick<TenonUser, 'id' | 'name'>): RecordActor {
  return { id: user.id, name: user.name, trust: 'declared' }
}

export function formatUserRef(user: Pick<RecordActor, 'id' | 'name'>): string {
  return `${user.name} <${user.id}>`
}

/** Legacy values (`unknown`, `null`, a bare name) and lists are not user refs. */
export function parseUserRef(value: string | readonly string[] | undefined): UserRef | null {
  if (typeof value !== 'string') return null
  const match = /^(.+) <([^<>]+)>$/u.exec(value.trim())
  if (match === null) return null
  const id = validateUserId(match[2] ?? '')
  if (id === null) return null
  return { id, name: normalizeUserName(match[1], id), slug: userSlug(id) }
}

/** `undefined` when absent, `null` when present but not an exact declared actor. */
export function decodeRecordActor(value: unknown): RecordActor | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 3 || keys[0] !== 'id' || keys[1] !== 'name' || keys[2] !== 'trust') return null
  if (record.trust !== 'declared' || typeof record.id !== 'string' || typeof record.name !== 'string') return null
  if (validateUserId(record.id) !== record.id || normalizeUserName(record.name, record.id) !== record.name) return null
  return { id: record.id, name: record.name, trust: 'declared' }
}
