# dsh-session-delete

DSH 会话删除插件：在侧边栏会话行的「⋯」菜单里增加一项 **删除会话**，点击后把这一个会话**真正从磁盘删掉**，而不是只做归档。

这不是官方 API 的包装——DSH 0.2 的 `ctx.sessionPersistence` 只提供 `create` / `open` / `flush` / `stat` / `list`，没有删除会话的方法，所以本插件按顺序做四件事：

1. **拒绝正在运行的会话**（Agent 状态为 `running`，或归档准入报告还有 jobs / 子代理 / 提醒在跑时返回 409，不会误删正在干活的数据）；
2. 通过官方 `ctx.workspaceRegistry.archiveSession()` **归档**该会话——这样所有界面（侧边栏、会话列表、搜索结果）立刻隐藏这一行；这一步必须在文件还在时执行，因为归档会校验会话是否存在；
3. 通过工作区实体的 `detachSession()` 把它从工作区记账里摘掉；
4. 删除磁盘上的两处产物：
   - 会话日志目录 `~/.dsh/sessions/<工作区目录>/<session-id>/`
   - 投影缓存记录 `~/.dsh/storages/session_projcache/sessions/<session-id>.json`

删除路径只来自 `ctx.sessionPersistence.locate()`（0.2 实现里仍保留）或按会话 id 在 `<DSH home>/sessions/*/` 下按名字扫描，并且删除前再校验一次目录名等于会话 id，所以不会误删别的目录。

## 交互

菜单项是**两段式**，避免误点：

1. 点「删除会话」→ 该行变成红色的「确认删除「会话名」」，菜单不关闭；
2. 再点一次 → 调用宿主删除，成功后菜单关闭、该行随归档状态消失。

失败时该行显示「删除失败：<原因>」，再点一次可重试。会话正在运行时提示「会话正在运行」。

## 在 0.2.0-rc.2 上的实测结果

在一份**一次性 DSH home + 临时 profile**里启动真实宿主（同样的 0.2.0-rc.2 运行时）做过端到端验证，被测会话是从真实 home 复制并改写过 id 的**真实会话日志**：

| 检查 | 结果 |
|---|---|
| 宿主激活报错 | 0 个 entry 未激活 |
| 客户端 boot graph 含本插件 | 是（bundle 可 200 取回） |
| 删除前：日志在盘、已被工作区记账 | 是 / 是 |
| 删除响应 | `200 {"ok":true,"removed":[会话目录, 投影缓存记录]}` |
| 删除后：日志目录 | 已消失 |
| 删除后：`session_projcache` 记录 | 已消失 |
| 删除后：归档集合含该 id | 是（证明走了官方 `archiveSession`） |
| 删除后：工作区记账 | 已摘除 |
| 再次删除 | `200 {"ok":true,"removed":[],"note":"no-artifact"}`（幂等） |

当前 desktop profile 的 `dsh-session-delete` 行也已装载：在 http://127.0.0.1:19387 上 `POST /dsh-session-delete/delete` 返回本插件的 JSON，`/plugins/??dsh-session-delete/client.js&rev=…` 返回 200（用的就是当时的文件版本）。客户端界面是否已出现菜单项，取决于当前界面有没有拿到宿主重算后的模块图——客户端支持重载就 Ctrl+R 重载一次，否则完全退出并重开客户端。

## 降级行为

`workspaceRegistry` 不是硬依赖（`inject` 只有 `webServer` 与 `sessionPersistence`）。宿主里没有工作区注册表、或它激活失败时，插件照常激活并**仍然删盘**，只是被删会话的那一行要等到下次列表刷新才消失（日志里会有一条 warning）。这样避免出现「插件因为一个非核心服务缺失而完全不可用」。

## 安装

