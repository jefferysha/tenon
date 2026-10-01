/**
 * `tenon verify --ci` 报告的装配：汇总、固定的信任边界陈述、退出码。
 * 「CI 验证不了什么」是报告的固定组成部分，不是可选脚注：每份 text / markdown / json / SARIF 都带着它。
 */
import {
  CI_REPORT_SCHEMA, allFindings, summarizeFindings,
  type CiChangeReport, type CiFinding, type CiSelector, type CiTrust, type CiVerifyOptions, type CiVerifyReport,
} from './types.js'

export const CI_EXIT_PASS = 0
export const CI_EXIT_FAIL = 2

/** 没有用户本机 HMAC 密钥（本机目录里被 gitignore 的 env.key 与封存文件）就无法在 CI 里证明的事。 */
export const CI_UNVERIFIABLE: readonly string[] = [
  '记录由受信任的 `tenon test run` 写出：封存链头只在开发者本机，CI 没有 HMAC 密钥；一条重算过全部摘要、与计划和代码自洽的伪造链，CI 看不出来（有锚点时除外）',
  '评审批准由人给出：批准存在本机封存里，任务历史里的批准行是明文，可以手写',
  '套件真的执行过、报告没有被伪造：报告与产物留在本机，CI 只有记录里的摘要；要在 CI 里证明，另起作业用 TENON_TEST_TRUST=1 tenon test run 重跑套件',
  '用户身份属实：身份是声明的，不是认证的',
]

export function ciTrust(options: CiVerifyOptions, anchored: boolean): CiTrust {
  return {
    verified: [
      '记录链完整性：链首、分叉、成环、游离记录、文件名、内容摘要（每个用户目录各校一次）',
      '记录自洽：所在任务与用户目录、执行人、结论、用例统计互相一致',
      '计划 ↔ 记录 ↔ 目录：计划摘要台账、目录可解析、记录绑定的目录 / 计划 / 策略 / 工作流摘要仍然新鲜；计划登记的测试文件仍在',
      '当前步骤策略下的用例级判定：套件已运行且通过、已登记用例出现在报告里、覆盖率 / 基准 / flaky / 场景追溯',
      options.candidate === 'off'
        ? '候选代码：未比对（--candidate off）'
        : `候选代码：记录绑定的工作区指纹等于本次检出的树${options.candidate === 'warn' ? '（不一致只给警告）' : ''}`,
      '受保护测试配置（目录、基线、已知失败、工作流）的改动在任务历史里有评审批准行，行里的摘要等于当前内容',
      '测试完整性信号（测试文件被删、用例或断言变少、新增跳过等）：读 diff 文本的启发式，只说明值得看一眼，不是证明；策略 `integrity: block` 才让它失败，缺省只提示',
      anchored ? '锚点：refs/notes/tenon 上锚定的链头在已提交的记录链里' : '锚点：没有找到锚点 note，未核对',
    ],
    unverifiable: CI_UNVERIFIABLE,
  }
}

export function buildCiReport(input: {
  readonly tenon: string
  readonly generatedAt: string
  readonly head: string | null
  readonly selector: CiSelector
  readonly options: CiVerifyOptions
  readonly changes: readonly CiChangeReport[]
  readonly findings: readonly CiFinding[]
}): CiVerifyReport {
  const partial = { changes: input.changes, findings: input.findings }
  return {
    schema: CI_REPORT_SCHEMA,
    tenon: input.tenon,
    generated_at: input.generatedAt,
    head: input.head,
    selector: input.selector,
    options: input.options,
    changes: input.changes,
    findings: input.findings,
    summary: summarizeFindings(allFindings(partial), input.changes.length),
    trust: ciTrust(input.options, input.changes.some((change) => change.anchor !== 'none')),
  }
}

export function ciExitCode(report: Pick<CiVerifyReport, 'summary'>): number {
  return report.summary.pass ? CI_EXIT_PASS : CI_EXIT_FAIL
}
