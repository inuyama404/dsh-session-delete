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
 *   4. delete the session's artifact directory and its projection-cache record,
 *      verifying the directory is really gone (a still-open write handle can
 *      re-create the log right after the unlink);
 *   5. drop the id from the archive set. The client's session list carries
 *      archived Sessions, so a surviving mark keeps the deleted id listed and,
 *      with its workspace slot already detached, renders it as a loose
 *      "Ungrouped" row. Clearing the mark lets the client's list refresh drop
 *      the id, which is what the client half triggers after every delete.
 *
 * A session with no log directory is archived and reported as `not-materialized`:
 * a blank session the store created but never wrote has nothing to unlink, so
 * hiding it is all a delete can mean. `GET /dsh-session-delete/diagnose?sessionId=…`
 * reports where a session lives, and `GET /dsh-session-delete/last` keeps the
 * recent delete outcomes so a failure is readable from a shell.
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
const PLAN_PATH = '/dsh-session-delete/plan'
const BULK_PATH = '/dsh-session-delete/bulk-delete'
const DIAGNOSE_PATH = '/dsh-session-delete/diagnose'
const LAST_PATH = '/dsh-session-delete/last'
const REPORT_PATH = '/dsh-session-delete/report'
/** Installed package version, read once so /status names the running code. */
const PLUGIN_VERSION = readPluginVersion()

/**
 * Upper bound on one bulk request. Deletion is serial on the filesystem, so this
 * also bounds how long a single response can be in flight; the client reports the
 * remainder rather than issuing an unbounded request.
 */
const BULK_MAX = 200
/**
 * Budget for the persistence `list()` call behind the plan route. It is documented
 * as unpaginated, so a large store must not be able to stall the route.
 */
const LIST_TIMEOUT_MS = 5000
/**
 * Removal is retried because a session that is still open in another view can
 * re-materialize its log from an in-memory write handle immediately after the
 * directory is unlinked. The retry makes "deleted" stick instead of leaving a row
 * that reports the session back as archived.
 */
const REMOVE_ATTEMPTS = 4
const REMOVE_RETRY_MS = 120
/** How many delete attempts the read-only `/last` route keeps. */
const RECENT_ATTEMPT_LIMIT = 20

/**
 * Recent delete outcomes, newest last. A failed delete only shows its reason in
 * the row that failed, which is easy to lose; this keeps the same facts readable
 * from a shell so a report does not depend on transcribing a tooltip.
 */
const recentAttempts = []

/** Most recent client-state report, kept in memory for the report route. */
let lastClientReport = null

/**
 * Append one attempt record for the `/last` route.
 * @param entry - attempt facts.
 */
