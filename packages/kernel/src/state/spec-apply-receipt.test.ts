/**
 * 彩排回执不得冒充一次真实应用。
 *
 * 真机实测（三条 track 全部走到完结）：`find openspec/specs -type f` 一个文件都没有，而每条 track
 * 都留着一份 `result: "pass"` 的 `.pipeline-spec-apply.json`——它是 `--dry-run` 写的。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSpecApplyReceiptStatus, SPEC_APPLY_RECEIPT_FILE } from './spec-apply-receipt.js'

const CHANGE = 'spec-apply-receipt-demo'
const DELTA = `openspec/changes/${CHANGE}/specs/demo-two/spec.md`
const MAIN = 'openspec/specs/demo-two/spec.md'
const DELTA_BODY = '## ADDED Requirements\n'
const MAIN_BODY = '# demo-two\n'

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('spec apply 回执：彩排与应用是两个事实', () => {
  let root: string
  let changeDir: string

  async function write(rel: string, body: string): Promise<void> {
    const target = join(root, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, 'utf8')
  }

  async function writeLedger(paths: readonly string[]): Promise<void> {
    await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: '2026-09-22T00:00:00Z',
      records: paths.map((path) => ({
        kind: 'delta-spec',
        path,
        sha256: digest(DELTA_BODY),
        producer: 'openspec-propose',
        recordedAt: '2026-09-22T00:00:00Z',
        reads: [],
      })),
    }, null, 2)}\n`, 'utf8')
  }

  async function writeReceipt(mode: string, targets: readonly { path: string; after: string }[]): Promise<void> {
    await writeFile(join(changeDir, SPEC_APPLY_RECEIPT_FILE), `${JSON.stringify({
      schema: 'tenon-spec-apply-v1',
      change: CHANGE,
      mode,
      result: 'pass',
      deltas: [{ path: DELTA, sha256: digest(DELTA_BODY) }],
      targets: targets.map((target) => ({
        path: target.path, before_sha256: null, after_sha256: digest(target.after), change: 'created',
      })),
    }, null, 2)}\n`, 'utf8')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-spec-apply-receipt-'))
    changeDir = join(root, 'openspec', 'changes', CHANGE)
    await mkdir(changeDir, { recursive: true })
    await write(DELTA, DELTA_BODY)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('没登记过 delta spec：既没彩排也没应用，原因点名 delta-spec-unrecorded', async () => {
    await expect(readSpecApplyReceiptStatus(root, changeDir)).resolves.toEqual({
      rehearsed: false, applied: false, mode: null, reason: 'delta-spec-unrecorded',
    })
  })

  it('dry-run 回执：算彩排过，不算应用过', async () => {
    await writeLedger([DELTA])
    await writeReceipt('dry-run', [{ path: MAIN, after: MAIN_BODY }])
    await expect(readSpecApplyReceiptStatus(root, changeDir)).resolves.toEqual({
      rehearsed: true, applied: false, mode: 'dry-run', reason: 'spec-apply-rehearsal-only',
    })
  })

  it('apply 回执但主规格不在盘上：回执自述不作数', async () => {
    await writeLedger([DELTA])
    await writeReceipt('apply', [{ path: MAIN, after: MAIN_BODY }])
    await expect(readSpecApplyReceiptStatus(root, changeDir)).resolves.toEqual({
      rehearsed: true, applied: false, mode: 'apply', reason: 'main-spec-not-applied',
    })
  })

  it('apply 回执且主规格字节与回执一致：应用过', async () => {
    await writeLedger([DELTA])
    await writeReceipt('apply', [{ path: MAIN, after: MAIN_BODY }])
    await write(MAIN, MAIN_BODY)
    await expect(readSpecApplyReceiptStatus(root, changeDir)).resolves.toEqual({
      rehearsed: true, applied: true, mode: 'apply',
    })
  })

  it('delta spec 应用后又被改：彩排与应用一起失效', async () => {
    await writeLedger([DELTA])
    await writeReceipt('apply', [{ path: MAIN, after: MAIN_BODY }])
    await write(MAIN, MAIN_BODY)
    await write(DELTA, `${DELTA_BODY}\n### Requirement: Later\n`)
    await expect(readSpecApplyReceiptStatus(root, changeDir)).resolves.toEqual({
      rehearsed: false, applied: false, mode: 'apply', reason: 'spec-apply-receipt-stale',
    })
  })
})
