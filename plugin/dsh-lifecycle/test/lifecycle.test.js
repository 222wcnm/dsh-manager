import test from 'node:test'
import assert from 'node:assert/strict'

// Import the plugin module directly (it has zero runtime deps and no side
// effects at module load, so a plain dynamic import is safe).
const plugin = await import('../index.js')

// Build a real-ish request stub with a socket carrying remoteAddress, and the
// headers the fence reads.
function makeRequest({ remoteAddress = '127.0.0.1', method = 'GET', headers = {} } = {}) {
  return {
    socket: { remoteAddress },
    method,
    headers: { host: '127.0.0.1:43123', ...headers },
  }
}

// Minimal ServerResponse stub: records writeHead calls and end payloads, and
// invokes the optional end callback synchronously (so tests can await the
// setImmediate inside the shutdown handler deterministically).
function makeResponse() {
  const calls = []
  const res = {
    written: null,
    ended: null,
    writeHead(status, headers) {
      calls.push({ type: 'writeHead', status, headers })
      this.written = { status, headers }
      return this
    },
    end(body, callback) {
      calls.push({ type: 'end', body })
      this.ended = body
      if (typeof callback === 'function') callback()
      return this
    },
    calls,
  }
  return res
}

// Fake ctx: webServer (port + register returning a disposer) and appExit
// (records the code). Returns the ctx plus arrays that let the test inspect
// registered route handlers, disposer invocation, and appExit calls.
function makeCtx() {
  const routes = new Map()
  const disposed = []
  const exitCodes = []
  const disposers = []
  const ctx = {
    get(name) {
      return undefined
    },
    webServer: {
      port: 43123,
      register(spec) {
        routes.set(`${spec.kind}:${spec.path}`, spec.handler)
        const disposer = () => { disposed.push(spec.path) }
        disposers.push(disposer)
        return disposer
      },
    },
    appExit(code) {
      exitCodes.push(code)
    },
  }
  // Mount the plugin immediately so the fake ctx's route registry is populated.
  const cleanup = plugin.apply(ctx)
  return { ctx, routes, disposed, exitCodes, disposers, cleanup }
}

// Resolve a health request, returning the parsed JSON body (or error marker).
// The handler is async, so await it before reading the recorded response.
async function healthPayload(ctx, routes, req) {
  const res = makeResponse()
  await routes.get('exact:/_lifecycle/health')(req, res)
  return { res, status: res.written?.status, body: res.ended }
}

async function shutdown(ctx, routes, req) {
  const res = makeResponse()
  await routes.get('exact:/_lifecycle/shutdown')(req, res)
  return { res, status: res.written?.status, body: res.ended }
}

test('exports the Cordis plugin shape', () => {
  assert.equal(plugin.name, 'dsh-lifecycle')
  assert.deepEqual(plugin.inject, ['webServer', 'appExit'])
  assert.equal(typeof plugin.apply, 'function')
})

test('health GET returns 200 with the correct JSON shape', async () => {
  const { ctx, routes } = makeCtx()
  const { status, body } = await healthPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  const json = JSON.parse(body)
  assert.equal(json.ok, true)
  assert.equal(json.pid, process.pid)
  assert.equal(typeof json.uptimeMs, 'number')
  assert.ok(json.uptimeMs >= 0)
  assert.equal(json.port, 43123)
  assert.equal(json.nodeVersion, process.version)
})

test('health uses port 0 when webServer.port is undefined', async () => {
  const { ctx, routes } = makeCtx()
  ctx.webServer.port = undefined
  const { status, body } = await healthPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).port, 0)
})

test('shutdown POST returns 202 and calls appExit(0) after the end callback', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const { status, body } = await shutdown(ctx, routes, makeRequest({ method: 'POST' }))
  assert.equal(status, 202)
  assert.equal(JSON.parse(body).ok, true)
  // The end callback runs synchronously in our stub and schedules appExit via
  // setImmediate; await a turn so it fires.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [0])
})

test('non-loopback remoteAddress is rejected with 403 and does not exit', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const req = makeRequest({ method: 'POST', remoteAddress: '203.0.113.7' })
  const { status } = await shutdown(ctx, routes, req)
  assert.equal(status, 403)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [])
})

