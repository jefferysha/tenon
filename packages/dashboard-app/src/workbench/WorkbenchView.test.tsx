import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, useT } from '../i18n'
import { invalidateWorkflowRules, useWorkflowRules } from '../model/workflowModel'
import { invalidateMandatoryConfig } from './mandatorySkills'
import { DEFAULT_WORKFLOW_RULES, makeChange, makeProject, makeSnapshot } from '../testkit'
import type { WorkflowPolicyRulesSnapshot } from '../types'
import { decodeWorkflowDeleteError, decodeWorkflowDeleteSuccess } from './workbenchApiDecoders'
import {
  moveSkillInDef,
  removeStageFromDef,
  reorderStagesInDef,
  setSkillDepInDef,
  stageCounts,
  WorkbenchView,
  type WbWorkflowDef,
} from './WorkbenchView'

const ROOT = '/tmp/proj-a'

describe('decodeWorkflowDeleteError', () => {
  it.each([
    {},
    { ok: false },
    { ok: false, code: 'WORKFLOW_REFERENCED', workflow: 'release-train', references: [{}] },
    { ok: false, code: 'WORKFLOW_REFERENCED', workflow: 'release-train', references: [{ kind: 'future-kind', source: 'x' }] },
  ])('rejects malformed or open-ended envelopes %#', (value) => {
    expect(decodeWorkflowDeleteError(value)).toBeNull()
  })

  it.each([
    {},
    { ok: false },
    { ok: true, deleted: 'release-train' },
  ])('requires the exact workflow delete success envelope %#', (value) => {
    expect(decodeWorkflowDeleteSuccess(value)).toBe(false)
  })

  it('accepts the exact workflow delete success envelope', () => {
    expect(decodeWorkflowDeleteSuccess({ ok: true })).toBe(true)
  })
})

// T12 fixture：对照 design-demos/v5-progress-workbench.html 的 release-train 三阶段示例，
// 但形状是真实 server 契约（GET /api/workflows/:name 的 { name, steps: StepDef[] }，同
// 旧 workflow 列表页测试（T18 已退役） 顶层 fixture 一致）。draft 带 3 个技能（验证 chips 截断 +N）、
// review 是复核门、ship 带 2 个产出（验证摘要行计数）。
const RELEASE_TRAIN = {
  name: 'release-train',
  steps: [
    {
      id: 'draft', label: '起草', gate: null,
      skills: [{ id: 'superpowers:tdd' }, { id: 'impeccable', depends_on: ['superpowers:tdd'] }, { id: 'browser-qa' }],
      inputs: [], outputs: [{ field: 'draft_doc', type: 'file_path' }], guards: [],
      transitions: [{ event: 'submitted', to: 'review' }],
    },
    {
      // T13：review 带 inputs——验收①「保存 body 含 inputs 原样透传」的探针字段
      //（Inputs UI 不渲染，但 schema/serialize 兼容保留，保存不丢）。
      id: 'review', label: '人工复核', gate: 'review',
      skills: [], inputs: [{ field: 'draft_doc', type: 'file_path' }], outputs: [], guards: [],
      transitions: [{ event: 'approved', to: 'ship' }, { event: 'rejected', to: 'draft' }],
    },
    {
      id: 'ship', label: '发布', gate: null,
      skills: [], inputs: [],
      outputs: [{ field: 'release_notes', type: 'file_path' }, { field: 'sha', type: 'string' }],
      guards: [], transitions: [],
    },
  ],
}

/**
 * v11 P1：删阶段的转换边重连（removeStageFromDef 纯函数）。
 * 这是本视图唯一会破坏 def 结构完整性的操作——留下悬空 id，kernel validate 保存时当场拒。
 * 故直接单测，不只靠 UI 层覆盖。fixture 用上面的 RELEASE_TRAIN：
 *   draft --submitted--> review --approved--> ship（末端）
 *                        review --rejected--> draft（回边）
 */
describe('removeStageFromDef 删阶段重连（v11 P1）', () => {
  const DEF = RELEASE_TRAIN as WbWorkflowDef

  it('删中间阶段：指向它的边改指它的线性后继，不留悬空 id', () => {
    const out = removeStageFromDef(DEF, 'review')
    expect(out.steps.map((s) => s.id)).toEqual(['draft', 'ship'])
    // draft 的 submitted→review 重连成 submitted→ship（review 的后继）
    expect(out.steps[0]!.transitions).toEqual([{ event: 'submitted', to: 'ship' }])
    // 全图不得残留指向已删 id 的边
    expect(out.steps.flatMap((s) => s.transitions).some((tr) => tr.to === 'review')).toBe(false)
  })

  it('删末端阶段：指向它的边直接删掉（前一步成为新末端，kernel 只许末端零边）', () => {
    const out = removeStageFromDef(DEF, 'ship')
    expect(out.steps.map((s) => s.id)).toEqual(['draft', 'review'])
    // review 的 approved→ship 没了；rejected→draft 原样保留（不指向被删项，不动）
    expect(out.steps[1]!.transitions).toEqual([{ event: 'rejected', to: 'draft' }])
  })

  it('删首阶段：重连若产生自环则丢弃该边（review 的 rejected→draft 不得变成 review 自指）', () => {
    const out = removeStageFromDef(DEF, 'draft')
    expect(out.steps.map((s) => s.id)).toEqual(['review', 'ship'])
    // rejected→draft 本应重连到 draft 的后继 review，但那是 review 自己 → 丢弃
    expect(out.steps[0]!.transitions).toEqual([{ event: 'approved', to: 'ship' }])
    // 全图不得出现自环（step 的出边指向自己）
    expect(out.steps.some((s) => s.transitions.some((tr) => tr.to === s.id))).toBe(false)
  })

  it('删不存在的 id：原样返回（同一引用，不产生无谓重渲染）', () => {
    expect(removeStageFromDef(DEF, 'nope')).toBe(DEF)
  })

  it('未触碰字段原样保留（skills/inputs/outputs/guards 不因删阶段丢失）', () => {
    const out = removeStageFromDef(DEF, 'review')
    expect(out.steps[0]!.skills).toEqual(DEF.steps[0]!.skills)
    expect(out.steps[0]!.outputs).toEqual(DEF.steps[0]!.outputs)
    expect(out.steps[1]!.outputs).toEqual(DEF.steps[2]!.outputs)
    expect(out.name).toBe('release-train')
  })
})

/**
 * v11 P2：阶段列拖动重排（reorderStagesInDef 纯函数）。
 * 与删阶段同理——这是会破坏 def 结构完整性的操作，直接单测。
 * fixture：draft --submitted--> review --approved--> ship（末端）；review --rejected--> draft（分支回边）
 */
describe('reorderStagesInDef 阶段列重排（v11 P2）', () => {
  const DEF = RELEASE_TRAIN as WbWorkflowDef

  it('把末端 ship 拖到最前：线性边按新序重连，原末端补出边、新末端删出边', () => {
    // 新序：ship, draft, review
    const out = reorderStagesInDef(DEF, 'ship', 'draft', false)
    expect(out.steps.map((s) => s.id)).toEqual(['ship', 'draft', 'review'])
    // ship 旧序是末端（无线性边）→ 新序不再是末端，必须补一条，否则中间 step 零出边 = kernel 拒
    expect(out.steps[0]!.transitions).toEqual([{ event: 'ship-complete', to: 'draft' }])
    // draft 的线性边 submitted 保留事件名，改指新的下一个 = review
    expect(out.steps[1]!.transitions).toEqual([{ event: 'submitted', to: 'review' }])
    // review 新序成了末端 → 线性边 approved 删掉；分支边 rejected→draft 原样保留
    expect(out.steps[2]!.transitions).toEqual([{ event: 'rejected', to: 'draft' }])
  })

  it('中间 review 拖到末尾：事件名不被重命名，分支边不受影响', () => {
    // 新序：draft, ship, review
    const out = reorderStagesInDef(DEF, 'review', 'ship', true)
    expect(out.steps.map((s) => s.id)).toEqual(['draft', 'ship', 'review'])
    expect(out.steps[0]!.transitions).toEqual([{ event: 'submitted', to: 'ship' }]) // 事件名保留
    expect(out.steps[1]!.transitions).toEqual([{ event: 'ship-complete', to: 'review' }]) // 原末端补边
    expect(out.steps[2]!.transitions).toEqual([{ event: 'rejected', to: 'draft' }]) // 线性边删、分支边留
  })

  it('重排后不留悬空 id，且每个非末端 step 都有出边（kernel 只许末端零边）', () => {
    for (const [from, to, after] of [['ship', 'draft', false], ['review', 'ship', true], ['draft', 'ship', true]] as const) {
      const out = reorderStagesInDef(DEF, from, to, after)
      const ids = new Set(out.steps.map((s) => s.id))
      for (const s of out.steps) for (const tr of s.transitions) expect(ids.has(tr.to)).toBe(true)
      out.steps.slice(0, -1).forEach((s) => expect(s.transitions.length).toBeGreaterThan(0))
    }
  })

  it('拖到自己身上 / 不存在的 id → 原样返回', () => {
    expect(reorderStagesInDef(DEF, 'draft', 'draft', false)).toBe(DEF)
    expect(reorderStagesInDef(DEF, 'nope', 'draft', false)).toBe(DEF)
  })
})

/**
 * v11 P2：技能拖动落位（moveSkillInDef）+ 依赖增删改（setSkillDepInDef）。
 * draft 的技能：superpowers:tdd → impeccable(depends_on:[superpowers:tdd]) → browser-qa
 */
describe('moveSkillInDef 技能拖排 / 跨列搬（v11 P2）', () => {
  const DEF = RELEASE_TRAIN as WbWorkflowDef

  it('列内排序：只动次序，depends_on 全部保留（依赖按 id 解析，与视觉序无关）', () => {
    const out = moveSkillInDef(DEF, { skillId: 'browser-qa', fromStage: 'draft', toStage: 'draft', refSkillId: 'superpowers:tdd', after: false })
    const draft = out.steps.find((s) => s.id === 'draft')!
    expect(draft.skills.map((k) => k.id)).toEqual(['browser-qa', 'superpowers:tdd', 'impeccable'])
    expect(draft.skills.find((k) => k.id === 'impeccable')!.depends_on).toEqual(['superpowers:tdd'])
  })

  it('跨列搬：源列里指向它的依赖被清掉（否则成跨 step 引用 = kernel 校验期错误）', () => {
    const out = moveSkillInDef(DEF, { skillId: 'superpowers:tdd', fromStage: 'draft', toStage: 'ship', refSkillId: null, after: true })
    const draft = out.steps.find((s) => s.id === 'draft')!
    const ship = out.steps.find((s) => s.id === 'ship')!
    expect(draft.skills.map((k) => k.id)).toEqual(['impeccable', 'browser-qa'])
    // impeccable 原本依赖 superpowers:tdd —— 它已被搬走，依赖必须清掉，且剔空后删键（不留空数组）
    expect(draft.skills.find((k) => k.id === 'impeccable')).not.toHaveProperty('depends_on')
    expect(ship.skills.map((k) => k.id)).toEqual(['superpowers:tdd'])
  })

  it('跨列搬：被搬技能自己的 depends_on 整个丢弃（它依赖的是源列的技能）', () => {
    const out = moveSkillInDef(DEF, { skillId: 'impeccable', fromStage: 'draft', toStage: 'ship', refSkillId: null, after: true })
    const moved = out.steps.find((s) => s.id === 'ship')!.skills.find((k) => k.id === 'impeccable')!
    expect(moved).not.toHaveProperty('depends_on')
  })

  it('目标列已有同名技能 → 整个 no-op（技能在阶段内唯一）', () => {
    const seeded: WbWorkflowDef = {
      ...DEF,
      steps: DEF.steps.map((s) => (s.id === 'ship' ? { ...s, skills: [{ id: 'browser-qa' }] } : s)),
    }
    expect(moveSkillInDef(seeded, { skillId: 'browser-qa', fromStage: 'draft', toStage: 'ship', refSkillId: null, after: true })).toBe(seeded)
  })

  it('不存在的技能 / 阶段 → 原样返回', () => {
    expect(moveSkillInDef(DEF, { skillId: 'nope', fromStage: 'draft', toStage: 'ship', refSkillId: null, after: true })).toBe(DEF)
    expect(moveSkillInDef(DEF, { skillId: 'browser-qa', fromStage: 'draft', toStage: 'nope', refSkillId: null, after: true })).toBe(DEF)
  })
})

describe('setSkillDepInDef 依赖增删改（v11 P2）', () => {
  const DEF = RELEASE_TRAIN as WbWorkflowDef
  // 多依赖 fixture：impeccable 同时依赖 tdd 与 browser-qa
  const MULTI: WbWorkflowDef = {
    ...DEF,
    steps: DEF.steps.map((s) =>
      s.id !== 'draft'
        ? s
        : { ...s, skills: [{ id: 'superpowers:tdd' }, { id: 'impeccable', depends_on: ['superpowers:tdd', 'browser-qa'] }, { id: 'browser-qa' }] },
    ),
  }
  const depsOf = (d: WbWorkflowDef, id: string) => d.steps.find((s) => s.id === 'draft')!.skills.find((k) => k.id === id)!.depends_on

  it('加一条：追加到已有依赖之后，不覆写既有的', () => {
    const out = setSkillDepInDef(MULTI, 'draft', 'superpowers:tdd', 'browser-qa', null)
    expect(depsOf(out, 'superpowers:tdd')).toEqual(['browser-qa'])
    // 别人的依赖不受影响
    expect(depsOf(out, 'impeccable')).toEqual(['superpowers:tdd', 'browser-qa'])
  })

  it('多依赖下改其中一条：只换那一条、保持位置，另一条纹丝不动（不静默丢数据）', () => {
    const out = setSkillDepInDef(MULTI, 'draft', 'impeccable', 'browser-qa', 'superpowers:tdd')
    // 把第一条 superpowers:tdd 换成 browser-qa → 与已有的 browser-qa 去重后只剩一条
    expect(depsOf(out, 'impeccable')).toEqual(['browser-qa'])
  })

  it('多依赖下清其中一条：另一条保留（整体覆写会把它抹掉——这条守的就是这个）', () => {
    const out = setSkillDepInDef(MULTI, 'draft', 'impeccable', null, 'superpowers:tdd')
    expect(depsOf(out, 'impeccable')).toEqual(['browser-qa'])
  })

  it('清掉最后一条依赖 → 删键而不是留空数组（serialize 不写无意义空行）', () => {
    const out = setSkillDepInDef(DEF, 'draft', 'impeccable', null, 'superpowers:tdd')
    expect(out.steps.find((s) => s.id === 'draft')!.skills.find((k) => k.id === 'impeccable')).not.toHaveProperty('depends_on')
  })

  it('重复加同一条 → 不产生重复项', () => {
    const out = setSkillDepInDef(DEF, 'draft', 'impeccable', 'superpowers:tdd', null)
    expect(depsOf(out, 'impeccable')).toEqual(['superpowers:tdd'])
  })
})

