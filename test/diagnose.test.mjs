/**
 * Regression suite for the deletion guarantees that make a delete verifiable
 * rather than assumed:
 *
 *   - a session's id leaves the archive set once its log is gone, so no surface
 *     keeps offering a row for a session that no longer exists;
 *   - a log directory that is not at the documented depth is still found (an
 *     upgraded host may nest it differently), instead of archiving without
 *     deleting anything;
 *   - a session the store knows but whose directory is nowhere on disk is
 *     refused rather than silently archived;
 *   - the diagnose route reports what a delete would see.
 *
 *   node test/diagnose.test.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const sandbox = join(here, '.diag')
const home = join(sandbox, 'home')
const workspacePath = join(sandbox, 'workspace')
const ID = 'session-aaaa1111-2222-3333-4444-555566667777'
const canonicalDir = join(home, 'sessions', '--test-workspace--', ID)
const cacheRecord = join(home, 'storages', 'session_projcache', 'sessions', `${ID}.json`)

let failures = 0
function check(label, condition, detail = '') {
  const ok = condition === true
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

/** One fake request; `url` is what the diagnose route reads. */
function fakeRequest(method, body, url = '/') {
  const listeners = new Map()
  const request = {
    method,
    url,
    destroy() {},
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return request
    },
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const callback of listeners.get('data') ?? []) callback(Buffer.from(body, 'utf8'))
    for (const callback of listeners.get('end') ?? []) callback()
  })
  return request
}

function fakeResponse() {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const response = {
    status: 0,
    payload: undefined,
    writeHead(status) { response.status = status },
    end(text) { response.payload = text === undefined ? undefined : JSON.parse(text); settle() },
  }
  return { response, done }
}

const plugin = await import(pathToFileURL(join(pluginDir, 'index.js')).href)

/**
 * Build a host context with the given registry and store behaviour, and return the
 * registered routes plus the recording registry.
 */
function makeHost({ archived = [], account = true } = {}) {
  const calls = { archived: [], detached: [], unarchived: [] }
  const registry = {
    archivedSessionIds: [...archived],
    async archiveSession(id) {
      calls.archived.push(id)
      if (!registry.archivedSessionIds.includes(id)) registry.archivedSessionIds.push(id)
    },
    async unarchiveSession(id) {
      calls.unarchived.push(id)
      registry.archivedSessionIds = registry.archivedSessionIds.filter((candidate) => candidate !== id)
    },
    list() {
      return account
        ? [{ path: workspacePath, sessionIds: [ID], async detachSession(id) { calls.detached.push(id) } }]
        : []
    },
  }
  const routes = []
  const state = { stat: undefined, locate: undefined }
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    effect(callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
    sessionPersistence: {
      async stat() { return state.stat },
      locate(meta) { return state.locate(meta) },
    },
    get(name) {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'dshHomePath') return (...segments) => join(home, ...segments)
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
  plugin.apply(ctx)
  return { routes, calls, registry, state }
}

/** Seed the store answer plus the artifact layout a test wants. `directory: null` means none. */
async function seed(state, { directory = canonicalDir, cache = true, store = 'ok', locate = 'matches' } = {}) {
  await rm(sandbox, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })
  // The scan needs the sessions root to exist; a test without artifacts simply
  // leaves it empty apart from an unrelated workspace directory.
  await mkdir(join(home, 'sessions', '--other-workspace--'), { recursive: true })
  const header = { version: 4, id: ID, createdAt: 1, cwd: workspacePath }
  state.stat = store === 'missing' ? undefined : { header, revision: 'r1' }
  state.locate = (meta) => {
    if (locate === 'throws') throw new Error('locate is unavailable')
    if (locate === 'elsewhere') return { kind: 'jsonl', path: join(home, 'decoy.json') }
    return { kind: 'jsonl', path: join(directory, 'session.v4.jsonl.zstd') }
  }
  if (directory !== null) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'log-bytes')
  }
  if (cache) {
    await mkdir(dirname(cacheRecord), { recursive: true })
    await writeFile(cacheRecord, '{}')
  }
  return header
}

async function call(routes, path, method, body, url) {
  const route = routes.find((candidate) => candidate.path === path)
  const { response, done } = fakeResponse()
  await route.handler(fakeRequest(method, body, url), response)
  await done
  return response
}

console.log('--- archive mark ---')
{
  const { routes, calls, registry, state } = makeHost({ archived: [ID] })
  await seed(state)
  const response = await call(routes, '/dsh-session-delete/delete', 'POST', JSON.stringify({ sessionId: ID }))
  check('still deletes the artifacts', response.status === 200 && !existsSync(canonicalDir), JSON.stringify(response.payload))
  // An archived id stays in the client's session list, so leaving the mark behind
  // lists the deleted session as a loose "Ungrouped" row.
  check('clears the archive mark', calls.unarchived.includes(ID) && !registry.archivedSessionIds.includes(ID), JSON.stringify(calls.unarchived))
  check('leaves no archived referent', registry.archivedSessionIds.length === 0, JSON.stringify(registry.archivedSessionIds))
}

console.log('\n--- session that was never archived ---')
{
  const { routes, calls, registry, state } = makeHost()
  await seed(state)
  const response = await call(routes, '/dsh-session-delete/delete', 'POST', JSON.stringify({ sessionId: ID }))
  check('deletes a session that was never archived', response.status === 200 && !existsSync(canonicalDir), JSON.stringify(response.payload))
  check('hides it by archiving first', calls.archived.includes(ID), JSON.stringify(calls.archived))
  check('clears the mark it just set', calls.unarchived.includes(ID) && registry.archivedSessionIds.length === 0, JSON.stringify(registry.archivedSessionIds))
}

