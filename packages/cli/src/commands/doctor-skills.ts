import { join } from 'node:path'
import {
  canonicalWorkflowSkillId, compileEffectiveWorkflowPlan, PRODUCT_IDENTITY, RETIRED_SKILL_IDS,
  skillTokenAlternatives, type SkillTable,
} from '@tenon/kernel'
import type { DoctorProbes, HostPluginInventorySource } from '../deps.js'
import {
  LEGACY_PLUGIN_IDENTITY,
  TENON_PLUGIN_IDENTITY,
} from '../migration/legacy-tenon-migration.js'
import { loadCanonicalSkillSources, type SkillSource } from '../skillSources.js'
import { resolveCommandOnPath } from './commandExists.js'
import { green, yellow, red, type DoctorCheck } from './doctor-check.js'
import { lockedUpstreamSkillIds } from './doctor-upstream-skills.js'

function skillInPlace(
  entry: string,
  byToken: Map<string, SkillSource>,
  installed: ReadonlySet<string>,
): boolean {
  for (const raw of entry.split('|')) {
    const alternative = raw.trim()
    if (alternative === '') continue
    const source = byToken.get(alternative)
    if (source && (source.tool === 'builtin' || source.tool === 'bundled')) return true
    if (installed.has(alternative)) return true
    if (source?.skill !== undefined && installed.has(source.skill)) return true
    const colon = alternative.indexOf(':')
    if (colon <= 0) continue
    const prefix = alternative.slice(0, colon)
    const suffix = alternative.slice(colon + 1)
    if (installed.has(prefix) || installed.has(suffix)) return true
    const pluginSkill = byToken.get(prefix)?.skill
    if (pluginSkill !== undefined && installed.has(pluginSkill)) return true
  }
  return false
}

function collectMissingSkills(
  table: SkillTable,
  byToken: Map<string, SkillSource>,
  installed: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>()
  const missing: string[] = []
  for (const row of Object.values(table)) {
    for (const list of Object.values(row)) {
      for (const entry of list ?? []) {
        if (seen.has(entry)) continue
        seen.add(entry)
        if (!skillInPlace(entry, byToken, installed)) missing.push(entry)
      }
    }
  }
  return missing
}

function evaluateSkillChecks(
  tables: { mandatory: SkillTable; recommended: SkillTable },
  registry: SkillSource[],
  installed: ReadonlySet<string>,
): [DoctorCheck, DoctorCheck] {
  const byToken = new Map(registry.map((source) => [source.token, source]))
  const mandatoryMissing = collectMissingSkills(tables.mandatory, byToken, installed)
  const recommendedMissing = collectMissingSkills(tables.recommended, byToken, installed)
  const mandatory = mandatoryMissing.length === 0
    ? green('skills:mandatory', '所有 manifest 强制技能均随当前 pipeline 插件打包并可用')
    : red(
        'skills:mandatory',
        `自定义 workflow 缺 ${mandatoryMissing.length} 个非打包强制技能：${mandatoryMissing.join('、')}`,
        `安装或随自定义插件打包这些技能（${mandatoryMissing.join('、')}）；tenon setup --<host> 只安装本插件默认流程资产`,
      )
  const recommended = recommendedMissing.length === 0
    ? green('skills:recommended', '所有 manifest 推荐技能均随当前 pipeline 插件打包并可用')
    : yellow(
        'skills:recommended',
        `自定义 workflow 缺 ${recommendedMissing.length} 个非打包推荐技能：${recommendedMissing.join('、')}`,
        '安装或随自定义插件打包这些推荐技能（默认 pipeline 不会下载第三方技能）',
      )
  return [mandatory, recommended]
}

