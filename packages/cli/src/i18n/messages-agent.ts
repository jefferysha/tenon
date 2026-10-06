/**
 * `tenon agent prompt | record | next` 里不属于跨厂商评审路由的输出：prompt / record 的拒绝与报告错误、
 * 评审者重跑防刷（F8），以及 `agent next` 的人读行（角色、状态、结果、重跑与宿主说明、下一波）。
 * `zh` 与这些命令原有的中文输出逐字一致；`ERROR:` / `WARN:` 前缀由调用处保留。
 * 宿主路由与登记拒绝在 messages-review.ts。
 */
export const AGENT_MESSAGES = {
  'agent.notDeclared': {
    zh: "agent '{agent}' 未在步骤 '{step}' 声明",
    en: "agent '{agent}' is not declared in step '{step}'",
  },
  'agent.notFrozen': {
    zh: "agent '{agent}' 未随本任务冻结；重新创建任务或改工作流",
    en: "agent '{agent}' was not frozen with this task; recreate the task or change the workflow",
  },
  'agent.waiting': {
    zh: "agent '{agent}' 还需等待：{needs}",
    en: "agent '{agent}' still has to wait for: {needs}",
  },
  'agent.rerun.reasonInvalid': {
    zh: '--rerun-reason 需要一行不超过 {max} 字的原因',
    en: '--rerun-reason needs a one-line reason of at most {max} characters',
  },
  'agent.rerun.refused': {
    zh: "评审者 '{agent}' 在当前候选上已经有 {count} 次结论（{results}）：同一份代码不能靠重跑换结论。改代码换候选后再重跑；确有需要（例如上次的提示缺上下文）用 tenon agent prompt {change} {agent} --rerun-reason <原因> 写明并留痕，判定会把同一候选上的所有运行一并看（没有原因的重跑取最严结论，有原因的以最后一次为准）",
    en: "reviewer '{agent}' already has {count} verdict(s) on the current candidate ({results}): the same code cannot change its verdict by rerunning. Change the code to get a new candidate, then rerun; if you really need to (for example the last prompt lacked context), state why and leave a trace with tenon agent prompt {change} {agent} --rerun-reason <reason>. The verdict looks at every run on the same candidate together (a rerun without a reason takes the strictest verdict, a rerun with a reason takes the last one)",
  },
  'agent.record.subagentInvalid': {
    zh: "--subagent '{subagent}' 非法",
    en: "--subagent '{subagent}' is not valid",
  },
  'agent.record.runNotRunning': {
    zh: "run '{run}' 不是本次步骤访问中进行中的运行",
    en: "run '{run}' is not a running run of this step visit",
  },
  'agent.record.reportTooLarge': {
    zh: '报告无效：超过 {max} 字节',
    en: 'invalid report: larger than {max} bytes',
  },
  'agent.record.reportUnreadable': {
    zh: '报告无效：{path} 读不到',
    en: 'invalid report: cannot read {path}',
  },
  'agent.record.reportInvalid': {
    zh: '报告无效：{error}',
    en: 'invalid report: {error}',
  },
  'agent.record.candidateChanged': {
    zh: '评审期间候选已变化；重跑：tenon agent prompt {change} {agent}',
    en: 'the candidate changed during the review; run it again: tenon agent prompt {change} {agent}',
  },
  'agent.next.role.executor': { zh: '执行者', en: 'executor' },
  'agent.next.role.reviewer': { zh: '评审者', en: 'reviewer' },
  'agent.next.state.idle': { zh: '未运行', en: 'idle' },
  'agent.next.state.running': { zh: '进行中', en: 'running' },
  'agent.next.state.done': { zh: '已完成', en: 'done' },
  'agent.next.state.stale': { zh: '过期', en: 'stale' },
  'agent.next.result.pass': { zh: '通过', en: 'pass' },
  'agent.next.result.fail': { zh: '不通过', en: 'fail' },
  'agent.next.result.done': { zh: '完成', en: 'done' },
  'agent.next.result.failed': { zh: '失败', en: 'failed' },
  'agent.next.findings': {
    zh: '问题 {count}',
    en: 'findings {count}',
  },
  'agent.next.rerun': {
    zh: ' 重跑 {count} 次{flipped}{reason}',
    en: ' reran {count} time(s){flipped}{reason}',
  },
  'agent.next.rerun.flipped': {
    zh: '（结论翻转）',
    en: ' (verdict flipped)',
  },
  'agent.next.rerun.reason': {
    zh: '：{reason}',
    en: ': {reason}',
  },
  'agent.next.host.mismatch': {
    zh: ' 宿主不符：要求 {required}，登记 {host}，结论无效',
    en: ' host mismatch: requires {required}, recorded {host}, result invalid',
  },
  'agent.next.host.none': {
    zh: '无',
    en: 'none',
  },
  'agent.next.host.recorded': {
    zh: ' 宿主 {host}',
    en: ' host {host}',
  },
  'agent.next.host.required': {
    zh: ' 要求宿主 {host}',
    en: ' requires host {host}',
  },
  'agent.next.wave': {
    zh: '下一波：{agents}',
    en: 'Next wave: {agents}',
  },
  'agent.next.running': {
    zh: '进行中：{agent}；完成后 tenon agent record {change} {run}',
    en: 'Running: {agent}; when it finishes run tenon agent record {change} {run}',
  },
  'agent.next.waiting': {
    zh: '等待：{agent} ← {needs}',
    en: 'Waiting: {agent} ← {needs}',
  },
  'agent.next.allDone': {
    zh: '全部完成',
    en: 'All done',
  },
  'agent.next.unfinished': {
    zh: '未完成：{blocker}',
    en: 'Not finished: {blocker}',
  },
} as const
