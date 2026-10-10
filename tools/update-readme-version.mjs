// Point README.md's release references at a new version.
//
// Used two ways:
//   CLI     node tools/update-readme-version.mjs <old> <new> <inPath> <outPath>
//   import  bumpReadme(text, oldVersion, newVersion) -> { text, changed, skipped }
//
// Every substitution must match exactly once. Each is tolerant of the README
// already naming the NEW version (that means the release ran before and left the
// README in sync), which keeps a re-run from failing or committing an empty
// change; a version that is neither old nor new is a hard error, so a silent
// mismatch can never slip through.
import { readFileSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function bumpReadme(text, oldVersion, newVersion) {
  // Re-running with the same pair is a genuine no-op, not "everything applied".
  if (oldVersion === newVersion) {
    return { text, changed: false, applied: [], skipped: ['all (old === new)'], failures: [] }
  }

  let out = text
  const failures = []
  const applied = []
  const skipped = []

  const sub = (label, from, to, { optional = false } = {}) => {
    const already = out.split(to).length - 1
    const hits = out.split(from).length - 1
    if (hits === 1) {
      out = out.replace(from, to)
      applied.push(label)
      return
    }
    if (hits === 0 && already >= 1) {
      skipped.push(label) // already points at the target version
      return
    }
    if (hits === 0 && optional) {
      skipped.push(`${label} (absent)`)
      return
    }
    failures.push(`${label}: expected exactly 1 occurrence of ${JSON.stringify(from)}, found ${hits}`)
  }

  // ---- version references ---------------------------------------------------
  sub('dist tgz', `\`dist\\dsh-session-delete-${oldVersion}.tgz\``, `\`dist\\dsh-session-delete-${newVersion}.tgz\``)
  sub('local tgz install', `add "D:\\路径\\dsh-session-delete-${oldVersion}.tgz"`, `add "D:\\路径\\dsh-session-delete-${newVersion}.tgz"`)
  sub('release tag mention', `（v${oldVersion} release 附 tgz）`, `（v${newVersion} release 附 tgz）`)
  sub('C1 github: spec', `dsh-session-delete#v${oldVersion}`, `dsh-session-delete#v${newVersion}`)
  sub('C2 release url', `releases/download/v${oldVersion}/dsh-session-delete-${oldVersion}.tgz`, `releases/download/v${newVersion}/dsh-session-delete-${newVersion}.tgz`)
  sub('C3 codeload url', `tar.gz/refs/tags/v${oldVersion}`, `tar.gz/refs/tags/v${newVersion}`)
  sub('allow-version example', `allow-version dsh-session-delete@${oldVersion}`, `allow-version dsh-session-delete@${newVersion}`)
  sub('status example output', `"plugin":"dsh-session-delete","version":"${oldVersion}"`, `"plugin":"dsh-session-delete","version":"${newVersion}"`)
  // The publish paragraph names no version after the 0.1.2 rewrite; drop the
  // stale one left by an older README so it cannot go out of date again. Absent
  // from pre-0.1.2 READMEs, so optional.
  sub('publish prose version', `，而 Node 的 TLS 正常，所以 ${oldVersion} 就是这么发的。`, '，而 Node 的 TLS 正常；本插件的发布流程就是这么跑的。', { optional: true })
  // The publish example must not name a concrete next version (that only works
  // for patch bumps), so it uses a placeholder.
  sub('publish example version', `tools/push-release.mjs ${oldVersion}`, 'tools/push-release.mjs x.y.z', { optional: true })

  // ---- console diagnostic added by the 0.1.2 locale fix --------------------
  // Only relevant once, when moving off 0.1.1. Historical 0.1.0 references are
  // deliberately left alone: they describe an older running process.
  if (oldVersion === '0.1.1') {
    sub('console diagnostic line',
      '   `[dsh-session-delete] menu entry registered in sidebar.workspaces.session.menu.item`\uFF1B',
      `   \`[dsh-session-delete] menu entry registered in sidebar.workspaces.session.menu.item (locale: dsh-session-delete)\`;
   括号里若是 \`(locale: english fallback)\`，说明没拿到 \`locale\` 服务，菜单项会退回内置英文文案（同时会打印一条 \`console.warn\` 说明原因）。`)
  }

  if (failures.length > 0) {
    const error = new Error(`README version bump failed:\n  - ${failures.join('\n  - ')}`)
    error.failures = failures
    throw error
  }
  return { text: out, changed: out !== text, applied, skipped }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isCli = (() => {
  if (process.argv[1] === undefined) return false
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href }
  catch { return false }
})()

if (isCli) {
  const [, , oldVersion, newVersion, inPath, outPath] = process.argv
  if (!/^\d+\.\d+\.\d+$/.test(oldVersion ?? '') || !/^\d+\.\d+\.\d+$/.test(newVersion ?? '')) {
    console.error('usage: node tools/update-readme-version.mjs <old> <new> <inPath> <outPath>')
    process.exit(2)
  }
  const text = readFileSync(inPath, 'utf8')
  let result
  try {
    result = bumpReadme(text, oldVersion, newVersion)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
  for (const label of result.applied) console.log(`ok    applied  ${label}`)
  for (const label of result.skipped) console.log(`ok    in sync  ${label}`)
  const kept = result.text.split('0.1.0').length - 1
  console.log(`\n0.1.0 kept: ${kept} (historical, must stay 1)`)
  console.log(`bytes: ${text.length} -> ${result.text.length}`)
  if (outPath) { writeFileSync(outPath, result.text, 'utf8'); console.log(`wrote ${outPath}`) }
}
