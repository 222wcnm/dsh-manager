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
// setImmediate inside the shutdown handler deterministically). M12: streams
// `write()` chunks into `writes`/`text` and supports 'close' listeners so SSE
// connection lifecycle is testable.
function makeResponse() {
  const calls = []
  const writes = []
  const closeHandlers = []
  const res = {
    written: null,
    ended: null,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      calls.push({ type: 'writeHead', status, headers })
      this.written = { status, headers }
      return this
    },
    write(chunk) {
      writes.push(String(chunk))
      return true
    },
    end(body, callback) {
      calls.push({ type: 'end', body })
      this.ended = body
      this.writableEnded = true
      if (typeof callback === 'function') callback()
      return this
    },
    on(event, callback) {
      if (event === 'close') closeHandlers.push(callback)
      return this
    },
    emitClose() {
      this.destroyed = true
      for (const cb of closeHandlers) cb()
      closeHandlers.length = 0
    },
    closes: closeHandlers,
    writes,
    calls,
    get text() {
      return writes.join('')
    },
  }
  return res
}

// Fork of makeCtx WITHOUT mounting the plugin — for tests that need to stub
// globals (heartbeat) or inspect pre-apply state before apply runs.
function makeCtxRaw() {
  const routes = new Map()
  const disposed = []
  const exitCodes = []
  const disposers = []
  const listeners = new Map()
  const effects = []
  const emit = (name, ...args) => {
    for (const cb of [...(listeners.get(name) || [])]) cb(...args)
  }
  const ctx = {
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
    get(name) {
      return undefined
    },
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(callback)
      return () => {
        const arr = listeners.get(name) || []
        const at = arr.indexOf(callback)
        if (at !== -1) arr.splice(at, 1)
      }
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
  return { ctx, routes, disposed, exitCodes, disposers, listeners, emit, effects }
}

// Fake ctx: webServer (port + register returning a disposer), appExit
// (records the code), and ctx.on (captures listeners, exposed via emit).
// Returns the ctx plus arrays that let the test inspect registered route
// handlers, disposer invocation, and appExit calls.
function makeCtx() {
  const base = makeCtxRaw()
  const cleanup = plugin.apply(base.ctx)
  return { ...base, cleanup }
}

test('readiness cleanup is registered with Cordis effect lifecycle', () => {
  const ctx = makeCtx()
  assert.equal(ctx.effects.length, 1)
  assert.equal(typeof ctx.effects[0], 'function')
  ctx.effects[0]()
  ctx.cleanup()
})

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
  assert.deepEqual(disposed.sort(), [
    '/_lifecycle/health',
    '/_lifecycle/shutdown',
    '/_manager/sessions',
    '/_manager/events',
  ].sort())
})

test('apply registers exactly four exact routes', () => {
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx)
  assert.equal(routes.size, 4)
  assert.ok(routes.has('exact:/_lifecycle/health'))
  assert.ok(routes.has('exact:/_lifecycle/shutdown'))
  assert.ok(routes.has('exact:/_manager/sessions'))
  assert.ok(routes.has('exact:/_manager/events'))
})

// ---- M9: GET /_manager/sessions (read-only session summaries) ----

const ev = (type, data = {}, time = 1700000000000) => ({ type, seq: 1, time, data })

function makeSession({ id = 'session-1', events = [], header = {} } = {}) {
  // rc.1+（dsh ≥ 0.1.2，§2.1.1 B5）：Session 类移除 `.events` 数组属性，
  // 事件改经 `snapshotEvents()` 方法读取。桩同时暴露两形状：
  // - `.events`（rc.2 及更早的旧形状，验证兼容回退路径）
  // - `snapshotEvents()`（rc.1 新形状，验证主路径）
  // 纯 rc.1 形状（仅 snapshotEvents、无 .events）由下方专门测试覆盖。
  return {
    id,
    events,
    snapshotEvents() {
      return events
    },
    header: { createdAt: 1700000000000, ...header },
  }
}

