import { appendFile, readFile } from 'node:fs/promises'
import type { ReviewDecisionLedgerFs } from '../decision/idempotency.js'

/** Node filesystem adapter for the Change-owned review decision ledger. */
export const nodeReviewDecisionLedgerFs: ReviewDecisionLedgerFs = {
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  },
  appendText: async (path, text) => {
    await appendFile(path, text, { encoding: 'utf8', flag: 'a', mode: 0o600 })
  },
}