function recordAttempt(entry) {
  recentAttempts.push({ at: new Date().toISOString(), ...entry })
  while (recentAttempts.length > RECENT_ATTEMPT_LIMIT) recentAttempts.shift()
}
/** How many directory levels below `sessions/` the artifact scan may search. */
const SCAN_MAX_DEPTH = 4

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
/** A client-state report carries one row per listed session, so it gets more room. */
const MAX_REPORT_BYTES = 64 * 1024
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
    () => ctx.webServer.register({ kind: 'exact', path: PLAN_PATH, handler: createPlanHandler(ctx) }),
    'dsh-session-delete: plan route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: BULK_PATH, handler: createBulkHandler(ctx) }),
    'dsh-session-delete: bulk delete route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: DIAGNOSE_PATH, handler: createDiagnoseHandler(ctx) }),
    'dsh-session-delete: diagnose route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: LAST_PATH, handler: createLastHandler() }),
    'dsh-session-delete: attempt log route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: REPORT_PATH, handler: createReportHandler() }),
    'dsh-session-delete: client state report route',
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
          bulk: { plan: PLAN_PATH, delete: BULK_PATH, maxPerRequest: BULK_MAX },
          diagnose: DIAGNOSE_PATH,
          last: LAST_PATH,
          report: REPORT_PATH,
        })
      },
    }),
    'dsh-session-delete: status route',
  )
  ctx.logger?.info?.(`[dsh-session-delete] ${PLUGIN_VERSION} ready: ${ROUTE_PATH} (+ plan, bulk, diagnose)`)
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
      recordAttempt({ route: 'delete', sessionId: sessionId.slice(0, 96), status: 400, ok: false, error: 'invalid-session-id' })
      respond(response, 400, { ok: false, error: 'invalid-session-id' })
      return
    }
    try {
      const outcome = await deleteSession(ctx, sessionId)
      recordAttempt({
        route: 'delete',
        sessionId,
        status: outcome.ok ? 200 : outcome.status ?? 500,
        ok: outcome.ok === true,
        error: outcome.error,
        note: outcome.note,
        message: outcome.message,
        removed: Array.isArray(outcome.removed) ? outcome.removed.length : 0,
      })
      respond(response, outcome.ok ? 200 : outcome.status ?? 500, outcome)
    } catch (error) {
      const message = errorMessage(error)
      recordAttempt({ route: 'delete', sessionId, status: 500, ok: false, error: 'delete-failed', message })
      ctx.logger?.warn?.(`[dsh-session-delete] deleting ${sessionId} failed: ${String(error)}`)
      respond(response, 500, {
        ok: false,
        error: 'delete-failed',
        message,
      })
    }
  }
}

/**
 * Build the HTTP handler for the bulk candidate list.
 *
 * The client cannot enumerate sessions (it only receives row identities), so the
 * "select all" affordance needs this. Discovery prefers `list()` and falls back to
 * scanning the artifact directories, so a build whose `list()` is missing or slow
 * still yields candidates.
 * @param ctx - Host plugin context.
 * @returns the exact-route handler.
 */
function createPlanHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'POST' && request.method !== 'GET') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    try {
      const sessions = await listCandidates(ctx)
      respond(response, 200, {
        ok: true,
        maxPerRequest: BULK_MAX,
        count: sessions.length,
        sessions,
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-delete] plan failed: ${errorMessage(error)}`)
      respond(response, 500, { ok: false, error: 'plan-failed', message: errorMessage(error) })
    }
  }
}

/**
 * Build the HTTP handler for the read-only diagnosis route.
 *
 * A delete that reports success while the row survives is indistinguishable from
 * a delete that never ran, so this route answers the only question that matters:
 * where does this session live on this host, right now? It reports what the store
 * says, what `locate()` resolves, whether the on-disk scan found a directory, and
 * how the Workspace registry accounts the id — without touching anything.
 * @param ctx - Host plugin context.
 * @returns the exact-route handler.
 */
function createDiagnoseHandler(ctx) {
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const raw = readSessionId(request)
    if (raw === null) {
      respond(response, 400, {
        ok: false,
        error: 'invalid-session-id',
        message: `pass a session id as ?sessionId=, e.g. ${DIAGNOSE_PATH}?sessionId=session-<uuid>`,
      })
      return
    }
    try {
      respond(response, 200, await diagnoseSession(ctx, raw))
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-delete] diagnose failed: ${errorMessage(error)}`)
      respond(response, 500, { ok: false, error: 'diagnose-failed', message: errorMessage(error) })
    }
  }
}

/**
 * Build the HTTP handler for a batch delete.
 *
 * Deletion is deliberately sequential: it touches the workspace registry and the
 * filesystem per session, and a burst of parallel unlinks gives no benefit while
 * making a partial failure harder to attribute. One session's failure never
 * abandons the rest, and beyond {@link BULK_MAX} the remainder is reported back
 * (`requested`/`deleted`/`results`) so the client can show it and ask again.
 * @param ctx - Host plugin context.
 * @returns the exact-route handler.
 */
