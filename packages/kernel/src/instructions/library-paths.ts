import { resolveProductPaths, type ProductPathInput } from '../product-paths.js'

/** 模板库根目录 `<configRoot>/templates/instructions`（下分 builtin/ 与 custom/）。 */
export function instructionLibraryRoot(input: ProductPathInput = {}): string {
  const configRoot = resolveProductPaths(input).configRoot
  const separator = configRoot.includes('\\') && !configRoot.includes('/') ? '\\' : '/'
  return [configRoot.replace(/[\\/]+$/u, ''), 'templates', 'instructions'].join(separator)
}
