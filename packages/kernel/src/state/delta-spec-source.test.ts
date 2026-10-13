/**
 * delta spec 的统一来源：带文档账本的任务（升级前创建）取账本里的 delta-spec 记录；
 * 没有账本的任务（观察模式）扫描任务目录 `specs/` 下的 spec.md。
 * 扫描有界、只认普通文件、不跟随符号链接，路径不会越出任务目录。
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changeDeltaSpecPaths, DELTA_SPEC_SCAN_MAX_DEPTH, DELTA_SPEC_SCAN_MAX_ENTRIES, DeltaSpecSourceError,
} from './delta-spec-source.js'

const CHANGE = 'delta-source-demo'
const BODY = '## ADDED Requirements\n'

describe('delta spec 来源', () => {
  let root: string
  let outside: string
  let changeDir: string

  async function write(rel: string, body = BODY): Promise<void> {
    const target = join(changeDir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, 'utf8')
  }

  async function writeLedger(paths: readonly string[]): Promise<void> {
    await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
      version: 1,
      contract: 'openspec-v1',
      createdAt: '2026-09-22T00:00:00Z',
      records: paths.map((path) => ({
        kind: 'delta-spec', path, sha256: 'a'.repeat(64), producer: 'openspec-propose',
        recordedAt: '2026-09-22T00:00:00Z', reads: [],
      })),
    }, null, 2)}\n`, 'utf8')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-delta-source-'))
    outside = await mkdtemp(join(tmpdir(), 'tenon-delta-outside-'))
    changeDir = join(root, 'openspec', 'changes', CHANGE)
    await mkdir(changeDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  describe('任务有文档账本（契约模式）', () => {
    it('取账本里 delta-spec 记录的路径，不扫目录', async () => {
      const recorded = `openspec/changes/${CHANGE}/specs/recorded/spec.md`
      await write('specs/recorded/spec.md')
      await write('specs/unrecorded/spec.md')
      await writeLedger([recorded])
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([recorded])
    })

    it('账本里没有 delta-spec 记录：空（目录里有 spec.md 也不算）', async () => {
      await write('specs/unrecorded/spec.md')
      await writeLedger([])
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([])
    })

    it('账本损坏：抛错，不回退到扫目录', async () => {
      await write('specs/a/spec.md')
      await writeFile(join(changeDir, '.pipeline-documents.json'), '{not json', 'utf8')
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/document ledger/)
    })
  })

  describe('任务没有文档账本（观察模式）：扫描任务目录 specs/', () => {
    it('返回仓库相对路径，按字典序，capability 可以多级', async () => {
      await write('specs/zeta/spec.md')
      await write('specs/alpha/spec.md')
      await write('specs/group/inner/spec.md')
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([
        `openspec/changes/${CHANGE}/specs/alpha/spec.md`,
        `openspec/changes/${CHANGE}/specs/group/inner/spec.md`,
        `openspec/changes/${CHANGE}/specs/zeta/spec.md`,
      ])
    })

    it('只认名为 spec.md 的普通文件：别的文件、specs 之外的 spec.md 都不算', async () => {
      await write('specs/alpha/spec.md')
      await write('specs/alpha/notes.md')
      await write('specs/README.md')
      await write('spec.md')
      await write('design/specs/beta/spec.md')
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([
        `openspec/changes/${CHANGE}/specs/alpha/spec.md`,
      ])
    })

    it('没有 specs 目录、或 specs 目录是空的：空（本任务不产出规格增量）', async () => {
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([])
      await mkdir(join(changeDir, 'specs', 'empty'), { recursive: true })
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([])
    })

    it('名为 spec.md 的目录不是普通文件：不算，但会继续往里找', async () => {
      await mkdir(join(changeDir, 'specs', 'odd', 'spec.md'), { recursive: true })
      await write('specs/odd/spec.md/spec.md')
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([
        `openspec/changes/${CHANGE}/specs/odd/spec.md/spec.md`,
      ])
    })

    it('spec.md 是指向任务目录外的符号链接：拒绝，不当作 delta spec', async () => {
      await writeFile(join(outside, 'spec.md'), BODY, 'utf8')
      await mkdir(join(changeDir, 'specs', 'evil'), { recursive: true })
      await symlink(join(outside, 'spec.md'), join(changeDir, 'specs', 'evil', 'spec.md'))
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toBeInstanceOf(DeltaSpecSourceError)
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/符号链接/)
    })

    it('指向任务目录内另一份文件的符号链接同样拒绝（不跟随）', async () => {
      await write('specs/real/spec.md')
      await symlink(join(changeDir, 'specs', 'real', 'spec.md'), join(changeDir, 'specs', 'real', 'copy.md'))
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/符号链接/)
    })

    it('specs 下的子目录是符号链接：拒绝，不进到链接里去找', async () => {
      await writeFile(join(outside, 'spec.md'), BODY, 'utf8')
      await mkdir(join(changeDir, 'specs'), { recursive: true })
      await symlink(outside, join(changeDir, 'specs', 'linked'))
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/符号链接/)
    })

    it('specs 目录本身是符号链接（指向任务目录外）：拒绝', async () => {
      await mkdir(join(outside, 'cap'), { recursive: true })
      await writeFile(join(outside, 'cap', 'spec.md'), BODY, 'utf8')
      await symlink(outside, join(changeDir, 'specs'))
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/符号链接/)
    })

    it('specs 不是目录：拒绝', async () => {
      await write('specs', 'not a directory')
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toBeInstanceOf(DeltaSpecSourceError)
    })

    it('目录嵌套超过深度上限：拒绝，不静默截断', async () => {
      const deep = Array.from({ length: DELTA_SPEC_SCAN_MAX_DEPTH + 1 }, (_, index) => `d${index}`)
      await write(join('specs', ...deep, 'spec.md'))
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/深度/)
    })

    it('恰好在深度上限内（specs 之下 MAX_DEPTH 层目录）的 spec.md 仍可取到', async () => {
      const deep = Array.from({ length: DELTA_SPEC_SCAN_MAX_DEPTH }, (_, index) => `d${index}`)
      await write(join('specs', ...deep, 'spec.md'))
      await expect(changeDeltaSpecPaths(changeDir)).resolves.toEqual([
        `openspec/changes/${CHANGE}/${['specs', ...deep, 'spec.md'].join('/')}`,
      ])
    })

    it('条目数超过上限：拒绝，不静默截断', async () => {
      await mkdir(join(changeDir, 'specs'), { recursive: true })
      await Promise.all(Array.from({ length: DELTA_SPEC_SCAN_MAX_ENTRIES + 1 }, (_, index) =>
        mkdir(join(changeDir, 'specs', `cap-${index}`))))
      await expect(changeDeltaSpecPaths(changeDir)).rejects.toThrow(/条目/)
    })
  })
})