function renderView(props: Partial<Parameters<typeof WorkbenchView>[0]> = {}, _openEditor = true) {
  function LanguageToggle(): JSX.Element {
    const { setLang } = useT()
    return <button type="button" data-testid="test-language-en" onClick={() => setLang('en')}>en</button>
  }
  render(
    <I18nProvider>
      <LanguageToggle />
      <WorkbenchView root={ROOT} {...props} />
    </I18nProvider>,
  )
  // 编辑器现在直接常驻主页；测试不再模拟一个已删除的“查看与编辑”中转操作。
}

async function openGovernance(): Promise<HTMLElement> {
  const button = await screen.findByTestId('wb-governance-open')
  await waitFor(() => expect(button).toBeEnabled())
  expect(button).toBeVisible()
  fireEvent.click(button)
  return screen.findByTestId('wb-side-col')
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * v11 P4 断言迁移登记（2026-07-15）：五页签 sheet 退役 —— 编辑驱动点从 sheet 里的
 * <StepEditor> 换成**画布泳道就地编**。
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * 「合并的是 IA，不是能力」——被测行为基本没变，变的是渲染位置。全文件落点对照：
 *   sheet 页签      wb-tab-* / wb-pane-*             → 无（页签概念本身退役，见下方 §删除登记）
 *   阶段名          getByLabelText('阶段名称')        → wb-lane-name-${id} 点开 → wb-lane-name-input-${id}
 *   复核门          getByRole('switch',{name:'复核门'}) → wb-lane-gate-sw-${id}
 *   产出非空 guard   getByRole('switch',{name:'产出非空方可推进'}) → wb-lane-guard-${id}
 *   加产出          getByRole('button',{name:'+ 添加'}) → wb-lane-out-add-${id} → wb-lane-out-input-${id}
 *   选中态读数      wb-editor-stage 文本              → 泳道 aria-current="step" / data-state="current"
 *   只读说明        wb-ed-readonly                    → 泳道 wb-lane-lock-${id} 徽章 + 零编辑入口
 *   Loop 卡         wb-pane-loop 内 wb-loop-card      → wb-rail-loop-full → wb-rail-loop-dialog 内挂原件
 *   AFK/凭证/技能健康 wb-pane-afk/secrets/health       → 右栏 wb-rail-machine-summary 折叠区（默认收起）
 *   default 强制矩阵 SkillChain default 模式 + wb-mx-open → 画布 wb-mand-* + 看板级 wb-track-*
 *
 * §删除登记（**只有**随页签本身消失的概念才删，逐条附因）：
 *   · 「点 tab 切 pane / aria-selected 与 pane data-state 联动」——页签没了，tab/pane 不存在。
 *   · 「墨线 ink GSAP 滑动 + pane crossfade」——本就不在 jsdom 断言，随页签一并作废。
 *   · 「pane 恒挂载保留未提交草稿」——探针（StepEditor 的 adding/draft 本地 state）与被证伪对象
 *     （pane 条件卸载）双双随页签退役；画布无页签、无 pane 切换，「切走再切回」这个动作不存在。
 *   · 「编辑卡在前、Loop 卡在后（demo 布局序）」——编辑卡（wb-editor）已卸载，两者不再同列共存。
 *   · 「矩阵入口卡 wb-mx-open：自定义 workflow 可点 → 切到 default；default 下禁用」——入口卡
 *     随「技能健康」页签一并被摘（生产侧 Task C 的决定；i18n 的 mx_open/mx_open_here 已成孤儿键，
 *     已上报）。其守的**能力**（default 的强制技能矩阵可达）未丢：改由 workflow 下拉切 default
 *     → 画布技能区渲 wb-mand-* 承载，见下方「default 强制技能矩阵」用例。
 */

/** 泳道阶段名就地改：点名字进编辑态 → 改 → Enter 提交（画布 commitName：空名/同名不提交）。 */
function editLaneName(stage: string, value: string): void {
  fireEvent.click(screen.getByTestId(`wb-lane-name-${stage}`))
  const input = screen.getByTestId(`wb-lane-name-input-${stage}`)
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}


// T16 fixture：/api/loops/snapshot 单 loop 行（server LoopRow 契约形状；缺省空——多数用例只关心
// workflow 编辑面，摘要「自动运行」行回落「未配置」）。
const LOOP_ROW = {
  root: ROOT,
  id: 'restyle-loop',
  name: '样式迁移',
  autonomy_level: 'L1',
  status: 'active',
  cadence: '2h',
  goal: '把旧版工单卡样式逐个迁移到 SaaS 卡片风',
  design_doc: 'design/restyle.md',
  change_prefix: 'rl-',
  risk: 'low',
  runner: 'claude-code',
  human_gates: ['合并前'],
  kill_criteria: ['no-change-3'],
  allowlist: [],
  denylist: [],
  budget_decl: { max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip', max_tokens_per_day: 100000 },
  readiness: { score: 62, band: 'L2-ready' },
  budget: { breaker: 'ok', runsToday: 3, spentToday: 3000, remaining: 97000, hasBudget: true, maxTokensPerDay: 100000 },
  // T7：关系条数据面（server LoopRow 契约形状同步——本文件多数用例不断言关系条内容，给稳定占位值）。
  matched_changes: ['rl-0142-migrate-card'],
  phases: ['build', 'verify'],
}

let loopRows: unknown[]
let workflowDefs: Record<string, typeof RELEASE_TRAIN>

beforeEach(() => {
  localStorage.clear()
  invalidateWorkflowRules() // 模块级 rules 缓存跨用例清空（同 旧 workflow 列表页测试（T18 已退役） 既有先例）
  // v11 P1：mandatory config 也是模块级缓存（mandatorySkills.tsx 的 cfgCache，与 sheet 里的
  // SkillChain 共用一份）——不清就会跨用例泄漏：第一个用例把 {capable:false} 写进缓存后，
  // 后续用例的 peekMandatoryConfig() 直接命中它、连 fetch 都不发，于是「跑单条绿、整文件红」
  // 这类顺序依赖就出现了（本轮真踩过）。同 invalidateWorkflowRules 的既有纪律。
  invalidateMandatoryConfig()
  loopRows = []
  workflowDefs = { 'release-train': structuredClone(RELEASE_TRAIN) }
  global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
    if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
      return new Response(JSON.stringify({ names: Object.keys(workflowDefs).sort() }), { status: 200 })
    }
    const workflowRead = /^\/api\/workflows\/([^?]+)\?root=/.exec(url)
    if (workflowRead && (!opts?.method || opts.method === 'GET')) {
      const name = decodeURIComponent(workflowRead[1]!)
      const found = workflowDefs[name]
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response(JSON.stringify({ error: `workflow '${name}' 不存在` }), { status: 404 })
    }
    // T13 + v3 Studio：保存、新建与复制共用 POST /api/workflows/:name。
    const workflowWrite = /^\/api\/workflows\/([^?]+)$/.exec(url)
    if (workflowWrite && opts?.method === 'POST') {
      const name = decodeURIComponent(workflowWrite[1]!)
      const body = JSON.parse(String(opts.body)) as typeof RELEASE_TRAIN & { root?: string }
      const { root: _root, ...stored } = body
      workflowDefs[name] = stored as typeof RELEASE_TRAIN
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const workflowDelete = /^\/api\/workflows\/([^?]+)\?root=/.exec(url)
    if (workflowDelete && opts?.method === 'DELETE') {
      const name = decodeURIComponent(workflowDelete[1]!)
      delete workflowDefs[name]
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    // T16：Loop 卡数据面（缺省无 loop——空态；用例按需往 loopRows 里灌行）
    if (url === '/api/loops/snapshot') {
      return new Response(JSON.stringify({ generated_at: '2026-07-11T00:00:00Z', rows: loopRows }), { status: 200 })
    }
    // v11 P1：本视图现在托管 useMandatorySkills（default 的 manifest 强制技能矩阵），
    // 它 mount 即拉 config 与 registry。这两条**必须**显式应答：走下面的 throw 兜底虽被
    // loadMandatoryConfig 的 fail-soft catch 接住（不会炸），但会把 {capable:false} 写进
    // 模块缓存、并让一个 async setState 落在用例边界之外——正是 flake 的来源。
    if (url.startsWith('/api/config?root=')) {
      return new Response(JSON.stringify({
        ok: true,
        generated_at: '2026-07-19T00:00:00Z',
        revision: 'workbench-r5',
        source: 'builtin-only',
        mandatory_skills_writable_profiles: ['pm', 'frontend', 'backend'],
        mandatory_skills: {},
        tracks: ['pm', 'frontend', 'backend'].map((id, index) => ({
          id,
          label: id,
          builtin: true,
          workflow: { default: 'default', allowed: '*' },
          policyProfile: {
            reviewSeed: id === 'pm' ? 'skipped' : 'pending',
            automationEligible: true,
            coverageProfile: id,
            routing: { enabled: true, pattern: id, priority: 100 + index },
            skills: { matrix: true, profile: id },
          },
        })),
      }), { status: 200 })
    }
    if (url === '/api/skills/registry') {
      return new Response(JSON.stringify({ skills: [] }), { status: 200 })
    }
    // ── v11 P4：右栏「机器配置」折叠区的三件原件（AutomationCard/SecretsCard/SkillHealthPanel）
    //    各自 mount 即拉。**闭合即卸载**（WorkbenchSideRail.tsx:134），故只有真展开折叠区的那条
    //    用例会走到这里；但仍**显式应答**而非留给 throw 兜底——理由同上面 /api/config 那条登记：
    //    fail-soft catch 会把一个 async setState 落在用例边界之外，正是 flake 的来源。
    //    三条 body 逐字对齐各自 client 接缝消费的形状（AutomationCard.test/SecretsCard.test 同款）
    //    ——形状糊弄不过去：readiness 有 isValidReadiness 浅校验（client.ts:460-473，Bug3 的修复），
    //    SecretsCard 则会直接深访问 keys[key].set。
    if (url.startsWith('/api/automation')) {
      return new Response(
        JSON.stringify({
          ok: true,
          settings: {
            enabled: false,
            max_parallel: 1,
            max_retries: 1,
            default_opt_in: false,
            image: 'pipeline-afk:latest',
          },
        }),
        { status: 200 },
      )
    }
    if (url.startsWith('/api/afk/readiness')) {
      return new Response(
        JSON.stringify({
          ok: true,
          docker: { available: true },
          image: { configured: 'pipeline-afk:latest', present: true, build_hint: '' },
          credentials: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: { set: true, source: 'secrets-file' } },
            codex: { OPENAI_API_KEY: { set: false }, CODEX_HOME: { set: false } },
          },
        }),
        { status: 200 },
      )
    }
    if (url.startsWith('/api/secrets')) {
      return new Response(
        JSON.stringify({
          ok: true,
          keys: { CLAUDE_CODE_OAUTH_TOKEN: { set: false }, OPENAI_API_KEY: { set: false } },
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
})
afterEach(() => {
  delete window.__TENON_DASHBOARD_TOKEN__
  window.localStorage.removeItem('tenon-dashboard-lang')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkbenchView stepper（验收①）', () => {
  it('切换语言不重拉 Workflow、不覆盖未保存草稿，并保留已打开的治理对话框', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (/^\/api\/workflows\/release-train$/.test(url) && options?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false, errors: ['阶段配置无效'] }), { status: 400 })
      }
      return baseFetch(url, options)
    }) as unknown as typeof fetch
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByRole('button', { name: '执行指令' }))
    const prompt = screen.getByLabelText('Codex 阶段指令')
    fireEvent.change(prompt, { target: { value: 'Keep this unsaved prompt.' } })
    fireEvent.click(screen.getByTestId('wb-save'))
    expect(await screen.findByTestId('wb-save-errors')).toHaveTextContent('阶段配置无效')
    fireEvent.click(screen.getByTestId('wb-governance-open'))
    expect(await screen.findByRole('dialog', { name: '运行治理' })).toBeInTheDocument()

    const workflowUrl = `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}`
    const workflowGetsBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url, options]) => url === workflowUrl && (!(options as RequestInit | undefined)?.method || (options as RequestInit).method === 'GET')).length

    fireEvent.click(screen.getByTestId('test-language-en'))

    expect(screen.getByLabelText('Codex step instructions')).toHaveValue('Keep this unsaved prompt.')
    expect(screen.getByRole('dialog', { name: 'Runtime governance' })).toBeInTheDocument()
    expect(screen.queryByText('阶段配置无效')).toBeNull()
    expect(screen.queryByTestId('wb-save-errors')).toBeNull()
    const workflowGetsAfter = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url, options]) => url === workflowUrl && (!(options as RequestInit | undefined)?.method || (options as RequestInit).method === 'GET')).length
    expect(workflowGetsAfter).toBe(workflowGetsBefore)
  })

  it('English locale covers the Dashboard Workbench header, track controls, and canonical phases', async () => {
    window.localStorage.setItem('tenon-dashboard-lang', 'en')
    renderView()
    await screen.findByTestId('wb-step-draft')

    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('Current workflow')
    expect(screen.getByText('Run track')).toBeInTheDocument()
    expect(screen.getByTestId('wb-track-pm')).toHaveTextContent('Product')
    expect(screen.getByTestId('wb-track-frontend')).toHaveTextContent('Frontend')
    expect(screen.getByTestId('wb-track-backend')).toHaveTextContent('Backend')
    expect(screen.queryByText('当前工作流')).toBeNull()
    expect(screen.queryByText('运行轨道')).toBeNull()

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    const open = await screen.findByTestId('wb-step-open')
    expect(open).toHaveTextContent('Open')
    expect(open).not.toHaveTextContent('立项')
    expect(screen.getByTestId('wb-workflow-copy')).toHaveTextContent('Create editable copy')

    const settingsToggle = screen.getByTestId('wb-track-settings-toggle')
    settingsToggle.focus()
    fireEvent.click(settingsToggle)
    const trackSettings = screen.getByTestId('wb-track-settings-panel')
    expect(trackSettings).toHaveTextContent('Work tracks')
    expect(trackSettings).toHaveTextContent('Automatic routing')
    expect(trackSettings).not.toHaveTextContent('工作轨道')
    expect(trackSettings).not.toHaveTextContent('自动分配')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('wb-track-settings-panel')).toBeNull()
    expect(settingsToggle).toHaveFocus()

    const governanceTrigger = screen.getByTestId('wb-governance-open')
    governanceTrigger.focus()
    fireEvent.click(governanceTrigger)
    expect(screen.getByRole('dialog', { name: 'Runtime governance' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(governanceTrigger).toHaveFocus()
  })

  it('unifies Workflow identity/actions and project Track controls into one ordered two-row surface', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')

    const controls = screen.getByTestId('wb-controls')
    const workflowRow = within(controls).getByTestId('wb-workflow-controls')
    const trackRow = within(controls).getByTestId('wb-track-context')
    expect(workflowRow.compareDocumentPosition(trackRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trackRow).not.toHaveClass('rounded-2xl', 'border', 'shadow-sm')

    expect(within(workflowRow).getByTestId('wb-wf-btn')).toHaveClass('min-h-10')
    expect(within(workflowRow).getByTestId('wb-workflow-new')).toHaveClass('min-h-10')
    expect(within(workflowRow).getByTestId('wb-governance-open')).toHaveClass('inline-flex', 'items-center', 'whitespace-nowrap')
    expect(within(trackRow).getByTestId('wb-track-pm')).toHaveClass('min-h-10')
    expect(within(trackRow).getByTestId('wb-track-control-row')).toHaveClass('[&_[data-testid=wb-track-settings-toggle]]:min-h-10')
  })

  it('主视图就是工作流编辑器；不再经过“查看与编辑”二层浮层，阶段内添加 Skill 才打开编排浮层', async () => {
    renderView({}, false)
    await screen.findByTestId('wb-step-draft')

    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('当前工作流')
    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('release-train')
    expect(screen.queryByTestId('wb-workflow-edit')).toBeNull()
    expect(screen.queryByTestId('wb-advanced-orchestration')).toBeNull()
    expect(screen.getByTestId('step-policy-editor')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '配置 Skill 依赖' })).toBeNull()

    fireEvent.click(screen.getByTestId('wb-lane-sk-add-draft'))
    expect(await screen.findByTestId('wb-skill-orchestration')).toBeInTheDocument()
  })

  it('编排画布没有旧 wb-stage 动画锚点时不向 GSAP 传空目标，控制台保持干净', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    renderView()
    await screen.findByTestId('wb-step-draft')

    expect(warn.mock.calls.flat().join('\n')).not.toContain('GSAP target')
  })

  /**
   * v11 P0 断言迁移：主列的流程带（StepperRail）换成编排画布（OrchestrationBoard）后，
   * 本用例的「表现层」断言随之改写——被测行为不变（阶段数/名称/复核语义/技能与产出来自 def），
   * 变的是渲染形态：
   *   · 「3 技能 / 1 产出」摘要计数 → 画布直接把技能卡与产出 chip 逐条列出（计数不再是唯一信息）；
   *   · 技能 chips 的「前 2 个短名 + 截断 +1」→ 全名逐条直出。**这正是本轮硬约束要消灭的反例**
   *     （用户明确要求任何名称不换行不省略），故此处反向钉住：全名在、`+1` 截断计数不在。
   * 零截断的完整守门在 OrchestrationBoard.test.tsx（含变异测试），此处只钉住接线后的真实渲染。
   */
  it('按 /api/workflows 数据渲染阶段导航；所选阶段的 Skill 与产出进入唯一纵向编辑器', async () => {
    renderView()
    const draft = await screen.findByTestId('wb-step-draft')
    // 泳道序号：画布内技能卡也带 1..n 序号，故按泳道头的可及名定位，避免 getByText('1') 多义
    expect(within(draft).getByRole('button', { name: '选择阶段 起草' })).toHaveTextContent('1')
    expect(within(draft).getByText('起草')).toBeInTheDocument()

    // 技能：def 的 3 个技能逐条全名直出（不短名化、不截断）。
    // 注：带命名空间的名字在 DOM 里拆成两个 span（前缀弱化着色），视觉仍是完整一行，
    // 故按卡片的 textContent 断言全名，而非 getByText（后者不跨元素匹配）。
    expect(screen.getByTestId('wb-lane-sk-draft-superpowers:tdd')).toHaveTextContent('superpowers:tdd')
    expect(screen.getByTestId('wb-lane-sk-draft-impeccable')).toHaveTextContent('impeccable')
    expect(screen.getByTestId('wb-lane-sk-draft-browser-qa')).toHaveTextContent('browser-qa')
    // 旧板的截断计数必须绝迹（硬约束回归守门）
    expect(within(draft).queryByText('+1')).toBeNull()

    // 产出：当前 draft 1 个；切到 ship 后，同一编辑器原位显示 ship 的 2 个产出。
    expect(within(screen.getByTestId('wb-lane-outs-draft')).getByText('阶段草稿')).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId('wb-step-ship')).getByRole('button', { name: '选择阶段 发布' }))
    const shipOuts = screen.getByTestId('wb-lane-outs-ship')
    expect(within(shipOuts).getByText('发布说明')).toBeInTheDocument()
    expect(within(shipOuts).getByText('代码版本')).toBeInTheDocument()
    expect(screen.getByTestId('wb-timeline-node-codex')).toHaveTextContent('此阶段尚未配置 Skill')

    // 总览轨道不重复渲染复核徽标；复核语义收口在所选阶段的详情中。
    expect(screen.queryByTestId('wb-flow-gate-review')).toBeNull()
    expect(screen.queryByTestId('wb-flow-gate-draft')).toBeNull()
    fireEvent.click(within(screen.getByTestId('wb-step-review')).getByRole('button', { name: '选择阶段 人工复核' }))
    expect(screen.getByTestId('wb-selected-gate')).toHaveTextContent('复核门')

    // #2（2026-07-15）：卡间连接件的转换事件名小字已退役（会被相邻卡挡住、非必要）
    expect(screen.queryByText('submitted')).toBeNull()
    expect(screen.queryByText('approved')).toBeNull()
  })

  it('「+ 添加阶段」只在可编辑 workflow 出现；default 不渲染假入口', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.getByRole('button', { name: '+ 添加阶段' })).toBeEnabled()

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    await screen.findByTestId('wb-step-open')
    expect(screen.queryByRole('button', { name: '+ 添加阶段' })).toBeNull()
    expect(screen.queryByTestId('wb-default-copy-cue')).toBeNull()
    expect(screen.getByTestId('wb-workflow-copy')).toHaveTextContent('创建可编辑副本')
  })
})

