// LIVE test (needs Safari Technology Preview): exercises the reader pool with
// concurrent reads, warm reuse, surplus disposal, and pool teardown.
import { planRead } from '../page-read.mjs'
import { createReaderPool } from '../reader-pool.mjs'

const pool = createReaderPool({
  driver: '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver',
  labelPrefix: 'DSH: ',
  maxIdle: 1,
  idleMs: 0,
  readTimeoutMs: 60_000,
  trace: (record) => console.log('  trace', JSON.stringify(record)),
  logger: console,
})
const t0 = Date.now()
const req = (url, format = 'markdown') => ({ ...planRead({ format }, true), url, waitMs: 0 })
const [a, b] = await Promise.all([
  pool.read(req('https://example.com')),
  pool.read(req('https://www.iana.org/', 'plainText')),
])
console.log(`concurrent reads done in ${Date.now() - t0} ms; stats after:`, pool.stats())
console.log('A:', a.title, '|', a.content.slice(0, 80).replace(/\n/g, ' '))
console.log('B:', b.title, '|', b.content.slice(0, 80).replace(/\n/g, ' '))
const t1 = Date.now()
const c = await pool.read(req('https://www.youtube.com/watch?v=QgH9sr7G13Q', 'markdown'))
console.log(`warm read done in ${Date.now() - t1} ms; stats:`, pool.stats())
console.log('C:', c.title, '| chars', c.content.length, '| has SECTIONS:', c.content.includes('SECTIONS'))
await pool.dispose()
console.log('disposed; stats:', pool.stats())