// A ctx whose ctx.get resolves the sessions/agents services for the endpoint.
function makeCtxWithSessions({ sessions = [], agents = {}, workspaceRegistry } = {}) {
  const base = makeCtx()
  base.ctx.get = (name) => {
    if (name === 'sessions') {
      return {
        list: () => sessions,
        get: (id) => sessions.find((s) => s && s.id === id),
      }
    }
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

test('sessions: rc.1-shaped session (snapshotEvents only, no .events property) summarizes correctly', async () => {
  // §2.1.1 B5：dsh ≥ 0.1.2 起 Session 类移除 `.events` 数组属性，事件改经
  // `snapshotEvents()` 方法读取。此桩模拟 rc.1 真实形状（无 .events 键），
  // 验证主路径（防「事件恒空 → 状态恒 idle」静默降级回归）。
  const rc1Session = {
    id: 's-rc1',
    header: { createdAt: 1700000000000, cwd: 'D:\\w' },
    snapshotEvents() {
      return [ev('turn/start'), ev('turn/end')]
    },
  }
  const { ctx, routes } = makeCtxWithSessions({ sessions: [rc1Session] })
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  const [item] = JSON.parse(body).items
  assert.equal(item.sessionId, 's-rc1')
  assert.equal(item.state, 'completed')
  assert.equal(item.blank, false)
})

test('sessions: a session with neither .events nor snapshotEvents degrades to idle without throwing', async () => {
  const bare = { id: 's-bare', header: { createdAt: 1700000000000 } }
  const { ctx, routes } = makeCtxWithSessions({ sessions: [bare] })
  const { status, body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(status, 200)
  const [item] = JSON.parse(body).items
  assert.equal(item.sessionId, 's-bare')
  assert.equal(item.state, 'idle')
  assert.equal(item.blank, true)
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

// ---- M13.1 修复：子代理感知以事件总线为权威源（真实 dsh 形状）----
// dsh 0.1.1-rc.2 / 0.1.2-rc.1 源码核验：subagent/start|end 只经事件总线发布、
// 不写入父会话 session log（见 index.js activeChildRuns 注记）——旧实现从
// sessionEvents() 配对在真实环境恒空、popup 不显示子代理行。以下测试模拟真实
// dsh：父会话事件流为空，活跃子代理仅经 session/created（header.parentSession）
// + subagent/start|end 总线事件登记。

test('sessions: active children from bus events (real dsh shape, empty session log)', async () => {
  const sessions = [
    makeSession({ id: 's-parent', events: [ev('turn/end')] }),
    makeSession({
      id: 'child-1',
      header: { origin: 'subagent', parentSession: 's-parent' },
      events: [ev('subagent/descriptor', { label: '检索代码' })],
    }),
  ]
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions })
  // 模拟 dsh：子会话创建（header.parentSession 登记）+ subagent/start 总线事件
  emit('session/created', sessions[1])
  emit('subagent/start', { runId: 'run-1', id: 'child-1', provider: 'subagent', local: true })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.sessionId, 's-parent')
  assert.equal(item.hasActiveChildren, true)
  assert.deepEqual(item.childRuns, [{ childId: 'child-1', label: '检索代码' }])
})

test('sessions: subagent/end removes the active child from the bus index', async () => {
  const sessions = [
    makeSession({ id: 's-parent', events: [ev('turn/end')] }),
    makeSession({ id: 'child-1', header: { origin: 'subagent', parentSession: 's-parent' } }),
  ]
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions })
  emit('session/created', sessions[1])
  emit('subagent/start', { runId: 'run-1', id: 'child-1', provider: 'subagent', local: true })
  emit('subagent/end', { runId: 'run-1', id: 'child-1', stopReason: 'completed' })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.hasActiveChildren, false)
  assert.deepEqual(item.childRuns, [])
})

test('sessions: cold-start fallback scans live running subagent children', async () => {
  // 插件热重载后总线索引为空（无 session/created / subagent/start 事件），
  // 仅靠 live 扫描兜底：origin='subagent' + parentSession 匹配 + agent running。
  const sessions = [
    makeSession({ id: 's-parent', events: [ev('turn/end')] }),
    makeSession({ id: 'child-1', header: { origin: 'subagent', parentSession: 's-parent' } }),
  ]
  const agents = { 'child-1': { status: 'running' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.hasActiveChildren, true)
  assert.deepEqual(item.childRuns, [{ childId: 'child-1' }])
})

test('sessions: cold-start fallback ignores settled (non-running) subagent children', async () => {
  const sessions = [
    makeSession({ id: 's-parent', events: [ev('turn/end')] }),
    makeSession({ id: 'child-1', header: { origin: 'subagent', parentSession: 's-parent' } }),
  ]
  const agents = { 'child-1': { status: 'idle' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.hasActiveChildren, false)
  assert.deepEqual(item.childRuns, [])
})

test('sessions: a parent without turn/end but with active children is working (not hidden)', async () => {
  // M13.1：冷恢复/未结束 turn 的父会话 + 活跃子代理 → state 归入 working
  // （「有子代理运行归入进行中」定稿；popup 按 idle 隐藏整行，working 恒显）。
  const parent = makeSession({ id: 's-parent', events: [] })
  const child = makeSession({
    id: 'child-1',
    header: { origin: 'subagent', parentSession: 's-parent' },
    events: [ev('subagent/descriptor', { label: '子任务' })],
  })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [parent, child] })
  emit('session/created', child)
  emit('subagent/start', { runId: 'run-1', id: 'child-1', provider: 'subagent', local: true })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.state, 'working')
  assert.equal(item.hasActiveChildren, true)
})

