/**
 * 真实 e2e —— transition 全副作用面（BACKLOG #14，GOAL C9 无伪测试）。
 * 零 mock：freshHarness 真临时项目，真跑 init/set/transition，断言真实落盘的
 * canonical current 字段值 + .pipeline.yaml 兼容投影 + .pipeline-history.jsonl。默认轨行为 oracle = 老仓
 * skills/pipeline/scripts/state-transition.sh cmd_transition 的 case 块（行号见
 * commands/transition.ts 顶部盘点表）：
 *   explore-complete   校验 design_doc 非空/非 null/文件存在（老仓 L120-126）
 *   spec-complete      track≠pm 校验 plan（L127-138）
 *   build-complete     build_mode/isolation 已设 + isolation 枚举 + full·direct→
 *                      direct_override=true + pre-Verify 全量收敛 pass + build_sha 冻结（L139-162）
 *   verify-pass        verification_report / branch_status=handled / 非 pm 双 review=pass /
 *                      barrier HEAD==build_sha + verify_result=pass + verified_at（L163-205）
 *   verify-fail        verify_result=fail + build_sha=null + phase_status=in_progress（L206-211）
 *   archived           archived=true + archived_at + phase_status=done（L212-218）
 * 校验失败 = exit 1 + ERROR 走 stderr + canonical/YAML 均不变（老仓 case 校验先于任何写）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  FIXED_CLOCK,
  TEST_GIT_BUILD_TOKEN,
  freshHarness,
  realDeps,
  rm,
  type Harness,
} from './integration-harness.js'

let h: Harness

// This suite performs several real filesystem/CLI transitions per case. Its measured
// single-file runtime exceeds Vitest's 5s default; timing out leaves the asynchronous
// harness cleanup racing the next case and produces misleading ENOTEMPTY failures.

beforeEach(async () => {
  h = await freshHarness()
})

afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
})

/** 在临时项目里真建一个文件（字段指向的 design/plan/report 产物） */
async function seed(rel: string, content = '# doc\n'): Promise<void> {
  const p = join(h.cwd, rel)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, content, 'utf8')
}

/** 直改 YAML adapter 后显式导入 canonical（绕过 set 闸，构造 transition 防线的脏输入）。 */
async function corruptField(name: string, field: string, value: string): Promise<void> {
  const dir = join(h.cwd, 'openspec', 'changes', name)
  // Protected transition fields cannot be imported from the legacy projection anymore. For
  // this barrier test, mutate the canonical fixture under its repository lock to model a
  // corrupted persisted revision without reopening the import-legacy bypass.
  if (field === 'build_sha') {
    const deps = realDeps(h.cwd, [], [])
    await deps.store.withLock(dir, async () => {
      const state = await deps.store.read(dir)
      state.fields.build_sha = value
      await deps.store.writeUnderLock(dir, state, { kind: 'set-many' })
    })
    return
  }
  const p = join(dir, '.pipeline.yaml')
  const yaml = await readFile(p, 'utf8')
  const next = yaml.replace(new RegExp(`^${field}: .*$`, 'm'), `${field}: ${value}`)
  expect(next).not.toBe(yaml) // 保证真的改到了
  await writeFile(p, next, 'utf8')
  // G1 后 current 是唯一真相源；直接改 adapter 必须被隔离为 drift。这个用例要验证的是
  // transition 自身的纵深校验，因此经显式 legacy-import 把脏值变成一条可审计 canonical mutation。
  await realDeps(h.cwd, [], []).store.importLegacyProjection(dir)
}

/** 所有 default transition 测试显式播种真实 hash/read ledger；各用例仍可单独构造事件前置失败。 */
async function initGoverned(name: string, track: 'backend' | 'pm' = 'backend', preset = 'full'): Promise<void> {
  expect(await h.run(['init', name, '--track', track, '--preset', preset])).toBe(0)
  await h.seedGovernedDocumentEvidence(name)
}