function createBulkHandler(ctx) {
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
    if (!Array.isArray(body?.sessionIds)) {
      respond(response, 400, { ok: false, error: 'bad-request', message: 'sessionIds must be an array' })
      return
    }

    // Reject the whole request on a malformed id rather than silently dropping it:
    // a partial delete would be worse than asking the client to resend valid ids.
    const requested = []
    const seen = new Set()
    for (const raw of body.sessionIds) {
      const id = typeof raw === 'string' ? raw.trim() : ''
      if (!SESSION_ID_RE.test(id)) {
        respond(response, 400, { ok: false, error: 'invalid-session-id', sessionId: typeof raw === 'string' ? raw.slice(0, 96) : null })
        return
      }
      if (seen.has(id)) continue
      seen.add(id)
      requested.push(id)
    }

    const batch = requested.slice(0, BULK_MAX)
    const results = []
    let deleted = 0
    for (const sessionId of batch) {
      try {
        const outcome = await deleteSession(ctx, sessionId)
        if (outcome.ok) deleted += 1
        results.push({
          sessionId,
          ok: outcome.ok === true,
          status: outcome.status ?? (outcome.ok ? 200 : 500),
          error: outcome.error,
          removed: outcome.removed,
          note: outcome.note,
        })
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-session-delete] bulk delete ${sessionId} failed: ${errorMessage(error)}`)
        results.push({ sessionId, ok: false, status: 500, error: 'delete-failed', message: errorMessage(error) })
      }
    }

    // A durable, greppable record of an irreversible operation.
    ctx.logger?.info?.(
      `[dsh-session-delete] bulk delete: ${deleted}/${batch.length} removed`
      + ` (${results.filter((r) => !r.ok).map((r) => `${r.sessionId}:${r.error ?? 'error'}`).join(', ') || 'no failures'})`,
    )
    for (const row of results) {
      if (row.ok) continue
      recordAttempt({ route: 'bulk-delete', sessionId: row.sessionId, status: row.status, ok: false, error: row.error, message: row.message })
    }

    respond(response, 200, {
      ok: deleted === batch.length,
      requested: requested.length,
      deleted,
      failed: results.filter((r) => !r.ok).length,
      remaining: Math.max(0, requested.length - batch.length),
      maxPerRequest: BULK_MAX,
      results,
    })
  }
}

/**
 * List sessions that can be offered for bulk deletion.
 * @param ctx - Host plugin context.
 * @returns candidate rows in a stable order.
 */
async function listCandidates(ctx) {
  const fromStore = await listFromStore(ctx)
  if (fromStore.length > 0 || fromStore.available) return fromStore.rows
  return listFromArtifacts(ctx)
}

/**
 * Read candidates from the persistence service.
 * @param ctx - Host plugin context.
 * @returns `{ available, rows }`; `available` is false when `list()` could not run.
 */
async function listFromStore(ctx) {
  const persistence = ctx.sessionPersistence
  if (typeof persistence?.list !== 'function') return { available: false, rows: [] }
  let snapshots
  try {
    snapshots = await withTimeout(Promise.resolve(persistence.list()), LIST_TIMEOUT_MS)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] session list unavailable: ${errorMessage(error)}`)
    return { available: false, rows: [] }
  }
  if (!Array.isArray(snapshots)) return { available: false, rows: [] }

  const owners = ownershipIndex(ctx)
  const rows = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header ?? snapshot
    const id = typeof header?.id === 'string' ? header.id : ''
    if (!SESSION_ID_RE.test(id)) continue
    rows.push(candidateView(id, header, owners))
  }
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.sessionId.localeCompare(b.sessionId))
  return { available: true, rows }
}

/**
 * Fall back to the artifact directories when the store cannot enumerate.
 * @param ctx - Host plugin context.
 * @returns candidate rows in a stable order.
 */
async function listFromArtifacts(ctx) {
  const home = dshHome(ctx)
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const owners = ownershipIndex(ctx)
  const rows = []
  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(root, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_RE.test(entry.name)) continue
      rows.push(candidateView(entry.name, undefined, owners))
    }
  }
  rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  return rows
}

/**
 * Project one candidate row for the client.
 * @param id - Session id.
 * @param header - Stored header, when the store supplied one.
 * @param owners - Workspace ownership index.
 * @returns the wire representation.
 */
