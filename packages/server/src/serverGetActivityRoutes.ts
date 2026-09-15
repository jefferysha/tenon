import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve as resolvePath } from 'node:path'
import { listAutomationPolicyTemplates, stateStorageExistsSync } from '@tenon/kernel'
import { buildAfkLog, buildAfkSnapshot, readAfkRunLog } from './afk.js'
import { handleContextBundlePreview } from './contextBundlePreview.js'
import { buildRunDetail } from './runDetail.js'
import { buildSnapshot } from './snapshot.js'
import { readChangeHistory } from './transition.js'
import { handleGetUserRoute } from './serverUserRoutes.js'
import type { GetRouteDeps } from './serverGetRoutes.js'

export async function handleGetActivityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: GetRouteDeps,
): Promise<void> {
  const {
    cadenceScheduler, sendJson, sendHtml, serveIndexWithToken, serveAsset, indexHtml, token,
    version, releaseId, transactionId, stateScopeId, isLocalHost, snapshotDeps, handleStream, isRegisteredRoot,
    clock, store, recordStore, loopLedger, errMsg,
  } = deps
  const boundPort = deps.boundPort()
    if (serveAsset(req, res, path)) return
    if (path === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        scope: 'global',
        version,
        ...(releaseId === undefined ? {} : { releaseId }),
        ...(transactionId === undefined ? {} : { transactionId }),
        stateScopeId,
        pid: process.pid,
      })
    }
    // ── DNS 重绑定守卫（Bug 修复）：除无敏感内容的静态 /assets 与 health 探针（以上均已 return）外，
    //    落地页和所有 /api 只读数据端点统一挡伪造 Host。落地页会注入 bearer token，cadence 会返回
    //    项目绝对路径，二者都不得像静态资源一样在守卫前提前 return。此前仅 secrets/docker/readiness 各自 inline
    //    了这道校验，其余（snapshot / afk log / change history / workflows / config / loops / traces /
    //    hooks / automation / skills）全无 → evil.com 经 DNS 重绑定到 127.0.0.1 后，受害者浏览器可同源
    //    读走全部项目路径、状态、run-log（可能含 token）、yaml。统一在此施加，语义同 handlePost 首道守卫；
    //    下方 secrets/docker/readiness 的 inline 守卫遂归并至此（不再各自重复）。
    if (!isLocalHost(req.headers.host, boundPort)) {
      return sendJson(res, 403, { ok: false, error: 'Host header 不合法（疑似 DNS 重绑定攻击）' })
    }
    if (handleGetUserRoute(req, res, path, deps)) return
    if (path === '/api/cadence/status') {
      if (cadenceScheduler === null) {
        return sendJson(res, 404, { ok: false, error: 'cadence scheduler 未启用（capabilities.cadence=false）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root')
      const status = cadenceScheduler.snapshot()
      return sendJson(res, 200, root === null ? status : {
        ...status,
        loops: status.loops.filter((row) => row.root === resolvePath(root)),
      })
    }
    if (path === '/' || path === '/index.html') {
      if (serveIndexWithToken(res)) return // SPA 产物存在 → 服务真前端
      return sendHtml(res, 200, indexHtml(token)) // 回退最小落地页
    }
    if (path === '/api/context-bundle/preview') {
      return handleContextBundlePreview(req, res, deps)
    }
    if (path === '/api/snapshot') {
      try {
        return sendJson(res, 200, await buildSnapshot(snapshotDeps()))
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    if (path === '/api/stream') return handleStream(req, res)
    // ── H11 starter gallery：直接投影 kernel 版本化模板目录，不在前端手抄七份。──
    if (path === '/api/operations/starters') {
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      return sendJson(res, 200, {
        ok: true,
        templates: listAutomationPolicyTemplates(),
        defaults: { runner: 'codex', workflow: 'default' },
      })
    }
    // ── #29d AFK 指挥面数据端：聚合 automation_* → 泳道 + 调度器 doctor 灯 + 流水 ──
    if (path === '/api/afk/snapshot') {
      try {
        return sendJson(res, 200, buildAfkSnapshot(await buildSnapshot(snapshotDeps()), clock))
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    if (path === '/api/afk/log') {
      try {
        return sendJson(res, 200, buildAfkLog(await buildSnapshot(snapshotDeps()), clock))
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: errMsg(e) })
      }
    }
    // ── afk-workbench Task 6：GET /api/afk/:name/log —— 单个 change 的原始运行日志文本
    //    （.sandcastle-run.log 原样读取，见 afk.ts::readAfkRunLog）。与上面字面量路由
    //    /api/afk/log（聚合时间线）语义、路径结构均不同，正则要求 /log 前必有 change 名段，
    //    故不会误吞不带名字的旧路由——仍把参数化路由放在字面量判断之后，减少认知负担。
    //    校验顺序同 /api/afk/<name>/cancel、/api/afk/<name>/retry：先 change 名格式、
    //    再 root 信任锚（两侧 resolvePath 规范化再比对注册表）、最后 changeDir 存在性
    //    （ENOENT 前置校验，避免把「change 真不存在」误报成「还没日志」的 200 null）。
    //    读端点本身对齐 /api/config、/api/skills/registry：本机回环 GET 不鉴权。
    const logMatch = /^\/api\/afk\/([^/]+)\/log$/.exec(path)
    if (logMatch) {
      const segment = logMatch[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      // 信任锚：同 /api/afk/<name>/cancel、/api/afk/<name>/retry 共用的「两侧规范化再比较」模式。
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      // ENOENT 前置校验（同 cancelAfkRun/retryAfkRun 的存在性前置）：change 真不存在时给 400，
      // 不与「change 存在但还没日志」的 200 { log: null } 混为一谈。这里刻意用 400 而非看似更
      // "RESTful" 的 404——三个同由 root+name 寻址的兄弟端点（cancel/retry/log）在这条完全相同
      // 的“canonical current 与 legacy YAML 都不存在”判断上必须给同一状态码：cancel/retry 经
      // `sendJson(res, result.ok ? 200 : 400, result)` 把这个条件统一收敛成 400（见下方两个
      // handlePost 分支），log 若单独选 404 会让共享这三个端点错误处理逻辑的前端踩坑（review
      // finding）。root 未注册（上面那个分支）仍是 404，因为那是三端点另一个真正统一使用 404
      // 的既有约定，与此处无关。
      if (!stateStorageExistsSync(dir)) {
        return sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      }
      return sendJson(res, 200, { log: await readAfkRunLog(dir) })
    }
    // ── v5 T1（G21）：GET /api/change/:name/history —— change 阶段时间线数据源
    //    （.pipeline-history.jsonl 按 ts 升序回放，见 transition.ts::readChangeHistory）。
    //    校验顺序同 /api/afk/<name>/log 兄弟端点：先 change 名格式（防路径穿越）、再 root
    //    信任锚（两侧 resolvePath 规范化再比对注册表 → 404）、最后 changeDir 存在性（ENOENT
    //    前置校验 → 400，同 cancel/retry/log 三兄弟对这条完全相同判断的统一状态码约定——
    //    不与「change 存在但还没记录」的 200 { entries: [] } 混为一谈）。
    //    读端点对齐 /api/config、/api/skills/registry：本机回环 GET 不鉴权。
    const mHistory = /^\/api\/change\/([^/]+)\/history$/.exec(path)
    if (mHistory) {
      const segment = mHistory[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      if (!stateStorageExistsSync(dir)) {
        return sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      }
      return sendJson(res, 200, { entries: await readChangeHistory(dir, { store, recordStore }) })
    }
    // ── Control Room：canonical WorkflowRun + TransitionRecord + 关联 loop ledger 审计真相源。──
    const mRunDetail = /^\/api\/change\/([^/]+)\/run-detail$/.exec(path)
    if (mRunDetail) {
      const segment = mRunDetail[1]
      if (segment === undefined) return sendJson(res, 400, { ok: false, error: '非法 change 路径' })
      const name = decodeURIComponent(segment)
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.includes('..')) {
        return sendJson(res, 400, { ok: false, error: '非法 change 名（仅允许 a-z A-Z 0-9 - _）' })
      }
      const root = new URL(req.url ?? '/', 'http://localhost').searchParams.get('root') ?? ''
      if (!isRegisteredRoot(root)) {
        return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
      }
      const dir = join(root, 'openspec', 'changes', name)
      if (!stateStorageExistsSync(dir)) {
        return sendJson(res, 400, { ok: false, error: '找不到该 change（无 canonical/legacy 状态）' })
      }
      try {
        return sendJson(res, 200, await buildRunDetail(root, dir, name, {
          store,
          recordStore,
          ledger: loopLedger,
        }))
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: errMsg(error) })
      }
    }
}
