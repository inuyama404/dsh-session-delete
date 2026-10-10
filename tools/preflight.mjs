// Read-only preflight: confirm the token identity and that it can write this repo.
// Prints no secrets. Exit 1 when the token cannot write.
const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const HEADERS = { 'user-agent': 'dsh-locale-fix', accept: 'application/vnd.github+json' }

const token = process.env.DSH_GH_TOKEN
if (!token) { console.error('no token in DSH_GH_TOKEN'); process.exit(2) }
console.log(`token shape   : ${token.slice(0, 11)}… (length ${token.length})`)

const auth = { ...HEADERS, authorization: `Bearer ${token}` }

const me = await fetch('https://api.github.com/user', { headers: auth })
console.log(`GET /user     : HTTP ${me.status}`)
if (me.ok) {
  const u = await me.json()
  console.log(`  login       : ${u.login}`)
  console.log(`  matches owner: ${u.login.toLowerCase() === OWNER.toLowerCase() ? 'yes' : 'NO — token belongs to a different account'}`)
} else {
  console.log('  (token rejected or lacks user scope — continuing to the repo check)')
}

const repo = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: auth })
console.log(`GET /repo     : HTTP ${repo.status}`)
if (!repo.ok) { console.error('cannot read the repo with this token'); process.exit(1) }
const r = await repo.json()
console.log(`  permissions.push   : ${r.permissions?.push}`)
console.log(`  permissions.pull   : ${r.permissions?.pull}`)
console.log(`  default_branch     : ${r.default_branch}`)
console.log(`  visibility         : ${r.visibility}`)

const file = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/client.js`, { headers: auth })
if (!file.ok) { console.error(`GET contents: HTTP ${file.status}`); process.exit(1) }
const f = await file.json()
console.log(`  client.js sha      : ${f.sha}`)
console.log(`  client.js size     : ${f.size}`)

const canWrite = r.permissions?.push === true
console.log(`\nWRITE ACCESS: ${canWrite ? 'YES' : 'NO'}`)
process.exit(canWrite ? 0 : 1)
