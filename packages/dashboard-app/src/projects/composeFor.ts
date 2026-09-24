import { composeInstructions } from '../api/instructionsClient'
import { selectionKey, type TemplateSelection } from './TemplateStep'

/** 按所选模板与各自的变量值拼出指令正文与骨架目录；变量值按 `<source>/<category>/<id>::<key>` 记。 */
export async function composeFor(
  projectName: string, selected: readonly TemplateSelection[], values: Readonly<Record<string, string>>,
): Promise<{ markdown: string; directories: string[] }> {
  const composed = await composeInstructions(projectName, selected.map((item) => {
    const prefix = `${selectionKey(item)}::`
    return {
      ...item,
      values: Object.fromEntries(Object.entries(values)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value])),
    }
  }))
  return { markdown: composed.markdown, directories: composed.directories.map((entry) => entry.path) }
}
