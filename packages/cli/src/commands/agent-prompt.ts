/**
 * `tenon agent prompt` 的提示词渲染。布局固定、逐字确定：宿主把它作为子代理（专属 `tenon-<name>`
 * 或退回的通用子代理）的 prompt 派发，两种都拿到同一份全文；Tenon 不调用模型。
 */
import { qualifySkillReferences, waiverReasonText, type AgentRole, type FrozenAgent } from '@tenon/kernel'
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
  /**
   * `reads_tests` 引用的测试结果，Tenon 执行后交给评审者。计划里对这条测试有豁免时带 `waiver`：
   * 评审者要知道它失败了、有人要放行它、以及是否已经评审批准（`approved` 取自策略判定：批准要绑定当前这份代码）。
   */
  readonly tests: readonly {
    readonly id: string
    readonly run: TestRunRecordV1 | undefined
    readonly waiver?: { readonly approved: boolean; readonly reason: string }
  }[]
  /** 目录套件的最新运行摘要（失败用例、flaky、覆盖率对照门槛、基准变化）；已渲染成行，空 = 没有可附的。 */
  readonly testSummary?: readonly string[]
  /** 评审要求（或建议）的宿主：登记命令带 `--host <它>`，登记的宿主就是这次评审声明的宿主。 */
  readonly recordHost?: string
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

/**
 * 结果行，其下（有豁免时）一行豁免。理由是登记者（常是执行者 agent）的自述：标注未经核实，并按 kernel 的展示口径折成单行、
 * 截到 200 字、反引号与尖括号换成全角——评审者提示词的行结构不被换行打乱，理由也伪造不出代码块或标签。
 */
function testLines(item: AgentPromptInput['tests'][number]): readonly string[] {
  if (item.waiver === undefined) return [testLine(item)]
  return [
    testLine(item),
    `  豁免（${item.waiver.approved ? '已批准' : '待评审批准'}，理由为登记者自述、未经核实）：${waiverReasonText(item.waiver.reason)}`,
  ]
}

export function renderAgentPrompt(input: AgentPromptInput): string {
  const definition = input.frozen.definition
  const header = [
    `<tenon-agent change="${input.change}" step="${input.step}" role="${input.role}" run="${input.runId}">`,
    `候选：${input.candidate}`,
    ...(definition.skills.length === 0 ? [] : [`技能：${definition.skills.join(', ')}`]),
    ...(definition.tools.length === 0 ? [] : [`工具：${definition.tools.join(', ')}`]),
    ...(input.blockAt === undefined ? [] : [`阻断：${input.blockAt}`]),
    ...(input.tests.length === 0 ? [] : ['测试：', ...input.tests.flatMap(testLines)]),
    ...(input.testSummary ?? []),
    ...(input.stepPrompt === undefined ? [] : [`步骤说明：${input.stepPrompt}`]),
    `报告：${input.reportPath}`,
    `结束：tenon agent record ${input.change} ${input.runId}${input.recordHost === undefined ? '' : ` --host ${input.recordHost}`}`,
    '</tenon-agent>',
  ]
  return [
    header.join('\n'),
    '',
    qualifySkillReferences(definition.body, definition.skills).trim(),
    '',
    '## tenon-result',
    `报告末尾写一个 \`\`\`tenon-result\`\`\` 代码块：${RESULT_HINT[input.role]}`,
    '',
  ].join('\n')
}
