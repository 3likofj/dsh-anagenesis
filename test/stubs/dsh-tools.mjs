/**
 * Test-only host stub for `@deepseek-ai/dsh-tools`.
 *
 * Implements the parts of `defineTool` this plugin relies on, and the parts that
 * can actually fail at runtime: argument validation (required / enum / type) and
 * the tool shape `{ name, description, parameters, output, execute }`.
 *
 * The real contract was read out of the running harness
 * (`app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`, 0.2.0-rc.2):
 * `defineTool` compiles the simplified parameter spec to JSON Schema, validates
 * args, and does NOT validate the returned value against `output.schema`.
 * @module dsh-anagenesis/test/stubs/dsh-tools
 */

/**
 * @param {any} definition
 * @returns {any}
 */
export function defineTool(definition) {
  const spec = definition.parameters ?? {}
  return {
    name: definition.name,
    description: definition.description,
    /** Mirrors the real compiler: `parameterSchemaSpecToJsonSchema(spec)`. */
    parameters: compileParameterSchema(spec),
    parameterSpec: spec,
    output: definition.output,
    presentCall: definition.presentCall,
    presentResult: definition.presentResult,
    isConcurrencySafe: definition.isConcurrencySafe,
    /** @param {any} args */
    validate(args) {
      return validateArgs(spec, args ?? {})
    },
    /**
     * @param {any} args
     * @param {any} exec
     */
    async execute(args, exec) {
      const violations = validateArgs(spec, args ?? {})
      if (violations.length > 0) {
        throw new Error(`${definition.name}: invalid arguments: ${violations.join('; ')}`)
      }
      return definition.execute(args ?? {}, exec ?? {})
    },
  }
}

/**
 * @param {Record<string, any>} spec
 * @returns {{ type: 'object', properties: Record<string, any>, required?: string[] }}
 */
export function compileParameterSchema(spec) {
  /** @type {Record<string, any>} */
  const properties = {}
  const required = []
  for (const [name, def] of Object.entries(spec)) {
    if (def.required === true) required.push(name)
    if (def.type === 'json') {
      properties[name] = { description: def.description }
      continue
    }
    /** @type {any} */
    const node = { type: def.type ?? 'string' }
    if (def.description !== undefined) node.description = def.description
    if (def.enum !== undefined) node.enum = def.enum
    if (def.items !== undefined) {
      node.items = def.items.type === 'json' ? {} : { type: def.items.type }
    }
    properties[name] = node
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties }
}

/**
 * @param {Record<string, any>} spec
 * @param {Record<string, any>} args
 * @returns {string[]}
 */
export function validateArgs(spec, args) {
  const violations = []
  for (const [name, def] of Object.entries(spec)) {
    const value = args[name]
    if (value === undefined || value === null) {
      if (def.required === true) violations.push(`parameters.${name} is required`)
      continue
    }
    const type = def.type ?? 'string'
    if (type === 'json') continue
    if (type === 'array') {
      if (!Array.isArray(value)) violations.push(`parameters.${name} must be an array`)
      continue
    }
    if (type === 'integer') {
      if (!Number.isInteger(value)) violations.push(`parameters.${name} must be an integer`)
      continue
    }
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`parameters.${name} must be a number`)
      continue
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') violations.push(`parameters.${name} must be a boolean`)
      continue
    }
    if (typeof value !== 'string') {
      violations.push(`parameters.${name} must be a string`)
      continue
    }
    if (Array.isArray(def.enum) && !def.enum.includes(value)) {
      violations.push(`parameters.${name} must be one of ${def.enum.join(', ')}`)
    }
  }
  return violations
}
