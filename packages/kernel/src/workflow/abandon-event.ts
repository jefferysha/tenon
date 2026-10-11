/**
 * 放弃边：任务超出了这条工作流的范围（default 的轻量轨道里由改动风险探针触发），转入终态 `escalated`，
 * 之后另起一个 default 的重型轨道任务。放弃一个任务不该先把它做完，所以走这条边不要求测试、评审者、
 * 文档与技能证据（评审门步骤的人工确认照旧）。
 *
 * 只有这一个常量和判定，独立成叶子模块：Dashboard 的工作流编辑器也要认得这条边（它不是「去下一步 / 退回」），
 * 不该为此把整个执行引擎打进前端包。
 */
export const ABANDON_EVENT = 'scope-expanded'

export function isAbandonEvent(event: string): boolean {
  return event === ABANDON_EVENT
}
