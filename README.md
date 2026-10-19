# dsh-session-delete

DSH 会话删除插件：在侧边栏会话行的「⋯」菜单里增加 **删除会话**，并支持**批量删除**——勾选多个会话后在会话列表下方一键删除。两者都是把会话**真正从磁盘删掉**，而不是只做归档。

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

## 批量删除

1. 在任意会话行的「⋯」菜单里点 **批量删除会话…** → 进入选择模式，每行左侧出现复选框；
2. 勾选要删的会话（也可以点右侧浮动栏的「全选」）；
3. 侧边栏底部（会话列表正下方）出现红色按钮 **删除选中的 N 个会话**；
4. 点它 → 弹出确认框 **确认删除 N 个会话？**，说明「会话记录会从磁盘上永久删除，无法恢复。」；
5. 点 **确认删除** → 一次请求删掉整批；**全部成功时选择模式自动关闭**，复选框与按钮一起消失。

「取消」只关掉确认框，**保留勾选**，方便反悔后再删。

### 三条安全规则

| 规则 | 行为 |
|---|---|
| **当前正在查看的会话不可删** | 它的复选框是灰的，悬停提示「当前会话不能删除」；「全选」会跳过它；即使通过别的途径混进选择，**提交前也会被过滤掉**（只剩它时一个请求都不发） |
| **正在运行的会话不被删** | 可以被勾选，但宿主返回 409；其余照删，结果里单独报告失败 |
| **部分失败时保留失败项** | 只要有一条失败，选择模式不关闭，且**只保留失败的那几条**，方便处理后重试 |

判定"当前会话"读的是会话行上的 `_selected` 类，并在**点击删除的那一刻重新读一次**，所以切换会话不会留下过期判断。

### 宿主端点

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/dsh-session-delete/plan` | 列出可删会话（`sessionPersistence.list()` 优先，失败时回退扫描 `sessions/`），供「全选」使用 |
| `POST` | `/dsh-session-delete/bulk-delete` | body `{"sessionIds":[...]}`，顺序删除，逐条返回 `{sessionId, ok, status, error}`；单条失败不中断；单批上限 200，超出部分回 `remaining` |
| `POST` | `/dsh-session-delete/delete` | 单条删除（原有） |
| `GET` | `/dsh-session-delete/status` | 版本与端点自述 |

任一 id 不合法则**整批拒绝**（400），不做部分删除。每次批量操作会写一条 `info` 日志（`bulk delete: X/Y removed (…)`），作为不可恢复操作的可追溯记录。

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

## 在 0.2.1-rc.2 上的批量删除验证

DSH 会自动升级，所以 0.2.0 的玩法在 0.2.1-rc.2 上重新核对过：

- **slot 契约未变**：`sidebar.workspaces.session.menu.item`、`sidebar.session.row.leading`、`shell.overlay` 在新版里仍是 `list` / `root` 作用域，行渲染器仍按 `renderSlot("sidebar.session.row.leading", { sessionId })` 取值。
- **实测（桌面客户端，0.2.1-rc.2）**：在一条测试会话里进入批量模式，可以删除另外两条测试会话；**当前所在的会话复选框为灰、无法勾选**，也无法删除自己。
- **单元测试**覆盖了真实删除路径（临时目录里的真实文件）、逐条失败、批量上限、当前会话过滤，以及确认框与红色按钮的渲染结构。

升级过一次就出过问题：0.2.0 时代的客户端代码在 0.2.1 上曾把会话列表整块拖空（渲染抛错没有被隔离）。因此现在每个 slot 入口都包了**错误边界**（`getDerivedStateFromError`），并用 `try/catch` 隔离注册与 `ctx.provide`——**任何一处失败只让那一个入口消失，不会再牵连会话列表**。

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

`dist\dsh-session-delete-0.2.0.tgz` 是现成的单文件安装包（含 `index.js` / `client.js` / `cordis.patch.yml` / `package.json` / `README.md` / `test`）。改动源码后可以自己重打：

```powershell
& "D:\DeepSeek Harness\resources\runtime\bin\node.cmd" "D:\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs" --dir "<本目录>" pack --pack-destination "<输出目录>"
```

在对方电脑上：

1. **先打开一次 DeepSeek Harness 桌面客户端**（初始化 profile），然后**完全退出**；
2. 把 tgz 拷过去，然后：
   ```powershell
   & "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\路径\dsh-session-delete-0.2.0.tgz"
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

已发布仓库：<https://github.com/inuyama404/dsh-session-delete>（v0.2.0 release 附 tgz）。

