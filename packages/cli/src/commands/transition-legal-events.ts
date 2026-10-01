/**
 * 非法 / 未知 event 的报错要告诉人「此刻能走什么」：default 轨的合法 event 是事件表里 from 等于当前相位的那些。
 * 自定义工作流的 step 已经在 `event-unsupported` 里列出自己的出边，不走这里。
 */
import { TRANSITION_EVENTS } from '@tenon/kernel'
import { resolveChangeDir } from '../paths.js'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'

export function legalEventsAt(phase: string): readonly string[] {
  return Object.entries(TRANSITION_EVENTS)
    .filter(([, edge]) => edge.from === phase)
    .map(([event]) => event)
}

function phaseOf(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value : (value ?? []).join(',')
}

/** 把「当前 step 的合法 event」写成下一行 stderr；current 未知时读一次 state，读不到就不输出（不遮盖原错误）。 */
export async function reportLegalEvents(deps: CliDeps, name: string, current?: string): Promise<void> {
  let phase = current
  if (phase === undefined) {
    try {
      phase = phaseOf((await deps.store.read(resolveChangeDir(deps.cwd, name))).fields.phase)
    } catch {
      return
    }
  }
  if (phase === '') return
  const events = legalEventsAt(phase)
  deps.io.err(msg(deps, 'transition.legalEvents', {
    step: phase,
    events: events.length > 0 ? events.join(', ') : msg(deps, 'transition.noLegalEvents'),
  }))
}
