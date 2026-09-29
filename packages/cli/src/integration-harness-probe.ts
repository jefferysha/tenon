/**
 * integration harness 的 `tenon test code-size` 通过桩。
 *
 * default 工作流的验证步骤声明了必需测试 `tenon test code-size --json`。真实用户环境里 `tenon` 在
 * PATH 上；harness 在进程内跑 CLI，PATH 上没有（或是安装引导脚本），命令会失败。夹具项目对 npm 脚本
 * 也是同样处理（`exit 0`）：项目自己兑现声明的命令，这里兑现的是「规模在限额内」。真探针由
 * `commands/test-code-size.test.ts` 用真 git 仓库覆盖。
 *
 * 桩放在系统临时目录（不在夹具项目里），否则会改变工作区候选指纹，让 build_sha 屏障失效。
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const STUB = `#!/bin/sh
if [ "$1" = "test" ] && [ "$2" = "code-size" ]; then
  echo '{"files_changed":0,"lines_added":0,"lines_deleted":0,"largest_added_lines":0}'
  exit 0
fi
echo "tenon harness stub: unsupported command: $*" >&2
exit 127
`

let stubDir: string | undefined

/** 把桩目录放到本进程 PATH 最前（幂等）；进程退出时删除。 */
export function ensureCodeSizeProbeOnPath(): void {
  if (stubDir === undefined || !existsSync(stubDir)) {
    stubDir = mkdtempSync(join(tmpdir(), 'tenon-harness-bin-'))
    const dir = stubDir
    const file = join(dir, 'tenon')
    writeFileSync(file, STUB, 'utf8')
    chmodSync(file, 0o755)
    process.once('exit', () => { rmSync(dir, { recursive: true, force: true }) })
  }
  const entries = (process.env.PATH ?? '').split(delimiter)
  if (entries[0] !== stubDir) process.env.PATH = [stubDir, ...entries.filter((entry) => entry !== stubDir)].join(delimiter)
}
