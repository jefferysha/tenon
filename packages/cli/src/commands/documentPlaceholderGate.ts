/**
 * `document record` 的骨架占位符闸（D7）：骨架还没写完的文档不是证据。
 *
 * 判定取 kernel findDocumentPlaceholders（只认模板渲染器写出的记号）。读不到文件时不在这里判——
 * 路径越界、缺文件、符号链接等由登记本身按既有口径拒绝，这里不另造一套文案。
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { findDocumentPlaceholders } from '@tenon/kernel'

const PREVIEW = 5

/** 拒绝原因（点名 `path:行号`，最多 5 处）；null = 没有占位符，可以登记。 */
export async function placeholderRefusal(cwd: string, kind: string, path: string): Promise<string | null> {
  let content: string
  try {
    content = await readFile(resolve(cwd, path), 'utf8')
  } catch {
    return null
  }
  const found = findDocumentPlaceholders(content)
  if (found.length === 0) return null
  const shown = found.slice(0, PREVIEW).map((item) => `${path}:${item.line}: ${item.text}`)
  const more = found.length > shown.length ? `\n  …另有 ${found.length - shown.length} 处` : ''
  return `document '${kind}' 仍含 ${found.length} 处未替换的骨架占位符，写完再登记：\n  ${shown.join('\n  ')}${more}`
}
