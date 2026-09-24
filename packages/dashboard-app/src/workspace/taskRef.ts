/**
 * 工作台 URL `change` 的取值。选了项目时就是 change 名；聚合视图（所有项目）里两个项目可能有同名 change，
 * 所以写成 `<项目短标识>:<change 名>`。change 名只含 `[a-zA-Z0-9_-]`，冒号不会出现在名字里，按最后一个冒号切分。
 */

/** 项目 root 的短标识：FNV-1a 32 位十六进制，8 个字符。只用于区分同名 change，不可逆也不需要可逆。 */
export function rootTag(root: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < root.length; index += 1) {
    hash ^= root.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

interface TaskIdentity {
  readonly root: string
  readonly change: { readonly name: string }
}

/** 聚合视图写 `<tag>:<name>`，单项目视图只写名字。 */
export function taskRef(row: TaskIdentity, aggregate: boolean): string {
  return aggregate ? `${rootTag(row.root)}:${row.change.name}` : row.change.name
}

/** URL 的 change 是否指这一行。不带项目标识的旧链接只按名字匹配。 */
export function matchesTaskRef(ref: string, row: TaskIdentity): boolean {
  const split = ref.lastIndexOf(':')
  if (split < 0) return ref === row.change.name
  return ref.slice(split + 1) === row.change.name && ref.slice(0, split) === rootTag(row.root)
}
