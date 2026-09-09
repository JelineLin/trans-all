/* Trans All — 划词翻译。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  const MAX_LENGTH = 5000;

  let getSettings = () => TA.DEFAULT_SETTINGS;
  let activePort = null;
  let lastRequest = null;

  /** 取当前选中的文本与位置，支持 input / textarea */
  function readSelection() {
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(active.type || 'text')))
    ) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start != null && end != null && end > start) {
        return {
          text: active.value.slice(start, end),
          rect: active.getBoundingClientRect()
        };
      }
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString();
    if (!text.trim()) return null;

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      const rects = range.getClientRects();
      rect = rects.length ? rects[rects.length - 1] : null;
    }
    // 拿不到位置不该导致整次翻译作废——退回到视口顶部居中，
    // 否则用户按了快捷键却什么都没发生，也看不出原因
    if (!rect) {
      const half = Math.min(210, window.innerWidth / 2);
      rect = {
        left: window.innerWidth / 2 - half,
        right: window.innerWidth / 2 + half,
        top: 72,
        bottom: 96
      };
    }

    return { text, rect };
  }

  function closePort() {
    if (activePort) {
      try {
        activePort.disconnect();
      } catch (_) {
        /* 已断开 */
      }
      activePort = null;
    }
  }

  /** 通过端口流式接收译文 */
  function startTranslation(text, rect) {
    const settings = getSettings();
    lastRequest = { text, rect };

    TA.ui.openPanel(rect, {
      original: text,
      // 超长会被截断，必须说出来——否则用户以为翻全了，其实后半段根本没送出去
      meta:
        text.length > MAX_LENGTH
          ? `→ ${TA.langName(settings.targetLang)} · 已截断至前 ${MAX_LENGTH} 字`
          : `→ ${TA.langName(settings.targetLang)}`,
      onRetry: () => startTranslation(text, rect)
    });

    closePort();

    let port;
    try {
      port = chrome.runtime.connect({ name: TA.STREAM_PORT });
    } catch (err) {
      TA.ui.errorPanel('扩展已更新或被禁用，请刷新页面后重试。');
      return;
    }
    activePort = port;

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'delta') {
        TA.ui.appendDelta(msg.delta);
      } else if (msg.type === 'done') {
        TA.ui.finishPanel(msg.text);
        closePort();
      } else if (msg.type === 'error') {
        TA.ui.errorPanel(msg.error);
        closePort();
      }
    });

    port.onDisconnect.addListener(() => {
      if (activePort === port) activePort = null;
    });

    port.postMessage({
      type: 'start',
      text: text.slice(0, MAX_LENGTH),
      targetLang: settings.targetLang
    });
  }

  function onMouseUp(event) {
    if (TA.ui.isOwn(event.target)) return;

    const settings = getSettings();
    if (settings.triggerMode === 'off') return;

    // 等浏览器完成选区更新
    setTimeout(() => {
      const picked = readSelection();
      if (!picked) {
        TA.ui.hideTrigger();
        return;
      }
      if (settings.triggerMode === 'instant') {
        startTranslation(picked.text, picked.rect);
      } else {
        TA.ui.showTrigger(picked.rect, () => startTranslation(picked.text, picked.rect));
      }
    }, 0);
  }

  function onMouseDown(event) {
    if (TA.ui.isOwn(event.target)) return;
    TA.ui.hideTrigger();
    if (TA.ui.isPanelOpen()) {
      TA.ui.hidePanel();
      closePort();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      TA.ui.hideTrigger();
      if (TA.ui.isPanelOpen()) {
        TA.ui.hidePanel();
        closePort();
      }
    }
  }

  TA.selection = {
    init(settingsGetter) {
      getSettings = settingsGetter;
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      TA.ui.onPanelClose = closePort;
    },

    /** 快捷键 / 右键菜单入口：忽略触发模式设置 */
    translateCurrent() {
      const picked = readSelection();
      if (!picked) return false;
      startTranslation(picked.text, picked.rect);
      return true;
    },

    /** 供页面翻译使用：中止当前划词请求 */
    abort: closePort,

    hasLast() {
      return !!lastRequest;
    }
  };
})(globalThis.TA);
