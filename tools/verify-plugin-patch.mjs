// Verify the patched plugin client: inject list, dictionary registration, and
// the locale config handed to the slot in both service-present and service-absent cases.
import { readFileSync } from 'node:fs'

const src = readFileSync(process.argv[2], 'utf8')
let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      mod = factory((id) => {
        if (id === 'react') {
          return { createElement: (t, p, c) => ({ t, p, c }), useState: (i) => [i, () => {}], useCallback: (f) => f }
        }
        throw new Error(`no module ${id}`)
      })
    },
  },
}
await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)

function run(label, { provideLocale }) {
  const registered = []
  const captured = {}
  const fakeLocale = {
    register: (ns, dicts) => { registered.push({ ns, locales: Object.keys(dicts) }); return () => {} },
  }
  const ctx = {
    get: (n) => (n === 'locale' && provideLocale ? fakeLocale : undefined),
    effect: (fn) => fn(),
    slots: { inject: (_n, fn) => fn(), register: (cfg) => { captured.cfg = cfg } },
  }
  mod.apply(ctx)
  console.log(`\n[${label}]`)
  console.log('  inject           :', JSON.stringify(mod.inject))
  console.log('  locale.register  :', registered.length ? JSON.stringify(registered) : '(not called)')
  console.log('  slot locale opt  :', captured.cfg?.locale ?? '(absent -> English fallback)')
  return { registered, captured }
}

const a = run('locale service PRESENT', { provideLocale: true })
const b = run('locale service ABSENT', { provideLocale: false })

const ok =
  JSON.stringify(mod.inject) === '["slots","locale"]' &&
  a.registered.length === 1 &&
  a.registered[0].ns === 'dsh-session-delete' &&
  JSON.stringify(a.registered[0].locales) === '["zh","en"]' &&
  a.captured.cfg.locale === 'dsh-session-delete' &&
  b.registered.length === 0 &&
  b.captured.cfg.locale === undefined

console.log(`\nRESULT: ${ok ? 'ALL CHECKS PASS' : 'CHECK FAILED'}`)

// Optional second argument: write the exact text that should be committed upstream
// (base64 of the source, LF-normalized, no BOM) for a byte-exact Contents API write.
if (process.argv[3]) {
  const { writeFileSync } = await import('node:fs')
  const committed = src.replace(/\r\n/g, '\n')
  writeFileSync(process.argv[3], Buffer.from(committed, 'utf8').toString('base64'), 'utf8')
  console.log(`wrote base64 payload -> ${process.argv[3]} (${Buffer.byteLength(committed)} bytes)`)
}

