'use strict';

/* 翻译引擎：分批协议、漏段重试、缓存、错误隔离。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, settingsWithProvider } = require('./helpers/env');

const TA = load('shared/constants.js', 'shared/lang.js', 'shared/storage.js', 'shared/providers.js', 'shared/engine.js');

/** 每个用例都从干净的设置与缓存开始 */
async function reset(overrides) {
  await TA.storage.set(settingsWithProvider(overrides));
  TA.engine.clearCache();
  // 真等指数退避会让整个测试跑好几分钟
  Object.assign(TA.engine.retry, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 });
}

/** 按 </seg> 切成多个 SSE 分片，让增量解析器真的分批看到内容 */
function sseChunks(text) {
  const pieces = [];
  const re = /[\s\S]*?<\/seg>/g;
  let m;
  let last = 0;
  while ((m = re.exec(text)) !== null) {
    pieces.push(m[0]);
    last = re.lastIndex;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return (pieces.length ? pieces : [text])
    .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    .concat('data: [DONE]\n\n');
}

/**
 * 假的 LLM，记录每次请求的 user 内容。
 *
 * 多段批次走流式（引擎要逐段上屏），单段走非流式，所以同一个响应对象
 * 两条路径都要能用。reply 返回 { status, message } 则模拟 HTTP 错误。
 */
function mockLLM(reply) {
  const calls = [];
  global.fetch = async (url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    calls.push(user);

    const out = reply(user, calls.length);
    if (out && typeof out === 'object') {
      return {
        ok: false,
        status: out.status,
        text: async () => JSON.stringify({ error: { message: out.message } })
      };
    }

    const chunks = sseChunks(out);
    let i = 0;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: out } }] }),
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length
              ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
              : { done: true, value: undefined },
          cancel() {}
        })
      }
    };
  };
  return calls;
}

/** 把 <seg> 协议里的每段按 fn 翻译后原样组装回去 */
function segEcho(fn) {
  return (user) =>
    user.replace(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g, (_, id, text) => `<seg id="${id}">${fn(text)}</seg>`);
}

test('多段走 seg 协议，一次请求解决', async () => {
  await reset();
  const calls = mockLLM(segEcho((t) => '译:' + t));

  const out = await TA.engine.translateBatch(['alpha', 'beta', 'gamma'], {});
  assert.equal(calls.length, 1, '三段应合并成一次请求');
  assert.match(calls[0], /<seg id="1">alpha<\/seg>/);
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta', '译:gamma']);
});

test('单段不套 seg 协议，减少模型出错机会', async () => {
  await reset();
  const calls = mockLLM(() => '直接译文');

  const out = await TA.engine.translateBatch(['only one'], {});
  assert.equal(calls[0], 'only one', '单段应原样发送');
  assert.equal(out[0].text, '直接译文');
});

test('模型漏掉的段落逐条重试补齐', async () => {
  await reset();
  // 第一次批量请求故意丢掉第 2 段
  const calls = mockLLM((user, n) => {
    if (n === 1) return '<seg id="1">译:alpha</seg><seg id="3">译:gamma</seg>';
    return '补:' + user;
  });

  const out = await TA.engine.translateBatch(['alpha', 'beta', 'gamma'], {});
  assert.equal(calls.length, 2, '应为漏掉的那段补发一次');
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '补:beta', '译:gamma']);
});

test('单段失败不影响同批其它段落', async () => {
  await reset();
  // 批量请求只回了第 1 段，补发第 2 段时撞上限流
  mockLLM((user, n) =>
    n === 1 ? '<seg id="1">译:alpha</seg>' : { status: 429, message: 'Rate limited' }
  );

  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(out[0].text, '译:alpha');
  assert.equal(out[1].text, undefined);
  assert.match(out[1].error, /429|Rate limited/);
});

test('逐段推送：先译完的段落立刻上屏，不等整批结束', async () => {
  await reset();
  mockLLM(segEcho((t) => '译:' + t));

  const pushed = [];
  const out = await TA.engine.translateBatch(['alpha', 'beta', 'gamma'], {
    onSegment: (index, text) => pushed.push([index, text])
  });

  assert.deepEqual(pushed, [[0, '译:alpha'], [1, '译:beta'], [2, '译:gamma']]);
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta', '译:gamma']);
});

