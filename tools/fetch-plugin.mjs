// Fetch the dsh-session-delete v0.1.1 release tarball via the bundled Node runtime.
// Node's TLS stack works here; PowerShell's schannel does not (SEC_E_NO_CREDENTIALS).
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const URL =
  'https://github.com/inuyama404/dsh-session-delete/releases/download/v0.1.1/dsh-session-delete-0.1.1.tgz'
const EXPECTED =
  'a56dabefa523af8a140c44031a0d837ef920c59c534d925b82f76728ce2a29f2'
const OUT = process.argv[2]

const res = await fetch(URL, { redirect: 'follow', headers: { 'user-agent': 'dsh-plugin-installer' } })
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status} ${res.statusText}`)
  process.exit(1)
}
const buf = Buffer.from(await res.arrayBuffer())
const sha = createHash('sha256').update(buf).digest('hex')

await writeFile(OUT, buf)
console.log(`saved   : ${OUT}`)
console.log(`bytes   : ${buf.length}`)
console.log(`sha256  : ${sha}`)
console.log(`expected: ${EXPECTED}`)
console.log(sha === EXPECTED ? 'DIGEST_OK' : 'DIGEST_MISMATCH')
process.exit(sha === EXPECTED ? 0 : 1)
