// LIVE (spawns STP): element capture pipeline against a real Safari session,
// driven directly over MCP (the plugin routes the same calls through the registry).
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { cropBox, cropImage, imageSize, measureScript, parseMeasurement, rectMoved } from '../safari-screenshot.mjs'

const transport = new StdioClientTransport({ command: '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver', args: ['--mcp'], stderr: 'inherit' })
const client = new Client({ name: 'DSH: screenshot test', version: '1' })
await client.connect(transport)
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.filter(b => b.type === 'text').map(b => b.text).join(''); if (r.isError) throw new Error(t); return t }
const url = process.argv[2] ?? 'https://www.iana.org/'
const selector = process.argv[3] ?? 'h1, header, .main-content h1, body > *:first-child'
await call('navigate_to_url', { url })
const t0 = Date.now()
const before = parseMeasurement(await call('evaluate_javascript', { expression: measureScript(selector, true) }))
const shot = join(tmpdir(), `dsh-shot-test-${Date.now()}.png`)
await call('screenshot', { savePath: shot })
const after = parseMeasurement(await call('evaluate_javascript', { expression: measureScript(selector, false) }))
const size = await imageSize(shot)
const box = cropBox(after.rect, after.viewport, size)
const bytes = await cropImage(shot, box)
const out = '/tmp/dsh-element-crop.png'
await writeFile(out, bytes)
console.log(`pipeline ${Date.now() - t0} ms | settled=${before.settled} moved=${rectMoved(before.rect, after.rect)} | rect ${JSON.stringify(after.rect)} dpr=${after.dpr} viewport ${after.viewport.width}x${after.viewport.height} | image ${size.width}x${size.height} scale=${box.scale} | crop ${box.width}x${box.height} @ (${box.x},${box.y}) → ${out}`)
await client.close()