test('IPv6 loopback ::1 is allowed', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    remoteAddress: '::1',
    headers: { host: '[::1]:3080' },
  }))
  assert.equal(status, 200)
})

test('::ffff:127.0.0.1 loopback is allowed', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    remoteAddress: '::ffff:127.0.0.1',
    headers: { host: '127.0.0.1:3080' },
  }))
  assert.equal(status, 200)
})

test('cross-origin Origin header is rejected with 403', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const req = makeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.com' },
  })
  const { status } = await shutdown(ctx, routes, req)
  assert.equal(status, 403)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [])
})

test('sec-fetch-site: cross-site is rejected with 403 and does not exit', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const req = makeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  })
  const { status } = await shutdown(ctx, routes, req)
  assert.equal(status, 403)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [])
})

test('sec-fetch-site: same-site / same-origin values are allowed', async () => {
  const { ctx, routes } = makeCtx()
  for (const value of ['same-site', 'same-origin', 'none']) {
    const { status } = await healthPayload(ctx, routes, makeRequest({
      method: 'GET',
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': value },
    }))
    assert.equal(status, 200, `sec-fetch-site=${value} should be allowed`)
  }
})

test('concurrent shutdown: second POST returns 409 and appExit is called once', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const first = await shutdown(ctx, routes, makeRequest({ method: 'POST' }))
  assert.equal(first.status, 202)
  const second = await shutdown(ctx, routes, makeRequest({ method: 'POST' }))
  assert.equal(second.status, 409)
  assert.equal(JSON.parse(second.body).ok, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [0])
})

test('same-origin Origin header is allowed', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    headers: { host: 'localhost:3080', origin: 'http://localhost:3080' },
  }))
  assert.equal(status, 200)
})

test('a missing Origin header is allowed (native-host chain sends none)', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
  }))
  assert.equal(status, 200)
})

test('malformed Origin header is rejected with 403', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    headers: { host: '127.0.0.1:3080', origin: 'not-a-url' },
  }))
  assert.equal(status, 403)
})

test('shutdown via GET returns 405 with Allow: POST and does not exit', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const { res, status } = await shutdown(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 405)
  assert.equal(res.written.headers.allow, 'POST')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [])
})

test('health via POST returns 405 with Allow: GET', async () => {
  const { ctx, routes } = makeCtx()
  const { res, status } = await healthPayload(ctx, routes, makeRequest({ method: 'POST' }))
  assert.equal(status, 405)
  assert.equal(res.written.headers.allow, 'GET')
})

test('malicious Host header is rejected with 403', async () => {
  const { ctx, routes, exitCodes } = makeCtx()
  const req = makeRequest({ method: 'POST', headers: { host: 'evil.com' } })
  const { status } = await shutdown(ctx, routes, req)
  assert.equal(status, 403)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(exitCodes, [])
})

test('non-loopback Host (e.g. 192.168.1.10) is rejected with 403', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    headers: { host: '192.168.1.10:3080' },
  }))
  assert.equal(status, 403)
})

test('Host with a non-numeric port fragment is rejected', async () => {
  const { ctx, routes } = makeCtx()
  const { status } = await healthPayload(ctx, routes, makeRequest({
    method: 'GET',
    headers: { host: '127.0.0.1:evil' },
  }))
  assert.equal(status, 403)
})

test('apply returns a disposer that releases every registered route', () => {
  const { ctx, disposed } = makeCtx()
  const cleanup = plugin.apply(ctx)
  // All routes registered before apply returned.
  assert.deepEqual(disposed, [])
  cleanup()
  assert.deepEqual(disposed.sort(), ['/_lifecycle/health', '/_lifecycle/shutdown', '/_manager/sessions'].sort())
})

test('apply registers exactly three exact routes', () => {
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx)
  assert.equal(routes.size, 3)
  assert.ok(routes.has('exact:/_lifecycle/health'))
  assert.ok(routes.has('exact:/_lifecycle/shutdown'))
  assert.ok(routes.has('exact:/_manager/sessions'))
})

// ---- M9: GET /_manager/sessions (read-only session summaries) ----

const ev = (type, data = {}, time = 1700000000000) => ({ type, seq: 1, time, data })

