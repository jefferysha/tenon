/**
 * 路径类：一次改动「碰到了哪类需要更多把关的地方」。纯函数，不碰文件系统。
 *
 * 两个消费者共用这一份分类，口径才不会分叉：
 *   · standard 通道的风险探针（`tenon test diff-risk`）按类计数，超过工作流里写的阈值就升级；
 *   · 评审者的 `attach_on`（例如 security 只在鉴权 / 依赖 / 契约路径变化时挂上）。
 *
 * 分类只看仓库相对路径，不读内容：目录名与文件名里的词元（`requireAuth.ts` → require / auth）以及几类
 * 众所周知的清单文件名。宁可多报：多报的代价是多一个评审者或升级到完整流程，漏报的代价是该审的没审。
 */

export const PATH_CLASSES = ['auth', 'dependency', 'contract', 'migration'] as const
export type PathClass = (typeof PATH_CLASSES)[number]

export function isPathClass(value: string): value is PathClass {
  return (PATH_CLASSES as readonly string[]).includes(value)
}

/** 路径 → 小写词元：按 `/`、标点和驼峰边界切开。 */
export function pathTokens(path: string): readonly string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase())
}

const AUTH_TOKENS: ReadonlySet<string> = new Set([
  'auth', 'authn', 'authz', 'authentication', 'authorization', 'authorize', 'authenticate', 'authenticator',
  'login', 'logout', 'signin', 'signup', 'sso', 'oauth', 'oauth2', 'oidc', 'openid', 'saml', 'jwt', 'jwk', 'jwks',
  'session', 'sessions', 'password', 'passwords', 'passwd', 'credential', 'credentials', 'secret', 'secrets',
  'permission', 'permissions', 'rbac', 'acl', 'crypto', 'cipher', 'encrypt', 'encryption', 'decrypt', 'keystore',
  'security', 'csrf', 'cors',
])

const CONTRACT_TOKENS: ReadonlySet<string> = new Set([
  'contract', 'contracts', 'schema', 'schemas', 'openapi', 'swagger', 'asyncapi', 'proto', 'protos', 'protobuf',
  'graphql', 'gql', 'idl', 'thrift', 'wsdl', 'avsc',
])

const MIGRATION_TOKENS: ReadonlySet<string> = new Set([
  'migration', 'migrations', 'migrate', 'alembic', 'flyway', 'liquibase',
])

const DEPENDENCY_BASENAMES: ReadonlySet<string> = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock',
  '.yarnrc.yml', '.npmrc', 'bun.lock', 'bun.lockb', 'deno.lock',
  'pipfile', 'pipfile.lock', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'setup.py', 'setup.cfg',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'gemfile', 'gemfile.lock',
  'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'packages.config', 'directory.packages.props', 'mix.exs', 'mix.lock',
  'pubspec.yaml', 'pubspec.lock', 'podfile', 'podfile.lock', 'package.swift', 'package.resolved',
])

const DEPENDENCY_BASENAME_PATTERNS: readonly RegExp[] = [
  /^requirements[^/]*\.txt$/,
  /^constraints[^/]*\.txt$/,
  /\.csproj$/,
  /\.fsproj$/,
  /\.vbproj$/,
]

const CONTRACT_BASENAME_PATTERNS: readonly RegExp[] = [
  /\.proto$/, /\.graphql$/, /\.gql$/, /\.prisma$/, /\.thrift$/, /\.wsdl$/, /\.xsd$/,
  /(^|[._-])schema\.json$/, /^openapi[^/]*\.(json|ya?ml)$/, /^swagger[^/]*\.(json|ya?ml)$/,
]

const AUTH_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.crt$/, /\.p12$/, /\.pfx$/, /\.keystore$/,
]

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return (slash < 0 ? path : path.slice(slash + 1)).toLowerCase()
}

/** 一个仓库相对路径（正斜杠）命中的路径类；都不命中返回空数组。 */
export function classifyPath(path: string): readonly PathClass[] {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const base = basenameOf(normalized)
  const tokens = pathTokens(normalized)
  const classes: PathClass[] = []
  if (tokens.some((token) => AUTH_TOKENS.has(token)) || AUTH_BASENAME_PATTERNS.some((re) => re.test(base))) {
    classes.push('auth')
  }
  if (DEPENDENCY_BASENAMES.has(base) || DEPENDENCY_BASENAME_PATTERNS.some((re) => re.test(base))) {
    classes.push('dependency')
  }
  if (tokens.some((token) => CONTRACT_TOKENS.has(token)) || CONTRACT_BASENAME_PATTERNS.some((re) => re.test(base))) {
    classes.push('contract')
  }
  if (tokens.some((token) => MIGRATION_TOKENS.has(token))) classes.push('migration')
  return classes
}
