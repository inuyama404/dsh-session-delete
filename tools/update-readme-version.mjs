// Point README.md's release references at a new version.
//   node tools/update-readme-version.mjs <oldVersion> <newVersion> <inPath> <outPath>
// Each substitution is explicit and must match exactly once, so an upstream README
// edit can never be silently clobbered. The console-diagnostic rewrite is part of
// the 0.1.2 locale fix and is applied only when moving off 0.1.1.
import { readFileSync, writeFileSync } from 'node:fs'

const [, , oldVersion, newVersion, inPath, outPath] = process.argv
if (!/^\d+\.\d+\.\d+$/.test(oldVersion ?? '') || !/^\d+\.\d+\.\d+$/.test(newVersion ?? '')) {
  console.error('usage: node tools/update-readme-version.mjs <oldVersion> <newVersion> <inPath> <outPath>')
  process.exit(2)
}
let text = readFileSync(inPath, 'utf8')
let out = text
let ok = true

function sub(label, from, to, { optional = false } = {}) {
  const n = out.split(from).length - 1
  const status = n === 1 ? 'ok  ' : n === 0 && optional ? 'skip' : 'FAIL'
  console.log(`${status} (${n}) ${label}`)
  if (n === 1) out = out.replace(from, to)
  else if (!(n === 0 && optional)) ok = false
}

// ---- 1. version references ---------------------------------------------------
sub('dist tgz', `\`dist\\dsh-session-delete-${oldVersion}.tgz\``, `\`dist\\dsh-session-delete-${newVersion}.tgz\``)
sub('local tgz install', `add "D:\\路径\\dsh-session-delete-${oldVersion}.tgz"`, `add "D:\\路径\\dsh-session-delete-${newVersion}.tgz"`)
sub('release tag mention', `（v${oldVersion} release 附 tgz）`, `（v${newVersion} release 附 tgz）`)
sub('C1 github: spec', `dsh-session-delete#v${oldVersion}`, `dsh-session-delete#v${newVersion}`)
sub('C2 release url', `releases/download/v${oldVersion}/dsh-session-delete-${oldVersion}.tgz`, `releases/download/v${newVersion}/dsh-session-delete-${newVersion}.tgz`)
sub('C3 codeload url', `tar.gz/refs/tags/v${oldVersion}`, `tar.gz/refs/tags/v${newVersion}`)
sub('allow-version example', `allow-version dsh-session-delete@${oldVersion}`, `allow-version dsh-session-delete@${newVersion}`)
sub('status example output', `"plugin":"dsh-session-delete","version":"${oldVersion}"`, `"plugin":"dsh-session-delete","version":"${newVersion}"`)

// ---- 2. console diagnostic added by the 0.1.2 locale fix --------------------
// Only relevant once, when moving off 0.1.1; optional so later bumps still work.
// NB: the original line ends with a FULL-WIDTH semicolon (U+FF1B), not ';'.
if (oldVersion === '0.1.1') {
  sub('console diagnostic line',
    '   `[dsh-session-delete] menu entry registered in sidebar.workspaces.session.menu.item`\uFF1B',
    `   \`[dsh-session-delete] menu entry registered in sidebar.workspaces.session.menu.item (locale: dsh-session-delete)\`;
   括号里若是 \`(locale: english fallback)\`，说明没拿到 \`locale\` 服务，菜单项会退回内置英文文案（同时会打印一条 \`console.warn\` 说明原因）。`)
}

// ---- 3. truthful publish instructions (replaces a non-existent script) -------
sub('publish section',
  '**改完代码重新发布**：`publish-to-github.ps1`（工作区根目录）是幂等的——它读 token、必要时建仓库、按文件内容生成提交（内容没变就不提交）、发 release 并附 tgz、最后删除 token 文件。重新生成一个新 token 存到 `~/.dsh/gh-token.txt` 再跑一次即可。',
  [
    '**改完代码重新发布**：走 GitHub Contents / Releases API，**不需要 `git`**。这台机器没有 `git`，PowerShell 的 TLS 栈也取不到凭据（`schannel: SEC_E_NO_CREDENTIALS`），而 Node 的 TLS 正常，所以 0.1.2 就是这么发的。',
    '',
    '```powershell',
    '# 1) 改 package.json 的 version 并提交    2) 打包    3) 建 release 并把 tgz 作为附件上传',
    '& "D:\\DeepSeek Harness\\resources\\runtime\\bin\\node.cmd" tools/push-release.mjs 0.1.3',
    '```',
    '',
    'token 从 `$env:DSH_GH_TOKEN` 读取（细粒度、只授权本仓库的 Contents: Read and write 即可），用完请撤销。三条防呆：提交前核对 `package.json` 里确实是目标版本、已存在的 tag 直接拒绝、上传后回读附件比对 SHA-256。tag 由 release 创建时一并生成，因此本地不需要 git 仓库。',
  ].join('\n'))

// ---- 4. name the install path that works on a clean machine -----------------
sub('C2 recommended', '**方式 C2（不需要 Git，推荐给干净的机器）**——直接用 release 附件 URL：',
  '**方式 C2（不需要 Git，新机器首选）**——直接用 release 附件 URL，一步到位：')

sub('C summary', 'C2 / C3 都在一次性 profile 里实测通过（装成真实目录、bundle 自动进 `dsh.profile.bundles`、装好的副本自检 32 项全过）；C1 在**没有 git** 的机器上实测失败（报 `git ls-remote` 找不到命令），装了 Git 的机器可用。本插件没有 `prepare` 或任何构建脚本，不会触发 pnpm 的构建脚本审批。',
  '**装到干净的机器上请用 C2**：一步到位，且不依赖 `git`。A 需要先拿到 tgz 文件，B 是 `link:` 安装（目录必须一直留着），C1 需要对方装了 Git（本机没有 git，实测报 `git ls-remote` 找不到命令），C3 拉的是 tag 归档而非发布附件。C2 / C3 都在一次性 profile 里实测通过（装成真实目录、bundle 自动进 `dsh.profile.bundles`、装好的副本自检 32 项全过）。本插件没有 `prepare` 或任何构建脚本，不会触发 pnpm 的构建脚本审批。')

if (ok) {
  const kept = out.split('0.1.0').length - 1
  console.log(`\n0.1.0 kept: ${kept} (historical, must stay 1)`)
  console.log(`bytes: ${text.length} -> ${out.length}`)
  writeFileSync(outPath, out, 'utf8')
  console.log(`wrote ${outPath}`)
} else {
  console.error('\nABORTED: an anchor did not match exactly once; nothing written.')
  process.exit(1)
}