describe('WorkbenchView v3 Workflow 生命周期', () => {
  it('新建：提交受治理的 canonical OpenSpec 七阶段定义，成功后立即切到新 workflow', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')

    fireEvent.click(screen.getByTestId('wb-workflow-new'))
    const dialog = await screen.findByTestId('wb-workflow-create-dialog')
    fireEvent.change(within(dialog).getByLabelText('Workflow 名称'), { target: { value: 'ops-flow' } })
    fireEvent.click(within(dialog).getByTestId('wb-workflow-create-confirm'))

    await screen.findByTestId('wb-step-open')
    expect(screen.getByTestId('wb-step-archive')).toBeInTheDocument()
    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('ops-flow')
    expect(screen.getByTestId('step-policy-editor')).toBeInTheDocument()
    expect(screen.getByTestId('wb-save')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-ro-pill')).toBeNull()
    const post = vi.mocked(fetch).mock.calls.find(([url, opts]) => url === '/api/workflows/ops-flow' && opts?.method === 'POST')
    expect(post).toBeDefined()
    const body = JSON.parse(String(post?.[1]?.body)) as WbWorkflowDef & { root: string }
    expect(body).toMatchObject({ root: ROOT, name: 'ops-flow', openspecContract: 'required' })
    expect(body.steps.map((step) => step.id)).toEqual(['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'])
    expect(body.steps.find((step) => step.id === 'explore')?.gate).toBe('review')
    expect(body.steps.find((step) => step.id === 'explore')?.skills.map((skill) => skill.id)).toContain('brainstorming')
    expect(body.steps.find((step) => step.id === 'spec')?.skills.map((skill) => skill.id)).toContain('writing-plans')
    expect(body.steps.find((step) => step.id === 'verify')?.skills.map((skill) => skill.id)).toContain('verification-before-completion')
  })

  it('英文界面新建默认七阶段 Workflow 时，写入当前语言标签而不是中文默认值', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-workflow-new'))
    const dialog = await screen.findByTestId('wb-workflow-create-dialog')
    fireEvent.change(within(dialog).getByLabelText('Workflow name'), { target: { value: 'english-flow' } })
    fireEvent.click(within(dialog).getByTestId('wb-workflow-create-confirm'))

    await screen.findByTestId('wb-step-open')
    const post = vi.mocked(fetch).mock.calls.find(([url, opts]) => url === '/api/workflows/english-flow' && opts?.method === 'POST')
    const body = JSON.parse(String(post?.[1]?.body)) as WbWorkflowDef
    expect(body.steps.map((step) => step.label)).toEqual(['Open', 'Explore', 'Spec', 'Build', 'Verify', 'Ship', 'Archive'])
    expect(body.steps.map((step) => step.label).join('')).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('结构合法但 name 错配的 Workflow 响应按无效响应拒绝，不加载到请求名下', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}` && (!opts?.method || opts.method === 'GET')) {
        return new Response(JSON.stringify({ ...RELEASE_TRAIN, name: 'another-workflow' }), { status: 200 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch
    renderView()
    expect(await screen.findByRole('alert')).toHaveTextContent('服务端响应格式无效')
    expect(screen.queryByTestId('wb-step-draft')).toBeNull()
  })

  it('新建：Workflow 名称支持中文并按真实名称写入 URL 与定义', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')

    fireEvent.click(screen.getByTestId('wb-workflow-new'))
    const dialog = await screen.findByTestId('wb-workflow-create-dialog')
    const input = within(dialog).getByLabelText('Workflow 名称')
    fireEvent.change(input, { target: { value: '发布验收流程' } })
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(within(dialog).queryByText(/仅允许字母/)).toBeNull()
    fireEvent.click(within(dialog).getByTestId('wb-workflow-create-confirm'))

    await waitFor(() => expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('发布验收流程'))
    const post = vi.mocked(fetch).mock.calls.find(([url, opts]) => url === '/api/workflows/%E5%8F%91%E5%B8%83%E9%AA%8C%E6%94%B6%E6%B5%81%E7%A8%8B' && opts?.method === 'POST')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ name: '发布验收流程' })
  })

  it('复制：完整保留当前 workflow 定义，只替换名称', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')

    fireEvent.click(screen.getByTestId('wb-workflow-copy'))
    const dialog = await screen.findByTestId('wb-workflow-copy-dialog')
    const input = within(dialog).getByLabelText('Workflow 名称')
    expect(input).toHaveValue('release-train-copy')
    fireEvent.change(input, { target: { value: 'release-safe' } })
    fireEvent.click(within(dialog).getByTestId('wb-workflow-copy-confirm'))

    await waitFor(() => expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('release-safe'))
    const post = vi.mocked(fetch).mock.calls.find(([url, opts]) => url === '/api/workflows/release-safe' && opts?.method === 'POST')
    const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>
    expect(body.name).toBe('release-safe')
    expect(body.steps).toEqual(RELEASE_TRAIN.steps)
  })

  it.each([
    ['empty object', () => new Response(JSON.stringify({}), { status: 200 })],
    ['negative envelope', () => new Response(JSON.stringify({ ok: false }), { status: 200 })],
    ['non-JSON body', () => new Response('not-json', { status: 200 })],
  ])('新建收到畸形 2xx %s：保留对话框和原 workflow，并显示当前语言无效响应', async (_label, response) => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/workflows/malformed-flow' && opts?.method === 'POST') return response()
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-workflow-new'))
    const dialog = await screen.findByTestId('wb-workflow-create-dialog')
    fireEvent.change(within(dialog).getByLabelText('Workflow 名称'), { target: { value: 'malformed-flow' } })
    fireEvent.click(within(dialog).getByTestId('wb-workflow-create-confirm'))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('服务端响应格式无效')
    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('release-train')
    expect(screen.getByTestId('wb-step-draft')).toBeInTheDocument()
    expect(workflowDefs).not.toHaveProperty('malformed-flow')
    expect(within(dialog).getByLabelText('Workflow 名称')).toHaveValue('malformed-flow')
  })

  it('删除：确认后走带 token 的 DELETE，成功后从列表移除并切回 default', async () => {
    window.__TENON_DASHBOARD_TOKEN__ = 'studio-token'
    renderView()
    await screen.findByTestId('wb-step-draft')

    fireEvent.click(screen.getByTestId('wb-workflow-delete'))
    const dialog = await screen.findByTestId('wb-workflow-delete-dialog')
    fireEvent.click(within(dialog).getByTestId('wb-workflow-delete-confirm'))

    await screen.findByTestId('wb-step-open')
    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('default')
    const remove = vi.mocked(fetch).mock.calls.find(([url, opts]) =>
      url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}` && opts?.method === 'DELETE')
    expect(remove?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer studio-token' }))
  })

  it.each([
    ['empty object', () => new Response(JSON.stringify({}), { status: 200 })],
    ['negative envelope', () => new Response(JSON.stringify({ ok: false }), { status: 200 })],
    ['non-JSON body', () => new Response('not-json', { status: 200 })],
  ])('删除：HTTP 200 %s 仍视为无效响应并保留当前 workflow', async (_label, makeResponse) => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}` && opts?.method === 'DELETE') {
        return makeResponse()
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-workflow-delete'))
    const dialog = await screen.findByTestId('wb-workflow-delete-dialog')
    fireEvent.click(within(dialog).getByTestId('wb-workflow-delete-confirm'))

    expect(await within(dialog).findByTestId('wb-workflow-delete-error')).toHaveTextContent('服务端响应格式无效')
    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('release-train')
    expect(screen.getByTestId('wb-step-draft')).toBeInTheDocument()
    expect(workflowDefs['release-train']).toBeDefined()
  })

  it('删除被引用 workflow：409 引用来源逐条展示，定义与当前选择保持不变', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}` && opts?.method === 'DELETE') {
        return new Response(JSON.stringify({
          ok: false,
          code: 'WORKFLOW_REFERENCED',
          workflow: 'release-train',
          references: [
            { kind: 'loop-binding', source: 'loop:release-loop' },
            { kind: 'track-default', source: 'track:frontend.workflow.default' },
          ],
        }), { status: 409 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-workflow-delete'))
    const dialog = await screen.findByTestId('wb-workflow-delete-dialog')
    fireEvent.click(within(dialog).getByTestId('wb-workflow-delete-confirm'))

    expect(await within(dialog).findByTestId('wb-workflow-delete-error')).toHaveTextContent('release-loop')
    expect(within(dialog).getByTestId('wb-workflow-delete-error')).toHaveTextContent('frontend.workflow.default')
    expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('release-train')
    expect(screen.getByTestId('wb-step-draft')).toBeInTheDocument()
  })

  it('English workflow delete failure masks server-authored Chinese message and reference details', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}` && opts?.method === 'DELETE') {
        return new Response(JSON.stringify({
          ok: false,
          code: 'WORKFLOW_REFERENCED',
          workflow: 'release-train',
          error: '该流程仍被生产轨道引用',
          references: [{ kind: 'track-default', source: '前端默认流程' }],
        }), { status: 409 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-workflow-delete'))
    const dialog = await screen.findByTestId('wb-workflow-delete-dialog')
    fireEvent.click(within(dialog).getByTestId('wb-workflow-delete-confirm'))

    const alert = await within(dialog).findByTestId('wb-workflow-delete-error')
    expect(alert).toHaveTextContent('This workflow is still referenced and was not deleted.')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('删除错误信封字段类型畸形时显示无效响应，不把对象或伪引用交给 React 渲染', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}` && opts?.method === 'DELETE') {
        return new Response(JSON.stringify({
          ok: false,
          error: {},
          references: [{ kind: 42, source: {} }],
          blockers: 'not-an-array',
        }), { status: 409 })
      }
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-workflow-delete'))
    const dialog = await screen.findByTestId('wb-workflow-delete-dialog')
    fireEvent.click(within(dialog).getByTestId('wb-workflow-delete-confirm'))

    const alert = await within(dialog).findByTestId('wb-workflow-delete-error')
    expect(alert).toHaveTextContent('服务端响应格式无效')
    expect(alert).not.toHaveTextContent('[object Object]')
  })

  it('default 只读：复制入口并入顶部操作区，不再插入突兀说明横幅', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    await screen.findByTestId('wb-step-open')

    expect(screen.queryByTestId('wb-default-copy-cue')).toBeNull()
    expect(screen.getByTestId('wb-workflow-copy')).toHaveTextContent('创建可编辑副本')
    expect(screen.getByTestId('wb-workflow-copy')).toBeEnabled()
    expect(screen.queryByTestId('wb-workflow-delete')).toBeNull()
  })

  it('轨道是项目级运行配置：自定义与 default workflow 都能选择并进入轨道设置', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.getByTestId('wb-track-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('wb-track-settings-toggle')).toBeEnabled()

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    await screen.findByTestId('wb-step-open')
    expect(screen.getByTestId('wb-track-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('wb-track-settings-toggle')).toBeEnabled()
  })

  it('Track 草稿 dirty 上报不会因父组件重渲染形成 effect 循环', async () => {
    const onDirtyChange = vi.fn()
    renderView({ onDirtyChange })
    await screen.findByTestId('wb-step-draft')

    fireEvent.click(screen.getByTestId('wb-track-settings-toggle'))
    fireEvent.click(screen.getByTestId('wb-track-edit-pm'))
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Product draft' } })

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
    expect(onDirtyChange.mock.calls.filter(([dirty]) => dirty === true)).toHaveLength(1)
  })
})

