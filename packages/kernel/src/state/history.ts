/**
 * lite 历史侧文件 —— <changeDir>/.pipeline-history.jsonl，一行一个 JSON（CONTRACT §1）。
 * 老内核把 base64 历史区塞进 YAML 的存储变形，在 lite 以 JSONL 侧文件修复（GOAL.md 动机 4）。
 * writer 本身 fail-loud；best-effort（失败仅 WARN）语义由 CLI 调用方兜。
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryEntry, HistoryWriter } from '../types.js'
import { actorOf, parseUserRef, type RecordActor } from '../users/user.js'
import type { TransitionRecord } from '../workflow/run-types.js'

export const HISTORY_FILE = '.pipeline-history.jsonl'

/**
 * `actor` stamps the declared operator on rows that carry none (the CLI passes its resolved identity, so every
 * command's rows are attributed without per-command edits). A row that already names an actor keeps it.
 */
export function createHistoryWriter(options: { readonly actor?: () => RecordActor | undefined } = {}): HistoryWriter {
  return {
    async append(changeDir: string, entry: HistoryEntry): Promise<void> {
      const actor = entry.actor ?? options.actor?.()
      const row = actor === undefined ? entry : { ...entry, actor }
      await appendFile(join(changeDir, HISTORY_FILE), `${JSON.stringify(row)}\n`, 'utf8')
    },
  }
}

/**
 * canonical TransitionRecord → JSONL 兼容投影行的唯一构造点（W1 第二增量：history 合并边界
 * 从时间戳比较改成逐条来源标记）。CLI/server 四处 canonical transition 收尾都必须用这个函数
 * 写 JSONL，不能各自手填 from/to/event/ts——那样等于对同一份数据维护两份独立真相，任何一处
 * 漂移都会让 readChangeHistory() 的 transitionRecordId 去重判断失真。
 * The record's user-ref string actor is projected as the history actor object.
 */
export function transitionRecordToHistoryEntry(record: TransitionRecord): HistoryEntry {
  const ref = parseUserRef(record.actor)
  return {
    ts: record.observedAt,
    kind: 'transition',
    from: record.from,
    to: record.to,
    raw: record.event,
    transitionRecordId: record.id,
    ...(ref === null ? {} : { actor: actorOf(ref) }),
  }
}