/**
 * 测试里的真人确认等价物：先让真实 `review request` 通过当前 phase 的完整检查，再用真实
 * `acknowledge` 写入 exact-phase-and-event receipt。不能用 store 白盒直接塞 approved，否则这组 e2e 会漏掉
 * CLI 协议与 receipt 消费的接线错误。
 */
async function approveReviewExit(name: string, event: string): Promise<void> {
  // `review request` 的预检就是整份 check（含测试证据与 agent 结论），所以先跑该步声明的测试与
  // agent——真实用户同样是先把两者办完再请求评审。
  await h.satisfyStepTests(name, event.replace(/-(complete|pass|fail)$/u, ''))
  await h.satisfyStepAgents(name)
  const request = await h.run(['review', 'request', name, '--event', event])
  if (request !== 0) throw new Error(`review request failed (${request}): ${[...h.err, ...h.out].join('\n')}`)
  const acknowledge = await h.run(['review', 'acknowledge', name])
  if (acknowledge !== 0) throw new Error(`review acknowledge failed (${acknowledge}): ${[...h.err, ...h.out].join('\n')}`)
}

/** 按老仓 case 块前置，把 change 从 open 推进到目标相位（步骤对齐 oracle backend-full fixture） */
async function advanceTo(name: string, phase: 'explore' | 'spec' | 'build' | 'verify' | 'ship'): Promise<void> {
  expect(await h.run(['transition', name, 'open-complete'])).toBe(0)
  if (phase === 'explore') return
  // Reuse the governed OpenSpec design seeded with the complete coverage block. Review request
  // runs the real phase check, so a generic placeholder would correctly be rejected at spec exit.
  await h.seedArtifact(name, 'design_doc', `openspec/changes/${name}/design.md`)
  await approveReviewExit(name, 'explore-complete')
  expect(await h.run(['transition', name, 'explore-complete'])).toBe(0)
  if (phase === 'spec') return
  await seed('docs/plan.md')
  await h.seedArtifact(name, 'plan', 'docs/plan.md')
  await approveReviewExit(name, 'spec-complete')
  expect(await h.run(['transition', name, 'spec-complete'])).toBe(0)
  if (phase === 'build') return
  await h.run(['set', name, 'build_mode', 'direct'])
  await h.run(['set', name, 'isolation', 'worktree'])
  await h.run(['set', name, 'direct_override', 'true'])
  await h.satisfyStepTests(name, 'build')
  // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
  expect(await h.run(['set', name, 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
  expect(await h.run(['transition', name, 'build-complete'])).toBe(0)
  if (phase === 'verify') return
  await seed('docs/verify.md')
  await h.seedArtifact(name, 'verification_report', 'docs/verify.md')
  await h.run(['set', name, 'branch_status', 'handled'])
  await approveReviewExit(name, 'verify-pass')
  await h.satisfyStepTests(name, 'verify')
    await h.satisfyStepAgents(name)
  expect(await h.run(['transition', name, 'verify-pass'])).toBe(0)
  // Ship 出口要求本 change 的 delta spec 真的应用进主规格；夹具留下 `tenon spec apply` 的产物。
  await h.seedAppliedSpec(name)
  // 非 pm 轨的 ship 出口还要求 pr_url（kernel flow/guard.ts 的 EXIT_RULES，transition 现在也评估）。
  await h.run(['set', name, 'pr_url', 'https://example.com/pr/1'])
}

describe('真实 e2e —— explore-complete 校验（老仓 L120-126）', () => {
  test('design_doc 未设（字面 null）真拒：exit 1、ERROR 对齐老仓、yaml 字节不变', async () => {
    await initGoverned('demo')
    await h.run(['transition', 'demo', 'open-complete'])
    const before = await h.read('demo')
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(1)
    expect(h.err).toContain('ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=null)')
    expect(h.out).toEqual([])
    expect(await h.read('demo')).toBe(before) // 校验先于任何写：字节不变
  })

  test('design_doc 指向不存在文件真拒：exit 1，相位停在 explore', async () => {
    await initGoverned('demo')
    await h.run(['transition', 'demo', 'open-complete'])
    await h.seedArtifact('demo', 'design_doc', 'docs/nope.md') // 不建文件
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(1)
    expect(h.err).toContain('ERROR: explore-complete 要求 design_doc 字段非空且文件存在 (当前=docs/nope.md)')
    expect(await h.read('demo')).toMatch(/^phase: explore$/m)
  })

  test('design_doc 真文件满足 → exit 0，phase=spec + phase_status=pending 落盘', async () => {
    await initGoverned('demo')
    await h.run(['transition', 'demo', 'open-complete'])
    await seed('docs/design.md')
    await h.seedArtifact('demo', 'design_doc', 'docs/design.md')
    await approveReviewExit('demo', 'explore-complete')
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^phase: spec$/m)
    expect(yaml).toMatch(/^phase_status: pending$/m)
  })
})

describe('真实 e2e —— spec-complete 校验（老仓 L127-138）', () => {
  test('backend track 无 plan 真拒：exit 1，ERROR 带 track 名', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'spec')
    expect(await h.run(['transition', 'demo', 'spec-complete'])).toBe(1)
    expect(h.err).toContain('ERROR: backend track spec-complete 要求 plan 字段非空且文件存在 (当前=null)')
    expect(await h.read('demo')).toMatch(/^phase: spec$/m)
  })

  test('pm track 保持原流程的 legacy plan artifact 豁免：无 plan 也可进 build', async () => {
    await initGoverned('pmx', 'pm')
    await advanceTo('pmx', 'spec')
    await approveReviewExit('pmx', 'spec-complete')
    expect(await h.run(['transition', 'pmx', 'spec-complete'])).toBe(0)
    expect(await h.read('pmx')).toMatch(/^phase: build$/m)
  })
})