function makeSession({ id = 'session-1', events = [], header = {} } = {}) {
  return { id, events, header: { createdAt: 1700000000000, ...header } }
}

// A ctx whose ctx.get resolves the sessions/agents services for the endpoint.
function makeCtxWithSessions({ sessions = [], agents = {}, workspaceRegistry } = {}) {
  const base = makeCtx()
  base.ctx.get = (name) => {
    if (name === 'sessions') return { list: () => sessions }
    if (name === 'agents') return { get: (id) => agents[id] }
    if (name === 'workspaceRegistry') return workspaceRegistry
    return undefined
  }
  return base
}

async function sessionsPayload(ctx, routes, req) {
  const res = makeResponse()
  await routes.get('exact:/_manager/sessions')(req, res)
  return { res, status: res.written?.status, body: res.ended }
}

test('sessions GET returns 200 with an empty items array when no session is live', async () => {
  const { ctx, routes } = makeCtxWithSessions()
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(body), { ok: true, items: [] })
})

test('sessions maps every state: idle / working / completed / waiting approval / waiting question', async () => {
  const sessions = [
    makeSession({ id: 's-idle' }),
    makeSession({
      id: 's-working',
      events: [ev('turn/start'), ev('user/message', { source: { kind: 'user' } })],
    }),
    makeSession({ id: 's-completed', events: [ev('turn/start'), ev('turn/end')] }),
    makeSession({
      id: 's-approval',
      events: [
        ev('turn/start'),
        ev('approval/asked', { id: 'approve-1', callId: 'call-1', toolName: 'read' }),
      ],
    }),
    makeSession({
      id: 's-question',
      events: [
        ev('turn/start'),
        ev('tool/call', { callId: 'call-q1', name: 'ask_user_question' }),
      ],
    }),
  ]
  const agents = { 's-working': { status: 'running' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  const byId = new Map(JSON.parse(body).items.map((item) => [item.sessionId, item]))
  assert.equal(byId.get('s-idle').state, 'idle')
  assert.equal(byId.get('s-working').state, 'working')
  assert.equal(byId.get('s-completed').state, 'completed')
  assert.equal(byId.get('s-approval').state, 'waiting')
  assert.equal(byId.get('s-question').state, 'waiting')
  assert.equal(byId.get('s-idle').blank, true)
  assert.equal(byId.get('s-working').blank, false)
})

test('sessions resolves an answered approval and an answered question back to completed', async () => {
  const sessions = [
    makeSession({
      id: 's-settled',
      events: [
        ev('turn/start'),
        ev('approval/asked', { id: 'approve-1' }),
        ev('approval/decided', { id: 'approve-1' }),
        ev('tool/call', { callId: 'call-q1', name: 'ask_user_question' }),
        ev('tool/result', { message: { source: { callId: 'call-q1' } } }),
        ev('turn/end'),
      ],
    }),
  ]
  const { ctx, routes } = makeCtxWithSessions({ sessions })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.state, 'completed')
})

test('sessions folds the title from the session/title event and omits it when absent', async () => {
  const sessions = [
    makeSession({
      id: 's-titled',
      events: [ev('session/title', { title: '帮我查一下最近的提交' })],
      header: { cwd: 'D:\\work\\repo' },
    }),
    makeSession({ id: 's-untitled' }),
  ]
  const { ctx, routes } = makeCtxWithSessions({ sessions })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const items = JSON.parse(body).items
  const titled = items.find((item) => item.sessionId === 's-titled')
  assert.equal(titled.title, '帮我查一下最近的提交')
  assert.equal(titled.cwd, 'D:\\work\\repo')
  const untitled = items.find((item) => item.sessionId === 's-untitled')
  assert.ok(!('title' in untitled))
})

test('sessions ignores a malformed session and still answers 200', async () => {
  const sessions = [
    null,
    makeSession({ id: 's-ok' }),
  ]
  const { ctx, routes } = makeCtxWithSessions({ sessions })
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  const items = JSON.parse(body).items
  assert.equal(items.length, 1)
  assert.equal(items[0].sessionId, 's-ok')
})

test('sessions answers 500 when the sessions service is absent', async () => {
  // makeCtx() has no ctx.get at all — same as makeCtx's default.
  const { ctx, routes } = makeCtx()
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 500)
  assert.equal(JSON.parse(body).ok, false)
})

