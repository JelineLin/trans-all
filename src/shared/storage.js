/* Trans All — 设置读写。用 chrome.storage.local（API Key 不适合走 sync 同步）。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  let cache = null;
  const subscribers = [];

  // 任何上下文（popup / 设置页 / 内容脚本）写入后，其它上下文的缓存必须立刻失效，
  // 否则 service worker 会一直用旧的目标语言和提示词。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[TA.STORAGE_KEY]) return;
    cache = normalize(changes[TA.STORAGE_KEY].newValue);
    subscribers.forEach((cb) => {
      try {
        cb(cache);
      } catch (err) {
        console.error('[Trans All] 设置回调出错', err);
      }
    });
  });

  function normalize(raw) {
    const s = Object.assign({}, TA.DEFAULT_SETTINGS, raw || {});
    s.providers = Array.isArray(s.providers) ? s.providers : [];
    s.providers = s.providers.map((p) => Object.assign({}, TA.DEFAULT_PROVIDER, p));
    s.autoTranslateSites = Array.isArray(s.autoTranslateSites) ? s.autoTranslateSites : [];
    s.neverTranslateSites = Array.isArray(s.neverTranslateSites) ? s.neverTranslateSites : [];

    // activeProviderId 指向已删除的配置时回退到第一个
    if (!s.providers.some((p) => p.id === s.activeProviderId)) {
      s.activeProviderId = s.providers.length ? s.providers[0].id : null;
    }
    return s;
  }

  TA.storage = {
    async get() {
      if (cache) return cache;
      const raw = await chrome.storage.local.get(TA.STORAGE_KEY);
      cache = normalize(raw[TA.STORAGE_KEY]);
      return cache;
    },

    /** 浅合并保存；返回合并后的完整设置 */
    async patch(partial) {
      const current = await TA.storage.get();
      const next = normalize(Object.assign({}, current, partial));
      cache = next;
      await chrome.storage.local.set({ [TA.STORAGE_KEY]: next });
      return next;
    },

    async set(settings) {
      const next = normalize(settings);
      cache = next;
      await chrome.storage.local.set({ [TA.STORAGE_KEY]: next });
      return next;
    },

    /** 取当前生效的服务商配置，没有则返回 null */
    activeProvider(settings, overrideId) {
      const id = overrideId || settings.activeProviderId;
      return settings.providers.find((p) => p.id === id) || null;
    },

    /** 设置变更时回调（含其它页面写入触发的变更） */
    onChange(cb) {
      subscribers.push(cb);
    }
  };

  /** 站点规则匹配：支持精确 hostname 与 *.example.com 通配 */
  TA.matchSite = function (list, hostname) {
    if (!hostname) return false;
    return (list || []).some((rule) => {
      const r = String(rule).trim().toLowerCase();
      if (!r) return false;
      if (r.startsWith('*.')) {
        const base = r.slice(2);
        return hostname === base || hostname.endsWith('.' + base);
      }
      return hostname === r;
    });
  };
})(globalThis.TA);
