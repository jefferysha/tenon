import { describe, expect, it, vi } from 'vitest'
import { workflowNamesUnder, type WorkflowDirectoryReader } from './workflow-global-store.js'

describe('workflow global store node adapter', () => {
  it('reads only workflow YAML names through the directory port', () => {
    const reader: WorkflowDirectoryReader = {
      exists: vi.fn(() => true),
      entries: vi.fn(() => ['default.yaml', 'notes.txt', 'draft.yaml.bak', 'custom.yaml']),
    }

    expect(workflowNamesUnder('/repo', reader)).toEqual(['default', 'custom'])
    expect(reader.exists).toHaveBeenCalledWith('/repo/.pipeline/workflows')
    expect(reader.entries).toHaveBeenCalledWith('/repo/.pipeline/workflows')
  })

  it('returns an empty list when the workflow directory is absent', () => {
    const reader: WorkflowDirectoryReader = {
      exists: () => false,
      entries: () => {
        throw new Error('must not enumerate a missing directory')
      },
    }

    expect(workflowNamesUnder('/missing', reader)).toEqual([])
  })
})
