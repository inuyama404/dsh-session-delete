// Regression suite for the bulk-delete feature, run without DSH.
//
//   node test/bulk.test.mjs
//
// Fakes the Host plugin context (webServer + sessionPersistence + workspaceRegistry
// + agents) to exercise the real handlers, and fakes the client module loader and
// React to exercise the real store and surfaces.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`FAIL  ${name}\n        ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Fake Host plumbing
// ---------------------------------------------------------------------------
const ID_A = 'session-aaaaaaaa-0000-4000-8000-000000000001'
const ID_B = 'session-bbbbbbbb-0000-4000-8000-000000000002'
const ID_C = 'session-cccccccc-0000-4000-8000-000000000003'
const ID_D = 'session-dddddddd-0000-4000-8000-000000000004'

function makeHome(sessionIds) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bulk-'))
  const workspace = join(home, 'sessions', '--ws--')
  mkdirSync(workspace, { recursive: true })
  for (const id of sessionIds) {
    const dir = join(workspace, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
  }
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  return home
}

function makeCtx({ home, list, running = [], registry = true }) {
  const routes = new Map()
  const logs = []
  const archived = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), debug: () => {} },
    effect: (fn) => fn(),
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'workspaceRegistry') {
        if (!registry) return undefined
        return {
          list: () => [{ sessionIds: list?.map((s) => s.header.id) ?? [], archivedSessionIds: [] }],
          archiveSession: async (id) => {
            if (running.includes(id)) {
              const error = new Error('active')
              error.name = 'WorkspaceActiveSessionError'
              throw error
            }
            archived.push(id)
          },
        }
      }
      if (name === 'agents') return { get: (id) => (running.includes(id) ? { status: 'running' } : undefined) }
      return undefined
    },
    sessionPersistence: {
      list: list === undefined ? undefined : async () => list,
      stat: async (id) => list?.find((s) => s.header.id === id),
      locate: (header) => ({ path: join(home, 'sessions', '--ws--', header.id, 'session.v4.jsonl.zstd') }),
    },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
  }
  return { ctx, routes, logs, archived }
}

function call(handler, { method = 'POST', body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(raw !== undefined ? raw : JSON.stringify(body ?? {})))
        if (event === 'end') cb()
        return req
      },
      destroy() {},
    }
    let status = 0
    const res = {
      writeHead: (code) => { status = code },
      end: (text) => {
        let payload
        try { payload = JSON.parse(text) } catch { payload = text }
        resolve({ status, body: payload })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

const pluginUrl = pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href
const host = await import(pluginUrl)

// ---------------------------------------------------------------------------
// Host: happy path
// ---------------------------------------------------------------------------
{
  const ids = [ID_A, ID_B]
  const home = makeHome(ids)
  const list = ids.map((id, i) => ({ header: { id, createdAt: i, title: `t-${i}` } }))
  const { ctx, routes, logs, archived } = makeCtx({ home, list })
  host.apply(ctx)

  await test('registers delete, plan, bulk and status routes', () => {
    for (const path of ['/dsh-session-delete/delete', '/dsh-session-delete/plan', '/dsh-session-delete/bulk-delete', '/dsh-session-delete/status']) {
      assert.ok(routes.has(path), `missing ${path}`)
    }
  })

  await test('status advertises the bulk endpoints', async () => {
    const { status, body } = await call(routes.get('/dsh-session-delete/status'), { method: 'GET' })
    assert.equal(status, 200)
    assert.equal(body.bulk.maxPerRequest, 200)
    assert.equal(body.bulk.plan, '/dsh-session-delete/plan')
  })

  await test('plan lists candidates from the store', async () => {
    const out = await call(routes.get('/dsh-session-delete/plan'), { method: 'GET' })
    assert.equal(out.status, 200)
    assert.equal(out.body.count, 2)
    assert.deepEqual(out.body.sessions.map((s) => s.sessionId).sort(), ids.slice().sort())
  })

  await test('plan rejects other methods', async () => {
    const out = await call(routes.get('/dsh-session-delete/plan'), { method: 'PUT' })
    assert.equal(out.status, 405)
  })

  await test('bulk rejects a non-POST method', async () => {
    assert.equal((await call(routes.get('/dsh-session-delete/bulk-delete'), { method: 'GET' })).status, 405)
  })

  await test('bulk rejects a body without sessionIds', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { ids: [] } })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, 'bad-request')
  })

  await test('bulk rejects a malformed id', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { sessionIds: ['../etc/passwd'] } })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, 'invalid-session-id')
  })

  await test('bulk rejects an oversized body', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { raw: JSON.stringify({ sessionIds: [ID_A], pad: 'x'.repeat(9000) }) })
    assert.equal(out.status, 400)
  })

  await test('bulk deletes every valid id and reports counts', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { sessionIds: ids } })
    assert.equal(out.status, 200)
    assert.equal(out.body.deleted, 2)
    assert.equal(out.body.failed, 0)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.remaining, 0)
    assert.equal(out.body.results.length, 2)
    for (const row of out.body.results) assert.equal(row.ok, true)
  })

  await test('the session directories are really gone', () => {
    for (const id of ids) assert.equal(existsSync(join(home, 'sessions', '--ws--', id)), false)
  })

  await test('workspace accounting was archived for each session', () => {
    for (const id of ids) assert.ok(archived.includes(id), `not archived: ${id}`)
  })

  await test('bulk logs a durable summary', () => {
    const summary = logs.find((m) => m.includes('bulk delete:'))
    assert.ok(summary, `expected a bulk summary, got: ${JSON.stringify(logs)}`)
    assert.match(summary, /2\/2 removed/)
  })

  await test('deleting the same ids again reports no-artifact, not an error', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { sessionIds: ids } })
    assert.equal(out.status, 200)
    assert.equal(out.body.deleted, 2)
    for (const row of out.body.results) assert.equal(row.note, 'no-artifact')
  })

  rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Host: partial failure and dedup
