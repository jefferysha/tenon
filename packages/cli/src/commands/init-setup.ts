/**
 * `tenon init` 建好任务 worktree 之后的工作区准备：把本用户在主检出里的信任带过来，目录受信任时执行它声明的 `setup`。
 *
 * 信任按命令摘要生效（封存的 trusted 条目只记摘要）：新 worktree 里的目录摘要与主检出里信任过的一致才算受信任——
 * 目录已提交时两边一致；主检出有未提交的目录改动时，worktree 里是 HEAD 版本、摘要不同，按未受信任处理并提示；
 * 之后在 worktree 里改了任何命令也要重新信任。只复制 trusted：评审批准（approvals）绑任务名与路径，共享文件写入记录（writes）
 * 与记录链头（heads）绑主检出里的文件状态，都不属于新 worktree。
 *
 * 准备失败不让已建好的任务失败：本模块不抛错，`tenon init` 的退出码不受影响。
 * 子进程的输出逐行转到 stderr（`--json` 时 stdout 只能有那一行 JSON），不直接继承 stdout。
 */
import { spawn } from 'node:child_process'
import {
  catalogExecDigest, isTenonUser, isTrusted, readCatalogFile, readTestSeal, updateTestSeal, userSlug,
  type TaskWorktreePlan,
} from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

type CreatePlan = Extract<TaskWorktreePlan, { kind: 'create' }>

/**
 * 把 `from`（主检出）里 `slug` 用户的信任条目写进 `to`（新 worktree）的本机封存，返回新增的条目数。
 * 只复制 trusted，目标已有同一摘要的不重复写；主检出封存不存在、被改过（读成空封存）或没有信任条目时什么都不写。
 */
export async function inheritTrust(input: { readonly from: string; readonly to: string; readonly slug: string }): Promise<number> {
  const { seal: source } = await readTestSeal(input.from, input.slug)
  if (source.trusted.length === 0) return 0
  let copied = 0
  await updateTestSeal(input.to, input.slug, (seal) => {
    const known = new Set(seal.trusted.map((entry) => entry.digest))
    const added = source.trusted.filter((entry) => {
      if (known.has(entry.digest)) return false
      known.add(entry.digest)
      return true
    })
    copied = added.length
    return added.length === 0 ? seal : { ...seal, trusted: [...seal.trusted, ...added] }
  })
  return copied
}

/** 逐行转发：按换行切开，不足一行的尾巴留到下一块（或流结束时冲出）。 */
function lineForwarder(log: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let rest = ''
  return {
    push(chunk) {
      const lines = (rest + chunk).split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) log(line)
    },
    flush() {
      if (rest !== '') log(rest)
      rest = ''
    },
  }
}

/** 真执行器：经 shell 在 cwd 里跑；stdin 不接，stdout / stderr 都逐行交给 `log`。起不来按退出码 127 返回。 */
export function spawnSetup(input: { readonly command: string; readonly cwd: string; readonly log: (line: string) => void }): Promise<number> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }
    const child = spawn(input.command, { shell: true, cwd: input.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const forwarders = [lineForwarder(input.log), lineForwarder(input.log)]
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => forwarders[index]?.push(chunk))
    }
    child.on('error', (error) => {
      input.log(error.message)
      settle(127)
    })
    child.on('close', (code) => {
      for (const forwarder of forwarders) forwarder.flush()
      settle(code ?? 1)
    })
  })
}

/** 出现在「手动重跑」提示里的路径：常见路径原样给，含空格等特殊字符时加单引号，复制粘贴就能用。 */
function shellPath(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`
}

/**
 * 新 worktree 的工作区准备：继承信任，然后按新 worktree 里的测试目录决定是否执行 `setup`。
 * 目录不存在 → 静默；目录无效、没有 setup、未受信任 → 提示并跳过；setup 失败 → WARN 并给出手动重跑的命令。
 */
export async function prepareInitWorktree(deps: CliDeps, plan: CreatePlan): Promise<void> {
  try {
    const user = deps.user()
    if (!isTenonUser(user)) return
    const slug = userSlug(user.id)
    try {
      const copied = await inheritTrust({ from: deps.cwd, to: plan.path, slug })
      if (copied > 0) deps.io.err(`[SETUP] 已把你在主检出里信任过的 ${copied} 条命令摘要带进新 worktree`)
    } catch (e) {
      deps.io.err(`WARN: [SETUP] 信任继承失败（${errMsg(e)}）；新 worktree 里需要重新 tenon test trust`)
    }
    const file = await readCatalogFile(plan.path)
    if (file.state === 'missing') return
    if (file.state === 'invalid') {
      deps.io.err(`WARN: [SETUP] 新 worktree 里的测试目录无效，没有执行 setup：${file.issues.slice(0, 3).join('；')}`)
      return
    }
    const setup = file.catalog.setup
    if (setup === undefined) {
      deps.io.err('[SETUP] 测试目录没有声明 setup，跳过工作区准备')
      return
    }
    const at = shellPath(plan.path)
    const { seal } = await readTestSeal(plan.path, slug)
    if (!isTrusted(seal, catalogExecDigest(file.catalog))) {
      deps.io.err(`[SETUP] 测试目录在新 worktree 里未受信任，没有执行 setup：$ ${setup}`)
      deps.io.err('  新 worktree 里是已提交的目录，它的命令摘要不在你的信任记录里（例如主检出里还有未提交的目录改动）')
      deps.io.err(`  请你在自己的终端里运行 cd ${at} && tenon test trust 确认（agent 不能替你确认），再手动执行 cd ${at} && ${setup}`)
      return
    }
    deps.io.err(`[SETUP] 在 ${plan.path} 执行 setup：$ ${setup}`)
    let code: number
    try {
      code = await (deps.setupRunner ?? spawnSetup)({ command: setup, cwd: plan.path, log: (line) => deps.io.err(`  ${line}`) })
    } catch (e) {
      deps.io.err(`  ${errMsg(e)}`)
      code = 1
    }
    if (code === 0) deps.io.err('[SETUP] setup 完成')
    else deps.io.err(`WARN: [SETUP] setup 以退出码 ${code} 结束，任务已建好；在 worktree 里手动重跑：cd ${at} && ${setup}`)
  } catch (e) {
    deps.io.err(`WARN: [SETUP] 新 worktree 的工作区准备失败（${errMsg(e)}）；任务已建好`)
  }
}
