#!/usr/bin/env node
/**
 * stub-cli.mjs — harness 测试专用的「新 CLI」替身（零依赖 ESM，非产品代码）。
 *
 * STUB_MODE:
 *   mirror   忠实复刻老内核 pipeline-state.sh 实测行为，并实现 fixture 明确声明的 PM
 *            spec-complete 自动入队产品演进——双跑模式下应全绿，证明对比机器既能抓回归，
 *            也不会把被断言的新能力误判为兼容性退化。
 *   contract 忠实遵循 docs/CONTRACT.md §3 契约表
 *            —— 降级（契约测试）模式下应全绿。
 *   corrupt  在 mirror 基础上故意作恶：get 输出错值、写回丢弃未知尾块（历史区）
 *            —— 三面 diff 与 PRESERVE 校验必须抓红。
 *   no-pm-auto-enqueue 仅漏掉 PM spec-complete 的已声明产品演进——用于证明 oracle 的
 *            KNOWN 不是静默白名单，而是会对错误状态显式失败。
 *
 * STUB_TRANSITION_HEAD=1 会在每次写回时附加一个合法形状的 canonical head anchor，
 * 用于钉住 oracle 只忽略该精确内部元数据行、仍逐字比较业务字段的兼容白名单。
 *
 * 老内核实测口径（2026-07-06，见 T6 报告）：
 *   init  stdout 空、exit 0 ；get 缺失字段 → 空行 + exit 0 ；set 成功 stdout 空
 *   transition 成功 stdout 空（消息在 stderr）、非法/未知事件 exit 1
 *   check stdout「[CHECK] …」人读、exit 0/1
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MODE = process.env.STUB_MODE ?? 'mirror'
const argv = process.argv.slice(2)
const cmd = argv[0]

const FIELD_ORDER = [
  'track', 'preset', 'created_by', 'assignee', 'phase', 'phase_status',
  'design_doc', 'plan', 'verification_report', 'build_mode', 'isolation', 'build_sha',
  'agent_review_result', 'codex_review_result', 'verify_result', 'branch_status', 'direct_override',
  'prd_path', 'pr_url',
  'automation', 'automation_queued_at', 'automation_sandbox', 'automation_worktree',
  'automation_attempts', 'automation_last_error', 'automation_preserved_path',
  'branch', 'base_branch', 'scope', 'related_files', 'spec_scope', 'depends_on',
  'created_at', 'updated_at', 'verified_at', 'archived_at', 'archived',
  'workflow', 'automation_current_phase', 'automation_cause',
]

// 老内核 cmd_set 白名单（state-fields.sh ALLOWED_FIELDS）
const ALLOWED = new Set([
  'track', 'preset', 'phase', 'phase_status', 'pipeline_mode',
  'design_doc', 'plan', 'verification_report',
  'build_mode', 'isolation', 'build_sha',
  'agent_review_result', 'codex_review_result', 'verify_result', 'branch_status',
  'direct_override', 'pre_verify_review_result', 'prd_path', 'pr_url',
  'archived', 'archived_at', 'verified_at', 'updated_at',
  'depends_on', 'created_by', 'assignee', 'coverage_confirmed_by',
  'automation', 'automation_queued_at', 'automation_sandbox', 'automation_worktree',
  'automation_attempts', 'automation_last_error', 'automation_preserved_path',
  'branch', 'base_branch', 'scope', 'related_files', 'spec_scope',
])

const ENUMS = {
  track: ['pm', 'frontend', 'backend'],
  preset: ['full', 'hotfix', 'tweak'],
  phase: ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'],
  phase_status: ['pending', 'in_progress', 'done', 'failed'],
  build_mode: ['direct', 'subagent-driven-development', 'parallel-team', 'prototype'],
  isolation: ['branch', 'worktree'],
  verify_result: ['pending', 'pass', 'fail', 'handled', 'skipped'],
  branch_status: ['pending', 'pass', 'fail', 'handled', 'skipped'],
  direct_override: ['true', 'false'],
  pre_verify_review_result: ['pending', 'pass'],
  archived: ['true', 'false'],
  automation: ['off', 'queued', 'scheduled', 'running', 'merged', 'failed', 'conflict', 'paused'],
}

// event → [from, to]（老仓 manifest transitions）
const TRANSITIONS = {
  'open-complete': ['open', 'explore'],
  'explore-complete': ['explore', 'spec'],
  'spec-complete': ['spec', 'build'],
  'build-complete': ['build', 'verify'],
  'verify-pass': ['verify', 'ship'],
  'verify-fail': ['verify', 'build'],
  'ship-complete': ['ship', 'archive'],
  archived: ['archive', 'archive'],
}

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const yamlPath = (name) => join('openspec', 'changes', name, '.pipeline.yaml')
const die = (code, msg) => { if (msg) process.stderr.write(`${msg}\n`); process.exit(code) }
const errExit = (msg) => die(MODE === 'contract' ? 2 : 1, msg) // transition 非法：mirror=1 / contract=2

function readDoc(name) {
  const p = yamlPath(name)
  if (!existsSync(p)) die(1, `ERROR: 状态文件不存在: ${p}`)
  const raw = readFileSync(p, 'utf8')
  return { p, lines: raw.replace(/\n$/, '').split('\n') }
}

const writeDoc = (doc) => writeFileSync(doc.p, doc.lines.join('\n') + '\n')

function getRaw(lines, field) {
  const re = new RegExp(`^${field}:`)
  for (const l of lines) if (re.test(l)) return l.slice(field.length + 1).trim()
  return undefined
}

function unquote(s) {
  if (s === undefined || s.length < 2) return s
  const a = s[0]; const b = s[s.length - 1]
  if (a === b && (a === '"' || a === "'")) return s.slice(1, -1)
  return s
}

function setLine(doc, field, value) {
  const re = new RegExp(`^${field}:`)
  const i = doc.lines.findIndex((l) => re.test(l))
  if (i >= 0) doc.lines[i] = `${field}: ${value}`
  else doc.lines.push(`${field}: ${value}`)
}

const hitsGate = (v) =>
  v.includes('\n') || v.includes('\r') || v.includes(': ') || v.includes(' #') ||
  v.startsWith('"') || v.startsWith("'")

// corrupt 模式作恶：丢弃 37 字段以外的一切行（历史尾块蒸发）
function corruptDrop(doc) {
  const known = new Set(FIELD_ORDER)
  doc.lines = doc.lines.filter((l) => {
    const m = /^([a-z_]+):/.exec(l)
    return m !== null && known.has(m[1])
  })
}

function persist(doc) {
  if (MODE === 'corrupt') corruptDrop(doc)
  if (process.env.STUB_BUSINESS_TAMPER === '1') setLine(doc, 'assignee', 'hostile-oracle-value')
  if (process.env.STUB_TRANSITION_HEAD) {
    const reservedPrefixes = [
      'pipeline_run_id:',
      'pipeline_transition_sequence:',
      'pipeline_transition_head:',
      'pipeline_state_revision:',
      'pipeline_state_revision_id:',
      'pipeline_state_digest:',
      '# oracle-misplaced-anchor:',
      '# tenon-internal-transition-head-v1:',
    ]
    doc.lines = doc.lines.filter(
      (line) => !reservedPrefixes.some((prefix) => line.startsWith(prefix)),
    )
    const runId = 'oracle-stub-run'
    const sequence = 1
    const recordId = 'oracle-stub-record'
    const recordDigest = 'a'.repeat(64)
    const stateDigest = 'b'.repeat(64)
    const revisionId = 'oracle-stub-revision'
    const payload = process.env.STUB_TRANSITION_HEAD === 'malformed'
      ? { schemaVersion: 1 }
      : { schemaVersion: 1, runId, sequence, recordId, recordDigest }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    doc.lines.push(
      `pipeline_run_id: ${runId}`,
      `pipeline_transition_sequence: ${sequence}`,
      `pipeline_transition_head: ${recordId}`,
      'pipeline_state_revision: 1',
      `pipeline_state_revision_id: ${revisionId}`,
      `pipeline_state_digest: ${stateDigest}`,
    )
    if (process.env.STUB_TRANSITION_HEAD === 'misplaced') {
      doc.lines.push('# oracle-misplaced-anchor: true')
    }
    doc.lines.push(`# tenon-internal-transition-head-v1: ${encoded}`)
  }
  writeDoc(doc)
}

// ---------- 子命令 ----------

function cmdInit() {
  const pos = []
  const opts = {}
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--track' || argv[i] === '--preset' || argv[i] === '--user') {
      opts[argv[i].slice(2)] = argv[++i]
    } else pos.push(argv[i])
  }
  const name = pos[0]
  const track = opts.track
  const preset = opts.preset ?? 'full'
  const user = opts.user ?? 'unknown'
  if (!name || !ENUMS.track.includes(track) || !ENUMS.preset.includes(preset)) die(1, 'ERROR: init 参数非法')
  mkdirSync(join('openspec', 'changes', name), { recursive: true })
  const now = ts()
  const review = track === 'pm' ? 'skipped' : 'pending'
  const v = {
    track, preset, created_by: user, assignee: 'null', phase: 'open', phase_status: 'pending',
    design_doc: 'null', plan: 'null', verification_report: 'null',
    build_mode: 'null', isolation: 'null', build_sha: 'null',
    agent_review_result: review, codex_review_result: review,
    verify_result: 'pending', branch_status: 'pending', direct_override: 'false',
    prd_path: 'null', pr_url: 'null',
    automation: 'off', automation_queued_at: '""', automation_sandbox: '""', automation_worktree: '""',
    automation_attempts: '0', automation_last_error: '""', automation_preserved_path: '""',
    branch: 'null', base_branch: 'main', scope: 'null', related_files: 'null', spec_scope: 'null',
    depends_on: 'null', created_at: now, updated_at: now,
    verified_at: 'null', archived_at: 'null', archived: 'false',
    workflow: 'default', automation_current_phase: '""', automation_cause: '""',
  }
  writeFileSync(yamlPath(name), FIELD_ORDER.map((f) => `${f}: ${v[f]}`).join('\n') + '\n')
  if (MODE === 'contract') process.stdout.write(`openspec/changes/${name}\n`) // 契约：创建路径一行
  process.exit(0)
}

function cmdGet() {
  const [, name, field] = argv
  const doc = readDoc(name)
  const raw = getRaw(doc.lines, field)
  if (raw === undefined) {
    if (MODE === 'contract') die(1, `ERROR: 字段不存在: ${field}`) // 契约：字段不存在 exit 1
    process.stdout.write('\n') // 老内核实测：空行 + exit 0
    process.exit(0)
  }
  let out = unquote(raw)
  if (MODE === 'corrupt') out += 'X-CORRUPT'
  process.stdout.write(`${out}\n`)
  process.exit(0)
}

function cmdSet() {
  const [, name, field, value = ''] = argv
  if (!ALLOWED.has(field)) die(1, `ERROR: 非法字段: ${field}`)
  if (ENUMS[field] && !ENUMS[field].includes(value)) die(1, `ERROR: 非法值 '${value}'`)
  if (hitsGate(value)) die(1, `ERROR: 值命中四闸，拒写 (field=${field})`)
  const doc = readDoc(name)
  setLine(doc, field, value)
  setLine(doc, 'updated_at', ts())
  persist(doc)
  process.exit(0)
}

function cmdTransition() {
  const [, name, event] = argv
  const doc = readDoc(name)
  const row = TRANSITIONS[event]
  if (!row) errExit(`ERROR: 未知 event: ${event}`)
  const [from, to] = row
  const phase = unquote(getRaw(doc.lines, 'phase'))
  if (phase !== from) errExit(`ERROR: ${name} 的当前 phase=${phase}，期望 ${from}`)
  const track = unquote(getRaw(doc.lines, 'track'))
  const need = (field, checkFile) => {
    const v = unquote(getRaw(doc.lines, field))
    if (!v || v === 'null' || (checkFile && !existsSync(v))) errExit(`ERROR: ${event} 要求 ${field} 就绪 (当前=${v})`)
    return v
  }
  let status = 'pending'
  switch (event) {
    case 'explore-complete': need('design_doc', true); break
    case 'spec-complete': if (track !== 'pm') need('plan', true); break
    case 'build-complete': {
      need('build_mode', false); const iso = need('isolation', false)
      if (!ENUMS.isolation.includes(iso)) errExit(`ERROR: 非法 isolation: ${iso}`)
      const preset = unquote(getRaw(doc.lines, 'preset'))
      const bm = unquote(getRaw(doc.lines, 'build_mode'))
      const ovr = unquote(getRaw(doc.lines, 'direct_override'))
      if (preset === 'full' && bm === 'direct' && ovr !== 'true') errExit('ERROR: direct_override 必须为 true')
      // 老内核口径：build_sha = `$(git rev-parse HEAD 2>/dev/null || echo "")` 的捕获值。有 commit
      // 的 fixture 仓得到真实 SHA；无 commit 仓（unborn branch）上 rev-parse 仍把字面 "HEAD" 打到
      // stdout，捕获后非空 → 写成字面 HEAD。两种情况都按同一命令逐字对齐。
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? ''
      if (head !== '') setLine(doc, 'build_sha', head)
      break
    }
    case 'verify-pass': {
      need('verification_report', true)
      if (unquote(getRaw(doc.lines, 'branch_status')) !== 'handled') errExit('ERROR: 要求 branch_status=handled')
      setLine(doc, 'verify_result', 'pass')
      setLine(doc, 'verified_at', ts())
      break
    }
    case 'verify-fail':
      setLine(doc, 'verify_result', 'fail'); setLine(doc, 'build_sha', 'null'); status = 'in_progress'; break
    case 'archived':
      setLine(doc, 'archived', 'true'); setLine(doc, 'archived_at', ts()); status = 'done'; break
    default: break
  }
  setLine(doc, 'phase', to)
  setLine(doc, 'phase_status', status)
  setLine(doc, 'updated_at', ts())
  // pm-history 的第 6 步用 .oracle-state-extensions 明确声明了这条后置能力。stub 也必须
  // 产生同一新侧状态，避免 harness 单测把“声明且验证的产品演进”降级成未覆盖的模拟差异。
  if (MODE !== 'no-pm-auto-enqueue' && event === 'spec-complete' && track === 'pm' && unquote(getRaw(doc.lines, 'automation')) === 'off') {
    setLine(doc, 'automation', 'queued')
    setLine(doc, 'automation_queued_at', ts())
  }
  persist(doc)
  if (MODE === 'contract') process.stdout.write(`${from} -> ${to}\n`) // 契约：`old -> new` 一行
  else process.stderr.write(`[TRANSITION] ${name}: ${from} -> ${to}\n`)
  process.exit(0)
}

function cmdCheck() {
  const [, name] = argv
  readDoc(name) // 状态文件必须在
  // fixture 计划只含「应通过」的 check；stdout 为人读面，harness 对 check 的 stdout 记 SKIP
  if (MODE === 'contract') process.stdout.write(`[guard] ${name}: pass\n`)
  else process.stdout.write(`[CHECK] ${name} 前置条件验证：\n`)
  process.exit(0)
}

switch (cmd) {
  case 'init': cmdInit(); break
  case 'get': cmdGet(); break
  case 'set': cmdSet(); break
  case 'transition': cmdTransition(); break
  case 'check': cmdCheck(); break
  // G1 oracle seed 在直改新侧 YAML 后会显式调用 import；stub 没有第二份 canonical store，
  // 因而这一步的忠实等价行为就是确认 adapter 已经是当前状态并成功 no-op。
  case 'state': {
    const [, sub, name] = argv
    if (sub !== 'import-legacy') die(1, `未知 state 子命令: ${sub}`)
    readDoc(name)
    process.exit(0)
    break
  }
  default: die(1, `未知子命令: ${cmd}`)
}
