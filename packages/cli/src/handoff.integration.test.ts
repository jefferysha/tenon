/**
 * handoff 上下文压缩 —— 真实端到端集成测试（BACKLOG #30 / GOAL B13·D11 / C9：无伪测试）。
 *
 * 零 mock：freshHarness 真临时项目 + 真 `init`/`set`/`transition`（走 buildProgram 真路径达到
 * build/verify 相位）+ 真建长 design_doc/plan/verification_report 文档 + realDeps 真 kernel deps +
 * 真调 cmdHandoff（默认 nodeHandoffFs 真读磁盘字节）。断言真实压缩摘要内容（关键决策/约束/待办
 * 保留、样板正文去除）+ 真实压缩率达标（≥25%，对齐 Tenon runtime CONTEXT-COMPRESSION 25-30%）。
 *
 * 覆盖（C10）：build handoff（design→build 真转换链）happy + 压缩率门 + JSON 信封；
 * verify handoff（--phase 覆写 + change 目录 changefile 解析）；边界（无文档 / 非法名 / 缺 change）；
 * 跨命令串联 init→transition×2→set×2→handoff 全程。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { freshHarness, realDeps, rm, type Harness } from './integration-harness.js'
import { cmdHandoff, type HandoffOpts } from './commands/handoff.js'

interface HandoffRun {
  code: number
  out: string[]
  err: string[]
}

/** 真调 cmdHandoff（realDeps 真 kernel + 默认 nodeHandoffFs 真读文件）。 */
async function handoff(h: Harness, name: string | undefined, opts: HandoffOpts = {}): Promise<HandoffRun> {
  const out: string[] = []
  const err: string[] = []
  const code = await cmdHandoff(realDeps(h.cwd, out, err), name, opts)
  return { code, out, err }
}

async function init(h: Harness, name: string): Promise<void> {
  expect(await h.run(['init', name, '--track', 'backend', '--preset', 'full'])).toBe(0)
}

/** Build handoff needs to traverse two review exits; use the public request/ack protocol, not a state fixture. */
async function approveReviewExit(h: Harness, name: string, event: string): Promise<void> {
  // 步骤声明的执行者（explore 的 researcher）先办完，评审请求的预检才会过。
  await h.satisfyStepAgents(name)
  expect(await h.run(['review', 'request', name, '--event', event])).toBe(0)
  expect(await h.run(['review', 'acknowledge', name])).toBe(0)
}

function changeFile(h: Harness, name: string, rel: string): string {
  return join(h.cwd, 'openspec', 'changes', name, rel)
}

// 真实的、样板密集的 design 文档：大量叙述正文（应被压掉）+ 少量决策/约束/待办（应保留）。
const DESIGN_DOC = [
  '# Design: Deterministic Context Compression',
  '',
  '## Background',
  '',
  'This document captures the design for compressing upstream phase artefacts before',
  'they are handed to the next phase. The narrative below explains context that the',
  'downstream builder does not strictly need but which motivated the work over time.',
  'It repeats and elaborates on the same motivation across several sentences so that a',
  'reader unfamiliar with the history can follow along without any external references.',
  'Much of this prose is scaffolding that carries no actionable signal for the builder.',
  '',
  '## Motivation',
  '',
  'Handing an entire design document to the build phase wastes token budget and buries',
  'the few load-bearing decisions under paragraphs of exposition. The paragraphs here',
  'are intentionally verbose to model a realistic long-form design document body that a',
  'compressor must strip down while preserving the decisions and constraints verbatim.',
  '',
  '## Decisions',
  '',
  'We decided to compress upstream documents deterministically at phase handoff.',
  'Decision: keep the compressor pure and zero-LLM so the output is oracle-verifiable.',
  'We chose character count as the token proxy to avoid a tokenizer dependency.',
  '',
  '## Constraints',
  '',
  '- The kernel MUST remain zero third-party runtime dependency.',
  '- Compression MUST NOT drop any decision or constraint line.',
  '- 禁止引入通用 yaml 解析器，沿用窄解析器口径。',
  '',
  '## Coverage',
  '',
  '```coverage',
  'touches:',
  'L1_api: filled',
  'L2_data: filled',
  'L3_rules: filled',
  'L4_state: filled',
  'L5_errors: filled',
  'L6_security: filled',
  'L7_perf: filled',
  'L8_deps: filled',
  'L10_terms: filled',
  '```',
  '',
  '## Tasks',
  '',
  '- [x] draft the compression rules',
  '- [x] enumerate the phase to document map',
  '- [ ] wire handoff into the transition side-effects',
  '- [ ] record the measured compression ratio in the report',
  '',
  '## Notes',
  '',
  'The remaining notes are additional narrative filler that pads the document body with',
  'even more exposition and background reasoning that the builder can safely ignore now,',
  'because everything load-bearing has already been captured under the sections above.',
].join('\n')