export function checkSkills(p: DoctorProbes): [DoctorCheck, DoctorCheck] {
  const tables = p.manifestSkills()
  if (tables === null) {
    return [
      yellow(
        'skills:mandatory',
        'manifest 不可用——无法核强制技能齐全度（不误报 green）',
        '先修复 asset:manifest（templates/manifest.yaml）后重跑 tenon doctor',
      ),
      yellow(
        'skills:recommended',
        'manifest 不可用——无法核推荐技能齐全度',
        '先修复 asset:manifest 后重跑 tenon doctor',
      ),
    ]
  }
  const registryPath = join(p.pluginRoot, 'templates', 'skill-sources.yaml')
  const registryResult = p.fileExists(registryPath)
    ? loadCanonicalSkillSources(registryPath)
    : { ok: false as const, error: 'registry 缺失' }
  if (!registryResult.ok && p.fileExists(registryPath)) {
    return [
      red(
        'skills:mandatory',
        `canonical registry 无效（${registryResult.error}）——严格 provenance 校验失败`,
        `修复 ${registryPath} 后重跑 tenon doctor；bash ${join(p.pluginRoot, 'tools', 'verify-skills.sh')} 可查看 category`,
      ),
      red(
        'skills:recommended',
        `canonical registry 无效（${registryResult.error}）——严格 provenance 校验失败`,
        `修复 ${registryPath} 后重跑 tenon doctor；bash ${join(p.pluginRoot, 'tools', 'verify-skills.sh')} 可查看 category`,
      ),
    ]
  }
  const registry = registryResult.ok ? registryResult.sources : []
  if (registry.length === 0) {
    return [
      yellow(
        'skills:mandatory',
        'registry 未就绪（templates/skill-sources.yaml 缺失/空）——无法核强制技能齐全度（不误报 green）',
        '确认插件安装完整（skill-sources.yaml 应随插件分发）后重跑 tenon doctor',
      ),
      yellow(
        'skills:recommended',
        'registry 未就绪（templates/skill-sources.yaml 缺失/空）——无法核推荐技能齐全度',
        '确认插件安装完整后重跑 tenon doctor',
      ),
    ]
  }

  // Upstream skills in skills.lock.json ship inside the same plugin root, so they count as bundled.
  const locked: SkillSource[] = lockedUpstreamSkillIds(p)
    .filter((id) => !registry.some((source) => source.token === id))
    .map((token) => ({ token, tool: 'bundled', source: 'upstream', tier: 'optional', official: false }))
  return evaluateSkillChecks(tables, [...registry, ...locked], p.installedSkillNames())
}

/**
 * 强制技能必须是宿主肯代模型调用的那一种。
 *
 * 事实来自获取期记进 skills.lock.json 的 model_invocable——skills/<id> 是 gitignore 的，
 * 只有那一刻手里有字节；tree_sha256 同时钉住内容，所以这一位不会和盘上的 SKILL.md 各说各话。
 * 判定按 token：`a|b` 只要有一个备选可调用就算过；没有锁记录的备选（自带技能、宿主命名空间、
 * 还没装上的）算未知，不拿它定罪，缺技能本身由 skills:mandatory 管。
 */
export function checkMandatorySkillInvocability(p: DoctorProbes): DoctorCheck {
  const tables = p.manifestSkills()
  if (tables === null) {
    return yellow(
      'skills:invocable',
      'manifest 不可用——无法核强制技能是否模型可调用（不误报 green）',
      '先修复 asset:manifest（templates/manifest.yaml）后重跑 tenon doctor',
    )
  }
  const view = p.upstreamSkillView?.()
  if (view === undefined || 'error' in view) {
    return yellow(
      'skills:invocable',
      view === undefined
        ? '上游技能探针未装配——无法核强制技能是否模型可调用（不误报 green）'
        : `上游技能锁不可读（${view.error}）——无法核强制技能是否模型可调用`,
      '运行 tenon update --<host> 或 npm run skills:fetch 重新获取上游技能后重跑 tenon doctor',
    )
  }
  const invocable = new Map<string, boolean>()
  for (const row of view.rows) {
    if (row.modelInvocable !== undefined) invocable.set(row.id, row.modelInvocable)
  }
  const offenders: string[] = []
  const seen = new Set<string>()
  for (const row of Object.values(tables.mandatory)) {
    for (const list of Object.values(row)) {
      for (const token of list ?? []) {
        if (seen.has(token)) continue
        seen.add(token)
        const alternatives = skillTokenAlternatives(token)
        if (alternatives.every((id) => invocable.get(id) === false)) offenders.push(token)
      }
    }
  }
  if (offenders.length === 0) {
    return green('skills:invocable', `${seen.size} 个 manifest 强制技能都是宿主可代模型调用的`)
  }
  return red(
    'skills:invocable',
    `${offenders.length} 个强制技能带 disable-model-invocation: true，宿主不会代模型调用，`
      + `声明它们的相位会卡死在 step-skills-incomplete：${offenders.join('、')}`,
    `把 templates/manifest.yaml 与 templates/workflows/default.yaml 里的 ${offenders.join('、')} `
      + '换成模型可调用的等价技能，或降级为人工指引后重跑 tenon doctor',
  )
}

