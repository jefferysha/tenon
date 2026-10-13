import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { STEP_OUTPUT_LEDGER_FILE, StepOutputLedgerError } from '../state/step-output-ledger.js'
import { stepOutputLedgerBlocker, unreadInputBlockers } from './step-input-gate.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function changeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'step-input-gate-'))
  roots.push(root)
  const dir = join(root, 'openspec', 'changes', 'demo')
  await mkdir(dir, { recursive: true })
  return dir
}

describe('stepOutputLedgerBlocker', () => {
  test.each([
    ['步骤产出账本损坏：visits[0].step 必须是字符串', '步骤产出账本损坏：visits[0].step 必须是字符串；'],
    ['步骤产出账本不是有效 JSON', '步骤产出账本损坏：不是有效 JSON；'],
    ['步骤产出账本超过 4 MiB 上限', '步骤产出账本损坏：超过 4 MiB 上限；'],
  ])('原因文案不重复「步骤产出账本损坏」前缀：%s', (reason, expectedPrefix) => {
    const blocker = stepOutputLedgerBlocker('demo', new StepOutputLedgerError(reason))
    expect(blocker.code).toBe('step-output-ledger-invalid')
    expect(blocker.message.startsWith(expectedPrefix)).toBe(true)
    expect(blocker.message).toContain(`修复 openspec/changes/demo/${STEP_OUTPUT_LEDGER_FILE} 后重试`)
    expect(blocker.subject).toBeUndefined()
  })
})

describe('unreadInputBlockers', () => {
  test('没有 run 状态的任务目录：没有当前访问就没有输入，不阻断', async () => {
    expect(await unreadInputBlockers(await changeDir())).toEqual([])
  })

  test('账本损坏：返回一条 step-output-ledger-invalid 阻断，而不是抛出', async () => {
    const dir = await changeDir()
    await writeFile(join(dir, STEP_OUTPUT_LEDGER_FILE), '{not json')
    const blockers = await unreadInputBlockers(dir)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({ code: 'step-output-ledger-invalid' })
    expect(blockers[0]?.message).toContain('步骤产出账本损坏：不是有效 JSON')
  })
})