test('events: subagent/start pushes an upsert with childRuns (bus event)', async () => {
  const parent = makeSession({ id: 's-parent', events: [ev('turn/end')] })
  const child = makeSession({
    id: 'child-1',
    header: { origin: 'subagent', parentSession: 's-parent' },
    events: [ev('subagent/descriptor', { label: '子任务' })],
  })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [parent, child] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  emit('session/created', child)
  emit('subagent/start', { runId: 'run-1', id: 'child-1', provider: 'subagent', local: true })
  await sleep(80)
  const upserts = parseSse(res.text).filter((f) => f.event === 'upsert')
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].data.session.sessionId, 's-parent')
  assert.equal(upserts[0].data.session.hasActiveChildren, true)
  assert.deepEqual(upserts[0].data.session.childRuns, [{ childId: 'child-1', label: '子任务' }])
})

// ---- M12: GET /_manager/events (SSE event-driven push surface) ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Parse raw SSE text into {id, event, data} frames (+ {comment} for ping).
function parseSse(text) {
  const frames = []
  for (const block of String(text || '').split('\n\n')) {
    const lines = block.split('\n').filter((l) => l.length > 0)
    if (lines.length === 0) continue
    if (lines[0].startsWith(':')) {
      frames.push({ comment: lines[0].slice(2) })
      continue
    }
    const frame = {}
    for (const line of lines) {
      if (line.startsWith('id: ')) frame.id = Number(line.slice(4))
      else if (line.startsWith('event: ')) frame.event = line.slice(7)
      else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
    }
    frames.push(frame)
  }
  return frames
}

async function eventsConnect(ctx, routes, req) {
  const res = makeResponse()
  await routes.get('exact:/_manager/events')(req, res)
  return res
}

// Real dsh Session.append() writes the event into the session log BEFORE the
// firehose notifies listeners — the mock store must do the same, or recompute
// sees a stale log and the diff suppresses every push.
function appendEvent(session, event) {
  session.events.push(event)
  return event
}

test('events snapshot frame equals the /_manager/sessions items shape', async () => {
  const sessions = [
    makeSession({ id: 's-working', events: [ev('turn/start')] }),
    makeSession({ id: 's-done', events: [ev('turn/start'), ev('turn/end')] }),
    makeSession({ id: 'child-x', header: { origin: 'subagent' } }),
  ]
  const agents = { 's-working': { status: 'running' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(res.written.status, 200)
  assert.equal(res.written.headers['content-type'], 'text/event-stream')
  assert.equal(res.written.headers['cache-control'], 'no-cache')
  assert.ok(res.text.startsWith('retry: 3000\n\n'))
  const [snapshot] = parseSse(res.text).filter((f) => f.event === 'snapshot')
  assert.ok(snapshot)
  assert.equal(snapshot.data.ok, true)
  // Same derivation as the GET endpoint: compare against a direct GET call.
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  assert.deepEqual(snapshot.data.items, JSON.parse(body).items)
})

test('events: approval/asked pushes an upsert with state waiting', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/start')] })
  const agents = { 's-run': { status: 'running' } }
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session], agents })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  emit('session/event', session, appendEvent(session, ev('approval/asked', { id: 'approve-1' })))
  await sleep(80)
  const upserts = parseSse(res.text).filter((f) => f.event === 'upsert')
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].data.session.sessionId, 's-run')
  assert.equal(upserts[0].data.session.state, 'waiting')
})