function candidateView(id, header, owners) {
  const owner = owners.get(id)
  return {
    sessionId: id,
    title: typeof header?.title === 'string' ? header.title : undefined,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
    archived: owner?.archived === true,
    // Presence only: the client cannot ask the agent registry itself.
    active: owner?.active === true || (header?.archived === true),
  }
}

/**
 * Map session id to its workspace entry, to surface archived state.
 * @param ctx - Host plugin context.
 * @returns id → `{ archived, active }`.
 */
function ownershipIndex(ctx) {
  const index = new Map()
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return index
  let workspaces
  try {
    workspaces = registry.list()
  } catch {
    return index
  }
  if (!Array.isArray(workspaces)) return index
  for (const workspace of workspaces) {
    const archivedIds = Array.isArray(workspace.archivedSessionIds) ? workspace.archivedSessionIds : []
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    for (const id of sessionIds) index.set(id, { archived: archivedIds.includes(id), active: false })
    for (const id of archivedIds) index.set(id, { archived: true, active: false })
  }
  return index
}

/**
 * Reject after `ms` when `promise` has not settled, so a slow `list()` cannot make
 * the plan route hang.
 * @param promise - Work to bound.
 * @param ms - Budget in milliseconds.
 * @returns the promise's value.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      // Do not keep the process alive just for this timer.
      timer.unref?.()
    }),
  ])
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

  // 1. Hide the session everywhere first, while it still exists.
  //
  // Archiving is how every DSH surface stops offering a row, and it is the reason
  // a delete looks like a delete: an id left unarchived becomes a "loose" session
  // and reappears in the sidebar's Ungrouped bucket. The archive mark therefore
  // stays after the files are gone; it is invisible because nothing lists a
  // session without a log, and the client half hides the row it just deleted.
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

  // 3. Nothing on disk: a blank session the store created but never materialized.
  //    Hiding it is all a delete can mean, and the archive step above already did
  //    that, so report the truth instead of claiming artifacts were removed.
  if (directory === undefined) {
    await clearArchiveMark(ctx, sessionId)
    return { ok: true, removed: [], note: header === undefined ? 'no-artifact' : 'not-materialized' }
  }

  // 4. Remove the artifacts.
  const removed = []
  if (basename(directory) === sessionId) {
    const existed = existsSync(directory)
    const gone = await removeArtifactDirectory(directory)
    if (!gone) {
      return {
        ok: false,
        status: 500,
        error: 'artifact-not-removed',
        message: `the session log directory survived deletion: ${directory}`,
        directory,
        hint: `GET ${DIAGNOSE_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
      }
    }
    if (existed) removed.push(directory)
  }
  const cacheRecord = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (existsSync(cacheRecord)) {
    await rm(cacheRecord, { force: true })
    removed.push(cacheRecord)
  }

  // 5. Drop the archive mark. The archived id stays in the client's session list
  //    (that list carries archived Sessions so the "Archived" filter can show
  //    them), and our detach removed its workspace slot, so a surviving mark
  //    renders the deleted row as a loose "Ungrouped" session — or, with the row
  //    hidden, as an empty "Ungrouped" group. Clearing it lets the client's list
  //    refresh drop the id entirely now that no log backs it.
  await clearArchiveMark(ctx, sessionId)

  return removed.length === 0 ? { ok: true, removed, note: 'no-artifact' } : { ok: true, removed }
}

/**
 * Drop a deleted session's id from the Workspace archive set.
 *
 * Only called once the log is gone: the archive mark is how the row hides while
 * the files go away, and leaving it behind would keep a session with no artifacts
 * listed under "Archived". A failure is a warning — the artifacts are already
 * deleted, so the worst case is that stale archived referent.
 * @param ctx - Host plugin context.
 * @param sessionId - Session id whose artifacts were just removed.
 */
