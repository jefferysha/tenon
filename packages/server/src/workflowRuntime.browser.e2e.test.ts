import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createDashboardServer } from './server.js'
import { resolveServerPaths } from './paths.js'
import { artifactNamespaceForChange, openArtifactService, StageArtifactRuntime } from '@tenon/automation'
import { chromium } from 'playwright'
import { initChange, makeProject, makeTempHome, newStore, testFlow } from './test-support.js'
import type { DashboardServer } from './types.js'

/**
 * Browser-level proof for the production provenance path.  The browser talks to a real
 * dashboard server and real artifact service; only the browser executable is selected from
 * the host (CI can skip this optional local acceptance test when Chrome is unavailable).
 */
// Playwright owns browser discovery. Local runs may skip when browsers are absent;
// CI sets TENON_REQUIRE_REAL_BROWSER=1 so missing Chromium is a hard failure.
const canLaunchChromium = existsSync(chromium.executablePath())
const requireRealBrowser = process.env.TENON_REQUIRE_REAL_BROWSER === '1'
const openServers: DashboardServer[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('browser workflow runtime provenance', () => {
  it.skipIf(!canLaunchChromium && !requireRealBrowser)('renders real runtime artifact provenance through snapshot/catalog APIs', async () => {
    const root = await makeProject(); roots.push(root)
    const store = newStore()
    const changeDir = await initChange(store, root, 'change-1', { track: 'simple' })
    const now = '2026-09-13T00:00:00.000Z'
    const artifacts = await openArtifactService({ rootDir: changeDir, scopeId: artifactNamespaceForChange(changeDir), now: () => now })
    // The built-in default workflow's first executable step is `open`; the
    // editor must match this exact blueprint stage id (not the Change phase name).
    // StageArtifactRuntime is the same adapter used by the production executor.
    const runtime = await StageArtifactRuntime.open({ service: artifacts, rootDir: changeDir, workflowRunId: 'run-browser-1', stageId: 'open', stageAttemptId: 'attempt-browser-1' })
    await mkdir(join(changeDir, 'artifacts'), { recursive: true })
    await writeFile(join(changeDir, 'artifacts/result.txt'), 'browser-runtime-result', 'utf8')
    await runtime.submit('artifacts/result.txt', 'deliverable', 'result')
    await runtime.end('completed')

    const home = await makeTempHome(); roots.push(home)
    const server = createDashboardServer({
      paths: resolveServerPaths({ home, env: {} }),
      token: 'browser-e2e-token',
      registry: () => [root],
      store,
      flow: testFlow(),
      clock: () => now,
      webRoot: join(process.cwd(), 'packages/dashboard-app/dist'),
      artifactServiceForRoot: async () => artifacts,
    })
    openServers.push(server)
    const { port } = await server.listen(0, '127.0.0.1')

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
      const requests: string[] = []
      const responses: Array<{ url: string; status: number }> = []
      page.on('request', (request) => {
        if (request.url().includes('/api/')) requests.push(request.url())
      })
      page.on('response', (response) => {
        if (response.url().includes('/api/')) responses.push({ url: response.url(), status: response.status() })
      })

      const query = new URLSearchParams({ view: 'workbench', root, change: 'change-1' })
      // The dashboard opens a long-lived SSE connection, so networkidle never settles.
      await page.goto(`http://127.0.0.1:${port}/?${query.toString()}`, { waitUntil: 'domcontentloaded' })
      await page.getByTestId('stage-editor-pane').waitFor({ state: 'visible', timeout: 10_000 })
      const runtimeSection = page.getByTestId('workflow-runtime-artifacts')
      await runtimeSection.waitFor({ state: 'visible', timeout: 10_000 })
      const history = page.getByTestId('runtime-artifacts-history-reference')
      await history.waitFor({ state: 'visible', timeout: 10_000 })
      const historyText = await history.textContent()
      expect(historyText).toContain('历史参考')
      expect(historyText).toContain('run-browser-1')
      expect(historyText).toContain('attempt-browser-1')

      const artifactRequest = requests.find((url) => url.includes('/api/artifacts/catalog'))
      expect(artifactRequest).toContain('stageAttemptId=attempt-browser-1')
      expect(artifactRequest).toContain('change=change-1')
      expect(responses.find((response) => response.url.includes('/api/snapshot'))?.status).toBe(200)
      expect(responses.find((response) => response.url.includes('/api/artifacts/catalog'))?.status).toBe(200)

      const artifactsSection = page.getByTestId('runtime-artifacts')
      await artifactsSection.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await artifactsSection.textContent()).toContain('artifacts/result.txt')
      await page.getByTestId('runtime-artifacts').getByRole('button', { name: /artifacts\/result\.txt/ }).click()
      const preview = page.getByTestId('artifact-preview')
      await preview.waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForFunction(() => document.querySelector('[data-testid="artifact-preview"] pre')?.textContent?.includes('browser-runtime-result') === true, undefined, { timeout: 10_000 })
      expect(await preview.textContent()).toContain('browser-runtime-result')

      const screenshotPath = '/tmp/tenon-workflow-runtime-browser-e2e.png'
      await page.screenshot({ path: screenshotPath, fullPage: true })
      expect(existsSync(screenshotPath)).toBe(true)
    } finally {
      await browser.close()
    }
    // Every browser step keeps its own 10 s bound; the whole-test budget also covers launching
    // Chromium, which exceeded 30 s while the full local suite saturated the machine.
  }, 90_000)
})
