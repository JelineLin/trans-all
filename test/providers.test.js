'use strict';

/* 三家服务商适配：请求地址 / 鉴权头 / 响应解析 / 流式增量 / 模型列表。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/env');

const TA = load('shared/constants.js', 'shared/providers.js');

/** 拦下 fetch，把请求原样交出来 */
function captureRequest(payload) {
  let seen = null;
  global.fetch = async (url, init) => {
    seen = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, json: async () => payload };
  };
  return () => seen;
}

/** 把若干 SSE 事件拼成一个可读流 */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        cancel() {}
      })
    }
  };
}

const OPENAI = { id: 'a', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-v4-flash', temperature: 0.2, maxTokens: 1000 };
const ANTHROPIC = { id: 'b', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k-x', model: 'claude-opus-5', temperature: 0.2, maxTokens: 1000 };
const GEMINI = { id: 'c', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'g-x', model: 'gemini-2.5-flash', temperature: 0.2, maxTokens: 1000 };

/* ------------------------------ OpenAI 兼容 ------------------------------ */

test('OpenAI 兼容：请求地址与 Bearer 鉴权', async () => {
  const seen = captureRequest({ choices: [{ message: { content: '译文' } }] });
  const out = await TA.providers.complete(OPENAI, { system: 'S', user: 'U' });

  assert.equal(seen().url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(seen().headers.authorization, 'Bearer sk-x');
  assert.equal(seen().body.model, 'deepseek-v4-flash');
  assert.deepEqual(seen().body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' }
  ]);
  assert.equal(out, '译文');
});

test('OpenAI 兼容：没有 key 时不发鉴权头（本地 Ollama）', async () => {
  const seen = captureRequest({ choices: [{ message: { content: 'x' } }] });
  await TA.providers.complete(
    { id: 'o', type: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' },
    { system: 'S', user: 'U' }
  );
  assert.equal('authorization' in seen().headers, false);
});

test('OpenAI 兼容：流式增量拼接', async () => {
  global.fetch = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n'
    ]);

  const deltas = [];
  const full = await TA.providers.stream(OPENAI, { system: 'S', user: 'U', onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(full, '你好');
});

/* ------------------------------ Anthropic ------------------------------ */

test('Anthropic：Messages 接口、版本头与浏览器直连声明', async () => {
  const seen = captureRequest({ content: [{ type: 'text', text: '译文' }] });
  const out = await TA.providers.complete(ANTHROPIC, { system: 'S', user: 'U' });

  assert.equal(seen().url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen().headers['x-api-key'], 'k-x');
  assert.equal(seen().headers['anthropic-version'], '2023-06-01');
  // 扩展的请求来源是 chrome-extension://，缺这个头会被拒
  assert.equal(seen().headers['anthropic-dangerous-direct-browser-access'], 'true');
  // system 走带 cache_control 的块，服务端命中后按约 10% 计费
  assert.deepEqual(seen().body.system, [
    { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }
  ]);
  assert.equal(seen().body.max_tokens, 1000, 'max_tokens 是必填项');
  assert.equal(out, '译文');
});

test('Anthropic：不发送 temperature——Opus 5 等模型会因此报 400', async () => {
  const seen = captureRequest({ content: [{ type: 'text', text: 'x' }] });
  await TA.providers.complete(ANTHROPIC, { system: 'S', user: 'U' });
  assert.equal('temperature' in seen().body, false);
  assert.equal('top_p' in seen().body, false);
  assert.equal('top_k' in seen().body, false);
});

test('Anthropic：多个文本块拼接', async () => {
  captureRequest({ content: [{ type: 'text', text: '前' }, { type: 'thinking', thinking: '忽略' }, { type: 'text', text: '后' }] });
  assert.equal(await TA.providers.complete(ANTHROPIC, { system: 'S', user: 'U' }), '前后');
});

test('Anthropic：流式只取 text_delta', async () => {
  global.fetch = async () =>
    sseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"忽略"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ]);

  const deltas = [];
  const full = await TA.providers.stream(ANTHROPIC, { system: 'S', user: 'U', onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(full, '你好');
});

/* ------------------------------ Gemini ------------------------------ */

test('Gemini：地址带模型名，系统提示走 systemInstruction', async () => {
  const seen = captureRequest({ candidates: [{ content: { parts: [{ text: '译文' }] } }] });
  const out = await TA.providers.complete(GEMINI, { system: 'S', user: 'U' });

  assert.equal(seen().url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(seen().headers['x-goog-api-key'], 'g-x');
  assert.deepEqual(seen().body.systemInstruction, { parts: [{ text: 'S' }] });
  assert.equal(out, '译文');
});

test('Gemini：流式走 alt=sse', async () => {
  let url = '';
  global.fetch = async (u) => {
    url = u;
    return sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}\n\n']);
  };
  const full = await TA.providers.stream(GEMINI, { system: 'S', user: 'U', onDelta() {} });
  assert.match(url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(full, '好');
});

/* ------------------------------ 通用 ------------------------------ */

test('SSE 分包被截断时仍能正确解析', async () => {
  // 一个事件被拆成三个网络分片，中间还夹着 \r\n
  global.fetch = async () =>
    sseResponse(['data: {"choices":[{"delta":{"con', 'tent":"完整"}}]}\r\n', '\r\ndata: [DONE]\n\n']);

  const full = await TA.providers.stream(OPENAI, { system: 'S', user: 'U', onDelta() {} });
  assert.equal(full, '完整');
});

test('HTTP 错误带出服务商给的原因', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid API key' } })
  });
  await assert.rejects(
    () => TA.providers.complete(OPENAI, { system: 'S', user: 'U' }),
    (err) => /401/.test(err.message) && /Invalid API key/.test(err.message)
  );
});

test('响应体不是 JSON 时也能给出可读错误', async () => {
  global.fetch = async () => ({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });
  await assert.rejects(
    () => TA.providers.complete(OPENAI, { system: 'S', user: 'U' }),
    (err) => /502/.test(err.message) && /Bad Gateway/.test(err.message)
  );
});

test('配置校验：缺模型 / 缺 key 会被拦下', () => {
  assert.match(TA.providers.validate(null), /未选择/);
  assert.match(TA.providers.validate({ type: 'openai', model: '' }), /模型/);
  assert.match(TA.providers.validate({ type: 'anthropic', model: 'm', apiKey: '' }), /API Key/);
  // OpenAI 兼容允许空 key，本地服务用得上
  assert.equal(TA.providers.validate({ type: 'openai', model: 'm', apiKey: '' }), null);
});

/* ------------------------------ 模型列表 ------------------------------ */

test('拉取模型列表：三家的地址与解析', async () => {
  let url = '';
  global.fetch = async (u) => {
    url = u;
    if (u.includes('deepseek')) return { ok: true, json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-flash' }] }) };
    if (u.includes('anthropic')) return { ok: true, json: async () => ({ data: [{ id: 'claude-opus-5' }] }) };
    return {
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
        ]
      })
    };
  };

  const openai = await TA.providers.listModels(OPENAI);
  assert.match(url, /\/v1\/models$/);
  assert.deepEqual(openai, ['deepseek-chat', 'deepseek-v4-flash'], '结果要排序');

  await TA.providers.listModels(ANTHROPIC);
  assert.match(url, /api\.anthropic\.com\/v1\/models/);

  const gemini = await TA.providers.listModels(GEMINI);
  assert.deepEqual(gemini, ['gemini-2.5-pro'], '只保留支持 generateContent 的，且剥掉 models/ 前缀');
});

test('模型列表为空时报错而不是静默返回空下拉', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  await assert.rejects(() => TA.providers.listModels(OPENAI), /没有返回任何模型/);
});
