// dsh-lifecycle — a DSH host plugin providing a loopback-fenced graceful
// shutdown endpoint and a health endpoint against the dsh web surface.
//
// Injected services (verified against @deepseek-ai/dsh@0.1.0-rc.6 source):
//   - webServer  `register({ kind, path, handler })` returns a disposer; its
//                `port` getter returns the OS-assigned listening port.
//   - appExit    `ctx.appExit(code)` is a graceful-dispose request: it triggers
//                the dsh fiber dispose (which closes the listening port) but
//                does NOT guarantee process exit. Process exit depends on the
//                event loop draining naturally; the DSH Manager host treats port
//                closure as the authoritative signal and falls back to taskkill
//                when needed. It is NOT a bare process.exit.
//
// A route handler receives Node http `IncomingMessage` / `ServerResponse`.
// The webserver dispatches `await route.handler(req, res)`; a handled exact
// route answers before the SPA fallback, so these paths never hit `/api`.

export const name = 'dsh-lifecycle'
export const inject = ['webServer', 'appExit']

// Idempotency guard: once a shutdown has been requested, subsequent POSTs are
// answered 409 Conflict without calling appExit again. This is self-managed and
// does NOT rely on the upstream `createProcessShutdown` pending-merge behavior.
let exiting = false

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

// Security fence (self-managed; plugin routes bypass the /api trust fence).
// All of the following must hold for a request to be allowed, else 403:
//   - remoteAddress is loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1);
//   - Host header matches a loopback authority (optionally with :port);
//   - sec-fetch-site, when present and "cross-site", is rejected — aligned
//     with the official /api fence `isTrustedApiRequest`
//     (dsh-client-connection/lib/index.js), which rejects cross-site before
//     the Origin same-origin check;
//   - Origin, when present, must be same-host as the Host header.
function allow(req) {
  if (!isLoopback(req.socket.remoteAddress ?? '')) return false
  const host = req.headers.host ?? ''
  if (!LOOPBACK_HOST.test(host)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

export function apply(ctx) {
  // A fresh lifecycle per mount: reset the idempotency guard when the plugin
  // is (re)applied, so a disposed/remounted instance starts clean.
  exiting = false
  const dispose = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/_lifecycle/health',
      handler: async (req, res) => {
        if (!allow(req)) {
          res.writeHead(403)
          res.end()
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          pid: process.pid,
          uptimeMs: Math.round(process.uptime() * 1000),
          port: ctx.webServer.port ?? 0,
          nodeVersion: process.version,
        }))
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/_lifecycle/shutdown',
      handler: async (req, res) => {
        if (!allow(req)) {
          res.writeHead(403)
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        if (exiting) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'shutdown already in progress' }))
          return
        }
        exiting = true
        // Flush the 202 response before beginning dispose, so the ack reaches
        // the socket rather than being truncated by process teardown.
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }), () => {
          setImmediate(() => ctx.appExit(0))
        })
      },
    }),
  ]

  return () => {
    for (const d of dispose) d()
  }
}
