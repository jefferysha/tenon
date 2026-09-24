/**
 * 相位出口规则表的文件面上下文：实现归 kernel（`phaseExitGuardContext`），CLI 的 check / status /
 * transition 与 Dashboard 快照读同一份。这里只保留 CLI 既有的导入路径。
 */
export { phaseExitGuardContext, type PhaseExitGuardContext } from '@tenon/kernel'
