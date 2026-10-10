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
    const ROUTE = '/dsh-session-delete/delete'
    const NS = 'dsh-session-delete'
    const MAX_TITLE = 22

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
      return payload
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

      const onSelect = React.useCallback(() => {
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
      }, [phase, run, sessionId, setMenuOpen])

      const title = shorten(displayTitle)
      let label
      if (phase === 'armed') label = translate('menu.confirm', { title: title === '' ? sessionId : title })
      else if (phase === 'busy') label = translate('menu.busy')
      else if (phase === 'done') label = translate('menu.done')
      else if (phase === 'failed') label = translate('menu.failed', { reason })
      else label = translate('menu.delete')

      const icon = primitives?.IconTrashOutlineRegular === undefined
        ? undefined
        : h(primitives.IconTrashOutlineRegular, { size: 14 })

      if (primitives?.MenuItemButton !== undefined) {
        return h(primitives.MenuItemButton, {
          danger: true,
          separatorBefore: true,
          icon,
          disabled: phase === 'busy' || phase === 'done',
          onSelect,
        }, label)
      }
      return fallbackRow({
        children: label,
        icon,
        danger: true,
        disabled: phase === 'busy' || phase === 'done',
        onSelect,
      })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let localised = false
        const locale = ctx.get?.('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            ctx.effect(() => locale.register(NS, DICTIONARIES), `${PLUGIN_ID}: dictionaries`)
            localised = true
          } catch {
            localised = false
          }
        }
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: `${PLUGIN_ID}.delete-session`,
          order: 500,
          ...(localised ? { locale: NS } : {}),
          inject: () => ({ deleteSession }),
        }, DeleteSessionMenuItem))
        // Visible in the page console (F12): the quickest way to tell whether
        // this page actually loaded the plugin bundle.
        console.info(
          `[dsh-session-delete] menu entry registered in ${SLOT}`
          + (primitives?.MenuItemButton === undefined ? ' (fallback row: primitives module unavailable)' : ''),
        )
      },
    }
  },
})