test('缓存命中的段落也会立刻推送，不会静默跳过', async () => {
  await reset();
  mockLLM(segEcho((t) => '译:' + t));
  await TA.engine.translateBatch(['alpha', 'beta'], {});

  const pushed = [];
  await TA.engine.translateBatch(['alpha', 'beta'], {
    onSegment: (index, text) => pushed.push([index, text])
  });
  assert.deepEqual(pushed, [[0, '译:alpha'], [1, '译:beta']]);
});

test('同一段落不会被推送两次（增量扫描 + 收尾整体解析）', async () => {
  await reset();
  mockLLM(segEcho((t) => '译:' + t));

  const counts = new Map();
  await TA.engine.translateBatch(['alpha', 'beta'], {
    onSegment: (index) => counts.set(index, (counts.get(index) || 0) + 1)
  });
  assert.deepEqual([...counts.values()], [1, 1], '每段只能上屏一次');
});

test('整批请求失败时每段都带上原因', async () => {
  await reset();
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.ok(out.every((r) => /500/.test(r.error)), '每段都应有可读的失败原因');
});

test('相同原文命中缓存，不重复请求', async () => {
  await reset();
  const calls = mockLLM(segEcho((t) => '译:' + t));

  await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 1);

  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 1, '第二次应全部命中缓存');
  assert.ok(out.every((r) => r.cached));
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta']);
});

test('缓存只对未命中的部分发起请求', async () => {
  await reset();
  const calls = mockLLM((user) => (user.includes('<seg') ? segEcho((t) => '译:' + t)(user) : '译:' + user));

  await TA.engine.translateBatch(['alpha'], {});
  await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'beta', '只该发送没缓存过的那段');
});

test('切换目标语言后缓存不串味', async () => {
  await reset();
  const calls = mockLLM(() => '译文');

  await TA.engine.translateBatch(['alpha'], { targetLang: 'zh-CN' });
  await TA.engine.translateBatch(['alpha'], { targetLang: 'ja' });
  assert.equal(calls.length, 2, '不同目标语言必须分开缓存');
});

