// Verify the new action bar: red button under the list, and the confirm dialog.
import { readFileSync } from 'node:fs'
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

const registrations = []
const provided = new Map()
mod.apply({
  get: (n) => (n === 'locale' ? { register: () => () => {} } : undefined),
  effect: (fn) => fn(),
  provide: (n, v) => provided.set(n, v),
  slots: { inject: (_n, fn) => fn(), register: (config, Component) => { registrations.push({ config, Component }); return () => {} } },
})

const store = provided.get('sessionDeleteSelection')
const bar = registrations.find((r) => r.config.id === 'dsh-session-delete.bulk-bar')
if (!bar) { console.error('bar not registered'); process.exit(1) }

const props = { sessionId: 'x', displayTitle: 't', useMenuOpenState: () => [false, () => {}], deleteSession: async () => {} }
let pass = true
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) pass = false
}

// 1. nothing selected -> nothing rendered
store.deactivate()
const idle = bar.Component(props)
check('no selection => renders null', idle === null, JSON.stringify(idle))

// 2. three selected -> one red button under the list
store.activate()
store.selectMany(['a', 'b', 'c'])
const withSelection = bar.Component(props)
const parts = (withSelection?.children ?? []).filter(Boolean)
const button = parts.find((c) => c.props?.type === 'button') ?? parts[0]
check('bar renders a container', withSelection?.type === 'div')
check('contains one button', button?.type === 'button', String(button?.type))
check('button is red', String(button?.props?.style?.background).includes('error-primary'), String(button?.props?.style?.background))
check('button sits at the sidebar bottom-left', button?.props?.style?.position === 'absolute' && button?.props?.style?.left === '8px' && button?.props?.style?.bottom === '8px')
check('button label carries the count', String(button?.children).includes('3'), String(button?.children))
check('no dialog before confirming', !JSON.stringify(withSelection).includes('"role":"dialog"'))

// 3. arming opens the confirmation dialog
store.begin()
const armed = bar.Component(props)
const hasDialog = JSON.stringify(armed).includes('"role":"dialog"')
check('confirm dialog appears when armed', hasDialog)
check('dialog is modal', JSON.stringify(armed).includes('"aria-modal":"true"'))
// This render has no `t` seat, so labels come from the English fallback table.
const btnCount = (JSON.stringify(armed).match(/"type":"button"/g) ?? []).length
check('dialog offers cancel + confirm', btnCount >= 6, `${btnCount / 2} buttons (element+prop pairs)`)
check('dialog names the count', JSON.stringify(armed).includes('3 sessions'))

// 4. cancel keeps the selection
store.cancel()
check('cancel returns to idle', store.getSnapshot().phase === 'idle')
check('cancel keeps the selection', store.getSnapshot().selected.length === 3)
const afterCancel = bar.Component(props)
check('dialog closed after cancel', !JSON.stringify(afterCancel).includes('"role":"dialog"'))

console.log(`\nRESULT: ${pass ? 'ALL PASS' : 'FAILURES'}`)
process.exit(pass ? 0 : 1)
