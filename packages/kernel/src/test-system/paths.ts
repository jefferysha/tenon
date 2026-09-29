/**
 * 测试体系的文件位置（单一真相源）。
 *   · 项目共享、进 git：`.tenon/tests/catalog.yaml`、`.tenon/tests/known-failures.yaml`、
 *     基线 `.tenon/tests/baselines/<suite>/<profile>.json`。
 *   · 任务内：`openspec/changes/<c>/test-plan.yaml` 与其摘要台账 `.pipeline-test-plan.json`。
 *   · 按用户：运行记录 v2 与 v1 放在同一个按用户的记录目录（userProjectPaths(...).testsDir/<change>），
 *     按 schema 区分；哈希链追加锁放在该用户 gitignored 的 local 目录下的 `test-chain/<change>/`。
 */
import { join } from 'node:path'
import { TENON_PROJECT_DIR, userProjectPaths } from '../users/user-paths.js'
import { SUITE_ID_RE } from './vocabulary.js'

export const TEST_SYSTEM_DIR = 'tests'
export const TEST_CATALOG_FILE = 'catalog.yaml'
export const KNOWN_FAILURES_FILE = 'known-failures.yaml'
export const BASELINES_DIR = 'baselines'
export const TEST_PLAN_LEDGER_FILE = '.pipeline-test-plan.json'
export const MACHINE_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/

export interface TestSystemPaths {
  readonly root: string
  readonly catalog: string
  readonly knownFailures: string
  readonly baselinesDir: string
}

export function testSystemPaths(repoRoot: string): TestSystemPaths {
  const root = join(repoRoot, TENON_PROJECT_DIR, TEST_SYSTEM_DIR)
  return {
    root,
    catalog: join(root, TEST_CATALOG_FILE),
    knownFailures: join(root, KNOWN_FAILURES_FILE),
    baselinesDir: join(root, BASELINES_DIR),
  }
}

/** 仓库相对形式（提示文案、hook 规则用）。 */
export const TEST_CATALOG_REPO_PATH = `${TENON_PROJECT_DIR}/${TEST_SYSTEM_DIR}/${TEST_CATALOG_FILE}`
export const KNOWN_FAILURES_REPO_PATH = `${TENON_PROJECT_DIR}/${TEST_SYSTEM_DIR}/${KNOWN_FAILURES_FILE}`
export const BASELINES_REPO_PATH = `${TENON_PROJECT_DIR}/${TEST_SYSTEM_DIR}/${BASELINES_DIR}`

export function baselineV2Path(repoRoot: string, suite: string, profile: string): string {
  if (!SUITE_ID_RE.test(suite)) throw new Error(`基线套件 id 非法: ${suite}`)
  if (!MACHINE_PROFILE_ID_RE.test(profile)) throw new Error(`机器画像 id 非法: ${profile}`)
  return join(testSystemPaths(repoRoot).baselinesDir, suite, `${profile}.json`)
}

export function testPlanPath(changeDir: string): string {
  return join(changeDir, 'test-plan.yaml')
}

export function testPlanLedgerPath(changeDir: string): string {
  return join(changeDir, TEST_PLAN_LEDGER_FILE)
}

/** v2 记录目录（与 v1 同目录）。change 名由调用方校验。 */
export function testRunRecordsDir(repoRoot: string, slug: string, change: string): string {
  return join(userProjectPaths(repoRoot, slug).testsDir, change)
}

/** 哈希链追加锁的目录（gitignored，本机）。 */
export function testRecordChainLockDir(repoRoot: string, slug: string, change: string): string {
  return join(userProjectPaths(repoRoot, slug).localDir, 'test-chain', change)
}
