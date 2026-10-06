/**
 * Test-only host stub for `@deepseek-ai/schemastery`.
 *
 * The real package lives in the *running profile*, not in this repository, so a
 * plain `node --test` cannot resolve it. This stub implements the exact builder
 * surface the plugin uses (`object/string/number/boolean/array/any` + `default`
 * + `required`), and deliberately nothing else: if the plugin ever starts using
 * an API outside that surface, the adapter tests fail loudly instead of passing
 * against a permissive fake.
 *
 * Contract verified against schemastery 3.x README (`Schema.array(Schema.string()).default([])`,
 * `Schema.dict`, `Schema.any()`) and the copy installed at
 * `$DSH_PROFILE_DIR/node_modules/@deepseek-ai/schemastery`.
 * @module dsh-anagenesis/test/stubs/schemastery
 */

/**
 * @param {Record<string, any>} descriptor
 * @returns {any}
 */
function chain(descriptor) {
  /** @type {any} */
  const api = {
    descriptor,
    default(value) {
      return chain({ ...descriptor, default: value })
    },
    required() {
      return chain({ ...descriptor, required: true })
    },
    description(text) {
      return chain({ ...descriptor, description: text })
    },
    /** Mirrors schemastery's callable schema: `Config(config)` would validate. */
    call(config) {
      return config
    },
    toString() {
      return `<Schema ${descriptor.type}>`
    },
  }
  return api
}

const Schema = {
  any: () => chain({ type: 'any' }),
  string: () => chain({ type: 'string' }),
  number: () => chain({ type: 'number' }),
  natural: () => chain({ type: 'natural' }),
  boolean: () => chain({ type: 'boolean' }),
  array: (inner) => chain({ type: 'array', inner }),
  dict: (inner) => chain({ type: 'dict', inner }),
  object: (dict) => chain({ type: 'object', dict }),
  union: (list) => chain({ type: 'union', list }),
  const: (value) => chain({ type: 'const', value }),
}

export default Schema
export { Schema }
