/**
 * 目录 `files` / `covers` 的 glob 匹配（仓库相对、正斜杠路径）。支持 `**`（零到多层目录）、`*`、`?`、
 * `{a,b}`（可嵌套）与 `[abc]` / `[!abc]`。纯函数，不依赖 Node 的实验性 `path.matchesGlob`。
 */

const cache = new Map<string, RegExp>()

function escapeChar(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char
}

function closingBrace(glob: string, open: number): number {
  let depth = 0
  for (let index = open; index < glob.length; index++) {
    const char = glob[index]
    if (char === '\\') { index++; continue }
    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? ''
    if (char === '\\') { current += char + (body[index + 1] ?? ''); index++; continue }
    if (char === '{') depth++
    if (char === '}') depth--
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts
}

function translate(glob: string): string {
  let out = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? ''
    if (char === '\\') {
      out += escapeChar(glob[index + 1] ?? '\\')
      index++
      continue
    }
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const atSegmentStart = index === 0 || glob[index - 1] === '/'
        index++
        if (atSegmentStart && glob[index + 1] === '/') {
          out += '(?:[^/]*(?:/[^/]*)*/)?'
          index++
        } else {
          out += '.*'
        }
        continue
      }
      out += '[^/]*'
      continue
    }
    if (char === '?') { out += '[^/]'; continue }
    if (char === '[') {
      const close = glob.indexOf(']', index + 2)
      if (close < 0) { out += '\\['; continue }
      let body = glob.slice(index + 1, close)
      const negate = body.startsWith('!') || body.startsWith('^')
      if (negate) body = body.slice(1)
      out += `[${negate ? '^/' : ''}${body.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`
      index = close
      continue
    }
    if (char === '{') {
      const close = closingBrace(glob, index)
      if (close < 0) { out += '\\{'; continue }
      const alternatives = splitAlternatives(glob.slice(index + 1, close)).map(translate)
      out += `(?:${alternatives.join('|')})`
      index = close
      continue
    }
    out += escapeChar(char)
  }
  return out
}

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob)
  if (cached !== undefined) return cached
  const regexp = new RegExp(`^${translate(glob)}$`, 'u')
  cache.set(glob, regexp)
  return regexp
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path)
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob))
}

/** 套件 cwd 下的 glob 换算成仓库相对 glob。 */
export function repoGlob(cwd: string, glob: string): string {
  return cwd === '.' ? glob : `${cwd}/${glob}`
}

/** 仓库内相对路径：非绝对、无 `..`、无反斜杠、无空段；单独的 `.` 表示仓库根。 */
export function isRepoRelativePath(value: string): boolean {
  if (value === '.') return true
  if (value === '' || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '..' && segment !== '.')
}

/** glob 同样必须留在仓库内：不以 `/` 开头、不含 `..` 段。 */
export function isRepoRelativeGlob(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '..')
}
