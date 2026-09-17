/**
 * `tenon agent prompt` 的提示词渲染。布局固定、逐字确定：宿主把它当普通子 agent 的 prompt
 * 直接派发，Tenon 不写任何宿主的 agent 目录，也不调用模型。
 */
import type { AgentRole, FrozenAgent } from '@tenon/kernel'
import type { TestRunRecordV1 } from '@tenon/kernel'

export interface AgentPromptInput {
  readonly change: string
  readonly step: string
  readonly role: AgentRole
  readonly runId: string
  readonly candidate: string
  readonly frozen: FrozenAgent
  readonly blockAt?: string
  readonly reportPath: string
  /** 步骤自己的补充说明（工作流 YAML 的 `prompt:`）。 */
  readonly stepPrompt?: string
  /** `reads_tests` 引用的测试结果，Tenon 执行后交给评审者。 */
  readonly tests: readonly { readonly id: string; readonly run: TestRunRecordV1 | undefined }[]
}

const RESULT_HINT: Readonly<Record<AgentRole, string>> = {
  reviewer: '{"findings":[{"severity":"critical|high|medium|low","location":"<path:line>","message":"<一句话>"}]}',
  executor: '{"result":"done|failed","findings":[{"severity":"critical|high|medium|low","location":"<path:line>","message":"<一句话>"}]}',
}

function testLine(item: AgentPromptInput['tests'][number]): string {
  if (item.run === undefined) return `- ${item.id} 未运行`
  const word = item.run.result === 'pass' ? '通过' : '未通过'
  const outputs = item.run.outputs.filter((output) => output.present).map((output) => output.path).join(' ')
  return `- ${item.id} ${word} exit=${item.run.exit_code}${outputs === '' ? '' : ` ${outputs}`}`
}

export function renderAgentPrompt(input: AgentPromptInput): string {
  const definition = input.frozen.definition
  const header = [
    `<tenon-agent change="${input.change}" step="${input.step}" role="${input.role}" run="${input.runId}">`,
    `候选：${input.candidate}`,
    ...(definition.skills.length === 0 ? [] : [`技能：${definition.skills.join(', ')}`]),
    ...(definition.tools.length === 0 ? [] : [`工具：${definition.tools.join(', ')}`]),
    ...(input.blockAt === undefined ? [] : [`阻断：${input.blockAt}`]),
    ...(input.tests.length === 0 ? [] : ['测试：', ...input.tests.map(testLine)]),
    ...(input.stepPrompt === undefined ? [] : [`步骤说明：${input.stepPrompt}`]),
    `报告：${input.reportPath}`,
    `结束：tenon agent record ${input.change} ${input.runId}`,
    '</tenon-agent>',
  ]
  return [
    header.join('\n'),
    '',
    definition.body.trim(),
    '',
    '## tenon-result',
    `报告末尾写一个 \`\`\`tenon-result\`\`\` 代码块：${RESULT_HINT[input.role]}`,
    '',
  ].join('\n')
}
