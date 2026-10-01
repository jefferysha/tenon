/**
 * 批量命令 `tenon step run` 与 `tenon document record <c> --all`：真临时项目、真文档台账、真技能回执。
 *
 * 验收：一次 `step run` 铺完当前步骤的文档骨架；骨架没填完时停在「等作者」而不是报错；写完之后一次登记全部；
 * 重复跑什么都不改（幂等）；登记被拒的那份如实报出、其余照常登记。每一步都与逐份的 `document scaffold` /
 * `document record` 是同一批命令函数，台账里的结果相同。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'doc-batch'
const DOCS: Readonly<Record<string, string>> = {
  proposal: `openspec/changes/${CHANGE}/proposal.md`,
  'openspec-design': `openspec/changes/${CHANGE}/design.md`,
  tasks: `openspec/changes/${CHANGE}/tasks.md`,
}

interface StepRunJson {
  readonly did: readonly { readonly action: string; readonly command: string; readonly ok: boolean; readonly detail: string }[]
  readonly stopped: { readonly kind: string; readonly action: string; readonly reason: string } | null
  readonly step: { readonly id: string; readonly next: readonly { readonly action: string; readonly [key: string]: unknown }[] }
}

let h: Harness
let seq = 0
beforeEach(async () => { h = await freshHarness() })
afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

const changeDir = (): string => join(h.cwd, 'openspec', 'changes', CHANGE)

async function put(rel: string, body: string): Promise<void> {
  const abs = join(h.cwd, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, body, 'utf8')
}

/** 宿主加载一个技能（hook 的历史行 + 内部回执命令），时间跟 harness 的固定时钟走。 */
async function loadSkill(skill: string): Promise<void> {
  seq += 1
  await appendFile(join(changeDir(), '.pipeline-history.jsonl'), `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: `Skill: ${skill}` })}\n`, 'utf8')
  expect(await h.run(['internal-native-skill-receipt', CHANGE, skill, 'batch-session', `tool-${seq}`, FIXED_CLOCK]), h.err.join('\n')).toBe(0)
}

async function stepRun(): Promise<StepRunJson> {
  expect(await h.run(['step', 'run', CHANGE, '--json']), h.err.join('\n')).toBe(0)
  return JSON.parse(h.out.join('\n')) as StepRunJson
}

async function startOpen(): Promise<void> {
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full']), h.err.join('\n')).toBe(0)
  expect(await h.run(['session', 'activate', CHANGE, '--host-session', 'batch-session']), h.err.join('\n')).toBe(0)
}

/** 作者把骨架写成真内容（tasks 的 Open 段全勾）。 */
async function authorDocuments(): Promise<void> {
  await put(DOCS.proposal!, '# proposal\n\n## Why\n\nThe batch commands need a durable example.\n')
  await put(DOCS['openspec-design']!, '# design\n\n## Hypothesis\n\nOne call can scaffold and record.\n')
  await put(DOCS.tasks!, '## Open\n- [x] scope\n## Build\n- [ ] implementation\n## Verify\n- [ ] verification\n## Ship\n- [ ] ship\n')
}

