/**
 * doctor 的 Codex Skill 发现面：Codex 正常对话要调用的那批 Skill，此刻到底从哪个根被发现。
 *
 * 判定顺序是宿主登记 → 唯一发现根 → 项目投影；每一步不成立都得说清是哪一步，而不是笼统报缺。
 * 这台机器上根本没有 Codex 时，这项检查不适用——doctor 同屏的 `auth:codex` 用的是同一判定。
 */
import type { DoctorProbes, HostPluginInventorySource } from '../deps.js'
import {
  LEGACY_PLUGIN_IDENTITY,
  TENON_PLUGIN_IDENTITY,
} from '../migration/legacy-tenon-migration.js'
import { PRODUCT_IDENTITY } from '@tenon/kernel'
import { green, yellow, red, type DoctorCheck } from './doctor-check.js'
import { activeHost } from './doctor-host.js'
import { declaredWorkflowSkillIds } from './doctor-skills.js'

/**
 * 这台机器上「Codex 参与了」的证据：当前会话宿主是 Codex，或已安装的 native runtime 宿主是
 * Codex，或宿主 plugin inventory 报的就是 Codex。三条都不成立、项目里也一个 Skill 都没投影过时，
 * 这项检查在给一个不存在的宿主打分。
 */
async function codexInPlay(
  p: DoctorProbes,
  inventory: HostPluginInventorySource | undefined,
): Promise<boolean> {
  if ((inventory?.kind === 'native' || inventory?.kind === 'unavailable') && inventory.host === 'codex') {
    return true
  }
  return await activeHost(p) === 'codex'
}

/**
 * 真机实测的缺陷（acceptance run）：doctor 对一个非 Codex 项目先打
 * `[PASS] auth:codex 当前会话宿主非 Codex`，两行之后又打
 * `[WARN] integration:codex-project-skills Codex 唯一发现根缺 17 个 Tenon Skills`。同一屏上两句
 * 互相打脸，而后者要求的修复（重跑 static adapter）在一个不用 Codex 的项目里毫无意义。
 */
function notApplicable(): DoctorCheck {
  return green(
    'integration:codex-project-skills',
    '此项目未启用 Codex（无 Codex 宿主登记，项目里也没有 Skill 投影）；Codex Skill 发现检查不适用',
  )
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
    if (!native && discovery.project.size === 0 && !(await codexInPlay(p, inventory))) {
      return notApplicable()
    }
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
  if (missing.length > 0 && installed.size === 0 && !(await codexInPlay(p, inventory))) {
    return notApplicable()
  }
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
