/**
 * 回归锚：一次彩排不得顶替一次规格应用。
 *
 * 真机实测（0.1.0，backend/frontend/pm 三条 track 全部走到完结）：`find openspec/specs -type f`
 * 一个文件都没有，而每个 change 目录里都躺着一份 `result: "pass"` 的 `.pipeline-spec-apply.json`
 * ——它是 `tenon spec apply <c> --dry-run` 写的。判定当时只看 `result`，于是：
 *   · `status` 的 next 在 ship 直接发 `scaffold-document applied-spec`（而不是 `apply-spec`），
 *     运行器照做，登记了一份写着「占位内容」的 applied-spec；
 *   · ship 出口的 spec-migration-applied guard 只守着一份历史迁移回执，缺席即 not-required，
 *     对这份 change 自己的应用一言不发；
 *   · 于是 ship-complete 与 archived 一路放行，主规格里什么都没有。
 *
 * 本文件在真 harness 上把那份彩排回执原样摆出来，逐条钉住三个出口：check 拒、status 的出边
 * blockers 点名、transition 不动相位；再换成真应用后三者一起放行。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { sha256Hex } from '@tenon/kernel'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'specgate'
const DELTA = `openspec/changes/${CHANGE}/specs/capability/spec.md`

interface StatusPayload {
  readonly step: {
    readonly exits: readonly {
      readonly event: string
      readonly ready: boolean
      readonly blockers: readonly { readonly source: string; readonly message: string }[]
    }[]
  }
}

describe('ship 出口：delta spec 必须真的应用进主规格', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    await h.seedGovernedDocumentEvidence(CHANGE)
    // 本用例的主题是 ship 的规格应用门，不是前面六相位的推进；相位直接置于 ship。
    await h.seedPhase(CHANGE, 'ship')
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  /** 逐字照搬真机那份 `--dry-run` 回执的形状：同样的 schema、同样的 result=pass，只有 mode 不同。 */
  async function writeRehearsalReceipt(): Promise<void> {
    const delta = await h.readIn(CHANGE, 'specs/capability/spec.md')
    await writeFile(
      join(h.cwd, 'openspec', 'changes', CHANGE, '.pipeline-spec-apply.json'),
      `${JSON.stringify({
        schema: 'tenon-spec-apply-v1',
        change: CHANGE,
        mode: 'dry-run',
        result: 'pass',
        deltas: [{ path: DELTA, sha256: sha256Hex(delta) }],
        targets: [{
          path: 'openspec/specs/capability/spec.md',
          before_sha256: null,
          after_sha256: sha256Hex('# Applied spec\n'),
          change: 'created',
        }],
      }, null, 2)}\n`,
      'utf8',
    )
  }

  async function shipExitBlockers(): Promise<readonly { source: string; message: string }[]> {
    expect(await h.run(['status', CHANGE, '--json']), h.err.join('\n')).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as StatusPayload
    const exit = payload.step.exits.find((candidate) => candidate.event === 'ship-complete')
    expect(exit, 'ship 必须有 ship-complete 出边').toBeDefined()
    return exit?.blockers ?? []
  }

  test('只彩排过：check 拒、status 出边点名、transition 不动相位', async () => {
    await writeRehearsalReceipt()

    expect(await h.run(['check', CHANGE])).toBe(2)
    expect(h.out.join('\n')).toContain('[FAIL] migration: spec-apply-rehearsal-only')

    const blockers = await shipExitBlockers()
    expect(blockers.some((blocker) =>
      blocker.source === 'spec' && blocker.message.includes('spec-apply-rehearsal-only'))).toBe(true)

    expect(await h.run(['transition', CHANGE, 'ship-complete'])).toBe(1)
    expect(h.err.join('\n')).toContain('spec-apply-rehearsal-only')
    expect(await h.read(CHANGE)).toMatch(/^phase: ship$/m)
  })

  test('一次都没跑过 spec apply：同样拒，理由是回执缺失', async () => {
    expect(await h.run(['check', CHANGE])).toBe(2)
    expect(h.out.join('\n')).toContain('[FAIL] migration: spec-apply-receipt-missing')
    expect(await h.run(['transition', CHANGE, 'ship-complete'])).toBe(1)
    expect(await h.read(CHANGE)).toMatch(/^phase: ship$/m)
  })

  test('真应用过：三个出口一起放行', async () => {
    await h.seedAppliedSpec(CHANGE)

    await h.run(['check', CHANGE])
    expect(h.out.join('\n')).not.toContain('migration:')

    expect((await shipExitBlockers()).filter((blocker) => blocker.source === 'spec')).toEqual([])

    expect(await h.run(['transition', CHANGE, 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.read(CHANGE)).toMatch(/^phase: archive$/m)
  })
})