test('提示词里带上目标语言与用户自定义要求', async () => {
  await reset({ customPrompt: '术语一律保留英文原文' });
  let system = '';
  global.fetch = async (url, init) => {
    system = JSON.parse(init.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
  };

  await TA.engine.translateBatch(['alpha'], { targetLang: 'ja' });
  assert.match(system, /Japanese/);
  assert.match(system, /术语一律保留英文原文/);
  assert.match(system, /<i0>/, '必须说明占位标签规则');
});

/*
 * 划词翻译与整页翻译的提示词必须分开：
 * 整页要「只给译文」，划词是用户主动查东西，只回一个对应词等于没解释清楚。
 */
test('划词翻译用词典式提示词，不沿用整页那套「只给译文」', async () => {
  await reset();
  let system = '';
  global.fetch = async (url, init) => {
    system = JSON.parse(init.body).messages[0].content;
    return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
  };

  await TA.engine.translateStream('serendipity', { targetLang: 'zh-CN', onDelta() {} });

  assert.match(system, /dictionary/i, '应要求词典式释义');
  assert.match(system, /part of speech/i, '应标注词性');
  assert.match(system, /example sentence/i, '应给例句');
  assert.match(system, /Simplified Chinese/, '解释本身也要用目标语言');
  assert.equal(/Output the translation only/.test(system), false, '不该沿用整页的静默规则');
});

// 读音按源语言选记法，而且只给词和短语：整句标音标只会把译文挤得看不清
test('划词释义第一行给读音，整句不加', async () => {
  await reset();
  let system = '';
  global.fetch = async (url, init) => {
    system = JSON.parse(init.body).messages[0].content;
    return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
  };

  await TA.engine.translateStream('serendipity', { targetLang: 'zh-CN', onDelta() {} });

  assert.match(system, /headword and its pronunciation, before any sense/, '读音应在释义之前');
  assert.match(system, /IPA/, '英语等用国际音标');
  assert.match(system, /British and American/, '英美读音不同时都给');
  assert.match(system, /Pinyin with tone marks/, '汉语用带声调的拼音');
  assert.match(system, /kana/, '日语用假名读音');
  assert.match(system, /rather than guess/, '不确定时省略，不要编');
  assert.match(system, /Do not add pronunciation to sentences/, '整句不加音标');
});

test('整页翻译仍然只要译文，不受划词提示词影响', async () => {
  await reset();
  let system = '';
  global.fetch = async (url, init) => {
    system = JSON.parse(init.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
  };

  await TA.engine.translateBatch(['alpha'], {});
  assert.match(system, /Output the translation only/);
  assert.equal(/dictionary/i.test(system), false);
});

test('划词提示词也带上用户的自定义要求', async () => {
  await reset({ customPrompt: '术语保留英文原文' });
  let system = '';
  global.fetch = async (url, init) => {
    system = JSON.parse(init.body).messages[0].content;
    return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
  };

  await TA.engine.translateStream('alpha', { targetLang: 'zh-CN', onDelta() {} });
  assert.match(system, /术语保留英文原文/);
});

test('未配置服务商时给出可操作的提示', async () => {
  await TA.storage.set(Object.assign({}, TA.DEFAULT_SETTINGS, { providers: [], activeProviderId: null }));
  TA.engine.clearCache();
  await assert.rejects(() => TA.engine.translateBatch(['alpha'], {}), /未选择 LLM 服务/);
});

test('模型把整段回复包进代码块时能剥掉', async () => {
  await reset();
  mockLLM(() => '```xml\n<seg id="1">译:alpha</seg>\n<seg id="2">译:beta</seg>\n```');
  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta']);
});

test('seg 解析容忍单引号与多余空格', async () => {
  await reset();
  mockLLM(() => "<seg id='1' >译:alpha</seg>\n<seg  id = \"2\">译:beta</seg>");
  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta']);
});

test('译文里的占位标签原样保留，不被引擎吃掉', async () => {
  await reset();
  mockLLM(segEcho(() => '访问 <i0>网站</i0> <x1/>'));
  const out = await TA.engine.translateBatch(['a', 'b'], {});
  assert.equal(out[0].text, '访问 <i0>网站</i0> <x1/>');
});

/* ------------------------------------------------------------------ *
 * 中止：用户点「还原」或关标签页后，后台不能继续烧 token
 * ------------------------------------------------------------------ */

test('中止信号会真的掐断请求，不再继续发', async () => {
  await reset();
  const controller = new AbortController();
  let started = 0;

  global.fetch = async (url, init) => {
    started += 1;
    // 请求发出后随即被取消，模拟用户点了「还原」
    controller.abort();
    const aborted = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return err;
    };
    // signal 可能在挂监听之前就已经 aborted，必须先查一次，否则永远等不到事件
    if (init.signal.aborted) throw aborted();
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(aborted()), { once: true });
    });
  };

  const out = await TA.engine.translateBatch(['alpha', 'beta', 'gamma'], {
    signal: controller.signal
  });

  assert.equal(started, 1, '取消之后不该再发起补发请求');
  assert.ok(out.every((r) => !r.text), '取消时不产出译文');
});

test('已经取消的信号不会发出任何请求', async () => {
  await reset();
  const controller = new AbortController();
  controller.abort();

  let started = 0;
  global.fetch = async () => {
    started += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
  };

  await TA.engine.translateBatch(['alpha', 'beta'], { signal: controller.signal });
  assert.equal(started, 0);
});

/* ------------------------------------------------------------------ *
 * 限流：退避重试，而且不能把一次限流放大成 N 次请求
 * ------------------------------------------------------------------ */

test('撞 429 后退避重试，第二次成功就正常出译文', async () => {
  await reset();
  const calls = mockLLM((user, n) =>
    n === 1 ? { status: 429, message: 'Rate limited' } : segEcho((t) => '译:' + t)(user)
  );

  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 2, '应重试一次');
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta']);
});

test('限流重试耗尽后，不再逐条补发放大请求量', async () => {
  await reset();
  // 8 段的批次持续撞 429
  const calls = mockLLM(() => ({ status: 429, message: 'Rate limited' }));
  const texts = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'];

  const out = await TA.engine.translateBatch(texts, {});

  // 修复前：1 次批量 + 8 次逐条补发 = 9 次，等于对着限流的接口猛打
  assert.equal(calls.length, retryAttempts(), `只应有 ${retryAttempts()} 次退避重试，实际 ${calls.length} 次`);
  assert.ok(out.every((r) => /429|Rate limited/.test(r.error)), '每段都要带上限流原因');
});

