/**
 * `tenon agent new [<name>] --role --description --skills --tools --model --hosts [--scope] [--from]`
 *
 * 在终端生成一个 agent 文件并登记进库。全参数时非交互可用；终端交互时缺的项逐个问（给出默认值）。
 * `--from <agent>` 以现有 agent（通常是官方）为底：字段作默认值、正文整段沿用；否则按身份生成
 * 固定结构的正文骨架（职责 / 只做与不做 / 方法 / 自检 / 报告），起草细节交给 agent-author 技能。
 */
import {
  AGENT_NAME_RE, AGENT_ROLES, KNOWN_AGENT_HOSTS, effectiveAgent,
  type AgentDefinition, type AgentRole,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { REAL_INIT_WIZARD_ENV, type InitWizardEnv } from './init.js'
import {
  ROLE_WORD, SKELETON_DO_PLACEHOLDER, SKELETON_PLACEHOLDERS, SOURCE_WORD, checkDefinition, loadLibrary, registerAgent, scopeOf,
} from './agent-library.js'

export interface AgentNewOpts {
  readonly role?: string
  readonly description?: string
  readonly skills?: string
  readonly tools?: string
  readonly model?: string
  readonly hosts?: string
  readonly scope?: string
  readonly from?: string
}

const DEFAULT_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = {
  executor: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  reviewer: ['Read', 'Grep', 'Glob', 'Bash'],
}

const RESULT_EXAMPLE: Readonly<Record<AgentRole, string>> = {
  executor: '{"result":"done","findings":[]}',
  reviewer: '{"findings":[{"severity":"high","location":"src/a.ts:42","message":"一句话说明问题"}]}',
}

/** 逗号列表；没给（或交互时留空）= undefined，由默认值补。 */
const list = (raw: string | undefined): string[] | undefined =>
  raw === undefined || raw.trim() === '' ? undefined : raw.split(',').map((item) => item.trim()).filter((item) => item !== '')

/** 默认工具：按身份给；声明了技能就补上 Skill（技能要靠它加载）。 */
function defaultTools(role: AgentRole, skills: readonly string[]): readonly string[] {
  return skills.length > 0 ? [...DEFAULT_TOOLS[role], 'Skill'] : DEFAULT_TOOLS[role]
}

/** 固定结构的正文骨架；`tenon agent prompt` 会在前面加上交接头、在后面加上 tenon-result 说明。 */
export function agentBodySkeleton(name: string, role: AgentRole, description: string): string {
  const readOnly = role === 'reviewer' ? '只读：不改代码、不提交、不改 Tenon 状态。' : '只改本次派发给你的范围；不提交、不改 Tenon 状态。'
  return [
    `# ${name}（${ROLE_WORD[role]}）`,
    '',
    '## 职责',
    '',
    description,
    '',
    '## 只做与不做',
    '',
    `- 做：${SKELETON_DO_PLACEHOLDER[role]}`,
    `- 不做：${readOnly}`,
    '',
    '## 方法',
    '',
    `1. ${SKELETON_PLACEHOLDERS[0]}`,
    `2. ${SKELETON_PLACEHOLDERS[1]}`,
    '',
    '## 自检',
    '',
    `- ${SKELETON_PLACEHOLDERS[2]}`,
    '',
    '## 报告',
    '',
    '把结果写进派发提示给的报告路径；报告**最后一个**代码块必须是 ```tenon-result```：',
    '',
    '```tenon-result',
    RESULT_EXAMPLE[role],
    '```',
    '',
  ].join('\n')
}

/** 按 kernel 闭集 frontmatter 的形态写回（一行一个键，列表为单行 [a, b]）。 */
export function renderAgentFile(definition: Omit<AgentDefinition, 'roleInferred'>): string {
  return [
    '---',
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `role: ${definition.role}`,
    ...(definition.version === undefined ? [] : [`version: ${definition.version}`]),
    `skills: [${definition.skills.join(', ')}]`,
    `tools: [${definition.tools.join(', ')}]`,
    ...(definition.model === undefined ? [] : [`model: ${definition.model}`]),
    ...(definition.hosts === undefined ? [] : [`hosts: [${definition.hosts.join(', ')}]`]),
    '---',
    '',
    definition.body.replace(/^\n+/u, ''),
  ].join('\n')
}

interface Answers {
  name: string
  role: string
  description: string
  skills: string
  tools: string
  model: string
}

/** 交互补全：只问缺的必填项；可选项给默认值，回车即收。 */
async function ask(env: InitWizardEnv, answers: Answers, base: AgentDefinition | undefined): Promise<Answers> {
  const prompter = env.makePrompter()
  const need = async (label: string, current: string, valid: (value: string) => boolean): Promise<string> => {
    let value = current
    while (!valid(value)) value = (await prompter.ask(`${label}: `)).trim()
    return value
  }
  const optional = async (label: string, current: string): Promise<string> =>
    (await prompter.ask(current === '' ? `${label}: ` : `${label} [${current}]: `)).trim() || current
  try {
    const name = await need('名称（小写字母、数字与 -）', answers.name, (value) => AGENT_NAME_RE.test(value))
    const role = await need('身份（executor | reviewer）', answers.role, (value) => (AGENT_ROLES as readonly string[]).includes(value))
    const description = await need('一句话说明', answers.description, (value) => value !== '')
    const skills = await optional('技能（逗号分隔）', answers.skills)
    const tools = await optional('工具（逗号分隔）', answers.tools !== '' ? answers.tools
      : (base?.tools ?? defaultTools(role as AgentRole, list(skills) ?? [])).join(','))
    const model = await optional('模型', answers.model)
    return { name, role, description, skills, tools, model }
  } finally {
    prompter.close()
  }
}

export async function cmdAgentNew(
  deps: CliDeps, nameArg: string | undefined, opts: AgentNewOpts, env: InitWizardEnv = REAL_INIT_WIZARD_ENV,
): Promise<number> {
  const scope = scopeOf(deps, opts.scope)
  if (typeof scope === 'string') {
    deps.io.err(`ERROR: ${scope}`)
    return 1
  }
  const library = await loadLibrary(deps)
  if (library === undefined) return 1
  let base: AgentDefinition | undefined
  if (opts.from !== undefined) {
    base = effectiveAgent(library, opts.from)?.definition
    if (base === undefined) {
      deps.io.err(`ERROR: --from：agent 库中不存在可用的 '${opts.from}'`)
      return 1
    }
  }
  let answers: Answers = {
    name: nameArg ?? '',
    role: opts.role ?? base?.role ?? '',
    description: opts.description ?? base?.description ?? '',
    skills: opts.skills ?? base?.skills.join(',') ?? '',
    tools: opts.tools ?? '',
    model: opts.model ?? base?.model ?? '',
  }
  const missing = [
    AGENT_NAME_RE.test(answers.name) ? null : '<name>',
    (AGENT_ROLES as readonly string[]).includes(answers.role) ? null : '--role executor|reviewer',
    answers.description === '' ? '--description' : null,
  ].filter((item): item is string => item !== null)
  if (missing.length > 0) {
    if (!env.isInteractive()) {
      deps.io.err(`ERROR: 非交互模式缺少或非法：${missing.join(' ')}`)
      return 1
    }
    answers = await ask(env, answers, base)
  }
  const role = answers.role as AgentRole
  const skills = list(answers.skills) ?? []
  const hosts = list(opts.hosts)
  for (const host of hosts ?? []) {
    if (!KNOWN_AGENT_HOSTS.includes(host)) {
      deps.io.err(`ERROR: --hosts 的 '${host}' 不是已知宿主（${KNOWN_AGENT_HOSTS.join(' | ')}）`)
      return 1
    }
  }
  const definition: Omit<AgentDefinition, 'roleInferred'> = {
    name: answers.name,
    description: answers.description,
    role,
    version: base?.version ?? '0.1.0',
    skills,
    tools: list(answers.tools) ?? base?.tools ?? defaultTools(role, skills),
    ...(answers.model === '' ? {} : { model: answers.model }),
    ...(hosts === undefined ? (base?.hosts === undefined ? {} : { hosts: base.hosts }) : { hosts }),
    body: base?.body ?? agentBodySkeleton(answers.name, role, answers.description),
  }
  const content = renderAgentFile(definition)
  // 刚写出的骨架带占位符是预期的（登记后提示补全、validate 催补全）；用 --from 沿用的正文照常检查。
  const checks = checkDefinition({ ...definition }, deps.knownSkillIds?.(), { allowSkeleton: base === undefined })
  const failed = checks.filter((check) => check.level === 'fail')
  if (failed.length > 0) {
    for (const check of failed) deps.io.err(`ERROR: ${check.message}`)
    return 1
  }
  const entry = await registerAgent(deps, scope, definition.name, content, false)
  if (typeof entry === 'number') return entry
  deps.io.out(`[AGENT] 已创建 ${entry.name}（${SOURCE_WORD[entry.source]} · ${ROLE_WORD[role]}）${entry.path ?? ''}`)
  if (base === undefined) deps.io.out('正文是骨架：补全后运行 tenon agent validate ' + entry.name)
  return 0
}