/** 工作流数据声明的每个技能都要能在插件载荷里找到；技能清单不再硬编码在这里。 */
export function declaredWorkflowSkillIds(): readonly string[] {
  const ids = new Set<string>([PRODUCT_IDENTITY.entrySkill])
  for (const workflow of [compileEffectiveWorkflowPlan('default'), compileEffectiveWorkflowPlan('simple')]) {
    const definition = workflow.definition ?? workflow.workflow
    const branches = [definition.steps, ...Object.values(definition.tracks ?? {}).map((track) => track.steps)]
    for (const steps of branches) {
      for (const step of steps) for (const skill of step.skills) ids.add(canonicalWorkflowSkillId(skill.id))
    }
  }
  return [...ids].sort()
}

export function checkWorkflowSkills(p: DoctorProbes): DoctorCheck {
  let declared: readonly string[]
  try {
    declared = declaredWorkflowSkillIds()
  } catch (error) {
    return red(
      'skills:workflow',
      `工作流技能清单无法解析：${error instanceof Error ? error.message : String(error)}`,
      '修复 default workflow source/generated runtime 后重跑 tenon doctor',
    )
  }
  const retired = declared.filter((id) => RETIRED_SKILL_IDS.includes(id))
  if (retired.length > 0) {
    return red(
      'skills:workflow',
      `工作流引用已删除的技能：${retired.join('、')}`,
      '在工作流页移除后重新保存，再重跑 tenon doctor',
    )
  }
  const missing = declared.filter((id) => !p.fileExists(join(p.pluginRoot, 'skills', id, 'SKILL.md')))
  if (missing.length === 0) {
    return green('skills:workflow', `工作流声明的 ${declared.length} 个技能都可发现`)
  }
  return red(
    'skills:workflow',
    `工作流声明的技能缺 ${missing.length} 个：${missing.join('、')}`,
    `运行 tenon update 补齐 ${missing.map((id) => join(p.pluginRoot, 'skills', id, 'SKILL.md')).join('、')} 后重跑 tenon doctor`,
  )
}

/**
 * OpenSpec CLI：上游 OpenSpec 技能与 `tenon spec apply` 都调它。仓库里它只是 devDependency，
 * 用户机器上没有就是黄灯——不是缺陷，但规格应用跑不了。
 */
export function checkOpenspecCli(): DoctorCheck {
  const path = resolveCommandOnPath('openspec')
  return path === undefined
    ? yellow(
      'integration:openspec-cli',
      'PATH 上没有 openspec：受 openspec 治理的工作流无法应用规格',
      '安装 OpenSpec CLI（npm i -g @fission-ai/openspec）后重跑 tenon doctor',
    )
    : green('integration:openspec-cli', `openspec 可执行：${path}`)
}

/** Codex 正常对话必须能发现的技能 = 工作流数据声明的那一份，不另列清单。 */
function codexProjectContractSkills(): readonly string[] {
  try {
    return declaredWorkflowSkillIds()
  } catch {
    return [PRODUCT_IDENTITY.entrySkill]
  }
}