describe('WorkbenchView 选中态（验收②）', () => {
  /**
   * P4 迁移：原名「选中态与编辑区占位」。被测行为——「默认选中第一阶段、点卡换选中态、
   * 同一时刻只有一列被选中」——完全没变；变的是**选中态读数落在哪**：sheet 时代由
   * wb-editor-stage（StepEditor 卡头的阶段 id 文本）承载，画布时代由泳道自己的
   * aria-current="step" + data-state="current" 承载（OrchestrationBoard.tsx:1079-1081）。
   * 两个属性都断：aria-current 是无障碍契约，data-state 是样式承载（v10b 迁移后的既定纪律），
   * 只断一个另一个悄悄掉了不会红。
   */
  it('默认选中第一阶段；点卡切换 aria-current/data-state，且同时只有一列被选中', async () => {
    renderView()
    const draft = await screen.findByTestId('wb-step-draft')
    expect(draft).toHaveAttribute('aria-current', 'step')
    expect(draft).toHaveAttribute('data-state', 'current')
    expect(screen.getByTestId('wb-step-ship')).not.toHaveAttribute('aria-current')

    fireEvent.click(screen.getByTestId('wb-step-ship'))
    const ship = screen.getByTestId('wb-step-ship')
    expect(ship).toHaveAttribute('aria-current', 'step')
    expect(ship).toHaveAttribute('data-state', 'current')
    expect(draft).not.toHaveAttribute('aria-current')
    expect(draft).not.toHaveAttribute('data-state', 'current')
  })
})

describe('WorkbenchView workflow 下拉（验收①/②）', () => {
  it('遵循 ARIA menu 键盘模式：打开聚焦当前项、方向/Home/End 漫游、Escape 回触发器', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const trigger = screen.getByTestId('wb-wf-btn')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('wb-wf-item-release-train')).toHaveFocus())

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(screen.getByTestId('wb-wf-item-default')).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Home' })
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    expect(screen.getAllByRole('menuitem').at(-1)).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('按钮显示当前 workflow 与阶段数；切到 default 渲染 7 个完整阶段名且总览不叠加复核徽标', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const btn = screen.getByTestId('wb-wf-btn')
    expect(btn).toHaveTextContent('release-train')
    expect(btn).toHaveTextContent('3 阶段')

    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const defaultItem = await screen.findByTestId('wb-wf-item-default')
    expect(defaultItem).toHaveTextContent('7 阶段')

    fireEvent.click(defaultItem)
    await screen.findByTestId('wb-step-open')
    for (const p of ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']) {
      expect(screen.getByTestId(`wb-step-${p}`)).toBeInTheDocument()
    }
    // 复核状态不挤占阶段轨道；阶段名完整展示，不靠省略号腾位置。
    for (const p of ['explore', 'spec', 'verify']) {
      expect(screen.queryByTestId(`wb-flow-gate-${p}`)).toBeNull()
    }
    expect(screen.queryByText('离开前复核')).toBeNull()
    expect(within(screen.getByTestId('wb-step-explore')).getByText('调研')).not.toHaveClass('truncate')
    for (const [phase, output] of [['explore', '调研文档'], ['spec', '实施计划'], ['build', '构建基线'], ['verify', '验证报告']] as const) {
      fireEvent.click(within(screen.getByTestId(`wb-step-${phase}`)).getByRole('button', { name: new RegExp(`选择阶段`) }))
      expect(within(screen.getByTestId(`wb-lane-outs-${phase}`)).getByText(output)).toBeInTheDocument()
    }
    expect(btn).toHaveTextContent('7 阶段')
  })
})

describe('WorkbenchView 右栏摘要（验收③前半）', () => {
  it('摘要四行：阶段 3 / 复核门 1 / 技能 3（跨阶段去重）/ 钩子占位', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const side = await openGovernance()
    expect(within(side).getByTestId('wb-sum-stages')).toHaveTextContent('3')
    expect(within(side).getByTestId('wb-sum-gates')).toHaveTextContent('1')
    expect(within(side).getByTestId('wb-sum-skills')).toHaveTextContent('3')
    expect(within(side).getByTestId('wb-sum-hooks')).toHaveTextContent('—')
  })
})

/**
 * v6 T13 断言迁移登记：「流程预览」「预演」两组用例随 GSAP 假预演整体退役——
 * reduced-motion 直达终态类断言无迁移目标(「最近流转」为静态真实事件列表,无循环动画);
 * gate 语义由所选阶段详情接管；节点序断言由下方「最近流转」
 * describe 的真实事件序断言接管。
 */
// ── T13：阶段编辑区（StepEditor 挂载 + 保存接线 + 脏守卫 + default 只读）──

/** 取最近一次 POST 保存调用（url + 解析后的 body）；无 POST → null。 */
function lastSaveCall(): { url: string; body: unknown } | null {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
  const post = [...calls].reverse().find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
  if (!post) return null
  return { url: String(post[0]), body: JSON.parse(String((post[1] as RequestInit).body)) }
}

