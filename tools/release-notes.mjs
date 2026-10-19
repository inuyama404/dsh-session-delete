/**
 * Build a release description.
 *
 * Extracted from tools/push-release.mjs after a real mistake: that script shipped
 * the 0.1.2 notes inside the 0.2.0 release, because the text was hard-coded. The
 * body is now either a maintainer-written RELEASE_NOTES.md or a generated summary;
 * neither can describe the wrong version, because both interpolate the version.
 *
 * @param options.version - the version being released, e.g. `0.2.0`.
 * @param options.sha256 - the tarball digest printed into the verify section.
 * @param options.notes - contents of RELEASE_NOTES.md, or null when absent.
 * @param options.owner - repository owner.
 * @param options.repo - repository name.
 * @param options.tag - the release tag, e.g. `v0.2.0`.
 * @param options.appendSections - append install/verify blocks (default true).
 * @returns the release body.
 */
export function buildReleaseBody({ version, sha256, notes = null, owner, repo, tag, appendSections = true }) {
  const installBlock = [
    '### 安装',
    '',
    '```powershell',
    `& "<DSH>\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add "https://github.com/${owner}/${repo}/releases/download/${tag}/dsh-session-delete-${version}.tgz"`,
    '```',
    '',
    '### 校验',
    '',
    '```',
    `${sha256}  dsh-session-delete-${version}.tgz`,
    '```',
  ].join('\n')

  const trimmed = typeof notes === 'string' ? notes.trim() : ''
  if (trimmed !== '' && !appendSections) return trimmed
  if (trimmed !== '') return `${trimmed}\n\n${installBlock}`

  return [
    `v${version}`,
    '',
    `变更内容见本版本的提交记录与 README：<https://github.com/${owner}/${repo}/blob/main/README.md>。`,
    '',
    installBlock,
  ].join('\n')
}