describe('真实 e2e —— build-complete 校验 + build_sha 冻结（老仓 L139-162）', () => {
  test('缺 build_mode → 缺 isolation → 逐个解锁（首错优先序对齐老仓）', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'build')
    await h.satisfyStepTests('demo', 'build')
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(1)
    expect(h.err).toContain('ERROR: build_mode 必须设置')
    await h.run(['set', 'demo', 'build_mode', 'direct'])
    await h.satisfyStepTests('demo', 'build')
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(1)
    expect(h.err).toContain('ERROR: isolation 必须设置')
    expect(await h.read('demo')).toMatch(/^phase: build$/m)
  })

  test('isolation 非法枚举（绕过 set 闸直改 yaml）→ transition 防线仍拒：exit 1', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'build')
    await h.run(['set', 'demo', 'build_mode', 'direct'])
    await h.run(['set', 'demo', 'isolation', 'branch'])
    await h.run(['set', 'demo', 'direct_override', 'true'])
    await corruptField('demo', 'isolation', 'bogus')
    await h.satisfyStepTests('demo', 'build')
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(1)
    expect(h.err).toContain("ERROR: 非法值 'bogus'，允许: branch worktree in-place")
  })

  test('full preset + build_mode=direct 必须显式 direct_override=true，补设后冻结 build_sha', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'build')
    await h.run(['set', 'demo', 'build_mode', 'direct'])
    await h.run(['set', 'demo', 'isolation', 'worktree'])
    await h.satisfyStepTests('demo', 'build')
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(1)
    expect(h.err).toContain('ERROR: full workflow 使用 build_mode=direct 必须显式设 direct_override=true')
    expect(await h.read('demo')).toMatch(/^build_sha: null$/m) // 拒绝时不冻结
    await h.run(['set', 'demo', 'direct_override', 'true'])
    await h.satisfyStepTests('demo', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'demo', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^phase: verify$/m)
    expect(yaml).toContain(`build_sha: ${TEST_GIT_BUILD_TOKEN}`)
  })

  test('hotfix preset + direct 不要求 direct_override（规则只锁 full）', async () => {
    await initGoverned('demo', 'backend', 'hotfix')
    await advanceTo('demo', 'build')
    await h.run(['set', 'demo', 'build_mode', 'direct'])
    await h.run(['set', 'demo', 'isolation', 'branch'])
    await h.satisfyStepTests('demo', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'demo', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: verify$/m)
  })

  test('full preset + direct + in-place + direct_override 可完成构建出口', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'build')
    await seed('src/app.js', 'export const version = 1\n')
    await h.run(['set', 'demo', 'build_mode', 'direct'])
    await h.run(['set', 'demo', 'isolation', 'in-place'])
    await h.run(['set', 'demo', 'direct_override', 'true'])
    await h.satisfyStepTests('demo', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'demo', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^phase: verify$/m)
    // in-place 没有不可变 Git checkout；必须冻结排除 pipeline 元数据后的工作区内容基线，
    // 不能把同一个 HEAD 错当成仍未漂移的实现目标。
    expect(yaml).toMatch(/^build_sha: build:v1:workspace:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/m)
  })
})

