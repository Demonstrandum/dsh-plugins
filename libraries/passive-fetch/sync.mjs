import { readFile, writeFile } from 'node:fs/promises'
const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
for (const name of ['anthropic-oauth-audit', 'billing-status']) {
  const destination = new URL(`../../plugins/${name}/passive-fetch.mjs`, import.meta.url)
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8') !== source) throw new Error(`Stale passive-fetch copy: ${name}; run node libraries/passive-fetch/sync.mjs`)
  } else await writeFile(destination, source)
}
console.log(process.argv.includes('--check') ? 'Passive fetch package copies match canonical source' : 'Generated both passive fetch package copies')