**方式 C1（需要对方装了 Git）**——pnpm 会先用 `git ls-remote` 解析 tag，所以本机没有 `git` 会直接失败：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:inuyama404/dsh-session-delete#v0.2.0"
```

**方式 C2（不需要 Git，新机器首选）**——直接用 release 附件 URL，一步到位：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/inuyama404/dsh-session-delete/releases/download/v0.2.0/dsh-session-delete-0.2.0.tgz"
```

**方式 C3（不需要 Git）**——GitHub 的 tag 归档：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://codeload.github.com/inuyama404/dsh-session-delete/tar.gz/refs/tags/v0.2.0"
```

**装到干净的机器上请用 C2**：一步到位，且不依赖 `git`。A 需要先拿到 tgz 文件，B 是 `link:` 安装（目录必须一直留着），C1 需要对方装了 Git（本机没有 git，实测报 `git ls-remote` 找不到命令），C3 拉的是 tag 归档而非发布附件。C2 / C3 都在一次性 profile 里实测通过（装成真实目录、bundle 自动进 `dsh.profile.bundles`、装好的副本自检 32 项全过）。本插件没有 `prepare` 或任何构建脚本，不会触发 pnpm 的构建脚本审批。

**改完代码重新发布**：走 GitHub Contents / Releases API，**不需要 `git`**。这台机器没有 `git`，PowerShell 的 TLS 栈也取不到凭据（`schannel: SEC_E_NO_CREDENTIALS`），而 Node 的 TLS 正常；本插件的发布流程就是这么跑的。

```powershell
# 1) 改 package.json 的 version 并提交    2) 打包    3) 建 release 并把 tgz 作为附件上传
& "D:\DeepSeek Harness\resources\runtime\bin\node.cmd" tools/push-release.mjs x.y.z
```

token 从 `$env:DSH_GH_TOKEN` 读取（细粒度、只授权本仓库的 Contents: Read and write 即可），用完请撤销。三条防呆：提交前核对 `package.json` 里确实是目标版本、已存在的 tag 直接拒绝、上传后回读附件比对 SHA-256。tag 由 release 创建时一并生成，因此本地不需要 git 仓库。

### 换机器要注意什么

- **版本门槛**：插件声明 peer `@deepseek-ai/dsh-base >=0.2.0-rc.1 <0.3.0`。对方版本不在范围内时，`dsh plugin add` 会在安装前直接拒绝，并打印放行命令：
  `dsh plugin --profile desktop allow-version dsh-session-delete@0.2.0 --dsh-version <对方运行时版本> --accept-risk`。
  这是官方的风险闸门（不兼容插件可能崩溃或损坏数据），放行前请确认插件的 API 在新版本里还在。对 0.1.x：`sessionPersistence.stat()` / `locate()` 可能不存在，代码里这两处都有兜底（拿不到 header 就按 `<home>/sessions/*/<会话id>` 扫描目录删除），但**未在 0.1.x 上实测**。
- **profile 名要对**：桌面客户端装到 `--profile desktop`；若你在别处用 `dsh web` 启动，默认 profile 是 `web`，就装到 `web`。
- **只适用于客户端/Web profile**：插件需要 `webServer`（注册路由）与 `sessionPersistence`；headless / ACP / SDK 这类没有 `webServer` 的 profile 里它会停在 `pending`，不会激活。
- **pnpm 会报 peer 警告**（`Issues with peer dependencies found`）：因为 `@deepseek-ai/dsh-base` 是 peer 而 profile 不自动装 peer。这只是警告，DSH 自己的兼容性检查已经通过。
- **没有写死绝对路径**：DSH home 来自 `ctx.dshHomePath` / `$DSH_HOME` / `~/.dsh`，会话目录优先用 `sessionPersistence.locate()`，失败则按 `<home>/sessions/*/<会话id>` 扫描；投影缓存固定为 `<home>/storages/session_projcache/sessions/<会话id>.json`。本次验证就是在另一份临时 DSH home 上跑通的。

## 怎么确认它生效了

面向**桌面客户端**（不是浏览器；客户端内嵌的就是本机宿主 127.0.0.1:19387 提供的同一套界面，插件客户端半侧也由宿主的模块图下发）：

1. **最直接的一条：看菜单**。会话行「⋯」菜单最后一项（在「归档会话」之下、带一条分隔线）应是红色的「删除会话」，其上方应有「批量删除会话…」。看得到就说明两半都活了。
2. **批量删除**：点「批量删除会话…」→ 每行左侧出现复选框 → 勾几条 → **侧边栏底部**出现红色「删除选中的 N 个会话」→ 点开确认框 → 确认。**你当前所在的会话，复选框应当是灰的。**
3. **宿主半侧**（在任意 shell 里，不依赖客户端；端口以客户端实际监听为准）：
   ```powershell
   curl.exe -sS http://127.0.0.1:19387/dsh-session-delete/status
   # {"ok":true,"plugin":"dsh-session-delete","version":"0.2.0","workspaceRegistry":true,
   #  "bulk":{"plan":"/dsh-session-delete/plan","delete":"/dsh-session-delete/bulk-delete","maxPerRequest":200}}
   ```
   返回 404 说明当前进程里跑的还是 0.1.0（没有 status 路由，但删除功能正常）；`version` 会告诉你进程里到底是哪一份代码；没有 `bulk` 字段说明还是 0.1.x。
4. **客户端控制台**（仅当你的客户端开放了开发者工具时才可用）：加载后应打印
   `[dsh-session-delete] bulk surfaces registered: … (locale: dsh-session-delete)`;
   括号里若是 `(locale: english fallback)`，说明没拿到 `locale` 服务，文案会退回内置英文表（同时会打印一条 `console.warn` 说明原因）。
   若某个入口渲染失败，只会看到一条 `[dsh-session-delete] surface "…" failed to render`，**其它入口与会话列表不受影响**。

菜单里没有「删除会话」时：客户端内嵌界面支持重载就用 **Ctrl+R** 重载一次；不行就**完全退出并重开客户端**（重开会换到新的宿主代码，例如 `index.js` 改动后的版本）。

## 自检

不启动 DSH 就能跑完整回归（伪装宿主 context、模块加载器与 React）：

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\node.cmd" test/selftest.mjs
& "D:\DeepSeek Harness\resources\runtime\cli\bin\node.cmd" test/bulk.test.mjs
& "D:\DeepSeek Harness\resources\runtime\cli\bin\node.cmd" test/bulk-run.test.mjs
& "D:\DeepSeek Harness\resources\runtime\cli\bin\node.cmd" test/render-bar.test.mjs
& "D:\DeepSeek Harness\resources\runtime\cli\bin\node.cmd" test/open-session.test.mjs
```