describe('WorkbenchView T13 编辑 → 保存（验收①）', () => {
  it('挂载只读运行时策略摘要且不改动 Workflow 草稿', async () => {
    const runtimePolicy: WorkflowPolicyRulesSnapshot = {
      schema: 'workflow-policy/v1',
      configured: {
        status: 'available',
        workflowFingerprint: 'a'.repeat(64),
        decomposition: { version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced', max_items: 16, max_depth: 2, auto_when: [], ask_when: [] },
        interaction: { version: 'v1', mode: 'interactive' },
      },
      frozen: {
        workflowFingerprint: 'b'.repeat(64),
        decomposition: { version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced', max_items: 16, max_depth: 2, auto_when: [], ask_when: [] },
        interaction: { version: 'v1', mode: 'interactive' },
        workflowCeiling: { status: 'valid', grants: [] },
      },
      effective: { status: 'available', grants: [], denials: [] },
      drift: { status: 'current', fingerprintChanged: false, policyChanged: false },
    }
    const snapshot = makeSnapshot([makeProject(ROOT, [makeChange('runtime-summary-change', 'build', {
      fields: { workflow: 'release-train' },
      updated_at: '2026-08-08T09:00:00Z',
      workflowRules: { ...DEFAULT_WORKFLOW_RULES, policy: runtimePolicy },
    })])])
    const before = JSON.stringify(snapshot)

    renderView({ snapshot })
    await screen.findByTestId('workflow-policy-runtime-summary')
    await screen.findByTestId('workflow-policy-editor')

    expect(screen.getByTestId('workflow-policy-runtime-source-change')).toHaveTextContent('runtime-summary-change')
    expect(screen.getByTestId('workflow-policy-runtime-configured-decomposition')).toHaveTextContent('关闭')
    expect(screen.getByTestId('workflow-policy-runtime-configured-interaction')).toHaveTextContent('逐项互动')
    expect(screen.getByTestId('workflow-policy-runtime-frozen-ceiling-empty')).toHaveTextContent('冻结权限上限未授予任何动作')
    expect(screen.getByLabelText('拆分模式')).toHaveValue('off')
    expect(screen.getByLabelText('互动模式')).toHaveValue('interactive')
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
    expect(lastSaveCall()).toBeNull()
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('加载后未编辑：无「未保存」chip，保存钮 disabled（上轮 minor 收口项）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
    expect(screen.getByTestId('wb-save')).toBeDisabled()
  })

  it('完整 Step IR 编辑器已接到唯一 def 草稿：Prompt 修改后随保存 payload 写回，未触碰字段不丢', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByRole('button', { name: '执行指令' }))
    fireEvent.change(screen.getByLabelText('Codex 阶段指令'), { target: { value: 'Implement and run browser E2E.' } })
    expect(screen.getByTestId('wb-dirty')).toHaveTextContent('未保存')
    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toHaveTextContent('已保存'))
    expect(screen.getByTestId('wb-save-ok')).toHaveAttribute('role', 'status')
    const body = lastSaveCall()?.body as {
      decomposition: unknown
      interaction: unknown
      steps: Array<Record<string, unknown>>
    }
    expect(body.decomposition).toEqual({
      version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced',
      max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
    })
    expect(body.interaction).toEqual({ version: 'v1', mode: 'interactive' })
    expect(body.steps[0]).toEqual({ ...RELEASE_TRAIN.steps[0], prompt: 'Implement and run browser E2E.' })
    expect(body.steps[1]).toEqual(RELEASE_TRAIN.steps[1])
    expect(body.steps[2]).toEqual(RELEASE_TRAIN.steps[2])
  })

  it('策略编辑保持拆分与互动正交，并通过完整 Workflow POST 保存', async () => {
    renderView()
    await screen.findByTestId('workflow-policy-editor')

    fireEvent.change(screen.getByLabelText('拆分模式'), { target: { value: 'auto-safe' } })
    fireEvent.change(screen.getByLabelText('互动模式'), { target: { value: 'recommended-defaults' } })
    fireEvent.click(screen.getByLabelText('跨组件边界'))
    fireEvent.click(screen.getByRole('button', { name: '保存策略' }))

    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toHaveTextContent('已保存'))
    const body = lastSaveCall()?.body as {
      decomposition: { mode: string; target: string; auto_when: string[] }
      interaction: { mode: string }
      steps: unknown[]
    }
    expect(body.decomposition).toMatchObject({
      mode: 'auto-safe',
      target: 'work-items',
      auto_when: ['cross-component-boundary'],
    })
    expect(body.interaction).toEqual({ version: 'v1', mode: 'recommended-defaults' })
    expect(body.steps).toHaveLength(RELEASE_TRAIN.steps.length)
  })

  it('仅修改 Review 次数也启用策略保存并持久化', async () => {
    renderView()
    await screen.findByTestId('workflow-policy-editor')

    const savePolicy = screen.getByRole('button', { name: '保存策略' })
    expect(savePolicy).toBeDisabled()
    fireEvent.change(screen.getByLabelText('最大 Review 次数'), { target: { value: '3' } })
    expect(savePolicy).toBeEnabled()
    fireEvent.click(savePolicy)

    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toHaveTextContent('已保存'))
    expect((lastSaveCall()?.body as { reviewBudget?: unknown }).reviewBudget)
      .toEqual({ version: 'v1', max_attempts: 3 })
  })

  it('策略取消只恢复策略字段，并保留其他 Workflow 草稿', async () => {
    renderView()
    await screen.findByTestId('workflow-policy-editor')

    editLaneName('draft', '未保存阶段')
    fireEvent.change(screen.getByLabelText('拆分模式'), { target: { value: 'auto-safe' } })
    fireEvent.change(screen.getByLabelText('互动模式'), { target: { value: 'afk' } })
    fireEvent.click(screen.getByRole('button', { name: '取消策略修改' }))

    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('未保存阶段')
    expect(screen.getByLabelText('拆分模式')).toHaveValue('off')
    expect(screen.getByLabelText('互动模式')).toHaveValue('interactive')
    expect(screen.getByTestId('wb-dirty')).toHaveTextContent('未保存')
  })

  it('策略 Escape 只恢复策略字段，并保留其他 Workflow 草稿', async () => {
    renderView()
    await screen.findByTestId('workflow-policy-editor')

    editLaneName('draft', 'Escape 后仍保留')
    fireEvent.click(screen.getByTestId('wb-lane-gate-sw-draft'))
    fireEvent.change(screen.getByLabelText('拆分模式'), { target: { value: 'require-review' } })
    fireEvent.keyDown(screen.getByTestId('workflow-policy-form'), { key: 'Escape' })

    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('Escape 后仍保留')
    expect(screen.getByTestId('wb-lane-gate-sw-draft')).toBeChecked()
    expect(screen.getByLabelText('拆分模式')).toHaveValue('off')
    expect(screen.getByLabelText('拆分模式')).toHaveFocus()
    expect(screen.getByTestId('wb-dirty')).toHaveTextContent('未保存')
  })

  it('仅有非策略字段未保存时禁用策略取消', async () => {
    renderView()
    await screen.findByTestId('workflow-policy-editor')

    editLaneName('draft', '阶段草稿')

    expect(screen.getByRole('button', { name: '取消策略修改' })).toBeDisabled()
  })

  it('Workflow 策略读取失败可原地重试，成功后焦点与编辑面恢复', async () => {
    const baseFetch = global.fetch
    let attempts = 0
    global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}`) {
        attempts += 1
        if (attempts === 1) return new Response(JSON.stringify({ error: 'temporary' }), { status: 503 })
      }
      return baseFetch(url, options)
    }) as unknown as typeof fetch

    renderView()
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('拆分模式')).toHaveValue('off')
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('编辑名称后保存：隐藏的 guard、inputs 与 outputs 均原样透传', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', '初稿')
    expect(screen.getByTestId('wb-dirty')).toHaveTextContent('未保存')
    expect(screen.getByTestId('wb-save')).toBeEnabled()

    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toHaveTextContent('已保存'))

    const save = lastSaveCall()
    expect(save?.url).toBe('/api/workflows/release-train')
    // 页面不再让用户手工声明产出或守卫；保存别的字段时，这些运行契约仍不能丢。
    expect(save?.body).toEqual({
      ...RELEASE_TRAIN,
      decomposition: {
        version: 'v1', mode: 'off', target: 'work-items', strategy: 'balanced',
        max_items: 16, max_depth: 2, auto_when: [], ask_when: [],
      },
      interaction: { version: 'v1', mode: 'interactive' },
      reviewBudget: { version: 'v1', max_attempts: 2 },
      steps: [
        { ...RELEASE_TRAIN.steps[0], label: '初稿' },
        RELEASE_TRAIN.steps[1],
        RELEASE_TRAIN.steps[2],
      ],
      root: ROOT,
    })
    // 保存成功后脏状态清除、保存钮回到 disabled
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
    expect(screen.getByTestId('wb-save')).toBeDisabled()
  })

  it.each([
    ['empty object', () => new Response(JSON.stringify({}), { status: 200 })],
    ['negative envelope', () => new Response(JSON.stringify({ ok: false }), { status: 200 })],
    ['non-JSON body', () => new Response('not-json', { status: 200 })],
  ])('保存收到畸形 2xx %s：保持 dirty 和草稿，并显示当前语言无效响应', async (_label, response) => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/workflows/release-train' && opts?.method === 'POST') return response()
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', 'Uncommitted draft')
    fireEvent.click(screen.getByTestId('wb-save'))

    expect(await screen.findByTestId('wb-save-errors')).toHaveTextContent('服务端响应格式无效')
    expect(screen.getByTestId('wb-dirty')).toBeInTheDocument()
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('Uncommitted draft')
    expect(screen.queryByTestId('wb-save-ok')).toBeNull()
    expect(screen.getByTestId('wb-save')).toBeEnabled()
  })

  it('运行时产出只读：不提供人工增删，保存其他字段仍保留原始类型', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.queryByTestId('wb-lane-out-add-draft')).toBeNull()
    expect(screen.getByTestId('wb-lane-outs-draft')).toHaveTextContent('运行 Agent 显式登记，系统校验后展示')
    editLaneName('draft', '初稿')

    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toHaveTextContent('已保存'))

    const outputs = (lastSaveCall()?.body as { steps: { id: string; outputs: unknown }[] }).steps.find(
      (s) => s.id === 'draft',
    )!.outputs
    expect(outputs).toEqual([
      { field: 'draft_doc', type: 'file_path' },
    ])
  })

  /**
   * P4 迁移：驱动点换画布就地编。被测行为不变——**同一份 def 状态被多个消费方同时消费**：
   * 改名 → 泳道自己的展示名跟着变；开门 → 右栏摘要的「复核门」计数联动 1→2。
   * 注：sheet 时代「编辑区改、阶段卡跟着变」是跨组件联动；画布时代编辑入口与展示名同在泳道内，
   * 故这里把**右栏摘要计数**这条真正的跨消费方联动看得更重（它才是「一份状态、多处消费」的证据），
   * 门开关与摘要分居主列/右栏两处，联动断了当场红。
   */
  it('编辑联动：改名后阶段泳道显示新名；开复核门 → 右栏摘要计数联动（同一份 def 状态的多个消费方）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', '初稿')
    expect(within(screen.getByTestId('wb-step-draft')).getByText('初稿')).toBeInTheDocument()
    expect(screen.getByTestId('wb-step-draft')).toHaveTextContent('初稿')
    // 开复核门 → 治理面板摘要读到 2（review 本有门，draft 再开一个）
    fireEvent.click(screen.getByTestId('wb-lane-gate-sw-draft'))
    const side = await openGovernance()
    expect(within(side).getByTestId('wb-sum-gates')).toHaveTextContent('2')
    // 复核门真实写入，但总览轨道仍保持干净；详情承担状态解释。
    expect(screen.queryByTestId('wb-flow-gate-draft')).toBeNull()
    expect(screen.getByTestId('wb-selected-gate')).toHaveTextContent('复核门')
  })

  it('保存被 kernel validate 拒（400 errors[]）→ 错误原文上抛展示，已编辑内容不丢', async () => {
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
      }
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify(RELEASE_TRAIN), { status: 200 })
      }
      if (url === '/api/workflows/release-train' && opts?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false, errors: ["step 'draft': 循环依赖：a -> b -> a", "step 'draft' 的 skill id 'x y' 含非法字符（仅允许 a-zA-Z0-9_-）"] }), { status: 400 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch
    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', '初稿')
    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-errors')).toBeInTheDocument())
    expect(screen.getByTestId('wb-save-errors')).toHaveAttribute('role', 'alert')
    // kernel validate 错误逐条原文展示（不翻译、不吞并）
    expect(screen.getByText("step 'draft': 循环依赖：a -> b -> a")).toBeInTheDocument()
    expect(screen.getByText(/skill id 'x y' 含非法字符/)).toBeInTheDocument()
    // 编辑内容仍在、dirty 未被误清。P4 迁移：读数从 StepEditor 的受控 input value 换成
    // 泳道展示名（就地编提交后输入框收起，名字回到 wb-lane-name-* 按钮上——它的 textContent
    // 逐字等于全名，见 OrchestrationBoard.tsx:1202-1204）。
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('初稿')
    expect(screen.getByTestId('wb-dirty')).toBeInTheDocument()
  })

  it('英文界面保存凭证失效（401）→ 显示英文恢复指引且不泄漏中文产品文案', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
      }
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify(RELEASE_TRAIN), { status: 200 })
      }
      if (url === '/api/workflows/release-train' && opts?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', 'Draft')
    fireEvent.click(screen.getByTestId('wb-save'))

    const errors = await screen.findByTestId('wb-save-errors')
    expect(errors).toHaveTextContent('Your save credentials have expired. Refresh the page and try again.')
    expect(errors.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('保存 A 在途时切到 B：迟到响应不能覆盖 B 的快照、dirty 或保存状态', async () => {
    workflowDefs['z-next'] = {
      ...structuredClone(RELEASE_TRAIN),
      name: 'z-next',
      steps: RELEASE_TRAIN.steps.map((step, index) => index === 0 ? { ...step, label: 'Z draft' } : { ...step }),
    }
    const baseFetch = global.fetch
    let releaseSave!: (response: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { releaseSave = resolve })
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/workflows/release-train' && opts?.method === 'POST') return pendingSave
      return baseFetch(url, opts)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', 'A changed')
    fireEvent.click(screen.getByTestId('wb-save'))
    expect(screen.getByTestId('wb-workflow-new')).toBeDisabled()
    expect(screen.getByTestId('wb-workflow-copy')).toBeDisabled()
    expect(screen.getByTestId('wb-workflow-delete')).toBeDisabled()

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-z-next'))
    fireEvent.click(screen.getByRole('button', { name: '丢弃并切换' }))
    await waitFor(() => expect(screen.getByTestId('wb-wf-btn')).toHaveTextContent('z-next'))
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('Z draft')

    releaseSave(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await pendingSave
    await waitFor(() => expect(screen.getByTestId('wb-workflow-new')).toBeEnabled())
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
    expect(screen.queryByTestId('wb-save-ok')).toBeNull()
    expect(screen.getByTestId('wb-save')).toBeDisabled()
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('Z draft')
  })

  it('English workflow save validation failure masks endpoint-authored Chinese prose', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
      }
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify(RELEASE_TRAIN), { status: 200 })
      }
      if (url === '/api/workflows/release-train' && opts?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: false,
          errors: ["step 'draft': 循环依赖", '技能 ID 含非法字符'],
        }), { status: 400 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', 'Draft')
    fireEvent.click(screen.getByTestId('wb-save'))

    const errors = await screen.findByTestId('wb-save-errors')
    expect(errors).toHaveTextContent('Request failed (HTTP 400).')
    expect(errors.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })
})

// 验收②后半：保存成功 → (root,name) 规则缓存失效（同 旧画布编辑器测试（T18 已退役） 评审 P0-4 的
// RulesProbe 内容断言法：探针先灌 v1 缓存，保存后重挂探针，真重拉才能看到 v2 的 4 个 step）。
function RulesProbe(): JSX.Element {
  const { rules } = useWorkflowRules(ROOT, ['release-train'])
  return <div data-testid="rules-probe">{rules.get('release-train')?.steps.length ?? 0}</div>
}

describe('WorkbenchView T13 保存后规则缓存失效（验收②）', () => {
  it('保存成功 → 下一个 useWorkflowRules 消费方真重拉、看到保存后的新定义', async () => {
    const V2 = {
      ...RELEASE_TRAIN,
      steps: [...RELEASE_TRAIN.steps, { id: 'extra', label: '', gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions: [] }],
    }
    let saved = false
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
      }
      if (url === `/api/workflows/release-train?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify(saved ? V2 : RELEASE_TRAIN), { status: 200 })
      }
      if (url === '/api/workflows/release-train' && opts?.method === 'POST') {
        saved = true
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    // 1. 探针灌 v1 缓存（模拟收件箱/进度已消费过规则）
    const probe1 = render(<RulesProbe />)
    await waitFor(() => expect(screen.getByTestId('rules-probe').textContent).toBe('3'))
    probe1.unmount()

    // 2. 工作台编辑 + 保存成功（此后 server 端已是 v2）。P4 迁移：编辑驱动点换画布就地编，
    //    「保存成功 → invalidateWorkflowRules(root,name)」这条被测行为一字未变。
    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', '初稿')
    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toBeInTheDocument())

    // 3. 消费方再次挂载：缓存已失效 → 真重拉 → 看到 v2 的 4 个 step
    render(<RulesProbe />)
    await waitFor(() => expect(screen.getByTestId('rules-probe').textContent).toBe('4'))
  })
})

describe('WorkbenchView T13 脏守卫：切 workflow 确认 Dialog（验收③）', () => {
  it('把 workflow 草稿 dirty 精确上报给 App，保存成功后清除', async () => {
    const onDirtyChange = vi.fn()
    renderView({ onDirtyChange })
    await screen.findByTestId('wb-step-draft')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))

    editLaneName('draft', '待保存草稿')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))

    fireEvent.click(screen.getByTestId('wb-save'))
    await screen.findByTestId('wb-save-ok')
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('body portal 中的切换确认框仍能被 GSAP 定位且不产生空目标警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderView()
    await screen.findByTestId('wb-step-draft')
    editLaneName('draft', '初稿')

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))

    expect(screen.getByTestId('wb-switch-confirm').parentElement).toBe(document.body)
    expect(warn.mock.calls.flat().join('\n')).not.toContain('GSAP target')
  })

  it('dirty 时切 workflow → 共享 Dialog 确认；取消停留原 workflow，确认丢弃并切换', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    // P4 迁移：编辑驱动点换画布就地编——脏守卫四件套的被测行为一字未变。
    editLaneName('draft', '初稿')

    // 切到 default → 不直接切，先弹确认
    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    expect(screen.getByTestId('wb-switch-confirm')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-step-open')).toBeNull()

    // 取消：停留 release-train，编辑内容仍在（读数换泳道展示名，同「保存被拒」用例的登记）
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByTestId('wb-switch-confirm')).toBeNull()
    expect(screen.getByTestId('wb-lane-name-draft')).toHaveTextContent('初稿')

    // 再切 + 确认丢弃：真切到 default
    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    fireEvent.click(screen.getByRole('button', { name: '丢弃并切换' }))
    await screen.findByTestId('wb-step-open')
  })

  it('非 dirty 切 workflow 不弹确认（既有直切行为不回归）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    expect(screen.queryByTestId('wb-switch-confirm')).toBeNull()
    await screen.findByTestId('wb-step-open')
  })
})

