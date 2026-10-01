import { describe, expect, it } from 'vitest'
import {
  MAX_REDACTED_LINE_CHARS, redactCredentials, redactForSharing, totalRedactions,
} from './redact.js'

const SECRETS = [
  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  'xoxb-1234567890-abcdefghijkl',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  'npm_0123456789abcdefghijklmnopqrstuvwxyz',
]

describe('redactCredentials · 凭证', () => {
  it('抹掉常见前缀的 token，计数并保留周围的文字', () => {
    for (const secret of SECRETS) {
      const result = redactCredentials(`calling api with ${secret} now`)
      expect(result.text, secret).toBe('calling api with [REDACTED:token] now')
      expect(result.counts.token, secret).toBe(1)
    }
  })

  it('Authorization 头整行抹掉，Bearer/Basic 值抹掉但保留方案名', () => {
    expect(redactCredentials('Authorization: Bearer abcdefghijklmnop').text).toBe('Authorization: [REDACTED:token]')
    expect(redactCredentials('proxy-authorization: Basic dXNlcjpwYXNz').text).toBe('proxy-authorization: [REDACTED:token]')
    expect(redactCredentials('retry with Bearer abcdefghijklmnop.q').text).toBe('retry with Bearer [REDACTED:token]')
  })

  it('Cookie / Set-Cookie 整行抹掉（含会话 cookie 的值）', () => {
    const lines = [
      'Cookie: tenon_session_18765=0123456789abcdef; theme=dark',
      'Set-Cookie: tenon_session_18765=0123456789abcdef; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict',
    ].join('\n')
    const result = redactCredentials(lines)
    expect(result.text).toBe('Cookie: [REDACTED:cookie]\nSet-Cookie: [REDACTED:cookie]')
    expect(result.counts.cookie).toBe(2)
  })

  it('键名里带 token / secret / password / session 等字样的值被抹掉，引号保留', () => {
    const cases: Array<[string, string]> = [
      ['TOKEN=abc123def456', 'TOKEN=[REDACTED:token]'],
      ['api_key: "abc123"', 'api_key: "[REDACTED:token]"'],
      ['{"password":"hunter2","user":"bob"}', '{"password":"[REDACTED:token]","user":"bob"}'],
      ["client_secret='s3cr3t'", "client_secret='[REDACTED:token]'"],
      ['--token abcdef123456 --verbose', '--token [REDACTED:token] --verbose'],
      ['--api-key=abc123', '--api-key=[REDACTED:token]'],
      ['tenon_session_18765=0123456789abcdef', 'tenon_session_18765=[REDACTED:cookie]'],
      ['TENON_HOST_SESSION_ID=abc-123', 'TENON_HOST_SESSION_ID=[REDACTED:cookie]'],
    ]
    for (const [input, expected] of cases) expect(redactCredentials(input).text, input).toBe(expected)
  })

  it('一次性登录码与在场 nonce 在 URL 查询里被抹掉，路径保留', () => {
    const result = redactCredentials('GET /session/start?code=Zm9vYmFyMTIzNDU2&next=%2F 302')
    expect(result.text).toBe('GET /session/start?code=[REDACTED:token]&next=%2F 302')
    expect(redactCredentials('open http://127.0.0.1:18765/auth?presence_nonce=abcd1234').text)
      .toBe('open http://127.0.0.1:18765/auth?presence_nonce=[REDACTED:token]')
  })

  it('URL 里的用户名密码被抹掉，主机保留', () => {
    const result = redactCredentials('git clone https://bob:hunter2@example.com/org/repo.git')
    expect(result.text).toBe('git clone https://[REDACTED:credentials]@example.com/org/repo.git')
    expect(result.counts['credential-url']).toBe(1)
  })

  it('私钥块（含被截断的）整体抹掉', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----'
    expect(redactCredentials(`before\n${block}\nafter`).text).toBe('before\n[REDACTED:private-key]\nafter')
    const truncated = redactCredentials('log tail\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg')
    expect(truncated.text).toBe('log tail\n[REDACTED:private-key]')
    expect(truncated.counts['private-key']).toBe(1)
  })

  it('键名带敏感字样但值是对象 / 数组时只是结构，不当成秘密抹掉（JSON 保持可解析）', () => {
    const json = JSON.stringify({ secrets: { configuredKeys: ['OPENAI_API_KEY'] }, tokens: [], session: { id: 'x', token: 'abc123' } }, null, 2)
    const result = redactCredentials(json)
    expect(() => JSON.parse(result.text)).not.toThrow()
    expect(JSON.parse(result.text)).toEqual({ secrets: { configuredKeys: ['OPENAI_API_KEY'] }, tokens: [], session: { id: 'x', token: '[REDACTED:token]' } })
  })

  it('无害的值与普通文字不动', () => {
    const text = 'session: null\ntoken: true\nthe session started at 12:00\ncode: 1\nstate=ready'
    const result = redactCredentials(text)
    expect(result.text).toBe(text)
    expect(totalRedactions(result.counts)).toBe(0)
  })

  it('幂等：对已脱敏文本再跑一遍，文字和计数都不变', () => {
    const once = redactCredentials(`Authorization: Bearer abcdefghijklmnop\ntoken=abc123\n${SECRETS.join(' ')}`)
    const twice = redactCredentials(once.text)
    expect(twice.text).toBe(once.text)
    expect(totalRedactions(twice.counts)).toBe(0)
  })

  it('超长行被截断，凭证不会因为截断点而漏出', () => {
    const long = `${'x'.repeat(MAX_REDACTED_LINE_CHARS + 500)} token=abc123`
    const result = redactCredentials(long)
    expect(result.text.length).toBeLessThan(long.length)
    expect(result.text.endsWith('…[line truncated]')).toBe(true)
    expect(result.text).not.toContain('abc123')
  })
})