test('sessions is read-only: non-GET methods answer 405 with Allow: GET', async () => {
  const { ctx, routes } = makeCtxWithSessions()
  const { res, status } = await sessionsPayload(ctx, routes, makeRequest({ method: 'POST' }))
  assert.equal(status, 405)
  assert.equal(res.written.headers.allow, 'GET')
})

test('sessions enforces the same loopback fence: non-loopback address answers 403', async () => {
  const { ctx, routes } = makeCtxWithSessions()
  const { status } = await sessionsPayload(ctx, routes, makeRequest({
    method: 'GET',
    remoteAddress: '203.0.113.7',
  }))
  assert.equal(status, 403)
})

// ---- 子代理感知(M11):subagent/start ↔ subagent/end 配对折叠 ----

test('sessions folds active children: unpaired subagent/start yields childRuns with label', async () => {
  const sessions = [
    makeSession({
      id: 's-parent',
      events: [
        ev('turn/start'),
        ev('turn/end'),
        ev('subagent/start', { runId: 'run-1', id: 'child-1', provider: 'subagent', local: true }),
        ev('subagent/start', { runId: 'run-2', id: 'child-2', provider: 'subagent', local: true }),
        ev('subagent/end', { runId: 'run-2', id: 'child-2', stopReason: 'completed' }),
      ],
    }),
    makeSession({
      id: 'child-1',
      header: { origin: 'subagent', cwd: 'D:\\w' },
      events: [ev('subagent/descriptor', { version: 1, mode: 'continuable', provider: 'subagent', label: '检索代码' })],
    }),
  ]
  const { ctx, routes } = makeCtxWithSessions({ sessions })
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  const items = JSON.parse(body).items
  const parent = items.find((item) => item.sessionId === 's-parent')
  assert.equal(parent.state, 'completed')
  assert.equal(parent.hasActiveChildren, true)
  assert.deepEqual(parent.childRuns, [ { childId: 'child-1', label: '检索代码' } ])
})

test('sessions hides subagent sessions from the top-level list', async () => {
  const sessions = [
    makeSession({ id: 's-main', events: [ev('turn/end')] }),
    makeSession({ id: 'child-x', header: { origin: 'subagent' }, events: [ev('subagent/descriptor', { label: 'x' })] }),
  ]
  const { ctx, routes } = makeCtxWithSessions({ sessions })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const ids = JSON.parse(body).items.map((item) => item.sessionId)
  assert.deepEqual(ids, ['s-main'])
})

test('sessions filters archived sessions but keeps archived sessions with running children', async () => {
  const sessions = [
    makeSession({ id: 's-arch-done', events: [ev('turn/end')] }),
    makeSession({
      id: 's-arch-child',
      events: [
        ev('turn/end'),
        ev('subagent/start', { runId: 'run-a', id: 'child-a', provider: 'subagent', local: true }),
      ],
    }),
    makeSession({ id: 's-live', events: [ev('turn/end')] }),
    makeSession({ id: 'child-a', header: { origin: 'subagent' } }),
  ]
  const workspaceRegistry = { archivedSessionIds: ['s-arch-done', 's-arch-child'] }
  const { ctx, routes } = makeCtxWithSessions({ sessions, workspaceRegistry })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const byId = new Map(JSON.parse(body).items.map((item) => [item.sessionId, item]))
  assert.equal(byId.has('s-arch-done'), false)
  assert.equal(byId.has('s-live'), true)
  assert.equal(byId.has('s-arch-child'), true)
  assert.equal(byId.get('s-arch-child').hasActiveChildren, true)
})

test('sessions defaults: completed childRuns empty when every start is paired', async () => {
  const sessions = [
    makeSession({
      id: 's-settled-child',
      events: [
        ev('turn/end'),
        ev('subagent/start', { runId: 'run-1', id: 'c1', provider: 'subagent', local: true }),
        ev('subagent/end', { runId: 'run-1', id: 'c1', stopReason: 'completed' }),
      ],
    }),
  ]
  const { ctx, routes } = makeCtxWithSessions({ sessions })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.hasActiveChildren, false)
  assert.deepEqual(item.childRuns, [])
})
