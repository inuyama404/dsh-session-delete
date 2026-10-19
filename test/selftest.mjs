/**
 * Self-test for dsh-session-delete: exercises the Host route against a fake DSH
 * home and the Client half against a fake module loader, without booting DSH.
 *
 *   node test/selftest.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const sandboxRoot = join(here, '.sandbox', 'home')
const SESSION_ID = 'session-11112222-3333-4444-5555-666677778888'
const CWD = join(here, '.sandbox', 'workspace')
const sessionDir = join(sandboxRoot, 'sessions', '--test-workspace--', SESSION_ID)
const cacheRecord = join(sandboxRoot, 'storages', 'session_projcache', 'sessions', `${SESSION_ID}.json`)

let failures = 0
function check(label, condition, detail = '') {
  const ok = condition === true
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`)
}

/** Build one fake request emitting a JSON body. */
function fakeRequest(method, body) {
  const listeners = new Map()
  const request = {
    method,
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

/** Build one fake response resolving on end. */
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

async function hostTest() {
  console.log('\n--- Host half ---')
  await rm(sandboxRoot, { recursive: true, force: true })
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  await mkdir(dirname(cacheRecord), { recursive: true })
  await writeFile(cacheRecord, '{}')
  await mkdir(CWD, { recursive: true })

  const header = { version: 4, id: SESSION_ID, createdAt: 1, isSeeded: false, cwd: CWD }
  const calls = { archived: [], detached: [], registered: [], warned: [] }
  let agentStatus

  const registry = {
    async archiveSession(id) { calls.archived.push(id) },
    list() {
      return [
        { sessionIds: [SESSION_ID], async detachSession(id) { calls.detached.push(id) } },
        { sessionIds: [], async detachSession(id) { calls.detached.push(`other:${id}`) } },
      ]
    },
  }

  const routes = []
  const makeCtx = (withRegistry = true) => ({
    logger: { warn: (message) => calls.warned.push(String(message)), debug: () => {} },
    effect(callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    webServer: { register(route) { routes.push(route); calls.registered.push(route.path); return () => {} } },
    sessionPersistence: {
      async stat(id) { return id === SESSION_ID ? { header, revision: 'r1' } : undefined },
      locate(meta) { return { kind: 'jsonl', path: join(sandboxRoot, 'sessions', '--test-workspace--', meta.id, 'session.v4.jsonl.zstd') } },
    },
    get(name) {
      if (name === 'agents') return { get: () => (agentStatus === undefined ? undefined : { status: agentStatus }) }
      if (name === 'dshHomePath') return (...segments) => join(sandboxRoot, ...segments)
      if (name === 'workspaceRegistry') return withRegistry ? registry : undefined
      return undefined
    },
  })

  const plugin = await import(pathToFileURL(join(pluginDir, 'index.js')).href)
  check('exports apply()', typeof plugin.apply === 'function')
  check('requires only webServer + sessionPersistence', Array.isArray(plugin.inject) && plugin.inject.join() === 'webServer,sessionPersistence', plugin.inject.join())

  const ctx = makeCtx()
  plugin.apply(ctx)
  const deleteRoute = routes.find((candidate) => candidate.path === '/dsh-session-delete/delete')
  const statusRoute = routes.find((candidate) => candidate.path === '/dsh-session-delete/status')
  check('registers the delete route', deleteRoute !== undefined && deleteRoute.kind === 'exact', JSON.stringify(calls.registered))
  check('registers the status route', statusRoute !== undefined && statusRoute.kind === 'exact', JSON.stringify(calls.registered))

  const status = fakeResponse()
  await statusRoute.handler(fakeRequest('GET', undefined), status.response)
  await status.done
  // Compare against the manifest so a version bump cannot break the suite.
  const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  check(
    'status names the running code',
    status.response.payload?.version === manifest.version && status.response.payload?.workspaceRegistry === true,
    JSON.stringify(status.response.payload),
  )

  const route = deleteRoute
  const invoke = async (method, body) => {
    const { response, done } = fakeResponse()
    await route.handler(fakeRequest(method, body), response)
    await done
    return response
  }

  let response = await invoke('GET', undefined)
  check('rejects non-POST with 405', response.status === 405, String(response.status))

  response = await invoke('POST', JSON.stringify({ sessionId: '../../etc' }))
  check('rejects a traversal-shaped id with 400', response.status === 400, JSON.stringify(response.payload))

  agentStatus = 'running'
  response = await invoke('POST', JSON.stringify({ sessionId: SESSION_ID }))
  check('refuses a running session with 409', response.status === 409 && response.payload?.error === 'session-running', JSON.stringify(response.payload))

  agentStatus = undefined
  response = await invoke('POST', JSON.stringify({ sessionId: SESSION_ID }))
  check('deletes a stored session with 200', response.status === 200 && response.payload?.ok === true, JSON.stringify(response.payload))
  check('archives before deleting', calls.archived.includes(SESSION_ID))
  check('detaches only the owning workspace', JSON.stringify(calls.detached) === JSON.stringify([SESSION_ID]), JSON.stringify(calls.detached))
  check('removes the session directory', !existsSync(sessionDir))
  check('removes the projection-cache record', !existsSync(cacheRecord))
  check('reports both removed paths', Array.isArray(response.payload?.removed) && response.payload.removed.length === 2, JSON.stringify(response.payload?.removed))

  response = await invoke('POST', JSON.stringify({ sessionId: SESSION_ID }))
  check('a second delete is a no-op success', response.status === 200 && response.payload?.note === 'no-artifact', JSON.stringify(response.payload))

  // Degraded composition: the Workspace registry failed to activate, so the
  // route must still delete the artifacts and say so.
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  await mkdir(dirname(cacheRecord), { recursive: true })
  await writeFile(cacheRecord, '{}')
  const degradedRoutes = []
  const degradedWarnings = []
  const degradedCtx = {
    logger: { warn: (message) => degradedWarnings.push(String(message)), debug: () => {} },
    effect: (callback) => { callback(); return () => {} },
    webServer: { register: (route) => { degradedRoutes.push(route); return () => {} } },
    sessionPersistence: ctx.sessionPersistence,
    get: (name) => {
      if (name === 'dshHomePath') return (...segments) => join(sandboxRoot, ...segments)
      return undefined
    },
  }
  plugin.apply(degradedCtx)
  const degraded = fakeResponse()
  await degradedRoutes.find((candidate) => candidate.path === '/dsh-session-delete/delete').handler(fakeRequest('POST', JSON.stringify({ sessionId: SESSION_ID })), degraded.response)
  await degraded.done
  check('deletes without a workspace registry', degraded.response.status === 200 && degraded.response.payload?.ok === true, JSON.stringify(degraded.response.payload))
  check('degrades without a workspace registry', !existsSync(sessionDir) && !existsSync(cacheRecord))
  check('warns that the row stays visible', degradedWarnings.some((line) => line.includes('no workspace registry')), JSON.stringify(degradedWarnings))
}

function clientTestData() {
  const fakeReact = (() => {
    let states = []
    let cursor = 0
    return {
      React: {
        createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
        useState: (initial) => {
          const index = cursor++
          if (!(index in states)) states[index] = initial
          return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
        },
        useCallback: (fn) => fn,
      },
      begin: () => { cursor = 0 },
      reset: () => { cursor = 0; states = [] },
    }
  })()
  return fakeReact
}

async function clientTest() {
  console.log('\n--- Client half ---')
  const source = await readFile(join(pluginDir, 'client.js'), 'utf8')
  const runtime = clientTestData()
  const edits = []
  const requests = []
  const menus = []

  const primitives = {
    MenuItemButton: function MenuItemButton(props) { return { type: 'MenuItemButton', props } },
    IconTrashOutlineRegular: function IconTrashOutlineRegular(props) { return { type: 'IconTrashOutlineRegular', props } },
  }

  const sandbox = {
    console,
    window: { __ModuleLoader__: { load: (spec) => { sandbox.__captured = spec } } },
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, async json() { return { ok: true, removed: ['x'] } } }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  const captured = sandbox.__captured
  check('registers a module factory with the package id', captured?.id === 'dsh-session-delete', String(captured?.id))

  const plugin = captured.factory((name) => {
    if (name === 'react') return runtime.React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${name}`)
  })
  check('injects slots + locale', Array.isArray(plugin.inject) && plugin.inject.join() === 'slots,locale' && typeof plugin.apply === 'function')

  let registration
  const registrations = []
  const provided = new Map()
  const dictionaries = []
  const ctx = {
    effect(callback) { const dispose = callback(); return () => { if (typeof dispose === 'function') dispose() } },
    // A locale service is present, so every surface must be given its seat.
    get: (name) => (name === 'locale'
      ? { register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} } }
      : undefined),
    provide(name, value) { provided.set(name, value) },
    slots: {
      inject(name, register) {
        check(
          'injects a known slot',
          name === 'sidebar.workspaces.session.menu.item'
            || name === 'sidebar.session.row.leading'
            || name === 'shell.overlay',
          name,
        )
        register()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        if (options?.id === 'dsh-session-delete.delete-session') registration = { options, Component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  check('publishes the selection service', provided.has('sessionDeleteSelection'), String(provided.has('sessionDeleteSelection')))
  check('registers every surface', registrations.length === 5, String(registrations.length))
  check(
    'every surface carries the locale seat',
    registrations.every(({ options }) => options?.locale === 'dsh-session-delete'),
    JSON.stringify(registrations.map(({ options }) => [options?.id, options?.locale])),
  )
  check('registers with order 500', registration?.options?.order === 500, String(registration?.options?.order))
  check('registers a unique id', registration?.options?.id === 'dsh-session-delete.delete-session', String(registration?.options?.id))

  const Component = registration.Component
  const injected = registration.options.inject()
  const props = {
    sessionId: SESSION_ID,
    displayTitle: '在iPhone部署AI代打暗影格斗2',
    useMenuOpenState: () => [true, (open) => menus.push(open)],
    deleteSession: async (id) => { edits.push(id); return injected.deleteSession(id) },
  }

  runtime.begin()
  let tree = Component(props)
  check('renders the primitives menu row', tree?.type === primitives.MenuItemButton)
  check('first row is the delete label', String(tree.props.children) === 'Delete session', String(tree.props.children))
  check('row is destructive', tree.props.danger === true)
  check('row starts a group', tree.props.separatorBefore === true)

  tree.props.onSelect()
  runtime.begin()
  tree = Component(props)
  check('second row arms the confirmation', String(tree.props.children).startsWith('Confirm delete'), String(tree.props.children))

  await tree.props.onSelect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('confirmation calls the host once', edits.length === 1 && edits[0] === SESSION_ID, JSON.stringify(edits))
  check('confirmation posts to the plugin route', requests[0]?.url === '/dsh-session-delete/delete', String(requests[0]?.url))
  check('success closes the menu', menus.includes(false), JSON.stringify(menus))
  runtime.begin()
  tree = Component(props)
  check('success state renders Deleted', String(tree.props.children) === 'Deleted', String(tree.props.children))

  // Failure path: the host refusal becomes the row label and stays retryable.
  runtime.reset()
  const failedProps = {
    ...props,
    deleteSession: async () => { throw new Error('the session is running') },
  }
  runtime.begin()
  let failed = Component(failedProps)
  failed.props.onSelect()
  runtime.begin()
  failed = Component(failedProps)
  await failed.props.onSelect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  runtime.begin()
  failed = Component(failedProps)
  check('failure surfaces the reason', String(failed.props.children).includes('the session is running'), String(failed.props.children))

  // Fallback lane: no primitives module must still render one menuitem button.
  const fallbackPlugin = captured.factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error('primitives unavailable')
  })
  let fallbackRegistration
  fallbackPlugin.apply({
    effect: (callback) => { callback(); return () => {} },
    get: () => undefined,
    provide: () => {},
    slots: {
      inject: (_name, register) => { register() },
      register: (options, Component) => {
        if (options?.id === 'dsh-session-delete.delete-session') fallbackRegistration = { options, Component }
        return () => {}
      },
    },
  })
  runtime.reset()
  runtime.begin()
  const fallbackTree = fallbackRegistration.Component(failedProps)
  check('fallback renders a menuitem button', fallbackTree?.type === 'button' && fallbackTree.props.role === 'menuitem')
  check('fallback keeps the error-coded color', String(fallbackTree.props.style.color).includes('--dsw-alias-state-error-primary'))
}

await hostTest()
await clientTest()
await rm(join(here, '.sandbox'), { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
