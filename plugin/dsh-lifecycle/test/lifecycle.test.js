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
  // Both routes registered before apply returned.
  assert.deepEqual(disposed, [])
  cleanup()
  assert.deepEqual(disposed.sort(), ['/_lifecycle/health', '/_lifecycle/shutdown'].sort())
})

test('apply registers exactly two exact routes', () => {
  const { ctx, routes } = makeCtx()
  plugin.apply(ctx)
  assert.equal(routes.size, 2)
  assert.ok(routes.has('exact:/_lifecycle/health'))
  assert.ok(routes.has('exact:/_lifecycle/shutdown'))
})