describe('WorkbenchView T13 default workflow 只读态（验收④）', () => {
  /**
   * P4 迁移：原断言是「只读 pill + wb-ed-readonly 只读说明 + StepEditor 控件 disabled + 无保存钮」。
   * 被测行为——「default 是 manifest 只读镜像：前端不给任何编辑入口，不给保存钮」——完全没变，
   * 变的是**只读的表达方式**：sheet 时代是「控件在、但 disabled」；画布时代按契约验收清单
   * 「default 满屏 🔒：零拖手柄、零编辑入口、零假按钮」收严成 **入口根本不渲染**
   * （OrchestrationBoard 的 `回调 !== undefined && !readonly` 同款把关，组件 :618-627）。
   * 故 disabled 断言 → 「一个都不长」，并配**正向对照组**（同一批 testid 在自定义 workflow 下全在）
   * ——否则 testid 拼错/整块没渲染也会让这一串 queryBy…toBeNull 假绿。
   * wb-ed-readonly 的只读说明随 StepEditor 卸载失去渲染方，其对位是 wb-ro-pill（工具条）+
   * 逐列 wb-lane-lock-* 锁徽章 + 「+ 添加阶段」钮的 title（后者已由本文件 stepper describe 钉住）。
   */
  it('default：顶部只读态统一表达，阶段内零编辑入口、无保存钮', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    await screen.findByTestId('wb-step-open')

    expect(screen.getByTestId('wb-ro-pill')).toHaveTextContent('内置 · 只读')
    // 阶段导航保持只读；锁定原因统一放在顶部，避免每个阶段重复图标并与复核门重叠。
    for (const p of ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive']) {
      expect(screen.queryByTestId(`wb-lane-lock-${p}`)).toBeNull()
      expect(screen.queryByTestId(`wb-lane-grip-${p}`)).toBeNull()
    }
    expect(screen.queryByTestId('wb-lane-gate-sw-open')).toBeNull()
    expect(screen.queryByTestId('wb-lane-rm-open')).toBeNull()
    expect(screen.queryByTestId('wb-lane-out-add-open')).toBeNull()
    expect(screen.queryByTestId('wb-lane-sk-add-open')).toBeNull()
    expect(screen.queryByTestId('wb-mand-add-open')).toBeNull()
    expect(screen.getByTestId('wb-track-settings-toggle')).toBeEnabled()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByTestId('wb-add-stage-open')).toBeNull()
    expect(screen.queryByTestId('wb-save')).toBeNull()
    expect(screen.queryByTestId('wb-dirty')).toBeNull()
  })

  it('对照组：同一批编辑入口在自定义 workflow 下全部在场（证明上一条的反向断言有牙）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.getByTestId('wb-lane-name-draft')).toBeInTheDocument()
    expect(screen.getByTestId('wb-lane-gate-sw-draft')).toBeInTheDocument()
    expect(screen.getByTestId('wb-lane-rm-draft')).toBeInTheDocument()
    expect(screen.getByTestId('wb-lane-grip-draft')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-lane-out-add-draft')).toBeNull()
    expect(screen.getByTestId('wb-lane-sk-add-draft')).toBeInTheDocument()
    expect(screen.getByTestId('wb-add-stage-open')).toBeInTheDocument()
    expect(screen.getByTestId('wb-save')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-ro-pill')).toBeNull()
    expect(screen.queryByTestId('wb-lane-lock-draft')).toBeNull()
  })
})

// ── 验收反馈#4（补齐 T13 遗留缺口）：「+ 添加阶段」从禁用占位变真功能 ──
// 行为规格：自定义 workflow 非只读态可点 → 打开 Dialog（阶段名称 + 阶段 ID，ID 按名称自动
// slug 化、可再编辑覆盖，校验 ^[a-zA-Z0-9_-]+$ 且 steps 内唯一）→ 确认后在当前选中阶段之后
// 插入新 step（未选中则追加末尾）、线性语义接转换边、选中态切到新阶段、进入 dirty。

/** 最近一次保存调用的请求体（复用上方 lastSaveCall 的解析约定，narrow 出 WbWorkflowDef 形状）。 */
function lastSavedDef(): (WbWorkflowDef & { root: string }) | undefined {
  const call = lastSaveCall()
  return call?.body as (WbWorkflowDef & { root: string }) | undefined
}

/** rail 内按 DOM 顺序排列的阶段卡 id 序（v6 T11：StepperRail 重写为流程带后按
 *  data-testid 前缀取值，不再依赖 CSS 类名——「+ 添加阶段」按钮没有 data-testid，
 *  天然不会被此选择器命中，比原先绑 CSS 类名更不脆弱）。查询范围收在阶段卡横排容器
 *  `wb-stages`（v10b tailwind 迁移后类名不再是锚点，改 data-testid 寻址）内（而非整个
 *  workbench-view）：StepEditor.tsx 的编辑区外壳也用了 'wb-step-editor' 这个 testid，
 *  前缀恰好同款，不收范围会被一起命中，数出第 4 个「阶段」。 */
function railStepOrder(): string[] {
  const rail = screen.getByTestId('wb-stages')
  return Array.from(rail.querySelectorAll<HTMLElement>('[data-testid^="wb-step-"]')).map((el) => el.getAttribute('data-testid') ?? '')
}

function openAddStageDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: '+ 添加阶段' }))
  return screen.getByTestId('wb-add-stage')
}

describe('WorkbenchView 添加阶段 Dialog（验收反馈#4，补齐 T13 遗留缺口）', () => {
  it('点击打开 Dialog：阶段名称 + 阶段 ID 两个字段，ID 按名称自动 slug 化；手改 ID 后不再随名称联动', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const dialog = openAddStageDialog()
    expect(within(dialog).getByLabelText('阶段名称')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('阶段 ID')).toHaveValue('')

    fireEvent.change(within(dialog).getByLabelText('阶段名称'), { target: { value: 'QA Gate' } })
    expect(within(dialog).getByLabelText('阶段 ID')).toHaveValue('qa-gate')

    // 手改 ID 后视为「已接管」，后续改名称不再覆盖它
    fireEvent.change(within(dialog).getByLabelText('阶段 ID'), { target: { value: 'qa-custom' } })
    fireEvent.change(within(dialog).getByLabelText('阶段名称'), { target: { value: 'QA Gate Two' } })
    expect(within(dialog).getByLabelText('阶段 ID')).toHaveValue('qa-custom')
  })

  it('ID 校验：非法字符报错、确认钮禁用；改回合法字符后错误消失、可确认', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const dialog = openAddStageDialog()
    fireEvent.change(within(dialog).getByLabelText('阶段 ID'), { target: { value: 'bad id!' } })
    expect(within(dialog).getByTestId('wb-add-stage-id-error')).toHaveTextContent('阶段 ID 仅允许字母 / 数字 / - / _')
    expect(within(dialog).getByTestId('wb-add-stage-confirm')).toBeDisabled()

    fireEvent.change(within(dialog).getByLabelText('阶段 ID'), { target: { value: 'bad-id' } })
    expect(within(dialog).queryByTestId('wb-add-stage-id-error')).toBeNull()
    expect(within(dialog).getByTestId('wb-add-stage-confirm')).toBeEnabled()
  })

  it('ID 校验：与已有 step 重复报错、确认钮禁用，不落', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const dialog = openAddStageDialog()
    fireEvent.change(within(dialog).getByLabelText('阶段 ID'), { target: { value: 'ship' } })
    expect(within(dialog).getByTestId('wb-add-stage-id-error')).toHaveTextContent('阶段 ID 已存在')
    expect(within(dialog).getByTestId('wb-add-stage-confirm')).toBeDisabled()
    // 禁用钮点击是浏览器/jsdom 层面的天然 no-op：不会新增第 4 张卡
    fireEvent.click(within(dialog).getByTestId('wb-add-stage-confirm'))
    expect(railStepOrder()).toEqual(['wb-step-draft', 'wb-step-review', 'wb-step-ship'])
    expect(screen.getByTestId('wb-add-stage')).toBeInTheDocument()
  })

  it('选中中间阶段（review）后添加 → 插在其后；前一步 transition 重定向指向新阶段、新阶段转到原后继；保存 payload 含新 step', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-step-review'))

    const dialog = openAddStageDialog()
    fireEvent.change(within(dialog).getByLabelText('阶段名称'), { target: { value: 'QA Gate' } })
    fireEvent.click(within(dialog).getByTestId('wb-add-stage-confirm'))

    // Dialog 关闭、新卡插在 review 与 ship 之间、选中态切到新阶段、进入 dirty
    expect(screen.queryByTestId('wb-add-stage')).toBeNull()
    expect(railStepOrder()).toEqual(['wb-step-draft', 'wb-step-review', 'wb-step-qa-gate', 'wb-step-ship'])
    // P4 迁移：选中态读数从 wb-editor-stage（StepEditor 卡头）换成泳道 aria-current
    // （同「选中态」describe 的登记）。「插入后选中态切到新阶段」这条行为本身没变。
    expect(screen.getByTestId('wb-step-qa-gate')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('wb-step-review')).not.toHaveAttribute('aria-current')
    expect(screen.getByTestId('wb-dirty')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toBeInTheDocument())

    const saved = lastSavedDef()
    expect(saved?.steps.map((s) => s.id)).toEqual(['draft', 'review', 'qa-gate', 'ship'])
    // review 原 approved→ship 改指 qa-gate，rejected→draft 原样保留
    expect(saved?.steps.find((s) => s.id === 'review')?.transitions).toEqual([
      { event: 'approved', to: 'qa-gate' },
      { event: 'rejected', to: 'draft' },
    ])
    // 新 step 形状：{ id, label, gate: null, skills: [], inputs: [], outputs: [], guards: [], transitions }
    expect(saved?.steps.find((s) => s.id === 'qa-gate')).toEqual({
      id: 'qa-gate', label: 'QA Gate', gate: null, skills: [], inputs: [], outputs: [], guards: [],
      transitions: [{ event: 'qa-gate-complete', to: 'ship' }],
    })
    // ship 未被牵动
    expect(saved?.steps.find((s) => s.id === 'ship')?.transitions).toEqual([])
  })

  it('选中末尾阶段（ship）后添加 → 追加到末尾，原终点自动接到新终点', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    fireEvent.click(screen.getByTestId('wb-step-ship'))

    const dialog = openAddStageDialog()
    fireEvent.change(within(dialog).getByLabelText('阶段名称'), { target: { value: 'Notify' } })
    fireEvent.click(within(dialog).getByTestId('wb-add-stage-confirm'))

    expect(railStepOrder()).toEqual(['wb-step-draft', 'wb-step-review', 'wb-step-ship', 'wb-step-notify'])
    expect(screen.getByTestId('wb-step-notify')).toHaveAttribute('aria-current', 'step')

    fireEvent.click(screen.getByTestId('wb-save'))
    await waitFor(() => expect(screen.getByTestId('wb-save-ok')).toBeInTheDocument())

    const saved = lastSavedDef()
    expect(saved?.steps.map((s) => s.id)).toEqual(['draft', 'review', 'ship', 'notify'])
    expect(saved?.steps.find((s) => s.id === 'ship')?.transitions).toEqual([
      { event: 'ship-complete', to: 'notify' },
    ])
    expect(saved?.steps.find((s) => s.id === 'notify')?.transitions).toEqual([])
  })

  it('插入后未保存即切 workflow → 触发脏守卫确认 Dialog（脏守卫四件套复用生效）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const dialog = openAddStageDialog()
    fireEvent.change(within(dialog).getByLabelText('阶段名称'), { target: { value: 'QA Gate' } })
    fireEvent.click(within(dialog).getByTestId('wb-add-stage-confirm'))
    expect(screen.getByTestId('wb-dirty')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    expect(screen.getByTestId('wb-switch-confirm')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-step-open')).toBeNull()
  })
})

// ── T16：「自动运行(Loop)」卡挂载 + 右栏摘要「自动运行」行 ──

/**
 * P4 迁移登记：「自动运行」页签退役 → LoopCard **原件**改挂右栏「完整治理设置」Dialog
 * （wb-rail-loop-full → wb-rail-loop-dialog，WorkbenchSideRail.tsx:161-183）。
 * 被测行为不变：① 卡吃的是同一份 useLoops rows（「数据住共同祖先」——宿主 WorkbenchView 拉、
 * 治理轨与 Dialog 共用），故空态/真参数渲染逐字照旧；② 右栏摘要「自动运行」行读的是已保存
 * 真值，与卡是否展开无关（下面刻意**不开 Dialog** 就断摘要行，钉住这条解耦）。
 *
 * §删除登记：「编辑卡在前、Loop 卡在后（demo 布局序）」——StepEditor（wb-editor）已从本视图
 * 卸载，两者不再同列共存，这条 DOM 序断言失去参照物。Loop 卡现在的位置语义（右栏 Dialog 内）
 * 由下面的 within(dialog) 断言承载。
 */
