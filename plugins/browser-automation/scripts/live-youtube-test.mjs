// LIVE (spawns STP): mcp__safari__get_youtube_notes through the plugin's real tool execute.
import * as plugin from '../index.js'
const defs = {}; const created = []; let unload
const cfg = plugin.Config({ chrome: { enabled: false }, safari: { reader: { idleMinutes: 0 } } })
const ctx = { logger: console, on: (e, cb) => { if (e === 'agent/created') created.push(cb) }, effect: (run, label) => { const d = run(); if (label === 'browser-automation.mounts') unload = d; return () => {} }, tools: { schemas: () => [] }, agents: { list: () => [] }, get: () => undefined }
plugin.apply(ctx, cfg)
const agent = { id: 's', session: { header: { cwd: '/tmp', delegationDepth: 0 } }, ctx: { tools: { register: (d) => { defs[d.name] = d; return () => {} } }, plugin: () => { throw new Error('no mount expected') } } }
created[0]({ agent })
const t0 = Date.now()
const notes = await defs.safari_get_youtube_notes.execute({ url: process.argv[2] ?? 'https://youtu.be/QgH9sr7G13Q' }, { agent })
console.log(`done in ${Date.now() - t0} ms`)
console.log(defs.safari_get_youtube_notes.output.render({}, notes)[0].text.split('\n').slice(0, 22).join('\n'))
console.log(`… description ${notes.description.length} chars, ${notes.links.length} links, keywords: ${notes.keywords.slice(0, 5).join(', ')}`)
await unload()
