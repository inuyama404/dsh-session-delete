// Tests for buildReleaseBody: the function that replaced a hard-coded release
// description which once shipped the wrong version's notes.
import assert from 'node:assert/strict'
import { buildReleaseBody } from './release-notes.mjs'

const base = {
  version: '9.9.9',
  sha256: 'a'.repeat(64),
  owner: 'inuyama404',
  repo: 'dsh-session-delete',
  tag: 'v9.9.9',
}

const results = []
const test = (name, fn) => {
  try {
    fn()
    results.push(true)
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`FAIL  ${name}\n        ${error.message}`)
  }
}

test('generated body names the version and the digest', () => {
  const body = buildReleaseBody(base)
  assert.ok(body.includes('v9.9.9'))
  assert.ok(body.includes('a'.repeat(64)))
  assert.ok(body.includes('releases/download/v9.9.9/dsh-session-delete-9.9.9.tgz'))
})

test('generated body carries no stale version', () => {
  const body = buildReleaseBody(base)
  for (const stale of ['0.1.1', '0.1.2', '0.2.0']) assert.ok(!body.includes(stale), `leaked ${stale}`)
})

test('generated body carries no pasted-in changelog', () => {
  const body = buildReleaseBody(base)
  assert.ok(!body.includes('locale 服务'), 'must not contain the 0.1.2 notes')
  assert.ok(!body.includes('Delete session'), 'must not contain the 0.1.2 notes')
})

test('notes file is used verbatim and gets the sections appended', () => {
  const body = buildReleaseBody({ ...base, notes: '# 我的说明\n\n- 一条变更\n' })
  assert.ok(body.startsWith('# 我的说明'))
  assert.ok(body.includes('- 一条变更'))
  assert.ok(body.includes('### 安装'))
  assert.ok(body.includes('### 校验'))
})

test('--no-append publishes the notes exactly as written', () => {
  const notes = '# 只发说明\n'
  const body = buildReleaseBody({ ...base, notes, appendSections: false })
  assert.equal(body, notes.trim())
})

test('blank or missing notes fall back to the generated body', () => {
  for (const notes of [null, undefined, '', '   \n']) {
    const body = buildReleaseBody({ ...base, notes })
    assert.ok(body.includes('releases/download/v9.9.9/'), JSON.stringify(notes))
  }
})

test('every URL in the body points at this tag', () => {
  const body = buildReleaseBody({ ...base, notes: '说明' })
  for (const m of body.matchAll(/https:\/\/github\.com\/[^\s"]+/g)) {
    assert.ok(m[0].includes('/v9.9.9/') || m[0].endsWith('/blob/main/README.md'), m[0])
  }
})

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
