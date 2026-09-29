/**
 * `tenon test catalog show|validate|add|set|rm` —— 项目测试目录（.tenon/tests/catalog.yaml）的查看与编辑。
 * 目录是人可直接改的配置；这些命令只是不必手写 YAML 的入口，写出前整份重新解析，写坏的目录进不了盘。
 * 退出码：0 成功，2 validate 发现问题，1 用法 / 环境错误。
 */
import { serializeTestCatalog, type CatalogService, type CatalogSuite, type TestCatalog, type TestDirectionDef } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { readCatalogFile, updateCatalog, type CatalogFile } from '../test-system/project-files.js'
import { buildService, buildSuite, type ServiceOptions, type SuiteOptions } from './test-catalog-edit.js'

function fail(deps: CliDeps, message: string): number {
  deps.io.err(`ERROR: ${message}`)
  return 1
}

function needCatalog(deps: CliDeps, file: CatalogFile): TestCatalog | number {
  if (file.state === 'ok') return file.catalog
  if (file.state === 'missing') return fail(deps, '还没有测试目录（.tenon/tests/catalog.yaml）；tenon test discover --write 或 tenon test catalog add')
  deps.io.err(`ERROR: catalog.yaml 无效：\n${file.issues.slice(0, 8).map((line) => `  ${line}`).join('\n')}`)
  return 1
}

function suiteLine(suite: CatalogSuite): string {
  const services = suite.services.length === 0 ? '' : `  services=${suite.services.join(',')}`
  return `  ${suite.id}  ${suite.kind}/${suite.runner}  cwd=${suite.cwd}  report=${suite.report.format}${suite.report.path === undefined ? '' : `:${suite.report.path}`}${services}  ${suite.command}`
}

function serviceLine(service: CatalogService): string {
  const ready = 'url' in service.ready ? `url ${service.ready.url}` : 'port' in service.ready ? `port ${service.ready.port}` : `log "${service.ready.log}"`
  return `  ${service.id}  ready=${ready} (${service.ready.timeout_s}s)  ${service.start}`
}

export async function cmdCatalogShow(deps: CliDeps, id: string | undefined, opts: { readonly json?: boolean }): Promise<number> {
  const catalog = needCatalog(deps, await readCatalogFile(deps.cwd))
  if (typeof catalog === 'number') return catalog
  if (id !== undefined) {
    const suite = catalog.suites.find((item) => item.id === id)
    const service = catalog.services.find((item) => item.id === id)
    if (suite === undefined && service === undefined) return fail(deps, `目录里没有 '${id}'（套件：${catalog.suites.map((item) => item.id).join(', ') || '无'}）`)
    if (opts.json === true) deps.io.out(JSON.stringify(suite ?? service, null, 2))
    else {
      const only: TestCatalog = { ...catalog, profiles_env: [], suites: suite === undefined ? [] : [suite], services: suite === undefined && service !== undefined ? [service] : catalog.services.filter((item) => suite?.services.includes(item.id) === true) }
      deps.io.out(serializeTestCatalog(only).trimEnd())
    }
    return 0
  }
  if (opts.json === true) {
    deps.io.out(JSON.stringify(catalog, null, 2))
    return 0
  }
  deps.io.out(`[TEST] 目录：${catalog.suites.length} 个套件，${catalog.services.length} 个服务`)
  for (const suite of catalog.suites) deps.io.out(suiteLine(suite))
  if (catalog.services.length > 0) deps.io.out('  服务：')
  for (const service of catalog.services) deps.io.out(serviceLine(service))
  return 0
}

export async function cmdCatalogValidate(deps: CliDeps, opts: { readonly json?: boolean }): Promise<number> {
  const file = await readCatalogFile(deps.cwd)
  if (file.state === 'missing') return fail(deps, '还没有测试目录（.tenon/tests/catalog.yaml）')
  const issues = file.state === 'invalid' ? file.issues : []
  if (opts.json === true) {
    deps.io.out(JSON.stringify({ valid: issues.length === 0, issues }, null, 2))
    return issues.length === 0 ? 0 : 2
  }
  if (issues.length === 0 && file.state === 'ok') {
    deps.io.out(`[TEST] catalog.yaml 有效（${file.catalog.suites.length} 个套件，${file.catalog.services.length} 个服务）`)
    return 0
  }
  for (const issue of issues) deps.io.err(`  ${issue}`)
  deps.io.err(`[FAIL] catalog.yaml 有 ${issues.length} 处问题`)
  return 2
}

