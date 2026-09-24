/**
 * 工作台可复制的终端命令。都先 `cd` 到任务所在项目：所有项目视图里用户不一定在那个目录。
 * 路径与名字按 POSIX shell 单引号转义，粘贴即可运行。
 */

const PLAIN = /^[A-Za-z0-9_./:@%+=,-]+$/u

export function shellQuote(value: string): string {
  if (value !== '' && PLAIN.test(value)) return value
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function inProject(root: string, command: string): string {
  return `cd ${shellQuote(root)} && ${command}`
}

/** 完整的下一步（`step.next`）与全部阻断：`tenon status <change>`。 */
export function statusCommand(root: string, change: string): string {
  return inProject(root, `tenon status ${shellQuote(change)}`)
}

/**
 * 在自己的 agent 对话里接手：发给 agent 的提示词，不是终端命令（不 cd、不转义）。router hook 把
 * 「继续」+ 完整点名的 change 名识别为 resume（hooks/prompt-intent.sh `pipeline_prompt_requests_resume`），
 * tenon 技能随后只接手这个任务。不用 `tenon session activate`：那是授予连续执行权。
 */
export function takeoverPrompt(change: string): string {
  return `/tenon 继续 ${change}`
}

/** 评审门退回：为退回边请求评审，之后在工作台确认（通过）。 */
export function reviewRequestCommand(root: string, change: string, event: string): string {
  return inProject(root, `tenon review request ${shellQuote(change)} --event ${shellQuote(event)}`)
}

/** 新建任务的完整命令（空态引导），不省略 --preset。 */
export const INIT_COMMAND = 'tenon init my-change --workflow default --track chat --preset full'
