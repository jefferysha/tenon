/**
 * 支持包的组装（纯函数、无 I/O）：每一段文本先按预算截断、再脱敏，最后打成一个 `.tar.gz`，总大小有硬上限。
 *
 * 顺序是刻意的：先截断再脱敏，脱敏只处理真正会进包的那部分；出门前所有文本——包括清单与「不可用」原因——
 * 都过 `redactForSharing`，包里没有任何一个字节没经过它。
 */
import {
  addRedactionCounts, NO_REDACTIONS, redactForSharing,
  type RedactionCounts, type SharingRedactionOptions,
} from '@tenon/kernel'
import { createTarGz, type TarEntry } from './tar.js'

export const SUPPORT_BUNDLE_MAX_BYTES = 5 * 1024 * 1024
/** 脱敏后写进归档的文本总量；gzip 之后一定小于 5 MiB 上限，上限检查只是兜底。 */
export const SUPPORT_RAW_BUDGET_BYTES = 4 * 1024 * 1024

export type BundleSource =
  | {
      readonly kind: 'text'
      readonly name: string
      readonly text: string
      /** 超预算时保留开头还是结尾；日志留结尾（最近的才有用）。 */
      readonly keep?: 'head' | 'tail'
      /** 这一段自己的上限，再大也只给这么多。 */
      readonly maxBytes?: number
    }
  | { readonly kind: 'unavailable'; readonly name: string; readonly reason: string }

export interface BundleEntryReport {
  readonly name: string
  readonly bytes: number
  readonly originalBytes: number
  readonly truncated: boolean
  readonly unavailable?: string
}

export interface BuiltBundle {
  readonly archive: Buffer
  readonly entries: readonly BundleEntryReport[]
  readonly redactions: RedactionCounts
}

export interface BuildBundleInput {
  readonly createdAt: string
  readonly sources: readonly BundleSource[]
  readonly redaction: SharingRedactionOptions
  readonly notIncluded: readonly string[]
  readonly maxBytes?: number
  readonly rawBudget?: number
}

export const MANIFEST_NAME = 'manifest.json'

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function cut(text: string, allowed: number, keep: 'head' | 'tail'): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= allowed) return text
  if (keep === 'head') {
    const head = buffer.subarray(0, allowed).toString('utf8')
    return head.slice(0, head.lastIndexOf('\n') + 1)
  }
  const tail = buffer.subarray(buffer.length - allowed).toString('utf8')
  // 从中间截起的文本第一行多半不完整：丢掉。
  return tail.slice(tail.indexOf('\n') + 1)
}

interface Prepared {
  readonly report: BundleEntryReport
  readonly content: string | undefined
}

function prepare(
  sources: readonly BundleSource[],
  budget: number,
  redaction: SharingRedactionOptions,
): { readonly prepared: readonly Prepared[]; readonly redactions: RedactionCounts } {
  let remaining = budget
  let redactions = NO_REDACTIONS
  const prepared: Prepared[] = []
  for (const source of sources) {
    if (source.kind === 'unavailable') {
      const reason = redactForSharing(source.reason, redaction)
      redactions = addRedactionCounts(redactions, reason.counts)
      prepared.push({
        report: { name: source.name, bytes: 0, originalBytes: 0, truncated: false, unavailable: reason.text },
        content: undefined,
      })
      continue
    }
    const originalBytes = bytesOf(source.text)
    const allowed = Math.max(0, Math.min(source.maxBytes ?? remaining, remaining))
    const truncated = originalBytes > allowed
    const kept = truncated ? cut(source.text, allowed, source.keep ?? 'head') : source.text
    const marker = truncated
      ? `[tenon] truncated: kept the ${source.keep === 'tail' ? 'last' : 'first'} ${bytesOf(kept)} of ${originalBytes} bytes\n`
      : ''
    const result = redactForSharing(`${marker}${kept}`, redaction)
    redactions = addRedactionCounts(redactions, result.counts)
    const bytes = bytesOf(result.text)
    remaining = Math.max(0, remaining - bytes)
    prepared.push({ report: { name: source.name, bytes, originalBytes, truncated }, content: result.text })
  }
  return { prepared, redactions }
}

function manifestOf(input: BuildBundleInput, entries: readonly BundleEntryReport[], redactions: RedactionCounts, maxBytes: number): string {
  return `${JSON.stringify({
    schema: 'tenon-support-bundle/v1',
    created_at: input.createdAt,
    max_bytes: maxBytes,
    entries: entries.map((entry) => ({
      name: entry.name,
      bytes: entry.bytes,
      original_bytes: entry.originalBytes,
      truncated: entry.truncated,
      ...(entry.unavailable === undefined ? {} : { unavailable: entry.unavailable }),
    })),
    redactions,
    not_included: input.notIncluded,
  }, null, 2)}\n`
}

export function buildSupportBundle(input: BuildBundleInput): BuiltBundle {
  const maxBytes = input.maxBytes ?? SUPPORT_BUNDLE_MAX_BYTES
  const mtime = Math.floor(Date.parse(input.createdAt) / 1000)
  const stamp = Number.isFinite(mtime) ? mtime : 0
  let budget = input.rawBudget ?? SUPPORT_RAW_BUDGET_BYTES
  for (let attempt = 0; attempt < 8; attempt++) {
    const { prepared, redactions } = prepare(input.sources, budget, input.redaction)
    const entries = prepared.map((item) => item.report)
    const manifest = manifestOf(input, entries, redactions, maxBytes)
    const files: TarEntry[] = [{ name: MANIFEST_NAME, content: Buffer.from(manifest, 'utf8'), mtime: stamp }]
    for (const item of prepared) {
      if (item.content !== undefined) files.push({ name: item.report.name, content: Buffer.from(item.content, 'utf8'), mtime: stamp })
    }
    const archive = createTarGz(files)
    if (archive.length <= maxBytes) return { archive, entries, redactions }
    // 压缩率比预想的差：收紧文本预算重来（日志最先被截）。
    budget = Math.floor(budget * 0.6)
  }
  throw new Error(`support bundle cannot be made smaller than ${maxBytes} bytes`)
}