async function clearArchiveMark(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  let archived
  try {
    archived = registry.archivedSessionIds
  } catch {
    return
  }
  const ids = Array.isArray(archived) ? archived : archived instanceof Set ? [...archived] : []
  if (!ids.includes(sessionId)) return
  if (typeof registry.unarchiveSession !== 'function') return
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-delete] could not clear the archive mark for ${sessionId}: ${errorMessage(error)}`)
  }
}

/**
 * Delete one artifact directory, retrying while it stays on disk.
 *
 * A session that is still attached to a live write handle can re-create its log
 * right after the unlink, so one `rm` is not proof of deletion. This returns true
 * only once the path is verifiably absent.
 * @param directory - absolute artifact directory.
 * @returns whether the directory is gone.
 */
async function removeArtifactDirectory(directory) {
  let lastError
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      lastError = error
    }
    if (!existsSync(directory)) return true
    await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS))
  }
  if (lastError !== undefined) return false
  return !existsSync(directory)
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
 * Find a directory named exactly after the session id under `<DSH home>/sessions`.
 *
 * The documented layout is `<sessions>/<workspace dir>/<session id>`, checked
 * first because it is one `readdir` and one `exists`. A host upgrade may nest or
 * rename the levels around the session directory, which used to turn a delete into
 * "archived but still on disk"; the bounded walk below finds the directory by name
 * instead of assuming its depth. The name must equal the session id, so a match is
 * still proof that this is that session's own directory.
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
  return findDirectoryNamed(root, sessionId)
}

/**
 * Walk `directory` breadth-first looking for a child directory named `name`.
 * @param directory - absolute directory to walk.
 * @param name - exact directory basename to match.
 * @returns the matching directory, or undefined.
 */
async function findDirectoryNamed(directory, name) {
  const queue = [{ directory, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current.directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(current.directory, entry.name)
      if (entry.name === name) return full
      if (current.depth + 1 < SCAN_MAX_DEPTH) queue.push({ directory: full, depth: current.depth + 1 })
    }
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
 * Build the handler for the read-only attempt log.
 *
 * Only facts the plugin observed are reported: the id, the HTTP status the client
 * received, the outcome code and the number of artifacts removed. That is enough
 * to tell a refusal from a crash without the client-side label.
 * @returns the exact-route handler.
 */
function createLastHandler() {
  return (request, response) => {
    if (request.method !== 'GET') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    respond(response, 200, {
      ok: true,
      plugin: 'dsh-session-delete',
      version: PLUGIN_VERSION,
      count: recentAttempts.length,
      attempts: [...recentAttempts].reverse(),
    })
  }
}

/**
 * Build the handler for the client-state report.
 *
 * The sidebar's rows are derived in the renderer from a session list the Host
 * cannot read back, so a row that survives a delete is invisible to every other
 * diagnostic here. The client half posts what it actually holds and this route
 * keeps it, which is what turns "there is an empty Ungrouped group" into a named
 * session id. Nothing is written to disk.
 * @returns the exact-route handler.
 */
function createReportHandler() {
  return async (request, response) => {
    if (request.method === 'GET') {
      respond(response, 200, {
        ok: true,
        plugin: 'dsh-session-delete',
        version: PLUGIN_VERSION,
        report: lastClientReport,
      })
      return
    }
    if (request.method !== 'POST') {
      respond(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    let body
    try {
      body = await readJsonBody(request, MAX_REPORT_BYTES)
    } catch {
      respond(response, 400, { ok: false, error: 'bad-request' })
      return
    }
    lastClientReport = { at: new Date().toISOString(), ...body }
    respond(response, 200, { ok: true, stored: true })
  }
}

/**
 * Read a session id from the request's `?sessionId=` query.
 * @param request - incoming request.
 * @returns the validated id, or null when absent or malformed.
 */
function readSessionId(request) {
  const raw = typeof request?.url === 'string' ? request.url : '/'
  let url
  try {
    url = new URL(raw, 'http://dsh.invalid')
  } catch {
    return null
  }
  const value = (url.searchParams.get('sessionId') ?? '').trim()
  return SESSION_ID_RE.test(value) ? value : null
}

/**
 * Describe where one session lives on this host, without changing anything.
 * @param ctx - Host plugin context.
 * @param sessionId - Validated session id.
 * @returns the diagnosis report served by the diagnose route.
 */
async function diagnoseSession(ctx, sessionId) {
  const home = dshHome(ctx)
  const persistence = ctx.sessionPersistence
  const report = {
    ok: true,
    plugin: 'dsh-session-delete',
    version: PLUGIN_VERSION,
    sessionId,
    home,
    sessionsRoot: join(home, 'sessions'),
    store: { stat: 'unavailable' },
    locate: { path: null, directory: null, namedAfterSession: false },
    scan: { directory: null },
    account: { workspaces: 0, accountedIn: [], archived: false, active: false },
    artifacts: { directory: null, directoryExists: false, logFiles: [], cache: null, cacheExists: false },
  }

  let header
  if (typeof persistence?.stat === 'function') {
    try {
      const snapshot = await persistence.stat(sessionId)
      header = snapshot?.header
      report.store = header === undefined
        ? { stat: 'unknown-session' }
        : {
            stat: 'ok',
            id: typeof header.id === 'string' ? header.id : null,
            cwd: typeof header.cwd === 'string' ? header.cwd : null,
            createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
          }
    } catch (error) {
      report.store = { stat: 'error', message: errorMessage(error) }
    }
  }

  if (header !== undefined && typeof persistence?.locate === 'function') {
    try {
      const location = persistence.locate(header)
      const path = typeof location?.path === 'string' ? location.path : null
      const directory = path === null ? null : dirname(path)
      report.locate = {
        path,
        directory,
        namedAfterSession: directory !== null && basename(directory) === header.id,
      }
    } catch (error) {
      report.locate = { path: null, directory: null, namedAfterSession: false, message: errorMessage(error) }
    }
  }

  const scanned = await scanArtifactDirectory(home, sessionId)
  report.scan.directory = scanned ?? null
  const directory = report.locate.namedAfterSession ? report.locate.directory : report.scan.directory
  report.artifacts.directory = directory
  report.artifacts.directoryExists = directory !== null && existsSync(directory)
  if (report.artifacts.directoryExists) {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      report.artifacts.logFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    } catch {
      // A directory we cannot list still exists; the verdict does not depend on it.
    }
  }
  const cache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  report.artifacts.cache = cache
  report.artifacts.cacheExists = existsSync(cache)

  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    let workspaces
    try {
      workspaces = registry.list()
    } catch {
      workspaces = undefined
    }
    const list = Array.isArray(workspaces) ? workspaces : []
    report.account.workspaces = list.length
    for (const workspace of list) {
      if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        report.account.accountedIn.push(workspace?.path ?? workspace?.id ?? 'unknown')
      }
    }
    try {
      const archived = registry.archivedSessionIds
      const ids = Array.isArray(archived) ? archived : archived instanceof Set ? [...archived] : []
      report.account.archived = ids.includes(sessionId)
    } catch {
      // An unreadable archive set is reported as "not archived"; the delete path
      // re-reads it on its own.
    }
  }

  report.verdict = diagnoseVerdict(report)
  return report
}

/**
 * Say what a delete would do with the state a diagnosis observed.
 * @param report - the report built by {@link diagnoseSession}.
 * @returns one of `deletable`, `store-without-artifact`, `accounted-without-artifact`, `already-gone`.
 */
function diagnoseVerdict(report) {
  if (report.artifacts.directoryExists) return 'deletable'
  if (report.store.stat === 'ok') return 'store-without-artifact'
  if (report.account.accountedIn.length > 0 || report.account.archived) return 'accounted-without-artifact'
  return 'already-gone'
}

/**
 * Read one bounded JSON request body.
 * @param request - incoming request.
 * @param limit - maximum accepted body size in bytes.
 * @returns the parsed body, or an empty object for an empty body.
 */
function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
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
