/**
 * T6 golden-oracle 双跑 harness 测试。
 *
 * 被测物 = tools/oracle/run.sh（bash harness）+ fixtures/*.sh。
 * 新 CLI 侧统一用 tests/stub-cli.mjs 注入（ORACLE_NEW_CLI），三种模式：
 *   mirror   —— 忠实复刻老内核实测行为（stdout/exit/yaml 三面对齐）→ 双跑应全绿
 *   contract —— 忠实遵循 docs/CONTRACT.md §3 契约表 → 降级模式应全绿
 *   corrupt  —— 故意输出错值 + 写回丢历史尾块 → 三面 diff 必须抓红
 *
 * 运行：cd <repo> && npx vitest run --config tools/oracle/vitest.config.ts
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // tools/oracle
const runSh = join(here, 'run.sh')
const stubCli = join(here, 'tests', 'stub-cli.mjs')

interface HarnessResult {
  status: number | null
  out: string
  workdir: string
}

function runHarness(env: Record<string, string>, args: string[] = []): HarnessResult {
  const workdir = mkdtempSync(join(tmpdir(), 'oracle-t6-'))
  const res = spawnSync('bash', [runSh, ...args], {
    env: { ...process.env, ORACLE_WORKDIR: workdir, ...env },
    encoding: 'utf8',
    timeout: 280_000,
  })
  return { status: res.status, out: `${res.stdout ?? ''}\n${res.stderr ?? ''}`, workdir }
}

const stubEnv = (mode: string): Record<string, string> => ({
  ORACLE_NEW_CLI: `node ${stubCli}`,
  STUB_MODE: mode,
})

describe('run.sh 前置守卫', () => {
  it('新 CLI 构建产物缺失 → 打印「先 npm run build」并 exit 2', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'oracle-empty-'))
    try {
      const r = runHarness({ ORACLE_REPO_ROOT: emptyRoot })
      expect(r.status).toBe(2)
      expect(r.out).toContain('先 npm run build')
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})

describe('双跑模式（oracle = 老仓 pipeline-state.sh 实跑）', () => {
  it('mirror stub 三 fixture 双跑全绿：汇总表无 FAIL、exit 0', () => {
    const r = runHarness(stubEnv('mirror'))
    expect(r.out).toContain('汇总')
    expect(r.out).not.toContain('DEGRADED')
    expect(r.out).not.toMatch(/\bFAIL\b/)
    expect(r.status).toBe(0)
    // 报告落盘
    expect(existsSync(join(r.workdir, 'report.txt'))).toBe(true)
  })

  it('合法 canonical transition-head anchor 只作为内部元数据归一，业务投影仍全量对比', () => {
    const r = runHarness(
      { ...stubEnv('mirror'), STUB_TRANSITION_HEAD: 'valid' },
      ['backend-full'],
    )
    expect(r.out).toContain('汇总')
    expect(r.out).not.toMatch(/\bFAIL\b/)
    expect(r.status).toBe(0)
  })

  it.each([
    ['closed schema 损坏', { STUB_TRANSITION_HEAD: 'malformed' }],
    ['不在 logical opaque tail 首行', { STUB_TRANSITION_HEAD: 'misplaced' }],
    ['anchor 合法但业务字段漂移', {
      STUB_TRANSITION_HEAD: 'valid',
      STUB_BUSINESS_TAMPER: '1',
    }],
  ])('%s 的 transition-head fixture 必须被 YAML 面抓红', (_label, extraEnv) => {
    const r = runHarness(
      { ...stubEnv('mirror'), ...extraEnv },
      ['backend-full'],
    )
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/\bFAIL\b/)
  })

  it('corrupt stub 被三面 diff 抓红：exit 1，含 FAIL 行 + 历史区 PRESERVE 抓红', () => {
    const r = runHarness(stubEnv('corrupt'), ['backend-full', 'pm-history'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/\bFAIL\b/)
    // pm-history 的老内核 base64 历史区在新侧写回后必须逐字保留——corrupt 故意丢弃，必须抓红
    expect(r.out).toMatch(/PRESERVE.*FAIL/)
  })

  it('PM 自动入队声明不是静默白名单：新侧未从 off 进入 queued 时显式失败', () => {
    const r = runHarness(stubEnv('no-pm-auto-enqueue'), ['pm-history'])
    expect(r.status).toBe(1)
    expect(r.out).toContain('PM spec-complete 自动入队断言失败')
  })
})

describe('新侧契约 fixture（.oracle-new-only）', () => {
  it('一次列出全部未满足项的 stub：契约全绿，且不与老脚本双跑', () => {
    const r = runHarness(stubEnv('guard-errors'), ['default-guard-errors'])
    expect(r.out).toContain('新侧契约 fixture')
    expect(r.out).not.toMatch(/\bFAIL\b/)
    expect(r.status).toBe(0)
  })

  it('首错即停的 stub：check 没有一次列全，输出缺少契约要求的原文，抓红', () => {
    const r = runHarness(stubEnv('guard-errors-first'), ['default-guard-errors'])
    expect(r.out).toContain('输出缺少契约要求的原文')
    expect(r.out).toMatch(/\bFAIL\b/)
  })

  it('离开条件不满足却退出 0 的实现：退出码不符契约，抓红', () => {
    // contract stub 的 transition 对 open-complete 直接放行（exit 0），而 fixture 要求 2。
    const r = runHarness(stubEnv('contract'), ['default-guard-errors'])
    expect(r.out).toMatch(/exit 不符契约/)
    expect(r.out).toMatch(/\bFAIL\b/)
  })
})

describe('降级模式（契约测试模式）', () => {
  it('ORACLE_FORCE_DEGRADED=1 + contract stub → 显式 DEGRADED 横幅、契约全绿、exit 0', () => {
    const r = runHarness({ ...stubEnv('contract'), ORACLE_FORCE_DEGRADED: '1' })
    expect(r.out).toContain('DEGRADED: 契约测试模式')
    expect(r.out).not.toMatch(/\bFAIL\b/)
    expect(r.status).toBe(0)
  })

  it('老脚本探针失败（路径不存在）→ 自动降级 + 原因写进报告 + exit 0', () => {
    const r = runHarness(
      { ...stubEnv('contract'), ORACLE_OLD_SCRIPT: '/nonexistent/pipeline-state.sh' },
      ['frontend-quotegate'],
    )
    expect(r.out).toContain('DEGRADED: 契约测试模式')
    expect(r.out).toContain('/nonexistent/pipeline-state.sh')
    expect(r.status).toBe(0)
  })
})

describe('fixtures 生成脚本', () => {
  const cases = [
    ['backend-full', 't6-be', ['.oracle-post-init', 't6-be']],
    ['frontend-quotegate', 't6-fe', ['.oracle-post-init', 't6-fe']],
    ['pm-history', 't6-pm', ['openspec', 'changes', 't6-pm']],
  ] as const

  for (const [name, change, fixturePath] of cases) {
    it(`${name}.sh 独立可跑：生成项目骨架 + .oracle-plan`, () => {
      const target = mkdtempSync(join(tmpdir(), `oracle-fx-${name}-`))
      try {
        const res = spawnSync('bash', [join(here, 'fixtures', `${name}.sh`), target], {
          encoding: 'utf8',
        })
        expect(res.status).toBe(0)
        expect(existsSync(join(target, ...fixturePath))).toBe(true)
        const plan = readFileSync(join(target, '.oracle-plan'), 'utf8')
        expect(plan).toContain(change)
        // 计划行格式：<expected_new_exit>\t<cmd>\t<args...>
        for (const line of plan.split('\n').filter((l) => l && !l.startsWith('#'))) {
          expect(line).toMatch(/^\d+\t\S+\t/)
        }
      } finally {
        rmSync(target, { recursive: true, force: true })
      }
    })
  }

  it('default-effects.sh 独立可跑：确定性 git 仓 + 初始 commit + commit 伪命令行（G2 P3 barrier 覆盖）', () => {
    const target = mkdtempSync(join(tmpdir(), 'oracle-fx-default-effects-'))
    try {
      const res = spawnSync('bash', [join(here, 'fixtures', 'default-effects.sh'), target], { encoding: 'utf8' })
      expect(res.status).toBe(0)
      // 确定性初始 commit（build-complete 冻结此 HEAD；双侧同 SHA 靠固定身份+日期）
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' })
      expect(head.status).toBe(0)
      expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
      const plan = readFileSync(join(target, '.oracle-plan'), 'utf8')
      expect(plan).toContain('t6-de')
      // commit 伪命令行（barrier 造 HEAD 位移）与 barrier 触发的 verify-pass（首列非零期望）
      expect(plan).toMatch(/^0\tcommit\t1$/m)
      expect(plan).toMatch(/^0\tcommit\t2$/m)
      expect(plan).toMatch(/^1\ttransition\tt6-de\tverify-pass$/m)
      for (const line of plan.split('\n').filter((l) => l && !l.startsWith('#'))) {
        expect(line).toMatch(/^\d+\t\S+\t/)
      }
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('default-guard-errors.sh 是只比新侧的契约 fixture：声明 .oracle-new-only，拒绝步退出码 2 / 1，并声明必须出现的报错原文（设计 §1b Q10）', () => {
    const target = mkdtempSync(join(tmpdir(), 'oracle-fx-default-guard-errors-'))
    try {
      const res = spawnSync('bash', [join(here, 'fixtures', 'default-guard-errors.sh'), target], { encoding: 'utf8' })
      expect(res.status).toBe(0)
      expect(existsSync(join(target, '.oracle-new-only'))).toBe(true)
      // 旧版逐字对比用的 sidecar 已不存在：首错即停的旧文案不是新产品的行为准绳。
      expect(existsSync(join(target, '.oracle-stderr-check'))).toBe(false)
      const plan = readFileSync(join(target, '.oracle-plan'), 'utf8')
      expect(plan).toContain('t6-ge')
      // 离开条件不满足：check 与 transition 都是退出码 2；事件不属于当前步骤是用法错误，退出码 1。
      expect(plan).toMatch(/^2\tcheck\tt6-ge\topen$/m)
      expect(plan).toMatch(/^2\ttransition\tt6-ge\topen-complete$/m)
      expect(plan).toMatch(/^1\ttransition\tt6-ge\texplore-complete$/m)
      // 已删除的检查不再出现在计划里。
      expect(plan).not.toMatch(/build_mode|isolation|direct_override|branch_status/)
      // check 一次列全：任务未勾、缺文档、缺技能同时出现。
      const expected = readFileSync(join(target, '.oracle-expect-output'), 'utf8')
      for (const text of ['要求截至本步的 tasks.md 任务都已勾选', "缺少 document 'proposal'", '尚未完成声明的 skill：openspec-propose']) {
        expect(expected).toContain(`2\t${text}`)
      }
      // 计划行格式：<expected_new_exit>\t<cmd>\t<args...>
      for (const line of plan.split('\n').filter((l) => l && !l.startsWith('#'))) {
        expect(line).toMatch(/^\d+\t\S+\t/)
      }
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('pm-history fixture 含老内核 base64 历史区 + PRESERVE 基线 sidecar', () => {
    const target = mkdtempSync(join(tmpdir(), 'oracle-fx-hist-'))
    try {
      spawnSync('bash', [join(here, 'fixtures', 'pm-history.sh'), target], { encoding: 'utf8' })
      const yaml = readFileSync(join(target, 'openspec', 'changes', 't6-pm', '.pipeline.yaml'), 'utf8')
      expect(yaml).toContain('transitions_history:')
      expect(yaml).toContain('prompts_history:')
      expect(yaml).toContain('tools_history:')
      expect(yaml).toMatch(/b64: "[A-Za-z0-9+/=]+"/)
      const sidecar = readFileSync(join(target, '.oracle-preserve'), 'utf8')
      expect(sidecar.split('\n')[0]).toBe('t6-pm')
      // 基线块必须是 yaml 的逐字子串（生成期自洽）
      expect(yaml).toContain(sidecar.split('\n').slice(1).join('\n').trimEnd())
      const extensions = readFileSync(join(target, '.oracle-state-extensions'), 'utf8')
      expect(extensions).toContain('6\tpm-spec-complete-auto-enqueue\tt6-pm\toff\tqueued')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
})
