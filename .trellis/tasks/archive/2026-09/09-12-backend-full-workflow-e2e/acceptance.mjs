import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const root = path.resolve(process.argv[2] ?? '')
const packageMode = process.argv.includes('--package')
const packagePath = packageMode ? (await (async () => { const { readdir } = await import('node:fs/promises'); const files = await readdir(path.join(root, 'release')); const name = files.find((f) => f.endsWith('.tgz') || f.endsWith('.tar.gz')); if (!name) throw new Error('release archive missing'); return path.join(root, 'release', name) })()) : null
const testRoot = packagePath === null ? root : await mkdtemp(path.join(tmpdir(), 'tenon-release-'))
if (packagePath !== null) {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util')
  await promisify(execFile)('tar', ['-xzf', packagePath, '-C', testRoot])
}
const entry = path.join(testRoot, 'src', 'server.mjs')
const dataFile = path.join(testRoot, '.acceptance-data.json')
const child = spawn(process.execPath, [entry], { cwd: testRoot, env: { ...process.env, PORT: '0', DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''; child.stderr.on('data', (b) => { stderr += String(b) })
const lines = createInterface({ input: child.stdout })
const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`server start timeout: ${stderr}`)), 5000); lines.on('line', (line) => { const match = /^LISTENING (\d+)$/.exec(line.trim()); if (match) { clearTimeout(timer); resolve(Number(match[1])) } }); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)) }) })
const base = `http://127.0.0.1:${port}`
const results = []
async function check(name, fn) { try { await fn(); results.push({ name, ok: true }) } catch (e) { results.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) }) } }
const json = async (res) => { const text = await res.text(); return text ? JSON.parse(text) : null }
await check('health', async () => { const r = await fetch(`${base}/health`); if (r.status !== 200 || (await json(r)).status !== 'ok') throw new Error(`unexpected health ${r.status}`) })
await check('malformed-json', async () => { const r = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }); if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`) })
await check('blank-title', async () => { const r = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '  ' }) }); if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`) })
let id
await check('create-and-list', async () => { const r = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Ship backend API' }) }); const task = await json(r); if (r.status !== 201 || typeof task.id !== 'string' || task.status !== 'pending') throw new Error(`unexpected create ${r.status}`); id = task.id; const list = await fetch(`${base}/tasks`); const body = await json(list); if (!body.tasks.some((t) => t.id === id)) throw new Error('created task missing from list') })
await check('get-and-invalid-status', async () => { const got = await fetch(`${base}/tasks/${id}`); if (got.status !== 200) throw new Error(`get ${got.status}`); const bad = await fetch(`${base}/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'broken' }) }); if (bad.status !== 400) throw new Error(`expected invalid status 400, got ${bad.status}`) })
await check('update-and-delete', async () => { const updated = await fetch(`${base}/tasks/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }) }); if (updated.status !== 200 || (await json(updated)).status !== 'done') throw new Error(`update ${updated.status}`); const deleted = await fetch(`${base}/tasks/${id}`, { method: 'DELETE' }); if (deleted.status !== 204) throw new Error(`delete ${deleted.status}`); const missing = await fetch(`${base}/tasks/${id}`); if (missing.status !== 404) throw new Error(`missing ${missing.status}`) })
await new Promise((resolve) => child.kill('SIGTERM') ? child.once('exit', resolve) : resolve())
const restart = spawn(process.execPath, [entry], { cwd: testRoot, env: { ...process.env, PORT: '0', DATA_FILE: dataFile }, stdio: ['ignore', 'pipe', 'pipe'] })
let restartErr = ''; restart.stderr.on('data', (b) => { restartErr += String(b) })
const restartLines = createInterface({ input: restart.stdout }); const restartPort = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`restart timeout: ${restartErr}`)), 5000); restartLines.on('line', (line) => { const m = /^LISTENING (\d+)$/.exec(line.trim()); if (m) { clearTimeout(timer); resolve(Number(m[1])) } }); restart.once('exit', (code) => { clearTimeout(timer); reject(new Error(`restart exited ${code}: ${restartErr}`)) }) })
await check('restart-persistence', async () => { const r = await fetch(`http://127.0.0.1:${restartPort}/tasks`); const body = await json(r); if (r.status !== 200 || !Array.isArray(body.tasks) || body.tasks.length !== 0) throw new Error('unexpected persisted list after delete') })
restart.kill('SIGTERM'); await new Promise((resolve) => restart.once('exit', resolve))
if (packagePath !== null) await rm(testRoot, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(JSON.stringify({ mode: packageMode ? 'package' : 'source', root: testRoot, package: packagePath, checks: results, passed: failed.length === 0 }, null, 2))
if (failed.length > 0) process.exitCode = 1
