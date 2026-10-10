// Fetch upstream client.js, apply the locale fix textually, and verify the result
// reproduces the locally-installed patched file byte-for-byte. That guarantee is
// what makes the Contents API write safe: the committed bytes are exactly the
// bytes that passed the mocked cordis/render verification.
import { readFileSync, writeFileSync } from 'node:fs'

const [, , upstreamPath, installedPath, outDir] = process.argv
const upstream = readFileSync(upstreamPath, 'utf8')
const installed = readFileSync(installedPath, 'utf8')

const OLD = `    return {
      inject: ['slots'],
      apply(ctx) {
        let localised = false
        const locale = ctx.get?.('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            ctx.effect(() => locale.register(NS, DICTIONARIES), \`\${PLUGIN_ID}: dictionaries\`)
            localised = true
          } catch {
            localised = false
          }
        }`

const NEW = `    return {
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
            ctx.effect(() => locale.register(NS, DICTIONARIES), \`\${PLUGIN_ID}: dictionaries\`)
            localised = true
          } catch (error) {
            console.warn(\`[\${PLUGIN_ID}] dictionary registration failed:\`, error)
          }
        } else {
          console.warn(\`[\${PLUGIN_ID}] locale service unavailable; continuing with the English fallback table\`)
        }`

const OLD_LOG = `          \`[dsh-session-delete] menu entry registered in \${SLOT}\`
          + (primitives?.MenuItemButton === undefined ? ' (fallback row: primitives module unavailable)' : ''),`
const NEW_LOG = `          \`[dsh-session-delete] menu entry registered in \${SLOT}\`
          + \` (locale: \${localised ? NS : 'english fallback'})\`
          + (primitives?.MenuItemButton === undefined ? ' (fallback row: primitives module unavailable)' : ''),`

let rebuilt = upstream
for (const [label, from, to] of [['inject/guard', OLD, NEW], ['startup log', OLD_LOG, NEW_LOG]]) {
  const n = rebuilt.split(from).length - 1
  console.log(`${label.padEnd(14)}: ${n} occurrence(s) in upstream`)
  if (n !== 1) { console.error(`FAIL: expected exactly 1 anchor for ${label}`); process.exit(1) }
  rebuilt = rebuilt.replace(from, to)
}

const rebuiltBuf = Buffer.from(rebuilt, 'utf8')
const installedBuf = Buffer.from(installed, 'utf8')
console.log(`upstream  bytes: ${Buffer.byteLength(upstream)}`)
console.log(`rebuilt   bytes: ${rebuiltBuf.length}`)
console.log(`installed bytes: ${installedBuf.length}`)
const same = Buffer.compare(rebuiltBuf, installedBuf) === 0
console.log(`REBUILD MATCHES TESTED FILE: ${same ? 'YES' : 'NO'}`)
if (!same) {
  const a = rebuilt.split('\n'), b = installed.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`first diff at line ${i + 1}:\n  rebuilt  : ${JSON.stringify(a[i])}\n  installed: ${JSON.stringify(b[i])}`)
      break
    }
  }
  process.exit(1)
}

if (outDir) {
  writeFileSync(`${outDir}/client.fixed.js`, rebuilt, 'utf8')
  writeFileSync(`${outDir}/client.fixed.b64`, rebuiltBuf.toString('base64'), 'utf8')
  // A patch in git's own format is still handy for the PR body / manual apply.
  writeFileSync(`${outDir}/client.js.diff`, [
    'diff --git a/client.js b/client.js',
    '--- a/client.js',
    '+++ b/client.js',
    '@@ inject/disable-silent-english-fallback @@',
    ...OLD.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')).map((l) => '-' + l),
    ...NEW.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')).map((l) => '+' + l),
    ...OLD_LOG.split('\n').map((l) => '-' + l),
    ...NEW_LOG.split('\n').map((l) => '+' + l),
    '',
  ].join('\n'), 'utf8')
  console.log(`wrote: client.fixed.js, client.fixed.b64 (${rebuiltBuf.length} bytes), client.js.diff -> ${outDir}`)
}
