/**
 * import <name> [--strip] —— 老仓 change 的 base64 历史区 → .pipeline-history.jsonl
 * （BACKLOG #11）。解析/清理归 kernel legacy.ts，本命令只编排：
 *   幂等（JSONL 已有 import 哨兵 → 拒绝重跑）→ 逐条 append → 哨兵收尾
 *   → --strip 时写回清空历史节的 state（其余尾内容 kernel 保证逐字保留）。
 * append 在此 fail-loud（显式导入命令，不同于 set/transition 的 best-effort 记账）。
 */
import { parseLegacyHistory, stripLegacyHistory, type HistoryWriter } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { msg } from '../i18n/messages.js'

async function runImportUnderLock(
  deps: CliDeps,
  dir: string,
  name: string,
  opts: { strip?: boolean },
  history: HistoryWriter,
): Promise<number> {
  const state = await deps.store.read(dir)
  const entries = parseLegacyHistory(state.opaqueTail)
  if (entries.length === 0) {
    deps.io.err(`[IMPORT] ${name}: 无历史区可导入`)
    return 0
  }
  const prior = (await deps.readHistoryRaw?.(dir)) ?? ''
  // 幂等哨兵：逐行 JSON.parse 判 kind==='import'（不用裸子串 includes——历史行的 raw/文本里
  // 若字面含 "kind":"import" 会误判已导入，拒绝真正的首次导入）。非 JSON 行忽略。
  const alreadyImported = prior.split('\n').some((line) => {
    const t = line.trim()
    if (t === '') return false
    try {
      const parsed: unknown = JSON.parse(t)
      return typeof parsed === 'object' && parsed !== null && 'kind' in parsed && parsed.kind === 'import'
    } catch {
      return false
    }
  })
  if (alreadyImported) {
    deps.io.err(`ERROR: ${name} 已导入过（.pipeline-history.jsonl 存在 import 哨兵），拒绝重复导入`)
    return 1
  }
  for (const e of entries) await history.append(dir, e)
  await history.append(dir, {
    ts: deps.clock(),
    kind: 'import',
    raw: `legacy-yaml: ${entries.length} entries`,
  })
  if (opts.strip) {
    await deps.store.writeUnderLock(
      dir,
      { ...state, opaqueTail: stripLegacyHistory(state.opaqueTail) },
      { kind: 'legacy-import' },
    )
  }
  deps.io.err(
    `[IMPORT] ${name}: ${entries.length} 条历史 → .pipeline-history.jsonl${opts.strip ? '（已清理 YAML 历史区）' : ''}`,
  )
  return 0
}

export async function cmdImport(deps: CliDeps, name: string, opts: { strip?: boolean }): Promise<number> {
  if (!isValidChangeName(name)) {
    deps.io.err(`ERROR: ${msg(deps, 'change.nameInvalid', { name })}`)
    return 1
  }
  if (!deps.history) {
    deps.io.err('ERROR: import 需要 history writer（main.ts 装配缺失？）')
    return 1
  }
  const history = deps.history
  const dir = changeDir(deps.cwd, name)
  try {
    // history 幂等检查、append 与可选 canonical strip 同属一次导入事务；同一 change 锁覆盖
    // 全过程，避免并发 import 双写哨兵或 strip 用陈旧 state 覆盖别的 mutation。
    return await deps.store.withLock(dir, () => runImportUnderLock(deps, dir, name, opts, history))
  } catch (e) {
    deps.io.err(`ERROR: ${errMsg(e)}`)
    return 1
  }
}
