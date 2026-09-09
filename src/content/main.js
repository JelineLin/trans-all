/* Trans All — 内容脚本入口：初始化、消息处理、设置同步。 */
(function (TA) {
  'use strict';

  if (window.__taInjected) return;
  window.__taInjected = true;

  let settings = Object.assign({}, TA.DEFAULT_SETTINGS);
  const getSettings = () => settings;
  const isTopFrame = window.top === window;

  function hostname() {
    try {
      return location.hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  async function boot() {
    settings = await TA.storage.get();

    TA.ui.init();
    TA.page.init(getSettings, { showHud: isTopFrame });
    TA.selection.init(getSettings);

    TA.storage.onChange((next) => {
      const prev = settings;
      settings = next;
      TA.page.onSettingsChanged(prev, next);
    });

    if (isTopFrame) {
      const host = hostname();
      if (
        settings.enabled &&
        TA.matchSite(settings.autoTranslateSites, host) &&
        !TA.matchSite(settings.neverTranslateSites, host)
      ) {
        // 等首屏内容稳定一点，再让标签页内的所有 frame 一起开始翻译。
        setTimeout(async () => {
          try {
            await chrome.runtime.sendMessage({
              type: TA.MSG.SET_TAB_PAGE_STATE,
              payload: { active: true }
            });
          } catch (_) {
            // 后台刚好被回收时，至少保证顶层正文仍能翻译。
            TA.page.translate();
          }
        }, 300);
      }
    } else {
      // iframe 可能晚于整页翻译动作加载，启动后向顶层 frame 对齐状态。
      try {
        const response = await chrome.runtime.sendMessage({ type: TA.MSG.GET_TAB_PAGE_STATE });
        if (response && response.ok && response.data && response.data.active) {
          TA.page.translate();
        }
      } catch (_) {
        /* 顶层 frame 尚未就绪时保持原状，下一次整页动作仍会广播到这里 */
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    switch (message.type) {
      case TA.MSG.TOGGLE_PAGE:
        {
          const active = TA.page.toggle();
          if (isTopFrame) sendResponse({ ok: true, active });
        }
        return false;

      case TA.MSG.SET_PAGE_STATE:
        if (message.active) TA.page.translate();
        else TA.page.restore();
        if (isTopFrame) sendResponse({ ok: true, active: TA.page.isActive() });
        return false;

      case TA.MSG.GET_PAGE_STATE:
        if (isTopFrame) {
          sendResponse({ ok: true, active: TA.page.isActive(), host: hostname() });
        }
        return false;

      case TA.MSG.TRANSLATE_SELECTION: {
        const ok = TA.selection.translateCurrent();
        // 过去这里是静默失败的：快捷键确实到了，但没选中文字就什么都不发生，
        // 用户分不清是快捷键没生效还是选区没了
        if (!ok && !message.silentIfEmpty) {
          TA.ui.toast('没有选中的文本，请先选中再按快捷键');
        }
        if (ok || isTopFrame) {
          sendResponse({ ok, error: ok ? null : '请先选中要翻译的文本' });
        }
        return false;
      }

      default:
        return false;
    }
  });

  boot();
})(globalThis.TA);
