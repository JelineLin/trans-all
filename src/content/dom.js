/* Trans All — DOM 分析：把页面切成可翻译的“段落单元”，并保留内联结构。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  /** 整棵子树都不翻译 */
  const EXCLUDED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'FRAMESET',
    'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH', 'PRE', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION', 'OPTGROUP', 'AUDIO', 'VIDEO', 'HEAD', 'TITLE', 'META',
    'LINK', 'BASE', 'MAP', 'AREA', 'TRACK', 'SOURCE', 'PARAM', 'COL', 'COLGROUP'
  ]);

  /** 行内元素：出现在段落中不构成新的段落边界 */
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'BUTTON', 'CITE',
    'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INS', 'KBD',
    'LABEL', 'MARK', 'NOBR', 'OUTPUT', 'PICTURE', 'Q', 'RP', 'RT', 'RUBY',
    'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME',
    'TT', 'U', 'VAR', 'WBR',
    // 图标和公式经常夹在句子中间，当成块级会把句子劈成两段分别翻译
    'SVG', 'MATH'
  ]);

  /** 需要保留标签、但内部文字要翻译的行内元素 */
  const WRAP_TAGS = new Set([
    'A', 'ABBR', 'B', 'CITE', 'DEL', 'DFN', 'EM', 'I', 'INS', 'MARK', 'Q',
    'S', 'SMALL', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'U'
  ]);

  /** 原样保留、内部文字不翻译的行内元素 */
  const KEEP_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'IMG', 'PICTURE', 'RUBY']);

  /** 即使没有文字也要保留成占位的元素，否则译文里图标会消失 */
  const VISUAL_TAGS = new Set(['IMG', 'PICTURE', 'SVG', 'CANVAS', 'VIDEO', 'MATH']);

  const EXCLUDED_SELECTOR = [
    '[translate="no"]',
    '.notranslate',
    '[data-ta-ignore]',
    '.ta-target',
    '.ta-source',
    '.ta-ui',
    '[contenteditable="true"]',
    '[contenteditable=""]'
  ].join(',');

  let unitSeq = 0;
  let seenNodes = new WeakSet();

  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function isTextNode(node) {
    return node && node.nodeType === Node.TEXT_NODE;
  }

  function hasText(node) {
    return !!(node && node.textContent && node.textContent.trim());
  }

  /**
   * SVG / MathML 这类外来元素的 tagName 保留原始大小写（`svg` 而不是 `SVG`），
   * 只有 HTML 元素才一定是大写。不统一大小写的话整个 <svg> 子树会漏过排除检查。
   */
  function tagOf(el) {
    return el && el.tagName ? el.tagName.toUpperCase() : '';
  }

  function isInline(el) {
    return INLINE_TAGS.has(tagOf(el));
  }

  function isExcluded(el) {
    if (!isElement(el)) return false;
    if (EXCLUDED_TAGS.has(tagOf(el))) return true;
    if (el.isContentEditable) return true;
    try {
      if (el.matches(EXCLUDED_SELECTOR)) return true;
    } catch (_) {
      /* 极少数情况下选择器不被支持 */
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 提取：把单元内的节点序列变成带占位标签的纯文本
   * ------------------------------------------------------------------ */

  function extract(nodes) {
    const placeholders = [];
    let text = '';
    let plain = '';

    function pushKeep(node) {
      const idx = placeholders.length;
      placeholders.push({ kind: 'keep', node });
      text += `<x${idx}/>`;
    }

    function walk(node) {
      if (isTextNode(node)) {
        text += node.data;
        plain += node.data;
        return;
      }
      if (!isElement(node)) return;

      const tag = tagOf(node);
      if (tag === 'BR') {
        text += '\n';
        plain += '\n';
        return;
      }
      if (EXCLUDED_TAGS.has(tag) || isExcluded(node)) {
        if (hasText(node) || VISUAL_TAGS.has(tag)) pushKeep(node);
        return;
      }
      if (KEEP_TAGS.has(tag)) {
        pushKeep(node);
        return;
      }
      if (WRAP_TAGS.has(tag)) {
        const idx = placeholders.length;
        placeholders.push({ kind: 'wrap', node });
        text += `<i${idx}>`;
        for (const child of node.childNodes) walk(child);
        text += `</i${idx}>`;
        return;
      }
      // span / font / 其它容器：拍平，只保留文字
      for (const child of node.childNodes) walk(child);
    }

    for (const node of nodes) walk(node);

    return {
      text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
      plain: plain.replace(/\s+/g, ' ').trim(),
      placeholders
    };
  }

  /* ------------------------------------------------------------------ *
   * 回填：把译文里的占位标签还原成真实节点
   * ------------------------------------------------------------------ */

  /** 任何“长得像占位标签”的东西，宽松匹配：大小写、空格、斜杠位置都不计较 */
  const TOKEN_RE = /<\s*(\/?)\s*([ix])\s*(\d+)\s*(\/?)\s*>/gi;
  /** 输出被截断时末尾可能留下半个标签 */
  const TRUNCATED_RE = /<\s*\/?\s*[ix]\s*\d*\s*\/?\s*$/i;

  /**
   * 把译文里的占位标签还原成真实节点。
   *
   * 模型的输出并不规范：标签变大写、成对标签写成自闭合、漏掉闭合、闭合编号对不上、
   * 标签里多空格、编号越界、输出被截断——这些都真实出现过。所以这里用栈式扫描而不是
   * 严格配对的正则：凡是形状像占位标签的都会被消费掉，保证绝不会以文字形式漏到页面上。
   * 结构对不上时宁可丢标签、保文字。
   */
  function buildFragment(translated, placeholders, doc) {
    const source = String(translated || '').replace(TRUNCATED_RE, '');
    const root = doc.createDocumentFragment();
    // 栈底是最终结果，每遇到一个 <iN> 就压一层容器
    const stack = [{ node: root, idx: -1 }];
    const top = () => stack[stack.length - 1].node;
    const emit = (text) => {
      if (text) top().appendChild(doc.createTextNode(text));
    };
    const collapseTo = (depth) => {
      while (stack.length > depth) {
        const done = stack.pop();
        top().appendChild(done.node);
      }
    };

    const re = new RegExp(TOKEN_RE.source, 'gi');
    let last = 0;
    let m;

    while ((m = re.exec(source)) !== null) {
      emit(source.slice(last, m.index));
      last = m.index + m[0].length;

      const isClose = m[1] === '/';
      const kind = m[2].toLowerCase();
      const idx = Number(m[3]);
      const selfClosed = m[4] === '/';
      const ph = placeholders[idx];

      if (kind === 'x') {
        if (ph) top().appendChild(ph.node.cloneNode(true));
        continue; // 编号越界就当没这个占位，丢掉即可
      }

      if (selfClosed) continue; // <i0/>：成对标签被写成了自闭合，内容已丢，忽略

      if (!isClose) {
        // 浅克隆保留 href / class / style；编号无效时用文档片段当透明容器
        const container =
          ph && ph.kind === 'wrap' ? ph.node.cloneNode(false) : doc.createDocumentFragment();
        stack.push({ node: container, idx });
        continue;
      }

      // 闭合标签：找栈里最近的同编号层，容忍交叉嵌套与缺失的闭合
      let depth = -1;
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].idx === idx) {
          depth = i;
          break;
        }
      }
      if (depth === -1) continue; // 孤立闭合标签，丢弃
      collapseTo(depth);
    }

    emit(source.slice(last));
    collapseTo(1); // 收拢所有没闭合的层
    return root;
  }

  /* ------------------------------------------------------------------ *
   * 遍历：收集段落单元
   * ------------------------------------------------------------------ */

  /**
   * @param {Node} root
   * @param {{targetLang:string, minTextLength:number}} opts
   * @returns {Array} 单元列表
   */
  function collect(root, opts) {
    const units = [];

    function pushUnit(nodes, parent, wholeElement) {
      const first = nodes[0];
      if (!first || seenNodes.has(first)) return;

      // 整个元素就是一个段落时，提取它的**子节点**而不是它自己。
      // 否则 <a> / <strong> 这类元素会把自己变成 <i0> 占位，回填时被克隆成
      // 第二个按钮 / 链接，连站点样式一起复制过来。
      const source =
        wholeElement && isElement(first)
          ? Array.prototype.slice.call(first.childNodes)
          : nodes;
      const info = extract(source);
      if (!info.plain) return;
      if (!TA.shouldTranslate(info.plain, opts.targetLang, opts.minTextLength)) return;

      seenNodes.add(first);
      units.push({
        id: ++unitSeq,
        nodes,
        parent,
        /** true 表示整个元素就是一个段落，译文插到元素内部末尾 */
        wholeElement,
        text: info.text,
        plain: info.plain,
        placeholders: info.placeholders,
        status: 'idle',
        target: null,
        sourceWrapper: null
      });
    }

    /**
     * 容器里只有内联元素、没有散落文字时（按钮组、导航项、图标链接……），
     * 让每个内联元素各自成段——译文写进元素内部，而不是在它旁边克隆出
     * 第二个按钮 / 链接。返回 true 表示已处理。
     */
    function splitInlineChildren(children) {
      const hasLooseText = children.some((n) => isTextNode(n) && n.data.trim());
      if (hasLooseText) return false;

      const inlineEls = children.filter(
        (n) => isElement(n) && isInline(n) && hasText(n) && !isExcluded(n)
      );
      if (!inlineEls.length) return false;

      inlineEls.forEach(walkInlineUnit);
      return true;
    }

    /** 一路下钻到真正承载文字的那层内联元素 */
    function walkInlineUnit(el) {
      const children = Array.prototype.slice.call(el.childNodes);
      if (splitInlineChildren(children)) return;
      if (hasText(el)) pushUnit([el], el.parentNode, true);
    }

    function walk(el) {
      if (isExcluded(el)) return;

      const children = Array.prototype.slice.call(el.childNodes);
      const hasBlockChild = children.some(
        (n) => isElement(n) && !isInline(n) && hasText(n)
      );

      if (!hasBlockChild) {
        if (splitInlineChildren(children)) return;
        if (hasText(el)) pushUnit([el], el.parentNode, true);
        return;
      }

      let run = [];
      const flush = () => {
        if (run.length && run.some(hasText)) pushUnit(run, el, false);
        run = [];
      };

      for (const node of children) {
        if (isElement(node) && !isInline(node)) {
          flush();
          walk(node);
        } else if (isElement(node) || isTextNode(node)) {
          run.push(node);
        }
      }
      flush();
    }

    if (isElement(root)) {
      // 传入的根本身可能就是一个段落
      if (isInline(root)) {
        pushUnit([root], root.parentNode, true);
      } else {
        walk(root);
      }
    } else if (root) {
      Array.prototype.forEach.call(root.childNodes || [], (n) => {
        if (isElement(n)) walk(n);
      });
    }

    return units;
  }

  TA.dom = {
    collect,
    extract,
    buildFragment,
    isExcluded,
    /** 文本发生变化后允许对应单元再次进入收集结果。 */
    forget(unit) {
      const first = unit && unit.nodes && unit.nodes[0];
      if (first) seenNodes.delete(first);
    },
    /** 还原页面后重新开始时调用，让所有节点可以再次被收集 */
    reset() {
      seenNodes = new WeakSet();
    }
  };
})(globalThis.TA);
