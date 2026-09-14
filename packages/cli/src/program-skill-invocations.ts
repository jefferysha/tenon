import type { Command } from 'commander'
import type { CliDeps } from './deps.js'
import { cmdInternalCodexSkillReceipt } from './codexSkillReceipt.js'
import { cmdInternalHostInteraction } from './commands/hostInteraction.js'
import { cmdInternalNativeSkillReceipt } from './nativeSkillReceipt.js'
import { cmdInternalSelfApproval } from './commands/internalSelfApproval.js'
import { bail } from './program-exit.js'

export function registerSkillInvocationInternalCommands(program: Command, deps: CliDeps): void {
  program
    .command('internal-codex-skill-receipt <changeName> <skillId> <skillPath> <transcriptPath> <sessionId> <turnId> <toolUseId>')
    .description('[内部] 仅登记 Codex PreToolUse 的待核验 skill receipt；不会直接写完成证据')
    .action(async (
      changeName: string,
      skillId: string,
      skillPath: string,
      transcriptPath: string,
      sessionId: string,
      turnId: string,
      toolUseId: string,
    ) => bail(await cmdInternalCodexSkillReceipt(
      deps, changeName, skillId, skillPath, transcriptPath, sessionId, turnId, toolUseId,
    )))

  program
    .command('internal-native-skill-receipt <changeName> <skillId> <sessionId> <toolUseId> <observedAt>')
    .description('[内部] 将 native Skill PostToolUse 绑定到 canonical current StepVisit 并开始 invocation')
    .action(async (
      changeName: string, skillId: string, sessionId: string, toolUseId: string, observedAt: string,
    ) => bail(await cmdInternalNativeSkillReceipt(
      deps, changeName, skillId, sessionId, toolUseId, observedAt,
    )))

  program
    .command('internal-host-interaction <changeName> <payloadPath>')
    .description('[内部] 将 native host 的结构化问答绑定到同 session 的 canonical active invocation')
    .action(async (changeName: string, payloadPath: string) =>
      bail(await cmdInternalHostInteraction(deps, changeName, payloadPath)))

  program
    .command('internal-self-approval <payloadPath> [changeName]')
    .description('[内部] 记录 pending review 的脱敏自审批检测信号')
    .action(async (payloadPath: string, changeName: string | undefined) =>
      bail(await cmdInternalSelfApproval(deps, payloadPath, changeName)))
}
