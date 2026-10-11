import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliDeps } from '../deps.js'
import { msg } from '../i18n/messages.js'

/**
 * 项目里还留着旧的 `.pipeline/tracks.yaml`：它已不再被读取（轨道只写在工作流分支里），
 * 检测到时输出一行迁移提示。只看文件是否存在，不读内容。
 */
export function warnIgnoredTracksFile(deps: Pick<CliDeps, 'cwd' | 'io' | 'locale'>): void {
  if (existsSync(join(deps.cwd, '.pipeline', 'tracks.yaml'))) deps.io.err(`WARN: ${msg(deps, 'tracks.fileIgnored')}`)
}