// ---------------------------------------------------------------------------
{
  const ids = [ID_C, ID_D]
  const home = makeHome(ids)
  const list = ids.map((id) => ({ header: { id, createdAt: 1 } }))
  const { ctx, routes } = makeCtx({ home, list, running: [ID_C] })
  host.apply(ctx)

  await test('a running session fails alone and the batch continues', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { sessionIds: ids } })
    assert.equal(out.status, 200)
    assert.equal(out.body.deleted, 1)
    assert.equal(out.body.failed, 1)
    assert.equal(out.body.ok, false)
    const blocked = out.body.results.find((r) => r.sessionId === ID_C)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.error, 'session-running')
    assert.equal(out.body.results.find((r) => r.sessionId === ID_D).ok, true)
  })

  await test('only the running session survives on disk', () => {
    assert.equal(existsSync(join(home, 'sessions', '--ws--', ID_D)), false)
    assert.equal(existsSync(join(home, 'sessions', '--ws--', ID_C)), true)
  })

  await test('bulk deduplicates repeated ids', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { sessionIds: [ID_C, ID_C, ID_C] } })
    assert.equal(out.body.requested, 1)
    assert.equal(out.body.results.length, 1)
  })

  rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Host: discovery fallbacks and degradation
// ---------------------------------------------------------------------------
{
  const home = makeHome([ID_A])
  const { ctx, routes } = makeCtx({ home, list: undefined })
  host.apply(ctx)
  await test('plan falls back to the artifact directories', async () => {
    const out = await call(routes.get('/dsh-session-delete/plan'), { method: 'GET' })
    assert.equal(out.status, 200)
    assert.deepEqual(out.body.sessions.map((s) => s.sessionId), [ID_A])
  })
  rmSync(home, { recursive: true, force: true })
}

{
  const home = makeHome([ID_A])
  const { ctx, routes } = makeCtx({ home, list: undefined })
  ctx.sessionPersistence.list = async () => { throw new Error('boom') }
  host.apply(ctx)
  await test('plan survives a failing list() by falling back', async () => {
    const out = await call(routes.get('/dsh-session-delete/plan'), { method: 'GET' })
    assert.equal(out.status, 200)
    assert.equal(out.body.count, 1)
  })
  rmSync(home, { recursive: true, force: true })
}

{
  const home = makeHome([ID_A])
  const { ctx, routes } = makeCtx({ home, list: [{ header: { id: ID_A, createdAt: 1 } }], registry: false })
  host.apply(ctx)
  await test('bulk still deletes when workspaceRegistry is absent', async () => {
    const out = await call(routes.get('/dsh-session-delete/bulk-delete'), { body: { sessionIds: [ID_A] } })
    assert.equal(out.body.deleted, 1)
    assert.equal(existsSync(join(home, 'sessions', '--ws--', ID_A)), false)
  })
  rmSync(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Client: real module, fake loader and hook-free React
// ---------------------------------------------------------------------------
const fakeReact = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState: (initial) => {
    let value = initial
    return [value, (next) => { value = typeof next === 'function' ? next(value) : next }]
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => {
    subscribe(() => {})
    return getSnapshot()
  },
}

let clientModule = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      clientModule = factory((id) => {
        if (id === 'react') return fakeReact
        throw new Error(`unexpected require: ${id}`)
      })
    },
  },
}
await import(pathToFileURL(join(import.meta.dirname, '..', 'client.js')).href)