console.log('\n--- layout fallback ---')
{
  const { routes, state } = makeHost()
  const nested = join(home, 'sessions', '--test-workspace--', 'nested', 'deeper', ID)
  await seed(state, { directory: nested, cache: false, locate: 'elsewhere' })
  const response = await call(routes, '/dsh-session-delete/delete', 'POST', JSON.stringify({ sessionId: ID }))
  check('finds a deeper layout by name', response.status === 200 && Array.isArray(response.payload?.removed) && response.payload.removed.includes(nested), JSON.stringify(response.payload))
  check('removes the deeper directory', !existsSync(nested))
}

console.log('\n--- locate throws ---')
{
  const { routes, state } = makeHost()
  await seed(state, { locate: 'throws' })
  const response = await call(routes, '/dsh-session-delete/delete', 'POST', JSON.stringify({ sessionId: ID }))
  check('falls back to the disk scan when locate fails', response.status === 200 && !existsSync(canonicalDir), JSON.stringify(response.payload))
}

console.log('\n--- store knows it, disk does not ---')
{
  const { routes, calls, registry, state } = makeHost()
  await seed(state, { directory: null, cache: false, locate: 'elsewhere' })
  const response = await call(routes, '/dsh-session-delete/delete', 'POST', JSON.stringify({ sessionId: ID }))
  check('succeeds without inventing an artifact', response.status === 200 && response.payload?.note === 'not-materialized', JSON.stringify(response.payload))
  check('still drops the accounting entry', calls.detached.includes(ID), JSON.stringify(calls.detached))
  // Nothing to unlink, so hiding it is the whole delete: archive, then clear the
  // mark again so the client's list can drop the id.
  check('hides the blank session', calls.archived.includes(ID), JSON.stringify(calls.archived))
  check('clears the mark after hiding it', calls.unarchived.includes(ID) && registry.archivedSessionIds.length === 0, JSON.stringify(registry.archivedSessionIds))
}

console.log('\n--- attempt log ---')
{
  const { routes, state } = makeHost()
  await seed(state)
  let response = await call(routes, '/dsh-session-delete/last', 'POST', undefined, '/dsh-session-delete/last')
  check('rejects a non-GET attempt-log read with 405', response.status === 405, String(response.status))

  const before = (await call(routes, '/dsh-session-delete/last', 'GET', undefined, '/dsh-session-delete/last')).payload
  await call(routes, '/dsh-session-delete/delete', 'POST', JSON.stringify({ sessionId: ID }))
  response = await call(routes, '/dsh-session-delete/last', 'GET', undefined, '/dsh-session-delete/last')
  const attempts = response.payload?.attempts ?? []
  check(
    'records the attempt',
    response.status === 200 && (response.payload?.count ?? 0) === (before?.count ?? 0) + 1,
    JSON.stringify(response.payload?.count),
  )
  check(
    'records the outcome',
    attempts[0]?.sessionId === ID && attempts[0]?.ok === true && attempts[0]?.removed === 2,
    JSON.stringify(attempts[0]),
  )
}

console.log('\n--- client state report ---')
{
  const { routes } = makeHost()
  let response = await call(routes, '/dsh-session-delete/report', 'GET', undefined, '/dsh-session-delete/report')
  check('serves the report route', response.status === 200 && response.payload?.ok === true, String(response.status))

  response = await call(routes, '/dsh-session-delete/report', 'POST', JSON.stringify({ reason: 'mount', ids: [ID], workspaces: [] }))
  check('stores a client report', response.status === 200 && response.payload?.stored === true, JSON.stringify(response.payload))

  response = await call(routes, '/dsh-session-delete/report', 'GET', undefined, '/dsh-session-delete/report')
  check(
    'returns what the client held',
    response.payload?.report?.reason === 'mount' && response.payload?.report?.ids?.[0] === ID,
    JSON.stringify(response.payload?.report),
  )

  response = await call(routes, '/dsh-session-delete/report', 'PUT', undefined, '/dsh-session-delete/report')
  check('rejects other methods with 405', response.status === 405, String(response.status))
}

console.log('\n--- diagnose route ---')
{
  const { routes, state } = makeHost()
  await seed(state)
  let response = await call(routes, '/dsh-session-delete/diagnose', 'GET', undefined, '/dsh-session-delete/diagnose')
  check('rejects a missing session id with 400', response.status === 400 && response.payload?.error === 'invalid-session-id', JSON.stringify(response.payload))

  response = await call(routes, '/dsh-session-delete/diagnose', 'GET', undefined, `/dsh-session-delete/diagnose?sessionId=${ID}`)
  check('reports a deletable session', response.status === 200 && response.payload?.verdict === 'deletable', JSON.stringify(response.payload?.verdict))
  check('reports the located directory', response.payload?.artifacts?.directory === canonicalDir, String(response.payload?.artifacts?.directory))
  check('reports the cache record', response.payload?.artifacts?.cacheExists === true)
  check('reports workspace accounting', Array.isArray(response.payload?.account?.accountedIn) && response.payload.account.accountedIn.includes(workspacePath), JSON.stringify(response.payload?.account))

  await rm(canonicalDir, { recursive: true, force: true })
  response = await call(routes, '/dsh-session-delete/diagnose', 'GET', undefined, `/dsh-session-delete/diagnose?sessionId=${ID}`)
  check('reports a store entry without artifacts', response.payload?.verdict === 'store-without-artifact', JSON.stringify(response.payload?.verdict))
}

await rm(sandbox, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
