// Commit several files in ONE commit through the Git Data API (no git binary).
// Builds blobs -> a tree based on the current main tree -> a commit -> updates the
// main ref. Reads the file list from a JSON manifest to keep paths/data explicit.
//   node commit-files.mjs <message> <manifest.json>
// Manifest: [{ "repoPath": "README.md", "localPath": "C:/.../README.md" }]
import { readFileSync } from 'node:fs'

const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const HEADERS = { 'user-agent': 'dsh-release', accept: 'application/vnd.github+json' }
const API = `https://api.github.com/repos/${OWNER}/${REPO}`

const [, , message, manifestPath] = process.argv
const token = process.env.DSH_GH_TOKEN
if (!message || !manifestPath) { console.error('usage: node commit-files.mjs <message> <manifest.json>'); process.exit(2) }
if (!token) { console.error('no token in DSH_GH_TOKEN'); process.exit(2) }
const auth = { ...HEADERS, authorization: `Bearer ${token}` }
const files = JSON.parse(readFileSync(manifestPath, 'utf8'))

// This link to api.github.com is slow and occasionally times out (undici's default
// is 10s and it does not retry), so give every call a longer budget and retry.
const req = async (url, init = {}, attempts = 4) => {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 40000)
      try {
        return await fetch(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) }, signal: ctl.signal })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      last = error
      const code = error?.cause?.code ?? error?.name ?? error?.message
      console.log(`  retry ${i}/${attempts} after ${code}`)
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i))
    }
  }
  throw last
}

const post = async (url, body) => {
  const r = await req(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`POST ${url} -> HTTP ${r.status} ${JSON.stringify(j)}`)
  return j
}
const get = async (url) => {
  const r = await req(url)
  const j = await r.json()
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status} ${JSON.stringify(j)}`)
  return j
}

// 1. Current main tip and its tree.
const ref = await get(`${API}/git/ref/heads/main`)
const parentSha = ref.object.sha
const parent = await get(`${API}/git/commits/${parentSha}`)
console.log(`parent commit : ${parentSha}`)
console.log(`parent tree   : ${parent.tree.sha}`)

// 2. One blob per file.
const tree = []
for (const f of files) {
  const data = readFileSync(f.localPath)
  const blob = await post(`${API}/git/blobs`, { content: data.toString('base64'), encoding: 'base64' })
  console.log(`blob          : ${f.repoPath.padEnd(24)} ${data.length} bytes -> ${blob.sha}`)
  tree.push({ path: f.repoPath, mode: '100644', type: 'blob', sha: blob.sha })
}

// 3. New tree on top of the existing one (base_tree keeps every other path).
const newTree = await post(`${API}/git/trees`, { base_tree: parent.tree.sha, tree })
console.log(`new tree      : ${newTree.sha}`)

// 4. Commit, then move the branch.
const commit = await post(`${API}/git/commits`, { message, tree: newTree.sha, parents: [parentSha] })
console.log(`commit        : ${commit.sha}`)
console.log(`url           : https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)

const updated = await req(`${API}/git/refs/heads/main`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sha: commit.sha, force: false }),
})
const updatedBody = await updated.json()
if (!updated.ok) throw new Error(`ref update failed: HTTP ${updated.status} ${JSON.stringify(updatedBody)}`)
console.log(`main          : ${updatedBody.object.sha}`)
