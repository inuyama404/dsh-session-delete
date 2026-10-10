# tools

这个目录是维护本插件时用到的脚本。它们都不是插件运行的一部分——`dsh plugin add` 只读包根目录的
`index.js` / `client.js` / `cordis.patch.yml` / `package.json`，`tools/` 不会被打进 tgz。

全部脚本用 **DSH 自带的 Node** 运行（`resources\runtime\bin\node.cmd`）；部分脚本会联网访问
`api.github.com`，所以需要一个 token。

## 为什么是这套工具

发布这件事在这台机器上有两个硬约束：

- **没有 `git`**：所以 `pnpm` 无法从 `github:` / `git+ssh:` 规格安装或解析 tag（实测报
  `git ls-remote` 找不到命令）。发布改走 GitHub **Contents / Releases API**。
- **PowerShell 的 TLS 取不到凭据**（`schannel: SEC_E_NO_CREDENTIALS`），而 **Node 的 TLS 正常**：
  所以联网脚本一律用 Node，别用 `curl.exe` / `Invoke-RestMethod`。

## 发布

| 脚本 | 作用 |
|---|---|
| `push-release.mjs <x.y.z>` | **一条命令发版**：改版本号并提交 → pnpm 打包 → 建 release（顺带建 tag）并上传附件 → 回读比对 SHA-256。从仓库根目录运行，读 `$env:DSH_GH_TOKEN`。 |
| `bump-version.mjs <x.y.z>` | 只改 `package.json` 的 version 并提交（`push-release.mjs` 的第 1 步，单独用也行）。 |
| `create-release.mjs <x.y.z> <tgz> <sha256>` | 只建 release 并上传附件（第 3 步）。 |
| `commit-files.mjs <message> <manifest.json>` | 用 Git Data API 把多个文件**一次性**提交（blob → tree → commit → 移动 main ref），支持一次提交多文件。 |
| `update-readme-version.mjs <old> <new> <in> <out>` | 把 README 里的发布版本引用整体改到新版本。每处替换都要求"恰好命中一次"，上游一动就会失败而不是误改。 |
| `preflight.mjs` | **只读**预检：确认 token 身份、以及它对本仓库有没有写权限（看 `permissions.push`）。 |

## 校验

| 脚本 | 作用 |
|---|---|
| `verify-tarball.mjs <新tgz> <对比tgz> <期望的client.js> [输出摘要文件]` | 校验打包产物：条目与旧版一致、只应改动的文件改动、包内 `client.js` 与期望逐字节相同、gzip 完整、并输出 SHA-256/512。**自己解析 tar**，因为沙箱里 Node 无法 `spawnSync` 外部进程。 |
| `verify-committed.mjs <manifest.json>` | 回读仓库文件，与本地版本逐字节比对（证明"提交上去的就是验证过的"）。 |
| `verify-live.mjs <dir>` | 回读 `client.js` 与 `client.fixed.js` 比对（发布修复后确认线上内容）。 |
| `verify-plugin-patch.mjs <client.js>` | 用 mock 的 cordis + React 跑插件客户端半侧，验证 `inject`、词典注册、slot 的 `locale` 选项，以及拿不到 locale 时的降级。 |
| `diff-text.mjs <a> <b>` | 行级 diff（LCS），用于提交前审阅。 |

## 抓取与打包

| 脚本 | 作用 |
|---|---|
| `fetch-plugin.mjs <输出路径>` | 下载 release 附件并校验 SHA-256（Node TLS；文件头的 URL 与期望摘要需按需修改）。 |
| `assemble-0.1.2.mjs <源包目录> <修好的 client.js> <源包目录>` | 用已发布的 tgz 内容 + 新的 `client.js` 组装出下一个版本的包目录，只改版本号那一行。 |
| `build-upstream-patch.mjs <上游 client.js> <已安装 client.js> <输出目录>` | 从上游文件文本重放补丁，验证结果与本地实测文件逐字节相同，并输出 `client.fixed.js` / `.b64` / `.diff`。 |

## 检查 DSH 自身

| 脚本 | 作用 |
|---|---|
| `asar-read.mjs <app.asar> find <正则>` | 列 `app.asar` 里的路径（免依赖）。 |
| `asar-extract.mjs <app.asar> <输出目录> <仓库内路径...>` | 从 `app.asar` 提取文件；也支持 `list <正则> <输出文件>` 模式，避免超长 stdout。 |
| `push-locale-fix.mjs <fetch\|push> <目录>` | 针对 0.1.1 → 0.1.2 那次修复的 Contents API 推送（含 SHA 守卫）。 |

## fix-payload

0.1.2 那次修复的凭据留档，`verify-live.mjs` 会用到：

- `client.upstream.js` — 修改前的上游版本
- `client.fixed.js` — 已提交、已验证的修复版
- `client.fixed.b64` / `client.js.diff` — 提交载荷与 diff
- `client.live.js` — 发布后从 GitHub 回读的副本
- `client.js.sha256` / `client.upstream.meta.json` — 摘要与上游 blob sha

## 注意

- **asar 头部格式**：本机 Electron 的 `app.asar` 头部是
  `[u32 pickleSize][u32 headerSize][u32 jsonLen][json...]`，JSON 从 **offset 16** 开始，
  每个文件的 `offset` 相对 **`8 + headerSize`**。用 `fs.readFileSync` 直接读 `.asar` 会只拿到头部。
- **沙箱限制**：当前会话里 Node 无法 `spawnSync` 外部进程（EPERM，命名管道受限），所以相关脚本
  都改成纯 JS 实现，不依赖 `tar.exe`。
- `preflight.mjs` / `verify-committed.mjs` 等脚本会访问 `api.github.com`；如果所在网络到
  `api.github.com` 的连接不稳，脚本内已带重试与较长超时。
