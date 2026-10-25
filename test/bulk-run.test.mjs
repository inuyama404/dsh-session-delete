// Focused tests for store.run(): auto-close on success, keep only refused ids on
// a partial result, keep everything on a transport failure.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const fakeReact = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => {
    subscribe(() => {})
    return getSnapshot()
  },
}

let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      mod = factory((id) => {
        if (id === 'react') return fakeReact
        throw new Error(`no module ${id}`)
      })
    },
  },
}
await import(pathToFileURL(join(import.meta.dirname, '..', 'client.js')).href)

const provided = new Map()
mod.apply({
  get: (n) => (n === 'locale' ? { register: () => () => {} } : undefined),
  effect: (fn) => fn(),
  provide: (n, v) => provided.set(n, v),
  slots: { inject: (_n, fn) => fn(), register: () => () => {} },
})
const store = provided.get('sessionDeleteSelection')

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`FAIL  ${name}\n        ${error.message}`)
  }
}

const A = 'session-aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'session-bbbbbbbb-0000-4000-8000-00000000000b'
const realFetch = globalThis.fetch
const stub = (payload) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload })
}

await test('a clean run closes selection mode', async () => {
  stub({ ok: true, requested: 3, deleted: 3, failed: 0, remaining: 0, results: [
    { sessionId: A, ok: true }, { sessionId: B, ok: true },
  ] })
  store.activate()
  store.selectMany([A, B])
  store.begin()
  const payload = await store.run()
  const s = store.getSnapshot()
  assert.equal(payload.deleted, 3)
  assert.equal(s.active, false, 'selection mode must close after a clean run')
  assert.deepEqual(s.selected, [])
  assert.equal(s.phase, 'done')
})

await test('a partial run keeps only the refused sessions', async () => {
  stub({ ok: false, requested: 2, deleted: 1, failed: 1, remaining: 0, results: [
    { sessionId: A, ok: true },
    { sessionId: B, ok: false, status: 409, error: 'session-running' },
  ] })
  store.activate()
  store.selectMany([A, B])
  store.begin()
  await store.run()
  const s = store.getSnapshot()
  assert.equal(s.active, true, 'must stay in selection mode when something failed')
  assert.deepEqual(s.selected, [B], 'only the refused session stays selected')
  assert.equal(s.phase, 'failed')
  assert.equal(s.result.failed, 1)
})

await test('a transport failure keeps every id for a retry', async () => {
  globalThis.fetch = async () => { throw new Error('offline') }
  store.activate()
  store.selectMany([A, B])
  store.begin()
  const payload = await store.run()
  const s = store.getSnapshot()
  assert.equal(payload, null)
  assert.equal(s.active, true)
  assert.deepEqual(s.selected.slice().sort(), [A, B])
  assert.equal(s.phase, 'failed')
  // postBatch maps a transport failure to the localized "cannot reach the host".
  assert.ok(typeof s.result.message === 'string' && s.result.message.length > 0, JSON.stringify(s.result.message))
})

await test('run refuses while busy', async () => {
  store.activate()
  store.selectMany([A])
  const first = store.run()
  const second = await store.run()
  assert.equal(second, null, 'a second run while busy must be a no-op')
  stub({ ok: true, deleted: 1, failed: 0, remaining: 0, results: [{ sessionId: A, ok: true }] })
  await first
})

// ---- the session currently being viewed ----------------------------------
await test('select all skips the open session', async () => {
  store.setCurrentResolver(() => B)
  store.activate()
  store.selectMany([A, B])
  const s = store.getSnapshot()
  assert.deepEqual(s.selected, [A], 'the open session must never be selected')
})

await test('the open session stays out of the batch even if it was selected', async () => {
  store.setCurrentResolver(() => A)
  store.activate()
  store.selectMany([A, B])
  // Bypass selectMany's filter to simulate a stale selection from before a switch.
  store.toggle(A)
  store.begin()
  let called = 0
  globalThis.fetch = async (url, init) => {
    // The client also reports its state to the plugin's diagnostic route; only the
    // batch request is under test here.
    if (url !== '/dsh-session-delete/bulk-delete') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    called += 1
    const body = JSON.parse(init.body)
    assert.deepEqual(body.sessionIds, [B], 'the request must not contain the open session')
    return { ok: true, status: 200, json: async () => ({ ok: true, deleted: 1, failed: 0, remaining: 0, results: [{ sessionId: B, ok: true }] }) }
  }
  await store.run()
  assert.equal(called, 1)
  assert.equal(store.getSnapshot().skippedCurrent, true, 'it should report that it was skipped')
})

await test('a batch of only the open session sends nothing', async () => {
  store.setCurrentResolver(() => A)
  store.activate()
  store.toggle(A)
  assert.deepEqual(store.getSnapshot().selected, [A], 'the low-level toggle can still add it')
  store.begin()
  let called = 0
  globalThis.fetch = async () => { called += 1; throw new Error('should not be called') }
  const payload = await store.run()
  assert.equal(payload, null)
  assert.equal(called, 0, 'no request may be sent')
  const s = store.getSnapshot()
  assert.deepEqual(s.selected, [])
  assert.equal(s.active, true)
})

store.setCurrentResolver(() => null)

globalThis.fetch = realFetch
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
