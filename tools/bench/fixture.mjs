/**
 * 基准夹具：隔离根里 N 个 git 项目，每个项目 M 个 change（用真实的 `tenon init` 建），规模与开发者的日常机器同量级，
 * 但固定不变——基线只在夹具不变时才可比。
 */
import { join } from 'node:path'
import { commitBase, createScratch, isolatedEnv, removeScratch, runTenon, writeProjectFile } from '../lib/isolated-tenon.mjs'

export function createBenchFixture({ projects, changes }) {
  const { scratch, home, runtime } = createScratch('tenon-bench')
  const env = isolatedEnv({ home, runtime })
  const roots = []
  for (let project = 1; project <= projects; project++) {
    const root = join(scratch, `project-${project}`)
    writeProjectFile(root, 'AGENTS.md', `# Bench project ${project}\n`)
    commitBase(root, env)
    for (let change = 1; change <= changes; change++) {
      runTenon(env, root, ['init', `change-${change}`, '--track', 'backend', '--preset', 'full'])
    }
    roots.push(root)
  }
  return { scratch, env, roots, cleanup: () => removeScratch(scratch) }
}
