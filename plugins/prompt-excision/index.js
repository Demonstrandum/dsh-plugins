import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { exciseAssembly, resolveConfig } from './excision.mjs'

export const name = 'prompt-excision'
export const inject = ['systemPrompt']
export { resolveConfig }

/** Cordis validates the provider mapping before activating this plugin. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'tali-prompt-excision',
    validate(input) {
      try { return { value: resolveConfig(input) } }
      catch (error) { return { issues: [{ message: error.message }] } }
    },
  },
}

/** Excise during assembly so normal DSH prompt admission logs the same text it sends. */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const providers = new Map(Object.entries(config.providers))
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return exciseAssembly(assembly, providers, renderPrompt)
  }, { prepend: true })
}
