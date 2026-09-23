/**
 * 技能与产物的绑定：第三轮真机验收里，五条空 PostToolUse（没有工作、没有文件、没有提问）把
 * explore 的五个必需技能全刷成 `done`，`skill-source blockers: []`。那道门只看「调用过没有」。
 *
 * 现在的规则：本步 document 契约点名为 producer 的技能，要在本次步骤访问里登记了它产出的文档
 * 才算完成；本步不产出文档的技能仍以调用为准（没有可以绑定的产物）。`check`、`transition` 与
 * `status` 的 skills / exits / next 读同一份判定。
 *
 * 零 mock：真临时项目、真 kernel、真文档台账；回执落在 PostToolUse hook 最终调用的生产命令上。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FIXED_CLOCK, freshHarness, rm, type Harness } from './integration-harness.js'

const CHANGE = 'bare'

interface StepSkill {
  readonly id: string
  readonly status: string
  readonly pending_documents: readonly string[]
}

interface StepBlock {
  readonly id: string
  readonly skills: readonly StepSkill[]
  readonly exits: readonly { readonly event: string; readonly blockers: readonly { readonly code: string; readonly message: string }[] }[]
  readonly next: readonly { readonly action: string; readonly [key: string]: unknown }[]
}

let h: Harness
let seq = 0

function changeDir(): string {
  return join(h.cwd, 'openspec', 'changes', CHANGE)
}

async function run(args: readonly string[]): Promise<void> {
  const code = await h.run([...args])
  if (code !== 0) throw new Error(`tenon ${args.join(' ')} exit=${code}\n${h.err.join('\n')}\n${h.out.join('\n')}`)
}

/** 一条空的 PostToolUse：只有调用回执，没有任何产物。 */
async function bareReceipt(skill: string): Promise<void> {
  seq += 1
  await appendFile(
    join(changeDir(), '.pipeline-history.jsonl'),
    `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: `Skill: ${skill}` })}\n`,
    'utf8',
  )
  await run(['internal-native-skill-receipt', CHANGE, skill, 'bare-session', `tool-${seq}`, FIXED_CLOCK])
}

async function step(): Promise<StepBlock> {
  await run(['status', CHANGE, '--json'])
  const payload = JSON.parse(h.out.join('\n')) as { step?: StepBlock }
  if (payload.step === undefined) throw new Error(`status 没有 step 分块\n${h.out.join('\n')}`)
  return payload.step
}

function skill(block: StepBlock, id: string): StepSkill | undefined {
  return block.skills.find((candidate) => candidate.id === id)
}

async function recordAs(kind: string, path: string, producer: string): Promise<void> {
  const abs = join(h.cwd, path)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, kind === 'tasks' ? '- [x] scope\n- [x] implementation\n- [x] verification\n' : `# ${kind}\n\nbody\n`, 'utf8')
  await run(['document', 'record', CHANGE, kind, path, '--producer', producer])
}

beforeEach(async () => {
  seq = 0
  h = await freshHarness()
  expect(await h.run(['init', CHANGE, '--track', 'backend', '--preset', 'full'])).toBe(0)
  expect(await h.run(['session', 'activate', CHANGE])).toBe(0)
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

describe('必需技能 = 调用 + 本步绑定的产物', () => {
  test('空回执：producer 技能停在 invoked，check / transition / status 都点名缺的文档', async () => {
    await bareReceipt('tenon')
    await bareReceipt('openspec-propose')

    const open = await step()
    expect(open.id).toBe('open')
    expect(skill(open, 'openspec-propose')).toEqual(expect.objectContaining({
      status: 'invoked',
      pending_documents: ['proposal', 'openspec-design', 'tasks'],
    }))
    // 剩下的动作是它的文档，不是再调用一次同一个技能。
    expect(open.next.map((action) => action.action)).not.toContain('load-skill')
    expect(open.next).toContainEqual(expect.objectContaining({
      action: 'record-document', kind: 'proposal', skill: 'openspec-propose',
    }))
    const skillBlockers = open.exits.flatMap((exit) => exit.blockers).filter((item) => item.code === 'skill-incomplete')
    expect(skillBlockers.map((item) => item.message)).toContainEqual(
      expect.stringMatching(/openspec-propose（已调用，本次步骤访问尚未登记它产出的 document：proposal, openspec-design, tasks）/u),
    )

    expect(await h.run(['check', CHANGE])).toBe(2)
    expect(h.out.join('\n')).toMatch(/尚未完成声明的 skill：openspec-propose（已调用.*proposal, openspec-design, tasks）/u)

    // 让 open 的出口规则（tasks 全勾）先过，transition 才走到技能门。
    await writeFile(join(changeDir(), 'tasks.md'), '- [x] scope\n- [x] implementation\n- [x] verification\n', 'utf8')
    expect(await h.run(['transition', CHANGE, 'open-complete'])).not.toBe(0)
    expect(h.err.join('\n')).toMatch(/openspec-propose（已调用.*proposal, openspec-design, tasks）/u)
  })

  test('登记了它的产物才完成；本步不产出文档的技能调用即完成', async () => {
    await bareReceipt('tenon')
    await bareReceipt('openspec-propose')
    const base = `openspec/changes/${CHANGE}`
    await recordAs('proposal', `${base}/proposal.md`, 'openspec-propose')
    await recordAs('openspec-design', `${base}/design.md`, 'openspec-propose')
    expect(skill(await step(), 'openspec-propose')).toEqual(expect.objectContaining({
      status: 'invoked', pending_documents: ['tasks'],
    }))
    await recordAs('tasks', `${base}/tasks.md`, 'openspec-propose')
    expect(skill(await step(), 'openspec-propose')).toEqual(expect.objectContaining({
      status: 'done', pending_documents: [],
    }))
    await run(['transition', CHANGE, 'open-complete'])

    // explore：验收那一轮的五条空回执。
    await bareReceipt('tenon')
    for (const id of ['openspec-explore', 'brainstorming', 'grilling', 'domain-modeling', 'codebase-design']) {
      await bareReceipt(id)
    }
    const explore = await step()
    expect(explore.id).toBe('explore')
    // brainstorming 是本步 superpower-design / adr 的 producer：只调用不算完成。
    expect(skill(explore, 'brainstorming')).toEqual(expect.objectContaining({
      status: 'invoked', pending_documents: ['superpower-design', 'adr'],
    }))
    // 这几个本步不产出任何文档，没有可以绑定的产物，调用即完成。
    for (const id of ['openspec-explore', 'grilling', 'domain-modeling', 'codebase-design']) {
      expect(skill(explore, id)?.status, id).toBe('done')
    }
    const forward = explore.exits.find((exit) => exit.event === 'explore-complete')
    expect(forward?.blockers).toContainEqual(expect.objectContaining({
      code: 'skill-incomplete',
      message: expect.stringMatching(/brainstorming（已调用.*superpower-design, adr）/u),
    }))
    expect(await h.run(['check', CHANGE])).toBe(2)
    expect(h.out.join('\n')).toMatch(/brainstorming（已调用.*superpower-design, adr）/u)
  })
})
