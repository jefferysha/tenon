/**
 * `tenon setup|update` 成功后的子代理安装步骤：经稳定启动器（与 `tenon-hook` 同目录的 `~/.local/bin/tenon`）子进程执行
 * `tenon agent install --host <host>`。
 *
 * 用子进程而不是进程内调用：到这一步新版本的 managed runtime 已激活，启动器指向新版本，由它渲染官方 agent 定义；
 * 当前进程跑的还是旧版本代码。参数固定（宿主取自闭集，不含任何用户输入），经 `execFile` 类调用，不走 shell。
 *
 * 只对原生宿主（claude / codex）有意义；adapter 宿主没有宿主原生子代理目录。
 * 失败只 WARN，绝不改变 setup / update 的退出码：安装是幂等的，用户随时可以手动重试。
 */
import { errMsg, type CliDeps } from '../deps.js'
import { stableLauncherPaths } from '../runtime/launchers.js'
import { isNativePipelineHost, type PipelineHost } from './plugin-host.js'
import type { SetupEnv } from './setupEnvironment.js'

const INSTALL_TIMEOUT_MS = 60_000

export function installHostAgentsAfterSuccess(
  deps: CliDeps,
  env: Pick<SetupEnv, 'homeDir' | 'runCommand'>,
  host: PipelineHost,
  opts: { readonly quiet?: boolean } = {},
): void {
  if (!isNativePipelineHost(host)) return
  const retry = `tenon agent install --host ${host}`
  const launcher = stableLauncherPaths(env.homeDir()).tenon
  try {
    const result = env.runCommand(launcher, ['agent', 'install', '--host', host], { timeoutMs: INSTALL_TIMEOUT_MS })
    // --auto（会话启动时的后台更新）只在失败时出声；交互式 setup / update 把安装结果原样转给用户。
    if (opts.quiet !== true && result.stdout.trim() !== '') deps.io.out(result.stdout.trimEnd())
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `退出码 ${result.code}`
      deps.io.err(`WARN: 宿主子代理安装失败（${detail}）；${host} 的 setup/update 本身已成功，可稍后手动执行 ${retry}`)
    }
  } catch (error) {
    deps.io.err(`WARN: 宿主子代理安装失败（${errMsg(error)}）；${host} 的 setup/update 本身已成功，可稍后手动执行 ${retry}`)
  }
}
