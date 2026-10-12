/**
 * inbox [--json] —— 收件箱：等待人工决策的 change 一屏清单（BACKLOG #9a）。
 * 回答的唯一问题：「现在哪个 change 在等我做什么决定」（老仓 UI 病灶 2 的 lite 解法）。
 *
 * 两类来源，按等待时长降序：
 *   1. 项目根新鲜（age ≤ GATE_TTL_MS[kind]，分级 TTL 同 gate.sh，BACKLOG #13
 *      对齐老内核：confirm 300s / review·interaction 1800s）marker → gate:<kind>。
 *      review 只接受带 Change identity 的 v2 projection；旧“进入 phase 即写”的三行 marker
 *      已被迁移为非权威投影，不能把无关 Change 重新塞回收件箱。
 *   2. canonical review receipt（review_gate_status=pending）→ review-request。它独立于 marker
 *      TTL，所以短时 hook 投影过期/丢失也不会把真正等待人类确认的 Change 隐藏掉。
 * 坏 change 跳过 + WARN（fail-open）；exit 恒 0。
 */
import { join } from 'node:path'
import { GATE_TTL_MS, parseReviewMarker, reviewGatePendingFor } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { str } from '../render.js'

interface InboxItem {
  name: string
  phase: string
  waiting_on: string
  waiting_s: number
  hint: string
}

/** 90 → "1m30s" 级别的紧凑时长（人读列） */
function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`
}

const REVIEW_HINT = '已请求人工复核：查看该相位产出并明确“确认继续”'

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 自足单页（零外部资源、深浅色自适应）；快照语义——页头标生成时间 */
function renderHtml(items: InboxItem[], generatedAt: string): string {
  const rows = items
    .map(
      (i) => `<tr><td class="n">${escapeHtml(i.name)}</td><td>${escapeHtml(i.phase)}</td>` +
        `<td class="w">${fmtDuration(i.waiting_s)}</td>` +
        `<td><span class="b">${escapeHtml(i.waiting_on)}</span> ${escapeHtml(i.hint)}</td></tr>`,
    )
    .join('\n')
  const body = items.length === 0
    ? '<p class="empty">收件箱空——没有在等你的事。</p>'
    : `<table><thead><tr><th>CHANGE</th><th>PHASE</th><th>等待</th><th>在等什么</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pipeline 收件箱</title>
<style>
:root{color-scheme:light dark;--ink:#1a1a1a;--paper:#fff;--line:#e2e2e2;--dim:#6b6b6b;--badge:#eef2ff;--badge-ink:#3730a3}
@media(prefers-color-scheme:dark){:root{--ink:#e6e6e6;--paper:#141414;--line:#333;--dim:#9a9a9a;--badge:#1e2350;--badge-ink:#c7d2fe}}
body{margin:2rem auto;max-width:52rem;padding:0 1rem;font:15px/1.6 system-ui,sans-serif;color:var(--ink);background:var(--paper)}
h1{font-size:1.2rem}small{color:var(--dim)}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.75rem;letter-spacing:.05em;color:var(--dim)}
.n{font-weight:600;font-family:ui-monospace,monospace}.w{white-space:nowrap;font-variant-numeric:tabular-nums}
.b{display:inline-block;padding:0 .5em;border-radius:.6em;background:var(--badge);color:var(--badge-ink);font-size:.8em;font-family:ui-monospace,monospace}
.empty{color:var(--dim);margin-top:2rem}
</style></head><body>
<h1>pipeline 收件箱 <small>生成于 ${escapeHtml(generatedAt)} · 快照（重跑 inbox --html 刷新）</small></h1>
${body}
</body></html>`
}

export async function cmdInbox(deps: CliDeps, opts: { json?: boolean; html?: boolean }): Promise<number> {
  const items: InboxItem[] = []
  const seen = new Set<string>()

  // 1. 三门 marker（分级新鲜判定同 gate.sh：age > GATE_TTL_MS[kind] 才陈旧，边界仍新鲜）
  const markers = (await deps.readGateMarkers?.()) ?? []
  for (const m of markers) {
    if (m.ageMs > GATE_TTL_MS[m.kind]) continue
    if (m.kind === 'review') {
      const receipt = parseReviewMarker(m.raw)
      // v1 marker was an entry-time lock.  Its only safe migration is to ignore it here; the
      // canonical review receipt now governs whether a transition may leave the phase.
      if (!receipt) continue
      items.push({
        name: receipt.changeName,
        phase: receipt.phase,
        waiting_on: 'gate:review',
        waiting_s: Math.floor(m.ageMs / 1000),
        hint: REVIEW_HINT,
      })
      seen.add(receipt.changeName)
      continue
    }
    const [phase = '?', hint = '', name = '?'] = m.raw.split('\n')
    items.push({
      name,
      phase,
      waiting_on: `gate:${m.kind}`,
      waiting_s: Math.floor(m.ageMs / 1000),
      hint,
    })
    seen.add(name)
  }

  // 2. Canonical review receipt (default and custom workflows share the same state protocol).
  const now = Date.parse(deps.clock())
  const changesRoot = join(deps.cwd, 'openspec', 'changes')
  for (const name of await deps.listChanges(changesRoot)) {
    if (seen.has(name)) continue
    let state
    try {
      state = await deps.store.read(join(changesRoot, name))
    } catch (e) {
      deps.io.err(`WARN: 跳过坏 change ${name}: ${errMsg(e)}`)
      continue
    }
    const fields = state.fields
    if (str(fields.archived) === 'true') continue
    const phase = str(fields.phase)
    if (!reviewGatePendingFor(state, phase)) continue
    const requested = Date.parse(str(fields.review_requested_at))
    const waitingS = Number.isNaN(requested) ? 0 : Math.max(0, Math.floor((now - requested) / 1000))
    items.push({ name, phase, waiting_on: 'review-request', waiting_s: waitingS, hint: REVIEW_HINT })
  }

  items.sort((a, b) => b.waiting_s - a.waiting_s)

  if (opts.json) {
    deps.io.out(JSON.stringify({ inbox: items }))
    return 0
  }
  if (opts.html) {
    deps.io.out(renderHtml(items, deps.clock()))
    return 0
  }
  if (items.length === 0) {
    deps.io.out('收件箱空——没有在等你的事。')
    return 0
  }
  const nameW = Math.max(6, ...items.map((i) => i.name.length))
  const phaseW = Math.max(5, ...items.map((i) => i.phase.length))
  const waitW = Math.max(4, ...items.map((i) => fmtDuration(i.waiting_s).length))
  deps.io.out(`${'CHANGE'.padEnd(nameW)}  ${'PHASE'.padEnd(phaseW)}  ${'等待'.padEnd(waitW)}  在等什么`)
  for (const i of items) {
    deps.io.out(
      `${i.name.padEnd(nameW)}  ${i.phase.padEnd(phaseW)}  ${fmtDuration(i.waiting_s).padEnd(waitW)}  [${i.waiting_on}] ${i.hint}`,
    )
  }
  return 0
}