// The default document contract requires OpenSpec tasks as a real, readable upstream input.
// Keep this fixture prose-heavy so it participates honestly in the compression-ratio assertions.
const TASKS_DOC = [
  '# OpenSpec Tasks',
  '',
  '## Context',
  '',
  'This checklist captures the delivery work after the design and plan have been agreed. The',
  'surrounding narrative intentionally explains familiar context at length so the compression',
  'test can prove that the small actionable checklist survives while this exposition is removed.',
  'The builder does not need to carry this repeated background into the next phase once the',
  'decisions, constraints, and completion state are already represented by the checklist.',
  '',
  '## Checklist',
  '',
  '- [x] confirm the OpenSpec proposal and design scope',
  '- [x] implement the governed workflow document ledger',
  '- [x] verify the default pipeline reads its required evidence',
  '',
  '## Notes',
  '',
  'The remaining notes are deliberate narrative filler describing the same workflow context in',
  'more words than the downstream implementation phase needs. They should not dominate the',
  'handoff, because the completed tasks above already convey the actionable state precisely.',
].join('\n')

const PLAN_DOC = [
  '# Plan: Build the Handoff Command',
  '',
  '## Overview',
  '',
  'This plan sketches the implementation sequence. The overview prose restates the goal',
  'in narrative form and provides context that duplicates the design document body, which',
  'is exactly the kind of boilerplate a downstream-facing compressor is expected to remove.',
  'Several more sentences of filler follow to make the plan resemble a real planning doc.',
  '',
  '## Steps',
  '',
  'The steps below elaborate each stage in prose before the actionable checklist, again',
  'padding the body with explanatory narrative that the builder does not need to re-read.',
  '',
  'Decision: implement the kernel compressor before the CLI shell.',
  '',
  '- The CLI command MUST reuse the injected StateStore for reading fields.',
  '- [ ] implement cmdHandoff CLI shell',
  '- [ ] add the JSON envelope for programmatic downstream consumption',
  '',
  '## Risks',
  '',
  'The risks section is more narrative filler describing hypothetical failure modes in',
  'long-winded prose so that the plan document is dominated by droppable exposition text.',
].join('\n')

const VERIFICATION_REPORT = [
  '# Verification Report',
  '',
  '## Summary',
  '',
  'This report narrates the verification outcome across several sentences of prose that',
  'the ship phase can safely skip. The narrative padding here models a realistic report',
  'body dominated by exposition, with only a couple of load-bearing lines worth keeping.',
  '',
  '## Result',
  '',
  'Conclusion: all guard gates pass and the build SHA matches HEAD at verify time.',
  '- The release MUST NOT proceed until branch_status is handled.',
  '',
  '## Follow-ups',
  '',
  '- [ ] archive the change after ship completes',
].join('\n')

