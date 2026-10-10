/**
 * 项目根上的门禁标记（`.pipeline-pending-{confirm,review,interaction}`）的读取。
 *
 * 交互标记按会话分文件：宿主给了会话 id 时 hook 写 `.pipeline-pending-interaction.<session_id>`（hooks/pending-marker.sh），
 * 没给时仍是单文件。对 `inbox` / `doctor` / `advance` 的硬门来说它们是同一道 interaction 门：项目里有任一新鲜的
 * 就算有——任一会话在等用户回答，advance 都不能自动越过去。hook 的原子写 / 认领临时文件（带点号后缀）不是标记。
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { interactionSessionMarkerId } from '@tenon/kernel'
import type { GateMarkerInfo } from './deps.js'

const GATE_KINDS = ['confirm', 'review', 'interaction'] as const

export async function readGateMarkers(cwd: string): Promise<GateMarkerInfo[]> {
  const out: GateMarkerInfo[] = []
  // 分文件不跟随符号链接、必须是普通文件（hook 也不读符号链接标记）；三个单文件保持原有读法。
  const collect = async (file: string, kind: GateMarkerInfo['kind'], plainFileOnly: boolean): Promise<void> => {
    try {
      const path = join(cwd, file)
      const st = await (plainFileOnly ? lstat(path) : stat(path))
      if (plainFileOnly && !st.isFile()) return
      out.push({ kind, file, ageMs: Math.max(0, Date.now() - st.mtimeMs), raw: await readFile(path, 'utf8') })
    } catch {
      // 缺失 = 无该门等待
    }
  }
  for (const kind of GATE_KINDS) await collect(`.pipeline-pending-${kind}`, kind, false)
  let names: string[]
  try {
    names = await readdir(cwd)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    if (interactionSessionMarkerId(name) !== undefined) await collect(name, 'interaction', true)
  }
  return out
}
