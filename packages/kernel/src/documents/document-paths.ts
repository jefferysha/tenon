import { readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { DocumentKind } from '../workflow/document-contract-model.js'
import { DOCUMENT_PRESENTATION_REGISTRY } from './document-presentation.generated.js'

/**
 * 某 document kind 的规范路径模板（来自 presentation registry；同 kind 多模板时全部返回）。
 * `{change}` 由 change 名替换；`{capability}` 表示目录通配（delta-spec 每个 capability 一份）。
 */
export function documentPathTemplates(kind: DocumentKind | string): readonly string[] {
  return Object.values(DOCUMENT_PRESENTATION_REGISTRY.templates)
    .filter((template) => template.kind === kind)
    .map((template) => template.path)
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 某 change 下该 kind **当前存在**的规范路径（repoRoot 相对、posix 分隔、去重、稳定序）。
 * 不读内容、不判断是否已登记——只回答「按契约它应该在哪、现在在不在」。
 */
export async function canonicalDocumentPaths(repoRoot: string, changeName: string, kind: DocumentKind | string): Promise<string[]> {
  const out: string[] = []
  for (const template of documentPathTemplates(kind)) {
    const filled = template.replaceAll('{change}', changeName)
    if (!filled.includes('{capability}')) {
      if (await isRegularFile(join(repoRoot, filled))) out.push(filled)
      continue
    }
    const [head, tail] = filled.split('{capability}')
    if (head === undefined || tail === undefined) continue
    const dir = posix.dirname(`${head}x`)
    let entries: string[] = []
    try {
      entries = (await readdir(join(repoRoot, dir), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    } catch {
      continue
    }
    for (const capability of entries) {
      const candidate = `${head}${capability}${tail}`
      if (await isRegularFile(join(repoRoot, candidate))) out.push(candidate)
    }
  }
  return [...new Set(out)]
}
