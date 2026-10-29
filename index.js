// Chrome Bridge —— Host 侧插件。
//
// 负责教 Agent 怎么用浏览器工具：这些工具驱动本机已安装的 Google Chrome，
// 该优先调用哪个工具，以及浏览器把截图和页面快照写到了哪里。

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 启动器写浏览器产物（截图、页面快照）的目录。 */
export const outputDirectory = join(here, 'runtime', 'output')

/** 本插件依赖的服务。 */
export const inject = ['systemPrompt', 'tools']

/** 提供浏览器工具的那个 MCP 服务器名。 */
const serverName = 'playwright'

/**
 * 告诉 Agent 浏览器工具是什么、产物落在哪里。
 *
 * MCP 服务器是整个 Profile 共用的一个进程，所以它的输出目录是固定的。
 * Agent 需要知道这个路径，才能用自己的文件工具把截图读回来。
 */
export function apply(ctx) {
  mkdirSync(outputDirectory, { recursive: true })

  ctx.systemPrompt.section({
    name: 'chrome-bridge',
    order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
    text: ({ scope }) => {
      // 工具没注册上（比如服务器启动失败）时，不渲染这段说明。
      if (ctx.tools.get(`mcp__${serverName}__browser_navigate`, scope) === undefined) return ''
      return [
        'Browser control is available through the Playwright MCP tools `mcp__playwright__*`.',
        'They drive the Google Chrome installed on this machine, so a browser window opens while you use them.',
        '',
        'How to use them:',
        '- `browser_navigate` opens a URL, then `browser_snapshot` reads the page as an accessibility tree.',
        '- Prefer `browser_snapshot` over a screenshot for reading a page; it is cheaper and more precise.',
        '- `browser_click`, `browser_type`, `browser_fill_form`, `browser_hover` and `browser_select_option` act on the element references that `browser_snapshot` returns.',
        '- `browser_find` searches the page for text or a pattern when you know what you are looking for.',
        '- `browser_evaluate` runs JavaScript in the page; `browser_network_requests` and `browser_console_messages` show what the page requested and logged.',
        '- `browser_close` releases the browser when you are done.',
        '',
        `Browser artifacts (screenshots and page snapshots) are written to ${outputDirectory}.`,
        'Screenshots are also returned inline as images, so you usually do not need to open the file.',
      ].join('\n')
    },
  })
}
