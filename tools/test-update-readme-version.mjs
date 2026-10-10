// Exercise bumpReadme against the README that is actually on main.
//
//   node tools/test-update-readme-version.mjs [currentReadme] [preFixReadme]
//
// Defaults target the repository layout, so running it from the repo root with no
// arguments works: the current README, plus the committed 0.1.1 fixture.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { bumpReadme } from './update-readme-version.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(process.argv[2] ?? join(here, '..', 'README.md'), 'utf8')
const count = (t, s) => t.split(s).length - 1
let pass = true
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
  if (!cond) pass = false
}

console.log(`README on main: ${readme.length} bytes`)
console.log(`  0.1.2 occurrences: ${count(readme, '0.1.2')}  (line 107 holds two: URL path + filename)`)
console.log(`  0.1.1 occurrences: ${count(readme, '0.1.1')}\n`)

// 1. the real forward case the release flow will hit: 0.1.2 -> 0.1.3
const r1 = bumpReadme(readme, '0.1.2', '0.1.3')
console.log('--- 0.1.2 -> 0.1.3 ---')
for (const l of r1.applied) console.log(`  applied ${l}`)
const oldLeft = count(r1.text, '0.1.2')
check('changed', r1.changed)
check('9 substitutions applied', r1.applied.length === 9, `applied ${r1.applied.length}`)
check('no stale 0.1.2 left', oldLeft === 0, `found ${oldLeft}`)
check('install url updated', r1.text.includes('releases/download/v0.1.3/dsh-session-delete-0.1.3.tgz'))
check('dist tgz updated', r1.text.includes('`dist\\dsh-session-delete-0.1.3.tgz`'))
check('C1 spec updated', r1.text.includes('dsh-session-delete#v0.1.3'))
check('C3 codeload updated', r1.text.includes('tar.gz/refs/tags/v0.1.3'))
check('allow-version updated', r1.text.includes('allow-version dsh-session-delete@0.1.3'))
check('status sample updated', r1.text.includes('"version":"0.1.3"'))
check('release-tag sentence updated', r1.text.includes('\uFF08v0.1.3 release \u9644 tgz\uFF09'))
check('0.1.0 history kept', count(r1.text, '0.1.0') === 1)
check('line count unchanged', readme.split('\n').length === r1.text.split('\n').length)
const exampleLine = r1.text.split('\n').find((l) => l.includes('push-release.mjs'))
check('publish example carries no stale version', /push-release\.mjs (?:\d+\.\d+\.\d+|x\.y\.z)/.test(exampleLine ?? ''),
  exampleLine?.trim().slice(0, 64))

// 2. idempotence: re-running with the same pair must be a no-op, not a failure
console.log('\n--- 0.1.3 -> 0.1.3 (re-run, must be a no-op) ---')
const r2 = bumpReadme(r1.text, '0.1.3', '0.1.3')
check('no change', r2.changed === false)
check('reported as skipped', r2.skipped.length > 0 && r2.skipped[0].includes('old === new'))
check('nothing applied', r2.applied.length === 0)

// 3. a stale/mismatched version must fail loudly rather than half-apply
console.log('\n--- 0.1.1 -> 0.1.3 against a README that says 0.1.2 (must throw) ---')
let threw = false
try { bumpReadme(readme, '0.1.1', '0.1.3') } catch (e) { threw = true; console.log(`  threw: ${e.failures.length} unmatched substitution(s)`) }
check('throws on mismatch', threw)

// 4. the historical 0.1.1 -> 0.1.2 path still works on the pre-fix README
// (the publish-section rewrite was part of that one-off change, not of version
// bumping, so it is not asserted here)
console.log('\n--- 0.1.1 -> 0.1.2 against the pre-fix README ---')
const old = readFileSync(process.argv[3] ?? join(here, 'fixtures', 'README.pre-0.1.2.md'), 'utf8')
const r4 = bumpReadme(old, '0.1.1', '0.1.2')
check('console diagnostic applied', r4.text.includes('(locale: dsh-session-delete)'))
check('console diagnostic not duplicated', count(r4.text, '(locale: dsh-session-delete)') === 1)
check('no stale 0.1.1 left', count(r4.text, '0.1.1') === 0, `found ${count(r4.text, '0.1.1')}`)

// 5. the publish example must not hard-code a version that only works for patch bumps
console.log('\n--- publish example version-agnostic ---')
check('example uses a placeholder, not a version', count(r1.text, 'push-release.mjs x.y.z') === 1,
  r1.text.split('\n').find((l) => l.includes('push-release.mjs'))?.trim().slice(0, 64))

console.log(`\nRESULT: ${pass ? 'ALL PASS' : 'FAILURES PRESENT'}`)
process.exit(pass ? 0 : 1)