async function loadDirection(deps: CliDeps, id: string): Promise<{ readonly direction: TestDirectionDef } | { readonly message: string }> {
  const library = await deps.testDirections?.()
  if (library === undefined) return { message: '当前环境读不到测试方向库' }
  const direction = library.find((item) => item.id === id)
  return direction === undefined
    ? { message: `测试方向库里没有 '${id}'（可选：${library.map((item) => item.id).join(', ') || '无'}）` }
    : { direction }
}

export async function cmdCatalogAdd(
  deps: CliDeps,
  idArgument: string | undefined,
  options: { readonly service?: boolean } & SuiteOptions & ServiceOptions,
): Promise<number> {
  const id = idArgument ?? options.from
  if (id === undefined) return fail(deps, 'add 需要一个 id（或 --from <测试方向>，id 默认取方向 id）')
  if (options.service === true) {
    const outcome = await updateCatalog(deps.cwd, (catalog) => {
      if (catalog.services.some((item) => item.id === id)) return `服务 '${id}' 已存在；用 tenon test catalog set ${id} --service 修改`
      const service = buildService(id, undefined, options)
      return typeof service === 'string' ? service : { catalog: { ...catalog, services: [...catalog.services, service] }, value: id }
    })
    if (!outcome.ok) return fail(deps, outcome.message)
    deps.io.out(`[TEST] 已添加服务 ${id}`)
    return 0
  }
  let direction: TestDirectionDef | undefined
  if (options.from !== undefined) {
    const loaded = await loadDirection(deps, options.from)
    if ('message' in loaded) return fail(deps, loaded.message)
    direction = loaded.direction
  }
  const outcome = await updateCatalog(deps.cwd, (catalog) => {
    if (catalog.suites.some((item) => item.id === id)) return `套件 '${id}' 已存在；用 tenon test catalog set ${id} 修改`
    const suite = buildSuite(id, undefined, options, direction)
    return typeof suite === 'string' ? suite : { catalog: { ...catalog, suites: [...catalog.suites, suite] }, value: id }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  deps.io.out(`[TEST] 已添加套件 ${id}${direction === undefined ? '' : `（来自测试方向 ${direction.id}）`}`)
  return 0
}

export async function cmdCatalogSet(
  deps: CliDeps,
  id: string,
  options: { readonly service?: boolean } & SuiteOptions & ServiceOptions,
): Promise<number> {
  const outcome = await updateCatalog(deps.cwd, (catalog) => {
    if (options.service === true) {
      const current = catalog.services.find((item) => item.id === id)
      if (current === undefined) return `目录里没有服务 '${id}'`
      const service = buildService(id, current, options)
      return typeof service === 'string' ? service : { catalog: { ...catalog, services: catalog.services.map((item) => (item.id === id ? service : item)) }, value: id }
    }
    const current = catalog.suites.find((item) => item.id === id)
    if (current === undefined) return `目录里没有套件 '${id}'`
    const suite = buildSuite(id, current, options, undefined)
    return typeof suite === 'string' ? suite : { catalog: { ...catalog, suites: catalog.suites.map((item) => (item.id === id ? suite : item)) }, value: id }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  deps.io.out(`[TEST] 已更新 ${id}`)
  return 0
}

export async function cmdCatalogRemove(deps: CliDeps, id: string, options: { readonly service?: boolean }): Promise<number> {
  const outcome = await updateCatalog(deps.cwd, (catalog) => {
    if (options.service === true) {
      if (!catalog.services.some((item) => item.id === id)) return `目录里没有服务 '${id}'`
      const users = catalog.suites.filter((suite) => suite.services.includes(id)).map((suite) => suite.id)
      if (users.length > 0) return `服务 '${id}' 还被套件 ${users.join(', ')} 引用，先改掉引用`
      return { catalog: { ...catalog, services: catalog.services.filter((item) => item.id !== id) }, value: id }
    }
    if (!catalog.suites.some((item) => item.id === id)) return `目录里没有套件 '${id}'`
    return { catalog: { ...catalog, suites: catalog.suites.filter((item) => item.id !== id) }, value: id }
  })
  if (!outcome.ok) return fail(deps, outcome.message)
  deps.io.out(`[TEST] 已移除 ${id}（已登记它的任务计划会报 test-catalog-missing，用 tenon test unregister 清理）`)
  return 0
}
