/**
 * tali-brand-kit — browser half.
 *
 * Reads `globalThis.__DSH_BRAND_KIT__` (published by the host half from the
 * validated config) and occupies the shell's brand cells for the parts that
 * are configured — all `single` slots, so registering replaces the shipped
 * fallback (whale / "DSH Local Build" + version chip) outright:
 *   - `sidebar.brand.mark`            the configured mark at the size the shell asks for
 *                                     (24px in the brand row and the collapsed rail);
 *   - `sidebar.brand.name`            the configured name (class `brand-kit-name`, typography
 *                                     from the host style row);
 *   - `conversation.hero.brand.mark`  the mark before the empty-session headline, in the
 *                                     shell's `className` so the headline geometry holds.
 * Mark modes: `mask` renders a span whose CSS mask is the file and whose
 * background is the text colour (theme-following, like the whale);
 * `image` renders the file as an <img>.
 *
 * The bundle's page in the Plugins panel gets a "Brand" card
 * (profiles-card.tsx, `plugins.bundle.config` keyed by the package name):
 * brand profiles — apply, new, duplicate, rename, export/import, edit.
 *
 * Two shipped strings have no slot and are locale-owned (`t('hero.headline')`,
 * `t('chat.deepDiving')`; one occupant per namespace), so their text nodes
 * are substituted in place: a MutationObserver on the document swaps each
 * shipped string for the configured one whenever its element mounts. React
 * only rewrites a text node when its string prop changes, and those props are
 * constant, so the swap holds.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only (erased): the slot declarations this plugin occupies, and `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Plugins panel's `plugins.bundle.config` slot.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { BrandProfilesCard } from './profiles-card.tsx'

export const inject = ['slots']

/** This package's name (package.json): the key of its configuration card on the Plugins page. */
const BUNDLE_NAME = 'tali-brand-kit'

/** The host half's payload ('' / null = that part keeps the shipped look). */
interface BrandKit {
  name: string
  headline: string
  turnStatus: string
  mark: { url: string, mode: 'mask' | 'image' } | null
}

declare global {
  // eslint-disable-next-line no-var
  var __DSH_BRAND_KIT__: BrandKit | undefined
}

/** Shipped strings and where their text node sits (mirrors SHIPPED in index.js). */
const SUBSTITUTIONS: { selector: string, shipped: string, key: 'headline' | 'turnStatus' }[] = [
  // EmptyHero: `<span class=titleGroup><span>{t('hero.headline')}</span>…`
  { selector: '[class*="_titleGroup"] > span:first-child', shipped: 'Into the Unknown', key: 'headline' },
  // ChatView: `<div class=turnStatus>{t('chat.deepDiving')}{clock?}</div>`
  { selector: '[class*="_turnStatus"]', shipped: 'Deep diving...', key: 'turnStatus' },
]

function Mark({ kit, size, className }: { kit: BrandKit['mark'] & object, size: number, className?: string }) {
  const cls = className === undefined ? 'brand-kit-mark' : `brand-kit-mark ${className}`
  if (kit.mode === 'image') return <img className={cls} src={kit.url} width={size} height={size} alt="" aria-hidden="true" />
  return <span className={cls} style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * Replace the shipped strings wherever they render, now and on every later
 * mount. Only the element's FIRST text node is touched (the turn status also
 * holds a clock span). Returns the disposer.
 */
function substituteTexts(kit: BrandKit): () => void {
  const active = SUBSTITUTIONS
    .map(rule => ({ ...rule, replacement: kit[rule.key] }))
    .filter(rule => rule.replacement !== '' && rule.replacement !== rule.shipped)
  if (active.length === 0) return () => {}
  const fix = (): void => {
    for (const rule of active) {
      for (const element of document.querySelectorAll(rule.selector)) {
        const node = element.firstChild
        if (node !== null && node.nodeType === Node.TEXT_NODE && node.nodeValue === rule.shipped) node.nodeValue = rule.replacement
      }
    }
  }
  const observer = new MutationObserver(fix)
  observer.observe(document.body, { childList: true, subtree: true })
  fix()
  return () => { observer.disconnect() }
}

/**
 * @param ctx - browser-plane plugin context.
 */
export function apply(ctx: Context): void {
  const kit: BrandKit = globalThis.__DSH_BRAND_KIT__ ?? { name: '', headline: '', turnStatus: '', mark: null }
  const mark = kit.mark
  if (mark !== null) {
    const SidebarMark = ({ size }: PropsRuntime<'sidebar.brand.mark'>) => <Mark kit={mark} size={size} />
    const HeroMark = ({ size, className }: PropsRuntime<'conversation.hero.brand.mark'>) => <Mark kit={mark} size={size} className={className} />
    ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, SidebarMark))
    ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HeroMark))
  }
  if (kit.name !== '') {
    const SidebarName = (_props: PropsRuntime<'sidebar.brand.name'>) => <span className="brand-kit-name">{kit.name}</span>
    ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, SidebarName))
  }
  ctx.effect(() => substituteTexts(kit))
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_NAME }, BrandProfilesCard))
}