本插件是纯 JavaScript 包，不需要构建（无 TypeScript、无依赖）。在 Desktop 里用仓库中的 `dsh` CLI 安装：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<本目录的绝对路径>"
```

或使用界面：**设置 → 插件 → 添加插件**，把本目录的绝对路径粘进输入框后点安装（界面安装会走 HMR，通常不需要重启）。

命令行安装后需要**重启 DeepSeek Harness**（宿主插件行与客户端 bundle 在启动时装载）。

若宿主已在运行，实测行为是：**客户端半侧会被热重载**（改一下 `client.js`，宿主立刻重算模块图并换用新的 rev，旧 rev 的 URL 返回 404），而**宿主半侧的 `index.js` 不会热重载**，需要重启才换到新版本。

> 安装使用 `link:` 依赖，profile 直指本目录：**不要移动或删除本目录**，否则下次启动会解析不到该插件行。需要移动时先卸载，再从新位置安装。

## 装到其他电脑

### A. 用打包文件（推荐）

`dist\dsh-session-delete-0.1.2.tgz` 是现成的单文件安装包（含 `index.js` / `client.js` / `cordis.patch.yml` / `package.json` / `README.md` / `test`）。改动源码后可以自己重打：

```powershell
& "D:\DeepSeek Harness\resources\runtime\bin\node.cmd" "D:\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs" --dir "<本目录>" pack --pack-destination "<输出目录>"
```

在对方电脑上：

1. **先打开一次 DeepSeek Harness 桌面客户端**（初始化 profile），然后**完全退出**；
2. 把 tgz 拷过去，然后：
   ```powershell
   & "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\路径\dsh-session-delete-0.1.2.tgz"
   ```
3. 重新打开客户端，会话行「⋯」菜单里出现「删除会话」即成功。

tgz 是**复制安装**：装完后 tgz 和源码目录都可以删掉，实际文件在 profile 的 `node_modules\dsh-session-delete\` 里（实测确认过不是软链）。

### B. 拷贝整个目录

同样先退出客户端，然后把目录拷到对方电脑并：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\dsh-plugins\dsh-session-delete"
```

这是 `link:` 安装，**该目录必须留着**，不能删除或移动。

### C. 放到 GitHub 再装

已发布仓库：<https://github.com/inuyama404/dsh-session-delete>（v0.1.2 release 附 tgz）。

**方式 C1（需要对方装了 Git）**——pnpm 会先用 `git ls-remote` 解析 tag，所以本机没有 `git` 会直接失败：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:inuyama404/dsh-session-delete#v0.1.2"
```

**方式 C2（不需要 Git，新机器首选）**——直接用 release 附件 URL，一步到位：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/inuyama404/dsh-session-delete/releases/download/v0.1.2/dsh-session-delete-0.1.2.tgz"
```