function makeClientCtx(provideLocale = true) {
  const slotRegistrations = []
  const provided = new Map()
  const dictionaries = []
  const ctx = {
    get: (name) => (name === 'locale' && provideLocale
      ? { register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} } }
      : undefined),
    effect: (fn) => fn(),
    provide: (name, value) => provided.set(name, value),
    slots: {
      inject: (_name, fn) => fn(),
      register: (config, Component) => {
        slotRegistrations.push({ config, Component })
        return () => {}
      },
    },
  }
  return { ctx, slotRegistrations, provided, dictionaries }
}

await test('client declares slots and locale injection', () => {
  assert.deepEqual(clientModule.inject, ['slots', 'locale'])
})

await test('client registers its dictionaries once', () => {
  const { ctx, dictionaries } = makeClientCtx()
  clientModule.apply(ctx)
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'dsh-session-delete')
  assert.ok(dictionaries[0].dicts.zh['bulk.delete'])
  assert.ok(dictionaries[0].dicts.en['bulk.delete'])
})

await test('menu slot gets the single row, the bulk row and the per-row select', () => {
  const { ctx, slotRegistrations } = makeClientCtx()
  clientModule.apply(ctx)
  const ids = slotRegistrations
    .filter((r) => r.config.name === 'sidebar.workspaces.session.menu.item')
    .map((r) => r.config.id)
    .sort()
  assert.deepEqual(ids, [
    'dsh-session-delete.bulk-mode',
    'dsh-session-delete.delete-session',
    'dsh-session-delete.row-select',
  ])
})

await test('leading slot gets only the checkbox', () => {
  const { ctx, slotRegistrations } = makeClientCtx()
  clientModule.apply(ctx)
  const ids = slotRegistrations
    .filter((r) => r.config.name === 'sidebar.session.row.leading')
    .map((r) => r.config.id)
  assert.deepEqual(ids, ['dsh-session-delete.row-checkbox'])
})

await test('the bar lives in the frame-wide shell.overlay slot', () => {
  const { ctx, slotRegistrations } = makeClientCtx()
  clientModule.apply(ctx)
  const ids = slotRegistrations.filter((r) => r.config.name === 'shell.overlay').map((r) => r.config.id)
  assert.deepEqual(ids, ['dsh-session-delete.bulk-bar'])
})

await test('every surface passes the locale seat (this was the English bug)', () => {
  const { ctx, slotRegistrations } = makeClientCtx()
  clientModule.apply(ctx)
  assert.ok(slotRegistrations.length >= 5, `expected 5+ registrations, got ${slotRegistrations.length}`)
  for (const { config } of slotRegistrations) {
    assert.equal(config.locale, 'dsh-session-delete', `missing locale on ${config.id}`)
  }
})

// The store is exercised directly: it is the piece with the real logic.
const { ctx: storeCtx, provided } = makeClientCtx()
clientModule.apply(storeCtx)
const store = provided.get('sessionDeleteSelection')

await test('the selection store is published as a client service', () => {
  assert.ok(store, 'expected sessionDeleteSelection')
  assert.equal(store.getSnapshot().active, false)
})

await test('activate enters selection with an empty set', () => {
  store.activate()
  const s = store.getSnapshot()
  assert.equal(s.active, true)
  assert.deepEqual(s.selected, [])
})

await test('toggle adds then removes', () => {
  store.toggle('session-a')
  assert.deepEqual(store.getSnapshot().selected, ['session-a'])
  store.toggle('session-a')
  assert.deepEqual(store.getSnapshot().selected, [])
})

await test('selectMany adds without duplicates', () => {
  store.selectMany(['session-a', 'session-b'])
  store.selectMany(['session-b', 'session-c'])
  assert.deepEqual(store.getSnapshot().selected.slice().sort(), ['session-a', 'session-b', 'session-c'])
})

await test('begin arms only a non-empty selection', () => {
  store.clear()
  assert.equal(store.begin(), false)
  store.selectMany(['session-a'])
  assert.equal(store.begin(), true)
  assert.equal(store.getSnapshot().phase, 'armed')
})

await test('deactivate clears the batch and leaves selection', () => {
  store.activate()
  store.selectMany(['session-a'])
  assert.equal(store.deactivate(), true)
  const s = store.getSnapshot()
  assert.equal(s.active, false)
  assert.deepEqual(s.selected, [])
})

await test('run refuses an empty selection', async () => {
  store.activate()
  assert.equal(await store.run(), null)
})

await test('client still applies cleanly without a locale service', () => {
  const { ctx } = makeClientCtx(false)
  assert.doesNotThrow(() => clientModule.apply(ctx))
})

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`\n${f.name}\n${f.error?.stack ?? f.error}`)
  process.exit(1)
}
console.log('ALL PASS')
