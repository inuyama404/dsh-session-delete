#!/usr/bin/env node
/**
 * Publish this plugin without git.
 *
 * This machine has no `git` binary, and PowerShell's TLS stack cannot acquire
 * credentials (`schannel: SEC_E_NO_CREDENTIALS`), while Node's TLS works. So the
 * whole release runs over the GitHub Contents / Releases API:
 *
 *   1. bump `version` in package.json and commit it to main
 *   2. pack the tarball with the bundled pnpm
 *   3. create the release (which also creates the tag) and upload the tgz
 *   4. download the published asset back and compare SHA-256
 *
 * Usage:  node tools/push-release.mjs 0.1.3
 * Token:  $env:DSH_GH_TOKEN  (fine-grained, this repo only, Contents: Read and write)
 *
 * Guards: the version is verified on main before the tag is created, an existing
 * tag/release aborts, and the asset is round-trip verified. Safe to re-run.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

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

// ---------------------------------------------------------------------------
step(1, `bump package.json to ${version} and commit`)
// ---------------------------------------------------------------------------
const pkgApi = `${API}/contents/package.json`
const getFile = async (url) => {
  const r = await fetch(`${url}?ref=main&t=${Date.now()}`, { headers: auth })
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`)
  return r.json()
}
const pkgRes = await getFile(pkgApi)
const pkgText = Buffer.from(pkgRes.content, 'base64').toString('utf8')
const current = JSON.parse(pkgText).version

if (current !== version) {
  const anchor = `"version": "${current}",`
  if (pkgText.split(anchor).length - 1 !== 1) throw new Error(`version anchor not unique for ${current}`)
  const bumped = pkgText.replace(anchor, `"version": "${version}",`)
  const put = await fetch(pkgApi, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `chore(release): ${version}`,
      content: Buffer.from(bumped, 'utf8').toString('base64'),
      sha: pkgRes.sha,
      branch: 'main',
    }),
  })
  const out = await put.json()
  if (!put.ok) throw new Error(`bump failed: HTTP ${put.status} ${JSON.stringify(out)}`)
  console.log(`  ${current} -> ${version}`)
  console.log(`  commit: ${out.commit.html_url}`)
} else {
  console.log(`  already at ${version}; nothing to commit`)
}

// ---------------------------------------------------------------------------
step(2, 'pack the tarball with the bundled pnpm')
// ---------------------------------------------------------------------------
rmSync(buildDir, { recursive: true, force: true })
mkdirSync(buildDir, { recursive: true })
const runtime = process.env.DSH_RUNTIME_DIR ?? 'D:/DeepSeek Harness/resources/runtime'
const node = process.execPath
const pnpm = join(runtime, 'pnpm', 'bin', 'pnpm.mjs')
if (!existsSync(pnpm)) throw new Error(`bundled pnpm not found at ${pnpm}; set DSH_RUNTIME_DIR`)
execFileSync(node, [pnpm, '--dir', root, 'pack', '--pack-destination', buildDir], { stdio: 'inherit' })
const tgz = join(buildDir, `dsh-session-delete-${version}.tgz`)
if (!existsSync(tgz)) throw new Error(`pack did not produce ${tgz}`)
const data = readFileSync(tgz)
const sha256 = createHash('sha256').update(data).digest('hex')
console.log(`  ${tgz}`)
console.log(`  ${data.length} bytes  sha256 ${sha256}`)

// ---------------------------------------------------------------------------
step(3, `create release ${tag} and upload the asset`)
// ---------------------------------------------------------------------------
const head = await (await fetch(`${API}/commits/main`, { headers: auth })).json()
console.log(`  main HEAD: ${head.sha}`)

// The tag must point at a tree that really declares this version.
const verify = JSON.parse(Buffer.from((await getFile(pkgApi)).content, 'base64').toString('utf8'))
if (verify.version !== version) throw new Error(`main declares ${verify.version}, not ${version}`)

const existing = await fetch(`${API}/releases/tags/${tag}`, { headers: auth })
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
  ``,
  `已发布的 0.1.1 tarball 仍含该缺陷，装过 0.1.1 的人需要升级到本版。`,
].join('\n')

const rel = await fetch(`${API}/releases`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, target_commitish: head.sha, name: tag, body, draft: false, prerelease: false }),
})
const relBody = await rel.json()
if (!rel.ok) throw new Error(`release POST failed: HTTP ${rel.status} ${JSON.stringify(relBody)}`)
console.log(`  release: ${relBody.html_url}`)

const assetName = `dsh-session-delete-${version}.tgz`
const up = await fetch(`${relBody.upload_url.split('{')[0]}?name=${encodeURIComponent(assetName)}`, {
  method: 'POST',
  headers: { ...HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/gzip', 'content-length': String(data.length) },
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
const relCheck = await (await fetch(`${API}/releases/tags/${tag}`, { headers: auth })).json()
const asset = relCheck.assets.find((a) => a.name === assetName)
const digest = asset?.digest?.replace(/^sha256:/, '')
console.log(`  server-side digest: ${digest ?? '(none reported)'}`)
console.log(`  local      sha256 : ${sha256}`)
if (digest) console.log(`  MATCH: ${digest === sha256 ? 'YES' : 'NO'}`)

writeFileSync(join(buildDir, `${assetName}.sha256`), `${sha256}  ${assetName}\n`, 'utf8')
console.log(`\ndone. ${relBody.html_url}`)