test('events: an answered approval pushes the state back to completed', async () => {
  const session = makeSession({
    id: 's-run',
    events: [
      ev('turn/start'),
      ev('approval/asked', { id: 'approve-1' }),
      ev('approval/decided', { id: 'approve-1' }),
    ],
  })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  emit('session/event', session, appendEvent(session, ev('turn/end')))
  await sleep(80)
  const upserts = parseSse(res.text).filter((f) => f.event === 'upsert')
  assert.equal(upserts[upserts.length - 1].data.session.state, 'completed')
})

test('events: unrelated high-frequency events produce no frames', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/start'), ev('turn/end')] })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  const before = res.writes.length
  emit('session/event', session, appendEvent(session, ev('assistant/chunk')))
  emit('session/event', session, appendEvent(session, ev('assistant/chunk')))
  await sleep(80)
  assert.equal(res.writes.length, before)
})

test('events: updatedAt-only change (repeat turn/start) is diff-suppressed', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/start'), ev('turn/end')] })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  const before = res.writes.length
  emit('session/event', session, appendEvent(session, ev('turn/start', {}, 1700000100000)))
  await sleep(80)
  assert.equal(res.writes.length, before)
})

test('events: session/disposed pushes removed and drops the row', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/end')] })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  emit('session/disposed', session)
  const removals = parseSse(res.text).filter((f) => f.event === 'removed')
  assert.equal(removals.length, 1)
  assert.equal(removals[0].data.sessionId, 's-run')
  // Second dispose is a no-op (row already dropped).
  const before = res.writes.length
  emit('session/disposed', session)
  assert.equal(res.writes.length, before)
})

test('events: agent/status flips working → completed synchronously', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/start'), ev('turn/end')] })
  const agents = { 's-run': { status: 'running' } }
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session], agents })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  const [snapshot] = parseSse(res.text).filter((f) => f.event === 'snapshot')
  assert.equal(snapshot.data.items[0].state, 'working')
  agents['s-run'] = { status: 'idle' }
  emit('agent/status', { status: 'idle', agent: { id: 's-run' } })
  const upserts = parseSse(res.text).filter((f) => f.event === 'upsert')
  assert.equal(upserts[upserts.length - 1].data.session.state, 'completed')
})

test('events: archive transitions produce upsert/removed consistent with the GET surface', async () => {
  const session = makeSession({ id: 's-arch', events: [ev('turn/end')] })
  const workspaceRegistry = { archivedSessionIds: [] }
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session], workspaceRegistry })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  const [snapshot] = parseSse(res.text).filter((f) => f.event === 'snapshot')
  assert.equal(snapshot.data.items.length, 1)
  workspaceRegistry.archivedSessionIds = ['s-arch']
  emit('session/event', session, appendEvent(session, ev('turn/end')))
  await sleep(80)
  const removals = parseSse(res.text).filter((f) => f.event === 'removed')
  assert.equal(removals.length, 1)
  assert.equal(removals[0].data.sessionId, 's-arch')
  workspaceRegistry.archivedSessionIds = []
  emit('session/event', session, appendEvent(session, ev('turn/end')))
  await sleep(80)
  const upserts = parseSse(res.text).filter((f) => f.event === 'upsert')
  assert.equal(upserts.length, 1)
})

test('events: closed connections are dropped and no longer written', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/start'), ev('turn/end')] })
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  res.emitClose()
  const before = res.writes.length
  emit('session/event', session, ev('turn/end'))
  await sleep(80)
  assert.equal(res.writes.length, before)
})

test('events: fence enforces loopback + method + sessions-service availability', async () => {
  const { ctx, routes } = makeCtxWithSessions()
  let res = makeResponse()
  await routes.get('exact:/_manager/events')(makeRequest({ method: 'GET', remoteAddress: '203.0.113.7' }), res)
  assert.equal(res.written.status, 403)
  res = makeResponse()
  await routes.get('exact:/_manager/events')(makeRequest({ method: 'POST' }), res)
  assert.equal(res.written.status, 405)
  assert.equal(res.written.headers.allow, 'GET')
  const raw = makeCtxRaw()
  const cleanup = plugin.apply(raw.ctx)
  res = makeResponse()
  await raw.routes.get('exact:/_manager/events')(makeRequest({ method: 'GET' }), res)
  assert.equal(res.written.status, 500)
  cleanup()
})

