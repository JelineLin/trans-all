/* Trans All — 弹窗：快速开关与常用设置。 */
(function (TA) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    toggle: $('toggle'),
    hint: $('hint'),
    targetLang: $('targetLang'),
    displayMode: $('displayMode'),
    translationStyle: $('translationStyle'),
    provider: $('provider'),
    autoSite: $('autoSite'),
    neverSite: $('neverSite'),
    hostAuto: $('hostAuto'),
    hostNever: $('hostNever'),
    error: $('error'),
    openOptions: $('openOptions')
  };

  let settings = null;
  let tab = null;
  let host = '';
  let pageActive = false;
  let connected = false;
  let blockedReason = '';

  /** 各家应用商店同样禁止扩展注入脚本 */
  const STORE_URLS = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)/i;

  /** chrome:// edge:// 之类的页面禁止注入，任何扩展都做不到 */
  function isInjectable(url) {
    if (!url) return false;
    if (STORE_URLS.test(url)) return false;
    return /^(https?|file):/i.test(url);
  }

  /**
   * 内容脚本只会注入到「加载扩展之后」打开的页面，已经开着的标签页是没有的。
   * 这里按 manifest 里声明的文件补注入一次，省得用户去刷新。
   * main.js 有 __taInjected 守卫，重复注入是安全的。
   */
  async function injectContentScript(tabId) {
    const entry = chrome.runtime.getManifest().content_scripts[0];
    const target = { tabId, allFrames: true };
    if (entry.css && entry.css.length) {
      await chrome.scripting.insertCSS({ target, files: entry.css });
    }
    await chrome.scripting.executeScript({ target, files: entry.js });
  }

  async function ping(tabId) {
    try {
      return await chrome.tabs.sendMessage(
        tabId,
        { type: TA.MSG.GET_PAGE_STATE },
        { frameId: 0 }
      );
    } catch (_) {
      return null;
    }
  }

  function fillSelect(select, items, value) {
    select.innerHTML = '';
    items.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
    select.value = value;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = !message;
  }

  function renderToggle() {
    if (!connected) {
      el.toggle.disabled = true;
      el.toggle.textContent = '当前页面不可翻译';
      el.hint.textContent = blockedReason;
      return;
    }
    el.toggle.disabled = false;
    el.toggle.textContent = pageActive ? '还原原文' : '翻译此页面';
    el.toggle.classList.toggle('on', pageActive);
    el.hint.textContent = pageActive
      ? '滚动页面会继续翻译新出现的内容。'
      : '也可以按 Alt+A 直接切换。';
  }

  function renderRules() {
    const label = host || '此站点';
    el.hostAuto.textContent = label;
    el.hostNever.textContent = label;
    el.autoSite.checked = TA.matchSite(settings.autoTranslateSites, host);
    el.neverSite.checked = TA.matchSite(settings.neverTranslateSites, host);
    el.autoSite.disabled = !host;
    el.neverSite.disabled = !host;
  }

  function renderProviders() {
    el.provider.innerHTML = '';
    if (!settings.providers.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未配置 · 点右上角「设置」添加';
      el.provider.appendChild(option);
      el.provider.disabled = true;
      showError('还没有配置 LLM 服务，翻译无法工作。');
      return;
    }
    el.provider.disabled = false;
    settings.providers.forEach((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = `${p.name || p.type}（${p.model || '未填模型'}）`;
      el.provider.appendChild(option);
    });
    el.provider.value = settings.activeProviderId || '';
    showError('');
  }

  async function save(patch) {
    settings = await TA.storage.patch(patch);
  }

  function toggleInList(list, value, on) {
    const set = new Set(list || []);
    if (on) set.add(value);
    else set.delete(value);
    return Array.from(set);
  }

  async function init() {
    settings = await TA.storage.get();

    fillSelect(
      el.targetLang,
      TA.LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
      settings.targetLang
    );
    fillSelect(el.displayMode, TA.DISPLAY_MODES, settings.displayMode);
    fillSelect(el.translationStyle, TA.TRANSLATION_STYLES, settings.translationStyle);
    renderProviders();

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      try {
        host = new URL(tab.url).hostname.toLowerCase();
      } catch (_) {
        host = '';
      }
    }
    renderRules();

    if (tab && tab.id != null) {
      let state = await ping(tab.id);

      if (!state) {
        if (!isInjectable(tab.url)) {
          blockedReason = '浏览器内置页面与扩展商店禁止注入脚本。';
        } else {
          // 多半是这个标签页在扩展加载之前就开着，补注入一次即可
          try {
            await injectContentScript(tab.id);
            state = await ping(tab.id);
            if (!state) blockedReason = '脚本已注入但未响应，请刷新页面后重试。';
          } catch (err) {
            blockedReason = '无法注入脚本：' + (err.message || '请刷新页面后重试。');
          }
        }
      }

      connected = !!state;
      pageActive = !!(state && state.active);
      if (state && state.host) {
        host = state.host;
        renderRules();
      }
    } else {
      blockedReason = '没有找到活动标签页。';
    }
    renderToggle();
  }

  /* ---------------------------- 事件 ---------------------------- */

  el.toggle.addEventListener('click', async () => {
    if (!tab || tab.id == null) return;
    el.toggle.disabled = true;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: TA.MSG.SET_PAGE_STATE,
        active: !pageActive
      });
      pageActive = !!(res && res.active);
    } catch (err) {
      showError('无法与页面通信，请刷新后重试。');
    }
    renderToggle();
  });

  el.targetLang.addEventListener('change', () => save({ targetLang: el.targetLang.value }));
  el.displayMode.addEventListener('change', () => save({ displayMode: el.displayMode.value }));
  el.translationStyle.addEventListener('change', () =>
    save({ translationStyle: el.translationStyle.value })
  );
  el.provider.addEventListener('change', () => save({ activeProviderId: el.provider.value }));

  el.autoSite.addEventListener('change', async () => {
    if (!host) return;
    await save({
      autoTranslateSites: toggleInList(settings.autoTranslateSites, host, el.autoSite.checked)
    });
    if (el.autoSite.checked && el.neverSite.checked) {
      el.neverSite.checked = false;
      await save({
        neverTranslateSites: toggleInList(settings.neverTranslateSites, host, false)
      });
    }
  });

  el.neverSite.addEventListener('change', async () => {
    if (!host) return;
    await save({
      neverTranslateSites: toggleInList(settings.neverTranslateSites, host, el.neverSite.checked)
    });
    if (el.neverSite.checked && el.autoSite.checked) {
      el.autoSite.checked = false;
      await save({
        autoTranslateSites: toggleInList(settings.autoTranslateSites, host, false)
      });
    }
  });

  el.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  init();
})(globalThis.TA);
