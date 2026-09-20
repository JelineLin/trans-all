/* Trans All — 整页翻译：懒加载调度、批量请求、动态内容跟进。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  let getSettings = () => TA.DEFAULT_SETTINGS;
  let showHud = true;
  let active = false;

  let units = [];
  /*
   * 单元索引。MutationObserver 每条记录都要回答「哪些单元被波及」——
   * 之前是把 units 整个扫一遍做 containment 检查，5000 段的页面上一条记录 8ms，
   * 站点一次改 50 个小东西就是 400ms 主线程阻塞。
   * 改成从变动节点向上走祖先链查索引，开销只跟树深有关，跟页面大小无关。
   */
  let unitByNode = new WeakMap();      // 单元的每个节点 -> 单元
  let runUnitsByParent = new WeakMap(); // 散落文字单元的父元素 -> Set<单元>
  let pending = [];
  let inFlight = 0;

  let io = null;           // IntersectionObserver
  let mo = null;           // MutationObserver
  let anchorMap = new Map();
  let mutationRoots = new Set();
  let muted = false;       // 自己写 DOM 时屏蔽 MutationObserver
  let rescanTimer = null;
  /*
   * 待扫的子树。MutationObserver 本来就把新增节点交到手上了，
   * 之前却丢掉不用、每次重扫整个 body——页面越长越慢，是 O(n²) 的形状。
   * 无限滚动页面上实测差 140 倍（单次 35ms vs 0.25ms）。
   */
  let pendingRoots = new Set();
  // 变动面铺得太开时，逐棵扫反而不如整页扫一次划算
  const MAX_PENDING_ROOTS = 40;
  let scheduleTimer = null;
  const openPorts = new Set(); // 还原时要一并断开，停掉后台正在跑的请求
  let originalTitle = null;    // 标题被改过才需要还原

  const stats = { total: 0, done: 0, failed: 0 };

  /* ---------------------------- 工具 ---------------------------- */

  function anchorOf(unit) {
    if (unit.wholeElement && unit.nodes[0].nodeType === Node.ELEMENT_NODE) {
      return unit.nodes[0];
    }
    const parent = unit.parent;
    return parent && parent.nodeType === Node.ELEMENT_NODE ? parent : null;
  }

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    return el.getClientRects().length > 0;
  }

  /** 当前根节点之下直接可发现的开放式 Shadow Root。 */
  function childShadowRoots(root) {
    const elements = [];
    if (root && root.nodeType === Node.ELEMENT_NODE) elements.push(root);
    if (root && root.querySelectorAll) elements.push(...root.querySelectorAll('*'));
    return elements.map((el) => el.shadowRoot).filter(Boolean);
  }

  /**
   * 页面上是否已经有译文。
   *
   * 不能只信模块里的 active：内容脚本会被补注入（快捷键 / popup 在 sendMessage
   * 失败时会重新执行一遍脚本），而 __taInjected 守卫只挡住了 main.js，
   * page.js 的 active 会被重置成 false，可页面上的译文还挂着。
   * 这时再按一次快捷键就会叠加出第二份译文，所以判断要以 DOM 为准。
   */
  function hasTranslations() {
    function find(root) {
      if (root.querySelector('font.ta-target, font.ta-source')) return true;
      return childShadowRoots(root).some(find);
    }
    return find(document);
  }

  /** 包住所有 DOM 写操作，避免自己触发 MutationObserver */
  function write(fn) {
    muted = true;
    try {
      fn();
    } finally {
      if (mo) mo.takeRecords();
      muted = false;
    }
  }

  function updateHud() {
    if (!active || !showHud) return;
    const remaining = stats.total - stats.done - stats.failed;
    if (remaining > 0) {
      TA.ui.hud.update(`翻译中 ${stats.done}/${stats.total}`, false);
    } else if (stats.failed > 0) {
      TA.ui.hud.update(`已翻译 ${stats.done} 段 · ${stats.failed} 段失败`, true);
    } else {
      TA.ui.hud.update(`已翻译 ${stats.done} 段`, true);
    }
  }

  /* ---------------------------- 调度 ---------------------------- */

  function enqueue(unit) {
    if (unit.status !== 'idle' || unit.queued) return;
    unit.queued = true;
    pending.push(unit);
    stats.total += 1;
    updateHud();
    // 单元是逐个进入队列的（IntersectionObserver 逐条回调、扫描逐条产出）。
    // 立刻调度会让每段各发一个请求，合批就失效了，所以先攒一小会儿。
    requestSchedule();
  }

  function requestSchedule() {
    if (scheduleTimer) return;
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      schedule();
    }, 60);
  }

  function takeBatch(settings) {
    const batch = [];
    let chars = 0;
    while (pending.length && batch.length < settings.batchSize) {
      const unit = pending[0];
      const len = unit.text.length;
      if (batch.length && chars + len > settings.maxCharsPerBatch) break;
      pending.shift();
      unit.queued = false;
      unit.inFlight = true;
      batch.push(unit);
      chars += len;
    }
    return batch;
  }

  /*
   * 把攒好的段落切批发出去。这里不限并发：并发上限只在后台 engine 的 limiter 一处生效，
   * 它贴着 API 配额，也同时服务所有标签页和划词翻译。曾经页面侧也按 concurrency 限一次，
   * 两层各限一遍实际生效的是两者取小，调设置时行为跟直觉对不上。
   * 端口开多了不要紧：后台按 FIFO 排队，用户点「还原」时端口断开会连排队中的一起取消。
   */
  function schedule() {
    const settings = getSettings();
    while (active && pending.length) {
      const batch = takeBatch(settings);
      if (!batch.length) break;
      inFlight += 1;
      runBatch(batch, settings).finally(() => {
        inFlight -= 1;
        schedule();
        updateHud();
      });
    }
    updateHud();
  }

  /**
   * 跑一个批次。走端口而不是 sendMessage，因为后台会在每段译完时立刻推回来，
   * 这里收到一段就渲染一段——不显示任何“翻译中”占位，译文直接出现。
   */
  function runBatch(batch, settings) {
    return new Promise((resolve) => {
      const applied = new Array(batch.length).fill(false);
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };

      const applySeg = (index, text) => {
        const unit = batch[index];
        if (!unit || applied[index]) return;
        applied[index] = true;
        unit.inFlight = false;
        if (!active) return;
        if (unit.invalidated) {
          // 原文在请求途中发生变化；旧结果只结算计数，绝不能覆盖新正文。
          stats.done += 1;
          updateHud();
          return;
        }
        write(() => TA.render.apply(unit, text, getSettings()));
        stats.done += 1;
        updateHud();
      };

      /** 剩下没收到译文的段落，标记失败 */
      const failRest = (message) => {
        if (!active) return;
        const current = getSettings();
        write(() => {
          batch.forEach((unit, i) => {
            if (applied[i]) return;
            applied[i] = true;
            unit.inFlight = false;
            if (unit.invalidated) {
              stats.done += 1;
              return;
            }
            TA.render.error(unit, message, current);
            stats.failed += 1;
          });
        });
        // 配置没弄好时，「还原」帮不上忙——直接把用户送到设置页
        if (showHud) {
          if (/未选择 LLM 服务|未填写|API Key|401|403/.test(message)) {
            TA.ui.hud.setAction('打开设置', () => {
              chrome.runtime.sendMessage({ type: TA.MSG.OPEN_OPTIONS }).catch(() => {});
            });
          } else {
            TA.ui.hud.setAction('还原', restore);
          }
        }
        updateHud();
      };

      let port;
      try {
        port = chrome.runtime.connect({ name: TA.BATCH_PORT });
      } catch (_) {
        failRest('扩展已更新或被禁用，请刷新页面后重试');
        finish();
        return;
      }

      openPorts.add(port);

      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'seg') {
          applySeg(msg.index, msg.text);
        } else if (msg.type === 'done') {
          (msg.results || []).forEach((item, i) => {
            if (item && item.text) applySeg(i, item.text);
          });
          const stillMissing = msg.results && msg.results.find((r, i) => !applied[i]);
          if (stillMissing) failRest(stillMissing.error || '无译文返回');
          port.disconnect();
          openPorts.delete(port);
          finish();
        } else if (msg.type === 'error') {
          failRest(msg.error);
          port.disconnect();
          openPorts.delete(port);
          finish();
        }
      });

      port.onDisconnect.addListener(() => {
        openPorts.delete(port);
        // 后台被回收等异常断开：把还没落地的段落标记失败，避免卡住计数
        if (!finished) failRest('后台服务已断开，请重试');
        finish();
      });

      port.postMessage({
        type: 'start',
        texts: batch.map((u) => u.text),
        targetLang: settings.targetLang
      });
    });
  }

  /* ---------------------------- 扫描 ---------------------------- */

  function observeUnit(unit) {
    const anchor = anchorOf(unit);
    if (!anchor || !io) {
      enqueue(unit);
      return;
    }
    let set = anchorMap.get(anchor);
    if (!set) {
      set = new Set();
      anchorMap.set(anchor, set);
      io.observe(anchor);
    }
    set.add(unit);
  }

  function unobserveUnit(unit) {
    const anchor = anchorOf(unit);
    const set = anchor && anchorMap.get(anchor);
    if (!set) return;
    set.delete(unit);
    if (!set.size) {
      if (io) io.unobserve(anchor);
      anchorMap.delete(anchor);
    }
  }

  function scan(root) {
    const settings = getSettings();
    const found = TA.dom.collect(root, {
      targetLang: settings.targetLang,
      minTextLength: settings.minTextLength
    });
    if (!found.length) return;

    units = units.concat(found);
    found.forEach(indexUnit);
    found.forEach((unit) => {
      if (settings.lazyTranslate) {
        observeUnit(unit);
      } else if (isVisible(anchorOf(unit))) {
        enqueue(unit);
      } else {
        // 当前不可见（折叠菜单等），改为等它出现
        observeUnit(unit);
      }
    });
  }

  function observeMutationRoot(root) {
    if (!mo || !root || mutationRoots.has(root)) return;
    mo.observe(root, { childList: true, characterData: true, subtree: true });
    mutationRoots.add(root);
  }

  /** 扫描普通 DOM，并递归进入当前可访问的开放式 Shadow Root。 */
  function scanTree(root) {
    observeMutationRoot(root);
    scan(root);
    childShadowRoots(root).forEach(scanTree);
  }

  function indexUnit(unit) {
    unit.nodes.forEach((node) => unitByNode.set(node, unit));
    if (!unit.wholeElement && unit.parent) {
      let set = runUnitsByParent.get(unit.parent);
      if (!set) {
        set = new Set();
        runUnitsByParent.set(unit.parent, set);
      }
      set.add(unit);
    }
  }

  function unindexUnit(unit) {
    unit.nodes.forEach((node) => {
      if (unitByNode.get(node) === unit) unitByNode.delete(node);
    });
    if (!unit.wholeElement && unit.parent) {
      const set = runUnitsByParent.get(unit.parent);
      if (set) {
        set.delete(unit);
        if (!set.size) runUnitsByParent.delete(unit.parent);
      }
    }
  }

  /** 从节点沿祖先链向上找包着它的单元。单元互不嵌套，所以最多命中一个 */
  function enclosingUnit(node) {
    let cur = node;
    while (cur && cur.nodeType !== Node.DOCUMENT_NODE) {
      const unit = unitByNode.get(cur);
      if (unit) return unit;
      cur = cur.parentNode;
    }
    return null;
  }

  /** 被摘掉的子树里可能包着若干单元，逐个节点查索引；开销正比于被删的部分 */
  function unitsInside(root, out) {
    const unit = unitByNode.get(root);
    if (unit) out.add(unit);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    for (let child = root.firstChild; child; child = child.nextSibling) {
      unitsInside(child, out);
    }
  }

  /*
   * 一条变动记录波及了哪些单元。
   *
   * 方向性很要命：改动落在单元内部才算，落在祖先上的兄弟增删与本单元无关——
   * 曾经用双向的 containment 判断，往 body 里插任何一个节点，全页译文都被判失效重译。
   * 单元自身被摘掉时，record.target 是它原来的父节点，只能从 removedNodes 认。
   */
  function affectedUnits(record) {
    const hits = new Set();

    if (record.type === 'characterData') {
      const unit = enclosingUnit(record.target);
      if (unit) hits.add(unit);
      return hits;
    }

    // 变动发生在某个单元内部
    const enclosing = enclosingUnit(record.target);
    if (enclosing) hits.add(enclosing);

    // 散落文字单元由 parent 承载；parent 内的行内节点增删确实会改变这一段
    const runs = runUnitsByParent.get(record.target);
    if (runs) runs.forEach((unit) => hits.add(unit));

    // 被摘掉的节点：可能本身就是单元节点，也可能包着若干单元
    Array.from(record.removedNodes || []).forEach((removed) => unitsInside(removed, hits));

    return hits;
  }
  /** 原文变化时废弃旧单元；在途结果到达后会被识别为过期而丢弃。 */
  function invalidateUnits(changed) {
    if (!changed.size) return;

    changed.forEach((unit) => {
      unit.invalidated = true;
      unobserveUnit(unit);
      const index = pending.indexOf(unit);
      if (index >= 0) {
        pending.splice(index, 1);
        unit.queued = false;
        stats.total = Math.max(0, stats.total - 1);
      }
    });

    write(() => changed.forEach((unit) => TA.render.clear(unit)));
    changed.forEach((unit) => {
      TA.dom.forget(unit);
      unindexUnit(unit);
    });
    units = units.filter((unit) => !changed.has(unit));
  }

  function setupObservers() {
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const set = anchorMap.get(entry.target);
          io.unobserve(entry.target);
          anchorMap.delete(entry.target);
          if (set) set.forEach(enqueue);
        });
      },
      // 提前一屏开始翻译，滚动时不会看到空白
      { rootMargin: '800px 0px', threshold: 0 }
    );

    mo = new MutationObserver((records) => {
      if (muted || !active) return;

      let dirty = false;
      const changed = new Set();
      for (const record of records) {
        if (record.target && isOurs(record.target)) continue;

        let recordDirty = false;
        if (record.type === 'characterData') {
          recordDirty = true;
        } else {
          const nodes = [...record.addedNodes, ...record.removedNodes];
          recordDirty = nodes.some((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) {
              return false;
            }
            return !isOurs(node);
          });
        }

        if (recordDirty) {
          dirty = true;
          collectRoots(record);
          affectedUnits(record).forEach((unit) => changed.add(unit));
        }
      }
      if (!dirty) return;

      invalidateUnits(changed);

      // 失效的单元所在容器也要重扫，否则改过的段落再也不会被翻译
      changed.forEach((unit) => addRoot(unit.parent || unit.nodes[0]));

      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(rescan, 400);
    });
  }

  /** 把节点归一到最近的元素，并入待扫集合 */
  function addRoot(node) {
    let el = node;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentNode;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (isOurs(el)) return;
    pendingRoots.add(el);
  }

  function collectRoots(record) {
    if (record.type === 'characterData') {
      addRoot(record.target);
      return;
    }
    record.addedNodes.forEach(addRoot);
    // 删除节点本身已经不在树上了，要扫的是它原来所在的容器
    if (record.removedNodes.length) addRoot(record.target);
  }

  function rescan() {
    if (!active) return;

    const roots = [...pendingRoots].filter((el) => el.isConnected);
    pendingRoots = new Set();

    // 变动太散时整页扫一次更快；一个都没有就说明变动全落在我们自己的节点上
    if (!roots.length) return;
    if (roots.length > MAX_PENDING_ROOTS) {
      scanTree(document.body);
      return;
    }

    // 被别的待扫根包住的就不用单独扫了，dom.collect 的去重也依赖不到这一层
    roots
      .filter((el) => !roots.some((other) => other !== el && other.contains(el)))
      .forEach(scanTree);
  }

  function isOurs(node) {
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.id === 'ta-root') return true;
    // ta-source 包的是站点原文；站点更新其中的文字仍然需要触发重新翻译。
    return !!node.closest('.ta-target, #ta-root');
  }

  function teardownObservers() {
    if (io) {
      io.disconnect();
      io = null;
    }
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    anchorMap = new Map();
    mutationRoots = new Set();
    clearTimeout(rescanTimer);
    pendingRoots = new Set();
  }

  /* ---------------------------- 标题 ---------------------------- */

  /**
   * 标签页标题不在 body 里，扫描扫不到，但它恰恰是多标签时唯一的辨认依据。
   * 单独走一次普通消息即可，不值得为一段文字开端口。
   */
  async function translateTitle() {
    const settings = getSettings();
    const title = (document.title || '').trim();
    if (!title) return;
    if (!TA.shouldTranslate(title, settings.targetLang, settings.minTextLength)) return;

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: TA.MSG.TRANSLATE_BATCH,
        payload: { texts: [title], targetLang: settings.targetLang }
      });
    } catch (_) {
      return; // 标题翻译失败不值得打扰用户，正文才是主体
    }

    const translated = response && response.ok && (response.data.results[0] || {}).text;
    // 期间可能已经还原了，或者站点自己改了标题，两种情况都不该再覆盖
    if (!translated || !active || document.title.trim() !== title) return;
    originalTitle = document.title;
    document.title = translated;
  }

  function restoreTitle() {
    if (originalTitle == null) return;
    document.title = originalTitle;
    originalTitle = null;
  }

  /* ---------------------------- 对外 ---------------------------- */

  function translate() {
    if (active) return;
    // 模块状态丢过，但页面上还留着上一轮的译文：先清干净再翻，绝不叠加
    if (hasTranslations()) {
      write(() => TA.render.clearAll());
      TA.dom.reset();
    }
    active = true;
    units = [];
    unitByNode = new WeakMap();
    runUnitsByParent = new WeakMap();
    pending = [];
    inFlight = 0;
    stats.total = 0;
    stats.done = 0;
    stats.failed = 0;

    TA.dom.reset();
    if (showHud) TA.ui.hud.show('准备翻译…', '还原', restore);
    setupObservers();
    scanTree(document.body);
    translateTitle();

    if (showHud && !stats.total && !anchorMap.size) {
      TA.ui.hud.update('没有找到需要翻译的内容', true);
    }
  }

  function restore() {
    active = false;
    teardownObservers();
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
    pending = [];
    inFlight = 0;

    // 断开在途端口。后台那边的 onDisconnect 会 abort 掉正在跑的请求——
    // 用户已经点了还原，不该继续把这些 token 烧完。
    openPorts.forEach((port) => {
      try {
        port.disconnect();
      } catch (_) {
        /* 已断开 */
      }
    });
    openPorts.clear();

    write(() => TA.render.clearAll());
    units = [];
    unitByNode = new WeakMap();
    runUnitsByParent = new WeakMap();
    TA.dom.reset();
    restoreTitle();
    if (showHud) TA.ui.hud.hide();
  }

  TA.page = {
    init(settingsGetter, options) {
      getSettings = settingsGetter;
      showHud = !options || options.showHud !== false;
    },
    translate,
    restore,
    /** 内部计数快照，供排查与测试观察调度状态；不要据此做业务判断 */
    inspect() {
      return {
        units: units.length,
        pending: pending.length,
        inFlight,
        observedAnchors: anchorMap.size,
        done: stats.done,
        failed: stats.failed
      };
    },
    toggle() {
      // 只看 active 会漏掉「脚本被重新注入、状态丢了但译文还在」的情况，
      // 那时再按一次就变成叠加翻译，所以同时看 DOM
      if (active || hasTranslations()) restore();
      else translate();
      return active;
    },
    isActive() {
      return active || hasTranslations();
    },
    /** 设置变更：样式类可以就地更新，展示方式改变则整页重来 */
    onSettingsChanged(prev, next) {
      if (!active) return;
      if (
        prev.targetLang !== next.targetLang ||
        prev.displayMode !== next.displayMode
      ) {
        restore();
        translate();
      } else if (prev.translationStyle !== next.translationStyle) {
        write(() => TA.render.restyle(next));
      }
    }
  };
})(globalThis.TA);
