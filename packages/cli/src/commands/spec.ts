/**
 * spec 子命令 —— living spec 库（specs 列表 / set-spec-scope / inject-jsonl；GOAL A1 内核深度 /
 * D2 超越 Tenon contract 的规范库，BACKLOG #16）。
 * 老仓真相源：skills/pipeline/scripts/state-spec.sh（语义盘点见 kernel/src/state/spec.ts 顶注）。
 *   specs [--json]              列出 main capability + spec.md 路径（stdout 文本表 / JSON 数组）
 *   set-spec-scope <c> [scope]  写 spec_scope（空/清空 归一 null 哨兵；否则 list CSV / all 原样），无 stdout
 *   inject-jsonl <c> [agent]    注入 per-agent 清单：header + 逐 entry 内容（stdout）；WARN 走 stderr；fail-open rc0
 * stdout/exit 对齐老仓：specs 数据走 stdout（老仓 echo/printf）；set-spec-scope 的 green [OK] 走
 * stderr（老仓 green >&2）；inject header/内容走 stdout，WARN 走 stderr。exit：错误/非法名 = 1；
 * inject 内容问题（bad agent / 缺文件 / 坏行）恒 rc0（老仓注入期 fail-open，绝不非零退出）。
 */
import type { HistoryEntry } from '@tenon/kernel'
import {
  injectJsonl,
  listSpecEntries,
  specScopeWriteValue,
  type InjectOutcome,
  type SpecEntry,
  type SpecListing,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { cmdSpecApply } from './specApply.js'

export type { InjectOutcome, InjectChunk, SpecEntry, SpecListing } from '@tenon/kernel'

/** living spec 库 fs 注入面（默认真 fs；mock 层注入 fake，见 spec.test.ts）。 */
export interface SpecFs {
  listSpecs: (cwd: string) => Promise<SpecListing>
  inject: (cwd: string, name: string, agent: string) => Promise<InjectOutcome>
}

const REAL_FS: SpecFs = { listSpecs: listSpecEntries, inject: injectJsonl }

/** change 名校验（显式挡 undefined/空——同 task.ts checkName）。 */
function checkName(deps: CliDeps, name: string | undefined): name is string {
  if (name !== undefined && name !== '' && isValidChangeName(name)) return true
  deps.io.err(`ERROR: change-name 非法: '${name ?? ''}' (仅允许 a-z A-Z 0-9 - _)`)
  return false
}

/** history 记账 best-effort（同 fields.ts recordHistory：失败仅 WARN，不影响主写 exit）。 */
async function recordHistory(deps: CliDeps, dir: string, entry: HistoryEntry): Promise<void> {
  if (!deps.history) return
  try {
    await deps.history.append(dir, entry)
  } catch (e) {
    deps.io.err(`WARN: history 写入失败: ${errMsg(e)}`)
  }
}

// === specs：capability 列表（老仓 cmd_specs） ===

/** JSON 手工构造（老仓 :51-52 printf 逐字段，capability 名/路径为 fs dir 名，安全）。 */
function specsJson(entries: SpecEntry[]): string {
  const items = entries.map(
    (e) => `{"name":"${e.name}","spec_path":"${e.specPath}","has_spec":${e.hasSpec}}`,
  )
  return `[${items.join(',')}]`
}

async function cmdSpecs(deps: CliDeps, args: string[], fs: SpecFs): Promise<number> {
  const json = args.includes('--json')
  const listing = await fs.listSpecs(deps.cwd)
  if (!listing.exists) {
    // 老仓 :37-40：json → []；text → (无 main spec — <dir> 不存在)
    deps.io.out(json ? '[]' : `(无 main spec — ${listing.dir} 不存在)`)
    return 0
  }
  if (json) {
    deps.io.out(specsJson(listing.entries))
    return 0
  }
  deps.io.out('## Main Specs（capability → spec.md）')
  if (listing.entries.length === 0) {
    deps.io.out('  (无 main spec)')
    return 0
  }
  for (const e of listing.entries) {
    // 老仓 printf '  - %-32s %s'：name 左对齐宽 32
    deps.io.out(`  - ${e.name.padEnd(32)} ${e.hasSpec ? e.specPath : '(无 spec.md)'}`)
  }
  return 0
}

// === set-spec-scope：写 spec_scope（老仓 cmd_set_spec_scope） ===

async function cmdSetSpecScope(deps: CliDeps, name: string | undefined, scope: string | undefined): Promise<number> {
  if (!checkName(deps, name)) return 1
  const value = specScopeWriteValue(scope)
  const dir = changeDir(deps.cwd, name)
  try {
    // 老仓 ensure_state_exists（cmd_set 前置）：状态文件缺 → fail-loud exit 1。
    await deps.store.read(dir)
    // spec_scope 是 list 字段，但本命令按老仓语义写标量 CSV/哨兵（parse.ts 对 list 字段的 inline
    // 标量保持 string，序列化回标量行）。四闸由 store.set 承担。
    await deps.store.set(dir, 'spec_scope', value)
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
  await recordHistory(deps, dir, { ts: deps.clock(), kind: 'set', field: 'spec_scope', to: value })
  // 老仓 green（→ stderr）：空 → null（全扫，fail-open）；否则回显 scope
  if (value === 'null') deps.io.err(`[OK] set-spec-scope ${name}: null（全扫，fail-open）`)
  else deps.io.err(`[OK] set-spec-scope ${name}: ${value}`)
  return 0
}

// === inject-jsonl：per-agent 清单注入（老仓 cmd_inject_jsonl） ===

/** cat 一个 chunk 的内容（去单层尾换行后逐行 out；空内容不产行，对齐 cat 空文件）。 */
function emitContent(deps: CliDeps, content: string): void {
  if (content === '') return
  for (const line of content.replace(/\n$/, '').split('\n')) deps.io.out(line)
}

async function cmdInjectJsonl(deps: CliDeps, args: string[], fs: SpecFs): Promise<number> {
  const name = args[0]
  const agent = args[1] ?? 'implement'
  // 老仓 validate_change_name 硬失败（非注入内容问题，不走 fail-open）
  if (!checkName(deps, name)) return 1
  const outcome = await fs.inject(deps.cwd, name, agent)
  if (outcome.kind === 'bad-agent') {
    // 老仓 _jsonl_path red + inject `|| return 0`：stderr 报错但 rc0
    deps.io.err(`Error: jsonl agent 仅支持 implement / check（得到: ${agent}）`)
    return 0
  }
  if (outcome.kind === 'missing') {
    deps.io.err(`WARN: ${outcome.jsonlPath} 不存在 — sub-agent 仅收到 task artifacts（无 curated context）`)
    return 0
  }
  deps.io.out(`## Curated Context Manifest · ${agent} (${outcome.jsonlPath})`)
  for (const chunk of outcome.chunks) {
    deps.io.out('') // 老仓 printf '\n=== ...'：前导空行
    deps.io.out(`=== ${chunk.path} ===`)
    emitContent(deps, chunk.content)
  }
  for (const w of outcome.warnings) deps.io.err(w)
  if (!outcome.sawReal) {
    deps.io.err(`WARN: ${outcome.jsonlPath} has no curated entries (only seed) — sub-agent 仅收 task artifacts`)
  }
  return 0
}

/**
 * spec 子命令分派（纯函数 + deps 注入，风格同 task.ts）。
 * fs 缺省真 fs（integration 走真路径）；mock 层注入 fake SpecFs 快速回归。
 */
export async function cmdSpec(
  deps: CliDeps,
  sub: string,
  args: string[],
  fs: SpecFs = REAL_FS,
): Promise<number> {
  switch (sub) {
    case 'specs':
      return cmdSpecs(deps, args, fs)
    case 'set-spec-scope':
      return cmdSetSpecScope(deps, args[0], args[1])
    case 'inject-jsonl':
      return cmdInjectJsonl(deps, args, fs)
    case 'apply':
      if (!checkName(deps, args[0])) return 1
      return cmdSpecApply(deps, args[0], {
        dryRun: args.includes('--dry-run'),
        json: args.includes('--json'),
      })
    default:
      deps.io.err(`ERROR: 未知 spec 子命令: ${sub}（支持: specs set-spec-scope inject-jsonl apply）`)
      return 1
  }
}
