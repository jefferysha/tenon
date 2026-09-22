/**
 * `tenon spec apply` 的回执读取：这份 change 的 delta spec 只是**彩排**过，还是**真的落进主规格**。
 *
 * 两个事实必须分开回答，否则一次 `--dry-run` 就能冒充一次应用：
 *   · rehearsed —— 回执 result=pass，且回执里的 delta 摘要与盘上当前 delta spec 字节一致。
 *     delta spec 改过之后，上一次的彩排结论不再说明任何事情，所以摘要要对现在的字节取。
 *   · applied   —— 在 rehearsed 之上还要求 mode=apply，且回执点名的每份主规格此刻真的在盘上、
 *     内容摘要等于回执里的 after_sha256。「回执说应用过」和「主规格真在盘上」是两件事。
 *
 * 判定放在 kernel：`status` 的 next 动作投影（要不要再跑 validate-spec / apply-spec）与 ship 出口的
 * spec-migration-applied guard 必须读同一份答案，两边各算一遍就是「投影说过了、门禁说没过」的来源。
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256Hex } from '../sha256.js'
import { readDocumentLedger } from './document-ledger.js'

/** 回执文件名（change 目录内）；`tenon spec apply` 写、投影与 guard 读。 */
export const SPEC_APPLY_RECEIPT_FILE = '.pipeline-spec-apply.json'

export interface SpecApplyReceiptStatus {
  /** 回执对得上当前 delta spec 字节，且 result=pass（彩排或应用都算）。 */
  readonly rehearsed: boolean
  /** 在 rehearsed 之上：mode=apply，且回执点名的主规格此刻真的在盘上且摘要一致。 */
  readonly applied: boolean
  /** 回执里的 mode 原值（'apply' / 'dry-run'）；无可用回执时 null。 */
  readonly mode: string | null
  /** applied=false 的机器可读原因；applied=true 时缺省。 */
  readonly reason?: string
}

const UNUSABLE: SpecApplyReceiptStatus = {
  rehearsed: false, applied: false, mode: null, reason: 'spec-apply-receipt-missing',
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 这份 change 有没有登记过 delta spec。没有 = 本 change 根本不产出规格增量，
 * 「应用规格」这件事对它不适用（返回空数组，由调用方决定 not-required 还是别的口径）。
 */
export async function recordedDeltaSpecPaths(changeDir: string): Promise<readonly string[]> {
  const ledger = await readDocumentLedger(changeDir)
  return (ledger?.records ?? [])
    .filter((record) => record.kind === 'delta-spec')
    .map((record) => record.path)
}

export async function readSpecApplyReceiptStatus(
  repoRoot: string,
  changeDir: string,
): Promise<SpecApplyReceiptStatus> {
  let deltas: readonly string[]
  try {
    deltas = await recordedDeltaSpecPaths(changeDir)
  } catch {
    return { ...UNUSABLE, reason: 'delta-spec-ledger-unreadable' }
  }
  if (deltas.length === 0) return { ...UNUSABLE, reason: 'delta-spec-unrecorded' }

  const raw = await readText(join(changeDir, SPEC_APPLY_RECEIPT_FILE))
  let receipt: Record<string, unknown> | undefined
  if (raw !== null) {
    try {
      receipt = asRecord(JSON.parse(raw) as unknown)
    } catch {
      receipt = undefined
    }
  }
  if (receipt === undefined) return UNUSABLE
  const mode = asText(receipt.mode) ?? null
  if (receipt.result !== 'pass') {
    return { rehearsed: false, applied: false, mode, reason: 'spec-apply-not-passing' }
  }

  const recorded = new Map<string, string>()
  for (const row of asArray(receipt.deltas)) {
    const entry = asRecord(row)
    const path = asText(entry?.path)
    const digest = asText(entry?.sha256)
    if (path !== undefined && digest !== undefined) recorded.set(path, digest)
  }
  if (recorded.size !== deltas.length) {
    return { rehearsed: false, applied: false, mode, reason: 'spec-apply-receipt-stale' }
  }
  for (const delta of deltas) {
    const text = await readText(resolve(repoRoot, delta))
    if (text === null || recorded.get(delta) !== sha256Hex(text)) {
      return { rehearsed: false, applied: false, mode, reason: 'spec-apply-receipt-stale' }
    }
  }

  if (mode !== 'apply') {
    return { rehearsed: true, applied: false, mode, reason: 'spec-apply-rehearsal-only' }
  }
  const targets = asArray(receipt.targets)
  if (targets.length === 0) {
    return { rehearsed: true, applied: false, mode, reason: 'spec-apply-no-targets' }
  }
  for (const row of targets) {
    const target = asRecord(row)
    const path = asText(target?.path)
    const after = asText(target?.after_sha256)
    if (path === undefined || after === undefined) {
      return { rehearsed: true, applied: false, mode, reason: 'spec-apply-target-invalid' }
    }
    const text = await readText(resolve(repoRoot, path))
    if (text === null || sha256Hex(text) !== after) {
      return { rehearsed: true, applied: false, mode, reason: 'main-spec-not-applied' }
    }
  }
  return { rehearsed: true, applied: true, mode }
}
