/**
 * 工作流字段是稳定的机器契约，界面只展示用户能理解的名称。
 * 保存、校验、复制和测试定位仍始终使用原字段 ID。
 */
const OUTPUTS: Record<string, { label: string; description: string }> = {
  draft_doc: { label: '阶段草稿', description: '记录本阶段形成的可继续完善的文档草稿。' },
  design_doc: { label: '调研文档', description: '记录调研结论、约束与设计依据。' },
  plan_md: { label: '阶段计划', description: '记录本阶段确认的执行步骤与安排。' },
  plan: { label: '实施计划', description: '记录可执行的步骤、依赖与验收方式。' },
  spec_md: { label: '需求规格', description: '记录已确认的需求范围、约束与验收标准。' },
  architecture_decision_record_md: {
    label: '技术决策记录',
    description: '记录关键技术方案、取舍原因与影响。',
  },
  branch: { label: '代码分支', description: '标识本轮实现所在的代码分支。' },
  build_sha: { label: '构建基线', description: '标识本轮实现的可复验基线：Git 隔离环境为提交 SHA，in-place 为工作区内容指纹。' },
  sha: { label: '代码版本', description: '标识本轮交付对应的代码版本。' },
  release_notes: { label: '发布说明', description: '说明本轮交付内容、影响与使用方式。' },
  evidence: { label: '验证证据', description: '保存可用于复核结论的证据。' },
  verify_result: { label: '验证结果', description: '记录检查是否通过及失败原因。' },
  pre_verify_review_result: { label: '预验证复核', description: '记录验证前的预检查复核结论。' },
  agent_review_result: { label: '执行复核', description: '记录执行代理的独立复核结论。' },
  codex_review_result: { label: 'Codex 复核', description: '记录 Codex 的独立复核结论。' },
  verification_report: { label: '验证报告', description: '记录测试、检查与最终验证结论。' },
  pr_url: { label: '合并请求', description: '提供本轮交付对应的合并请求地址。' },
  release_url: { label: '发布地址', description: '提供本轮交付结果的访问位置。' },
}

const OUTPUTS_EN: Record<string, { label: string; description: string }> = {
  draft_doc: { label: 'Stage draft', description: 'A document draft produced by this stage for later refinement.' },
  design_doc: { label: 'Research document', description: 'Research findings, constraints, and design evidence.' },
  plan_md: { label: 'Stage plan', description: 'Confirmed execution steps and arrangements for this stage.' },
  plan: { label: 'Implementation plan', description: 'Executable steps, dependencies, and acceptance checks.' },
  spec_md: { label: 'Requirements spec', description: 'Confirmed scope, constraints, and acceptance criteria.' },
  architecture_decision_record_md: { label: 'Architecture decision record', description: 'Key technical decisions, tradeoffs, and impact.' },
  branch: { label: 'Code branch', description: 'The source-control branch for this implementation.' },
  build_sha: { label: 'Build baseline', description: 'The reproducible implementation baseline: a commit SHA in Git isolation or a workspace fingerprint in place.' },
  sha: { label: 'Code version', description: 'The code version associated with this delivery.' },
  release_notes: { label: 'Release notes', description: 'Delivery contents, impact, and usage guidance.' },
  evidence: { label: 'Verification evidence', description: 'Evidence retained for independent review.' },
  verify_result: { label: 'Verification result', description: 'Whether checks passed and why they failed when they did not.' },
  pre_verify_review_result: { label: 'Pre-verification review', description: 'The review recorded before verification begins.' },
  agent_review_result: { label: 'Agent review', description: 'The execution agent’s independent review result.' },
  codex_review_result: { label: 'Codex review', description: 'Codex’s independent review result.' },
  verification_report: { label: 'Verification report', description: 'Tests, checks, and the final verification conclusion.' },
  pr_url: { label: 'Pull request', description: 'The pull request associated with this delivery.' },
  release_url: { label: 'Release URL', description: 'Where the delivered result can be accessed.' },
}

export const OUTPUT_PRESETS = Object.entries(OUTPUTS).map(([field, value]) => ({ field, ...value }))

export function outputPresentation(field: string, lang: 'zh' | 'en' = 'zh'): { label: string; title: string } {
  const known = (lang === 'en' ? OUTPUTS_EN : OUTPUTS)[field]
  if (!known) return lang === 'en'
    ? { label: 'Custom output', title: 'A custom result for later stages.' }
    : { label: '自定义产出', title: '供后续阶段使用的自定义结果。' }
  return { label: known.label, title: known.description }
}

export function outputValuePresentation(value: string, lang: 'zh' | 'en' = 'zh'): string {
  if (value === 'pass') return lang === 'en' ? 'Pass' : '通过'
  if (value === 'fail') return lang === 'en' ? 'Fail' : '未通过'
  if (value === 'pending') return lang === 'en' ? 'Pending' : '待验证'
  return value
}
