/**
 * 基准夹具：隔离根里 N 个 git 项目，每个项目 M 个 change（用真实的 `tenon init` 建），可选再加 K 个已结束任务
 * （`archived`，见 seedArchive），规模与开发者的日常机器同量级，但固定不变——基线只在夹具不变时才可比。
 *
 * 项目彼此独立，所以按项目并行建（每个项目内的 change 仍串行：同一个仓库的 init 共用一把治理锁）。
 * 30 × 30 = 900 个 change 串行要几分钟，并行后与核数同量级；并发上限 `BENCH_FIXTURE_CONCURRENCY`（默认 min(核数, 8)）。
 *
 * `fixtureDir`（--fixture-dir）只给开发机反复量同一份夹具用：目录里已有同规模的夹具就直接复用（不重建、不删除），
 * 没有就建在这里并留下。CI 与目录套件不传它，每次都是一份新的临时夹具。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import {
  TENON_CLI, commitBase, createScratch, isolatedEnv, isolatedNode, prepareTrustedNode, removeScratch, writeProjectFile,
} from '../lib/isolated-tenon.mjs'

const MARKER = 'bench-fixture.json'

function concurrency() {
  const configured = Number(process.env.BENCH_FIXTURE_CONCURRENCY)
  if (Number.isInteger(configured) && configured >= 1) return configured
  return Math.max(1, Math.min(availableParallelism(), 8))
}

/** 异步版 runTenon：退出码非 0 就抛错（带 stdout / stderr）。 */
function runTenonAsync(env, cwd, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(isolatedNode(env), [TENON_CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`tenon ${args.join(' ')} 退出 ${code}\n${output}`))))
  })
}

/** 至多 `limit` 个任务同时跑；任何一个失败就整体失败。 */
async function runPool(items, limit, task) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * 已结束任务：用真实的 CLI 建一个任务并终止它（移进 `archive/`），再把这个归档目录复制成 `archived` 份。复制与逐个终止
 * 在盘上的形状一致（归档目录不再变化），但只要毫秒；每份目录名不同，所以每份都是缓存里独立的一项。
 */
async function seedArchive(env, root, archived) {
  await runTenonAsync(env, root, ['init', 'archived-seed', '--track', 'backend', '--preset', 'full'])
  await runTenonAsync(env, root, ['task', 'terminate', 'archived-seed'])
  const archive = join(root, 'openspec', 'changes', 'archive')
  const [seed] = readdirSync(archive)
  if (seed === undefined) throw new Error(`${root}: tenon task terminate 之后 archive/ 是空的`)
  const date = seed.slice(0, 10)
  for (let copy = 2; copy <= archived; copy++) cpSync(join(archive, seed), join(archive, `${date}-archived-${copy}`), { recursive: true })
}

async function seedProject(env, root, project, changes, archived) {
  writeProjectFile(root, 'AGENTS.md', `# Bench project ${project}\n`)
  commitBase(root, env)
  for (let change = 1; change <= changes; change++) {
    await runTenonAsync(env, root, ['init', `change-${change}`, '--track', 'backend', '--preset', 'full'])
  }
  if (archived > 0) await seedArchive(env, root, archived)
}

export async function createBenchFixture({ projects, changes, archived = 0, fixtureDir }) {
  const kept = fixtureDir === undefined ? undefined : resolve(fixtureDir)
  let created
  if (kept === undefined) {
    created = createScratch('tenon-bench')
  } else {
    const marker = join(kept, MARKER)
    if (existsSync(marker)) {
      const saved = JSON.parse(readFileSync(marker, 'utf8'))
      if (saved.projects !== projects || saved.changes !== changes) {
        throw new Error(`${kept} 里的夹具是 ${saved.projects} × ${saved.changes}，与要求的 ${projects} × ${changes} 不同；换一个目录或删掉它`)
      }
      if ((saved.archived ?? 0) !== archived) {
        throw new Error(`${kept} 里的夹具每个项目有 ${saved.archived ?? 0} 个已结束任务，与要求的 ${archived} 个不同；换一个目录或删掉它`)
      }
      const env = isolatedEnv({ home: join(kept, 'home'), runtime: join(kept, 'runtime'), node: saved.node })
      return { scratch: kept, env, roots: rootsOf(kept, projects), cleanup: () => {} }
    }
    mkdirSync(join(kept, 'home'), { recursive: true })
    mkdirSync(join(kept, 'runtime'), { recursive: true })
    created = { scratch: kept, home: join(kept, 'home'), runtime: join(kept, 'runtime'), node: prepareTrustedNode(kept) }
  }
  const { scratch, home, runtime, node } = created
  const env = isolatedEnv({ home, runtime, node })
  const roots = rootsOf(scratch, projects)
  try {
    await runPool(roots, concurrency(), (root) => seedProject(env, root, roots.indexOf(root) + 1, changes, archived))
  } catch (error) {
    if (kept === undefined) removeScratch(scratch)
    throw error
  }
  if (kept !== undefined) writeFileSync(join(kept, MARKER), `${JSON.stringify({ projects, changes, archived, node })}\n`)
  return { scratch, env, roots, cleanup: () => { if (kept === undefined) removeScratch(scratch) } }
}

function rootsOf(scratch, projects) {
  return Array.from({ length: projects }, (_, index) => join(scratch, `project-${index + 1}`))
}
