// Post-push verification: read the file back with a cache-busting query and prove
// the live bytes equal the payload that passed local functional verification.
import { readFileSync, writeFileSync } from 'node:fs'

const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const dir = process.argv[2] ?? '.'
const HEADERS = { 'user-agent': 'dsh-locale-fix', accept: 'application/vnd.github+json' }

// Local source of truth: the file that was tested and then base64-encoded.
const tested = readFileSync(`${dir}/client.fixed.js`)
const expectedSha = readFileSync(`${dir}/client.js.sha256`, 'utf8').trim()

const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/client.js?ref=main&t=${Date.now()}`
const res = await fetch(url, { headers: HEADERS })
if (!res.ok) { console.error(`GET failed: HTTP ${res.status}`); process.exit(1) }
const body = await res.json()
const live = Buffer.from(body.content, 'base64')
writeFileSync(`${dir}/client.live.js`, live)

const { createHash } = await import('node:crypto')
const liveSha = createHash('sha256').update(live).digest('hex')

console.log(`live size      : ${live.length}`)
console.log(`live blob sha  : ${body.sha}`)
console.log(`live sha256    : ${liveSha}`)
console.log(`expected sha256: ${expectedSha}`)
console.log(`LIVE == TESTED : ${Buffer.compare(live, tested) === 0 && liveSha === expectedSha ? 'YES' : 'NO'}`)
process.exit(Buffer.compare(live, tested) === 0 && liveSha === expectedSha ? 0 : 1)
