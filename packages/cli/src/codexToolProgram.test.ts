import { describe, expect, it } from 'vitest'
import { transcriptExecInvocations } from './codexToolProgram.js'

describe('Codex transcript exec program', () => {
  it('accepts the real exec_command wrapper with a safe max_output_tokens value', () => {
    const expected = [{
      command: 'cat /trusted/SKILL.md',
      workdir: '/repo',
    }]
    expect(transcriptExecInvocations(
      'const r = await tools.exec_command({cmd:"cat /trusted/SKILL.md",workdir:"/repo",yield_time_ms:10000,max_output_tokens:20000}); text(r)',
    )).toEqual(expected)
    expect(transcriptExecInvocations(
      `const r = await tools.exec_command(${JSON.stringify({
        cmd: 'cat /trusted/SKILL.md',
        workdir: '/repo',
        yield_time_ms: 10_000,
        max_output_tokens: 20_000,
      })}); text(r)`,
    )).toEqual(expected)
  })

  it('accepts the pretty-printed current host wrapper with a descriptive result binding', () => {
    expect(transcriptExecInvocations(`const result = await tools.exec_command({
  cmd: "cat /trusted/SKILL.md",
  workdir: "/repo",
  yield_time_ms: 10000,
  max_output_tokens: 20000
});
text(result);
`)).toEqual([{
      command: 'cat /trusted/SKILL.md',
      workdir: '/repo',
    }])
  })

  it('accepts the host output-budget pragma when stdout is still verified byte-for-byte', () => {
    expect(transcriptExecInvocations(`// @exec: {"yield_time_ms":30000,"max_output_tokens":30000}
const r = await tools.exec_command({cmd:"cat /trusted/SKILL.md",max_output_tokens:30000}); text(r);
`)).toEqual([{ command: 'cat /trusted/SKILL.md' }])
  })

  it('accepts the single-expression wrapper that forwards the complete awaited result', () => {
    expect(transcriptExecInvocations(
      'text(await tools.exec_command({cmd:"cat /trusted/SKILL.md",max_output_tokens:6500}));\n',
    )).toEqual([{ command: 'cat /trusted/SKILL.md' }])
    expect(transcriptExecInvocations(`// @exec: {"max_output_tokens":6500}
text(await tools.exec_command({
  cmd: "cat /trusted/SKILL.md",
  workdir: "/repo"
}))
`)).toEqual([{ command: 'cat /trusted/SKILL.md', workdir: '/repo' }])
  })

  it.each([
    ['stdout only', 'text(await tools.exec_command({cmd:"cat /trusted/SKILL.md"}).output);'],
    ['not awaited', 'text(tools.exec_command({cmd:"cat /trusted/SKILL.md"}));'],
    ['extra statement', 'text(await tools.exec_command({cmd:"cat /trusted/SKILL.md"})); text("Script completed");'],
    ['leading statement', 'text("ok"); text(await tools.exec_command({cmd:"cat /trusted/SKILL.md"}));'],
    ['wrapped result', 'text(JSON.stringify(await tools.exec_command({cmd:"cat /trusted/SKILL.md"})));'],
    ['bound but stdout only', 'const r = await tools.exec_command({cmd:"cat /trusted/SKILL.md"}); text(r.output);'],
  ])('rejects a program that does not forward exactly one complete result: %s', (_label, program) => {
    expect(transcriptExecInvocations(program)).toEqual([])
  })

  it.each([
    '0',
    '-1',
    '1.5',
    '9007199254740992',
    '"20000"',
    'true',
    'null',
    'dynamicLimit',
  ])('rejects an unsafe max_output_tokens value: %s', (value) => {
    expect(transcriptExecInvocations(
      `const r = await tools.exec_command({cmd:"cat /trusted/SKILL.md",max_output_tokens:${value}}); text(r)`,
    )).toEqual([])
  })
})
