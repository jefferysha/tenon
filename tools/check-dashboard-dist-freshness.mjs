#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function checkDashboardDist(rootInput = fileURLToPath(new URL('..', import.meta.url))) {
  const root = resolve(rootInput)
  const dist = join(root, 'packages/dashboard-app/dist')
  const index = join(dist, 'index.html')
  const failures = []
  if (!existsSync(index)) return ['packages/dashboard-app/dist/index.html: missing generated dashboard entrypoint']
  const html = readFileSync(index, 'utf8')
  for (const match of html.matchAll(/(?:src|href)="(?:\.\/)?(assets\/[^"#?]+)"/gu)) {
    const asset = match[1]
    if (!existsSync(join(dist, asset))) failures.push(`packages/dashboard-app/dist/index.html: missing referenced asset ${asset}`)
  }
  const result = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', 'packages/dashboard-app/dist'], {
    cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status === 0) {
    for (const file of result.stdout.split('\0').filter(Boolean)) failures.push(`packages/dashboard-app/dist: untracked generated asset ${file}`)
  }
  return failures
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkDashboardDist()
  if (failures.length) {
    console.error(`[dashboard-dist-freshness] FAIL (${failures.length})`)
    failures.forEach((failure) => console.error(`- ${failure}`))
    process.exitCode = 1
  } else console.log('[dashboard-dist-freshness] PASS')
}
