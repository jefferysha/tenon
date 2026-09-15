import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildCanonicalManifest } from '@tenon/automation'

const NO_EXCLUDES: ReadonlySet<string> = new Set()

function unquote(value: string): string {
  const s = value.trim()
  return s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s
}

/** Single-line `key: value` fields of a SKILL.md frontmatter block; `null` without a closed `---` block. */
export function readSkillFrontmatter(path: string): ReadonlyMap<string, string> | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return null
  const fields = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return fields
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line)
    const key = match?.[1]
    if (key === undefined || fields.has(key)) continue
    fields.set(key, unquote(match?.[2] ?? ''))
  }
  return null
}

/** Sum of regular file bytes; any entry that is neither a regular file nor a directory is rejected. */
export function measureTree(dir: string, excludeTopLevel: ReadonlySet<string>): { readonly bytes: number } | { readonly error: string } {
  let bytes = 0
  const visit = (current: string, rel: string, excludes: ReadonlySet<string>): string | undefined => {
    for (const name of readdirSync(current).sort()) {
      if (excludes.has(name)) continue
      const path = join(current, name)
      const relPath = rel === '' ? name : `${rel}/${name}`
      const item = lstatSync(path)
      if (item.isDirectory()) {
        const error = visit(path, relPath, NO_EXCLUDES)
        if (error !== undefined) return error
      } else if (item.isFile()) {
        bytes += item.size
      } else {
        return `unsupported entry ${relPath}`
      }
    }
    return undefined
  }
  const error = visit(dir, '', excludeTopLevel)
  return error === undefined ? { bytes } : { error }
}

/** Copies regular files and directories only, with modes normalized to 0755 / 0644. */
export function copyTree(source: string, target: string, excludeTopLevel: ReadonlySet<string> = NO_EXCLUDES): void {
  mkdirSync(target, { recursive: true })
  chmodSync(target, 0o755)
  for (const name of readdirSync(source)) {
    if (excludeTopLevel.has(name)) continue
    const from = join(source, name)
    const to = join(target, name)
    const item = lstatSync(from)
    if (item.isDirectory()) {
      copyTree(from, to)
    } else if (item.isFile()) {
      copyFileSync(from, to)
      chmodSync(to, (item.mode & 0o111) !== 0 ? 0o755 : 0o644)
    } else {
      throw new Error(`unsupported entry ${from}`)
    }
  }
}

/** `sha256:` + tree-sha256-v1 of a real skill directory, or `null` when it is absent or not hashable. */
export async function treeHash(id: string, dir: string): Promise<`sha256:${string}` | null> {
  try {
    if (!lstatSync(dir).isDirectory()) return null
    return `sha256:${(await buildCanonicalManifest(id, dir)).treeSha256}`
  } catch {
    return null
  }
}
