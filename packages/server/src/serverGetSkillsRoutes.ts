import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readUpstreamSkillView } from '@tenon/automation'
import { listAllSkillsDetailed, listSkillFiles, readSkillFile } from './skillsRegistry.js'

export interface SkillsGetRouteDeps {
  readonly hostHome: string
  /** Plugin payload root whose `skills/` and `templates/` the routes read. */
  readonly repoRoot: string
  readonly stateRoot: string
  readonly sendJson: (res: ServerResponse, code: number, body: unknown) => void
  readonly errMsg: (error: unknown) => string
}

/** Read-only skill routes: directory listing, single file, registry and upstream sources view. */
export function resolveSkillsGet(req: IncomingMessage, res: ServerResponse, path: string, deps: SkillsGetRouteDeps): boolean {
  const { hostHome, repoRoot, stateRoot, sendJson, errMsg } = deps
  const claudeDir = join(hostHome, '.claude')
  const mSkillFiles = /^\/api\/skills\/([^/]+)\/(files|file)$/.exec(path)
  if (mSkillFiles) {
    const raw = decodeURIComponent(mSkillFiles[1] ?? '')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw)) {
      sendJson(res, 400, { ok: false, error: '非法技能名' })
      return true
    }
    try {
      if (mSkillFiles[2] === 'files') {
        const files = listSkillFiles(raw, repoRoot, claudeDir)
        if (files === undefined) sendJson(res, 404, { ok: false, error: `技能 '${raw}' 不存在` })
        else sendJson(res, 200, files)
        return true
      }
      const relPath = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path') ?? ''
      const file = readSkillFile(raw, relPath, repoRoot, claudeDir)
      if (file.kind === 'ok') sendJson(res, 200, { path: file.path, text: file.text })
      else if (file.kind === 'invalid-path') sendJson(res, 400, { ok: false, error: '非法文件路径' })
      else if (file.kind === 'too-large') sendJson(res, 413, { ok: false, error: '文件超过 256KB' })
      else if (file.kind === 'binary') sendJson(res, 415, { ok: false, error: '不是文本文件' })
      else sendJson(res, 404, { ok: false, error: `技能 '${raw}' 没有文件 '${relPath}'` })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: errMsg(e) })
    }
    return true
  }
  if (path !== '/api/skills/registry' && path !== '/api/skills/sources') return false
  try {
    if (path === '/api/skills/registry') sendJson(res, 200, { skills: listAllSkillsDetailed(repoRoot, claudeDir) })
    else sendJson(res, 200, readUpstreamSkillView(repoRoot, stateRoot))
  } catch (e) {
    sendJson(res, 500, { ok: false, error: errMsg(e) })
  }
  return true
}
