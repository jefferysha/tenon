import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkDashboardDist } from './check-dashboard-dist-freshness.mjs'

test('dashboard dist references must exist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-dist-freshness-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dist = join(root, 'packages/dashboard-app/dist')
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, 'index.html'), '<script type="module" src="./assets/app.js"></script>')
  assert.match(checkDashboardDist(root).join('\n'), /missing referenced asset/)
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'assets/app.js'), '')
  assert.deepEqual(checkDashboardDist(root), [])
})
