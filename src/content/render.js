/* Trans All — 译文渲染：插入 / 替换 / 还原。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  const INLINE_UNIT_TAGS = new Set([
    'A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'LABEL', 'CITE', 'Q', 'ABBR'
  ]);

  // manifest 注入的 content.css 不会穿透页面 Shadow DOM；在开放式 Shadow Root
  // 内按需放一份局部样式，保证双语、替换与错误状态的行为和普通 DOM 一致。
  const SHADOW_STYLE = `
font.ta-target {
  display: block; margin-top: .28em; color: inherit; font: inherit;
  text-align: inherit; text-decoration: none; white-space: inherit;
}
font.ta-target.ta-inline { display: inline; margin: 0 0 0 .35em; }
font.ta-source { display: none !important; }
font.ta-target.ta-style-dashed { border-bottom: 1px dashed currentColor; padding-bottom: 1px; }
font.ta-target.ta-style-dotted { border-bottom: 1px dotted currentColor; padding-bottom: 1px; }
font.ta-target.ta-style-quote { border-left: 3px solid rgba(31,111,235,.55); padding-left: .6em; }
font.ta-target.ta-style-highlight { background-color: rgba(255,221,87,.28); border-radius: 3px; padding: 0 2px; }
font.ta-target.ta-style-dim { opacity: .72; }
font.ta-target.ta-style-blur { filter: blur(4px); transition: filter .18s ease; }
font.ta-target.ta-style-blur:hover { filter: none; }
font.ta-target.ta-error { color: #cf222e; font-size: .9em; opacity: .9; border-bottom: none; cursor: help; }
`;

  function ensureShadowStyle(unit) {
    const node = unit.nodes[0];
    const root = node && node.getRootNode ? node.getRootNode() : null;
    if (!root || !root.host || !root.querySelector) return;
    if (root.querySelector('style[data-ta-shadow-style]')) return;
    const style = doc(unit).createElement('style');
    style.setAttribute('data-ta-shadow-style', '');
    style.setAttribute('translate', 'no');
    style.textContent = SHADOW_STYLE;
    root.appendChild(style);
  }

  /** 对 document / element 以及其中所有开放式 Shadow Root 执行回调。 */
  function visitScopes(root, callback) {
    const scope = root || document;
    callback(scope);

    const elements = [];
    if (scope.nodeType === Node.ELEMENT_NODE) elements.push(scope);
    if (scope.querySelectorAll) elements.push(...scope.querySelectorAll('*'));

    elements.forEach((el) => {
      if (el.shadowRoot) visitScopes(el.shadowRoot, callback);
    });
  }

  function doc(unit) {
    const node = unit.nodes[0];
    return (node && node.ownerDocument) || document;
  }

  function isInlineUnit(unit) {
    if (!unit.wholeElement) return true;
    const el = unit.nodes[0];
    if (el.nodeType !== Node.ELEMENT_NODE) return true;
    // 外来元素的 tagName 不是大写，统一一下
    return INLINE_UNIT_TAGS.has(String(el.tagName).toUpperCase());
  }

  function createTarget(unit, settings) {
    const d = doc(unit);
    const el = d.createElement('font');
    el.className = 'ta-target ta-style-' + (settings.translationStyle || 'none');

    // 双语对照下有原文和译文两段，一律换行堆叠——这正是这个模式的名字所说的，
    // 而且行内会把按钮、导航项这类内联单元横向撑得很宽。
    // 替换模式只剩译文一段，应当原样占据原文的位置，所以保持行内。
    if (settings.displayMode === 'replace' && isInlineUnit(unit)) {
      el.classList.add('ta-inline');
    }
    el.setAttribute('translate', 'no');
    el.classList.add('notranslate');
    // 屏幕阅读器靠 lang 切换发音；不标的话会用页面语言（多半是英语）念中文，一句都听不懂
    if (settings.targetLang) el.setAttribute('lang', settings.targetLang);
    el.dataset.taId = String(unit.id);
    return el;
  }

  /** 把译文节点放到正确的位置 */
  function insertTarget(unit, target) {
    if (unit.wholeElement) {
      const el = unit.nodes[0];
      if (el.nodeType === Node.ELEMENT_NODE) {
        el.appendChild(target);
        return;
      }
    }
    const last = unit.nodes[unit.nodes.length - 1];
    const parent = last.parentNode;
    if (!parent) return;
    parent.insertBefore(target, last.nextSibling);
  }

  /** 替换模式：把原文包进隐藏容器 */
  function hideSource(unit) {
    if (unit.sourceWrapper && unit.sourceWrapper.isConnected) return;

    const d = doc(unit);
    let nodes;
    if (unit.wholeElement && unit.nodes[0].nodeType === Node.ELEMENT_NODE) {
      nodes = Array.prototype.slice.call(unit.nodes[0].childNodes).filter(
        (n) => !(n.nodeType === Node.ELEMENT_NODE && n.classList && n.classList.contains('ta-target'))
      );
    } else {
      nodes = unit.nodes.slice();
    }
    if (!nodes.length) return;

    const first = nodes[0];
    const parent = first.parentNode;
    if (!parent) return;

    const wrapper = d.createElement('font');
    wrapper.className = 'ta-source';
    wrapper.setAttribute('translate', 'no');
    parent.insertBefore(wrapper, first);
    nodes.forEach((n) => wrapper.appendChild(n));
    unit.sourceWrapper = wrapper;
  }

  function unwrap(wrapper) {
    const parent = wrapper.parentNode;
    if (!parent) return;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    parent.removeChild(wrapper);
    try {
      parent.normalize();
    } catch (_) {
      /* 忽略 */
    }
  }

  function showSource(unit) {
    if (unit.sourceWrapper) {
      unwrap(unit.sourceWrapper);
      unit.sourceWrapper = null;
    }
  }

  TA.render = {
    /** 显示“翻译中”占位 */
    loading(unit, settings) {
      TA.render.clear(unit, { keepSource: true });
      ensureShadowStyle(unit);
      const target = createTarget(unit, settings);
      target.classList.add('ta-loading');
      target.textContent = '翻译中…';
      insertTarget(unit, target);
      unit.target = target;
      unit.status = 'loading';
    },

    /** 写入译文 */
    apply(unit, translated, settings) {
      TA.render.clear(unit, { keepSource: true });
      ensureShadowStyle(unit);

      const target = createTarget(unit, settings);
      const fragment = TA.dom.buildFragment(translated, unit.placeholders, doc(unit));
      target.appendChild(fragment);
      insertTarget(unit, target);

      unit.target = target;
      unit.translated = translated;
      unit.status = 'done';

      if (settings.displayMode === 'replace') {
        hideSource(unit);
      } else {
        showSource(unit);
      }
    },

    /** 失败提示，鼠标悬停可看完整原因 */
    error(unit, message, settings) {
      TA.render.clear(unit, { keepSource: false });
      ensureShadowStyle(unit);
      const target = createTarget(unit, settings);
      target.classList.add('ta-error');
      target.textContent = '翻译失败：' + message;
      target.title = message;
      insertTarget(unit, target);
      unit.target = target;
      unit.status = 'error';
    },

    /** 移除该单元的译文（可选保留隐藏的原文包装） */
    clear(unit, opts) {
      if (unit.target && unit.target.parentNode) {
        unit.target.parentNode.removeChild(unit.target);
      }
      unit.target = null;
      if (!opts || !opts.keepSource) showSource(unit);
      unit.status = 'idle';
    },

    /** 整页还原 */
    clearAll(root) {
      visitScopes(root, (scope) => {
        scope.querySelectorAll('font.ta-target').forEach((el) => el.remove());
        scope.querySelectorAll('font.ta-source').forEach(unwrap);
        scope.querySelectorAll('style[data-ta-shadow-style]').forEach((el) => el.remove());
      });
    },

    /** 设置变化后就地更新样式类，无需重新请求 */
    restyle(settings) {
      const cls = 'ta-style-' + (settings.translationStyle || 'none');
      visitScopes(document, (scope) => {
        scope.querySelectorAll('font.ta-target').forEach((el) => {
          el.className = el.className.replace(/ta-style-[a-z]+/g, '').trim();
          el.classList.add('ta-target', cls);
        });
      });
    }
  };
})(globalThis.TA);
