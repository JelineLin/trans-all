/* Trans All — 翻译引擎：提示词、分批协议、缓存、并发控制。运行在 service worker 中。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  const REQUEST_TIMEOUT = 90000;
  const CACHE_LIMIT = 3000;

  /* ---------------------------- 提示词 ---------------------------- */

  function baseRules(lang, custom) {
    const rules = [
      `You are a professional translation engine embedded in a browser extension.`,
      `Translate the user's content into ${lang}.`,
      ``,
      `Rules:`,
      `- Output the translation only. No explanations, no notes, no preamble.`,
      `- Preserve the original meaning, tone and register. The result must read naturally in ${lang}.`,
      `- Keep URLs, email addresses, code identifiers, file paths, numbers and units unchanged.`,
      `- Keep the original punctuation style appropriate for ${lang}.`,
      `- If a segment is already in ${lang}, repeat it unchanged.`,
      `- The text may contain two kinds of placeholder tags:`,
      `  <i0>…</i0> wraps words that carry inline markup — translate the words inside and`,
      `  reproduce the tag around the corresponding part of your translation.`,
      `  <x0/> stands for content that must not be translated (code, images) — reproduce the`,
      `  tag verbatim at the matching position.`,
      `  Copy every placeholder character for character: lowercase letter, same number, same`,
      `  opening and closing form. Never renumber, invent or drop one, and never turn a paired`,
      `  <i0>…</i0> into a self-closing <i0/>.`
    ];
    if (custom && custom.trim()) {
      rules.push('', 'Additional instructions from the user:', custom.trim());
    }
    return rules.join('\n');
  }

  function batchSystemPrompt(lang, custom) {
    return [
      baseRules(lang, custom),
      '',
      'The input contains multiple segments wrapped in seg tags:',
      '<seg id="1">first segment</seg>',
      '<seg id="2">second segment</seg>',
      '',
      'Translate each segment independently and output every segment in exactly the same',
      'format and order:',
      '<seg id="1">translation of the first segment</seg>',
      '<seg id="2">translation of the second segment</seg>',
      '',
      'Do not merge, split, reorder or omit segments. Output nothing outside the seg tags.'
    ].join('\n');
  }

  function singleSystemPrompt(lang, custom) {
    return baseRules(lang, custom);
  }

  /**
   * 划词翻译的提示词。
   *
   * 整页翻译要的是「只给译文、不要解释」，但划词是用户主动查东西的场景——
   * 选一个生词却只回一个对应词，等于没解释清楚。所以这里按选中内容的长短分开：
   * 词/短语给词典式的完整释义，整句则以译文为主、必要时补一句注解。
   */
  function selectionSystemPrompt(lang, custom) {
    const rules = [
      `You are a bilingual dictionary and translation assistant in a browser extension.`,
      `The user selected some text on a web page and wants to understand it in ${lang}.`,
      `Write your entire answer in ${lang}.`,
      ``,
      `If the selection is a single word or a short phrase, answer like a good dictionary entry:`,
      `- Give the most common sense first, then other distinct senses, one per line.`,
      `- Mark the part of speech for each sense.`,
      `- If it is an idiom, an abbreviation, a technical term or a proper noun, say what it`,
      `  actually refers to rather than translating it word by word.`,
      `- Finish with one short example sentence and its ${lang} translation.`,
      ``,
      `If the selection is a full sentence or longer, lead with a faithful, natural ${lang}`,
      `translation of the whole thing. Do not summarise and do not leave any part out.`,
      `After the translation, add a brief note only when something is genuinely easy to`,
      `misread — an idiom, a pun, a technical term, or a culture-specific reference.`,
      `If nothing needs explaining, stop after the translation.`,
      ``,
      `Use plain text with simple line breaks. No Markdown headings, no tables, no bullet`,
      `characters other than a leading "- ". Keep it tight: this is shown in a small popup.`
    ];
    if (custom && custom.trim()) {
      rules.push('', 'Additional instructions from the user:', custom.trim());
    }
    return rules.join('\n');
  }

  function buildBatchUser(items) {
    return items.map((it, i) => `<seg id="${i + 1}">${it.text}</seg>`).join('\n');
  }

  /* ---------------------------- 响应解析 ---------------------------- */

  const SEG_RE = /<seg\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/seg>/gi;

  function parseSegments(raw) {
    const out = new Map();
    if (!raw) return out;
    SEG_RE.lastIndex = 0;
    let m;
    while ((m = SEG_RE.exec(raw)) !== null) {
      const id = parseInt(m[1], 10);
      if (!Number.isNaN(id)) out.set(id, m[2].trim());
    }
    return out;
  }

  /** 模型偶尔会把整段回答包在代码块里，剥掉再解析 */
  function stripFence(text) {
    const t = String(text || '').trim();
    const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
    return m ? m[1] : t;
  }

  /* ---------------------------- 缓存 ---------------------------- */

  const cache = new Map();

  /*
   * MV3 的 service worker 空闲约 30 秒就被回收，纯内存缓存会随之清零——
   * 用户翻完一页去别处待一会儿再回来，同一页要重新付费翻一遍。
   * chrome.storage.session 正好是为这个场景准备的：内存级、跨 SW 重启存活、关浏览器清空。
   */
  const SESSION_KEY = 'ta_cache';
  let hydrated = false;
  let flushTimer = null;

  function sessionStore() {
    try {
      return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) || null;
    } catch (_) {
      return null;
    }
  }

  async function hydrateCache() {
    if (hydrated) return;
    hydrated = true;
    const store = sessionStore();
    if (!store) return;
    try {
      const raw = await store.get(SESSION_KEY);
      const entries = raw && raw[SESSION_KEY];
      if (!Array.isArray(entries)) return;
      entries.forEach(([key, value]) => {
        if (typeof key === 'string' && typeof value === 'string' && !cache.has(key)) {
          cache.set(key, value);
        }
      });
    } catch (_) {
      // 会话存储不可用（配额满、老版本浏览器）就退回纯内存，不影响功能
    }
  }

  /** 攒一会儿再整体写入，避免每译一段就落一次盘 */
  function scheduleFlush() {
    const store = sessionStore();
    if (!store || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      Promise.resolve()
        .then(() => store.set({ [SESSION_KEY]: Array.from(cache.entries()) }))
        .catch(() => {
          // 多半是超出配额；下次写入会带上更少的条目（LRU 已经淘汰过）
        });
    }, 2000);
  }

  function cacheKey(provider, lang, text) {
    return JSON.stringify([provider.id, provider.model, lang, text]);
  }

  function cacheGet(key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    // 命中后移到末尾，实现简易 LRU
    cache.delete(key);
    cache.set(key, value);
    return value;
  }

  function cacheSet(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
    scheduleFlush();
  }

  /* ---------------------------- 并发限制 ---------------------------- */

  class Limiter {
    constructor(max) {
      this.max = Math.max(1, max || 1);
      this.active = 0;
      this.queue = [];
    }
    setMax(max) {
      this.max = Math.max(1, max || 1);
      this._drain();
    }
    run(task) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task, resolve, reject });
        this._drain();
      });
    }
    _drain() {
      while (this.active < this.max && this.queue.length) {
        const { task, resolve, reject } = this.queue.shift();
        this.active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this._drain();
          });
      }
    }
  }

  const limiter = new Limiter(3);

  /* ---------------------------- 请求封装 ---------------------------- */

  /** 重试参数。设置页暂未暴露，测试会直接改这里把等待时间压短。 */
  const retry = { attempts: 3, baseDelayMs: 800, maxDelayMs: 30000 };

  function abortedError() {
    const err = new Error('已取消');
    err.name = 'AbortError';
    return err;
  }

  /**
   * 限流、服务端抖动、网络中断值得退避重试；
   * 密钥错、模型名写错这类 4xx 重试多少次结果都一样，立刻失败反而更快看到原因。
   */
  function isRetryable(err) {
    if (!err || err.name === 'AbortError' || err.retryable === false) return false;
    const status = err.status;
    if (status === 429 || status === 408 || status >= 500) return true;
    if (status) return false;
    return true; // 没有状态码 = 没走到 HTTP 层，多半是网络抖动
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortedError());
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(abortedError());
          },
          { once: true }
        );
      }
    });
  }

  /**
   * 超时和外部中止都要真正掐断 fetch。
   * 少了外部中止这一路，用户点「还原」之后后台请求会继续跑完，token 照烧。
   */
  async function callWithTimeout(fn, externalSignal) {
    if (externalSignal && externalSignal.aborted) throw abortedError();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT);
    const onAbort = () => controller.abort();
    if (externalSignal) externalSignal.addEventListener('abort', onAbort, { once: true });

    try {
      return await fn(controller.signal);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (!timedOut) throw abortedError(); // 外部取消，静默收场
        const timeout = new Error('请求超时（90 秒），可尝试降低批次大小或更换模型');
        timeout.retryable = false; // 再等 90 秒没有意义
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 退避重试。等待发生在并发闸门之外，避免重试期间白占一个名额；
   * 加抖动是为了防止同时撞限流的多个批次又一起重来。
   */
  async function withRetry(task, signal) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await task();
      } catch (err) {
        if (attempt >= retry.attempts || !isRetryable(err)) throw err;
        // 抖动按退避窗口成比例，而不是固定毫秒数——固定值在窗口很小时会喧宾夺主
        const backoff = Math.min(retry.baseDelayMs * Math.pow(2, attempt - 1), retry.maxDelayMs);
        const wait =
          err.retryAfterMs != null
            ? Math.min(err.retryAfterMs, retry.maxDelayMs)
            : backoff + Math.random() * backoff;
        await sleep(wait, signal);
      }
    }
  }

  async function translateOne(provider, systemPrompt, text, signal) {
    const raw = await withRetry(
      () =>
        limiter.run(() =>
          callWithTimeout(
            (s) => TA.providers.complete(provider, { system: systemPrompt, user: text, signal: s }),
            signal
          )
        ),
      signal
    );
    return stripFence(raw).trim();
  }

  /**
   * 流式跑一个批次，每当有 <seg> 闭合就立刻回调该段。
   *
   * 这是速度体感的关键：非流式要等整批（可能上千 token）全部生成完才有第一个字，
   * 流式则是第一段译完就能上屏。返回累积的完整原始响应，供收尾时兜底解析。
   */
  async function streamSegments(provider, system, user, onSeg, signal) {
    const re = new RegExp(SEG_RE.source, SEG_RE.flags);
    let buffer = '';
    let scanned = 0; // 已经解析过的位置，避免每次增量都重扫全文

    await TA.providers.stream(provider, {
      system,
      user,
      signal,
      onDelta(delta) {
        buffer += delta;
        re.lastIndex = scanned;
        let m;
        while ((m = re.exec(buffer)) !== null) {
          scanned = m.index + m[0].length;
          const id = parseInt(m[1], 10);
          if (!Number.isNaN(id)) onSeg(id, m[2].trim());
        }
      }
    });

    return buffer;
  }

  /* ---------------------------- 对外 API ---------------------------- */

  TA.engine = {
    /**
     * 批量翻译。texts 为原文数组，返回等长结果数组，每项为 { text } 或 { error }。
     *
     * opts.onSegment(index, text) 会在每段译完的瞬间被调用（缓存命中则立即调用），
     * 调用方据此逐段上屏，不必等整批完成。
     */
    async translateBatch(texts, opts) {
      const options = opts || {};
      await hydrateCache();
      const settings = await TA.storage.get();
      const provider = TA.storage.activeProvider(settings, options.providerId);
      const invalid = TA.providers.validate(provider);
      if (invalid) throw new Error(invalid);

      const targetLang = options.targetLang || settings.targetLang;
      const langName = TA.promptLangName(targetLang);
      const onSegment = typeof options.onSegment === 'function' ? options.onSegment : null;
      const signal = options.signal || null;
      limiter.setMax(settings.concurrency);

      const results = new Array(texts.length);
      const pending = [];

      texts.forEach((text, index) => {
        const key = cacheKey(provider, targetLang, text);
        const hit = cacheGet(key);
        if (hit !== undefined) {
          results[index] = { text: hit, cached: true };
          if (onSegment) onSegment(index, hit); // 缓存命中，直接上屏
        } else {
          pending.push({ index, text, key });
        }
      });

      if (!pending.length) return results;

      const batchSystem = batchSystemPrompt(langName, settings.customPrompt);
      const singleSystem = singleSystemPrompt(langName, settings.customPrompt);
      const settled = new Set();

      /** seg 的编号是 1 开始的批内序号 */
      const settle = (localId, value) => {
        if (!value || settled.has(localId)) return;
        const item = pending[localId - 1];
        if (!item) return;
        settled.add(localId);
        cacheSet(item.key, value);
        results[item.index] = { text: value };
        if (onSegment) onSegment(item.index, value);
      };

      let batchError = null;

      if (pending.length === 1) {
        // 单条时不套 seg 协议，减少模型出错的机会
        try {
          settle(1, await translateOne(provider, singleSystem, pending[0].text, signal));
        } catch (err) {
          batchError = err;
        }
      } else {
        const user = buildBatchUser(pending);
        try {
          const raw = await withRetry(
            () =>
              limiter.run(() =>
                callWithTimeout((s) => streamSegments(provider, batchSystem, user, settle, s), signal)
              ),
            signal
          );
          // 收尾再整体解析一遍：增量扫描可能漏掉被代码块包裹的部分
          parseSegments(stripFence(raw)).forEach((value, id) => settle(id, value));
        } catch (err) {
          if (err && err.code === 'NO_STREAM') {
            // 少数网关不支持 SSE，退回一次性请求
            try {
              const raw = await withRetry(
                () =>
                  limiter.run(() =>
                    callWithTimeout(
                      (s) => TA.providers.complete(provider, { system: batchSystem, user, signal: s }),
                      signal
                    )
                  ),
                signal
              );
              parseSegments(stripFence(raw)).forEach((value, id) => settle(id, value));
            } catch (fallbackErr) {
              batchError = fallbackErr;
            }
          } else {
            batchError = err;
          }
        }
      }

      if (signal && signal.aborted) return results;

      /*
       * 逐条补发只针对「请求成功、但模型漏了某几段」。
       * 请求本身就失败时不能补发——那会把一次限流放大成 N 次请求，
       * 用户看到满屏红字，配额也被打得更狠。
       */
      const missing = batchError
        ? []
        : pending
            .map((item, i) => ({ item, localId: i + 1 }))
            .filter(({ localId }) => !settled.has(localId));

      if (missing.length) {
        await Promise.all(
          missing.map(async ({ item, localId }) => {
            try {
              settle(localId, await translateOne(provider, singleSystem, item.text, signal));
            } catch (err) {
              item.error = err;
            }
          })
        );
      }

      pending.forEach((item, i) => {
        if (settled.has(i + 1)) return;
        const err = item.error || batchError;
        results[item.index] = { error: (err && err.message) || '模型未返回该段落的译文' };
      });

      return results;
    },

    /**
     * 流式翻译单段文本（划词翻译用）。
     * @returns {Promise<string>} 完整译文
     */
    async translateStream(text, opts) {
      const settings = await TA.storage.get();
      const provider = TA.storage.activeProvider(settings, opts && opts.providerId);
      const invalid = TA.providers.validate(provider);
      if (invalid) throw new Error(invalid);

      const targetLang = (opts && opts.targetLang) || settings.targetLang;
      // 只有划词翻译走这条流式路径，用词典式的详细提示词
      const system = selectionSystemPrompt(TA.promptLangName(targetLang), settings.customPrompt);

      return TA.providers.stream(provider, {
        system,
        user: text,
        onDelta: opts.onDelta,
        signal: opts.signal
      });
    },

    /** 设置页“测试连接”用 */
    async testProvider(provider) {
      const invalid = TA.providers.validate(provider);
      if (invalid) throw new Error(invalid);
      const text = await callWithTimeout((signal) =>
        TA.providers.complete(provider, {
          system: 'You are a translation engine. Output the translation only.',
          user: 'Translate into Simplified Chinese: Hello, world!',
          signal
        })
      );
      return stripFence(text).trim();
    },

    clearCache() {
      cache.clear();
      hydrated = false;
      clearTimeout(flushTimer);
      flushTimer = null;
      const store = sessionStore();
      if (store) Promise.resolve().then(() => store.remove(SESSION_KEY)).catch(() => {});
    },

    /** 重试参数，供测试与将来的设置项调整 */
    retry
  };
})(globalThis.TA);