describe('真实 e2e —— build handoff（design→build 真转换链 + 压缩率门）', () => {
  let h: Harness
  const name = 'ctx-compress'

  beforeEach(async () => {
    h = await freshHarness()
    await init(h, name)
    await h.seedGovernedDocumentEvidence(name, { design: DESIGN_DOC, tasks: TASKS_DOC })
    // 真转换链 open → explore → spec → build（满足事件前置：design_doc/plan 字段 + 文件真实存在）
    expect(await h.run(['transition', name, 'open-complete'])).toBe(0)
    // design/tasks were written before their real ledger records so their evidence remains fresh.
    await h.seedArtifact(name, 'design_doc', `openspec/changes/${name}/design.md`) // P6：artifact 白盒预置
    await approveReviewExit(h, name, 'explore-complete')
    expect(await h.run(['transition', name, 'explore-complete'])).toBe(0)
    await writeFile(changeFile(h, name, 'plan.md'), PLAN_DOC, 'utf8')
    await h.seedArtifact(name, 'plan', `openspec/changes/${name}/plan.md`) // P6：artifact 白盒预置
    await approveReviewExit(h, name, 'spec-complete')
    expect(await h.run(['transition', name, 'spec-complete'])).toBe(0)
    // 落到 build 相位（真读盘验证）
    expect(await h.read(name)).toContain('phase: build')
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('text：真压缩治理产出（plan + design_doc + OpenSpec tasks），决策/约束/待办保留，样板去除', async () => {
    const r = await handoff(h, name)
    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain(`# 交接摘要: ${name}（阶段 build）`)
    // 关键决策逐字保留
    expect(out).toContain('We decided to compress upstream documents deterministically at phase handoff.')
    expect(out).toContain('Decision: keep the compressor pure and zero-LLM so the output is oracle-verifiable.')
    expect(out).toContain('Decision: implement the kernel compressor before the CLI shell.')
    // 约束保留（含 ZH）
    expect(out).toContain('The kernel MUST remain zero third-party runtime dependency.')
    expect(out).toContain('禁止引入通用 yaml 解析器，沿用窄解析器口径。')
    // 开 todo 保留、闭 todo 不出现在开列表
    expect(out).toContain('- [ ] wire handoff into the transition side-effects')
    expect(out).not.toContain('draft the compression rules') // 已完成项被压掉
    // 样板正文去除
    expect(out).not.toContain('narrative filler')
    expect(out).not.toContain('scaffolding that carries no actionable signal')
    expect(out).not.toContain('hypothetical failure modes')
  })

  test('真实压缩率达标：聚合 ≥ 25%（对齐 Tenon runtime 25-30%）', async () => {
    const r = await handoff(h, name, { json: true })
    expect(r.code).toBe(0)
    const env = JSON.parse(r.out.join('\n'))
    expect(env.change).toBe(name)
    expect(env.phase).toBe('build')
    expect(env.docs).toHaveLength(3)
    // 聚合压缩率真实测量 ≥ 0.25
    expect(env.aggregate.ratio).toBeGreaterThanOrEqual(0.25)
    expect(env.aggregate.originalChars).toBeGreaterThan(env.aggregate.compressedChars)
    // 逐文档也压缩（prose-heavy）
    for (const d of env.docs) {
      expect(d.stats.ratio).toBeGreaterThanOrEqual(0.25)
    }
  })

  test('JSON 信封结构化：headings/decisions/constraints/openTodos/keyFields 分桶可编程消费', async () => {
    const r = await handoff(h, name, { json: true })
    const env = JSON.parse(r.out.join('\n'))
    const design = env.docs.find((d: { path: string }) => d.path.endsWith('design.md'))
    expect(design).toBeDefined()
    expect(design.decisions).toContain('We chose character count as the token proxy to avoid a tokenizer dependency.')
    expect(design.constraints).toContain('Compression MUST NOT drop any decision or constraint line.')
    expect(design.openTodos).toEqual([
      'wire handoff into the transition side-effects',
      'record the measured compression ratio in the report',
    ])
    expect(design.doneTodoCount).toBe(2)
    expect(design.headings).toContain('# Design: Deterministic Context Compression')
    expect(design.headings).toContain('## Constraints')
  })
})

describe('真实 e2e —— verify handoff（--phase 覆写 + change 目录 changefile 解析）', () => {
  let h: Harness
  const name = 'vr-handoff'

  beforeEach(async () => {
    h = await freshHarness()
    await init(h, name)
    // 只需字段 + 文件真实存在；用 --phase verify 覆写，免去 build-complete 的重前置
    await writeFile(changeFile(h, name, 'verification_report.md'), VERIFICATION_REPORT, 'utf8')
    await h.seedArtifact(name, 'verification_report', `openspec/changes/${name}/verification_report.md`) // P6：artifact 白盒预置
    // change 目录内 tasks.md（changefile 候选，验证目录相对解析）
    await writeFile(changeFile(h, name, 'tasks.md'), '# Tasks\n\nnarrative intro prose here.\n\n- [ ] ship it\n', 'utf8')
  })

  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('--phase verify：压 verification_report（field）+ tasks.md（changefile），结论/约束保留', async () => {
    const r = await handoff(h, name, { phase: 'verify', json: true })
    expect(r.code).toBe(0)
    const env = JSON.parse(r.out.join('\n'))
    expect(env.phase).toBe('verify')
    const paths = env.docs.map((d: { path: string }) => d.path)
    // field（verification_report）与 changefile（tasks.md）都解析到
    expect(paths).toContain(`openspec/changes/${name}/verification_report.md`)
    expect(paths).toContain(`openspec/changes/${name}/tasks.md`)
    const vr = env.docs.find((d: { path: string }) => d.path.endsWith('verification_report.md'))
    expect(vr.decisions).toContain('Conclusion: all guard gates pass and the build SHA matches HEAD at verify time.')
    expect(vr.constraints).toContain('The release MUST NOT proceed until branch_status is handled.')
  })
})

describe('真实 e2e —— 边界与错误路径', () => {
  let h: Harness

  beforeEach(async () => {
    h = await freshHarness()
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('新 init（open 相位）→ 自动生成的 OpenSpec proposal 可作为 handoff、exit 0', async () => {
    await init(h, 'fresh')
    const r = await handoff(h, 'fresh')
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('# 交接摘要: fresh（阶段 open）')
    expect(r.out.join('\n')).toContain('openspec/changes/fresh/proposal.md')
    expect(r.err).toEqual([])
  })

  test('显式英文 Change 的 handoff 保持英文', async () => {
    expect(await h.run([
      'init', 'english-handoff', '--track', 'backend', '--preset', 'full',
      '--document-locale', 'en',
    ])).toBe(0)
    const r = await handoff(h, 'english-handoff')
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('# Handoff: english-handoff (phase open)')
    expect(r.out.join('\n')).toContain('# Compression:')
  })

  test('非法 change 名 → exit 1', async () => {
    const r = await handoff(h, 'bad/../x')
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('change-name')
  })

  test('不存在的 change → exit 1', async () => {
    const r = await handoff(h, 'ghost')
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('ERROR')
  })
})
