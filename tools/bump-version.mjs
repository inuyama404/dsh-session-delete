// Bump package.json's version field on main via the GitHub Contents API.
// Only that one line changes; formatting stays byte-stable.
//   node bump-version.mjs <newVersion>
// Requires DSH_GH_TOKEN with Contents: Read and write.
const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const FILE = 'package.json'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`
const HEADERS = { 'user-agent': 'dsh-release', accept: 'application/vnd.github+json' }

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) { console.error('usage: node bump-version.mjs <x.y.z>'); process.exit(2) }
const token = process.env.DSH_GH_TOKEN
if (!token) { console.error('no token in DSH_GH_TOKEN'); process.exit(2) }

const auth = { ...HEADERS, authorization: `Bearer ${token}` }
const res = await fetch(`${API}?ref=main&t=${Date.now()}`, { headers: auth })
if (!res.ok) { console.error(`GET failed: HTTP ${res.status}`); process.exit(1) }
const body = await res.json()
const text = Buffer.from(body.content, 'base64').toString('utf8')

const current = JSON.parse(text).version
const anchor = `"version": "${current}",`
if (text.split(anchor).length - 1 !== 1) { console.error(`FAIL: version anchor not unique for ${current}`); process.exit(1) }
if (current === version) { console.error(`already at ${version}; nothing to do`); process.exit(0) }

const bumped = text.replace(anchor, `"version": "${version}",`)
console.log(`version : ${current} -> ${version}`)
console.log(`bytes   : ${text.length} -> ${bumped.length}`)

const put = await fetch(API, {
  method: 'PUT',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    message: `chore(release): ${version}`,
    content: Buffer.from(bumped, 'utf8').toString('base64'),
    sha: body.sha,
    branch: 'main',
  }),
})
const out = await put.json()
if (!put.ok) { console.error(`PUT failed: HTTP ${put.status}\n${JSON.stringify(out, null, 2)}`); process.exit(1) }
console.log(`commit  : ${out.commit.html_url}`)
console.log(`commit sha: ${out.commit.sha}`)
