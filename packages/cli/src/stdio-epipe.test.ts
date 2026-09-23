import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { exitQuietlyOnEpipe } from './stdio-epipe.js'

describe('exitQuietlyOnEpipe', () => {
  test('EPIPE on a stream exits quietly; other stream errors are rethrown', () => {
    const stream = new EventEmitter()
    let exits = 0
    exitQuietlyOnEpipe([stream], () => { exits++ })
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(exits).toBe(1)
    expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }))).toThrow('boom')
    expect(exits).toBe(1)
  })

  test('a real process writing into a closed pipe ends without a stack trace', async () => {
    const helper = fileURLToPath(new URL('./stdio-epipe.ts', import.meta.url))
    const script = [
      `const { exitQuietlyOnEpipe } = await import(${JSON.stringify(helper)})`,
      'exitQuietlyOnEpipe([process.stdout, process.stderr], () => process.exit())',
      "const line = 'x'.repeat(1024) + '\\n'",
      'for (let i = 0; i < 4096; i++) process.stdout.write(line)',
    ].join('\n')
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdout.once('data', () => child.stdout.destroy())
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(stderr).not.toMatch(/Unhandled 'error' event|EPIPE|\n\s+at /u)
    expect(code).toBe(0)
  })
})
