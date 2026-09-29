import { build, context } from 'esbuild'
import { readFileSync } from 'node:fs'
const name = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
const options = {
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', sourcemap: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
}
if (process.argv.includes('--watch')) { const worker = await context(options); await worker.watch() }
else await build(options)
