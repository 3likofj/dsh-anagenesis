/**
 * Client half, part 6/9 — 把渲染层的样式表插进文档，并且只做这一件事。
 *
 * **这里曾经有一份自己的样式表，那是这一轮最严重的 bug 的来源。**
 * 渲染层（`src/render/*`）产出标记，`installStyles()` 却装的是这份手写的旧表：
 * 新标记里的 `.evo-card` / `.evo-pbar` / `.evo-svg` / `.evo-c-*` 一条规则都没有，
 * 于是仪表盘退化成"标签一行、值一行"的堆叠，图形节点也丢了颜色；更糟的是新标记用
 * `.evo-pane` 而旧表里叫 `.evo-body`，内容区因此没有 `flex:1 1 auto;min-height:0;
 * overflow:auto`，一整屏 3000px 的内容把窗口撑爆、页脚被顶到看不见的地方。
 *
 * 病根不是"少写了几条规则"，而是**同一个职责有两个所有者**：标记和样式表分别
 * 手写、靠人记住它们对得上。所以修法不是把旧表补全，而是把这份重复的表删掉 ——
 * 样式表的唯一所有者是 `src/render/20-theme.js` 的 `ANA_CSS`，窗口、离线预览、
 * 截图三处装的是同一份常量。
 *
 * 可逆性不变：整份样式是**一个** `<style>` 节点，激活时追加、卸载时按节点移除，
 * 没有改任何其他元素的 `style`，也没有往宿主节点上盖 class。
 */

/**
 * Insert the stylesheet and hand back the exact inverse.
 * @param {any} log
 * @returns {{ present: boolean, dispose: () => void }}
 */
function installStyles(log) {
  if (typeof document === 'undefined' || document === null || document.head === undefined || typeof document.createElement !== 'function') {
    log.push('styles.skipped', { reason: 'no document in this host' })
    return { present: false, dispose: () => {} }
  }
  const style = document.createElement('style')
  style.setAttribute(CSS_ATTR, 'styles')
  style.textContent = ANA_CSS
  document.head.appendChild(style)
  log.push('styles.inserted', { bytes: ANA_CSS.length, source: 'render/20-theme.js' })
  return {
    present: true,
    dispose: onceOnly(() => {
      // Remove exactly the node we added; never `querySelectorAll`, which could
      // hit a second instance's sheet during an HMR overlap.
      if (style.parentNode !== null && style.parentNode !== undefined) style.parentNode.removeChild(style)
      log.push('styles.removed', {})
    }, (error) => log.push('styles.dispose-error', { error: errorText(error) })),
  }
}