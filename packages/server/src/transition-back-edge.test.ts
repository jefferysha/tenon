/**
 * 真实 e2e —— Dashboard 服务的 transition 写回端点对退回边的技能门：default 工作流任务在实现步，本次访问没有任何
 * builder 运行与 TDD 回执时，退回边 `requirements-changed` 放行（TDD 归执行者 builder，只能在 builder 运行期间加载），
 * 前进边 `build-complete` 仍因缺 `test-driven-development` 被拒；不归属任何 agent 的主线技能在退回边上照旧要求。
 * 与 CLI 同一份判定（kernel transition-step-gates），agent 台账读冻结的 `.pipeline-frozen`。
 */
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  builtinTrack, compileEffectiveWorkflowPlan, createBuildRevisionToken, createTransitionRecordStore,
  createWorkflowRunRepository, ensureAgentFreeze, readCurrentRunRevision, type StateStore,
} from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import { initChange, makeProject, newStore, repoManifestPath, testFlow } from './test-support.js'

const NAME = 'demo'
const BUILD_TOKEN = createBuildRevisionToken(
  'git', 'a'.repeat(40), { repository: '/repo.git', worktree: '/repo' },
).value

let root: string
let store: StateStore
let deps: TransitionDeps

const changeDir = (): string => join(root, 'openspec', 'changes', NAME)
const go = (event: string) => performTransition(deps, root, NAME, event)
/** 仓库自带的内建 agent 定义（与 `tenon init` 冻结的同一份）。 */
const builtinAgent = (name: string): string =>
  readFileSync(join(dirname(repoManifestPath()), 'agents', `${name}.md`), 'utf8')

async function freezeAgents(): Promise<void> {
  const plan = compileEffectiveWorkflowPlan('default', undefined, builtinTrack('backend'))
  const runId = (await readCurrentRunRevision(changeDir()))?.state.runMetadata?.runId
  if (runId === undefined) throw new Error('fixture run identity missing')
  await ensureAgentFreeze({
    changeDir: changeDir(), runId, workflowFingerprint: plan.workflowFingerprint, workflow: plan.workflow,
    resolve: (name) => ({ source: 'builtin', content: builtinAgent(name) }),
  })
}

beforeEach(async () => {
  store = newStore()
  root = await makeProject()
  await initChange(store, root, NAME, { track: 'backend' })
  const recordStore = createTransitionRecordStore()
  deps = {
    store,
    runRepo: createWorkflowRunRepository({ store, recordStore, clock: () => '2026-10-11T00:00:00Z' }),
    recordStore,
    flow: testFlow(),
    clock: () => '2026-10-11T00:00:00Z',
    // 本用例的主题是技能门，不是构建版本：给一个固定的令牌，让 freeze-build-sha 不依赖真实 git。
    captureBuildRevision: async () => BUILD_TOKEN,
  }
  await freezeAgents()
})

/** 响应里 `detail` 的整段文案（技能行带「调用后还须…」后缀，按子串断言）。 */
const detailOf = (body: Record<string, unknown>): string => (Array.isArray(body.detail) ? body.detail : []).join('\n')

describe('Dashboard 服务的 transition：退回边不要求执行者的技能', () => {
  test('实现步没有 builder 运行与 TDD 回执：requirements-changed 回到规格；build-complete 仍列出 test-driven-development', async () => {
    // 前进边的前置条件（tasks 全部勾选、build_mode / isolation / 预验证评审）全部满足，只剩技能门这一个变量。
    await writeFile(join(changeDir(), 'tasks.md'), '# Tasks\n\n## Build\n\n- [x] scope\n- [x] implementation\n', 'utf8')
    await store.setMany(changeDir(), {
      phase: 'build', build_mode: 'direct', direct_override: 'true', isolation: 'branch', pre_verify_review_result: 'pass',
    })

    const forward = await go('build-complete')
    expect(forward.code, JSON.stringify(forward.body)).toBe(409)
    expect(forward.body.code, JSON.stringify(forward.body)).toBe('step-skills-incomplete')
    expect(detailOf(forward.body)).toContain('test-driven-development')
    expect((await store.read(changeDir())).fields.phase).toBe('build')

    const back = await go('requirements-changed')
    expect(back.body, JSON.stringify(back.body)).toMatchObject({ ok: true, from: 'build', to: 'spec' })
    expect(back.code).toBe(200)
    expect((await store.read(changeDir())).fields.phase).toBe('spec')
  })

  test('不归属任何 agent 的主线技能在退回边上仍被要求：验证步缺 verification-before-completion 时 verify-fail 被拒', async () => {
    await store.set(changeDir(), 'phase', 'verify')
    const back = await go('verify-fail')
    expect(back.code).toBe(409)
    expect(back.body).toMatchObject({ ok: false, code: 'step-skills-incomplete' })
    expect(detailOf(back.body)).toContain('verification-before-completion')
    expect((await store.read(changeDir())).fields.phase).toBe('verify')
  })
})
