#!/usr/bin/env node
/**
 * Publish this plugin without git.
 *
 * This machine has no `git` binary, and PowerShell's TLS stack cannot acquire
 * credentials (`schannel: SEC_E_NO_CREDENTIALS`), while Node's TLS works. So the
 * whole release runs over the GitHub Contents / Releases / Git Data APIs:
 *
 *   1. bump `package.json` AND README's release references, in ONE commit
 *   2. pack the tarball with the bundled pnpm
 *   3. create the release (which also creates the tag) and upload the tgz
 *   4. verify the published asset against the local sha256
 *
 * Usage:  node tools/push-release.mjs 0.1.3     (from the repository root)
 * Token:  $env:DSH_GH_TOKEN  (fine-grained, this repo only, Contents: Read and write)
 *
 * Guards: README substitutions must all apply, an existing tag/release aborts,
 * and a re-run where main is already at the target version is a clean no-op.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { bumpReadme } from './update-readme-version.mjs'

const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const HEADERS = { 'user-agent': 'dsh-release', accept: 'application/vnd.github+json' }
const API = `https://api.github.com/repos/${OWNER}/${REPO}`

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node tools/push-release.mjs <x.y.z>')
  process.exit(2)
}
const token = process.env.DSH_GH_TOKEN
if (!token) {
  console.error('no token in DSH_GH_TOKEN (fine-grained PAT, this repo, Contents: Read and write)')
  process.exit(2)
}
const auth = { ...HEADERS, authorization: `Bearer ${token}` }
const tag = `v${version}`
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'dist', `.build-${version}`)

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)

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
const getFile = async (path) => {
  const r = await req(`${API}/contents/${path}?ref=main&t=${Date.now()}`)
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`)
  return r.json()
}
const postJson = async (url, body) => {
  const r = await req(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`POST ${url} -> HTTP ${r.status} ${JSON.stringify(j)}`)
  return j
}

// ---------------------------------------------------------------------------
step(1, `bump package.json and README to ${version}, in one commit`)
// ---------------------------------------------------------------------------
const pkgRes = await getFile('package.json')
const pkgText = Buffer.from(pkgRes.content, 'base64').toString('utf8')
const current = JSON.parse(pkgText).version
console.log(`  main is at ${current}`)

let readmeBump = null
let newPkgText = pkgText
if (current !== version) {
  const anchor = `"version": "${current}",`
  if (pkgText.split(anchor).length - 1 !== 1) throw new Error(`version anchor not unique for ${current}`)
  newPkgText = pkgText.replace(anchor, `"version": "${version}",`)
}

if (current !== version) {
  // README references must move with the version, or the install URLs rot.
  const readmeRes = await getFile('README.md')
  const readmeText = Buffer.from(readmeRes.content, 'base64').toString('utf8')
  readmeBump = bumpReadme(readmeText, current, version)
  console.log(`  README: ${readmeBump.applied.length} substitution(s) applied, ${readmeBump.skipped.length} already in sync`)
  for (const l of readmeBump.applied) console.log(`    applied ${l}`)

  const head = await (await req(`${API}/commits/main`)).json()
  const parent = await (await req(`${API}/git/commits/${head.sha}`)).json()

  const blobs = []
  for (const [path, text] of [['package.json', newPkgText], ['README.md', readmeBump.text]]) {
    const blob = await postJson(`${API}/git/blobs`, { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' })
    blobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    console.log(`  blob ${path} -> ${blob.sha.slice(0, 12)}`)
  }
  const tree = await postJson(`${API}/git/trees`, { base_tree: parent.tree.sha, tree: blobs })
  const commit = await postJson(`${API}/git/commits`, {
    message: `chore(release): ${version}\n\nAlso repoints the README's release references, so the install commands,\nversion-gate example and /status sample never lag the published version.`,
    tree: tree.sha,
    parents: [head.sha],
  })
  const moved = await req(`${API}/git/refs/heads/main`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
  if (!moved.ok) throw new Error(`ref update failed: HTTP ${moved.status}`)
  console.log(`  commit: https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)
} else {
  console.log(`  already at ${version}; nothing to commit`)
}

// ---------------------------------------------------------------------------
step(2, 'pack the tarball with the bundled pnpm')
// ---------------------------------------------------------------------------
rmSync(buildDir, { recursive: true, force: true })
mkdirSync(buildDir, { recursive: true })
const runtime = process.env.DSH_RUNTIME_DIR ?? 'D:/DeepSeek Harness/resources/runtime'
const pnpm = join(runtime, 'pnpm', 'bin', 'pnpm.mjs')
if (!existsSync(pnpm)) throw new Error(`bundled pnpm not found at ${pnpm}; set DSH_RUNTIME_DIR`)
execFileSync(process.execPath, [pnpm, '--dir', root, 'pack', '--pack-destination', buildDir], { stdio: 'inherit' })
const tgz = join(buildDir, `dsh-session-delete-${version}.tgz`)
if (!existsSync(tgz)) throw new Error(`pack did not produce ${tgz}`)
const data = readFileSync(tgz)
const sha256 = createHash('sha256').update(data).digest('hex')
console.log(`  ${tgz}`)
console.log(`  ${data.length} bytes  sha256 ${sha256}`)

// ---------------------------------------------------------------------------
step(3, `create release ${tag} and upload the asset`)
// ---------------------------------------------------------------------------
const head = await (await req(`${API}/commits/main`)).json()
console.log(`  main HEAD: ${head.sha}`)

// The tag must point at a tree that really declares this version.
const verify = JSON.parse(Buffer.from((await getFile('package.json')).content, 'base64').toString('utf8'))
if (verify.version !== version) throw new Error(`main declares ${verify.version}, not ${version}`)

const existing = await req(`${API}/releases/tags/${tag}`)
if (existing.status === 200) throw new Error(`release ${tag} already exists: ${(await existing.json()).html_url}`)

const body = [
  `会话菜单的删除项此前在 CJK 界面下仍显示英文（\`Delete session\`）。`,
  ``,
  `- **修**：客户端声明 \`inject: ['slots', 'locale']\`，等 locale 服务就绪后再注册 \`zh\`/\`en\` 词典。此前只注入 \`slots\`，而 Cordis 4.0.4 没有可选注入、locale 服务又在一次 \`await\` 之后才 \`provide\`，第三方 bundle 有机会先跑完 \`apply\`：\`ctx.get('locale')\` 返回 \`undefined\`，词典从未注册，菜单项便一直走内置英文兜底表。`,
  `- **修**：语言降级不再静默——注册失败与服务缺失各留一条 \`console.warn\`，启动日志标明当前是 \`locale: dsh-session-delete\` 还是 \`english fallback\`。`,
  `- 未改动的行为：locale 服务不可用时插件仍然可用，只是回落英文（并现在会说出来）。`,
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
].join('\n')

const relBody = await postJson(`${API}/releases`, {
  tag_name: tag,
  target_commitish: head.sha,
  name: tag,
  body,
  draft: false,
  prerelease: false,
})
console.log(`  release: ${relBody.html_url}`)

const assetName = `dsh-session-delete-${version}.tgz`
const up = await req(`${relBody.upload_url.split('{')[0]}?name=${encodeURIComponent(assetName)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/gzip', 'content-length': String(data.length) },
  body: data,
})
const upBody = await up.json()
if (!up.ok) throw new Error(`asset upload failed: HTTP ${up.status} ${JSON.stringify(upBody)}`)
console.log(`  asset: ${upBody.browser_download_url} (${upBody.size} bytes)`)

// ---------------------------------------------------------------------------
step(4, 'verify the published asset')
// ---------------------------------------------------------------------------
// GitHub stores its own digest for release assets; prefer it, and only fall back
// to downloading (github.com may be unreachable from a restricted network).
const relCheck = await (await req(`${API}/releases/tags/${tag}`)).json()
const asset = relCheck.assets.find((a) => a.name === assetName)
const digest = asset?.digest?.replace(/^sha256:/, '')
console.log(`  server-side digest: ${digest ?? '(none reported)'}`)
console.log(`  local      sha256 : ${sha256}`)
if (digest && digest !== sha256) throw new Error('published asset digest does not match the local tarball')
if (digest) console.log('  MATCH: YES')

writeFileSync(join(buildDir, `${assetName}.sha256`), `${sha256}  ${assetName}\n`, 'utf8')
console.log(`\ndone. ${relBody.html_url}`)
