import { describe, expect, it } from 'vitest'
import { cmdInternalMotionGate, requiredGsapSkills } from './internalMotionGate.js'
import type { CliDeps } from '../deps.js'

const HISTORY = [
  JSON.stringify({ kind: 'transition', to: 'build' }),
  JSON.stringify({ kind: 'tool', raw: 'Skill: gsap-core' }),
].join('\n')

function deps(over: { phase?: string; history?: string; readFails?: boolean } = {}): CliDeps & { err: string[] } {
  const err: string[] = []
  const base = {
    cwd: '/repo',
    io: { out: () => undefined, err: (line: string) => err.push(line) },
    store: {
      read: async () => {
        if (over.readFails) throw new Error('state unreadable')
        return { fields: { phase: over.phase ?? 'build' } }
      },
    },
    readHistoryRaw: async () => over.history ?? HISTORY,
  } as unknown as CliDeps
  return Object.assign(base, { err })
}

describe('requiredGsapSkills', () => {
  it('任何候选都要求 gsap-core', () => {
    expect(requiredGsapSkills('gsap.to(box, { x: 10 })')).toEqual(['gsap-core'])
    expect(requiredGsapSkills('const a = 1')).toEqual([])
  })

  it('按标记追加对应技能', () => {
    expect(requiredGsapSkills("import { useGSAP } from '@gsap/react'")).toEqual(['gsap-core', 'gsap-react'])
    expect(requiredGsapSkills('gsap.registerPlugin(ScrollTrigger)')).toEqual(['gsap-core', 'gsap-scrolltrigger'])
    expect(requiredGsapSkills('const tl = gsap.timeline({ repeat: -1 })')).toEqual(['gsap-core', 'gsap-timeline'])
    expect(requiredGsapSkills('gsap.registerPlugin(Flip)')).toEqual(['gsap-core', 'gsap-plugins'])
    expect(requiredGsapSkills('{"file_path":"src/Hero.vue","content":"gsap.to()"}')).toEqual(['gsap-core', 'gsap-frameworks'])
    expect(requiredGsapSkills('gsap.timeline(); ScrollTrigger.create(); useGSAP()'))
      .toEqual(['gsap-core', 'gsap-react', 'gsap-scrolltrigger', 'gsap-timeline'])
  })
})

describe('cmdInternalMotionGate', () => {
  it('非 GSAP 输入直接放行，不读 state', async () => {
    const d = deps({ readFails: true })
    expect(await cmdInternalMotionGate(d, 'demo', 'const a = 1')).toBe(0)
    expect(d.err).toEqual([])
  })

  it('本步骤已读过所需技能 → 放行', async () => {
    expect(await cmdInternalMotionGate(deps(), 'demo', 'gsap.to(box, { x: 1 })')).toBe(0)
  })

  it('证据在进入本步骤之前 → 拦截并列出缺的技能', async () => {
    const stale = [
      JSON.stringify({ kind: 'tool', raw: 'Skill: gsap-core' }),
      JSON.stringify({ kind: 'transition', to: 'build' }),
    ].join('\n')
    const d = deps({ history: stale })
    expect(await cmdInternalMotionGate(d, 'demo', 'gsap.to(box, { x: 1 })')).toBe(2)
    expect(d.err.join('\n')).toContain('【Tenon 动画门】写入 GSAP 代码前先加载技能：gsap-core')
    expect(d.err.join('\n')).toContain('Codex 用单独一条 cat 读取其 SKILL.md')
  })

  it('缺的技能逐个列出', async () => {
    const d = deps()
    expect(await cmdInternalMotionGate(d, 'demo', "useGSAP(() => { ScrollTrigger.create() })")).toBe(2)
    expect(d.err.join('\n')).toContain('gsap-react, gsap-scrolltrigger')
    expect(d.err.join('\n')).not.toContain('gsap-core,')
  })

  it('CodexSkillRead 与 tenon: 命名空间都算证据', async () => {
    const codex = [
      JSON.stringify({ kind: 'transition', to: 'build' }),
      JSON.stringify({ kind: 'tool', raw: 'CodexSkillRead: gsap-core' }),
      JSON.stringify({ kind: 'tool', raw: 'Skill: tenon:gsap-react' }),
    ].join('\n')
    expect(await cmdInternalMotionGate(deps({ history: codex }), 'demo', 'useGSAP(() => {})')).toBe(0)
  })

  it('非法 change 名、无阶段、内部错误都 fail-open', async () => {
    const bad = deps()
    expect(await cmdInternalMotionGate(bad, '../escape', 'gsap.to()')).toBe(0)
    expect(bad.err.join('\n')).toContain('fail-open')
    expect(await cmdInternalMotionGate(deps({ phase: '' }), 'demo', 'gsap.to()')).toBe(0)
    const broken = deps({ readFails: true })
    expect(await cmdInternalMotionGate(broken, 'demo', 'gsap.to()')).toBe(0)
    expect(broken.err.join('\n')).toContain('internal-motion-gate 内部错误')
  })
})
