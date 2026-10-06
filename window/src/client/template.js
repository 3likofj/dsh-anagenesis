/**
 * Client half — SOURCE TEMPLATE.
 *
 * This file is NOT shipped and is NOT executed: `tools/build-client.mjs` splices
 * `src/client/parts/*.js` into the parts marker below and writes `client.js`, which
 * is the artifact DSH serves. The reason for the split is a hard constraint of the
 * browser module system, not taste:
 *
 *   - the served bundle must be a **classic script** whose first statement is
 *     `window.__ModuleLoader__.load({ id, factory })`;
 *   - `id` must equal the package name (a bundle that loads without registering
 *     its id makes `dsh-client-modules` fail the combo);
 *   - the factory body may not use top-level `import`/`export`, and `require` is a
 *     closed table (the platform seed words plus `dsh.client.external`), so the
 *     parts cannot be separate modules — they share one factory scope.
 *
 * Everything below is inside the factory closure, so every module-body side effect
 * (the stylesheet, the seats, the timers) happens at materialisation and is owned
 * by the returned plugin's fiber. `client.js` is committed and `npm run check`
 * fails if it is stale with respect to these parts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-anagenesis-window',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // The platform seed table supplies React. Destructured defensively rather
    // than assumed: a host on an older React must still boot this half, and the
    // `useSyncExternalStore` fallback in part 7 exists for exactly that case.
    const react = require('react')
    const createElement = react.createElement
    const useEffect = react.useEffect
    const useRef = react.useRef
    const useState = react.useState
    const useSyncExternalStore = react.useSyncExternalStore

__PARTS__

    return module.exports
  },
})