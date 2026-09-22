/**
 * 回归锚：`tenon status <change> --json` 的 step 分块不许被一条路径还定不下来的文档整块带走。
 *
 * 真机实测（v0.1.0 acceptance run）：phase=spec、delta-spec 还没登记时，命令打
 *   WARN: step 投影不可用: document kind 'delta-spec' 路径缺少 'capability'
 * 然后输出里**没有 step**。数据驱动的执行者在 spec 相位因此一无所得——和技能门那个 P0 同一类：
 * 本该告诉执行者「这一步做什么」的投影，一句话都不说。
 *
 * delta-spec 的 `{capability}` 由作者拍板（`tenon document scaffold <c> delta-spec --capability
 * <x>` 要求它，没有默认值），所以此刻本来就定不下来：投影要如实说 path=null 并给出模板，而不是抛。
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'specproj'

interface StatusJson {
  readonly step?: {
    readonly id: string
    readonly documents: {
      readonly records: readonly {
        readonly kind: string
        readonly path: string | null
        readonly path_template: string
      }[]
    }
    readonly next: readonly { readonly action: string }[]
  }
}

describe('status --json 的 step 投影：路径未定的文档', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
    expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
    expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
    expect(await h.seedPhase(CHANGE, 'spec')).toBeUndefined()
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('phase=spec 且 delta-spec 未登记时，step 仍然产出，delta-spec 的 path 为 null', async () => {
    expect(await h.run(['status', CHANGE, '--json'])).toBe(0)
    expect(h.err.join('\n')).not.toContain('step 投影不可用')
    const payload = JSON.parse(h.out.join('\n')) as StatusJson
    expect(payload.step, 'step 分块必须存在，否则执行者在 spec 相位一无所得').toBeDefined()
    expect(payload.step?.id).toBe('spec')
    const delta = payload.step?.documents.records.find((doc) => doc.kind === 'delta-spec')
    expect(delta).toBeDefined()
    expect(delta?.path).toBeNull()
    expect(delta?.path_template).toBe('openspec/changes/{change}/specs/{capability}/spec.md')
    expect(payload.step?.next.length, 'next 必须有可执行动作').toBeGreaterThan(0)
  })
})