**方式 C3（不需要 Git）**——GitHub 的 tag 归档：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://codeload.github.com/inuyama404/dsh-session-delete/tar.gz/refs/tags/v0.1.2"
```

**装到干净的机器上请用 C2**：一步到位，且不依赖 `git`。A 需要先拿到 tgz 文件，B 是 `link:` 安装（目录必须一直留着），C1 需要对方装了 Git（本机没有 git，实测报 `git ls-remote` 找不到命令），C3 拉的是 tag 归档而非发布附件。C2 / C3 都在一次性 profile 里实测通过（装成真实目录、bundle 自动进 `dsh.profile.bundles`、装好的副本自检 32 项全过）。本插件没有 `prepare` 或任何构建脚本，不会触发 pnpm 的构建脚本审批。

**改完代码重新发布**：走 GitHub Contents / Releases API，**不需要 `git`**。这台机器没有 `git`，PowerShell 的 TLS 栈也取不到凭据（`schannel: SEC_E_NO_CREDENTIALS`），而 Node 的 TLS 正常，所以 0.1.2 就是这么发的。

```powershell
# 1) 改 package.json 的 version 并提交    2) 打包    3) 建 release 并把 tgz 作为附件上传
& "D:\DeepSeek Harness\resources\runtime\bin\node.cmd" tools/push-release.mjs 0.1.3
```

token 从 `$env:DSH_GH_TOKEN` 读取（细粒度、只授权本仓库的 Contents: Read and write 即可），用完请撤销。三条防呆：提交前核对 `package.json` 里确实是目标版本、已存在的 tag 直接拒绝、上传后回读附件比对 SHA-256。tag 由 release 创建时一并生成，因此本地不需要 git 仓库。

### 换机器要注意什么

- **版本门槛**：插件声明 peer `@deepseek-ai/dsh-base >=0.2.0-rc.1 <0.3.0`。对方版本不在范围内时，`dsh plugin add` 会在安装前直接拒绝，并打印放行命令：
  `dsh plugin --profile desktop allow-version dsh-session-delete@0.1.2 --dsh-version <对方运行时版本> --accept-risk`。
  这是官方的风险闸门（不兼容插件可能崩溃或损坏数据），放行前请确认插件的 API 在新版本里还在。对 0.1.x：`sessionPersistence.stat()` / `locate()` 可能不存在，代码里这两处都有兜底（拿不到 header 就按 `<home>/sessions/*/<会话id>` 扫描目录删除），但**未在 0.1.x 上实测**。
- **profile 名要对**：桌面客户端装到 `--profile desktop`；若你在别处用 `dsh web` 启动，默认 profile 是 `web`，就装到 `web`。
- **只适用于客户端/Web profile**：插件需要 `webServer`（注册路由）与 `sessionPersistence`；headless / ACP / SDK 这类没有 `webServer` 的 profile 里它会停在 `pending`，不会激活。
- **pnpm 会报 peer 警告**（`Issues with peer dependencies found`）：因为 `@deepseek-ai/dsh-base` 是 peer 而 profile 不自动装 peer。这只是警告，DSH 自己的兼容性检查已经通过。
- **没有写死绝对路径**：DSH home 来自 `ctx.dshHomePath` / `$DSH_HOME` / `~/.dsh`，会话目录优先用 `sessionPersistence.locate()`，失败则按 `<home>/sessions/*/<会话id>` 扫描；投影缓存固定为 `<home>/storages/session_projcache/sessions/<会话id>.json`。本次验证就是在另一份临时 DSH home 上跑通的。

## 怎么确认它生效了

面向**桌面客户端**（不是浏览器；客户端内嵌的就是本机宿主 127.0.0.1:19387 提供的同一套界面，插件客户端半侧也由宿主的模块图下发）：

1. **最直接的一条：看菜单**。会话行「⋯」菜单最后一项（在「归档会话」之下、带一条分隔线）应是红色的「删除会话」。看得到就说明两半都活了。
2. **宿主半侧**（在任意 shell 里，不依赖客户端）：
   ```powershell
   curl.exe -sS http://127.0.0.1:19387/dsh-session-delete/status
   # {"ok":true,"plugin":"dsh-session-delete","version":"0.1.2","workspaceRegistry":true}
   ```
   返回 404 说明当前进程里跑的还是 0.1.0（没有 status 路由，但删除功能正常）；`version` 会告诉你进程里到底是哪一份代码。
3. **客户端控制台**（仅当你的客户端开放了开发者工具时才可用）：加载后应打印
   `[dsh-session-delete] menu entry registered in sidebar.workspaces.session.menu.item (locale: dsh-session-delete)`;
   括号里若是 `(locale: english fallback)`，说明没拿到 `locale` 服务，菜单项会退回内置英文文案（同时会打印一条 `console.warn` 说明原因）。
   若末尾带 `(fallback row: primitives module unavailable)`，说明取不到 `@deepseek-ai/dsh-client-ui-primitives`，插件已降级为自绘按钮（功能不受影响）。本部署的 profile 里 `developerTools: false`，通常没有这个入口——那就以第 1 条为准。

菜单里没有「删除会话」时：客户端内嵌界面支持重载就用 **Ctrl+R** 重载一次；不行就**完全退出并重开客户端**（重开会换到新的宿主代码，例如 `index.js` 改动后的版本）。

## 自检

不启动 DSH 就能跑完整回归（伪装宿主 context 与模块加载器）：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\node.cmd" test/selftest.mjs
```

覆盖：路由登记、非 POST/畸形 id/运行中会话的拒绝、归档与工作区记账顺序、日志目录与投影缓存的真实删除、重复删除的幂等、菜单项注册选项、两段式确认、失败重试文案，以及取不到 primitives 时的降级按钮。

## 卸载

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-session-delete
```

如果启动出现问题，直接编辑 profile 并移除这一行：

- `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里删掉 `dsh-session-delete`，`dsh.profile.bundles` 里删掉同名条目；
- `~/.dsh/profiles/desktop/cordis.patch.yml` 里删掉 `id: session-delete` 的插入行（如果 CLI 已写入）。

## 已知限制

- 删除**不可恢复**（没有回收站）。归档集合里会留下该会话 id 的痕迹，无害且不显示。
- 若该会话此刻正被某个标签页打开，删除后请刷新页面；被打开的空闲会话不会阻止删除，但继续在它里面输入可能重新落盘。
- 会话正在运行时不允许删除。
- 客户端菜单项依赖 `@deepseek-ai/dsh-client-ui-primitives`（该模块是 Client 模块表的基线 external）；万一取不到，插件会退化为自绘的 `role="menuitem"` 按钮，只使用 `--dsw-alias-*` 主题变量。
