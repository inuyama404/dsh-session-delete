// Create the vX.Y.Z release, tag it, and upload the packed tarball asset.
// Tag creation is part of the release POST (target_commitish), so no git binary
// is needed; the binary asset goes to uploads.github.com, not the Contents API.
//   node create-release.mjs <version> <tarballPath> <sha256>
// Requires DSH_GH_TOKEN with Contents: Read and write.
import { readFileSync } from 'node:fs'

const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const HEADERS = { 'user-agent': 'dsh-release', accept: 'application/vnd.github+json' }

const [, , version, tarballPath, sha256] = process.argv
if (!version || !tarballPath || !sha256) {
  console.error('usage: node create-release.mjs <x.y.z> <tarballPath> <sha256>')
  process.exit(2)
}
const tag = `v${version}`
const token = process.env.DSH_GH_TOKEN
if (!token) { console.error('no token in DSH_GH_TOKEN'); process.exit(2) }
const auth = { ...HEADERS, authorization: `Bearer ${token}` }
const API = `https://api.github.com/repos/${OWNER}/${REPO}`

// Refuse to tag a commit whose package.json is not the released version: the tag
// must point at a tree that actually declares this version.
const c = await fetch(`${API}/contents/package.json?ref=main&t=${Date.now()}`, { headers: auth })
if (!c.ok) { console.error(`GET package.json: HTTP ${c.status}`); process.exit(1) }
const pj = JSON.parse(Buffer.from((await c.json()).content, 'base64').toString('utf8'))
console.log(`main package.json version : ${pj.version}`)
if (pj.version !== version) {
  console.error(`ABORT: main declares ${pj.version}, not ${version}. Bump the version first.`)
  process.exit(3)
}

const head = await (await fetch(`${API}/commits/main`, { headers: auth })).json()
console.log(`main HEAD                 : ${head.sha}`)

// Creating the release creates the tag when it does not exist yet.
const existing = await fetch(`${API}/releases/tags/${tag}`, { headers: auth })
if (existing.status === 200) {
  console.error(`ABORT: release ${tag} already exists: ${(await existing.json()).html_url}`)
  process.exit(4)
}

const body = [
  `CJK 界面下会话菜单里的删除项此前一直显示英文（\`Delete session\`）。`,
  ``,
  `- **修**：客户端声明 \`inject: ['slots', 'locale']\`，等到 locale 服务就绪后再注册 \`zh\`/en\` 词典。此前只注入 \`slots\`，而 Cordis 4.0.4 没有可选注入、locale 服务又在一次 \`await\` 之后才 \`provide\`，第三方 bundle 有机会先跑完 \`apply\`：\`ctx.get('locale')\` 返回 \`undefined\`，词典从未注册，菜单项于是一直走内置英文兜底表。`,
  `- **修**：语言降级不再静默——注册失败与服务缺失各留一条 \`console.warn\`，启动日志直接标明当前是 \`locale: dsh-session-delete\` 还是 \`english fallback\`。`,
  `- 未改动的行为：locale 服务不可用时仍可用，只是回落英文（并现在会说出来）。`,
  ``,
  `### 安装`,
  ``,
  '```powershell',
  `& "<DSH>\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add "https://github.com/${OWNER}/${REPO}/releases/download/${tag}/dsh-session-delete-${version}.tgz"`,
  '```',
  ``,
  `### 校验`,
  ``,
  '```',
  `${sha256}  dsh-session-delete-${version}.tgz`,
  '```',
  ``,
  `本版只改动两个文件：\`client.js\`（修复）与 \`package.json\`（版本号）。其余文件与 0.1.1 逐字节相同。`,
  ``,
  `> 已发布的 0.1.1 tarball 仍含该缺陷，装过 0.1.1 的人需要升级到本版。`,
].join('\n')

const rel = await fetch(`${API}/releases`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, target_commitish: head.sha, name: tag, body, draft: false, prerelease: false }),
})
const relBody = await rel.json()
if (!rel.ok) { console.error(`release POST failed: HTTP ${rel.status}\n${JSON.stringify(relBody, null, 2)}`); process.exit(1) }
console.log(`release                   : ${relBody.html_url}`)

// Upload the tarball as a release asset.
const name = `dsh-session-delete-${version}.tgz`
const data = readFileSync(tarballPath)
const up = await fetch(`${relBody.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, {
  method: 'POST',
  headers: { ...HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/gzip', 'content-length': String(data.length) },
  body: data,
})
const upBody = await up.json()
if (!up.ok) { console.error(`asset upload failed: HTTP ${up.status}\n${JSON.stringify(upBody, null, 2)}`); process.exit(1) }
console.log(`asset                     : ${upBody.browser_download_url}`)
console.log(`asset size                : ${upBody.size}`)

// Confirm the published asset is byte-identical to the local artifact.
const { createHash } = await import('node:crypto')
const back = Buffer.from(await (await fetch(upBody.browser_download_url, { headers: { 'user-agent': 'dsh-release' } })).arrayBuffer())
const got = createHash('sha256').update(back).digest('hex')
console.log(`published sha256          : ${got}`)
console.log(`expected sha256           : ${sha256}`)
console.log(`ASSET ROUND-TRIP          : ${got === sha256 ? 'YES' : 'NO'}`)
process.exit(got === sha256 ? 0 : 1)
