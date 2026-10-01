import { describe, expect, test } from 'vitest'
import { PATH_CLASSES, classifyPath, isPathClass, pathTokens } from './path-classes.js'

describe('pathTokens', () => {
  test('按目录、标点和驼峰边界切成小写词元', () => {
    expect(pathTokens('src/middleware/requireAuth.ts')).toEqual(['src', 'middleware', 'require', 'auth', 'ts'])
    expect(pathTokens('db/migrations/20260101_add-users.sql')).toEqual(['db', 'migrations', '20260101', 'add', 'users', 'sql'])
  })
})

describe('classifyPath', () => {
  test.each([
    ['src/auth/login.js', ['auth']],
    ['src/middleware/requireAuth.ts', ['auth']],
    ['lib/session_store.py', ['auth']],
    ['config/.env.production', ['auth']],
    ['certs/server.pem', ['auth']],
    ['package.json', ['dependency']],
    ['packages/web/package-lock.json', ['dependency']],
    ['requirements-dev.txt', ['dependency']],
    ['go.sum', ['dependency']],
    ['services/api/Gemfile.lock', ['dependency']],
    ['app/App.csproj', ['dependency']],
    ['api/openapi.yaml', ['contract']],
    ['proto/user.proto', ['contract']],
    ['src/schema.graphql', ['contract']],
    ['src/schemas/user.ts', ['contract']],
    ['db/migrations/001_init.sql', ['migration']],
    ['prisma/migrate/seed.ts', ['migration']],
    // 同时命中多类
    ['src/auth/schema.json', ['auth', 'contract']],
  ] as const)('%s → %j', (path, expected) => {
    expect(classifyPath(path)).toEqual(expected)
  })

  test.each([
    'src/add.js', 'test/add.test.js', 'src/author.js', 'src/tokenizer.js', 'README.md', 'src/utils/format.ts',
    'src/changelog.ts',
  ])('%s 不命中任何路径类', (path) => {
    expect(classifyPath(path)).toEqual([])
  })

  test('闭集与类型守卫', () => {
    expect([...PATH_CLASSES]).toEqual(['auth', 'dependency', 'contract', 'migration'])
    expect(isPathClass('auth')).toBe(true)
    expect(isPathClass('secrets')).toBe(false)
  })
})
