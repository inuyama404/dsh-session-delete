/**
 * dsh-session-delete — Host half.
 *
 * Serves one exact HTTP route the Client half calls:
 *
 *   POST /dsh-session-delete/delete   body: { "sessionId": "session-<uuid>" }
 *
 * The route really removes a session from disk. DSH 0.2 has no session-delete
 * API (`ctx.sessionPersistence` exposes create/open/flush/stat/list only), so
 * removal is the ordered file operation below:
 *
 *   1. refuse a session whose Agent is currently running (and refuse one whose
 *      other families — jobs, subagents, reminders — still report activity);
 *   2. archive the session through ctx.workspaceRegistry so every surface hides
 *      the row immediately (this must happen while the session still exists,
 *      because archiving validates the session's existence);
 *   3. drop the session from its Workspace accounting entry;
 *   4. delete the session's artifact directory and its projection-cache record.
 *
 * Everything the plugin needs is read through public services, so an upgrade
 * that renames a private field cannot corrupt a delete: each step either
 * reports a failure or is a no-op.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'session-delete'

/**
 * Host services required before the routes can register. The Workspace registry
 * is deliberately *not* a hard dependency: when it is absent, or failed to
 * activate, the route still deletes artifacts and only the row-hiding step is
 * skipped — better a working delete with a stale row than a plugin that never
 * activates. It is read through `ctx.get('workspaceRegistry')` at call time.
 */
export const inject = ['webServer', 'sessionPersistence']

const ROUTE_PATH = '/dsh-session-delete/delete'
const STATUS_PATH = '/dsh-session-delete/status'
/** Installed package version, read once so /status names the running code. */
const PLUGIN_VERSION = readPluginVersion()

/** Read this package's version without depending on any service. */
function readPluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
const MAX_BODY_BYTES = 8 * 1024
/**
 * Official session ids come in three shapes: `session-<uuid>` (the Web UI),
 * `session-<n>` (store-minted) and a bare `<uuid>` (subagent children). The
 * charset stays tight because the id is joined into the artifact path.
 */
const SESSION_ID_RE = /^(?:session-)?[0-9a-fA-F][0-9a-fA-F-]{7,80}$/

/**
 * Register the plugin's routes for the plugin's lifetime: the delete route the
 * Client calls, plus a read-only status route so a user can check from a shell
 * or the browser which code generation is loaded.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createHandler(ctx) }),
    'dsh-session-delete: delete route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (_request, response) => {
        respond(response, 200, {
          ok: true,
          plugin: 'dsh-session-delete',
          version: PLUGIN_VERSION,
          workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
        })
      },
    }),
    'dsh-session-delete: status route',
  )
  ctx.logger?.info?.(`[dsh-session-delete] ${PLUGIN_VERSION} ready: ${ROUTE_PATH}`)
}

/**
 * Build the HTTP handler bound to one context.
 * @param ctx - Host plugin context.
 * @returns the exact-route handler.
 */
function createHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch {
      respond(response, 400, { ok: false, error: 'bad-request' })
      return
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!SESSION_ID_RE.test(sessionId)) {
      respond(response, 400, { ok: false, error: 'invalid-session-id' })
      return
    }
    try {
      const outcome = await deleteSession(ctx, sessionId)
      respond(response, outcome.ok ? 200 : outcome.status ?? 500, outcome)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-delete] deleting ${sessionId} failed: ${String(error)}`)
      respond(response, 500, {
        ok: false,
        error: 'delete-failed',
        message: errorMessage(error),
      })
    }
  }
}

/**
 * Remove one session from disk.
 * @param ctx - Host plugin context.
 * @param sessionId - Validated session id.
 * @returns an outcome whose `ok` decides the HTTP status.
 */
async function deleteSession(ctx, sessionId) {
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (agent?.status === 'running') {
    return { ok: false, status: 409, error: 'session-running' }
  }

  const persistence = ctx.sessionPersistence
  let header
  try {
    header = (await persistence.stat(sessionId))?.header
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] stat ${sessionId} failed: ${errorMessage(error)}`)
  }

  const home = dshHome(ctx)
  let directory = locateArtifactDirectory(ctx, header)
  if (directory === undefined) directory = await scanArtifactDirectory(home, sessionId)

  if (header === undefined && directory === undefined) {
    // Nothing stored and nothing on disk: forget whatever accounting remains.
    await detachEverywhere(ctx, sessionId)
    return { ok: true, removed: [], note: 'no-artifact' }
  }

  // 1. Hide the session everywhere first, while it still exists.
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    ctx.logger?.warn?.('[dsh-session-delete] no workspace registry: the deleted row stays visible until the next listing')
  } else {
    try {
      await registry.archiveSession(sessionId)
    } catch (error) {
      if (isActiveSessionError(error)) {
        return {
          ok: false,
          status: 409,
          error: 'session-active',
          message: 'the session still has running work; stop it first',
        }
      }
      // Already archived, or unknown to the registry: hiding is best-effort.
      ctx.logger?.debug?.(`[dsh-session-delete] archive ${sessionId}: ${errorMessage(error)}`)
    }
  }

  // 2. Drop the workspace accounting entry while the header still resolves.
  await detachEverywhere(ctx, sessionId)

  // 3. Remove the artifacts.
  const removed = []
  if (directory !== undefined && basename(directory) === sessionId && existsSync(directory)) {
    await rm(directory, { recursive: true, force: true })
    removed.push(directory)
  }
  const cacheRecord = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (existsSync(cacheRecord)) {
    await rm(cacheRecord, { force: true })
    removed.push(cacheRecord)
  }
  return removed.length === 0 ? { ok: true, removed, note: 'no-artifact' } : { ok: true, removed }
}

/**
 * Resolve the session's artifact directory from its stored header.
 * @param ctx - Host plugin context.
 * @param header - Stored session header, when the session is still known.
 * @returns the directory holding the session log, or undefined.
 */
function locateArtifactDirectory(ctx, header) {
  if (header === undefined) return undefined
  const persistence = ctx.sessionPersistence
  if (typeof persistence?.locate !== 'function') return undefined
  try {
    const location = persistence.locate(header)
    if (typeof location?.path !== 'string' || location.path === '') return undefined
    const directory = dirname(location.path)
    return basename(directory) === header.id ? directory : undefined
  } catch {
    return undefined
  }
}

/**
 * Find `<DSH home>/sessions/<workspace dir>/<session id>` by name.
 * @param home - Resolved DSH home directory.
 * @param sessionId - Validated session id.
 * @returns the session's directory, or undefined when it is not on disk.
 */
async function scanArtifactDirectory(home, sessionId) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Remove the session from every Workspace's ordered ownership account.
 * @param ctx - Host plugin context.
 * @param sessionId - Validated session id.
 */
async function detachEverywhere(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  let workspaces
  try {
    workspaces = registry.list()
  } catch {
    return
  }
  const owners = workspaces.filter((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
  // Detaching is idempotent, so an ownership account the registry cannot
  // validate this instant still gets one attempt rather than leaking the id.
  for (const workspace of owners.length > 0 ? owners : workspaces) {
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      ctx.logger?.debug?.(`[dsh-session-delete] detach ${sessionId} failed: ${errorMessage(error)}`)
    }
  }
}

/**
 * Resolve the DSH home directory through the boot-provided helper when present.
 * @param ctx - Host plugin context.
 * @returns the absolute DSH home path.
 */
function dshHome(ctx) {
  const provided = ctx.get?.('dshHomePath')
  if (typeof provided === 'function') {
    try {
      const home = provided()
      if (typeof home === 'string' && home !== '') return home
    } catch {
      // Fall through to the environment-derived home.
    }
  }
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Whether a registry rejection means the session still runs work.
 * @param error - Rejection from archiveSession.
 * @returns true for the registry's active-session refusal.
 */
function isActiveSessionError(error) {
  const name = error?.name
  return name === 'WorkspaceActiveSessionError'
    || error?.code === 'workspace/session-active'
    || Array.isArray(error?.activity)
}

/**
 * Read one bounded JSON request body.
 * @param request - incoming request.
 * @returns the parsed body, or an empty object for an empty body.
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        request.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
  })
}

/**
 * Write one JSON response.
 * @param response - outgoing response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function respond(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Normalize an unknown rejection into a message.
 * @param error - unknown rejection.
 * @returns the message text.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
