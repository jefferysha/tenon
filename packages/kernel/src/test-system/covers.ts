/**
 * 追溯引用的语法：
 *   · covers：`spec:<capability>/<Scenario 标题>`（OpenSpec delta spec 的 `#### Scenario:`）或
 *     `task:<编号>`（tasks.md 条目，如 `2.3`）。
 *   · 用例引用：`<文件> › <标题路径>`；文件可以是仓库相对路径，也可以是它的尾部（`Login.test.tsx`），
 *     标题路径按 ` › ` 分段，可只写最后几段。只写文件表示「该文件里的任一用例」。
 */

export const CASE_REF_SEPARATOR = ' › '

const CAPABILITY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const TASK_ID_RE = /^\d+(?:\.\d+)*$/

export type CoversRef =
  | { readonly kind: 'spec'; readonly capability: string; readonly title: string }
  | { readonly kind: 'task'; readonly id: string }

export function parseCovers(value: string): CoversRef | undefined {
  if (/[\r\n]/.test(value)) return undefined
  if (value.startsWith('spec:')) {
    const body = value.slice('spec:'.length)
    const slash = body.indexOf('/')
    if (slash <= 0) return undefined
    const capability = body.slice(0, slash)
    const title = body.slice(slash + 1).trim()
    if (!CAPABILITY_RE.test(capability) || title === '' || title !== body.slice(slash + 1)) return undefined
    return { kind: 'spec', capability, title }
  }
  if (value.startsWith('task:')) {
    const id = value.slice('task:'.length)
    return TASK_ID_RE.test(id) ? { kind: 'task', id } : undefined
  }
  return undefined
}

export function formatCovers(ref: CoversRef): string {
  return ref.kind === 'spec' ? `spec:${ref.capability}/${ref.title}` : `task:${ref.id}`
}

export function scenarioCoversKey(capability: string, title: string): string {
  return `spec:${capability}/${title}`
}

export function taskCoversKey(id: string): string {
  return `task:${id}`
}

export interface CaseRef {
  readonly file: string
  /** 标题路径分段；空表示该文件里的任一用例。 */
  readonly title: readonly string[]
}

export function parseCaseRef(value: string): CaseRef | undefined {
  if (value.trim() === '' || /[\r\n]/.test(value)) return undefined
  const parts = value.split(CASE_REF_SEPARATOR).map((part) => part.trim())
  const file = parts[0] ?? ''
  if (file === '' || file.startsWith('/') || file.split('/').includes('..') || parts.slice(1).some((part) => part === '')) {
    return undefined
  }
  return { file, title: parts.slice(1) }
}

/** 引用里的文件是否指向 path：完全相同，或是它以 `/` 为界的尾部。 */
export function fileRefMatches(ref: string, path: string): boolean {
  return path === ref || path.endsWith(`/${ref}`)
}

/** 一个执行过的用例：文件 + 从外到内的标题路径（describe 分组 … 用例名）。 */
export interface CaseIdentity {
  readonly file: string
  readonly suite_path: readonly string[]
  readonly name: string
}

export function caseMatchesRef(ref: CaseRef, identity: CaseIdentity): boolean {
  if (!fileRefMatches(ref.file, identity.file)) return false
  if (ref.title.length === 0) return true
  const full = [...identity.suite_path, identity.name]
  if (ref.title.length > full.length) return false
  const tail = full.slice(full.length - ref.title.length)
  return tail.every((segment, index) => segment === ref.title[index])
}

export function formatCaseRef(identity: CaseIdentity): string {
  return [identity.file, ...identity.suite_path, identity.name].join(CASE_REF_SEPARATOR)
}
