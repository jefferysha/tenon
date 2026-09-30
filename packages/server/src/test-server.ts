/**
 * `createDashboardServer` for tests: the server signs itself in as a browser would, right after it
 * listens, so `reqGet` / `reqPost` / ... from test-support carry a real session cookie.  Writes still
 * need the caller's own `Authorization: Bearer ${srv.token}`.  Server tests only — it imports the
 * server sources, which the web package's TypeScript program must not.
 */
import { createDashboardServer } from './server.js'
import { establishTestSession, forgetTestSession } from './test-session.js'
import type { DashboardServer, DashboardServerOptions } from './types.js'

export function createTestDashboardServer(options: DashboardServerOptions): DashboardServer {
  const server = createDashboardServer(options)
  let sessionPort: number | undefined
  return {
    ...server,
    async listen(port, host) {
      const bound = await server.listen(port, host)
      sessionPort = bound.port
      await establishTestSession(server, bound.port)
      return bound
    },
    close() {
      if (sessionPort !== undefined) forgetTestSession(sessionPort)
      return server.close()
    },
  }
}
