/**
 * 左列副行的项目路径：家目录折成 `~`，再只留最后两段（父目录 + 目录名），前面用 `…` 表示省略。
 * 同名目录靠父目录区分；完整路径放在 title 里。
 */
export function shortPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  if (trimmed === '') return path
  const home = /^\/(?:Users|home)\/[^/]+(?=\/|$)/u.exec(trimmed)
  const rest = home === null ? trimmed : `~${trimmed.slice(home[0].length)}`
  const segments = rest.split('/')
  // 「~/a/b」「/a/b」这类本来就只有两段以内的路径原样显示。
  const lead = segments[0] === '~' || segments[0] === '' ? 1 : 0
  if (segments.length - lead <= 2) return rest
  return `…/${segments.slice(-2).join('/')}`
}
