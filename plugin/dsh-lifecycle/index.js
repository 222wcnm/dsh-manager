// dsh-lifecycle — a DSH host plugin providing a loopback-fenced graceful
// shutdown endpoint, a health endpoint, and a read-only sessions-summary
// endpoint against the dsh web surface.
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
//   - sessions   (optional, read via ctx.get) live session store: `list()`
//                returns attached sessions in creation order (docs/design.md
//                §8.10 M9.1 spike).
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

// Fold the latest session title out of the event stream. The `session/title`
// event is appended by the official dsh-session-title service and its payload
// is already normalized; this plugin reads the event stream directly instead
// of depending on the service, so the endpoint also works on deployments that
// mount no title provider.
function foldTitle(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type !== 'session/title') continue
    const title = event.data?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  }
  return undefined
}

// True when the session log shows an open question or approval wait — the
// host-side equivalent of the webui client's pending-interaction tracking
// (docs/design.md §8.10 M9.1 spike):
//   - approval: an `approval/asked` whose id has no matching `approval/decided`
//     (same blind scan the official api-proxy performs, §8.10 spike);
//   - question: a `tool/call` of the ask_user_question tool whose callId has no
//     matching `tool/result` (callId pairing: tool/call.data.callId vs
//     tool/result.data.message.source.callId).
function hasPendingInteraction(events) {
  const asked = new Set()
  const decided = new Set()
  const pendingCalls = new Map()
  const answeredCalls = new Set()
  for (const event of events) {
    if (event.type === 'approval/asked') {
      const id = event.data?.id
      if (typeof id === 'string') asked.add(id)
    } else if (event.type === 'approval/decided') {
      const id = event.data?.id
      if (typeof id === 'string') decided.add(id)
    } else if (event.type === 'tool/call') {
      const callId = event.data?.callId
      const toolName = event.data?.name
      if (typeof callId === 'string' && toolName === 'ask_user_question') pendingCalls.set(callId, true)
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId
      if (typeof callId === 'string') answeredCalls.add(callId)
    }
  }
  for (const id of asked) if (!decided.has(id)) return true
  for (const callId of pendingCalls.keys()) if (!answeredCalls.has(callId)) return true
  return false
}

// Active subagent children of ONE parent session, folded from the parent's own
// event stream. The official subagent seam publishes `subagent/start` /
// `subagent/end` (same runId) INTO the parent session's log (dsh-subagent
// lifecycle emitter keyed by the delegating parent), so pairing runIds is the
// authoritative lifetime signal — it survives cold-resume (a fresh epoch
// publishes fresh edges), covers descendant chains (a child's `end` fires only
// after all of its own descendants settled), and needs no agents-service
// polling.
function activeChildIds(events) {
  const started = new Map() // runId -> child session id
  const ended = new Set() // runIds that settled
  for (const event of events) {
    if (event.type === 'subagent/start') {
      const runId = event.data?.runId
      const childId = event.data?.id
      if (typeof runId === 'string' && typeof childId === 'string') started.set(runId, childId)
    } else if (event.type === 'subagent/end') {
      const runId = event.data?.runId
      if (typeof runId === 'string') ended.add(runId)
    }
  }
  const ids = new Set()
  for (const [runId, childId] of started) if (!ended.has(runId)) ids.add(childId)
  return [...ids]
}

// Fold the child's task label out of its own `subagent/descriptor` event (the
// durable, model-hidden composition record). The first descriptor is
// authoritative; `label` is optional by contract.
function foldChildLabel(events) {
  for (const event of events) {
    if (event.type !== 'subagent/descriptor') continue
    const label = event.data?.label
    if (typeof label === 'string' && label.length > 0) return label
  }
  return undefined
}

// Derive the four-state session summary the extension renders
// (docs/design.md §8.10): waiting > working > completed > idle.
function summarizeSession(session, agents, childLabelBy) {
  const events = session.events ?? []
  const running = agents?.get?.(session.id)?.status === 'running'
  let state = 'idle'
  if (hasPendingInteraction(events)) state = 'waiting'
  else if (running) state = 'working'
  else if (events.some((event) => event.type === 'turn/end')) state = 'completed'
  const childRuns = activeChildIds(events).map((childId) => ({
    childId,
    ...(childLabelBy?.get?.(childId) !== undefined
      ? { label: childLabelBy.get(childId) }
      : {}),
  }))
  let updatedAt
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const time = events[i]?.time
    if (typeof time === 'number') { updatedAt = time; break }
  }
  if (updatedAt === undefined) updatedAt = session.header?.createdAt ?? Date.now()
  let blank = events.length === 0
  for (const event of events) if (event.type === 'turn/start') { blank = false; break }
  const title = foldTitle(events)
  return {
    sessionId: session.id,
    ...(title !== undefined ? { title } : {}),
    state,
    updatedAt,
    blank,
    hasActiveChildren: childRuns.length > 0,
    childRuns,
    ...(session.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
  }
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
    ctx.webServer.register({
      kind: 'exact',
      path: '/_manager/sessions',
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
        const sessions = ctx.get('sessions')
        if (sessions === undefined) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'sessions service unavailable' }))
          return
        }
        const agents = ctx.get('agents')
        // Official workspace registry (registry-global archive set). Absent on
        // deployments without the workspace plugin — degrade to no filtering.
        // Archived sessions are hidden from every grouping surface; an archived
        // session with RUNNING children still shows (perception wins — the work
        // is not actually finished), while archive masters without children hide.
        const workspaceRegistry = ctx.get('workspaceRegistry')
        const archivedIds = (workspaceRegistry && Array.isArray(workspaceRegistry.archivedSessionIds))
          ? new Set(workspaceRegistry.archivedSessionIds)
          : null
        const live = sessions.list()
        // Subagent label index: live child sessions (origin='subagent') fold
        // their own descriptor label; child runs not otherwise labelable fall
        // back to no label (the client renders '子代理').
        const childLabelBy = new Map()
        for (const child of live) {
          if (!child || typeof child !== 'object') continue
          if (child.header?.origin !== 'subagent') continue
          const label = foldChildLabel(child.events ?? [])
          if (label !== undefined) childLabelBy.set(child.id, label)
        }
        const items = []
        for (const session of live) {
          if (!session || typeof session !== 'object') continue
          // Subagent sessions never appear as top-level rows: their running
          // state is folded into the parent's childRuns (webui hides them too).
          if (session.header?.origin === 'subagent') continue
          try {
            const summary = summarizeSession(session, agents, childLabelBy)
            if (archivedIds !== null && archivedIds.has(session.id) && summary.childRuns.length === 0) continue
            items.push(summary)
          } catch {
            // One malformed session must never take down the whole listing.
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items }))
      },
    }),
  ]

  return () => {
    for (const d of dispose) d()
  }
}
