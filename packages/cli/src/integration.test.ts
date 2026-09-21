/**
 * 真实端到端集成测试（GOAL C9/C10：无伪测试 · 真实且全量，2026-07-07 用户指令）。
 *
 * 与其余 *.test.ts 的根本区别：**零 mock**。
 *   - 真 kernel：createStateStore / createFlowEngine / loadManifest / createHistoryWriter
 *   - 真文件系统：每个用例一个 mkdtemp 临时项目，断言落盘的真实 .pipeline.yaml / JSONL / marker 字节
 *   - 真装配：走 buildProgram(realDeps).parseAsync——与 main.ts 同一条命令解析路径
 * 只差一层进程边界（那层由 tools/test-bundle.sh 真跑编译产物覆盖）+ 老内核对照（oracle 覆盖）。
 *
 * 命中「伪测试」判据即不算数：断言 mock 返回 / 真实路径未执行 / 伪造 pass。本文件全程摸真盘。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildProgram, CliExit } from './program.js'
import { createBuildRevisionToken, probeBuildRevisionIdentity } from '@tenon/kernel'
import {
  FIXED_CLOCK,
  REPO_ROOT,
  TEST_GIT_BUILD_TOKEN,
  freshHarness,
  realDeps,
  type Harness,
} from './integration-harness.js'

// Real filesystem/document-ledger flows may exceed Vitest's 5s default. Keep the
// timeout explicit so a slow case cannot trigger cleanup races that masquerade as
// ENOTEMPTY failures.

describe('真实 e2e —— 全命令驱动真 kernel + 真 fs（GOAL C9）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
  })
  afterEach(async () => {
    await rm(h.cwd, { recursive: true, force: true })
  })

  test('init 真落盘 .pipeline.yaml：字段序 + created_by + phase=open', async () => {
    expect(await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^track: backend$/m)
    expect(yaml).toMatch(/^created_by: Tester <tester@tenon.test>$/m)
    expect(yaml).toMatch(/^assignee: Tester <tester@tenon.test>$/m)
    expect(yaml).toMatch(/^phase: open$/m)
    // 字段序：track 必在 phase 之前（FIELD_ORDER 落盘真相）
    expect(yaml.indexOf('\ntrack:')).toBeLessThan(yaml.indexOf('\nphase:'))
  })

  test('get 真读回 init 写的值', async () => {
    await h.run(['init', 'demo', '--track', 'pm', '--preset', 'full'])
    expect(await h.run(['get', 'demo', 'track'])).toBe(0)
    expect(h.out).toEqual(['pm'])
  })

  test('set 真写字段 + 真记 history JSONL', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['set', 'demo', 'plan', 'docs/plans/p.md'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^plan: docs\/plans\/p\.md$/m)
    const hist = await readFile(join(h.cwd, 'openspec/changes/demo/.pipeline-history.jsonl'), 'utf8')
    expect(hist).toContain('"kind":"set"')
    expect(hist).toContain('"field":"plan"')
  })

  test('get 未设字段真读回 init 忠实值 exit 0（G1，老内核 heredoc：可选字段写字面 null）', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    // 真实发现：init 对 plan 等可选字段落盘字面 "null"（忠实老内核，oracle 双跑据此过）——非空串
    expect(await h.run(['get', 'demo', 'plan'])).toBe(0)
    expect(h.out).toEqual(['null'])
    expect(await h.read('demo')).toMatch(/^plan: null$/m)
    // FIELD_ORDER 之外的未知字段 → grep-miss 空行 + exit 0（yaml_get 语义）
    expect(await h.run(['get', 'demo', 'nonesuch'])).toBe(0)
    expect(h.out).toEqual([''])
  })

  test('set-many 真原子写多字段，落盘字段序正确（G2）', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['set-many', 'demo', 'build_mode=direct', 'isolation=branch'])).toBe(0)
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^build_mode: direct$/m)
    expect(yaml).toMatch(/^isolation: branch$/m)
    // FIELD_ORDER：build_mode 在 isolation 之前
    expect(yaml.indexOf('\nbuild_mode:')).toBeLessThan(yaml.indexOf('\nisolation:'))
  })

  test('check 真跑 guard 全量面：未满足出口条件 exit 2，满足 exit 0（G3）', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    await h.run(['transition', 'demo', 'open-complete']) // → explore
    // explore 出口要求 design_doc 指向存在文件——未设 → check 不过 exit 2
    expect(await h.run(['check', 'demo'])).toBe(2)
    // 真建 design doc 并指向它 → check 过
    const ddir = join(h.cwd, 'openspec/changes/demo')
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md') // P6：artifact 白盒预置
    expect(await h.run(['check', 'demo'])).toBe(0)
  })

  test('set 四闸真拒写（": " 注入）exit 1，文件不被破坏', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    const before = await h.read('demo')
    expect(await h.run(['set', 'demo', 'prd_path', 'a: b'])).toBe(1)
    expect(await h.read('demo')).toBe(before) // 字节不变
  })

  test('cas 真比对：匹配写入 exit 0 / 不匹配 exit 3', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.run(['set', 'demo', 'automation', 'queued'])
    expect(await h.run(['cas', 'demo', 'automation', 'queued', 'running'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^automation: running$/m)
    expect(await h.run(['cas', 'demo', 'automation', 'queued', 'off'])).toBe(3) // 现值已是 running
  })

  test('transition 真改相位且不在进入 review 时自锁 + 真记历史', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    expect(await h.run(['transition', 'demo', 'open-complete'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: explore$/m)
    // explore 是 review 相位，但 entry 不写 marker；产物完成后的 `review request` 才会写 v2 投影。
    await expect(stat(join(h.cwd, '.pipeline-pending-review'))).rejects.toMatchObject({ code: 'ENOENT' })
    const hist = await readFile(join(h.cwd, 'openspec/changes/demo/.pipeline-history.jsonl'), 'utf8')
    expect(hist).toContain('"kind":"transition"')
    expect(hist).toContain('"to":"explore"')
  })

  test('transition 非法真拒：exit 1，相位不变', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['transition', 'demo', 'verify-pass'])).toBe(1) // open 相位收 verify 事件非法
    expect(await h.read('demo')).toMatch(/^phase: open$/m)
  })

  test('build-complete 真冻结 build_sha（喂足真实前置，忠实老内核 case 块）', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    // explore 出口：使用已记录的 OpenSpec design 并登记字段（不得改写 hash-bound 文档）。
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md') // P6：artifact 白盒预置
    await h.run(['transition', 'demo', 'open-complete'])
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'explore-complete'])).toBe(0)
    // spec 出口（backend）：真建 plan 并指向它（老仓 L127-138）
    await writeFile(join(h.cwd, 'openspec/changes/demo/plan.md'), '# plan\n', 'utf8')
    await h.seedArtifact('demo', 'plan', 'openspec/changes/demo/plan.md') // P6：artifact 白盒预置
    expect(await h.run(['review', 'request', 'demo', '--event', 'spec-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'demo'])).toBe(0)
    expect(await h.run(['transition', 'demo', 'spec-complete'])).toBe(0)
    // build 出口：build_mode + isolation 必设；full+direct 须显式 direct_override=true（老仓 L144-151）
    await h.run([
      'set-many', 'demo',
      'build_mode=direct', 'isolation=worktree', 'direct_override=true',
      'pre_verify_review_result=pass',
    ])
    // default 的 backend 轨在 build 声明了必需测试：像真实用户那样先跑它们（真记录，不是旁路）。
    await h.satisfyStepTests('demo', 'build')
    expect(await h.run(['transition', 'demo', 'build-complete'])).toBe(0)
    expect(await h.read('demo')).toMatch(/^phase: verify$/m)
    expect(await h.read('demo')).toContain(`build_sha: ${TEST_GIT_BUILD_TOKEN}`)
  })

  test('inbox 真读 canonical pending review request（--json schema）', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('demo')
    await h.run(['transition', 'demo', 'open-complete']) // → explore（复核相位）
    await h.seedArtifact('demo', 'design_doc', 'openspec/changes/demo/design.md')
    expect(await h.run(['review', 'request', 'demo', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['inbox', '--json'])).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as { inbox: Array<{ name: string; waiting_on: string }> }
    expect(payload.inbox.some((i) => i.name === 'demo')).toBe(true)
  })

  test('task add-dep + children 真跑通（走 buildProgram 注册，真落盘 depends_on）', async () => {
    await h.run(['init', 'a', '--track', 'backend', '--preset', 'full'])
    await h.run(['init', 'b', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['task', 'add-dep', 'a', 'b'])).toBe(0)
    // a 真落盘 depends_on 块序列含 b
    expect(await h.read('a')).toMatch(/depends_on:\n\s*-\s*b/)
    // children of b 真反查到 a（--json 经 program 的 --json 选项透传进 args）
    expect(await h.run(['task', 'children', 'b', '--json'])).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as Array<{ name: string; archived: boolean }>
    expect(payload).toEqual([{ name: 'a', archived: false }])
    // remove-dep 真清空回 []
    expect(await h.run(['task', 'remove-dep', 'a', 'b'])).toBe(0)
    expect(await h.run(['get', 'a', 'depends_on'])).toBe(0)
    expect(h.out).toEqual([''])
  })

  test('spec：specs 真枚举 + set-spec-scope 真落盘标量（走 buildProgram）', async () => {
    await h.run(['init', 'auth', '--track', 'backend', '--preset', 'full'])
    await import('node:fs/promises').then((fs) => fs.mkdir(join(h.cwd, 'openspec/specs/login'), { recursive: true }))
    await writeFile(join(h.cwd, 'openspec/specs/login/spec.md'), '# login\n', 'utf8')
    expect(await h.run(['spec', 'specs', '--json'])).toBe(0)
    const specs = JSON.parse(h.out.join('\n')) as Array<{ name: string; has_spec: boolean }>
    expect(specs).toEqual([{ name: 'login', spec_path: 'openspec/specs/login/spec.md', has_spec: true }])
    expect(await h.run(['spec', 'set-spec-scope', 'auth', 'login,billing'])).toBe(0)
    // 老仓字节：spec_scope 落标量 CSV（非 list 块序列）
    expect(await h.read('auth')).toMatch(/^spec_scope: login,billing$/m)
  })

  test('document：真实 CLI 为多个 capability delta 分别登记并读取证据', async () => {
    await h.run(['init', 'multi', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('multi')
    await h.seedArtifact('multi', 'design_doc', 'openspec/changes/multi/design.md')
    expect(await h.run(['transition', 'multi', 'open-complete'])).toBe(0)
    expect(await h.run(['review', 'request', 'multi', '--event', 'explore-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'multi'])).toBe(0)
    expect(await h.run(['transition', 'multi', 'explore-complete'])).toBe(0)

    const alpha = 'openspec/changes/multi/specs/alpha/spec.md'
    const beta = 'openspec/changes/multi/specs/beta/spec.md'
    for (const path of [alpha, beta]) {
      const target = join(h.cwd, path)
      await import('node:fs/promises').then((fs) => fs.mkdir(join(target, '..'), { recursive: true }))
      await writeFile(target, `# ${path}\n`, 'utf8')
    }
    const changeDir = join(h.cwd, 'openspec', 'changes', 'multi')
    for (const [path, toolUseId] of [[alpha, 'delta-alpha'], [beta, 'delta-beta']] as const) {
      await writeFile(
        join(changeDir, '.pipeline-history.jsonl'),
        `${JSON.stringify({ ts: FIXED_CLOCK, kind: 'tool', raw: 'Skill: openspec-propose' })}\n`,
        { encoding: 'utf8', flag: 'a' },
      )
      expect(await h.run([
        'internal-native-skill-receipt', 'multi', 'openspec-propose',
        'integration-multi-session', toolUseId, FIXED_CLOCK,
      ])).toBe(0)
      expect(await h.run([
        'document', 'record', 'multi', 'delta-spec', path, '--producer', 'openspec-propose',
      ])).toBe(0)
    }

    await h.seedArtifact('multi', 'plan', 'docs/superpowers/plans/multi.md')
    expect(await h.run(['review', 'request', 'multi', '--event', 'spec-complete'])).toBe(0)
    expect(await h.run(['review', 'acknowledge', 'multi'])).toBe(0)
    expect(await h.run(['transition', 'multi', 'spec-complete'])).toBe(0)
    expect(await h.run(['document', 'read', 'multi', 'delta-spec'])).toBe(0)
    expect(await h.run(['document', 'status', 'multi', '--json'])).toBe(0)
    const status = JSON.parse(h.out.join('\n')) as {
      items: Array<{ kind: string; paths: string[]; status: string }>
    }
    expect(status.items.find((item) => item.kind === 'delta-spec')).toMatchObject({
      status: 'recorded',
      paths: expect.arrayContaining([
        'openspec/changes/multi/specs/capability/spec.md',
        alpha,
        beta,
      ]),
    })
  })

  test('document migrate-delta：真实 CLI 仅按显式路径做同 digest 幂等迁移', async () => {
    await h.run(['init', 'legacy-doc', '--track', 'backend', '--preset', 'full'])
    const legacy = 'docs/legacy-doc-delta.md'
    const canonical = 'openspec/changes/legacy-doc/specs/capability/spec.md'
    const content = '# unchanged legacy delta\n'
    for (const path of [legacy, canonical]) {
      const target = join(h.cwd, path)
      await import('node:fs/promises').then((fs) => fs.mkdir(join(target, '..'), { recursive: true }))
      await writeFile(target, content, 'utf8')
    }
    const ledgerPath = join(h.cwd, 'openspec/changes/legacy-doc/.pipeline-documents.json')
    await writeFile(ledgerPath, `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: '2026-07-24T00:00:00Z',
      records: [{
        kind: 'delta-spec',
        path: legacy,
        sha256: createHash('sha256').update(content).digest('hex'),
        producer: 'openspec-propose',
        recordedAt: '2026-07-24T00:00:00Z',
        reads: [],
      }],
    }, null, 2)}\n`, 'utf8')

    expect(await h.run(['document', 'migrate-delta', 'legacy-doc', legacy, canonical])).toBe(0)
    expect(await h.run(['document', 'migrate-delta', 'legacy-doc', legacy, canonical])).toBe(0)
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      records: Array<{ kind: string; path: string; subjectRef?: { projection?: string } }>
    }
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]).toMatchObject({ kind: 'delta-spec', path: canonical, sha256: expect.any(String),
      producer: 'openspec-propose', recordedAt: '2026-07-24T00:00:00Z', reads: [] })
  })

  test('session：activate 真落当前用户 active-change（走 buildProgram，不动 phase）', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    const before = await h.read('demo')
    expect(await h.run(['session', 'activate', 'demo'])).toBe(0)
    expect(await readFile(join(h.cwd, '.tenon', 'users', 'tester-at-tenon.test', 'local', 'active-change'), 'utf8')).toBe('demo\n')
    expect(await h.read('demo')).toBe(before) // activate 不碰 .pipeline.yaml
    // 缺 change → exit 1
    expect(await h.run(['session', 'activate', 'nonesuch'])).toBe(1)
  })

  test('session：activate --continuous 经真实 Commander 参数层到达 Change 绑定授权', async () => {
    const sessionId = '019f92c7-6e66-7290-9352-f9d915266f14'
    await h.run(['init', 'continuous', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['session', 'activate', 'continuous', '--continuous', '--host-session', sessionId])).toBe(0)
    const authority = await readFile(join(h.cwd, '.tenon', 'users', 'tester-at-tenon.test', 'local', 'authority'), 'utf8')
    expect(authority).toContain('pipeline-interaction-authority-v2')
    expect(authority).toContain('change=continuous')
    expect(authority).toContain(`host_session=${sessionId}`)
    expect(authority).toContain('review=delegated')
    const history = await readFile(join(h.cwd, 'openspec/changes/continuous/.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('interaction-authority:enabled')
  })

  test('status/list 真枚举活跃 change（含 YAML projection 缺失的 canonical-only change）', async () => {
    await h.run(['init', 'a1', '--track', 'backend', '--preset', 'full'])
    await h.run(['init', 'b2', '--track', 'pm', '--preset', 'full'])
    await unlink(join(h.cwd, 'openspec', 'changes', 'b2', '.pipeline.yaml'))
    expect(await h.run(['list', '--json'])).toBe(0)
    const payload = JSON.parse(h.out.join('\n')) as { changes: Array<{ name: string }> }
    expect(payload.changes.map((c) => c.name).sort()).toEqual(['a1', 'b2'])
  })

  test('doctor 真跑健康面：识别本 pipeline 项目，exit 0/1 合法', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    const code = await h.run(['doctor', '--json'])
    expect([0, 1]).toContain(code)
    const payload = JSON.parse(h.out.join('\n')) as { checks: unknown[]; summary: Record<string, number> }
    expect(Array.isArray(payload.checks)).toBe(true)
    expect(payload.checks.length).toBeGreaterThan(0)
  })

  test('sync 真跑（走 buildProgram，--json 决策信封 cli_version 来自注入）', async () => {
    await h.run(['init', 'x', '--track', 'backend', '--preset', 'full'])
    expect(await h.run(['sync'])).toBe(0)
    const env = JSON.parse(h.out.join('\n')) as { stage: string; cli_version: string; report_only: boolean }
    expect(env.stage).toBe('sync')
    expect(env.cli_version).toBe('0.1.0') // deps.pluginVersion 注入
    expect(env.report_only).toBe(true) // 无 --migrate 只报告
  })

  test('uninstall --dry-run 真跑（只打印计划不删文件）', async () => {
    await h.run(['init', 'x', '--track', 'backend', '--preset', 'full'])
    const before = await h.read('x')
    expect(await h.run(['uninstall', '--dry-run', '--yes'])).toBe(0)
    // dry-run 不动 change 文件
    expect(await h.read('x')).toBe(before)
  })

  test('全程 init→archive 七相位真跑通（喂足每相位真实前置，忠实老内核）', async () => {
    const cd = join(h.cwd, 'openspec/changes/e2e')
    await h.run(['init', 'e2e', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('e2e')
    const clearGates = async () => {
      // review projection must only be consumed by `tenon review acknowledge`, never deleted by a test bypass.
      for (const k of ['confirm', 'interaction']) await rm(join(h.cwd, `.pipeline-pending-${k}`), { force: true })
    }
    const step = async (ev: string) => {
      if (ev === 'explore-complete' || ev === 'spec-complete' || ev === 'verify-pass' || ev === 'verify-fail') {
        expect(await h.run(['review', 'request', 'e2e', '--event', ev])).toBe(0)
        expect(await h.run(['review', 'acknowledge', 'e2e'])).toBe(0)
      }
      const code = await h.run(['transition', 'e2e', ev])
      expect(code, `事件 ${ev} 应成功；stderr=${h.err.join('|')}`).toBe(0)
      await clearGates()
    }
    // 每相位出口前喂真实前置（老仓 state-transition.sh case 块要求）
    await h.run(['transition', 'e2e', 'open-complete']); await clearGates()
    // design.md 已由真实 ledger fixture 记录，保持它的 digest 不变。
    await h.seedArtifact('e2e', 'design_doc', 'openspec/changes/e2e/design.md') // P6：artifact 白盒预置
    await step('explore-complete')
    await writeFile(join(cd, 'plan.md'), '# plan\n', 'utf8')
    await h.seedArtifact('e2e', 'plan', 'openspec/changes/e2e/plan.md') // P6：artifact 白盒预置
    await step('spec-complete')
    await h.run([
      'set-many', 'e2e',
      'build_mode=direct', 'isolation=worktree', 'direct_override=true',
      'pre_verify_review_result=pass',
    ])
    await h.satisfyStepTests('e2e', 'build')
    await step('build-complete')
    // verify 出口：报告 + branch_status + 双 review pass + barrier（build_sha 已=DEADBEEF）
    await h.seedArtifact('e2e', 'verification_report', 'docs/superpowers/reports/e2e.md') // P6：复用 hash-bound verification report
    await h.run(['set-many', 'e2e', 'branch_status=handled'])
    await h.satisfyStepTests('e2e', 'verify')
    await h.satisfyStepAgents('e2e')
    await step('verify-pass')
    await step('ship-complete')
    await step('archived')
    expect(await h.read('e2e')).toMatch(/^phase: archive$/m)
    expect(await h.read('e2e')).toMatch(/^archived: true$/m)
    // 历史 JSONL 真记满 7 条 transition，raw=事件名（#14 补）
    const hist = await readFile(join(cd, '.pipeline-history.jsonl'), 'utf8')
    const trans = hist.split('\n').filter((l) => l.includes('"kind":"transition"'))
    expect(trans).toHaveLength(7)
    expect(trans.some((l) => l.includes('"raw":"verify-pass"'))).toBe(true)
  }, 30_000)

  test('真实 CLI/default assessor 拒绝 legacy phase/build_sha backfill，即使有 approved review receipt', async () => {
    await h.run(['init', 'backfill', '--track', 'backend', '--preset', 'full'])
    await h.seedGovernedDocumentEvidence('backfill')

    // The temporary project itself is a real Git repository. The assessor used below deliberately
    // omits the harness identity override so transition.ts probes this physical identity.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: h.cwd })
    execFileSync('git', ['config', 'user.email', 'tenon@test.invalid'], { cwd: h.cwd })
    execFileSync('git', ['config', 'user.name', 'Tenon Test'], { cwd: h.cwd })
    await writeFile(join(h.cwd, 'baseline.txt'), 'baseline\n', 'utf8')
    execFileSync('git', ['add', 'baseline.txt'], { cwd: h.cwd })
    execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: h.cwd })
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h.cwd, encoding: 'utf8' }).trim()
    const identity = await probeBuildRevisionIdentity(h.cwd)
    expect(identity).toBeDefined()
    if (!identity) throw new Error('real Git fixture identity unavailable')
    const backfilledToken = createBuildRevisionToken('git', revision, identity).value

    // Reach Verify through the legacy field writer rather than Build-complete; no Build transition
    // record/effect is created for this token. The report is a real governed artifact, but review
    // request must now reject the unproven token before creating any receipt.
    expect(await h.run(['transition', 'backfill', 'open-complete'])).toBe(0)
    await h.seedPhase('backfill', 'verify')
    await h.seedArtifact('backfill', 'verification_report', 'docs/superpowers/reports/backfill.md')
    await h.run(['set-many', 'backfill',
      'branch_status=handled',
      'isolation=branch',
      `build_sha=${backfilledToken}`,
    ])
    const changeDir = join(h.cwd, 'openspec', 'changes', 'backfill')
    const recordsPath = join(changeDir, '.pipeline-transitions')
    const recordNames = (await readdir(recordsPath).catch(() => [] as string[])).sort()
    const before = {
      state: await readFile(join(changeDir, '.pipeline.yaml'), 'utf8'),
      current: await readFile(join(changeDir, '.pipeline-run', 'current.json'), 'utf8'),
      history: await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8'),
      records: await Promise.all(recordNames.map(async (name) => [name, await readFile(join(recordsPath, name), 'utf8')] as const)),
    }
    const markerPath = join(h.cwd, '.pipeline-pending-review')
    const markerBefore = await readFile(markerPath, 'utf8').catch(() => undefined)

    const out: string[] = []
    const err: string[] = []
    const baseDeps = realDeps(h.cwd, out, err)
    const actualDeps = {
      ...baseDeps,
      buildRevisionIdentity: undefined,
      assessBuildRevision: undefined,
      gitHeadSha: async () => execFileSync(
        'git', ['rev-parse', 'HEAD'], { cwd: h.cwd, encoding: 'utf8' },
      ).trim(),
    }
    let exitCode = 0
    try {
      await buildProgram(actualDeps).parseAsync(
        ['review', 'request', 'backfill', '--event', 'verify-pass'], { from: 'user' },
      )
    } catch (error) {
      if (!(error instanceof CliExit)) throw error
      exitCode = error.code
    }
    expect(exitCode).toBe(2)
    const diagnostic = [...out, ...err].join('\n')
    expect(diagnostic).toContain('verify-build-revision-untrusted')
    expect(diagnostic).toMatch(/reason=provenance-(missing|mismatch)/)
    expect(diagnostic).toContain('return-to-build-and-capture-current-revision')
    expect(diagnostic).not.toContain(backfilledToken)
    expect(diagnostic).not.toContain(h.cwd)

    expect(await readFile(join(changeDir, '.pipeline.yaml'), 'utf8')).toBe(before.state)
    expect(await readFile(join(changeDir, '.pipeline-run', 'current.json'), 'utf8')).toBe(before.current)
    expect(await readFile(join(changeDir, '.pipeline-history.jsonl'), 'utf8')).toBe(before.history)
    const afterNames = (await readdir(recordsPath).catch(() => [] as string[])).sort()
    expect(afterNames).toEqual(recordNames)
    expect(await Promise.all(afterNames.map(async (name) => [name, await readFile(join(recordsPath, name), 'utf8')] as const)))
      .toEqual(before.records)
    const markerAfter = await readFile(markerPath, 'utf8').catch(() => undefined)
    expect(markerAfter).toBe(markerBefore)
  })

  test('import 真迁移 base64 历史区（老仓 fixture）+ --strip 真清 YAML', async () => {
    // 用老仓真实 fixture 建 change（含 tools/prompts/transitions_history base64 区）
    const fixture = await readFile(join(REPO_ROOT, 'packages/kernel/src/state/fixtures/dashboard-interaction-fixes.pipeline.yaml'), 'utf8')
    const dir = join(h.cwd, 'openspec/changes/legacy1')
    await rm(dir, { recursive: true, force: true })
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
    await writeFile(join(dir, '.pipeline.yaml'), fixture, 'utf8')
    expect(await h.run(['import', 'legacy1', '--strip'])).toBe(0)
    const jsonl = await readFile(join(dir, '.pipeline-history.jsonl'), 'utf8')
    expect(jsonl).toContain('"kind":"import"')
    expect(jsonl.split('\n').filter(Boolean).length).toBeGreaterThan(5)
    expect(await h.read('legacy1')).not.toContain('_history:') // YAML 历史节真被清
    // --strip 后再 import：历史区已清空 → 诚实返回 exit 0「无历史区可导入」（非幂等哨兵路径）
    expect(await h.run(['import', 'legacy1'])).toBe(0)
    expect(h.err.join('\n')).toContain('无历史区')
  })

  test('import 幂等哨兵真拦重复导入（不带 --strip：tail 仍在，第二次被哨兵挡）', async () => {
    const fixture = await readFile(join(REPO_ROOT, 'packages/kernel/src/state/fixtures/dashboard-interaction-fixes.pipeline.yaml'), 'utf8')
    const dir = join(h.cwd, 'openspec/changes/legacy2')
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
    await writeFile(join(dir, '.pipeline.yaml'), fixture, 'utf8')
    expect(await h.run(['import', 'legacy2'])).toBe(0) // 首次真导入
    // 第二次：tail 未清（无 --strip）但 JSONL 已有 import 哨兵 → 真拦 exit 1
    expect(await h.run(['import', 'legacy2'])).toBe(1)
    expect(h.err.join('\n')).toContain('已导入过')
  })

  test('并发真锁：两个 set 竞争同一 change 不丢字段', async () => {
    await h.run(['init', 'demo', '--track', 'backend', '--preset', 'full'])
    // 真并发跑两条 set（各自独立 deps/store，真 mkdir 锁串行化落盘）
    const o1: string[] = [], e1: string[] = [], o2: string[] = [], e2: string[] = []
    const p1 = buildProgram(realDeps(h.cwd, o1, e1)).parseAsync(['set', 'demo', 'plan', 'P'], { from: 'user' }).catch((e) => { if (!(e instanceof CliExit)) throw e })
    const p2 = buildProgram(realDeps(h.cwd, o2, e2)).parseAsync(['set', 'demo', 'branch', 'B'], { from: 'user' }).catch((e) => { if (!(e instanceof CliExit)) throw e })
    await Promise.all([p1, p2])
    const yaml = await h.read('demo')
    expect(yaml).toMatch(/^plan: P$/m)
    expect(yaml).toMatch(/^branch: B$/m) // 两笔都在，锁未丢写
  })
})

describe('真实构建产物 —— tsc + esbuild bundle 存在且可执行（GOAL C9 证据链）', () => {
  test('dist/tenon.mjs 真存在、真跑 --help 不炸', () => {
    const bundle = join(REPO_ROOT, 'packages/cli/dist/tenon.mjs')
    expect(statSync(bundle).isFile()).toBe(true)
    // 真起子进程跑真产物（与 test-bundle.sh 同源，vitest 内也钉一道）
    const help = execFileSync('node', [bundle, '--help'], { encoding: 'utf8' })
    expect(help).toContain('pipeline')
    expect(help).toContain('transition')
  })
})
