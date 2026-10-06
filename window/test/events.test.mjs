/**
 * 事件接线 —— 这一组测试守的是"点了到底有没有反应"。
 *
 * 事故背景：工具条与内容都是 `dangerouslySetInnerHTML` 注入的 HTML，React 没有这些
 * 节点的 fiber；而 React 的 `onChange` 是**合成事件**，只对它自己注册过的表单元素
 * 合成。于是挂在窗口根节点上的 `onChange` 永远不会触发 —— 用户报的
 * 「图种 / 方向 / 宽度点不动」正是这三个 `data-ana-field` 控件。
 *
 * 原先的测试全都直接调用 `button.props.onClick()`（也就是绕过真实事件系统），
 * 所以 72 个测试没有一个能看见它。现在改成对一个**假节点**派发原生事件，
 * 走的就是浏览器里那条路。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRenderLayer } from '../tools/render-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const R = loadRenderLayer()

/** 一个只够用的假节点：记录监听器、能派发、能逆操作。 */
function fakeNode() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatch(type, event) {
      for (const fn of (listeners.get(type) ?? []).slice()) fn(event)
    },
    count() {
      let total = 0
      for (const list of listeners.values()) total += list.length
      return total
    },
    types: () => [...listeners.keys()].sort(),
  }
}

/** 一个记录调用的 engine 替身。 */
function fakeEngine() {
  const calls = []
  return {
    calls: calls,
    dispatch(action) {
      calls.push(['dispatch', action])
      return {}
    },
    setField(field, value) {
      calls.push(['setField', field, value])
      return {}
    },
    peek() {
      return { x: 12, y: 34 }
    },
  }
}

/** 一个像真实 DOM 那样的 target：支持 closest 与 getAttribute。 */
function targetFor(spec) {
  const attrs = spec.attrs ?? {}
  const chains = spec.closest ?? []
  return {
    value: spec.value,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    closest: (selector) => (chains.indexOf(selector) >= 0 ? { getAttribute: (name) => attrs[name] ?? null } : null),
  }
}

test('events: a native change on a data-ana-field control reaches the engine', () => {
  // 这就是用户点不动的那个控件：注入出来的 `<select data-ana-field="direction">`。
  const node = fakeNode()
  const engine = fakeEngine()
  const dispose = R.wireWindowEvents(node, engine)

  node.dispatch('change', { target: targetFor({ attrs: { 'data-ana-field': 'direction' }, value: 'TB' }) })
  assert.deepEqual(engine.calls, [['setField', 'direction', 'TB']], 'the select must reach setField through a NATIVE change')

  node.dispatch('change', { target: targetFor({ attrs: { 'data-ana-field': 'kind' }, value: 'lifecycle' }) })
  node.dispatch('change', { target: targetFor({ attrs: { 'data-ana-field': 'width' }, value: '120' }) })
  assert.deepEqual(engine.calls.slice(1), [['setField', 'kind', 'lifecycle'], ['setField', 'width', '120']])
  dispose()
})

test('events: a click on a data-ana-action button reaches the engine', () => {
  const node = fakeNode()
  const engine = fakeEngine()
  const dispose = R.wireWindowEvents(node, engine)

  node.dispatch('click', {
    target: targetFor({ attrs: { 'data-ana-action': 'view-graph' }, closest: ['[data-ana-action]'] }),
    preventDefault() {},
  })
  assert.deepEqual(engine.calls, [['dispatch', 'view-graph']])
  dispose()
})

test('events: clicks and changes outside a control are ignored', () => {
  const node = fakeNode()
  const engine = fakeEngine()
  const dispose = R.wireWindowEvents(node, engine)

  node.dispatch('click', { target: targetFor({}), preventDefault() {} })
  node.dispatch('change', { target: targetFor({}) })
  node.dispatch('change', { target: targetFor({ attrs: { 'data-ana-field': '' }, value: 'x' }) })
  assert.deepEqual(engine.calls, [], 'the listener must not invent an action')
  dispose()
})

test('events: dragging starts only on the drag bar, never on a control', () => {
  const node = fakeNode()
  const engine = fakeEngine()
  const started = []
  const dispose = R.wireWindowEvents(node, engine, {
    beginDrag: (event) => started.push(event.clientX),
    endDrag: () => started.push('end'),
  })

  const bar = targetFor({ closest: ['.ana-bar.ana-drag'] })
  node.dispatch('pointerdown', { button: 0, target: bar, clientX: 40 })
  assert.deepEqual(started, [40], 'the title bar starts a drag')

  // 工具栏里的按钮同样在 `.ana-bar` 里，但不是 `.ana-drag`，而且是一个控件。
  const button = targetFor({ closest: ['button,select,input'] })
  node.dispatch('pointerdown', { button: 0, target: button, clientX: 41 })
  assert.deepEqual(started, [40], 'a button inside a bar must not start a drag')

  node.dispatch('pointerdown', { button: 2, target: bar, clientX: 42 })
  assert.deepEqual(started, [40], 'a secondary button never drags')

  node.dispatch('pointerup', {})
  assert.deepEqual(started, [40, 'end'], 'and the drag can always be ended')
  dispose()
})

test('events: the disposer removes every listener it added', () => {
  const node = fakeNode()
  const engine = fakeEngine()
  const dispose = R.wireWindowEvents(node, engine)
  const before = node.count()
  assert.deepEqual(node.types(), ['change', 'click', 'pointerdown', 'pointerup'])
  assert.equal(before, 4)

  dispose()
  assert.equal(node.count(), 0, 'unmounting must leave no listener behind')
  node.dispatch('change', { target: targetFor({ attrs: { 'data-ana-field': 'width' }, value: '9' }) })
  assert.deepEqual(engine.calls, [], 'and nothing may fire afterwards')
})

test('events: a missing node is a no-op, not a crash', () => {
  // effect 在窗口关闭时也会跑一次（此时 ref 还是 null），这里必须安全。
  assert.equal(typeof R.wireWindowEvents(null, fakeEngine()), 'function')
  assert.equal(typeof R.wireWindowEvents(undefined, fakeEngine()), 'function')
  R.wireWindowEvents(null, fakeEngine())()
})

test('events: the bundled window wires natively instead of using React props', () => {
  // 回归护栏：如果谁把 onClick / onChange 属性加回窗口根节点，这条会红 ——
  // 那正是"注入的控件点不动"的成因。
  const source = readFileSync(resolve(here, '..', 'client.js'), 'utf8')
  assert.ok(source.includes('wireWindowEvents'), 'the window must wire its own events')
  assert.ok(!/role:\s*'dialog'[\s\S]{0,200}?onChange:/.test(source), 'the window root must not carry a React onChange')
  assert.ok(!/role:\s*'dialog'[\s\S]{0,200}?onClick:/.test(source), 'the window root must not carry a React onClick')
})