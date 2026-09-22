import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SpecMigrationGuardStatus } from '../workflow/ir.js'
import { readSpecApplyReceiptStatus } from './spec-apply-receipt.js'

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function escaped(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

async function trustedOrdinaryFile(
  repoRoot: string,
  candidate: string,
  optional = false,
): Promise<Buffer | undefined> {
  const root = resolve(repoRoot)
  const target = resolve(candidate)
  if (escaped(root, target)) throw new Error('路径越过项目根')
  let cursor = root
  const segments = relative(root, target).split(sep).filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment)
    let info
    try {
      info = await lstat(cursor)
    } catch (error) {
      if (optional && errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`可信路径拒绝 symlink: ${relative(root, cursor)}`)
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`可信路径父级不是目录: ${relative(root, cursor)}`)
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`迁移证据不是普通文件: ${relative(root, cursor)}`)
    }
  }
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)])
  if (escaped(rootReal, targetReal)) throw new Error('迁移证据真实路径越过项目根')
  return readFile(target)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 形状非法`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} 非法`)
  return value
}

function parseJson(raw: Buffer, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw.toString('utf8')) as unknown, label)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} 不是合法 JSON`)
    throw error
  }
}

export async function evaluateSpecMigrationEvidence(
  repoRoot: string,
  changeDir: string,
  changeName: string,
): Promise<SpecMigrationGuardStatus> {
  try {
    const root = resolve(repoRoot)
    const expectedChangeDir = resolve(root, 'openspec', 'changes', changeName)
    if (resolve(changeDir) !== expectedChangeDir || escaped(root, expectedChangeDir)) {
      return { kind: 'invalid', reason: 'change-directory-mismatch' }
    }
    const migrationDir = resolve(expectedChangeDir, 'migration')
    const receiptPath = resolve(migrationDir, 'spec-application.json')
    const receiptRaw = await trustedOrdinaryFile(root, receiptPath, true)
    // 没有历史迁移回执 = 这份 change 的主规格应用不是由那次一次性迁移承担的，于是问题回到它自己：
    // 它登记的 delta spec 到底应用了没有。此前这里直接 not-required，于是 guard 只守着一份历史
    // 回执、对本次应用一言不发——ship 与 archive 就这样放行了一个主规格里什么都没有的 change。
    if (!receiptRaw) return await changeSpecApplication(root, changeDir)

    const receipt = parseJson(receiptRaw, 'migration receipt')
    if (
      receipt.schemaVersion !== 1
      || receipt.kind !== 'historical-spec-application-migration'
      || text(receipt.change, 'receipt.change') !== changeName
    ) {
      return { kind: 'invalid', reason: 'receipt-identity-mismatch' }
    }
    const capability = text(receipt.capability, 'receipt.capability')
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(capability)) {
      return { kind: 'invalid', reason: 'receipt-capability-invalid' }
    }
    const expectedMainPath = `openspec/specs/${capability}/spec.md`
    const expectedDeltaPath = `openspec/changes/${changeName}/specs/${capability}/spec.md`
    if (
      text(receipt.mainSpecPath, 'receipt.mainSpecPath') !== expectedMainPath
      || text(receipt.deltaSpecPath, 'receipt.deltaSpecPath') !== expectedDeltaPath
    ) {
      return { kind: 'invalid', reason: 'receipt-path-mismatch' }
    }
    const expectedDigest = text(receipt.expectedAfterDigest, 'receipt.expectedAfterDigest')
    const deltaDigest = text(receipt.deltaDigest, 'receipt.deltaDigest')
    const deltaRaw = await trustedOrdinaryFile(root, resolve(root, expectedDeltaPath))
    if (!deltaRaw || digest(deltaRaw) !== deltaDigest) {
      return { kind: 'invalid', reason: 'delta-digest-mismatch' }
    }

    const resultRaw = await trustedOrdinaryFile(
      root,
      resolve(migrationDir, 'spec-application-result.json'),
      true,
    )
    if (!resultRaw) return { kind: 'invalid', reason: 'application-result-missing' }
    const result = parseJson(resultRaw, 'migration result')
    if (
      result.schemaVersion !== 1
      || result.kind !== 'spec-migration-application'
      || result.change !== changeName
      || result.capability !== capability
      || result.receiptDigest !== digest(receiptRaw)
      || result.targetPath !== expectedMainPath
      || (result.effect !== 'changed' && result.effect !== 'no-op')
      || result.expectedAfterDigest !== expectedDigest
      || result.afterDigest !== expectedDigest
    ) {
      return { kind: 'invalid', reason: 'application-result-mismatch' }
    }
    const mainRaw = await trustedOrdinaryFile(root, resolve(root, expectedMainPath))
    if (!mainRaw || digest(mainRaw) !== expectedDigest) {
      return { kind: 'invalid', reason: 'main-spec-digest-mismatch' }
    }
    return { kind: 'applied' }
  } catch (error) {
    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : 'migration-evidence-read-failed',
    }
  }
}

/**
 * 这份 change 自己的规格应用证据：`tenon spec apply <change>` 的回执，且必须是真跑过的那一种。
 *
 * 彩排（`--dry-run`）写的是同一份回执文件、同样 result=pass，只有 mode 不同；判定不看 mode 就等于
 * 认彩排为应用。回执之外还要求它点名的每份主规格此刻真的在盘上、摘要与回执一致——回执是自述，
 * 主规格字节才是证据。没有登记过 delta spec 的 change 本来就不产出规格增量，对它不适用。
 */
async function changeSpecApplication(
  repoRoot: string,
  changeDir: string,
): Promise<SpecMigrationGuardStatus> {
  const status = await readSpecApplyReceiptStatus(repoRoot, changeDir)
  if (status.applied) return { kind: 'applied' }
  if (status.reason === 'delta-spec-unrecorded') return { kind: 'not-required' }
  return { kind: 'invalid', reason: status.reason ?? 'spec-apply-missing' }
}
