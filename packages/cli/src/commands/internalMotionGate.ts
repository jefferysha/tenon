/**
 * tenon internal-motion-gate <name> —— 隐藏命令，动画门：写入含 GSAP 标记的代码前，必须先读过
 * 相应的官方 GSAP 技能。由 hooks/gate.sh 在文件编辑类工具上委托过来（stdin 是工具输入原文）。
 *
 * 与技能门的区别：动画规则不属于某条工作流，default 同样受它约束；判定只看「本次进入当前步骤之后
 * 读过哪些技能」这一份共享证据。exit 口径同 gate.sh：0=放行，2=拦截；任何内部异常 fail-open。
 */
import { errMsg, type CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'
import { canonicalTenonSkillId, completedSkillsSinceStepEntry, parseHistoryLines } from './stepSkillEvidence.js'

/** 工具输入里的标记 → 必须读过的技能。任一候选命中都要求 gsap-core。 */
const MARKERS: readonly { readonly skill: string; readonly test: (input: string) => boolean }[] = [
  { skill: 'gsap-react', test: (input) => input.includes('@gsap/react') || input.includes('useGSAP') },
  { skill: 'gsap-scrolltrigger', test: (input) => input.includes('ScrollTrigger') || input.includes('ScrollSmoother') },
  { skill: 'gsap-timeline', test: (input) => input.includes('.timeline(') },
  {
    skill: 'gsap-plugins',
    test: (input) => ['Flip', 'Draggable', 'SplitText', 'MorphSVGPlugin', 'DrawSVGPlugin', 'MotionPathPlugin', 'Observer', 'InertiaPlugin', 'CustomEase']
      .some((plugin) => input.includes(plugin)),
  },
  { skill: 'gsap-frameworks', test: (input) => /\.(?:vue|svelte)\b/u.test(input) },
]

/** 是不是 GSAP 写入：命中任一候选标记。非候选的工具输入根本不会走到本命令（gate.sh 先做纯 bash 判定）。 */
export function isGsapToolInput(input: string): boolean {
  return /gsap|GSAP|ScrollTrigger|useGSAP/u.test(input)
}

/** 本次写入需要的 GSAP 技能（gsap-core 恒在，其余按标记追加，顺序稳定）。 */
export function requiredGsapSkills(toolInput: string): readonly string[] {
  if (!isGsapToolInput(toolInput)) return []
  return ['gsap-core', ...MARKERS.filter((marker) => marker.test(toolInput)).map((marker) => marker.skill)]
}

const HINT = 'Claude Code 用 Skill 工具，Codex 用单独一条 cat 读取其 SKILL.md（输出不得截断）'

export async function cmdInternalMotionGate(deps: CliDeps, name: string, stdin: string): Promise<0 | 2> {
  try {
    const required = requiredGsapSkills(stdin)
    if (required.length === 0) return 0
    if (!isValidChangeName(name)) {
      deps.io.err(`WARN: internal-motion-gate 收到非法 change 名 '${name}'，fail-open 放行`)
      return 0
    }
    const dir = changeDir(deps.cwd, name)
    const state = await deps.store.read(dir)
    const step = String(state.fields.phase ?? '')
    if (step === '') return 0
    const lines = parseHistoryLines((await deps.readHistoryRaw?.(dir)) ?? '')
    const completed = completedSkillsSinceStepEntry(lines, step)
    const missing = required.filter((skill) => !completed.has(canonicalTenonSkillId(skill)))
    if (missing.length === 0) return 0
    deps.io.err(`【Tenon 动画门】写入 GSAP 代码前先加载技能：${missing.join(', ')}；${HINT}`)
    return 2
  } catch (error) {
    deps.io.err(`WARN: internal-motion-gate 内部错误，fail-open 放行：${errMsg(error)}`)
    return 0
  }
}
