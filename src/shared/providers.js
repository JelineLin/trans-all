/* Trans All — LLM 服务商适配层。只在 service worker / 设置页中使用（需要跨域 fetch）。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  const ANTHROPIC_VERSION = '2023-06-01';

  function trimSlash(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  function cleanHeaders(extra) {
    const out = {};
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (k && typeof v === 'string' && v.trim()) out[k] = v;
      }
    }
    return out;
  }

  /** 逐块读取 SSE，回调 (eventName, dataString) */
  async function readSSE(response, onEvent, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        if (signal && signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = '';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trim();
            else if (line.startsWith('event:')) event = line.slice(6).trim();
          }
          if (data) onEvent(event, data);
        }
      }
    } finally {
      try {
        reader.cancel();
      } catch (_) {
        /* 已关闭 */
      }
    }
  }

  async function readError(response) {
    let detail = '';
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        detail = json?.error?.message || json?.message || json?.error?.type || text;
      } catch (_) {
        detail = text;
      }
    } catch (_) {
      /* 无响应体 */
    }
    detail = String(detail || '').slice(0, 400);

    const err = new Error(`HTTP ${response.status}${detail ? ' · ' + detail : ''}`);
    // 带上状态码，调用方才能区分「限流/服务端抖动，该退避重试」和「密钥错了，重试也没用」
    err.status = response.status;
    const retryAfter = response.headers && response.headers.get && response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      // Retry-After 可能是秒数，也可能是 HTTP 日期
      err.retryAfterMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Math.max(0, new Date(retryAfter).getTime() - Date.now());
    }
    return err;
  }

  /* ------------------------------------------------------------------ *
   * OpenAI 兼容
   * ------------------------------------------------------------------ */
  const openai = {
    build(provider, { system, user, stream }) {
      const base = trimSlash(provider.baseUrl) || 'https://api.openai.com/v1';
      const body = {
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        stream: !!stream
      };
      if (typeof provider.temperature === 'number') body.temperature = provider.temperature;
      if (provider.maxTokens) body.max_tokens = provider.maxTokens;

      const headers = Object.assign(
        { 'content-type': 'application/json' },
        cleanHeaders(provider.extraHeaders)
      );
      // 本地 Ollama 之类可以不填 key
      if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;

      return { url: base + '/chat/completions', headers, body };
    },
    modelsRequest(provider) {
      const base = trimSlash(provider.baseUrl) || 'https://api.openai.com/v1';
      const headers = Object.assign({}, cleanHeaders(provider.extraHeaders));
      if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
      return { url: base + '/models', headers };
    },
    modelsParse(json) {
      return (json?.data || []).map((m) => m && m.id).filter(Boolean);
    },
    parse(json) {
      const msg = json?.choices?.[0]?.message;
      if (!msg) return '';
      if (typeof msg.content === 'string') return msg.content;
      // 少数服务返回分块内容数组
      if (Array.isArray(msg.content)) {
        return msg.content.map((c) => c?.text || '').join('');
      }
      return '';
    },
    delta(event, data) {
      if (data === '[DONE]') return null;
      try {
        const json = JSON.parse(data);
        return json?.choices?.[0]?.delta?.content || '';
      } catch (_) {
        return '';
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * Anthropic Claude
   * ------------------------------------------------------------------ */
  const anthropic = {
    build(provider, { system, user, stream }) {
      const base = trimSlash(provider.baseUrl) || 'https://api.anthropic.com';
      const body = {
        model: provider.model,
        max_tokens: provider.maxTokens || 4096,
        system,
        messages: [{ role: 'user', content: user }],
        stream: !!stream
      };
      // 注意：Claude Opus 5 / Opus 4.8 / 4.7 等模型已移除 temperature，传了会 400。
      // 这里一律不发送，翻译任务本身也不需要采样调节。

      const headers = Object.assign(
        {
          'content-type': 'application/json',
          'x-api-key': provider.apiKey || '',
          'anthropic-version': ANTHROPIC_VERSION,
          // 扩展的请求来源是 chrome-extension://，需要显式声明浏览器直连
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        cleanHeaders(provider.extraHeaders)
      );

      return { url: base + '/v1/messages', headers, body };
    },
    modelsRequest(provider) {
      const base = trimSlash(provider.baseUrl) || 'https://api.anthropic.com';
      return {
        url: base + '/v1/models?limit=100',
        headers: Object.assign(
          {
            'x-api-key': provider.apiKey || '',
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          cleanHeaders(provider.extraHeaders)
        )
      };
    },
    modelsParse(json) {
      return (json?.data || []).map((m) => m && m.id).filter(Boolean);
    },
    parse(json) {
      const blocks = json?.content;
      if (!Array.isArray(blocks)) return '';
      return blocks
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('');
    },
    delta(event, data) {
      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          return json.delta.text || '';
        }
        if (json.type === 'message_stop') return null;
        return '';
      } catch (_) {
        return '';
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * Google Gemini
   * ------------------------------------------------------------------ */
  const gemini = {
    build(provider, { system, user, stream }) {
      const base = trimSlash(provider.baseUrl) || 'https://generativelanguage.googleapis.com';
      const method = stream ? 'streamGenerateContent' : 'generateContent';
      const qs = stream ? '?alt=sse' : '';
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {}
      };
      if (typeof provider.temperature === 'number') {
        body.generationConfig.temperature = provider.temperature;
      }
      if (provider.maxTokens) body.generationConfig.maxOutputTokens = provider.maxTokens;

      const headers = Object.assign(
        {
          'content-type': 'application/json',
          'x-goog-api-key': provider.apiKey || ''
        },
        cleanHeaders(provider.extraHeaders)
      );

      return {
        url: `${base}/v1beta/models/${encodeURIComponent(provider.model)}:${method}${qs}`,
        headers,
        body
      };
    },
    modelsRequest(provider) {
      const base = trimSlash(provider.baseUrl) || 'https://generativelanguage.googleapis.com';
      return {
        url: base + '/v1beta/models?pageSize=200',
        headers: Object.assign(
          { 'x-goog-api-key': provider.apiKey || '' },
          cleanHeaders(provider.extraHeaders)
        )
      };
    },
    modelsParse(json) {
      return (json?.models || [])
        .filter((m) => {
          const methods = m && m.supportedGenerationMethods;
          return !methods || methods.includes('generateContent');
        })
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
    },
    parse(json) {
      const parts = json?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return '';
      return parts.map((p) => p?.text || '').join('');
    },
    delta(event, data) {
      try {
        const json = JSON.parse(data);
        const parts = json?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return '';
        return parts.map((p) => p?.text || '').join('');
      } catch (_) {
        return '';
      }
    }
  };

  const ADAPTERS = { openai, anthropic, gemini };

  TA.providers = {
    adapterFor(provider) {
      return ADAPTERS[provider?.type] || openai;
    },

    /** 配置是否完整可用 */
    validate(provider) {
      if (!provider) return '未选择 LLM 服务，请先在设置中添加并启用一个。';
      if (!provider.model) return `服务「${provider.name || provider.type}」未填写模型名称。`;
      if (!provider.apiKey && provider.type !== 'openai') {
        return `服务「${provider.name || provider.type}」未填写 API Key。`;
      }
      return null;
    },

    /**
     * 拉取该服务当前可用的模型列表。硬编码的预设列表迟早会过期，
     * 这里直接问服务商自己。
     * @returns {Promise<string[]>}
     */
    async listModels(provider, signal) {
      const adapter = TA.providers.adapterFor(provider);
      if (!adapter.modelsRequest) throw new Error('该接口类型不支持拉取模型列表');

      const req = adapter.modelsRequest(provider);
      const response = await fetch(req.url, { method: 'GET', headers: req.headers, signal });
      if (!response.ok) throw await readError(response);

      const models = adapter.modelsParse(await response.json());
      if (!models.length) throw new Error('接口没有返回任何模型');
      return models.sort((a, b) => a.localeCompare(b));
    },

    /**
     * 一次性（非流式）请求，返回完整文本。
     * @param {object} provider
     * @param {{system:string, user:string, signal?:AbortSignal}} opts
     */
    async complete(provider, opts) {
      const adapter = TA.providers.adapterFor(provider);
      const req = adapter.build(provider, { system: opts.system, user: opts.user, stream: false });

      const response = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: opts.signal
      });
      if (!response.ok) throw await readError(response);

      const json = await response.json();
      return adapter.parse(json);
    },

    /**
     * 流式请求，逐段回调增量文本，返回完整文本。
     * @param {object} provider
     * @param {{system:string, user:string, onDelta:(t:string)=>void, signal?:AbortSignal}} opts
     */
    async stream(provider, opts) {
      const adapter = TA.providers.adapterFor(provider);
      const req = adapter.build(provider, { system: opts.system, user: opts.user, stream: true });

      const response = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: opts.signal
      });
      if (!response.ok) throw await readError(response);
      if (!response.body) {
        // 打上标记，调用方据此退回一次性请求，而不是当成翻译失败
        const err = new Error('该服务未返回流式响应');
        err.code = 'NO_STREAM';
        throw err;
      }

      let full = '';
      await readSSE(
        response,
        (event, data) => {
          const piece = adapter.delta(event, data);
          if (piece === null) return; // 结束标记
          if (piece) {
            full += piece;
            opts.onDelta(piece);
          }
        },
        opts.signal
      );
      return full;
    }
  };
})(globalThis.TA);