describe('redactForSharing · 个人信息', () => {
  const home = '/Users/alice'

  it('已知 home 折成 ~，路径其余部分保留', () => {
    const result = redactForSharing(`cwd=${home}/code/app config ${home}`, { homeDirs: [home] })
    expect(result.text).toBe('cwd=~/code/app config ~')
    expect(result.counts['home-path']).toBe(2)
  })

  it('没传 home 时也折叠 /Users/<名>、/home/<名>、C:\\Users\\<名>，路径里的账户名随之消失', () => {
    const text = [
      '/Users/bob/Library/Application Support/tenon/state',
      '"/home/carol/.local/state/tenon"',
      'C:\\Users\\Dave\\AppData\\Local\\tenon',
      '{"path":"C:\\\\Users\\\\Erin\\\\AppData"}',
      '/Users/Shared/keep',
    ].join('\n')
    const result = redactForSharing(text)
    expect(result.text).toBe([
      '~/Library/Application Support/tenon/state',
      '"~/.local/state/tenon"',
      '~\\AppData\\Local\\tenon',
      '{"path":"~\\\\AppData"}',
      '/Users/Shared/keep',
    ].join('\n'))
    for (const name of ['bob', 'carol', 'Dave', 'Erin']) expect(result.text).not.toContain(name)
  })

  it('不会把 home 目录里嵌套的 /home/ 子目录再折一次', () => {
    expect(redactForSharing('/Users/bob/home/projects').text).toBe('~/home/projects')
  })

  it('home 的 realpath 变体（带符号链接目录）也折叠，且只在路径边界上匹配', () => {
    const result = redactForSharing('a /private/var/u1/me/x b /private/var/u1/meow/y', { homeDirs: ['/private/var/u1/me'] })
    expect(result.text).toBe('a ~/x b /private/var/u1/meow/y')
  })

  it('邮箱被抹掉；ssh 远端 git@host 不是个人信息，保留', () => {
    const result = redactForSharing('Alice <alice@example.com> pushed to git@github.com:org/repo.git')
    expect(result.text).toBe('Alice <[REDACTED:email]> pushed to git@github.com:org/repo.git')
    expect(result.counts.email).toBe(1)
  })

  it('已知用户名整词抹掉（不分大小写），子串不动；过短或太通用的名字不处理', () => {
    const result = redactForSharing('owner Zhangsan-pc, ZHANGSAN logged in; zhangsanfeng stays; root user', {
      userNames: ['zhangsan', 'ab', 'root'],
    })
    expect(result.text).toBe('owner [REDACTED:user]-pc, [REDACTED:user] logged in; zhangsanfeng stays; root user')
    expect(result.counts['user-name']).toBe(2)
  })

  it('同时包含凭证、邮箱、路径、用户名的日志行：一个都不剩', () => {
    const line = '[2026-10-01T10:00:00Z] user=Zhangsan <zhangsan@example.com> token=abcdef123456 cwd=/Users/zhangsan/work/app'
    const result = redactForSharing(line, { homeDirs: ['/Users/zhangsan'], userNames: ['Zhangsan'] })
    expect(result.text).toBe('[2026-10-01T10:00:00Z] user=[REDACTED:user] <[REDACTED:email]> token=[REDACTED:token] cwd=~/work/app')
    expect(totalRedactions(result.counts)).toBe(4)
  })

  it('幂等：重复脱敏不再改动也不再计数', () => {
    const options = { homeDirs: ['/Users/zhangsan'], userNames: ['Zhangsan'] }
    const once = redactForSharing('zhangsan@example.com /Users/zhangsan/x token=abc123', options)
    const twice = redactForSharing(once.text, options)
    expect(twice.text).toBe(once.text)
    expect(totalRedactions(twice.counts)).toBe(0)
  })
})