describe('真实 e2e —— verify-pass 校验 + 副作用（老仓 L163-205）', () => {
  test('两前置逐个解锁：report → branch_status（手填评审字段已删除）', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'verify')
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(1)
    expect(h.err).toContain('ERROR: verify-pass 要求 verification_report 字段非空且文件存在 (当前=null)')
    await seed('docs/verify.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify.md')
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(1)
    expect(h.err).toContain('ERROR: verify-pass 要求 branch_status=handled (当前=pending)')
    await h.run(['set', 'demo', 'branch_status', 'handled'])
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    await approveReviewExit('demo', 'verify-pass')
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^phase: ship$/m)
    expect(yaml).toMatch(/^verify_result: pass$/m)
    expect(yaml).toMatch(new RegExp(`^verified_at: ${FIXED_CLOCK}$`, 'm'))
  })

  test('barrier：build_sha≠HEAD 真拒（双行 ERROR），yaml 字节不变', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'verify') // build_sha 已冻结为可信 token
    await seed('docs/verify.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify.md')
    await h.run(['set', 'demo', 'branch_status', 'handled'])
    await approveReviewExit('demo', 'verify-pass')
    await corruptField('demo', 'build_sha', 'CAFEBABE') // 模拟 build 后偷改未复验
    const before = await h.read('demo')
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(1)
    expect(h.err.join('\n')).toContain(
      'ERROR: verify-build-revision-untrusted reason=malformed remediation=return-to-build-and-capture-current-revision',
    )
    expect(h.err.join('\n')).not.toContain('CAFEBABE')
    expect(h.err.join('\n')).toContain('remediation=return-to-build-and-capture-current-revision')
    expect(await h.read('demo')).toBe(before)
  })

  test('in-place barrier：源码在 build 后漂移 → verify-pass 真拒（不是同一个 Git HEAD 假绿）', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'build')
    await seed('src/app.js', 'export const version = 1\n')
    await h.run(['set', 'demo', 'build_mode', 'direct'])
    await h.run(['set', 'demo', 'isolation', 'in-place'])
    await h.run(['set', 'demo', 'direct_override', 'true'])
    await h.satisfyStepTests('demo', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'demo', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^build_sha: build:v1:workspace:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/m)

    await seed('docs/verify.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify.md')
    await h.run(['set', 'demo', 'branch_status', 'handled'])
    await approveReviewExit('demo', 'verify-pass')

    await seed('src/app.js', 'export const version = 2\n')
    const before = await h.read('demo')
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(1)
    expect(h.err.join('\n')).toContain(
      'ERROR: verify-build-revision-untrusted reason=revision-stale remediation=return-to-build-and-capture-current-revision',
    )
    expect(await h.read('demo')).toBe(before)
  })

  test('barrier 缺失：build_sha=null → fail closed，exit 1 且不提交', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'verify')
    await seed('docs/verify.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify.md')
    await h.run(['set', 'demo', 'branch_status', 'handled'])
    // Obtain a valid exact-event receipt while the canonical Build token is still trusted.
    await approveReviewExit('demo', 'verify-pass')
    await corruptField('demo', 'build_sha', 'null')
    const changeDir = join(h.cwd, 'openspec', 'changes', 'demo')
    const recordsPath = join(changeDir, '.pipeline-transitions')
    const recordNames = (await readdir(recordsPath).catch(() => [] as string[])).sort()
    const before = {
      state: await h.read('demo'),
      current: await readFile(join(changeDir, '.pipeline-run', 'current.json'), 'utf8'),
      history: await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8'),
      records: await Promise.all(recordNames.map(async (name) => [name, await readFile(join(recordsPath, name), 'utf8')] as const)),
    }
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(1)
    expect(h.err.join('\n')).toContain(
      'ERROR: verify-build-revision-untrusted reason=null remediation=return-to-build-and-capture-current-revision',
    )
    expect(await h.read('demo')).toBe(before.state)
    expect(await readFile(join(changeDir, '.pipeline-run', 'current.json'), 'utf8')).toBe(before.current)
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toBe(before.history)
    const afterNames = (await readdir(recordsPath).catch(() => [] as string[])).sort()
    expect(afterNames).toEqual(recordNames)
    expect(await Promise.all(afterNames.map(async (name) => [name, await readFile(join(recordsPath, name), 'utf8')] as const)))
      .toEqual(before.records)
  })

  test('pm track 豁免双 review（init 种 skipped 原样通过）', async () => {
    await initGoverned('pmx', 'pm')
    expect(await h.run(['transition', 'pmx', 'open-complete'])).toBe(0)
    await h.seedArtifact('pmx', 'design_doc', 'openspec/changes/pmx/design.md')
    await approveReviewExit('pmx', 'explore-complete')
    expect(await h.run(['transition', 'pmx', 'explore-complete'])).toBe(0)
    await approveReviewExit('pmx', 'spec-complete')
    expect(await h.run(['transition', 'pmx', 'spec-complete'])).toBe(0)
    await h.run(['set', 'pmx', 'build_mode', 'direct'])
    await h.run(['set', 'pmx', 'isolation', 'branch'])
    await h.run(['set', 'pmx', 'direct_override', 'true']) // full+direct 规则不分 track
    await h.satisfyStepTests('pmx', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'pmx', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'pmx', 'build-complete'])).toBe(0)
    await seed('docs/verify.md')
    await h.seedArtifact('pmx', 'verification_report', 'docs/verify.md')
    await h.run(['set', 'pmx', 'branch_status', 'handled'])
    // agent/codex 保持 init 的 skipped —— pm 不要求 pass
    await h.run(['set', 'pmx', 'verify_result', 'pass'])
    await approveReviewExit('pmx', 'verify-pass')
    await h.satisfyStepTests('pmx', 'verify')
    await h.satisfyStepAgents('pmx')
    expect(await h.run(['transition', 'pmx', 'verify-pass'])).toBe(0)
    const yaml = await h.read('pmx')
    expect(yaml).toMatch(/^phase: ship$/m)
    expect(yaml).toMatch(/^verify_result: pass$/m)
  })

  /**
   * 真机实测：两个 pm 任务带着 `prd_path = null` 走完了 ship 与 archive。`tenon check` 当时就在说
   * 「ship 出口：要求 prd_path 非空」，但 ship 步 gate=null、transition 不评估出口规则表，于是
   * 那句话没有任何执行力。这条用例把真实的七相位走完，钉住通往 完结 的那条边现在真的拦得住。
   */
  test('完结：pm 带着 prd_path=null 走不进 archive；补齐 PRD 后才走得进', async () => {
    await initGoverned('pmship', 'pm')
    expect(await h.run(['transition', 'pmship', 'open-complete'])).toBe(0)
    await h.seedArtifact('pmship', 'design_doc', 'openspec/changes/pmship/design.md')
    await approveReviewExit('pmship', 'explore-complete')
    expect(await h.run(['transition', 'pmship', 'explore-complete'])).toBe(0)
    await approveReviewExit('pmship', 'spec-complete')
    expect(await h.run(['transition', 'pmship', 'spec-complete'])).toBe(0)
    await h.run(['set-many', 'pmship',
      'build_mode=direct', 'isolation=branch', 'direct_override=true'])
    await h.satisfyStepTests('pmship', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'pmship', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'pmship', 'build-complete'])).toBe(0)
    await seed('docs/pmship-verify.md')
    await h.seedArtifact('pmship', 'verification_report', 'docs/pmship-verify.md')
    await h.run(['set-many', 'pmship', 'branch_status=handled', 'verify_result=pass'])
    await approveReviewExit('pmship', 'verify-pass')
    await h.satisfyStepTests('pmship', 'verify')
    await h.satisfyStepAgents('pmship')
    expect(await h.run(['transition', 'pmship', 'verify-pass'])).toBe(0)
    await h.seedAppliedSpec('pmship')

    // PRD 还没产出：通往 完结 的那条边必须拒，逐字给出理由，相位不动。
    expect(await h.run(['get', 'pmship', 'prd_path'])).toBe(0)
    expect(h.out.join('').trim()).toBe('null')
    expect(await h.run(['transition', 'pmship', 'ship-complete'])).toBe(2)
    expect(h.err.join('\n')).toContain("ship 出口：要求 prd_path 非空（当前='null'）")
    expect(await h.read('pmship')).toMatch(/^phase: ship$/m)

    // 交付物真的在了才放行，一路到 完结。
    await seed('docs/pmship-prd.md')
    expect(await h.run(['set', 'pmship', 'prd_path', 'docs/pmship-prd.md']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'pmship', 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'pmship', 'archived']), h.err.join('\n')).toBe(0)
    const finished = await h.read('pmship')
    expect(finished).toMatch(/^phase: archive$/m)
    expect(finished).toMatch(/^archived: true$/m)
    expect(finished).toMatch(/^prd_path: docs\/pmship-prd\.md$/m)
  }, 60_000)

  /**
   * 同一个终局的另一半：真机三条 track 全部到了 完结，而 `find openspec/specs -type f` 一个文件
   * 都没有——每个 change 手里只有一份 `--dry-run` 写下的 result=pass 回执。这条用例把主规格目录
   * 整个清掉、只留那份彩排回执，钉住通往 完结 的那条边拒得住，拒完主规格目录还是空的。
   */
  test('完结：backend 在主规格为空、只有彩排回执时走不进 archive；真应用后才走得进', async () => {
    await initGoverned('beship')
    await advanceTo('beship', 'ship')
    const specsDir = join(h.cwd, 'openspec', 'specs')
    const mainSpec = join(specsDir, 'capability', 'spec.md')
    const mainBody = await readFile(mainSpec, 'utf8')
    const receipt = join(h.cwd, 'openspec', 'changes', 'beship', '.pipeline-spec-apply.json')
    await writeFile(receipt, (await readFile(receipt, 'utf8')).replace('"mode": "apply"', '"mode": "dry-run"'), 'utf8')
    await rm(specsDir, { recursive: true, force: true })
    expect(existsSync(specsDir)).toBe(false)

    expect(await h.run(['transition', 'beship', 'ship-complete'])).toBe(1)
    expect(h.err.join('\n')).toContain(
      'ERROR: ship-complete 要求主规格迁移机器证据有效（当前=spec-apply-rehearsal-only）',
    )
    expect(await h.read('beship')).toMatch(/^phase: ship$/m)
    expect(existsSync(specsDir), '拒绝之后主规格目录仍然是空的').toBe(false)

    // 真跑一次应用留下的产物：主规格在盘上 + mode=apply 的回执。
    await mkdir(dirname(mainSpec), { recursive: true })
    await writeFile(mainSpec, mainBody, 'utf8')
    await h.seedAppliedSpec('beship')
    expect(await h.run(['transition', 'beship', 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'beship', 'archived']), h.err.join('\n')).toBe(0)
    const finished = await h.read('beship')
    expect(finished).toMatch(/^phase: archive$/m)
    expect(finished).toMatch(/^archived: true$/m)
    expect(existsSync(mainSpec)).toBe(true)
  }, 60_000)
})