function retryAttempts() {
  return TA.engine.retry.attempts;
}

test('鉴权失败这类 4xx 不重试，立刻把原因抛给用户', async () => {
  await reset();
  const calls = mockLLM(() => ({ status: 401, message: 'Invalid API key' }));

  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 1, '401 重试没有意义，不该重试');
  assert.ok(out.every((r) => /401|Invalid API key/.test(r.error)));
});

test('模型漏段仍然逐条补发（这条路径不受限流修复影响）', async () => {
  await reset();
  const calls = mockLLM((user, n) =>
    n === 1 ? '<seg id="1">译:alpha</seg>' : '补:' + user
  );

  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 2, '请求成功但漏了段，应该补发');
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '补:beta']);
});

/* ------------------------------------------------------------------ *
 * 缓存持久化
 *
 * MV3 的 service worker 随时会被回收，纯内存缓存等于没有；
 * chrome.storage.session 又会在关浏览器时清空。现在落在 storage.local，
 * 带 7 天 TTL，第二天重读同一篇文章不用重新付费。
 * ------------------------------------------------------------------ */

const { chromeMock } = require('./helpers/env');

/** 落盘是 5 秒去抖，测试里等它跑完 */
const waitFlush = () => new Promise((r) => setTimeout(r, 5200));

test('译文会落到 storage.local，带写入时间', async () => {
  await reset();
  mockLLM(segEcho((t) => '译:' + t));
  await TA.engine.translateBatch(['alpha', 'beta'], {});
  await waitFlush();

  const saved = chromeMock.storage.local._data.ta_cache;
  assert.ok(Array.isArray(saved), '应写入 storage.local');
  assert.equal(saved.length, 2);
  const entry = saved.find(([, value]) => value === '译:alpha');
  assert.ok(entry, '存的应是译文本身');
  assert.equal(typeof entry[2], 'number', '每条要带写入时间，否则无法过期');
});

test('service worker 重启后从 storage.local 恢复缓存，不重新付费', async () => {
  await reset();
  mockLLM(segEcho((t) => '译:' + t));
  await TA.engine.translateBatch(['alpha', 'beta'], {});
  await waitFlush();
  const survived = chromeMock.storage.local._data.ta_cache;

  // 模拟 SW 被回收：内存缓存没了，磁盘上的还在
  TA.engine.clearCache();
  chromeMock.storage.local._data.ta_cache = survived;

  const calls = mockLLM(segEcho((t) => '不该被调用:' + t));
  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});

  assert.equal(calls.length, 0, '应全部命中恢复回来的缓存');
  assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta']);
});

test('超过 7 天的缓存条目在恢复时被丢弃', async () => {
  await reset();
  TA.engine.clearCache();

  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const provider = settingsWithProvider().providers[0];
  const key = JSON.stringify([provider.id, provider.model, 'zh-CN', '', 'alpha']);
  chromeMock.storage.local._data.ta_cache = [[key, '过期译文', eightDaysAgo]];

  const calls = mockLLM(() => '新译文');
  const out = await TA.engine.translateBatch(['alpha'], {});

  assert.equal(calls.length, 1, '过期条目不该命中，应重新请求');
  assert.equal(out[0].text, '新译文');
});

test('storage.local 不可用时退回纯内存，不影响翻译', async () => {
  await reset();
  const real = chromeMock.storage.local;
  // 设置读取也走 storage.local，先把设置读进缓存再拔掉存储
  await TA.storage.get();
  chromeMock.storage.local = undefined;
  try {
    mockLLM(segEcho((t) => '译:' + t));
    const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
    assert.deepEqual(out.map((r) => r.text), ['译:alpha', '译:beta']);
  } finally {
    chromeMock.storage.local = real;
  }
});

/* ------------------------------------------------------------------ *
 * 缓存失效范围：只有真正影响译文的设置才该让缓存失效
 * ------------------------------------------------------------------ */

test('自定义提示词进入缓存 key，改提示词后不会拿到旧译文', async () => {
  await reset({ customPrompt: '正式语气' });
  const calls = mockLLM(() => '正式的译文');
  await TA.engine.translateBatch(['alpha'], {});
  assert.equal(calls.length, 1);

  // 只改提示词，不清缓存——key 不同就不会命中
  await TA.storage.patch({ customPrompt: '口语化' });
  mockLLM(() => '口语化的译文');
  const out = await TA.engine.translateBatch(['alpha'], {});
  assert.equal(out[0].text, '口语化的译文', '改了提示词就不能沿用旧译文');
});

