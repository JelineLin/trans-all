/* Trans All — background service worker：消息路由、右键菜单、快捷键。 */
importScripts(
  '/src/shared/constants.js',
  '/src/shared/lang.js',
  '/src/shared/storage.js',
  '/src/shared/providers.js',
  '/src/shared/engine.js'
);

(function (TA) {
  'use strict';

  const MENU_PAGE = 'ta-translate-page';
  const MENU_SELECTION = 'ta-translate-selection';

  /* ---------------------------- 右键菜单 ---------------------------- */

  function setupMenus() {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_SELECTION,
        title: '翻译选中的文本',
        contexts: ['selection']
      });
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: '翻译 / 还原此页面',
        contexts: ['page']
      });
    });
  }

  chrome.runtime.onInstalled.addListener((details) => {
    setupMenus();
    if (details.reason === 'install') {
      chrome.runtime.openOptionsPage();
    }
  });
  chrome.runtime.onStartup.addListener(setupMenus);

  /**
   * 内容脚本不会进入「扩展加载之前就打开的标签页」，所以发送失败时先补注入再重试一次。
   * main.js 的 __taInjected 守卫保证重复注入无副作用。
   */
  async function sendToTab(tabId, message, frameId) {
    const options = frameId == null ? undefined : { frameId };
    try {
      return await chrome.tabs.sendMessage(tabId, message, options);
    } catch (_) {
      try {
        const entry = chrome.runtime.getManifest().content_scripts[0];
        const target = { tabId, allFrames: true };
        if (entry.css && entry.css.length) {
          await chrome.scripting.insertCSS({ target, files: entry.css });
        }
        await chrome.scripting.executeScript({ target, files: entry.js });
        return await chrome.tabs.sendMessage(tabId, message, options);
      } catch (__) {
        // chrome:// 等页面确实注入不了，静默忽略
      }
    }
  }

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id == null) return;
    if (info.menuItemId === MENU_PAGE) {
      sendToTab(tab.id, { type: TA.MSG.TOGGLE_PAGE });
    } else if (info.menuItemId === MENU_SELECTION) {
      sendToTab(tab.id, { type: TA.MSG.TRANSLATE_SELECTION }, info.frameId);
    }
  });

  /* ---------------------------- 快捷键 ---------------------------- */

  chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) return;
    if (command === 'toggle-page-translate') {
      sendToTab(tab.id, { type: TA.MSG.TOGGLE_PAGE });
    } else if (command === 'translate-selection') {
      // 快捷键没有 frameId；消息会广播到所有 frame，只有持有选区的 frame 会处理。
      sendToTab(tab.id, { type: TA.MSG.TRANSLATE_SELECTION, silentIfEmpty: true });
    }
  });

  /* ---------------------------- 消息路由 ---------------------------- */

  const handlers = {
    async [TA.MSG.GET_SETTINGS]() {
      return TA.storage.get();
    },

    async [TA.MSG.TRANSLATE_BATCH](payload) {
      const results = await TA.engine.translateBatch(payload.texts, {
        targetLang: payload.targetLang,
        providerId: payload.providerId
      });
      return { results };
    },

    async [TA.MSG.TEST_PROVIDER](payload) {
      const text = await TA.engine.testProvider(payload.provider);
      return { text };
    },

    async [TA.MSG.LIST_MODELS](payload) {
      const models = await TA.providers.listModels(payload.provider);
      return { models };
    },

    async [TA.MSG.OPEN_OPTIONS]() {
      chrome.runtime.openOptionsPage();
      return { ok: true };
    },

    async [TA.MSG.CLEAR_CACHE]() {
      TA.engine.clearCache();
      return { ok: true };
    },

    /** 新加载的子 frame 用顶层 frame 的状态补齐当前整页翻译状态。 */
    async [TA.MSG.GET_TAB_PAGE_STATE](payload, sender) {
      if (!sender.tab || sender.tab.id == null) return { active: false };
      try {
        const state = await chrome.tabs.sendMessage(
          sender.tab.id,
          { type: TA.MSG.GET_PAGE_STATE },
          { frameId: 0 }
        );
        return { active: !!(state && state.active) };
      } catch (_) {
        return { active: false };
      }
    },

    /** 顶层 frame 的自动翻译规则需要同步启动标签页内的所有 frame。 */
    async [TA.MSG.SET_TAB_PAGE_STATE](payload, sender) {
      if (!sender.tab || sender.tab.id == null) return { active: false };
      const active = !!(payload && payload.active);
      await chrome.tabs.sendMessage(sender.tab.id, {
        type: TA.MSG.SET_PAGE_STATE,
        active
      });
      return { active };
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = handlers[message && message.type];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));

    return true; // 异步响应
  });

  /* ---------------------------- 流式翻译端口 ---------------------------- */

  /**
   * 整页翻译走端口而不是 sendMessage：模型每译完一段就立刻推给页面渲染，
   * 不必等整批返回。这是速度体感的关键。
   */
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TA.BATCH_PORT) return;

    const controller = new AbortController();
    let closed = false;

    port.onDisconnect.addListener(() => {
      closed = true;
      controller.abort();
    });

    port.onMessage.addListener(async (message) => {
      if (!message || message.type !== 'start') return;

      try {
        const results = await TA.engine.translateBatch(message.texts, {
          targetLang: message.targetLang,
          providerId: message.providerId,
          signal: controller.signal,
          onSegment(index, text) {
            if (!closed) port.postMessage({ type: 'seg', index, text });
          }
        });
        if (!closed) port.postMessage({ type: 'done', results });
      } catch (err) {
        if (closed) return;
        port.postMessage({ type: 'error', error: (err && err.message) || String(err) });
      }
    });
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TA.STREAM_PORT) return;

    const controller = new AbortController();
    let closed = false;

    port.onDisconnect.addListener(() => {
      closed = true;
      controller.abort();
    });

    port.onMessage.addListener(async (message) => {
      if (!message || message.type !== 'start') return;

      try {
        const full = await TA.engine.translateStream(message.text, {
          targetLang: message.targetLang,
          providerId: message.providerId,
          signal: controller.signal,
          onDelta: (delta) => {
            if (!closed) port.postMessage({ type: 'delta', delta });
          }
        });
        if (!closed) port.postMessage({ type: 'done', text: full });
      } catch (err) {
        if (closed) return;
        if (err && err.name === 'AbortError') return;
        port.postMessage({ type: 'error', error: (err && err.message) || String(err) });
      }
    });
  });
})(globalThis.TA);
