/**
 * phase-manifest 的前进边判定。
 *
 * 单独成叶子模块：implicit-completion.ts 的 `isForwardEdge` 在运行时依赖图里处于接缝之下
 * （compile.ts → step-rounds.ts → implicit-completion.ts，且 compile.ts 只传执行模型名、没有计划对象），
 * 它不能反向 import 接缝，只能调用这里。
 */
import { DEFAULT_EVENT_POLICY } from '../../flow/default-event-policy.js'

/** 前进边 = 事件策略声明 `enforceTaskExit` 的事件（相位完成边）；其余（含未知事件）都不是。 */
export function legacyIsForwardEdge(event: string): boolean {
  const policy = (DEFAULT_EVENT_POLICY as Record<string, { readonly enforceTaskExit: boolean } | undefined>)[event]
  return policy?.enforceTaskExit === true
}
