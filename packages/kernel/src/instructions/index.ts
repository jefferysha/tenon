export {
  CATALOG_CATEGORIES, INSTRUCTION_CATEGORIES, TEMPLATE_SOURCES,
  categoryHeadingLevel, isCatalogCategory, isInstructionCategory, isTemplateId, isTemplateSource,
} from './categories.js'
export type { CatalogCategory, InstructionCategory, TemplateRef, TemplateSource } from './categories.js'
export { INSTRUCTION_BLOCK_MAX_BYTES, parseInstructionBlock } from './block.js'
export type { BlockError, InstructionBlock, InstructionVariable } from './block.js'
export { NO_CATALOG, composeInstructions } from './compose.js'
export type {
  CatalogEntrySummary, CatalogLookup, ComposeError, ComposeResult, ComposeSelection, ComposedDirectory,
} from './compose.js'
export {
  INSTRUCTION_HOSTS, PROJECT_INSTRUCTION_FILES, ZED_PROJECT_ORDER,
  hasUserInstructionFile, instructionHost, projectTargetsFor, userInstructionPath, zedEffectiveFile,
} from './hosts.js'
export type { InstructionHost, InstructionLevels, ProjectInstructionFile } from './hosts.js'
export {
  PROJECT_CLIENTS_DIRS, PROJECT_CLIENTS_FILE, PROJECT_CLIENTS_MAX_BYTES, PROJECT_CLIENTS_SCHEMA,
  inferProjectClients, normalizeProjectClients, parseProjectClients, serializeProjectClients,
} from './clients.js'
export type { ClientIdsResult } from './clients.js'
export { ABSENT_DIGEST, instructionDigest } from './digest.js'
export { instructionLibraryRoot } from './library-paths.js'
export {
  MANAGED_MARKER_LINE, containsManagedMarker, contentAfterDelete, mergeManagedBlocks, parseManagedBlocks,
} from './managed-blocks.js'
export type { ManagedBlock, ManagedParse } from './managed-blocks.js'