describe('真实 e2e —— verify-fail / archived 副作用（老仓 L206-218）', () => {
  test('verify-fail：verify_result=fail + build_sha=null + phase_status=in_progress + phase=build', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'verify')
    expect(await h.read('demo')).toContain(`build_sha: ${TEST_GIT_BUILD_TOKEN}`) // 冻结在案
    await seed('docs/verify-fail.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify-fail.md')
    await approveReviewExit('demo', 'verify-fail')
    expect(await h.run(['transition', 'demo', 'verify-fail'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^phase: build$/m)
    expect(yaml).toMatch(/^phase_status: in_progress$/m)
    expect(yaml).toMatch(/^verify_result: fail$/m)
    expect(yaml).toMatch(/^build_sha: null$/m) // barrier 回退清空（ADR 0005）
  })

  test('archived：archived=true + archived_at=now + phase_status=done', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'ship')
    expect(await h.run(['transition', 'demo', 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'archived'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^phase: archive$/m)
    expect(yaml).toMatch(/^phase_status: done$/m)
    expect(yaml).toMatch(/^archived: true$/m)
    expect(yaml).toMatch(new RegExp(`^archived_at: ${FIXED_CLOCK}$`, 'm'))
  }, 30_000)
})

describe('真实 e2e —— 跨命令串联 + 历史 JSONL（GOAL C10）', () => {
  test('七相位全程（前置全喂足）：每条 transition 历史带事件名 raw（对齐老仓 transitions_history.event）', async () => {
    await initGoverned('e2e')
    await advanceTo('e2e', 'ship')
    expect(await h.run(['transition', 'e2e', 'ship-complete']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'e2e', 'archived'])).toBe(0)
    const yaml = await h.read('e2e')
    expect(yaml).toMatch(/^phase: archive$/m)
    expect(yaml).toMatch(/^archived: true$/m)
    const hist = await h.readIn('e2e', '.pipeline-history.jsonl')
    const events = hist
      .split('\n')
      .filter((l) => l.includes('"kind":"transition"'))
      .map((l) => (JSON.parse(l) as { raw?: string }).raw)
    expect(events).toEqual([
      'open-complete',
      'explore-complete',
      'spec-complete',
      'build-complete',
      'verify-pass',
      'ship-complete',
      'archived',
    ])
  }, 30_000)

  test('verify-fail 回炉重跑：build-complete 重新冻结新 SHA 后 verify-pass 通过（老仓 barrier 修复路径）', async () => {
    await initGoverned('demo')
    await advanceTo('demo', 'verify')
    await seed('docs/verify-fail.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify-fail.md')
    await approveReviewExit('demo', 'verify-fail')
    expect(await h.run(['transition', 'demo', 'verify-fail'])).toBe(0) // → build，build_sha=null
    await h.satisfyStepTests('demo', 'build')
    // pre-Verify 结论只能在本步就绪证据（必需测试）齐全之后写入。
    expect(await h.run(['set', 'demo', 'pre_verify_review_result', 'pass']), h.err.join('\n')).toBe(0)
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(0) // 重新收敛后冻结
    expect(await h.read('demo')).toContain(`build_sha: ${TEST_GIT_BUILD_TOKEN}`)
    await seed('docs/verify.md')
    await h.seedArtifact('demo', 'verification_report', 'docs/verify.md')
    await h.run(['set', 'demo', 'branch_status', 'handled'])
    await approveReviewExit('demo', 'verify-pass')
    await h.satisfyStepTests('demo', 'verify')
    await h.satisfyStepAgents('demo')
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^verify_result: pass$/m)
  }, 30_000)
})
