#!/usr/bin/env node
// Thin stdio proxy in front of `safaridriver --mcp`.
//
// Safari labels each MCP automation window "This window is controlled by
// <name>." where <name> is the MCP handshake's `clientInfo.name` (the
// SAFARI_MCP_AGENT_NAME env var is only a fallback when no clientInfo is sent).
// DSH's MCP client hardcodes clientInfo, so this shim rewrites the single
// `initialize` request and passes every other byte through untouched. stdout
// and stderr are inherited (no buffering), stdin EOF closes the child's stdin
// (safaridriver exits within ~20 ms, which closes its window cleanly), and
// termination signals are forwarded.
//
//   node safari-mcp-shim.mjs --name "DSH: my chat" -- /path/to/safaridriver --mcp

import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const sep = argv.indexOf('--')
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: safari-mcp-shim.mjs [--name <agent name>] -- <command> [args…]')
  process.exit(64)
}
const nameIndex = argv.indexOf('--name')
const name = nameIndex >= 0 && nameIndex < sep ? argv[nameIndex + 1] : undefined
const [command, ...args] = argv.slice(sep + 1)

const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] })
child.on('error', (error) => {
  console.error(`safari-mcp-shim: ${String(error)}`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 128 : 1))
})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { child.kill(signal) })
}

/** Rewrite one newline-delimited JSON-RPC message when it is the initialize request. */
function rewrite(line) {
  if (name === undefined || !line.includes('"initialize"')) return line
  try {
    const message = JSON.parse(line)
    if (message.method === 'initialize' && message.params && typeof message.params === 'object') {
      message.params.clientInfo = { ...(message.params.clientInfo ?? {}), name, title: name }
      return JSON.stringify(message)
    }
  } catch {
    // Not a complete JSON object: pass through unchanged.
  }
  return line
}

let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  let newline
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    child.stdin.write(`${rewrite(line)}\n`)
  }
})
process.stdin.on('end', () => {
  if (pending.length > 0) child.stdin.write(rewrite(pending))
  child.stdin.end()
})