test('events: dispose ends open connections and removes listeners', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/end')] })
  const { ctx, routes, emit, cleanup } = makeCtxWithSessions({ sessions: [session] })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  assert.equal(res.writableEnded, false)
  cleanup()
  assert.equal(res.writableEnded, true)
  const before = res.writes.length
  emit('session/event', session, ev('turn/end'))
  await sleep(80)
  assert.equal(res.writes.length, before)
})

test('events: heartbeat writes a comment frame and is disposed with the plugin', async () => {
  const captured = []
  const originalSetInterval = global.setInterval
  global.setInterval = (fn, ms) => {
    captured.push({ fn, ms })
    return { unref() {} }
  }
  const raw = makeCtxRaw()
  let cleanup
  try {
    cleanup = plugin.apply(raw.ctx)
  } finally {
    global.setInterval = originalSetInterval
  }
  assert.equal(captured.length, 1)
  assert.equal(captured[0].ms, 15000)
  const session = makeSession({ id: 's-run', events: [ev('turn/end')] })
  raw.ctx.get = (name) => {
    if (name === 'sessions') return { list: () => [session], get: () => session }
    if (name === 'agents') return { get: () => undefined }
    return undefined
  }
  const res = makeResponse()
  await raw.routes.get('exact:/_manager/events')(makeRequest({ method: 'GET' }), res)
  captured[0].fn()
  assert.ok(parseSse(res.text).some((f) => f.comment === 'ping'))
  cleanup()
})

test('events: session events with zero connected clients are no-ops', async () => {
  const session = makeSession({ id: 's-run', events: [ev('turn/start'), ev('turn/end')] })
  const { emit } = makeCtxWithSessions({ sessions: [session] })
  // Must not throw and must not schedule pending recomputes.
  emit('session/event', session, ev('approval/asked', { id: 'a-1' }))
  emit('agent/status', { status: 'idle', agent: { id: 's-run' } })
  emit('session/disposed', session)
  emit('session/created', session)
  await sleep(80)
})

// ---- M12.1: plan-review 等待判定（exit_plan_mode 工具配对，2026-08-26） ----

test('sessions: an unclosed exit_plan_mode call yields waiting (plan review)', async () => {
  const sessions = [
    makeSession({
      id: 's-plan',
      events: [
        ev('turn/start'),
        ev('plan/mode', { active: true }),
        ev('tool/call', { callId: 'call-plan-1', name: 'exit_plan_mode' }),
      ],
    }),
  ]
  const agents = { 's-plan': { status: 'running' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.state, 'waiting')
})

test('sessions: an answered exit_plan_mode returns to working (approved / keep-planning)', async () => {
  const sessions = [
    makeSession({
      id: 's-plan',
      events: [
        ev('turn/start'),
        ev('plan/mode', { active: true }),
        ev('tool/call', { callId: 'call-plan-1', name: 'exit_plan_mode' }),
        ev('plan/mode', { active: false }),
        ev('tool/result', { message: { source: { callId: 'call-plan-1' } } }),
      ],
    }),
  ]
  const agents = { 's-plan': { status: 'running' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.state, 'working')
})

test('sessions: an ordinary running tool (pwsh) never counts as waiting', async () => {
  const sessions = [
    makeSession({
      id: 's-work',
      events: [
        ev('turn/start'),
        ev('tool/call', { callId: 'call-pwsh-1', name: 'pwsh' }),
      ],
    }),
  ]
  const agents = { 's-work': { status: 'running' } }
  const { ctx, routes } = makeCtxWithSessions({ sessions, agents })
  const { body } = await sessionsPayload(ctx, routes, makeRequest({ method: 'GET' }))
  const [item] = JSON.parse(body).items
  assert.equal(item.state, 'working')
})

test('events: exit_plan_mode call pushes an upsert with state waiting', async () => {
  const session = makeSession({
    id: 's-plan',
    events: [ev('turn/start'), ev('plan/mode', { active: true })],
  })
  const agents = { 's-plan': { status: 'running' } }
  const { ctx, routes, emit } = makeCtxWithSessions({ sessions: [session], agents })
  const res = await eventsConnect(ctx, routes, makeRequest({ method: 'GET' }))
  emit('session/event', session, appendEvent(session, ev('tool/call', { callId: 'call-plan-2', name: 'exit_plan_mode' })))
  await sleep(80)
  const upserts = parseSse(res.text).filter((f) => f.event === 'upsert')
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].data.session.state, 'waiting')
})
