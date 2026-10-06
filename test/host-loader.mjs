/**
 * Registers the host-package stub hooks. Usage:
 *   node --import ./test/host-loader.mjs --test test/
 * @module dsh-anagenesis/test/host-loader
 */

import { register } from 'node:module'

register('./host-stub-hooks.mjs', import.meta.url)
