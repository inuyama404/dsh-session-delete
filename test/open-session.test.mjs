// Verify the open-session protection at the DOM level, with a fake element that
// answers `closest()` the way the real session row does.
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
const checkbox = registrations.find((r) => r.config.id === 'dsh-session-delete.row-checkbox').Component

const A = 'session-aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'session-bbbbbbbb-0000-4000-8000-00000000000b'

/** A stand-in for a session row: it matches `[class*="_selected"]` only when told. */
function fakeRowElement(rowClass) {
  const row = { className: rowClass }
  return {
    closest(selector) {
      if (selector !== '[class*="_selected"]') return null
      return rowClass.includes('_selected') ? row : null
    },
  }
}

/** Render the checkbox and wire its ref by hand (the fake React never commits). */
function renderCheckbox(sessionId, rowElement) {
  const props = { sessionId, displayTitle: '测试', useMenuOpenState: () => [false, () => {}], deleteSession: async () => {} }
  const tree = checkbox(props)
  if (tree?.props?.ref && rowElement !== undefined) tree.props.ref(rowElement)
  return checkbox(props)
}

const results = []
const check = (label, cond, extra = '') => {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
}
const input = (tree) => tree?.children
const isDisabled = (tree) => input(tree)?.props?.disabled === true
const titleOf = (tree) => input(tree)?.props?.['aria-label'] ?? tree?.props?.title

// --- inactive: renders only a hidden anchor ---------------------------------
store.deactivate()
const idle = renderCheckbox(A, fakeRowElement('hIlkoa_sessionRow'))
check('inactive renders a hidden anchor', idle?.type === 'span' && idle?.props?.style?.display === 'none')
check('inactive anchor still carries the ref', typeof idle?.props?.ref === 'function')

// --- active, this row IS the open session ----------------------------------
store.activate()
const openRow = renderCheckbox(A, fakeRowElement('hIlkoa_sessionRow hIlkoa_selected hIlkoa_menuOpen'))
check('open session: checkbox disabled', isDisabled(openRow), String(isDisabled(openRow)))
check('open session: explains why', /当前会话|open session/i.test(String(titleOf(openRow))), String(titleOf(openRow)))

// --- active, another row ---------------------------------------------------
const otherRow = renderCheckbox(B, fakeRowElement('hIlkoa_sessionRow'))
check('other session: checkbox enabled', isDisabled(otherRow) === false)
check('other session: selectable label', !String(titleOf(otherRow)).includes('当前会话'), String(titleOf(otherRow)))

// --- switching away clears the protection ----------------------------------
renderCheckbox(A, fakeRowElement('hIlkoa_sessionRow'))
const afterSwitch = renderCheckbox(A, undefined)
check('after switching away it is enabled again', isDisabled(afterSwitch) === false)

// --- unmount removes the registry entry ------------------------------------
const tree = renderCheckbox(A, fakeRowElement('hIlkoa_sessionRow'))
tree.props.ref(null)
const afterUnmount = renderCheckbox(B, undefined)
check('unmounted row no longer claimed as open', isDisabled(afterUnmount) === false)

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
