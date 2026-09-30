// Decimal currency arithmetic. Rates and receipts are decimal strings; never sum floats.
const SCALE = 10n ** 24n
export function units(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,24})?$/.test(value)) return undefined
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(24, '0'))
}
export function decimal(value) {
  const whole = value / SCALE
  const fraction = (value % SCALE).toString().padStart(24, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}`
}
export function addAmounts(values) {
  let total = 0n
  for (const value of values) {
    const amount = units(value)
    if (amount === undefined) throw new TypeError('Invalid decimal amount')
    total += amount
  }
  return decimal(total)
}
export function priceUsage(usage, card) {
  if (!usage || !card || card.inputMode !== 'exclusive') return undefined
  const input = usage.inputTokens
  const output = usage.outputTokens
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  if (![input, output, read, write].every(n => Number.isSafeInteger(n) && n >= 0)) return undefined
  const uncached = card.inputMode === 'inclusive' ? input - read - write : input
  const totalInput = card.inputMode === 'inclusive' ? input : input + read + write
  if (uncached < 0 || !Number.isSafeInteger(totalInput) || (card.maxInputTokens !== undefined && totalInput > card.maxInputTokens)) return undefined
  const pairs = [[uncached, card.inputPerMillion], [output, card.outputPerMillion], [read, card.cacheReadPerMillion], [write, card.cacheWritePerMillion]]
  let total = 0n
  for (const [count, rate] of pairs) {
    if (count === 0) continue
    const perMillion = units(rate)
    if (perMillion === undefined) return undefined // Missing cache rate isn't zero.
    total += perMillion * BigInt(count) / 1_000_000n
  }
  // Reasoning is already included in output. Hosted tools/modalities aren't priced here.
  return { kind: 'estimated', amount: decimal(total), currency: card.currency, scope: 'model-tokens', pricingVersion: card.version }
}
export function validateRateCards(cards = []) {
  if (!Array.isArray(cards) || cards.length > 256) throw new TypeError('rateCards must be an array of at most 256 entries')
  const seen = new Set()
  return cards.map(card => {
    const allowed = ['provider','model','currency','version','source','inputMode','inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion','maxInputTokens']
    if (!card || typeof card !== 'object' || Object.keys(card).some(key => !allowed.includes(key))) throw new TypeError('Invalid rate card fields')
    for (const key of ['provider','model','version']) {
      if (typeof card[key] !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(card[key])) throw new TypeError(`Invalid rate card ${key}`)
    }
    if (card.provider.endsWith('-oauth') || card.provider === 'openai-codex') throw new TypeError('OAuth subscriptions cannot use API token rate cards')
    if (!/^[A-Z]{3}$/.test(card.currency ?? '')) throw new TypeError('Rate card needs an ISO currency')
    if (card.inputMode !== 'exclusive') throw new TypeError('DSH usage is disjoint: inputMode must be exclusive')
    if (typeof card.source !== 'string' || card.source.length > 512) throw new TypeError('Rate card must cite its HTTPS pricing source')
    const source = new URL(card.source)
    if (source.protocol !== 'https:' || source.username || source.password || source.search) throw new TypeError('Pricing source must be public HTTPS without credentials or query parameters')
    for (const key of ['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion']) {
      if (card[key] === undefined && key.startsWith('cache')) continue
      if (units(card[key]) === undefined || (card[key].split('.')[1]?.length ?? 0) > 18) throw new TypeError(`Invalid decimal rate ${key}`)
    }
    if (card.maxInputTokens !== undefined && (!Number.isSafeInteger(card.maxInputTokens) || card.maxInputTokens < 1)) throw new TypeError('Invalid pricing context limit')
    const identity = `${card.provider}/${card.model}`
    if (seen.has(identity)) throw new TypeError('Duplicate model rate card')
    seen.add(identity)
    return Object.freeze({ ...card })
  })
}
