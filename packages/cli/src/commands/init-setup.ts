/**
 * `tenon init` 建好任务 worktree 之后的工作区准备：目录受信任时执行它声明的 `setup`。
 *
 * 信任按命令记在用户级状态目录（按用户 + 仓库 + 单条命令的摘要，见 test-trust.ts），同一仓库的所有 worktree 共享，
 * 所以新 worktree 不需要「继承」什么：用户在主检出里（或别的 worktree 里）信任过这条 `setup`，新 worktree 里
 * 目录声明的 `setup` 摘要一致就算受信任；新 worktree 里是已提交的目录，主检出里未提交的改动不在其中，`setup` 改了就是
 * 一条新命令，需要重新确认。
 *
 * 准备失败不让已建好的任务失败：本模块不抛错，`tenon init` 的退出码不受影响。
 * 子进程的输出逐行转到 stderr（`--json` 时 stdout 只能有那一行 JSON），不直接继承 stdout。
 */
import { spawn } from 'node:child_process'
import { isTenonUser, readCatalogFile, userSlug, type TaskWorktreePlan } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { TRUST_ENV, catalogSetupTrustTarget, trustScope, untrustedEntries } from './test-trust.js'

type CreatePlan = Extract<TaskWorktreePlan, { kind: 'create' }>

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
 * 新 worktree 的工作区准备：按新 worktree 里的测试目录决定是否执行 `setup`。
 * 目录不存在 → 静默；目录无效、没有 setup、未受信任 → 提示并跳过；setup 失败 → WARN 并给出手动重跑的命令。
 */
export async function prepareInitWorktree(deps: CliDeps, plan: CreatePlan): Promise<void> {
  try {
    const user = deps.user()
    if (!isTenonUser(user)) return
    const slug = userSlug(user.id)
    const file = await readCatalogFile(plan.path)
    if (file.state === 'missing') return
    if (file.state === 'invalid') {
      deps.io.err(`WARN: [SETUP] 新 worktree 里的测试目录无效，没有执行 setup：${file.issues.slice(0, 3).join('；')}`)
      return
    }
    const setup = file.catalog.setup
    const target = catalogSetupTrustTarget(file.catalog)
    if (setup === undefined || target === undefined) {
      deps.io.err('[SETUP] 测试目录没有声明 setup，跳过工作区准备')
      return
    }
    const at = shellPath(plan.path)
    // 环境显式信任（CI）与 `tenon test run` 同一口径；否则 setup 这一条命令要在用户级信任存储里（按仓库，与 worktree 无关）。
    if (deps.env?.(TRUST_ENV) !== '1' && (await untrustedEntries(deps, slug, target, await trustScope(deps))).length > 0) {
      deps.io.err(`[SETUP] 测试目录里的 setup 未受信任，没有执行：$ ${setup}`)
      deps.io.err('  它不在你的信任记录里（第一次信任，或新 worktree 里已提交的目录与主检出里未提交的改动不同）')
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
