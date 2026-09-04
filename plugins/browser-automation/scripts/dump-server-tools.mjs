// Dump both MCP servers' tools/list (names, descriptions, input schemas) to docs/server-tools.json for reference.
import { writeFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const dump = async (command, args) => {
  const t = new StdioClientTransport({ command, args, stderr: 'ignore' })
  const c = new Client({ name: 'dsh-browser-automation-manifest', version: '0' })
  await c.connect(t)
  const { tools } = await c.listTools()
  await c.close()
  return Object.fromEntries(tools.map(tool => [tool.name, { description: tool.description, inputSchema: tool.inputSchema }]))
}
const out = {
  safari: await dump('/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver', ['--mcp']),
  chrome: await dump('/opt/homebrew/bin/chrome-devtools-mcp', ['--isolated', '--no-usage-statistics']),
}
await writeFile(new URL('../docs/server-tools.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log('safari tools:', Object.keys(out.safari).length, '| chrome tools:', Object.keys(out.chrome).length)
