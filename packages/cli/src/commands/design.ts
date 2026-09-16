/**
 * `tenon design check | validate | propose` —— 项目设计体系的命令面。
 *
 * check 只做结构判断（快，前端任务立项的门）；validate 在结构就绪后再跑上游 hue 的 validate.mjs，
 * 并检查设计变更提案是否已合并（联合摘要仍等于 base ＝ 没合并）。propose 写提案骨架。
 * 退出码：0 通过；1 一切未通过与错误。
 */
import {
  checkDesignSystem, createDesignFileReader, designBaseDigest, designProposalBase, designProposalPath,
  renderDesignProposal, type DesignSystemCheck,
} from '@tenon/kernel'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errMsg, type CliDeps } from '../deps.js'

const DESIGN_MD = 'DESIGN.md'
const MODEL = 'design/design-model.yaml'

async function iconIds(deps: CliDeps): Promise<ReadonlySet<string>> {
  if (!deps.resourceCatalog) throw new Error('资源目录未装配')
  const catalog = await deps.resourceCatalog()
  return new Set(catalog.resources.filter((item) => item.entry.category === 'icons').map((item) => item.entry.id))
}

async function runCheck(deps: CliDeps): Promise<DesignSystemCheck> {
  return checkDesignSystem(createDesignFileReader(deps.cwd), await iconIds(deps))
}

const STATUS_WORD = { missing: '缺失', seed: '起步', incomplete: '不完整', ready: '就绪' } as const

export async function cmdDesignCheck(deps: CliDeps, opts: { json?: boolean }): Promise<0 | 1> {
  let check: DesignSystemCheck
  try {
    check = await runCheck(deps)
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
  if (opts.json) {
    deps.io.out(JSON.stringify({ status: check.status, problems: check.problems }, null, 2))
    return check.status === 'ready' ? 0 : 1
  }
  deps.io.out(`DESIGN.md：${STATUS_WORD[check.status]}`)
  for (const problem of check.problems) deps.io.out(`- ${problem}`)
  return check.status === 'ready' ? 0 : 1
}

const read = async (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null)

/** 提案存在且联合摘要仍等于 base → 设计变更没合并。 */
async function unmergedProposal(deps: CliDeps, change: string): Promise<boolean> {
  const proposal = await read(join(deps.cwd, designProposalPath(change)))
  if (proposal === null) return false
  const base = designProposalBase(proposal)
  if (base === null) return false
  const current = designBaseDigest(await read(join(deps.cwd, DESIGN_MD)), await read(join(deps.cwd, MODEL)))
  return current === base
}

export async function cmdDesignValidate(deps: CliDeps, opts: { change?: string }): Promise<0 | 1> {
  try {
    const check = await runCheck(deps)
    if (check.status !== 'ready') {
      deps.io.err(`ERROR: DESIGN.md ${STATUS_WORD[check.status]}`)
      for (const problem of check.problems) deps.io.err(`- ${problem}`)
      return 1
    }
    if (!deps.designValidator) {
      deps.io.err('ERROR: hue 校验器未装配')
      return 1
    }
    const script = deps.designValidator.path()
    if (script === '') {
      deps.io.err('ERROR: hue 技能未安装；运行 tenon update 同步上游技能')
      return 1
    }
    const code = await deps.designValidator.run(script, join(deps.cwd, 'design'), deps.cwd)
    if (code !== 0) {
      deps.io.err(`ERROR: hue 校验未通过（${code}）`)
      return 1
    }
    const change = opts.change ?? deps.env?.('TENON_CHANGE_NAME') ?? ''
    if (change !== '' && await unmergedProposal(deps, change)) {
      deps.io.err(`ERROR: 设计变更未合并：按 ${designProposalPath(change)} 更新 ${MODEL} 与 ${DESIGN_MD}`)
      return 1
    }
    deps.io.out('DESIGN.md：就绪')
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}

export async function cmdDesignPropose(deps: CliDeps, change: string): Promise<0 | 1> {
  try {
    const relative = designProposalPath(change)
    const path = join(deps.cwd, relative)
    if (await read(path) !== null) {
      deps.io.err(`ERROR: 提案已存在：${relative}`)
      return 1
    }
    const check = await runCheck(deps)
    if (check.status === 'missing') {
      deps.io.err('ERROR: 项目还没有 DESIGN.md；先完成设计体系任务')
      return 1
    }
    const base = designBaseDigest(await read(join(deps.cwd, DESIGN_MD)), await read(join(deps.cwd, MODEL)))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, renderDesignProposal(change, base), { encoding: 'utf8', flag: 'wx' })
    deps.io.out(relative)
    return 0
  } catch (error) {
    deps.io.err(`ERROR: ${errMsg(error)}`)
    return 1
  }
}
