/**
 * `next` 里与文档有关的动作：写入（铺骨架 / 登记 / 重新登记）、技能欠的文档，以及读输入文档时
 * 附带的可改范围说明。顺序仍由 statusStepNext.ts 的 `stepNextActions` 一处决定，这里只造动作。
 */
import { aliasesForSkill } from '@tenon/kernel'
import type { StepAction } from './statusStepAction.js'
import type { StepDocumentsView, StepDocumentView, StepSkillView } from './statusStepParts.js'

/**
 * 文档写入动作：本步产出铺骨架并登记；本步可改的、以及只读输入里已登记又变了的，重新登记。
 *
 * 三条从前都不成立的规则各自对应一条真机死路：
 *   · `scaffold-document` 写完文件，台账仍是 `missing`（只有 record 才会登记），`next` 于是原样
 *     再发一遍同一条 scaffold——文件写对了，状态一步不动。骨架与登记是一对动作，一起下发。
 *   · `role: update` 的槽是「本步可以改它」，不是「本步必须产出它」——文档取证层早就是这个口径
 *     （update 槽从不进 blockers）。当成必须产出时，前端 `ship` 会被要求 scaffold 一份 contract
 *     里根本没声明为产出的 `design-md`，命令当场拒：未登记的 update 槽不发任何动作。
 *   · 只读输入被改动后状态是 `stale`，`document read` 当场拒（「已变更；先重新 record 后再 read」），
 *     它要的是一次重新登记。
 * producers 一律取该文档在**当前步**合法的那组——登记命令认的就是这一组。
 */
export function documentWriteActions(documents: StepDocumentsView): readonly StepAction[] {
  const actions: StepAction[] = []
  const seen = new Set<string>()
  const push = (doc: StepDocumentView, scaffold: boolean): void => {
    if (seen.has(doc.kind)) return
    seen.add(doc.kind)
    // path=null 时 path_template 说明还缺哪个变量（delta-spec 缺 {capability}，由作者拍板后
    // 经 `tenon document scaffold <change> delta-spec --capability <x>` 定下来）。
    const shape = {
      kind: doc.kind,
      path: doc.path,
      path_template: doc.path_template,
      producers: doc.producers,
    }
    if (scaffold) actions.push({ action: 'scaffold-document', ...shape })
    actions.push({ action: 'record-document', ...shape })
  }
  for (const doc of documents.records) {
    if (doc.status === 'missing' || doc.status === 'stale') push(doc, doc.status === 'missing')
  }
  for (const doc of [...documents.updates, ...documents.reads]) {
    if (doc.status === 'stale' && doc.producers.length > 0) push(doc, false)
  }
  return actions
}

/**
 * 已调用、但契约绑定给它的文档还没在本次步骤访问里登记的技能：剩下的就是登记那些文档。
 *
 * 文档在台账上可能已是 `recorded`（上一次访问登记过，verify-fail 回来后的第二次 verify 就是这样），
 * 按台账状态派的写入分支因此一条都不会发；这里按技能欠的 kind 发，缺文件时连骨架一起。
 * producers 收窄到与该技能等价的那几个——登记者必须是它，别的合法 producer 不能替它交作业。
 */
export function skillDocumentActions(
  skills: readonly StepSkillView[],
  documents: StepDocumentsView,
): readonly StepAction[] {
  const actions: StepAction[] = []
  const seen = new Set<string>()
  for (const skill of skills) {
    if (skill.status !== 'invoked') continue
    const aliases = new Set(aliasesForSkill(skill.id))
    for (const kind of skill.pending_documents) {
      const doc = documents.records.find((candidate) => candidate.kind === kind)
      if (doc === undefined || seen.has(kind)) continue
      seen.add(kind)
      const own = doc.producers.filter((producer) =>
        aliasesForSkill(producer).some((alias) => aliases.has(alias)))
      const shape = {
        kind: doc.kind,
        path: doc.path,
        path_template: doc.path_template,
        producers: own.length > 0 ? own : doc.producers,
        skill: skill.id,
      }
      if (doc.status === 'missing') actions.push({ action: 'scaffold-document', ...shape })
      actions.push({ action: 'record-document', ...shape })
    }
  }
  return actions
}

/**
 * 输入文档在本步能不能改：读清单里同时出现在 `updates`（契约 role update）的 kind 本步可以改，
 * 改完照 `next` 重新登记；其余只读。真机第四轮：explore 里模型改了 open 登记的 design / tasks，
 * 登记随之失效，而动作里一句都没说哪些能动。需求语义要变走 `requirements-changed`（回到规格步）；
 * tasks 只勾当前步骤标题下的复选框。
 */
export function inputDocumentPolicy(documents: StepDocumentsView): { readonly editable: readonly string[]; readonly note: string } {
  const updatable = new Set(documents.updates.map((doc) => doc.kind))
  const editable = [...new Set(documents.reads.map((doc) => doc.kind).filter((kind) => updatable.has(kind)))]
  const scope = editable.length > 0
    ? `本步可以改的只有 ${editable.join(' / ')}（改完照 next 重新登记）；其余只读`
    : '本步全部只读'
  return {
    editable,
    note: `读进上下文（不要丢弃输出）后再 tenon document read。这些是已登记的输入文档：${scope}。`
      + '需求语义变了走 requirements-changed 回到规格步，不要直接改已登记的规格文档；tasks.md 只勾当前步骤标题下的复选框。',
  }
}
