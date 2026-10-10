// Verify the 0.1.2 tarball: entry layout vs 0.1.1, file contents vs the committed
// upstream client.js, gzip integrity, and the digests to publish.
// Parses the tar format in-process: spawning `tar` hits the sandbox's EPERM on pipes.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const [, , tgz112, tgz111, fixedClient, outDigest] = process.argv

const sha = (buf, alg) => createHash(alg).update(buf).digest('hex')

/** Minimal ustar reader: returns [{ name, size, body }] for regular files. */
function readTar(gz) {
  const buf = gunzipSync(gz)
  const entries = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const str = (s, e) => header.toString('utf8', s, e).replace(/\0.*$/, '').trim()
    const name = str(0, 100)
    const prefix = str(345, 500)
    const sizeField = str(124, 136)
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8)
    const typeflag = header.toString('utf8', 156, 157)
    const full = prefix === '' ? name : `${prefix}/${name}`
    const body = buf.subarray(off + 512, off + 512 + size)
    if (typeflag === '' || typeflag === '0') entries.push({ name: full, size, body })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return { entries, tarBytes: buf.length }
}

const tgz = readFileSync(tgz112)
console.log('=== artifact ===')
console.log(`file       : ${tgz112}`)
console.log(`bytes      : ${tgz.length}`)
console.log(`sha256     : ${sha(tgz, 'sha256')}`)
console.log(`sha512     : ${sha(tgz, 'sha512')}`)

const cur = readTar(tgz)
console.log(`gunzip ok  : ${cur.tarBytes} bytes of tar, ${cur.entries.length} entries`)

const prev = readTar(readFileSync(tgz111))
console.log('\n=== entries (0.1.1 vs 0.1.2) ===')
for (const e of cur.entries) {
  const p = prev.entries.find((x) => x.name === e.name)
  console.log(`  ${e.name.padEnd(26)} ${String(e.size).padStart(6)}   ${p ? `(0.1.1: ${p.size})` : '(NEW)'}`)
}
const aNames = prev.entries.map((e) => e.name).sort()
const bNames = cur.entries.map((e) => e.name).sort()
const sameLayout = JSON.stringify(aNames) === JSON.stringify(bNames)
console.log(`layout identical to 0.1.1: ${sameLayout ? 'YES' : 'NO'}`)

// Unchanged files must be byte-identical to 0.1.1; client.js must equal the fix.
console.log('\n=== file-by-file comparison ===')
let allSame = true
for (const e of cur.entries) {
  const p = prev.entries.find((x) => x.name === e.name)
  if (!p) { console.log(`  ${e.name.padEnd(26)} NEW`); continue }
  const same = Buffer.compare(p.body, e.body) === 0
  if (!same && e.name !== 'package/package.json') allSame = false
  console.log(`  ${e.name.padEnd(26)} ${same ? 'identical' : 'CHANGED'}`)
}

const c12 = cur.entries.find((e) => e.name === 'package/client.js').body
const fixed = readFileSync(fixedClient)
console.log('\n=== client.js in tarball vs committed fix ===')
console.log(`  tarball  : ${c12.length} bytes sha256 ${sha(c12, 'sha256')}`)
console.log(`  committed: ${fixed.length} bytes sha256 ${sha(fixed, 'sha256')}`)
const clientOk = Buffer.compare(c12, fixed) === 0
console.log(`  MATCHES COMMITTED FIX: ${clientOk ? 'YES' : 'NO'}`)

const pj = JSON.parse(cur.entries.find((e) => e.name === 'package/package.json').body.toString('utf8'))
console.log('\n=== manifest ===')
console.log(`  name/version : ${pj.name}@${pj.version}`)
console.log(`  peerDeps     : ${JSON.stringify(pj.peerDependencies)}`)
console.log(`  bundle.patch : ${pj.dsh?.bundle?.patch}`)
console.log(`  client.inject: ${JSON.stringify(pj.dsh?.client?.inject)}`)

// The manifest's ONLY permitted change is the version field.
const pjOldText = prev.entries.find((e) => e.name === 'package/package.json').body.toString('utf8')
const pjNewText = cur.entries.find((e) => e.name === 'package/package.json').body.toString('utf8')
const pjOldLines = pjOldText.split('\n')
const pjNewLines = pjNewText.split('\n')
const pjDiffs = []
for (let i = 0; i < Math.max(pjOldLines.length, pjNewLines.length); i++) {
  if (pjOldLines[i] !== pjNewLines[i]) pjDiffs.push({ line: i + 1, old: pjOldLines[i], now: pjNewLines[i] })
}
console.log('\n=== package.json changes ===')
for (const d of pjDiffs) console.log(`  L${d.line}\n    - ${d.old}\n    + ${d.now}`)
const onlyVersionChanged = pjDiffs.length === 1 && /"version":\s*"0\.1\.2",/.test(pjDiffs[0].now)
console.log(`  only the version field changed: ${onlyVersionChanged ? 'YES' : 'NO'}`)

// Every non-client, non-manifest entry must be byte-identical to 0.1.1.
const changedNames = cur.entries
  .filter((e) => {
    const p = prev.entries.find((x) => x.name === e.name)
    return p && Buffer.compare(p.body, e.body) !== 0
  })
  .map((e) => e.name)
console.log(`\nchanged entries: ${JSON.stringify(changedNames)}`)
const expectedChanges = ['package/client.js', 'package/package.json']
const changeSetOk = JSON.stringify(changedNames) === JSON.stringify(expectedChanges)
console.log(`exactly the expected two entries changed: ${changeSetOk ? 'YES' : 'NO'}`)

const ok = sameLayout && changeSetOk && onlyVersionChanged && clientOk && pj.version === '0.1.2'

if (outDigest) {
  writeFileSync(outDigest, `${sha(tgz, 'sha256')}  dsh-session-delete-0.1.2.tgz\n`, 'utf8')
  console.log(`\nwrote digest file -> ${outDigest}`)
}
console.log(`\nRESULT: ${ok ? 'ALL CHECKS PASS' : 'CHECK FAILED'}`)
process.exit(ok ? 0 : 1)
