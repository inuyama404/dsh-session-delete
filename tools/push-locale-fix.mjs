// Push the locale fix to inuyama404/dsh-session-delete via the GitHub Contents API.
// Node's TLS works here (PowerShell/curl schannel does not), and the API route needs
// no git binary. The token is read from the environment and never printed.
//
//   node push-locale-fix.mjs fetch            -> save upstream client.js + record its sha
//   node push-locale-fix.mjs push             -> PUT the verified bytes back
//
// Requires: DSH_GH_TOKEN (or GH_TOKEN / GITHUB_TOKEN).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const OWNER = 'inuyama404'
const REPO = 'dsh-session-delete'
const PATH = 'client.js'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`
const mode = process.argv[2]
const dir = process.argv[3] ?? '.'
const HEADERS = { 'user-agent': 'dsh-locale-fix', accept: 'application/vnd.github+json' }

function token() {
  const t = process.env.DSH_GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!t) { console.error('no token in DSH_GH_TOKEN / GH_TOKEN / GITHUB_TOKEN'); process.exit(2) }
  return t
}

if (mode === 'fetch') {
  const res = await fetch(API, { headers: HEADERS })
  if (!res.ok) { console.error(`GET failed: HTTP ${res.status}`); process.exit(1) }
  const body = await res.json()
  const raw = Buffer.from(body.content, 'base64')
  writeFileSync(`${dir}/client.upstream.js`, raw)
  writeFileSync(`${dir}/client.upstream.meta.json`, JSON.stringify({ sha: body.sha, size: body.size }, null, 2))
  console.log(`fetched client.js: ${raw.length} bytes, sha=${body.sha}`)
} else if (mode === 'push') {
  if (!existsSync(`${dir}/client.fixed.b64`)) { console.error('client.fixed.b64 missing; run build-upstream-patch.mjs first'); process.exit(2) }
  const content = readFileSync(`${dir}/client.fixed.b64`, 'utf8').trim()
  const meta = JSON.parse(readFileSync(`${dir}/client.upstream.meta.json`, 'utf8'))

  // Refuse to clobber a newer upstream revision than the one we patched.
  const check = await fetch(API, { headers: HEADERS })
  const now = await check.json()
  if (now.sha !== meta.sha) {
    console.error(`ABORT: upstream ${PATH} changed since we fetched it.\n  patched against: ${meta.sha}\n  current        : ${now.sha}\nRe-fetch and re-verify before pushing.`)
    process.exit(3)
  }

  const res = await fetch(API, {
    method: 'PUT',
    headers: { ...HEADERS, authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: [
        'fix(client): wait for the locale service so the zh dictionary loads',
        '',
        "The client declared inject: ['slots'] and then probed ctx.get('locale') in a",
        'guard whose else-branch silently fell back to the built-in English table.',
        'Cordis 4.0.4 has no optional injection, and @deepseek-ai/dsh-client-locale',
        'provides the service after an await, so a third-party bundle can and does run',
        'apply first: the probed service is undefined, the dictionary is never',
        'registered, and the menu row stays in English on a zh UI.',
        '',
        "Declaring 'locale' in inject makes the loader wait for the provider, and the",
        'two added console.warn calls make a future degradation visible instead of',
        'silent. No behavior change when the locale service is unavailable beyond the',
        'warning that was previously swallowed.',
      ].join('\n'),
      content,
      sha: meta.sha,
      branch: 'main',
    }),
  })
  const out = await res.json()
  if (!res.ok) { console.error(`PUT failed: HTTP ${res.status}\n${JSON.stringify(out, null, 2)}`); process.exit(1) }
  console.log(`pushed: ${out.commit.html_url}`)
  console.log(`new blob sha: ${out.content.sha}`)
} else {
  console.error('usage: node push-locale-fix.mjs fetch|push [dir]')
  process.exit(2)
}
