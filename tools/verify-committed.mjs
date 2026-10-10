// Verify live repo files byte-match the local versions that were committed.
//   node verify-committed.mjs <manifest.json>
// Manifest: [{ "repoPath": "README.md", "localPath": "C:/.../README.0.1.2.md" }]
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const H = { 'user-agent': 'dsh-verify', accept: 'application/vnd.github+json' }
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents`

const req = async (url, attempts = 4) => {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 40000)
      try { return await fetch(url, { headers: H, signal: ctl.signal }) } finally { clearTimeout(t) }
    } catch (e) { last = e; console.log(`  retry ${i}/${attempts} after ${e?.cause?.code ?? e.name}`); if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i)) }
  }
  throw last
}

const files = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let ok = true
for (const f of files) {
  const r = await req(`${API}/${f.repoPath}?ref=main&t=${Date.now()}`)
  if (!r.ok) { console.log(`HTTP ${r.status}  ${f.repoPath}`); ok = false; continue }
  const j = await r.json()
  const live = Buffer.from(j.content, 'base64')
  const local = readFileSync(f.localPath)
  const same = Buffer.compare(live, local) === 0
  if (!same) ok = false
  console.log(`${same ? 'MATCH' : 'DIFF '}  ${f.repoPath.padEnd(24)} live ${live.length}B sha256 ${createHash('sha256').update(live).digest('hex').slice(0, 16)}…`)
  console.log(`       ${' '.repeat(24)} local ${local.length}B sha256 ${createHash('sha256').update(local).digest('hex').slice(0, 16)}…  blob ${j.sha.slice(0, 12)}…`)
}
console.log(`\nRESULT: ${ok ? 'ALL LIVE FILES MATCH' : 'MISMATCH'}`)
process.exit(ok ? 0 : 1)