test('改译文样式这类与译文无关的设置，缓存必须保留', async () => {
  await reset();
  const calls = mockLLM(segEcho((t) => '译:' + t));
  await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 1);

  // 曾经的实现：任何设置变更都 clearCache，改个样式整页缓存全没
  await TA.storage.patch({ translationStyle: 'quote', displayMode: 'replace', concurrency: 2 });
  const out = await TA.engine.translateBatch(['alpha', 'beta'], {});
  assert.equal(calls.length, 1, '样式、展示方式、并发数都不影响译文，不该让缓存失效');
  assert.ok(out.every((r) => r.cached));
});

/* ------------------------------------------------------------------ *
 * 并发上限
 *
 * 页面侧不再限并发（否则同一个 concurrency 设置在两层各生效一次，实际值是两者取小，
 * 调设置时行为跟直觉对不上）。这里是唯一的一层，贴着 API 配额，也同时服务划词翻译。
 * ------------------------------------------------------------------ */

/** 假 LLM：每个请求挂起直到手动放行，用来观察同时在飞的请求数 */
function gatedLLM() {
  const inflight = [];
  let peak = 0;
  global.fetch = (url, init) =>
    new Promise((resolve) => {
      const user = JSON.parse(init.body).messages[1].content;
      const release = () => {
        inflight.splice(inflight.indexOf(release), 1);
        const out = segEcho((t) => '译:' + t)(user);
        const chunks = sseChunks(out);
        let i = 0;
        resolve({
          ok: true,
          json: async () => ({ choices: [{ message: { content: out } }] }),
          body: {
            getReader: () => ({
              read: async () =>
                i < chunks.length
                  ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
                  : { done: true, value: undefined },
              cancel() {}
            })
          }
        });
      };
      inflight.push(release);
      peak = Math.max(peak, inflight.length);
    });
  return {
    get inflight() {
      return inflight.length;
    },
    get peak() {
      return peak;
    },
    releaseOne() {
      if (inflight.length) inflight[0]();
    },
    releaseAll() {
      while (inflight.length) inflight[0]();
    }
  };
}

/** 反复放行并等一小会儿，直到所有任务落定；漏放一个就会挂住整个测试 */
async function drain(gate, jobs) {
  let settled = false;
  Promise.all(jobs).then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 50 && !settled; i += 1) {
    gate.releaseAll();
    await new Promise((r) => setTimeout(r, 10));
  }
  return Promise.all(jobs);
}

test('后台并发受 concurrency 限制，先跑的没结束不会超发', async () => {
  await reset({ concurrency: 3 });
  const gate = gatedLLM();

  // 8 个独立批次同时到达（对应页面侧一次性开出 8 个端口）
  const jobs = Array.from({ length: 8 }, (_, i) =>
    TA.engine.translateBatch([`a${i}`, `b${i}`], {})
  );
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(gate.inflight, 3, '同时在飞的请求应恰好是 concurrency');

  gate.releaseOne();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gate.inflight, 3, '放行一个后应立刻补位到上限');

  const out = await drain(gate, jobs);
  assert.equal(gate.peak, 3, '整个过程峰值不得超过 concurrency');
  assert.ok(out.every((r) => r.every((x) => x.text)), '全部批次最终都要完成');
});

test('改小 concurrency 后，新的批次按新上限排队', async () => {
  await reset({ concurrency: 4 });
  const gate = gatedLLM();
  const jobs = Array.from({ length: 6 }, (_, i) => TA.engine.translateBatch([`a${i}`, `b${i}`], {}));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gate.inflight, 4);

  await drain(gate, jobs);

  // 设置改成 1，再来一批
  await TA.storage.patch({ concurrency: 1 });
  const gate2 = gatedLLM();
  const jobs2 = Array.from({ length: 4 }, (_, i) => TA.engine.translateBatch([`c${i}`, `d${i}`], {}));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gate2.inflight, 1, '新上限应立即生效');

  await drain(gate2, jobs2);
  assert.equal(gate2.peak, 1);
});