| 套件 | 覆盖 |
|---|---|
| `selftest` | 路由登记、非 POST / 畸形 id / 运行中会话的拒绝、归档与记账顺序、日志与投影缓存的真实删除、幂等、菜单项选项、两段式确认、失败文案、primitives 缺失时的降级按钮 |
| `bulk.test` | plan 与批量端点、逐条失败不中断、去重、批量上限、`list()` 失败回退扫目录、无 workspaceRegistry 时仍可删；客户端 slot 注册与词典、每个入口都带 locale 座位 |
| `bulk-run` | 全部成功 → 自动关闭选择模式；部分失败 → 只留失败项；传输失败 → 保留全部可重试；**当前会话被过滤且不发请求** |
| `render-bar` | 红色按钮的位置与文案、无选中时不渲染、确认框为 modal、取消保留勾选 |
| `open-session` | 用假 DOM 验证当前会话判定：复选框置灰、切换后解除、卸载后释放 |

## 卸载

```powershell
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-session-delete
```

如果启动出现问题，直接编辑 profile 并移除这一行：

- `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里删掉 `dsh-session-delete`，`dsh.profile.bundles` 里删掉同名条目；
- `~/.dsh/profiles/desktop/cordis.patch.yml` 里删掉 `id: session-delete` 的插入行（如果 CLI 已写入）。

## 已知限制

- 删除**不可恢复**（没有回收站）。归档集合里会留下该会话 id 的痕迹，无害且不显示。
- **当前正在查看的会话不能被删**（客户端保护：复选框置灰、全选跳过、提交前再过滤）。其它被打开的空闲会话仍可删，删完刷新页面即可；继续在被删的会话里输入可能让日志重新落盘。
- **正在运行**的会话不允许删除（宿主返回 409，其余会话照删）。
- **已归档的会话没有复选框**：宿主不为归档行渲染 `sidebar.session.row.leading`。要用行菜单的「加入待删列表」把它们选进来。
- 单次批量上限 **200** 条；超出部分会在响应里回报 `remaining`，再点一次即可继续。
- 「当前会话」的判定读的是宿主行样式类 `_selected`。DSH 若改掉这个类名，保护会**静默失效**（退化成"能被自己删掉"的旧行为），不会报错。升级 DSH 后请顺手确认一次复选框是否仍会置灰。
- 客户端菜单项依赖 `@deepseek-ai/dsh-client-ui-primitives`（该模块是 Client 模块表的基线 external）；万一取不到，插件会退化为自绘的 `role="menuitem"` 按钮，只使用 `--dsw-alias-*` 主题变量。