export async function checkCodexProjectSkills(
  p: DoctorProbes,
  inventory: HostPluginInventorySource | undefined,
): Promise<DoctorCheck> {
  if (inventory?.kind === 'unavailable') {
      return red(
        'integration:codex-project-skills',
        `当前 ${inventory.host} managed runtime 的宿主 plugin inventory 不可用：${inventory.detail}`,
        `先运行 ${inventory.host} plugin list --json 修复宿主 inventory，再运行 tenon setup --${inventory.host}`,
      )
  }
  if (inventory?.kind === 'native') {
    const { host, enabledIds: hostPluginIds } = inventory
    if (hostPluginIds.has(LEGACY_PLUGIN_IDENTITY)) {
      return red(
        'integration:codex-project-skills',
        `${host === 'codex' ? 'Codex' : 'Claude'} 仍启用了会争用正常对话路由和 hooks 的旧工作流插件`,
        `运行 tenon setup --${host} -y；安装器会在 Tenon 新会话证明后通过宿主官方插件管理器清理冲突登记`,
      )
    }
    if (!hostPluginIds.has(TENON_PLUGIN_IDENTITY)) {
      return red(
        'integration:codex-project-skills',
        `${host === 'codex' ? 'Codex' : 'Claude'} plugin inventory 中没有唯一 Tenon 登记 ${TENON_PLUGIN_IDENTITY}`,
        `运行 tenon setup --${host} -y，并新开会话加载当前 Tenon skills/hooks`,
      )
    }
    const loadErrors = inventory.tenonLoadErrors ?? []
    if (loadErrors.length > 0) {
      return red(
        'integration:codex-project-skills',
        `${host === 'codex' ? 'Codex' : 'Claude'} 报告 Tenon 插件加载失败：${loadErrors.join('；')}`,
        `运行 tenon setup --${host} -y 安装当前正式版本并新开会话；仍失败时附上 ${host} plugin list --json 输出反馈`,
      )
    }
  }
  if (p.codexSkillDiscovery !== undefined) {
    const discovery = await p.codexSkillDiscovery()
    const native = discovery.selectedRoot !== undefined
    const active = native ? discovery.selected : discovery.project
    const missing = codexProjectContractSkills().filter((name) => !active.has(name))
    const duplicates: string[] = []
    const shadows: string[] = []
    if (native) {
      for (const [id, projectDigest] of discovery.project) {
        const selectedDigest = discovery.selected.get(id)
        if (selectedDigest === undefined) continue
        if (selectedDigest === projectDigest) duplicates.push(id)
        else shadows.push(id)
      }
    }

    if (shadows.length > 0) {
      return red(
        'integration:codex-project-skills',
        `shadow-conflict: ${shadows.join('、')} 在 Selected Skill Root 与项目投影内容不同；Selected Skill Root=${discovery.selectedRoot}`,
        `保留用户文件并移除/改名冲突来源；不要覆盖 ${discovery.projectRoot} 中的用户 Skill`,
      )
    }
    if (missing.length > 0) {
      const source = native ? `Selected Skill Root=${discovery.selectedRoot}` : `static root=${discovery.projectRoot}`
      return yellow(
        'integration:codex-project-skills',
        `Codex 唯一发现根缺 ${missing.length} 个 Tenon Skills：${missing.join('、')}（${source}；历史 cache 不算）`,
        native
          ? '运行 tenon setup --codex 重新校验完整插件'
          : '在无原生插件的宿主中重跑 static adapter；不要同时启用 native 与项目投影',
      )
    }
    if (duplicates.length > 0) {
      return yellow(
        'integration:codex-project-skills',
        `duplicate-projection: ${duplicates.join('、')} 同时出现在 Selected Skill Root=${discovery.selectedRoot} 与 ${discovery.projectRoot}`,
        '运行 Codex adapter 的 native 收敛路径；只会清理由 exact source ownership 证明的旧软链',
      )
    }
    return native
      ? green(
          'integration:codex-project-skills',
          `Codex contract Skills 完整；Selected Skill Root=${discovery.selectedRoot}，无项目重复投影`,
        )
      : green(
          'integration:codex-project-skills',
          `Codex contract Skills 完整；static-only Skill root=${discovery.projectRoot}`,
        )
  }

  if (p.codexProjectSkillNames === undefined) {
    return yellow(
      'integration:codex-project-skills',
      '未装配 Codex skill 探针——无法证明 normal-chat router 的包内 skill 可调用（不以 cache 假装 green）',
      '使用包含该探针的 Tenon CLI，或运行 tenon setup --codex 后重试',
    )
  }
  const installed = p.codexProjectSkillNames()
  const missing = codexProjectContractSkills().filter((name) => !installed.has(name))
  if (missing.length === 0) {
    return green(
      'integration:codex-project-skills',
      'Codex 可发现的 Tenon/OpenSpec/设计/验证 contract Skills 全部来自当前插件（normal-chat 可实际调用）',
    )
  }
  return yellow(
    'integration:codex-project-skills',
    `Codex 可发现的 Tenon Skills 缺 ${missing.length} 个：${missing.join('、')}（全局 cache 不算）`,
    '运行 tenon setup --codex 重新安装并校验完整插件；若使用非原生 adapter，再加 --target <项目目录>',
  )
}
