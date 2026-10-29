#!/usr/bin/env node
// Playwright MCP 服务器的启动器。
//
// DeepSeek Harness 的 Host 可能运行在文件沙箱里，不允许写会话工作区之外的路径。
// Playwright 和 Chromium 都会在用户主目录下创建缓存目录，所以本启动器先把这些
// 路径重定向到可写的 runtime 目录，再启动服务器。
//
// 启动器还会把 runtime 的输出目录设为服务器的工作目录。Playwright MCP 服务器
// 会把自己的工作目录作为「工作区根目录」上报给客户端，而自动命名的输出文件和
// 客户端指定文件名的文件都按这个根目录解析，因此所有浏览器产物都会落在同一个
// 可预期的目录里。
//
// runtime 目录默认是 <本目录>/runtime，可用环境变量 PLAYWRIGHT_MCP_RUNTIME_DIR 覆盖。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const runtimeDir = resolve(
  process.env.PLAYWRIGHT_MCP_RUNTIME_DIR ?? join(here, 'runtime'),
)

const home = join(runtimeDir, 'home')
const profiles = join(runtimeDir, 'profiles')
const output = join(runtimeDir, 'output')
const browsers = join(runtimeDir, 'browsers')

mkdirSync(home, { recursive: true })
mkdirSync(profiles, { recursive: true })
mkdirSync(output, { recursive: true })
mkdirSync(browsers, { recursive: true })

// 各平台解析「缓存目录」的方式不同，一次性把它们全部指到 runtime 内：
//
//   PLAYWRIGHT_BROWSERS_PATH  Playwright 浏览器注册表，三平台通用且优先级最高
//   PWMCP_PROFILES_DIR_FOR_TEST  Playwright MCP 的 Chrome Profile 目录，三平台通用
//   HOME                      macOS / Linux 的 os.homedir() 来源
//   USERPROFILE / LOCALAPPDATA  Windows 的 os.homedir() 与缓存目录来源
//   XDG_CACHE_HOME            Linux 上优先级高于 homedir()，必须一并覆盖
//
// 只设 HOME 在 Windows 上完全无效（Node 的 os.homedir() 在 Windows 读 USERPROFILE），
// 只设 HOME 在 Linux 上也可能被已存在的 XDG_CACHE_HOME 覆盖。
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browsers,
  PWMCP_PROFILES_DIR_FOR_TEST: profiles,
}

if (process.platform === 'win32') {
  env.USERPROFILE = home
  env.LOCALAPPDATA = join(home, 'AppData', 'Local')
  env.APPDATA = join(home, 'AppData', 'Roaming')
  mkdirSync(env.LOCALAPPDATA, { recursive: true })
  mkdirSync(env.APPDATA, { recursive: true })
} else {
  env.HOME = home
  env.XDG_CACHE_HOME = join(home, '.cache')
}

/**
 * 定位 Playwright MCP 的 CLI 入口。
 *
 * 两种安装形态都要支持：
 *   1. 作为 DSH bundle 以 link 方式装进 profile —— 依赖被内置在本包的 node_modules 里；
 *   2. 从 npm 安装 —— npm 永远不会打包 node_modules，依赖会被提升到上层的 node_modules。
 *
 * `@playwright/mcp` 的 exports 只暴露 "." 和 "./package.json"，无法直接 resolve
 * 到 cli.js，所以先解析 package.json 再拼出同目录下的 cli.js。
 */
function resolveCli() {
  const vendored = join(here, 'node_modules', '@playwright', 'mcp', 'cli.js')
  if (existsSync(vendored)) return vendored
  try {
    const pkgJson = require.resolve('@playwright/mcp/package.json')
    const resolved = join(dirname(pkgJson), 'cli.js')
    if (existsSync(resolved)) return resolved
  } catch {
    // 落到下面统一报错
  }
  throw new Error(
    `找不到 @playwright/mcp 的 cli.js。请确认依赖已安装（试过 ${vendored} 和 require.resolve）。`,
  )
}

const cli = resolveCli()

// Chrome 只要看到 `--no-sandbox` 就会弹一条「您使用的是不受支持的命令行标志」提示条，
// 并且会削弱浏览器自身的沙箱，所以默认**不加**。实测在本机 Harness 沙箱下 Chrome
// 可以直接正常启动。某些环境下（例如 Linux 容器里以 root 运行）Chrome 会因为无法
// 初始化沙箱而起不来，此时设 CHROME_BRIDGE_NO_SANDBOX=1 打开它即可。
const extraFlags = []
if (process.env.CHROME_BRIDGE_NO_SANDBOX === '1') extraFlags.push('--no-sandbox')

// Playwright MCP 对 Chromium 家族浏览器会强制追加 `--disable-blink-features=AutomationControlled`
// （用于隐藏自动化特征）。而 Chromium 的 kBadFlags 列表里有 switches::kDisableBlinkFeatures，
// 所以系统版 Chrome 会为它弹「您使用的是不受支持的命令行标志」提示条。
//
// 它注入前会先检查 args 里是否已存在含 "--disable-blink-features" 的项，存在就跳过。
// 因此这里给一个**不会被 Chrome 当成开关**的占位参数：Chrome 把 `--chrome-bridge-inert`
// 当作未知开关静默忽略，而子串检查命中后 MCP 就不再追加真正的那一个。
// 想保留隐藏自动化的行为，设 CHROME_BRIDGE_KEEP_BLINK_FLAG=1。
const configPath = join(runtimeDir, 'mcp-config.json')
const launchArgs = []
if (process.env.CHROME_BRIDGE_KEEP_BLINK_FLAG !== '1')
  launchArgs.push('--chrome-bridge-inert=--disable-blink-features')
writeFileSync(
  configPath,
  JSON.stringify({ browser: { launchOptions: { args: launchArgs } } }, null, 2) + '\n',
)

const args = [
  cli,
  // 使用系统已安装的 Google Chrome，而不是下载一份 Chromium。
  '--browser',
  'chrome',
  // 上面的浏览器参数通过配置文件传入（CLI 没有直接传自定义 Chrome 开关的选项）。
  '--config',
  configPath,
  ...extraFlags,
  // 自动命名的产物（页面快照等）写到这里。
  '--output-dir',
  output,
  ...process.argv.slice(2),
]

// 服务器把自己的工作目录当作「工作区根目录」，所以直接在输出目录里启动它，
// 这样所有产物都落在同一个地方。
const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env,
  cwd: output,
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
