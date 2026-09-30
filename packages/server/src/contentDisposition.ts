/**
 * `Content-Disposition` 头（RFC 6266）：带上文件的原始 basename，浏览器另存为时才不会退回 URL 末段（`artifact`）
 * 再按 content-type 猜出 `artifact.zip` / `artifact.txt`。
 *
 * `filename` 只放可打印 ASCII（`"`、`\`、`%` 与其余字符换成 `_`）作旧客户端的兜底；文件名不是纯 ASCII、
 * 或含 `"` `\` `%` 时，再补一个 RFC 5987 的 `filename*=UTF-8''…`，新客户端优先取它，拿到的仍是原名。
 * 调用方传入的是已校验的单个路径段，这里不负责路径安全，只保证输出的头值不会含控制字符或需要转义的引号。
 */
export type DispositionType = 'attachment' | 'inline'

// RFC 5987 attr-char：字母数字与 !#$&+-.^_`|~ 。
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/u

function asciiFallback(filename: string): string {
  let out = ''
  for (const char of filename) {
    const code = char.codePointAt(0) ?? 0
    const printable = code >= 0x20 && code <= 0x7e
    out += printable && char !== '"' && char !== '\\' && char !== '%' ? char : '_'
  }
  return out
}

function extendedValue(filename: string): string {
  // 按 UTF-8 字节编码：孤立代理项会被 Buffer 换成 U+FFFD，不会像 encodeURIComponent 那样抛错。
  let out = ''
  for (const byte of Buffer.from(filename, 'utf8')) {
    const char = String.fromCharCode(byte)
    out += byte < 0x80 && ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export function contentDisposition(type: DispositionType, filename: string): string {
  const fallback = asciiFallback(filename)
  const header = `${type}; filename="${fallback}"`
  return fallback === filename ? header : `${header}; filename*=UTF-8''${extendedValue(filename)}`
}
