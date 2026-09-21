/**
 * `tenon spec apply` 回执的新鲜度：回执里的 delta 摘要与盘上当前 delta spec 一致才算数。
 *
 * `step.next` 据此决定还要不要先跑一次 `validate-spec` / `apply-spec`——delta spec 改过之后，
 * 上一次的彩排结论就不再说明任何事情。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readDocumentLedger, sha256Hex } from '@tenon/kernel'
import { asArray, asRecord, asText, decodeJson } from './specApplyRehearsal.js'
import { SPEC_APPLY_RECEIPT } from './specApply.js'

export interface SpecApplyFreshness {
  readonly fresh: boolean
  readonly mode: string | null
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function specApplyReceiptFresh(
  repoRoot: string,
  changeDir: string,
): Promise<SpecApplyFreshness> {
  const raw = await readText(join(changeDir, SPEC_APPLY_RECEIPT))
  const receipt = raw === null ? null : decodeJson(raw)
  if (receipt === null || receipt.result !== 'pass') return { fresh: false, mode: null }
  let deltas: readonly { readonly path: string; readonly sha256: string }[]
  try {
    deltas = (await readDocumentLedger(changeDir))?.records
      .filter((record) => record.kind === 'delta-spec')
      .map((record) => ({ path: record.path, sha256: record.sha256 })) ?? []
  } catch {
    return { fresh: false, mode: null }
  }
  if (deltas.length === 0) return { fresh: false, mode: null }
  const recorded = new Map<string, string>()
  for (const row of asArray(receipt.deltas)) {
    const entry = asRecord(row)
    const path = asText(entry?.path)
    const digest = asText(entry?.sha256)
    if (path !== undefined && digest !== undefined) recorded.set(path, digest)
  }
  if (recorded.size !== deltas.length) return { fresh: false, mode: null }
  for (const delta of deltas) {
    const text = await readText(join(repoRoot, delta.path))
    if (text === null || recorded.get(delta.path) !== sha256Hex(text)) return { fresh: false, mode: null }
  }
  return { fresh: true, mode: asText(receipt.mode) ?? null }
}