describe('WorkbenchView T16 Loop 卡（右栏「完整治理设置」Dialog）与摘要行', () => {
  /** 开「完整治理设置」Dialog（P4 落点：原 sheet「自动运行」页签的对位）。 */
  async function openLoopDialog(): Promise<HTMLElement> {
    if (screen.queryByTestId('wb-side-col') === null) await openGovernance()
    fireEvent.click(screen.getByTestId('wb-rail-loop-full'))
    return screen.findByTestId('wb-rail-loop-dialog')
  }

  it('入口默认收着：LoopCard 不挂载；点「完整治理设置」→ Dialog 内挂 LoopCard 原件（能力未丢）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    await openGovernance()
    // 反向断言配正向对照：入口钮在场（能力可达），只是卡还没挂
    expect(screen.getByTestId('wb-rail-loop-full')).toBeInTheDocument()
    expect(screen.queryByTestId('wb-loop-card')).toBeNull()

    const dialog = await openLoopDialog()
    expect(within(dialog).getByTestId('wb-loop-card')).toBeInTheDocument()
  })

  it('无 loop 的 root：Dialog 内是空态 Loop 卡（loops.yaml 教学），摘要行显「未配置」', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    await openGovernance()
    // 摘要行不依赖 Dialog 展开（读的是宿主 useLoops 的已保存真值）——先断它，再开卡
    await waitFor(() => expect(screen.getByTestId('wb-sum-loop')).toHaveTextContent('未配置'))

    const dialog = await openLoopDialog()
    const card = within(dialog).getByTestId('wb-loop-card')
    expect(within(card).getByTestId('lp-empty')).toHaveTextContent('.pipeline/loops.yaml')
  })

  it('有 loop：Dialog 内的卡渲染真参数，摘要行 = 开 · 今日 runsToday/max_runs_per_day（已保存真值口径）', async () => {
    loopRows = [LOOP_ROW]
    renderView()
    await screen.findByTestId('wb-step-draft')
    await openGovernance()
    await waitFor(() => expect(screen.getByTestId('wb-sum-loop')).toHaveTextContent('开 · 今日 3/24'))

    const dialog = await openLoopDialog()
    const card = within(dialog).getByTestId('wb-loop-card')
    await waitFor(() => expect(within(card).getByTestId('lp-goal')).toHaveValue('把旧版工单卡样式逐个迁移到 SaaS 卡片风'))
    // 单 loop：卡头下拉隐藏
    expect(within(card).queryByTestId('lp-loop-select')).toBeNull()
  })

  it('Loop 草稿阻止关闭子 Dialog 与整个治理面板，确认丢弃后才卸载', async () => {
    loopRows = [LOOP_ROW]
    renderView()
    await screen.findByTestId('wb-step-draft')
    await openGovernance()
    const dialog = await openLoopDialog()
    const goal = await within(dialog).findByTestId('lp-goal')
    fireEvent.change(goal, { target: { value: '保留这份未保存治理草稿' } })

    fireEvent.click(within(dialog).getByTestId('wb-rail-loop-close'))
    expect(screen.getByTestId('wb-rail-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.getByTestId('lp-goal')).toHaveValue('保留这份未保存治理草稿')

    fireEvent.click(screen.getByTestId('wb-governance-close-action'))
    expect(screen.getByTestId('wb-governance-unsaved-draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '丢弃并离开' }))
    await waitFor(() => expect(screen.queryByTestId('wb-advanced-orchestration')).toBeNull())
  })

  it('暂停中的 loop：摘要行「停 · 今日 …」', async () => {
    loopRows = [{ ...LOOP_ROW, status: 'paused' }]
    renderView()
    await screen.findByTestId('wb-step-draft')
    await openGovernance()
    await waitFor(() => expect(screen.getByTestId('wb-sum-loop')).toHaveTextContent('停 · 今日 3/24'))
  })
})

describe('WorkbenchView 加载失败', () => {
  it('workflow 定义 404 → 行内错误文案（不白屏）', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'workflow 未找到' }), { status: 404 })
    }) as unknown as typeof fetch
    renderView()
    await waitFor(() => expect(screen.getByText('加载 workflow 失败：请求失败（HTTP 404）。')).toBeInTheDocument())
  })

  it('English workflow list network failure uses localized recovery copy without transport Chinese', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    global.fetch = vi.fn(async (url: string) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) throw new Error('offline')
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    renderView()
    const alert = await screen.findByText('Failed to fetch workflow list: Network error')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('English workflow list non-JSON HTTP failure uses localized status without endpoint fallback Chinese', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    global.fetch = vi.fn(async (url: string) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response('upstream unavailable', { status: 503 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    renderView()
    const alert = await screen.findByText('Failed to fetch workflow list: Request failed (HTTP 503).')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('English workflow definition HTTP failure does not expose server Chinese', async () => {
    localStorage.setItem('tenon-dashboard-lang', 'en')
    global.fetch = vi.fn(async (url: string) => {
      if (url === `/api/workflows?root=${encodeURIComponent(ROOT)}`) {
        return new Response(JSON.stringify({ names: ['release-train'] }), { status: 200 })
      }
      if (url.startsWith('/api/workflows/release-train?root=')) {
        return new Response(JSON.stringify({ error: 'workflow 未找到' }), { status: 404 })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    renderView()
    const alert = await screen.findByText('Failed to load workflow: Request failed (HTTP 404).')
    expect(alert.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })
})

// ── v6 计划 T11：StepperRail → 流程带——stageCounts 纯函数直测 + WorkbenchView 接线集成测试 ──

describe('stageCounts 纯函数（v6 T11，零 IO）', () => {
  const OTHER_ROOT = '/tmp/proj-b'

  it('按阶段分桶真实 change 数；只认精确匹配的 root + changeWorkflowName===workflow', () => {
    const snap = makeSnapshot([
      makeProject(ROOT, [
        makeChange('c1', 'draft', { fields: { workflow: 'release-train' } }),
        makeChange('c2', 'review', { fields: { workflow: 'release-train' } }),
        makeChange('c3', 'review', { fields: { workflow: 'release-train' } }),
        makeChange('c4', 'draft', { fields: { workflow: 'default' } }), // 其它 workflow，不计入
      ]),
      makeProject(OTHER_ROOT, [makeChange('c5', 'draft', { fields: { workflow: 'release-train' } })]), // 其它 root，不计入
    ])
    const counts = stageCounts(snap, ROOT, 'release-train')
    expect(counts['draft']).toEqual({ count: 1, running: false })
    expect(counts['review']).toEqual({ count: 2, running: false })
    expect(counts['ship']).toBeUndefined()
  })

  it('running 判据精确等于 automation===\'running\'（不折叠 scheduled，逐字对齐验收判据④）', () => {
    const snap = makeSnapshot([
      makeProject(ROOT, [
        makeChange('c1', 'review', { fields: { workflow: 'release-train', automation: 'running' } }),
        makeChange('c2', 'draft', { fields: { workflow: 'release-train', automation: 'scheduled' } }),
      ]),
    ])
    const counts = stageCounts(snap, ROOT, 'release-train')
    expect(counts['review']).toEqual({ count: 1, running: true })
    expect(counts['draft']).toEqual({ count: 1, running: false }) // scheduled ≠ running：不点脉冲
  })

  it('archived change 排除（对齐决议 #5「archive 排除进度」口径）', () => {
    const snap = makeSnapshot([
      makeProject(ROOT, [
        makeChange('c1', 'ship', { fields: { workflow: 'release-train' }, archived: 'true' }),
      ]),
    ])
    expect(stageCounts(snap, ROOT, 'release-train')).toEqual({})
  })

  it('root 不可达（ok:false）或 snapshot 为空：回落空对象，不抛异常', () => {
    const snap = makeSnapshot([makeProject(ROOT, [makeChange('c1', 'draft')], { ok: false })])
    expect(stageCounts(snap, ROOT, 'release-train')).toEqual({})
    expect(stageCounts(null, ROOT, 'release-train')).toEqual({})
  })
})

describe('WorkbenchView 流程带真实计数 / running 脉冲（v6 T11 集成）', () => {
  it('snapshot 未传（既有消费方缺省态）：计数气泡与脉冲均不渲染，不报错', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.queryByTestId('wb-flow-count-draft')).toBeNull()
    expect(screen.queryByTestId('wb-flow-gloss-draft')).toBeNull()
  })

  it('传入 snapshot：编辑器不展示在办数量，running 脉冲只在 automation===running 的阶段渲染', async () => {
    const snap = makeSnapshot([
      makeProject(ROOT, [
        makeChange('c1', 'draft', { fields: { workflow: 'release-train' } }),
        makeChange('c2', 'review', { fields: { workflow: 'release-train' } }),
        makeChange('c3', 'review', { fields: { workflow: 'release-train', automation: 'running' } }),
        makeChange('c4', 'ship', { fields: { workflow: 'release-train' }, archived: 'true' }), // 已归档，不计入
      ]),
    ])
    renderView({ snapshot: snap })
    await screen.findByTestId('wb-step-draft')

    expect(screen.queryByTestId('wb-flow-count-draft')).toBeNull()
    expect(screen.queryByTestId('wb-flow-count-review')).toBeNull()
    expect(screen.queryByTestId('wb-flow-count-ship')).toBeNull()

    expect(screen.queryByTestId('wb-flow-gloss-draft')).toBeNull()
    expect(screen.getAllByTestId('wb-flow-gloss-review')).toHaveLength(1)
    expect(screen.queryByTestId('wb-flow-gloss-ship')).toBeNull()
  })

  it('切换 workflow 后仍不在编辑器混入任务计数', async () => {
    const snap = makeSnapshot([
      makeProject(ROOT, [
        makeChange('c1', 'build', {}), // fields 空 → changeWorkflowName 回落 'default'
      ]),
    ])
    renderView({ snapshot: snap })
    await screen.findByTestId('wb-step-draft')
    expect(screen.queryByTestId('wb-flow-count-build')).toBeNull() // 此刻在 release-train，没有 build 阶段

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    await screen.findByTestId('wb-step-open')
    expect(screen.queryByTestId('wb-flow-count-build')).toBeNull()
  })
})

describe('WorkbenchView 阶段总览复核信息收口', () => {
  it('总览不渲染复核徽标；选择有复核门的阶段后只在详情展示真实状态', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    expect(screen.queryByTestId('wb-flow-gate-review')).toBeNull()
    fireEvent.click(within(screen.getByTestId('wb-step-review')).getByRole('button', { name: '选择阶段 人工复核' }))
    expect(screen.getByTestId('wb-step-review')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('wb-selected-gate')).toHaveTextContent('复核门')
  })
})

/**
 * v6 T12：编辑区瘦身——Hook 时序线从 StepEditor slot 挪右栏(per-root 数据面,不吃 workflow
 * 只读态);右栏新增安全门说明卡(决议#2 人话版)与 manifest 技能矩阵入口卡。
 * 断言迁移登记:原「编辑区含 Hook 分区」的隐性布局由本 describe 的①显式接管(编辑卡内不再有
 * wb-hooks);HookTimeline 自身开关/锁定/回滚逻辑仍由 HookTimeline.test.tsx 全量覆盖,不重复。
 * v8-E 迁移登记：Hook 时序线再挪进「阶段编辑」页签(①断言同步)、矩阵入口卡挪进「技能健康」
 * 页签(④断言收窄 within(wb-pane-health));安全门说明卡(③)留右栏不动。开关按选中阶段读写(②)
 * 与矩阵入口脏守卫路径(④)的行为断言全部保留——守门等强度,只换宿主位置。
 *
 * ── v11 P4 迁移登记（2026-07-15，五页签退役）──
 * ① Hook 时序线**第三次搬家**：右栏 → 「阶段编辑」页签 → **画布逐列 Hook 区**
 *    （wb-lane-hooks-${stage}）。断言随之从「wb-hooks 在 pane 内、不在编辑卡内」改成
 *    「Hook 区在每条泳道内、右栏仍无 wb-side-hooks」。
 * ② 「开关按**当前选中阶段**读写」→ 「开关按**所在列**读写」：画布一屏 N 列各一份 Hook 区，
 *    键的阶段半边恒 = 本列 lane.id（OrchestrationBoard.tsx:892-894），不再读 selectedId。
 *    这是增强不是缩水（不必先选中就能改任意列），故断言改为「点 review 列的开关 → phase=review，
 *    且此刻选中的是 draft」——比原来更严：写键若回退成读 selectedId，这条当场红。
 * ③ 安全门说明卡留右栏不动，断言原样。
 * ④ 矩阵入口卡（wb-mx-open）随「技能健康」页签一并被摘（生产侧决定，i18n 的 mx_open/
 *    mx_open_here 已成孤儿键——已上报）。它守的**能力**（default 的强制技能矩阵可达）未丢，
 *    改由 workflow 下拉切 default → 画布技能区渲 wb-mand-* + 看板级 wb-track-* 承载，
 *    故 ④ 迁移成对新落点的断言（含自定义 workflow 下不渲染的对照组）。
 */
describe('WorkbenchView v6 T12（v11 P4 画布化后）：Hook 区/安全门/default 强制技能矩阵', () => {
  const HOOKS_BODY = {
    hooks: [
      { id: 'session-start', event: 'SessionStart', configurable: true },
      { id: 'gate', event: 'PreToolUse', configurable: false },
      { id: 'interactive-skill-gate', event: 'PostToolUse', configurable: false },
      { id: 'confirm-clear', event: 'PostToolUse', configurable: false },
    ],
    matrix: {},
  }
  let hookPosts: string[]
  beforeEach(() => {
    hookPosts = []
    const prev = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url.startsWith('/api/hooks')) {
        if (opts?.method === 'POST') {
          hookPosts.push(String(opts.body))
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response(JSON.stringify(HOOKS_BODY), { status: 200 })
      }
      return (prev as unknown as typeof fetch)(url as never, opts)
    }) as unknown as typeof fetch
  })

  /** 唯一纵向编辑器只渲染当前阶段；切换阶段后读取该阶段完整 Hook 时序。 */
  async function selectLaneHooks(stage: string): Promise<HTMLElement> {
    const lane = await screen.findByTestId(`wb-step-${stage}`)
    fireEvent.click(within(lane).getByRole('button', { name: /选择阶段/ }))
    return screen.getByTestId(`wb-lane-hooks-${stage}`)
  }

  it('① Hook 区进入唯一纵向编辑器——切换阶段时原位展示该阶段 Hook，右栏不重复', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    for (const p of ['draft', 'review', 'ship']) {
      expect(await selectLaneHooks(p)).toBeInTheDocument()
    }
    // 右栏宿主卡自 v8-E 右栏瘦身起就已撤下，P4 后仍不许回潮
    const side = await openGovernance()
    expect(within(side).queryByTestId('wb-side-hooks')).toBeNull()
    expect(within(side).queryByTestId('wb-lane-hooks-draft')).toBeNull()
    // 正向对照（防上面两条 queryBy 假绿）：右栏确实渲染着它该有的东西
    expect(within(side).getByTestId('wb-sum-hooks')).toBeInTheDocument()
  })

  it('② 开关按当前编辑阶段写回：在 review 编辑器点击开关 → POST phase=review', async () => {
    renderView()
    const zone = await selectLaneHooks('review')

    fireEvent.click(within(zone).getByTestId('wb-lane-hk-sw-review-session-start'))
    await waitFor(() => expect(hookPosts.length).toBe(1))
    const body = JSON.parse(hookPosts[0]!) as { hook: string; phase: string; enabled: boolean }
    expect(body.hook).toBe('session-start')
    expect(body.phase).toBe('review')
    expect(body.enabled).toBe(false)
  })

  it('③ 安全门说明卡:强制常开与未接线两段人话说明(决议#2 回归)', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const side = await openGovernance()
    const card = within(side).getByTestId('wb-side-safegate')
    expect(card.textContent).toContain('强制常开')
    expect(card.textContent).toContain('不做假开关')
  })

  it('④ default 强制技能矩阵(原「矩阵入口卡」的能力落点):切到 default → 画布技能区渲矩阵 + 看板级 track 选择器', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    // 自定义 workflow 不渲染 default 专属矩阵，但仍能选择项目级运行轨道。
    expect(screen.queryByTestId('wb-mand-draft')).toBeNull()
    expect(screen.getByTestId('wb-track-tabs')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wb-wf-btn'))
    fireEvent.click(await screen.findByTestId('wb-wf-item-default'))
    await screen.findByTestId('wb-step-open')

    // 矩阵随当前阶段进入同一 Skill 区；切换阶段后原位更新，track 仍是全局单份。
    for (const p of ['open', 'build', 'verify']) {
      const lane = screen.getByTestId(`wb-step-${p}`)
      fireEvent.click(within(lane).getByRole('button', { name: /选择阶段/ }))
      expect(await screen.findByTestId(`wb-mand-${p}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('wb-track-tabs')).toBeInTheDocument()
    // 用户看到阶段入口与 Skill 调用链，不暴露“无序集合”实现术语。
    fireEvent.click(within(screen.getByTestId('wb-step-build')).getByRole('button', { name: /选择阶段/ }))
    const chain = screen.getByTestId('wb-mand-parallel-build')
    expect(chain).toHaveTextContent('阶段开始')
    expect(chain).not.toHaveTextContent('无序')
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * v11 P4（2026-07-15）：原「WorkbenchView v8-E：sheet 页签化」describe —— **整组删除**。
 * ══════════════════════════════════════════════════════════════════════════════════════
 * 逐条登记「原断言 → 为何随页签消失」（这三条是本轮**唯二**够格被删的那类：被断言的概念
 * 本身不存在了，不是换了个地方）：
 *
 * ① 「五页签渲染,默认『阶段编辑』选中;切页签换 aria-selected 与 pane data-state」
 *    → **删**。wb-tab-* / wb-pane-* / tab 状态整套随 sheet 退役（WorkbenchView.tsx:1147-1158
 *    的退役登记）。「页签」这个概念没了，「点 tab 切 pane」就无从谈起。
 *    其中「各页宿主卡就位（恒挂载）」这半条**没有被删**，而是拆到了各自的新宿主：
 *      · wb-editor（StepEditor）→ 编辑能力迁画布就地编，由本文件 T13 组全量守门；
 *      · wb-loop-card → 迁「完整治理设置」Dialog，由本文件 T16 组守门（含「入口在、卡按需挂」）。
 *
 * ② 「点阶段卡=选中并驱动 sheet 切回『阶段编辑』页签(其它页签停留态被拉回)」
 *    → **删**。这条断言的**全部内容**就是「选中动作会把 sheet 页签拉回第一页」——没有页签就
 *    没有「拉回」。其中「点阶段卡=选中」这半条由本文件「选中态」describe 全量接管（那里连
 *    aria-current/data-state 双读数与互斥性一起钉）。
 *
 * ③ 「右栏瘦身:摘要/安全门/最近流转留守,SkillHealthPanel 并入『技能健康』页签」
 *    → **迁移**（不是删）：见下方「v11 P4：右栏重组」describe——留守三卡照旧断，
 *    SkillHealthPanel 的落点从「技能健康」页签换成「机器配置」折叠区。
 *
 * ④ 原「pane 恒挂载保留未提交草稿（demo↔生产差异清单 #4）」describe
 *    → **删**。这条用例的探针与被证伪对象**双双随页签退役**：探针是 StepEditor 的
 *    adding/draft 本地 state（组件已从本视图卸载），被证伪对象是「pane 会不会被条件卸载」
 *    （pane 不存在了）。画布无页签、无 pane 切换，「切走再切回」这个动作在新 IA 里没有对应操作
 *    ——不存在「换个地方还测同一件事」的选项。
 *    注：画布自己的就地输入态（wb-lane-out-input-* 的 outAdd 本地 state）另有守门——
 *    OrchestrationBoard.test.tsx 的 P1 产出区用例覆盖其提交/取消/校验语义。
 *    「墨线 ink GSAP 滑动 + pane crossfade」本就在 jsdom 不断言（原 describe 头注释已声明），
 *    随页签一并作废，无迁移目标。
 */

/**
 * v11 P4：右栏重组（原「v8-E 右栏瘦身」的迁移落点）。
 * 五页签退役后右栏 = 治理轨(P3 三卡) +「完整治理设置」入口 +「机器配置」折叠区 + 既有留守卡。
 * 本组守两件事：① 留守三卡（摘要/安全门/最近流转）没在重组里丢；② AFK 执行/凭证/技能健康
 * 三张 per-root 机器卡的**能力未丢**——从「技能健康/AFK/凭证」三个页签换成「机器配置」折叠区，
 * 默认收起（机器级配置与当前 workflow 正交，不是日常路径），展开后三件原件都在。
 */
describe('WorkbenchView v11 P4：右栏重组（治理轨 + 机器配置折叠区）', () => {
  it('留守三卡仍在右栏：摘要/安全门/最近流转（重组不许顺手丢东西）', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    // v10b 迁移：右栏容器从 .side-col 类锚点改 data-testid 寻址
    const side = await openGovernance()
    expect(within(side).getByTestId('wb-sum-stages')).toBeInTheDocument()
    expect(within(side).getByTestId('wb-side-safegate')).toBeInTheDocument()
    expect(within(side).getByTestId('wb-recent')).toBeInTheDocument()
    // P3 治理轨在右栏顶部（P4 的「完整治理设置」入口是它的延伸）
    expect(within(side).getByTestId('wb-gov-rail')).toBeInTheDocument()
    expect(within(side).getByTestId('wb-rail-loop-full')).toBeInTheDocument()
  })

  /**
   * 原 v8-E ③ 的迁移：「技能齐全度不在右栏平铺、在『技能健康』页签里」→ 「不平铺、在
   * 『机器配置』折叠区里，且默认收起」。被测行为（右栏不平铺这块面、但它可达）不变；
   * P4 还多守一条：**闭合即卸载**（WorkbenchSideRail.tsx:134 的 `{machineOpen && …}`）——
   * 三张卡各自 mount 即 fetch，闭合还留在 DOM = 给用户没打开的面板白烧 3 个请求。
   */
  it('「机器配置」默认折叠：三件机器卡都不挂载；展开后 AFK/凭证/技能健康三件原件在场', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const side = await openGovernance()

    // 默认收起：入口在（能力可达）、内容不挂载（闭合即卸载）
    const summary = within(side).getByTestId('wb-rail-machine-summary')
    expect(within(side).getByTestId('wb-rail-machine')).not.toHaveAttribute('open')
    expect(within(side).queryByText('技能齐全度')).toBeNull()

    fireEvent.click(summary)

    expect(within(side).getByTestId('wb-rail-machine')).toHaveAttribute('open')
    // 三件原件在场（各自渲染自己的卡头，组装件不重复贴标题）
    expect(await within(side).findByText('技能齐全度')).toBeInTheDocument()
    expect(within(side).getByTestId('wb-side-skillhealth')).toBeInTheDocument() // SkillHealthPanel
    expect(within(side).getByTestId('wb-afk-card')).toBeInTheDocument() // AutomationCard
    expect(within(side).getByTestId('wb-secrets-card')).toBeInTheDocument() // SecretsCard
    // 区头说明：讲清「这些是 per-root 机器级配置，与当前 workflow 无关」
    expect(within(side).getByTestId('wb-rail-machine-note')).toBeInTheDocument()
  })

  it('机器配置内有未保存草稿时，折叠动作必须先确认丢弃', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')
    const side = await openGovernance()
    const summary = within(side).getByTestId('wb-rail-machine-summary')
    fireEvent.click(summary)
    const enabled = await within(side).findByTestId('afk-enabled')
    fireEvent.click(enabled)
    expect(within(side).getByTestId('afk-dirty')).toBeInTheDocument()

    fireEvent.click(summary)
    expect(screen.getByTestId('wb-rail-unsaved-draft')).toBeInTheDocument()
    expect(within(side).getByTestId('wb-rail-machine')).toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: '丢弃并离开' }))
    await waitFor(() => expect(within(side).getByTestId('wb-rail-machine')).not.toHaveAttribute('open'))
  })

  it('机器配置保存请求进行中时不得折叠或关闭治理面板', async () => {
    const baseFetch = global.fetch
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    global.fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/automation' && options?.method === 'POST') {
        await gate
        const { root: _root, ...settings } = JSON.parse(String(options.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ ok: true, settings }), { status: 200 })
      }
      return baseFetch(url, options)
    }) as typeof fetch

    renderView()
    await screen.findByTestId('wb-step-draft')
    const side = await openGovernance()
    const summary = within(side).getByTestId('wb-rail-machine-summary')
    fireEvent.click(summary)
    fireEvent.click(await within(side).findByTestId('afk-enabled'))
    fireEvent.click(within(side).getByTestId('afk-save'))
    await waitFor(() => expect(within(side).getByTestId('afk-save')).toBeDisabled())

    expect(screen.getByTestId('wb-governance-close-action')).toBeDisabled()
    fireEvent.click(summary)
    expect(within(side).getByTestId('wb-rail-machine')).toHaveAttribute('open')
    fireEvent.click(screen.getByTestId('wb-governance-close-icon'))
    expect(screen.getByTestId('wb-advanced-orchestration')).toBeInTheDocument()

    release()
    await waitFor(() => expect(within(side).getByTestId('afk-save-ok')).toBeInTheDocument())
    expect(screen.getByTestId('wb-governance-close-action')).toBeEnabled()
  })
})

/**
 * v6 T13：「最近流转」——真实 history 事件回放(假预演退役后的右栏接棒)。数据面:当前
 * (root, workflow) 分组内非 archived change 逐个 GET /api/change/:name/history,合并降序取
 * 最近 N 条;单 change 无记录计入 legacy 标注(决议#10);archived 不入列(决议#5);无轮询(G22)。
 */
describe('WorkbenchView v6 T13：最近流转(真实 history 回放)', () => {
  const HIST: Record<string, Array<Record<string, string>>> = {
    c1: [
      { ts: '2026-07-11T01:00:00Z', kind: 'transition', from: 'draft', to: 'review' },
      { ts: '2026-07-11T03:00:00Z', kind: 'set', field: 'verify_result' },
    ],
    c2: [{ ts: '2026-07-11T02:00:00Z', kind: 'transition', from: 'review', to: 'ship' }],
    legacy1: [],
  }
  beforeEach(() => {
    const prev = global.fetch
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      const m = /^\/api\/change\/([^/]+)\/history\?root=/.exec(String(url))
      if (m) {
        const name = decodeURIComponent(m[1]!)
        if (!(name in HIST)) return new Response(JSON.stringify({ ok: false, error: 'no such change' }), { status: 404 })
        return new Response(JSON.stringify({ ok: true, entries: HIST[name] }), { status: 200 })
      }
      return (prev as unknown as typeof fetch)(url as never, opts)
    }) as unknown as typeof fetch
  })

  const snapWith = (changes: ReturnType<typeof makeChange>[]) => makeSnapshot([makeProject(ROOT, changes)])

  it('多 change 事件合并按 ts 降序;archived 不入列;无记录 change 计入 legacy 标注', async () => {
    renderView({
      snapshot: snapWith([
        makeChange('c1', 'review', { fields: { workflow: 'release-train' } }),
        makeChange('c2', 'ship', { fields: { workflow: 'release-train' } }),
        makeChange('legacy1', 'draft', { fields: { workflow: 'release-train' } }),
        makeChange('c-arch', 'ship', { archived: 'true', fields: { workflow: 'release-train' } }),
        makeChange('c-other', 'draft', { fields: { workflow: 'default' } }),
      ]),
    })
    const side = await openGovernance()
    const list = await within(side).findByTestId('wb-recent-list')
    // v10b 迁移：条目从 .wb-rt-item 类锚点改按列表结构（li）寻址
    const items = Array.from(list.querySelectorAll('li')).map((li) => li.textContent ?? '')
    expect(items.length).toBe(3)
    expect(items[0]).toContain('verify_result') // 03:00 最新
    expect(items[1]).toContain('review → ship') // 02:00
    expect(items[2]).toContain('draft → review') // 01:00
    expect(items.some((x) => x.includes('c-arch'))).toBe(false)
    expect(screen.getByTestId('wb-recent-legacy').textContent).toContain('1')
  })

  it('分组内无 change → 空态文案,不发请求也不报错', async () => {
    renderView({ snapshot: snapWith([makeChange('c-other', 'draft', { fields: { workflow: 'default' } })]) })
    const side = await openGovernance()
    expect(await within(side).findByTestId('wb-recent-empty')).toBeInTheDocument()
  })
})

describe('Workbench 默认信息层级', () => {
  it('策略与运行时摘要默认折叠，打开后仍保留完整编辑与证据', async () => {
    renderView()
    await screen.findByTestId('wb-step-draft')

    const policy = screen.getByTestId('workbench-policy-disclosure')
    const runtime = screen.getByTestId('workbench-runtime-disclosure')
    expect(policy).not.toHaveAttribute('open')
    expect(runtime).not.toHaveAttribute('open')

    const summary = policy.querySelector('summary')
    if (!summary) throw new Error('policy disclosure summary missing')
    fireEvent.click(summary)
    expect(policy).toHaveAttribute('open')
    expect(within(policy).getByTestId('workflow-policy-editor')).toBeInTheDocument()
  })
})
