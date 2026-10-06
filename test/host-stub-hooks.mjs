/**
 * Redirect the two host packages this plugin imports to local test stubs.
 *
 * The plugin's own modules never import a host package (that is the whole point
 * of the core/adapter split), so only the three adapter rows need this mapping.
 * Run the suite with:
 *
 *   node --import ./test/host-loader.mjs --test test/
 *
 * @module dsh-anagenesis/test/host-stub-hooks
 */

const MAP = new Map([
  ['@deepseek-ai/schemastery', new URL('./stubs/schemastery.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-tools', new URL('./stubs/dsh-tools.mjs', import.meta.url).href],
])

/**
 * @param {string} specifier
 * @param {any} context
 * @param {(specifier: string, context: any) => Promise<any>} next
 */
export async function resolve(specifier, context, next) {
  const mapped = MAP.get(specifier)
  if (mapped !== undefined) return { url: mapped, shortCircuit: true }
  return next(specifier, context)
}
