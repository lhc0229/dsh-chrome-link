# Chrome Bridge —— 给 DeepSeek Harness 用的 Playwright MCP 桥接

把 [Playwright MCP 服务器](https://github.com/microsoft/playwright-mcp) 接入 Harness
的工具注册表，让 Agent 能够操作**本机已安装的 Google Chrome**。

安装后 Agent 可以调用 25 个 `mcp__playwright__*` 工具：导航、点击、悬停、拖拽、
输入、填表、下拉选择、按键、读取无障碍快照、截图、查看控制台输出与网络请求、
在页面里执行 JavaScript、管理标签页等等。

## 工作原理

插件会装上两行。

### 1. Host 插件（`index.js`）

注册一个名为 `chrome-bridge` 的系统提示段落，告诉 Agent 这些浏览器工具是什么、
该优先用哪个、以及浏览器把产物写到哪里。只有当工具确实在该 Agent 的作用域内注册
成功时，这段说明才会渲染。

### 2. MCP 客户端行（`cordis.patch.yml`）

| 字段 | 取值 | 原因 |
|---|---|---|
| `serverName` | `playwright` | 决定工具名前缀 `mcp__playwright__*`。 |
| `command` / `args` | `node <launcher.mjs>` | 通过启动器来启动 MCP 服务器。 |
| `toolCallTimeoutMs` | `120000` | 浏览器操作可能较慢，默认 60 秒对页面加载偏紧。 |
| `failOnStartupError` | `false` | 没装 Chrome 也不能让整个 Harness 启动失败。 |
| `reconnect` | 5 次尝试，1–15 秒退避 | 服务器崩溃后自动重启，不中断会话。 |

### 为什么需要一个启动器脚本

`launcher.mjs` 的存在主要是为了沙箱相关的路径重定向：

1. **Playwright 和 Chromium 都想写用户主目录。**
   Playwright 从 `$HOME/Library/Caches` 解析浏览器注册表（macOS），Chromium 也会
   把 Profile 和 crashpad 数据写到主目录下。Harness 可能运行在禁止这些写入的文件
   沙箱里，所以启动器把 `HOME` 和 `PWMCP_PROFILES_DIR_FOR_TEST` 重定向到与本
   README 同级的 `runtime/` 目录。

### 关于「您使用的是不受支持的命令行标志」提示条

Chrome 有一条 Bad Flags infobar：只要启动参数里出现 `kBadFlags` 列表中的任一开关，就会在
标签页顶部插一条警告。这个列表在 Chromium 源码
`chrome/browser/ui/startup/bad_flags_prompt.cc` 里可以查到，其中与自动化相关的有：

```cpp
sandbox::policy::switches::kNoSandbox,        // --no-sandbox
...
switches::kDisableBlinkFeatures,              // --disable-blink-features
switches::kEnableBlinkFeatures,               // --enable-blink-features
```

这里先后踩到两个：

1. **`--no-sandbox`**（早期版本加的，当时 Harness 沙箱下 Chrome 初始化自己的沙箱会失败）。
   实测当前环境已不需要，已移除；它同时还会削弱浏览器的沙箱。
   某些环境仍可能需要（典型是 Linux 容器里以 root 运行），设 `CHROME_BRIDGE_NO_SANDBOX=1`
   可以重新打开。

2. **`--disable-blink-features=AutomationControlled`** —— 这个不是本插件加的，而是
   **Playwright MCP 强制追加**的，用来隐藏自动化特征。它命中 `kDisableBlinkFeatures`，
   所以系统版 Chrome 一定会为它弹提示条。

   它的注入逻辑带一个判断：只要 `launchOptions.args` 里已经存在含 `--disable-blink-features`
   子串的项，就不再追加。因此启动器通过 MCP 的 `--config` 传入一个**不会被 Chrome 当成
   开关**的占位参数 `--chrome-bridge-inert=--disable-blink-features`：Chrome 把
   `--chrome-bridge-inert` 当作未知开关静默忽略，子串判断命中后 MCP 就不再注入真正的那一个。

   代价是会失去「隐藏自动化特征」的效果（部分站点可能识别出自动化）。想保留它，设
   `CHROME_BRIDGE_KEEP_BLINK_FLAG=1`。

改完之后，Chrome 实际收到的命令行与 `kBadFlags` 的交集为空，提示条不再有触发条件。

启动器还传了 `--browser chrome`，让 Playwright 使用系统已安装的 Google Chrome，
而不是另外下载一份 Chromium。

### 为什么要改服务器的工作目录

Playwright MCP 服务器会把自己的工作目录作为「工作区根目录」上报给客户端。自动命名
的输出文件（页面快照）和客户端指定文件名的文件（带 `filename` 的截图）**都**按这个
根目录解析——但两者走的是不同的代码路径，所以只设 `--output-dir` 只能覆盖前一种。

因此启动器直接在 `runtime/output` 里启动服务器，这样不论 Agent 怎么命名，所有产物
都落在这同一个目录。

### 为什么启动器路径要写成 `!!js` 表达式

Loader 会以插件上下文为作用域求值 `!!js` 表达式。bundle 目录在那里没有暴露，但
Profile 目录是有的：

```
ctx.get('profileContext').dir + '/node_modules/dsh-chrome-link/launcher.mjs'
```

bundle 是以链接包的形式装进 Profile 的 `node_modules`，所以这个路径始终指向已安装的
启动器。注意：在 patch 求值阶段，`workingDirectory` 这类插件**服务**是不可用的，
只有 `profileContext` 和 `dshHomePath` 可用——所以路径不能依赖它们。

## 文件说明

| 文件 | 作用 |
|---|---|
| `cordis.patch.yml` | Bundle 补丁：Host 行和 MCP 客户端行。 |
| `index.js` | Host 侧：系统提示段落。 |
| `launcher.mjs` | 以沙箱安全的路径启动 Playwright MCP 服务器。 |
| `locale/en.json`、`locale/zh.json` | 插件页显示用的标题和描述。 |
| `icon.svg` | Plugin Manager 里的图标。 |

`@playwright/mcp` 既声明为普通依赖，**也**直接内置在 `node_modules/` 里。两者都需要：
`install_bundle` 是把本地目录**链接**过去而不是复制，而包管理器不会为被链接的包安装
依赖。内置依赖可以让启动器里的 `node_modules/@playwright/mcp/cli.js` 路径直接有效，
无需额外安装步骤。除非你打算用别的方式安装依赖，否则不要删 `node_modules/`。

## 安装

```sh
plugin_manager install_bundle /path/to/this/directory
```

安装后，该 Profile 下的所有 Agent 都会看到 `mcp__playwright__*` 这些工具。

## 从 npm 安装

```sh
npm install dsh-chrome-link
```

包名必须与 `cordis.patch.yml` 里 `launcher.mjs` 的路径段一致（`dsh-chrome-link`），
否则 MCP 客户端找不到启动器。

## 发布到 npm

包名是全局的 unscoped 名，发布时直接 `npm publish` 即可（`publishConfig.access: "public"`
在 `package.json` 里配着，对 scoped 包才必需，这里留着无害）。

```sh
# 1. 登录（首次会打开浏览器做 OTP 授权）
npm login --registry https://registry.npmjs.org/

# 2. 确认登录身份
npm whoami --registry https://registry.npmjs.org/

# 3. 预演：看看会打包哪些文件（应该是 8 个，不含 runtime/ 和 node_modules/）
npm pack --dry-run

# 4. 发布
npm publish
```

`package.json` 的 `files` 字段是白名单，npm 只打包其中列出的路径；`.npmignore` 是一层
额外保险，防止有人删掉 `files` 时误发 `runtime/` 里的浏览器产物。

发布前记得同步改版本号（`npm version patch` 会自动改 `package.json` 并打 git tag）。

> **注意**：`node_modules/` 不在 `files` 里，所以 npm 发布时不会带上内置的
> `@playwright/mcp`。从 npm 安装时依赖会被提升到上层 `node_modules`，启动器的
> `resolveCli()` 会通过 `require.resolve('@playwright/mcp/package.json')` 找到它，
> 因此依然可用。而用 `install_bundle` 从本地目录安装（软链方式）时，包管理器不会
> 为被链接的包装依赖，所以本地这份 `node_modules/` 必须保留。

## 跨平台适配

代码本身没有平台分支假设：路径全部走 `node:path` 的 `join`/`resolve`，进程用
`spawn(文件, 参数数组)` 启动（不经过 shell，所以路径带空格或中文都没问题）。

真正需要按平台处理的是「缓存目录落在哪」，各平台规则不同，启动器已经逐一覆盖：

| 平台 | Playwright 浏览器注册表 | Chrome Profile | `os.homedir()` 来源 |
|---|---|---|---|
| macOS | `PLAYWRIGHT_BROWSERS_PATH` | `PWMCP_PROFILES_DIR_FOR_TEST` | `HOME` |
| Linux | 同上 | 同上 | `HOME`（且受 `XDG_CACHE_HOME` 影响，已一并覆盖） |
| Windows | 同上 | 同上 | `USERPROFILE`，缓存另读 `LOCALAPPDATA` |

前两个环境变量是跨平台直连的；后两列是各平台 `os.homedir()` 的真实来源。
**只设 `HOME` 在 Windows 上完全无效**，这是最早版本的一个实际缺陷，现已修正。

启动命令也不依赖 `PATH` 里的 `node`：patch 用 `process.execPath`（即当前 Host 进程
自身的可执行文件）配合 `ELECTRON_RUN_AS_NODE=1`。Desktop 版 Host 是 Electron，加这个
变量后就以 Node 运行（实测为 Node 24.21）；CLI 版 Host 本身就是 node，该变量被忽略。
两种形态都成立，因此没装 Node 的机器也能跑。

### 已验证 / 未验证

- **macOS（Apple Silicon）**：已实测，导航 / 截图 / 关闭全部正常，产物落在
  `runtime/output/`。
- **Windows**：代码路径已按 Windows 的变量规则处理好，但**本机无法实测**。若遇到
  问题，优先看两点：① Chrome 是否装在标准位置（`--browser chrome` 通过注册表查找）；
  ② 路径过长——Chromium Profile 内部目录很深，可能触发 Windows 的 260 字符上限，
  此时把 `PLAYWRIGHT_MCP_RUNTIME_DIR` 指到一个短路径即可，例如 `C:\dsh-rt`。
- **Linux**：同样未实测。需要本机装有 Google Chrome；没装的话 `--browser chrome` 会
  失败，但 `failOnStartupError: false` 保证 Harness 本身照常启动，只是看不到浏览器工具。

### 换机器时的注意事项

- `node_modules/` 是随包内置的，里面是纯 JS，跨平台通用，不需要重新安装。
- Chrome 必须装在目标机器上；也可以给启动器加 `--executable-path <路径>` 显式指定。
- 想改产物目录，设 `PLAYWRIGHT_MCP_RUNTIME_DIR` 即可。

## 说明与限制

- **产物**——截图和页面快照——写在与本 README 同级的 `runtime/output/`。因为 MCP
  服务器是整个 Profile 共用的一个进程，所以输出目录只能是固定的一个。截图同时也会
  以内联图片的形式交给模型，因此通常不需要再去读文件。
- 浏览器默认是**有界面**运行的：会弹出一个 Chrome 窗口。这正是「操作本机 Chrome」
  的含义。如果只想后台运行，给启动器的参数加上 `--headless`。
- 默认不传 `--no-sandbox`，并阻断了 Playwright MCP 强加的 `--disable-blink-features`，
  因此 Chrome 参数里不含任何 `kBadFlags` 开关，「不受支持的命令行标志」提示条不会出现。
  若某台机器上 Chrome 起不来，再设 `CHROME_BRIDGE_NO_SANDBOX=1`。
- 代价是需要牺牲「隐藏自动化特征」这一能力；若要保留，设 `CHROME_BRIDGE_KEEP_BLINK_FLAG=1`，
  提示条会随之回来。
- 服务器只维护一个浏览器实例。`mcp__playwright__browser_close` 会释放它，下次调用
  工具时会自动重新拉起。