describe('tenon step run', () => {
  test('宿主该做的事它不代做：只给原因和最新的 next，什么都不改', async () => {
    await startOpen()
    const first = await stepRun()
    expect(first.did).toEqual([])
    expect(first.stopped).toMatchObject({ kind: 'host', action: 'load-tenon' })
    expect(first.step.next[0]).toMatchObject({ action: 'load-tenon' })
    await loadSkill('tenon')
    const second = await stepRun()
    expect(second.did).toEqual([])
    expect(second.stopped).toMatchObject({ kind: 'host', action: 'load-skill' })
    expect(second.step.next[0]).toMatchObject({ action: 'load-skill', skill: 'openspec-propose' })
  })

  test('一次铺齐本步缺的文档骨架；骨架没填完停在「等作者」，不是失败（退出码 0）', async () => {
    await startOpen()
    await loadSkill('tenon')
    await loadSkill('openspec-propose')
    // 删掉 init 铺好的两份骨架：step run 一次补齐，而不是在第一份的占位符上就停下。
    await rm(join(h.cwd, DOCS.proposal!), { force: true })
    await rm(join(h.cwd, DOCS.tasks!), { force: true })
    const run = await stepRun()
    expect(run.did.filter((item) => item.action === 'scaffold-document').map((item) => item.command)).toEqual([
      `tenon document scaffold ${CHANGE} proposal`, `tenon document scaffold ${CHANGE} tasks`,
    ])
    for (const path of Object.values(DOCS)) expect(await readFile(join(h.cwd, path), 'utf8')).toMatch(/待填写|pending|将本阶段目标拆成可验证任务/u)
    expect(run.stopped).toMatchObject({ kind: 'author', action: 'record-document' })
    expect(run.stopped?.reason).toContain('占位符')
    // 再跑一次：没有新的骨架要铺，也没有可登记的，什么都不改。
    const again = await stepRun()
    expect(again.did).toEqual([])
    expect(again.stopped).toMatchObject({ kind: 'author' })
  })

  test('作者写完后一次 step run 登记全部文档；之后重复跑不改任何东西', async () => {
    await startOpen()
    await loadSkill('tenon')
    await loadSkill('openspec-propose')
    await stepRun()
    await authorDocuments()
    const run = await stepRun()
    expect(run.did.filter((item) => item.action === 'record-document' && item.ok)).toHaveLength(3)
    expect(run.stopped).toMatchObject({ kind: 'work', action: 'transition' })
    expect(run.step.next[0]).toMatchObject({ action: 'transition', event: 'open-complete' })
    const ledger = await readFile(join(changeDir(), '.pipeline-documents.json'), 'utf8')
    for (const kind of Object.keys(DOCS)) expect(ledger).toContain(`"kind": "${kind}"`)
    const before = await readFile(join(changeDir(), '.pipeline-documents.json'), 'utf8')
    const again = await stepRun()
    expect(again.did).toEqual([])
    expect(await readFile(join(changeDir(), '.pipeline-documents.json'), 'utf8')).toBe(before)
  })

  test('人读输出写明做了什么、停在哪、下一步', async () => {
    await startOpen()
    await loadSkill('tenon')
    await loadSkill('openspec-propose')
    expect(await h.run(['step', 'run', CHANGE]), h.err.join('\n')).toBe(0)
    const text = h.out.join('\n')
    expect(text).toContain(`[STEP] ${CHANGE} · open`)
    expect(text).toContain('没有可批量做的事，什么都没改。') // 骨架 init 已经铺好、剩下的要作者来填
    expect(text).toContain('占位符')
    expect(text).toContain('停下：')
    expect(text).toContain('下一步（step.next）：')
  })

  test('任务不存在 / 非法名字：退出码 1 和一句人话', async () => {
    expect(await h.run(['step', 'run', 'nope'])).toBe(1)
    expect(h.err.join('\n')).toContain('change 不存在: nope')
    expect(await h.run(['step', 'run', 'bad name'])).toBe(1)
  })
})

describe('tenon document record <change> --all', () => {
  test('文件还没写 / 骨架没填完：列出并跳过，退出码 0；写完后一次登记全部；再跑无事可做', async () => {
    await startOpen()
    await loadSkill('tenon')
    await loadSkill('openspec-propose')
    await rm(join(h.cwd, DOCS.tasks!), { force: true })
    expect(await h.run(['document', 'record', CHANGE, '--all']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('0/3 份已登记')
    expect(h.out.join('\n')).toContain('文件还没写')
    expect(h.out.join('\n')).toContain('骨架里还有')

    await stepRun() // 补齐被删的骨架
    expect(await readFile(join(h.cwd, DOCS.tasks!), 'utf8')).toContain('将本阶段目标拆成可验证任务')

    await authorDocuments()
    expect(await h.run(['document', 'record', CHANGE, '--all']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('3/3 份已登记')

    expect(await h.run(['document', 'record', CHANGE, '--all']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('没有待登记的文档')
    expect(await h.run(['document', 'status', CHANGE]), h.out.join('\n')).toBe(0)
  })

  test('某一份被拒（producer 不对）如实报出并退出 2，其余文档照常登记', async () => {
    await startOpen()
    await loadSkill('tenon')
    await loadSkill('openspec-propose')
    await stepRun()
    await authorDocuments()
    expect(await h.run(['document', 'record', CHANGE, '--all', '--producer', 'no-such-skill'])).toBe(2)
    expect(h.out.join('\n')).toContain('[FAIL]')
    // 没有留下半截登记：用正确的 producer 重来一次全部成功。
    expect(await h.run(['document', 'record', CHANGE, '--all']), h.err.join('\n')).toBe(0)
    expect(h.out.join('\n')).toContain('3/3 份已登记')
  })

  test('参数分派：--all 不带 kind / path；逐份登记缺参数时给出用法', async () => {
    await startOpen()
    expect(await h.run(['document', 'record', CHANGE, 'proposal', '--all'])).toBe(1)
    expect(h.err.join('\n')).toContain('--all 不带 kind / path')
    expect(await h.run(['document', 'record', CHANGE, 'proposal'])).toBe(1)
    expect(h.err.join('\n')).toContain('用法：tenon document record')
  })
})
