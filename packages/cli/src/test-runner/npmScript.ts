/**
 * 「测试未配置」的判定：声明的命令是一条 npm 脚本调用，而项目里没有这个脚本。
 *
 * 真机（第二轮）：backend 轨 verify 固定执行 `npm run test:integration`，项目没有这个脚本；
 * `tenon test run` 把 npm 的「Missing script」记成一次失败，模型只能在 package.json 里加一条与
 * `npm test` 相同的脚本凑数。缺脚本不是测试失败，是项目还没有配置这类测试：命令拒跑、不落记录，
 * 并说明两种配置方式。
 *
 * 只认得出的形态才判：`npm test` / `npm t` / `npm run <script>` / `npm run-script <script>`（可带
 * 后续参数）。别的命令（`npx playwright test`、非 npm 工具、带 shell 运算符的组合）一律不判，照常
 * 执行——判不出来就不替它下结论。package.json 读不出或不是合法 JSON 时同样不判。
 */
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'

export interface UnconfiguredNpmScript {
  /** 命令要的 npm 脚本名。 */
  readonly script: string
  /** 项目根相对的 package.json 路径。 */
  readonly packageJson: string
  /** package.json 不存在（而不是存在但缺这个脚本）。 */
  readonly missingPackageJson: boolean
}

/** 命令 → 它要的 npm 脚本名；不是可识别的 npm 脚本调用 → undefined。 */
export function npmScriptOf(command: string): string | undefined {
  const text = command.trim()
  if (/[;&|<>`$()]/u.test(text)) return undefined
  const tokens = text.split(/\s+/u)
  if (tokens[0] !== 'npm') return undefined
  const verb = tokens[1]
  if (verb === 'test' || verb === 't' || verb === 'tst') return 'test'
  if (verb === 'run' || verb === 'run-script') {
    const script = tokens[2]
    return script === undefined || script.startsWith('-') ? undefined : script
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function unconfiguredNpmScript(
  repoRoot: string,
  test: { readonly command: string; readonly cwd: string },
): Promise<UnconfiguredNpmScript | undefined> {
  const script = npmScriptOf(test.command)
  if (script === undefined) return undefined
  const packageJson = normalize(join(test.cwd, 'package.json'))
  let raw: string
  try {
    raw = await readFile(join(repoRoot, packageJson), 'utf8')
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined
    return code === 'ENOENT' ? { script, packageJson, missingPackageJson: true } : undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const scripts = parsed.scripts
  if (isRecord(scripts) && typeof scripts[script] === 'string') return undefined
  return { script, packageJson, missingPackageJson: false }
}

/** 未配置的说明：原因一句，配置方式两条。`tenon test run` 的拒绝与 `step.next` 的 fix 共用这一份。 */
export function unconfiguredMessage(
  testId: string,
  command: string,
  gap: UnconfiguredNpmScript,
): string {
  const reason = gap.missingPackageJson
    ? `${gap.packageJson} 不存在`
    : `${gap.packageJson} 的 scripts 里没有 '${gap.script}'`
  return `测试 '${testId}' 未配置（test-unconfigured，不是失败）：命令 \`${command}\` 要的 npm 脚本 '${gap.script}'，`
    + `但 ${reason}。配置方式：① 在 ${gap.packageJson} 的 scripts 里加 '${gap.script}'，让它运行本项目真正的这类测试`
    + `（还没有就先写测试；不要复制其它测试的命令凑数）；② 本项目不用 npm 或测试另有入口：在 Dashboard 工作流页`
    + `（存为全局配置目录下的 workflows/default.yaml 覆盖）改这条测试的 command——只对之后新建的任务生效，`
    + `已开始的任务按冻结计划执行。`
}
