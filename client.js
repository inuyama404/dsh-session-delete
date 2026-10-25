/**
 * dsh-session-delete — Client half.
 *
 * Registers one entry into the Session row's "..." menu
 * (`sidebar.workspaces.session.menu.item`, declared by
 * @deepseek-ai/dsh-client-ui-workspace) that deletes the session from disk.
 *
 * The entry receives only the row identity (sessionId, displayTitle) plus the
 * slot's menu-state hook. It renders one destructive menu row through
 * @deepseek-ai/dsh-client-ui-primitives (a baseline external of this module
 * lane) and falls back to a self-rendered `role="menuitem"` button that uses
 * only `--dsw-alias-*` theme tokens when that module is unavailable.
 *
 * Clicking once arms the row ("确认删除"), clicking again calls the Host route
 * and the menu closes. The armed step replaces a confirmation dialog so the
 * plugin needs no `shell.overlay` entry.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? null
    } catch {
      primitives = null
    }

    const PLUGIN_ID = 'dsh-session-delete'
    const SLOT = 'sidebar.workspaces.session.menu.item'
    const LEADING_SLOT = 'sidebar.session.row.leading'
    const OVERLAY_SLOT = 'shell.overlay'
    const ROUTE = '/dsh-session-delete/delete'
    const BULK_ROUTE = '/dsh-session-delete/bulk-delete'
    const PLAN_ROUTE = '/dsh-session-delete/plan'
    const REPORT_ROUTE = '/dsh-session-delete/report'
    const NS = 'dsh-session-delete'
    const MAX_TITLE = 22
    /** Delay before the second list pull, long enough for a stale pull to settle. */
    const LIST_SETTLE_MS = 800

    const DICTIONARIES = {
      zh: {
        'menu.delete': '删除会话',
        'menu.confirm': '确认删除「{title}」',
        'menu.busy': '正在删除…',
        'menu.done': '已删除',
        'menu.failed': '删除失败：{reason}',
        'reason.running': '会话正在运行',
        'reason.active': '会话仍有进行中的工作',
        'reason.missing': '会话不存在',
        'reason.network': '无法连接宿主',
        'bulk.enter': '批量删除会话…',
        'bulk.selected': '已选 {count} 个会话',
        'bulk.selectAll': '全选',
        'bulk.clear': '清空',
        'bulk.cancel': '取消',
        'bulk.delete': '删除 {count} 个会话',
        'bulk.confirm': '确认删除 {count} 个？',
        'bulk.deleting': '正在删除 {done}/{total}…',
        'bulk.done': '已删除 {deleted} 个',
        'bulk.someFailed': '已删除 {deleted} 个，{failed} 个失败',
        'bulk.none': '未选中任何会话',
        'bulk.empty': '没有可删除的会话',
        'bulk.loading': '正在读取会话列表…',
        'bulk.remain': '还有 {left} 个未处理，可再点一次',
        'bulk.reload': '刷新页面以更新列表',
        'bulk.select': '选择「{title}」',
        'bulk.selectN': '选择会话 {id}',
        'row.select': '加入待删列表',
        'row.unselect': '移出待删列表',
        'row.current': '当前会话不能删除',
        'row.currentShort': '当前会话',
        'bar.delete': '删除选中的 {count} 个会话',
        'bar.done': '已删除 {deleted} 个',
        'bar.partial': '已删除 {deleted} 个，{failed} 个失败',
        'confirm.title': '确认删除 {count} 个会话？',
        'confirm.body': '会话记录会从磁盘上永久删除，无法恢复。',
        'confirm.cancel': '取消',
        'confirm.ok': '确认删除',
      },
      en: {
        'menu.delete': 'Delete session',
        'menu.confirm': 'Confirm delete "{title}"',
        'menu.busy': 'Deleting…',
        'menu.done': 'Deleted',
        'menu.failed': 'Delete failed: {reason}',
        'reason.running': 'the session is running',
        'reason.active': 'the session still has running work',
        'reason.missing': 'no such session',
        'reason.network': 'cannot reach the host',
        'bulk.enter': 'Delete multiple sessions…',
        'bulk.selected': '{count} selected',
        'bulk.selectAll': 'Select all',
        'bulk.clear': 'Clear',
        'bulk.cancel': 'Cancel',
        'bulk.delete': 'Delete {count} sessions',
        'bulk.confirm': 'Really delete {count}?',
        'bulk.deleting': 'Deleting {done}/{total}…',
        'bulk.done': 'Deleted {deleted}',
        'bulk.someFailed': 'Deleted {deleted}, {failed} failed',
        'bulk.none': 'No session selected',
        'bulk.empty': 'Nothing to delete',
        'bulk.loading': 'Reading sessions…',
        'bulk.remain': '{left} left; run it again',
        'bulk.reload': 'Reload the page to refresh the list',
        'bulk.select': 'Select "{title}"',
        'bulk.selectN': 'Select session {id}',
        'row.select': 'Add to delete list',
        'row.unselect': 'Remove from delete list',
        'row.current': "The open session can't be deleted",
        'row.currentShort': 'open session',
        'bar.delete': 'Delete {count} selected sessions',
        'bar.done': 'Deleted {deleted}',
        'bar.partial': 'Deleted {deleted}, {failed} failed',
        'confirm.title': 'Delete {count} sessions?',
        'confirm.body': 'The session logs are removed from disk permanently. This cannot be undone.',
        'confirm.cancel': 'Cancel',
        'confirm.ok': 'Delete',
      },
    }

    const FALLBACK_TEXT = DICTIONARIES.en
    const FALLBACK_ERRORS = {
      'session-running': FALLBACK_TEXT['reason.running'],
      'session-active': FALLBACK_TEXT['reason.active'],
      'session-not-found': FALLBACK_TEXT['reason.missing'],
    }

    /** Interpolate `{name}` placeholders the way the Host locale service does. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.hasOwn(values ?? {}, key) ? String(values[key]) : whole
      ))
    }

    /** Host error code → readable reason. */
    function reasonText(payload, status) {
      const code = typeof payload?.error === 'string' ? payload.error : ''
      if (code === 'session-running') return FALLBACK_ERRORS['session-running']
      if (code === 'session-active') return FALLBACK_ERRORS['session-active']
      if (code === 'session-not-found') return FALLBACK_ERRORS['session-not-found']
      if (typeof payload?.message === 'string' && payload.message !== '') return payload.message
      if (code !== '') return code
      return `HTTP ${String(status)}`
    }

    /**
     * Post the session list this page actually holds to the Host's diagnostic route.
     *
     * The sidebar derives its rows from a list only the renderer has, so a row that
     * outlives a delete is invisible to every Host-side check. This report names the
     * ids, their blank/origin flags, the workspace accounting and the archive set,
     * which is enough to point at the exact session behind a stray row or an empty
     * "Ungrouped" group.
     * @param ctx - client plugin context.
     * @param reason - what triggered the report (mount, delete, refresh).
     */
    function reportClientState(ctx, reason) {
      if (typeof fetch !== 'function') return
      try {
        const list = ctx.get?.('sessions')?.list?.getSnapshot?.() ?? {}
        const model = ctx.get?.('workspaces')?.list?.getSnapshot?.() ?? {}
        const ids = Array.isArray(list.ids) ? list.ids : []
        const byId = list.byId ?? {}
        const body = {
          reason,
          ids,
          rows: ids.slice(0, 200).map((id) => {
            const row = byId[id] ?? {}
            return {
              id,
              title: typeof row.title === 'string' ? row.title : null,
              blank: row.blank === true,
              origin: typeof row.origin === 'string' ? row.origin : null,
            }
          }),
          workspaces: (Array.isArray(model.items) ? model.items : []).map((workspace) => ({
            id: workspace?.workspaceId ?? workspace?.id ?? null,
            title: workspace?.title ?? null,
            sessionIds: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [],
          })),
          archivedSessionIds: Array.isArray(model.archivedSessionIds) ? model.archivedSessionIds : [],
          pinnedSessionIds: Array.isArray(model.pinnedSessionIds) ? model.pinnedSessionIds : [],
        }
        void fetch(REPORT_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => {})
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] client state report failed:`, error)
      }
    }

    /**
     * Re-pull the Host's session list after a delete.
     *
     * The sidebar groups rows from the client's session list, and that list only
     * changes when the Host says so — a deleted session emits no removal, so the
     * stale row survives in place: it loses its workspace slot and reappears under
     * "Ungrouped", or leaves an empty group behind. `refresh()` re-pulls the real
     * baseline, which is what actually removes it.
     */
    let requestListRefresh = () => {}

    /** Ask the Host to delete the session and surface its refusal verbatim. */
    async function deleteSession(sessionId) {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } catch {
        throw new Error(FALLBACK_TEXT['reason.network'])
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload?.ok !== true) throw new Error(reasonText(payload, response.status))
      hideSessionRow(sessionId)
      requestListRefresh('delete')
      // `refresh()` joins a pull that is already in flight, and one started before
      // this delete resolves to the pre-delete list — the deleted id then comes
      // straight back. A second pull after that one settles drops it for good.
      scheduleListRefresh('delete-settled')
      return payload
    }

    /** Refresh again once a stale in-flight pull has had time to settle. */
    function scheduleListRefresh(reason) {
      if (typeof setTimeout !== 'function') return
      setTimeout(() => requestListRefresh(reason), LIST_SETTLE_MS)
    }

    /**
     * Send a batch to the Host. Resolves with the host payload for any HTTP 200,
     * including partial successes; a transport or protocol failure throws.
     */
    async function postBatch(sessionIds) {
      let response
      try {
        response = await fetch(BULK_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds }),
        })
      } catch {
        throw new Error(FALLBACK_TEXT['reason.network'])
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error(reasonText(payload, response.status))
      if (payload === null || !Array.isArray(payload.results)) throw new Error(`HTTP ${String(response.status)}`)
      return payload
    }

    /** Fetch the deletable-session list the Host offers for "select all". */
    async function fetchPlan() {
      let response
      try {
        response = await fetch(PLAN_ROUTE, { method: 'GET' })
      } catch {
        throw new Error(FALLBACK_TEXT['reason.network'])
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.sessions)) {
        throw new Error(reasonText(payload, response.status))
      }
      return payload
    }

    /**
     * Session id → the checkbox wrapper element rendered inside that row.
     *
     * Rows are keyed by session, so this doubles as a live index of "where each
     * session is on screen". The currently open session is the one whose row
     * carries the host's `_selected` class; reading it live (rather than caching a
     * value) means switching sessions cannot leave a stale id behind.
     */
    const rowRegistry = new Map()

    /**
     * The session currently open in the UI, or null when it cannot be determined.
     *
     * The class is hashed per build (`…_sessionRow …_selected`), so it is matched by
     * suffix. A wrong guess only ever removes protection from the UI; `run()`
     * re-checks before sending, so it is re-evaluated at the moment of deletion.
     */
    function currentSessionId() {
      for (const [id, element] of rowRegistry) {
        const row = element?.closest?.('[class*="_selected"]')
        if (row !== null && row !== undefined && /row/i.test(String(row.className))) return id
      }
      return null
    }

    /** Session ids whose row this page already hid after a successful delete. */
    const hiddenRows = new Set()
    /** Housekeeping rules this page installed, keyed so each is added once. */
    const installedRules = new Set()

    /**
     * Install one stylesheet rule once.
     * @param key - identity of the rule; a repeat call is a no-op.
     * @param css - rule text.
     * @returns whether the rule is in place.
     */
    function installRule(key, css) {
      if (typeof document === 'undefined' || document?.head === undefined) return false
      if (installedRules.has(key)) return true
      try {
        const tag = document.createElement('style')
        tag.dataset.plugin = PLUGIN_ID
        tag.dataset.rule = key
        tag.textContent = css
        document.head.appendChild(tag)
        installedRules.add(key)
        return true
      } catch {
        // A DOM we cannot touch only costs the immediate hide.
        return false
      }
    }

    function removeRule(key) {
      if (typeof document === 'undefined' || document?.head === undefined) return
      try {
        for (const tag of document.querySelectorAll?.(`style[data-rule="${key}"]`) ?? []) tag.remove()
        installedRules.delete(key)
      } catch {
        // Nothing to undo when the DOM cannot be read.
      }
    }

    /**
     * Hide one deleted session's row on this page.
     *
     * A session the host never materialized on disk exists only in the host's
     * in-memory list: there is no file to unlink, so the row would stay on screen
     * although the host reports success. Every row carries
     * `data-row-key="session:<id>"`, so one scoped rule hides exactly that row and
     * keeps hiding it across re-renders. The rule is inert as soon as the host's
     * list stops carrying the id, and the next page load drops it.
     * @param sessionId - the session whose row was just deleted.
     */
    function hideSessionRow(sessionId) {
      if (hiddenRows.has(sessionId)) return
      if (installRule(`row:${sessionId}`, `[data-row-key="session:${sessionId}"]{display:none !important}`)) {
        hiddenRows.add(sessionId)
        scheduleUngroupedReconcile()
      }
    }

    /**
     * Hide the "Ungrouped" bucket while it holds no visible row.
     *
     * The sidebar draws that bucket from the client's session list, and a deleted
     * session can stay in that list while its Host agent is still resident — the
     * row is hidden by this plugin, leaving a group header with nothing under it.
     * The header is the only element keyed `workspace:` (real Workspaces key by
     * id), so this never touches a named workspace.
     */
    function reconcileUngroupedHeader() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
      let header
      try {
        header = document.querySelector('[data-row-key="workspace:"]')
      } catch {
        return
      }
      if (header === null || header === undefined) {
        removeRule('group:ungrouped')
        return
      }
      let hasVisibleRow = false
      let sibling = header.nextElementSibling
      while (sibling !== null && sibling !== undefined) {
        const key = sibling.getAttribute?.('data-row-key') ?? ''
        if (key.startsWith('workspace:')) break
        if (key.startsWith('session:') && sibling.offsetParent !== null) {
          hasVisibleRow = true
          break
        }
        sibling = sibling.nextElementSibling
      }
      if (hasVisibleRow) removeRule('group:ungrouped')
      else installRule('group:ungrouped', '[data-row-key="workspace:"]{display:none !important}')
    }

    /**
     * Reconcile the "Ungrouped" header now and once more after React re-renders.
     *
     * Hiding a row and hiding its group cannot happen in the same frame: the group
     * is derived from the session list, so it only disappears after the next
     * render. The second pass catches that render.
     */
    function scheduleUngroupedReconcile() {
      reconcileUngroupedHeader()
      if (typeof setTimeout === 'function') setTimeout(reconcileUngroupedHeader, 250)
    }

    /**
     * Bulk-selection state shared by every surface (row checkboxes, the bulk menu
     * row, the action bar). The client's slot model hands each row only its own
     * `{ sessionId }`, so the selection cannot live in a component: it lives here,
     * is published as a client service in `apply`, and every surface subscribes
     * through the same snapshot.
     *
     * The snapshot is immutable and only replaced on real changes, so
     * `useSyncExternalStore` can compare it by identity.
     * @param options.resolveCurrent - returns the open session id, or null.
     */
    function createSelectionStore(options = {}) {
      let resolveCurrent = typeof options.resolveCurrent === 'function' ? options.resolveCurrent : () => null
      let snapshot = Object.freeze({
        active: false,
        selected: Object.freeze([]),
        busy: false,
        phase: 'idle',
        plan: null,
        planError: '',
        result: null,
        done: 0,
        // True when the batch had to drop the session currently being viewed.
        skippedCurrent: false,
      })
      const listeners = new Set()
      const set = (next) => {
        snapshot = Object.freeze({ ...snapshot, ...next })
        for (const listener of listeners) listener()
      }
      const has = (id) => snapshot.selected.includes(id)

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => snapshot,
        /** Internal: replace the open-session resolver (used by tests and by apply). */
        setCurrentResolver(fn) {
          resolveCurrent = typeof fn === 'function' ? fn : () => null
        },
        /** Enter selection mode, clearing any previous batch. */
        activate() {
          set({ active: true, selected: [], phase: 'idle', result: null, done: 0, planError: '', plan: null })
        },
        /** Leave selection mode. Refuses while a delete is in flight. */
        deactivate() {
          if (snapshot.busy) return false
          set({ active: false, selected: [], phase: 'idle', result: null, done: 0 })
          return true
        },
        toggle(sessionId) {
          if (!snapshot.active || snapshot.busy) return
          const next = has(sessionId)
            ? snapshot.selected.filter((id) => id !== sessionId)
            : [...snapshot.selected, sessionId]
          set({ selected: next, phase: 'idle', result: null })
        },
        selectMany(ids) {
          if (!snapshot.active || snapshot.busy) return
          // The session being viewed is never a candidate, not even via "select all".
          const open = resolveCurrent()
          const seen = new Set(snapshot.selected)
          for (const id of ids) {
            if (id === open) continue
            seen.add(id)
          }
          set({ selected: [...seen], phase: 'idle', result: null })
        },
        clear() {
          if (snapshot.busy) return
          set({ selected: [], phase: 'idle', result: null })
        },
        begin() {
          if (snapshot.busy || snapshot.selected.length === 0) return false
          set({ phase: 'armed' })
          return true
        },
        /** Leave the confirmation step but keep the selection. */
        cancel() {
          if (snapshot.busy) return
          set({ phase: 'idle' })
        },
        /** Load the host-side candidate list, used by "select all". */
        async loadPlan() {
          if (snapshot.plan !== null || snapshot.busy) return snapshot.plan
          set({ planError: '' })
          try {
            const payload = await fetchPlan()
            set({ plan: payload })
            return payload
          } catch (error) {
            set({ planError: error instanceof Error ? error.message : String(error) })
            return null
          }
        },
        /**
         * Delete the current selection in one host round trip (the host caps the
         * batch and reports the remainder).
         *
         * On a clean run the selection mode closes itself, so the checkboxes go away
         * with the rows. A partial run keeps only the refused sessions selected, so
         * a running or busy session is still actionable instead of silently surviving
         * a batch that looked like it succeeded.
         *
         * The session being viewed is filtered out here, immediately before the
         * request, rather than trusting the UI to have excluded it.
         */
        async run() {
          if (snapshot.busy || snapshot.selected.length === 0) return null
          const open = resolveCurrent()
          const ids = snapshot.selected.filter((id) => id !== open)
          if (ids.length === 0) {
            // Only the open session was selected: nothing may be deleted.
            set({ phase: 'idle', selected: [], skippedCurrent: true })
            return null
          }
          set({ busy: true, phase: 'running', done: 0, result: null, skippedCurrent: ids.length !== snapshot.selected.length })
          try {
            const payload = await postBatch(ids)
            // The host archives each session before deleting it, so the rows hide
            // themselves; the bar only has to report the outcome. The cached plan
            // is stale now, so "select all" re-fetches.
            const refused = Array.isArray(payload.results)
              ? payload.results.filter((row) => row.ok !== true).map((row) => row.sessionId)
              : []
            // A session the host never wrote to disk has no file to unlink and no
            // archive entry to hide it with, so its row would survive a successful
            // bulk delete exactly like the single-row path.
            if (Array.isArray(payload.results)) {
              for (const row of payload.results) if (row?.ok === true) hideSessionRow(row.sessionId)
            }
            if ((payload.deleted ?? 0) > 0) {
              requestListRefresh('bulk-delete')
              scheduleListRefresh('bulk-delete-settled')
            }
            if (refused.length === 0) {
              set({
                active: false,
                selected: [],
                busy: false,
                phase: 'done',
                result: payload,
                done: payload.deleted ?? 0,
                plan: null,
              })
            } else {
              set({
                busy: false,
                phase: 'failed',
                result: payload,
                done: payload.deleted ?? 0,
                selected: refused,
                plan: null,
              })
            }
            return payload
          } catch (error) {
            set({
              busy: false,
              phase: 'failed',
              result: { ok: false, deleted: 0, failed: ids.length, results: [], message: error instanceof Error ? error.message : String(error) },
              // Keep the ids so the user can retry after a transport failure.
              selected: ids,
            })
            return null
          }
        },
      }
    }

    /**
     * The shared selection store, created in `apply`. It is a module-level binding
     * so every slot component reads the same instance.
     */
    let selection = null

    /**
     * Subscribe a component to the shared store. Returns a null state when the store
     * is absent, so a component can render nothing rather than throwing.
     */
    function useSelection() {
      const store = selection
      if (store === null) return { state: null, store: null }
      // The store's presence is fixed for the page's lifetime, so hook order is stable.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      return { state, store }
    }

    /** Shorten a title so the armed row stays readable in the menu. */
    function shorten(title) {
      const text = typeof title === 'string' && title.trim() !== '' ? title.trim() : ''
      if (text === '') return ''
      return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE)}…` : text
    }

    /** Self-rendered menu row for compositions without the primitives module. */
    function fallbackRow({ children, icon, danger, disabled, onSelect }) {
      return h('button', {
        type: 'button',
        role: 'menuitem',
        disabled,
        onClick: onSelect,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          minHeight: '34px',
          padding: '6px 8px',
          border: 'none',
          borderRadius: 'var(--dsw-radius-md, 8px)',
          background: 'transparent',
          textAlign: 'left',
          fontSize: '13px',
          lineHeight: '20px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          color: danger
            ? 'var(--dsw-alias-state-error-primary, #d34)'
            : 'var(--dsw-alias-label-primary, inherit)',
        },
      }, [
        icon !== undefined && h('span', {
          key: 'icon',
          style: {
            display: 'inline-flex',
            flex: 'none',
            width: '14px',
            height: '14px',
            alignItems: 'center',
            justifyContent: 'center',
            color: danger ? 'var(--dsw-alias-state-error-primary, #d34)' : 'var(--dsw-alias-menu-icon, inherit)',
          },
        }, icon),
        h('span', {
          key: 'label',
          style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, children),
      ])
    }

    /**
     * The menu row: idle → armed → busy, with a retryable failure state.
     * @param props - row identity, the menu-state hook, the inject face, locale.
     * @returns one menu row.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, deleteSession: run, t } = props
      const translate = typeof t === 'function' ? t : (key, values) => format(FALLBACK_TEXT[key] ?? key, values)
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const setMenuOpen = typeof menuState?.[1] === 'function' ? menuState[1] : () => {}
      const [phase, setPhase] = React.useState('idle')
      const [reason, setReason] = React.useState('')
      // The session being viewed is protected here too: deleting it leaves the page
      // sitting in a session that no longer exists.
      const isOpen = currentSessionId() === sessionId

      const onSelect = React.useCallback(() => {
        if (isOpen) return
        if (phase === 'busy' || phase === 'done') return
        if (phase !== 'armed') {
          setReason('')
          setPhase('armed')
          return
        }
        setPhase('busy')
        Promise.resolve()
          .then(() => run(sessionId))
          .then(() => {
            setPhase('done')
            setMenuOpen(false)
          })
          .catch((error) => {
            const message = typeof error?.message === 'string' && error.message !== ''
              ? error.message
              : String(error)
            setReason(message)
            setPhase('failed')
          })
      }, [isOpen, phase, run, sessionId, setMenuOpen])

      const title = shorten(displayTitle)
      let label
      if (isOpen) label = translate('row.current')
      else if (phase === 'armed') label = translate('menu.confirm', { title: title === '' ? sessionId : title })
      else if (phase === 'busy') label = translate('menu.busy')
      else if (phase === 'done') label = translate('menu.done')
      else if (phase === 'failed') label = translate('menu.failed', { reason })
      else label = translate('menu.delete')

      const icon = primitives?.IconTrashOutlineRegular === undefined
        ? undefined
        : h(primitives.IconTrashOutlineRegular, { size: 14 })
      const disabled = isOpen || phase === 'busy' || phase === 'done'

      if (primitives?.MenuItemButton !== undefined) {
        return h(primitives.MenuItemButton, {
          danger: !isOpen,
          separatorBefore: true,
          icon,
          disabled,
          onSelect,
        }, label)
      }
      return fallbackRow({
        children: label,
        icon,
        danger: !isOpen,
        disabled,
        onSelect,
      })
    }

    /** Shared styling for the bulk surfaces, using only documented theme tokens. */
    const TOKENS = {
      danger: 'var(--dsw-alias-state-error-primary, #d34)',
      label: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #666)',
      border: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))',
      surface: 'var(--dsw-alias-bg-elevated, #fff)',
      radius: 'var(--dsw-radius-md, 8px)',
    }

    /**
     * A plugin must never be able to take a host surface down with it.
     *
     * Every slot entry is wrapped in an error boundary: if a render throws, only
     * that entry disappears (rendering null) and one warning names it in the
     * console. Without this, a single bad render inside a session row can blank the
     * whole session list.
     *
     * The class is created lazily on purpose: `class X extends React.Component`
     * evaluates when the bundle is materialized, so a missing `Component` export
     * would throw there and take the entire plugin down before anything renders.
     */
    let SurfaceBoundary = null
    function surfaceBoundary() {
      if (SurfaceBoundary !== null) return SurfaceBoundary
      if (typeof React.Component !== 'function') return null
      SurfaceBoundary = class extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error) {
          console.warn(`[${PLUGIN_ID}] surface "${this.props.surface}" failed to render:`, error)
        }

        render() {
          return this.state.failed ? null : this.props.children
        }
      }
      return SurfaceBoundary
    }

    /**
     * Wrap a slot component so a throw degrades to "this entry renders nothing".
     *
     * If the host's React exposes no `Component` class the wrapper cannot exist, so
     * the raw component is returned instead: the guard is a safety net, never a
     * hard dependency (a `class extends undefined` would throw while the bundle is
     * still being evaluated, taking the plugin down with it).
     * @param surface - entry id, used in the console warning.
     * @param Component - the real slot component.
     * @returns a guarded component of the same shape.
     */
    function guarded(surface, Component) {
      const Boundary = surfaceBoundary()
      if (Boundary === null) return Component
      return function GuardedSurface(props) {
        return h(Boundary, { surface }, h(Component, props))
      }
    }

    /**
     * One menu row that enters or leaves selection mode.
     *
     * It is registered on the same slot as the single delete row, so it inherits
     * the menu plumbing that already works, and it stays reachable for running and
     * archived sessions (whose `row.leading` slot is suppressed).
     */
    function BulkMenuMenuItem(props) {
      const { useMenuOpenState, t } = props
      const translate = typeof t === 'function' ? t : (key, values) => format(FALLBACK_TEXT[key] ?? key, values)
      const { state, store } = useSelection()
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const setMenuOpen = typeof menuState?.[1] === 'function' ? menuState[1] : () => {}
      if (state === null || store === null) return null

      const onSelect = () => {
        setMenuOpen(false)
        if (state.active) store.deactivate()
        else store.activate()
      }

      const label = state.active ? translate('bulk.cancel') : translate('bulk.enter')
      const icon = primitives?.IconChecklistOutlineRegular === undefined
        ? undefined
        : h(primitives.IconChecklistOutlineRegular, { size: 14 })

      if (primitives?.MenuItemButton !== undefined) {
        return h(primitives.MenuItemButton, {
          separatorBefore: !state.active,
          icon,
          onSelect,
        }, label)
      }
      return fallbackRow({ children: label, icon, danger: false, disabled: false, onSelect })
    }

    /**
     * The per-row checkbox, registered into `sidebar.session.row.leading`.
     *
     * That slot only renders for neither-archived nor status-dot rows, so an
     * archived or currently running session has no checkbox: those are reachable
     * through the row menu instead, and the host refuses a running one anyway.
     *
     * Events are stopped so arming a row never opens the session or starts the
     * row's drag reorder. `click` is NOT default-prevented: the row is draggable
     * and the checkbox lives inside it, and cancelling the click's default action
     * suppresses the checkbox's own activation (onChange never fires).
     */
    function BulkRowCheckbox(props) {
      const { sessionId, displayTitle, t } = props
      const translate = typeof t === 'function' ? t : (key, values) => format(FALLBACK_TEXT[key] ?? key, values)
      const { state, store } = useSelection()
      const [tick, setTick] = React.useState(0)
      const active = state !== null && store !== null && state.active

      // A ref callback runs when the element actually appears, which matters
      // because this component only renders its box once selection mode starts.
      // The element is kept (hidden) while inactive so the single-delete row can
      // still tell whether it belongs to the open session.
      const attach = React.useCallback((element) => {
        if (element === null) {
          rowRegistry.delete(sessionId)
          return
        }
        rowRegistry.set(sessionId, element)
        // The element only exists now, so the render that produced it could not
        // have known whether this row is the open one: ask for one more render.
        setTick((value) => value + 1)
      }, [sessionId])

      // "Which row is selected" is host state we cannot subscribe to, and the row
      // does not re-render when the user switches sessions. A coarse tick while
      // selection mode is on keeps the checkbox honest; the value that decides an
      // actual deletion is re-read at confirm time regardless.
      React.useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 500)
        return () => clearInterval(timer)
      }, [active])

      if (state === null || store === null) return null

      // The session being viewed can never be part of a delete batch.
      const isOpen = currentSessionId() === sessionId
      void tick

      if (!active) {
        // Hidden anchor only: keeps the row discoverable without occupying space.
        return h('span', {
          ref: attach,
          style: { display: 'none' },
          'aria-hidden': true,
          'data-session-id': sessionId,
        })
      }

      const checked = state.selected.includes(sessionId) && !isOpen
      const title = shorten(displayTitle)
      const label = isOpen
        ? translate('row.current')
        : (title === ''
            ? translate('bulk.selectN', { id: sessionId })
            : translate('bulk.select', { title }))
      const keep = (event) => event.stopPropagation()

      return h('span', {
        ref: attach,
        'data-session-id': sessionId,
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '16px', height: '16px' },
        onClick: keep,
        onDoubleClick: keep,
        onPointerDown: keep,
        onMouseDown: keep,
        onDragStart: (event) => {
          // Do not let the row's drag-reorder start from the checkbox.
          event.stopPropagation()
          event.preventDefault()
        },
        title: label,
      }, h('input', {
        type: 'checkbox',
        checked,
        disabled: state.busy || isOpen,
        'aria-label': label,
        onChange: () => store.toggle(sessionId),
        style: {
          width: '13px',
          height: '13px',
          margin: 0,
          cursor: state.busy || isOpen ? 'not-allowed' : 'pointer',
          accentColor: TOKENS.danger,
          opacity: isOpen ? 0.4 : 1,
        },
      }))
    }

    /**
     * The bulk action: a red button anchored under the session list, plus a
     * confirmation dialog.
     *
     * Registered into `shell.overlay`, the frame-wide overlay layer the layout
     * package renders as `position:absolute; inset:0; pointer-events:none` with
     * `pointer-events:auto` on its direct children. Anchoring with `left`/`bottom`
     * puts the button at the bottom of the sidebar — visually under the last session
     * row — without needing to measure anything.
     *
     * Renders nothing unless selection mode is on and at least one session is
     * selected.
     */
    function BulkBar(props) {
      const { t } = props
      const translate = typeof t === 'function' ? t : (key, values) => format(FALLBACK_TEXT[key] ?? key, values)
      const { state, store } = useSelection()

      if (state === null || store === null) return null
      if (!state.active || state.selected.length === 0) return null

      const count = state.selected.length
      const busy = state.busy
      const result = state.result
      const failed = result?.failed ?? 0
      const deleted = result?.deleted ?? 0

      let status = ''
      if (state.phase === 'done' || state.phase === 'failed') {
        status = failed > 0
          ? translate('bar.partial', { deleted, failed })
          : translate('bar.done', { deleted })
        if ((result?.remaining ?? 0) > 0) status += ` · ${translate('bulk.remain', { left: result.remaining })}`
        if (result?.ok === false && failed === 0 && typeof result?.message === 'string') status = result.message
      }

      const button = h('button', {
        key: 'action',
        type: 'button',
        disabled: busy,
        title: translate('bulk.enter'),
        onClick: () => {
          if (!busy) store.begin()
        },
        style: {
          position: 'absolute',
          left: '8px',
          bottom: '8px',
          width: 'calc(var(--dsh-windows-sidebar-width, 260px) - 16px)',
          padding: '8px 10px',
          border: `1px solid ${TOKENS.danger}`,
          borderRadius: TOKENS.radius,
          background: TOKENS.danger,
          color: 'var(--dsw-alias-label-on-error, #fff)',
          fontSize: '13px',
          fontWeight: 600,
          lineHeight: '18px',
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.6 : 1,
          pointerEvents: 'auto',
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        },
      }, busy
        ? translate('bulk.deleting', { done: 0, total: count })
        : translate('bar.delete', { count }))

      const note = status === ''
        ? null
        : h('div', {
          key: 'note',
          style: {
            position: 'absolute',
            left: '8px',
            bottom: '46px',
            width: 'calc(var(--dsh-windows-sidebar-width, 260px) - 16px)',
            padding: '4px 8px',
            borderRadius: '6px',
            background: TOKENS.surface,
            border: `1px solid ${failed > 0 ? TOKENS.danger : TOKENS.border}`,
            color: failed > 0 ? TOKENS.danger : TOKENS.secondary,
            fontSize: '11px',
            lineHeight: '16px',
            pointerEvents: 'none',
          },
        }, status)

      if (state.phase !== 'armed') return h('div', null, [button, note])

      // Two-step confirmation, as a real dialog rather than a label change.
      const dialog = h('div', {
        key: 'confirm-backdrop',
        style: {
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.35)',
          pointerEvents: 'auto',
        },
      }, h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        style: {
          width: 'min(360px, calc(100vw - 48px))',
          padding: '16px',
          borderRadius: TOKENS.radius,
          background: TOKENS.surface,
          border: `1px solid ${TOKENS.border}`,
          boxShadow: '0 16px 40px rgba(0,0,0,0.24)',
          color: TOKENS.label,
          fontSize: '13px',
          lineHeight: '20px',
        },
      }, [
        h('div', {
          key: 'title',
          style: { fontWeight: 600, marginBottom: '8px' },
        }, translate('confirm.title', { count })),
        h('div', {
          key: 'body',
          style: { color: TOKENS.secondary, marginBottom: '14px' },
        }, translate('confirm.body')),
        h('div', {
          key: 'actions',
          style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
        }, [
          h('button', {
            key: 'cancel',
            type: 'button',
            onClick: () => store.cancel(),
            style: {
              border: `1px solid ${TOKENS.border}`,
              borderRadius: '6px',
              background: 'transparent',
              color: TOKENS.label,
              padding: '4px 12px',
              fontSize: '12px',
              cursor: 'pointer',
            },
          }, translate('confirm.cancel')),
          h('button', {
            key: 'ok',
            type: 'button',
            onClick: () => store.run(),
            style: {
              border: `1px solid ${TOKENS.danger}`,
              borderRadius: '6px',
              background: TOKENS.danger,
              color: 'var(--dsw-alias-label-on-error, #fff)',
              padding: '4px 12px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            },
          }, translate('confirm.ok')),
        ]),
      ]))

      return h('div', null, [button, note, dialog])
    }

    /**
     * A per-row menu entry that toggles selection for *this* session.
     *
     * It exists because `sidebar.session.row.leading` is suppressed for archived
     * rows and for rows showing a live status dot, which would otherwise be
     * unselectable. While selection mode is on it is the reliable path for every row;
     * it disappears when the mode is off.
     */
    function BulkRowMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props
      const translate = typeof t === 'function' ? t : (key, values) => format(FALLBACK_TEXT[key] ?? key, values)
      const { state, store } = useSelection()
      const menuState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
      const setMenuOpen = typeof menuState?.[1] === 'function' ? menuState[1] : () => {}
      if (state === null || store === null || !state.active) return null

      const checked = state.selected.includes(sessionId)
      const onSelect = () => {
        store.toggle(sessionId)
        setMenuOpen(false)
      }
      const title = shorten(displayTitle)
      const label = checked ? translate('row.unselect') : translate('row.select')
      const icon = checked && primitives?.IconCheckOutlineRegular !== undefined
        ? h(primitives.IconCheckOutlineRegular, { size: 14 })
        : undefined

      if (primitives?.MenuItemButton !== undefined) {
        return h(primitives.MenuItemButton, {
          icon,
          disabled: state.busy,
          onSelect,
        }, label)
      }
      return fallbackRow({ children: label, icon, danger: false, disabled: state.busy, onSelect })
    }


    return {
      // 'locale' is required on purpose: the dictionary can only be registered
      // once @deepseek-ai/dsh-client-locale has provided the service. Declaring
      // it here makes the loader wait, instead of racing the provider and
      // silently falling back to the built-in English table.
      inject: ['slots', 'locale'],
      apply(ctx) {
        let localised = false
        const locale = ctx.get?.('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            ctx.effect(() => locale.register(NS, DICTIONARIES), `${PLUGIN_ID}: dictionaries`)
            localised = true
          } catch (error) {
            console.warn(`[${PLUGIN_ID}] dictionary registration failed:`, error)
          }
        } else {
          console.warn(`[${PLUGIN_ID}] locale service unavailable; continuing with the English fallback table`)
        }

        // One store for every surface: rows only receive their own session id, so
        // the selection cannot live inside a component. The "open session" resolver
        // is read live from the row registry, and re-read right before deleting.
        selection = createSelectionStore({ resolveCurrent: currentSessionId })
        try {
          ctx.provide('sessionDeleteSelection', selection)
        } catch (error) {
          // The service is a convenience for other plugins; losing it must not stop
          // this one from registering its own surfaces.
          console.warn(`[${PLUGIN_ID}] could not publish the selection service:`, error)
        }
        ctx.effect(() => () => {
          selection?.deactivate()
          selection = null
        }, `${PLUGIN_ID}: selection store`)

        // A deleted session emits no removal event, so the client's session list
        // keeps the row until it is re-pulled: the row loses its workspace slot and
        // shows up under "Ungrouped", or leaves an empty group behind. `refresh()`
        // is the client session service's own baseline pull. Each pull ends with a
        // state report, so the diagnostic route always describes what the renderer
        // currently holds.
        requestListRefresh = (reason = 'refresh') => {
          let pulled
          try {
            const sessions = ctx.get?.('sessions')
            if (sessions !== undefined && typeof sessions.refresh === 'function') {
              pulled = Promise.resolve(sessions.refresh()).catch(() => {})
            }
          } catch (error) {
            console.warn(`[${PLUGIN_ID}] session list refresh failed:`, error)
          }
          Promise.resolve(pulled).then(() => {
            reportClientState(ctx, reason)
            scheduleUngroupedReconcile()
          }).catch(() => {})
        }

        const localeOption = localised ? { locale: NS } : {}

        /**
         * Register one slot entry, isolating failures. A surface that cannot
         * register is skipped and named in the console; the others still load.
         */
        const mount = (label, slot, config, Component) => {
          try {
            ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...config }, Component))
          } catch (error) {
            console.warn(`[${PLUGIN_ID}] could not register "${label}":`, error)
          }
        }

        mount('delete-session', SLOT, {
          id: `${PLUGIN_ID}.delete-session`,
          order: 500,
          ...localeOption,
          inject: () => ({ deleteSession }),
        }, guarded('delete-session', DeleteSessionMenuItem))

        // 'locale' here is what turned the bulk row English: without it the slot
        // hands the component no `t` seat and every label falls back to the
        // built-in English table.
        mount('bulk-mode', SLOT, {
          id: `${PLUGIN_ID}.bulk-mode`,
          order: 450,
          ...localeOption,
        }, guarded('bulk-mode', BulkMenuMenuItem))

        // Second, always-available way to select one session: the row's leading
        // slot is suppressed for archived and status-dot rows.
        mount('row-select', SLOT, {
          id: `${PLUGIN_ID}.row-select`,
          order: 460,
          ...localeOption,
        }, guarded('row-select', BulkRowMenuItem))

        mount('row-checkbox', LEADING_SLOT, {
          id: `${PLUGIN_ID}.row-checkbox`,
          order: 100,
          ...localeOption,
        }, guarded('row-checkbox', BulkRowCheckbox))

        // The frame-wide overlay seat: no row transform/overflow can capture it.
        mount('bulk-bar', OVERLAY_SLOT, {
          id: `${PLUGIN_ID}.bulk-bar`,
          order: 100,
          ...localeOption,
        }, guarded('bulk-bar', BulkBar))

        // Visible in the page console (F12): the quickest way to tell whether
        // this page actually loaded the plugin bundle.
        console.info(
          `[dsh-session-delete] bulk surfaces registered: ${SLOT} (menu), ${LEADING_SLOT} (checkbox), ${OVERLAY_SLOT} (bar)`
          + ` (locale: ${localised ? NS : 'english fallback'})`
          + (primitives?.MenuItemButton === undefined ? ' (fallback rows: primitives module unavailable)' : ''),
        )

        // Reconcile once on load: a session deleted before this bundle mounted can
        // still sit in the client's list (and leave an empty "Ungrouped" group).
        // The pull joins any baseline read already in flight.
        requestListRefresh('mount')
      },
    }
  },
})
