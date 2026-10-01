import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ABSENT_REGISTRY_EPOCH,
  loadRegistry,
  readRegistrySnapshot,
  writeRegistryWithGovernance,
  type GraduationFs,
} from '@tenon/kernel'

export const REAL_GRADUATION_FS: GraduationFs = {
  loadRegistry: (repoRoot) => loadRegistry(repoRoot),
  readRunLog: (repoRoot) => {
    try {
      return readFileSync(join(repoRoot, '.superpowers', 'loops', 'progress.md'), 'utf8')
    } catch {
      return null
    }
  },
  readLoopDoc: (repoRoot) => {
    try {
      return readFileSync(join(repoRoot, 'LOOP.md'), 'utf8')
    } catch {
      return null
    }
  },
  readRegistrySnapshot: async (repoRoot) => {
    const snapshot = await readRegistrySnapshot(repoRoot)
    return snapshot.epoch === ABSENT_REGISTRY_EPOCH
      ? null
      : { text: snapshot.text, epoch: snapshot.epoch }
  },
  writeRegistryGoverned: async (repoRoot, expectedEpoch, produce) => {
    const result = await writeRegistryWithGovernance(repoRoot, expectedEpoch, (current) => produce(current))
    return { ok: result.ok, error: result.ok ? null : result.error }
  },
}

export function repoRootForSkills(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function assertDashboardTransactionId(value: string | undefined): void {
  if (value !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Dashboard managed transaction identity 格式非法')
  }
}

export function shQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  const normalized = host.trim().toLowerCase()
  return new Set([
    '127.0.0.1',
    'localhost',
    '[::1]',
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]).has(normalized)
}

export function indexHtml(token: string): string {
  const jsToken = JSON.stringify(token).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8"><title>Tenon Dashboard</title>
<h1>Pipeline Global Dashboard</h1>
<p>TS 全局 server 已就绪。只读数据见 <code>/api/snapshot</code> / <code>/api/stream</code>；健康探针 <code>/api/health</code>。</p>
<p>写端点需带写 token（仅登录会话的页面里有）。前端信息架构重构：BACKLOG #26。</p>
<script>window.__TENON_DASHBOARD_TOKEN__ = ${jsToken};</script>`
}
