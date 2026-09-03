/**
 * Host loader entry. This plugin is browser-only: the interesting half is
 * built to lib/client.js and served to the web GUI through the dsh.client
 * manifest in package.json.
 */
export const name = 'agent-status-indicator'

/** No host-side behavior. */
export function apply() {}
