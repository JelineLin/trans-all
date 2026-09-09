'use strict';

/*
 * 整页翻译的调度：合批、并发、懒加载、逐段上屏、还原清理。
 *
 * 这里是并发状态最多的地方——单元逐个入队、请求并行在跑、用户随时可能点还原，
 * 所以重点测的是「时序」而不是「结果」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, load, chromeMock } = require('./helpers/env');

const TA = load('shared/constants.js', 'shared/lang.js', 'content/dom.js', 'content/render.js', 'content/page.js');

/** 等一小会儿，让 requestSchedule 的 60ms 去抖跑完 */
const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 100 : ms));

/** 造 n 个足够长、语种明确的英文段落 */
function paragraphs(n) {
  return Array.from({ length: n }, (_, i) => `<p>Paragraph number ${i} needs translating.</p>`).join('');
}

function setup(html, overrides) {
  const doc = loadDom(`<body>${html}</body>`);

  // jsdom 没有 IntersectionObserver，自己造一个可手动触发的
  const observed = new Set();
  let ioCallback = null;
  global.IntersectionObserver = class {
    constructor(cb) {
      ioCallback = cb;
    }
    observe(el) {
      observed.add(el);
    }
    unobserve(el) {
      observed.delete(el);
    }
    disconnect() {
      observed.clear();
      ioCallback = null;
    }
  };
  global.MutationObserver = doc.defaultView.MutationObserver;

  // 后台端口替身
  const ports = [];
  chromeMock.runtime.connect = () => {
    const msgListeners = [];
    const discListeners = [];
    const port = {
      sent: [],
      disconnected: false,
      onMessage: { addListener: (f) => msgListeners.push(f) },
      onDisconnect: { addListener: (f) => discListeners.push(f) },
      postMessage: (m) => port.sent.push(m),
      // Chrome 语义：自己调 disconnect 不会触发自己的 onDisconnect
      disconnect: () => {
        port.disconnected = true;
      },
      /** 测试用：后台推一条消息过来 */
      push: (m) => msgListeners.slice().forEach((f) => f(m)),
      /** 测试用：模拟对端（后台）断开 */
      dropFromOtherEnd: () => {
        port.disconnected = true;
        discListeners.slice().forEach((f) => f());
      }
    };
    ports.push(port);
    return port;
  };

  // page.js 只用到 TA.ui.hud，其余 UI 与调度无关
  const hud = { calls: [] };
  TA.ui = {
    hud: {
      show: (...a) => hud.calls.push(['show', ...a]),
      update: (...a) => hud.calls.push(['update', ...a]),
      setAction: (...a) => hud.calls.push(['setAction', ...a]),
      hide: (...a) => hud.calls.push(['hide', ...a])
    }
  };

  const settings = Object.assign({}, TA.DEFAULT_SETTINGS, { lazyTranslate: true }, overrides);
  TA.page.init(() => settings);
  TA.dom.reset();

  return {
    doc,
    ports,
    hud,
    settings,
    /** 让所有被观察的元素进入视口 */
    reveal() {
      if (!ioCallback) return;
      const entries = [...observed].map((target) => ({ target, isIntersecting: true }));
      ioCallback(entries);
    },
    observedCount: () => observed.size
  };
}

/** 让一个端口按批次内序号把译文推回来 */
function respondAll(port, text) {
  const texts = port.sent[0].texts;
  texts.forEach((_, i) => port.push({ type: 'seg', index: i, text: text(texts[i], i) }));
  port.push({ type: 'done', results: texts.map((t, i) => ({ text: text(t, i) })) });
}

test.afterEach(() => {
  if (TA.page.isActive()) TA.page.restore();
});

test('未进入视口的段落不翻译', async () => {
  const ctx = setup(paragraphs(3));
  TA.page.translate();
  await tick();

  assert.equal(ctx.ports.length, 0, '没滚动到就不该发请求');
  assert.equal(ctx.observedCount(), 3, '三段都应处于观察中');
});

test('进入视口后合并成一个请求，而不是每段一个', async () => {
  const ctx = setup(paragraphs(5));
  TA.page.translate();
  ctx.reveal();
  await tick();

  // 单元是被 IntersectionObserver 逐条回调进队列的，
  // 没有去抖的话这里会变成 5 个请求
  assert.equal(ctx.ports.length, 1, '五段应合并成一次请求');
  assert.equal(ctx.ports[0].sent[0].texts.length, 5);
});

test('超过 batchSize 时拆批', async () => {
  const ctx = setup(paragraphs(5), { batchSize: 2, concurrency: 5 });
  TA.page.translate();
  ctx.reveal();
  await tick();

  assert.equal(ctx.ports.length, 3, '5 段按每批 2 段应拆成 3 批');
  assert.deepEqual(ctx.ports.map((p) => p.sent[0].texts.length), [2, 2, 1]);
});

test('超过 maxCharsPerBatch 时拆批', async () => {
  const ctx = setup(paragraphs(4), { batchSize: 100, maxCharsPerBatch: 80, concurrency: 5 });
  TA.page.translate();
  ctx.reveal();
  await tick();

  assert.ok(ctx.ports.length > 1, '字符数超限应拆批');
  ctx.ports.forEach((p) => {
    const chars = p.sent[0].texts.join('').length;
    const count = p.sent[0].texts.length;
    assert.ok(count === 1 || chars <= 80, `批内字符数应受限，实际 ${chars}`);
  });
});

test('并发受 concurrency 限制，先跑的没结束不会超发', async () => {
  const ctx = setup(paragraphs(20), { batchSize: 1, concurrency: 3 });
  TA.page.translate();
  ctx.reveal();
  await tick();

  assert.equal(ctx.ports.length, 3, '同时最多 3 个请求在跑');

  // 放行一个，应当补上下一个
  respondAll(ctx.ports[0], (t) => '译:' + t);
  await tick();
  assert.equal(ctx.ports.length, 4, '有请求结束后应立刻补位');
});

test('逐段上屏：收到一段就渲染一段，不等整批结束', async () => {
  const ctx = setup(paragraphs(3));
  TA.page.translate();
  ctx.reveal();
  await tick();

  const port = ctx.ports[0];
  port.push({ type: 'seg', index: 1, text: '第二段的译文' });
  await tick(0);

  const targets = ctx.doc.querySelectorAll('font.ta-target');
  assert.equal(targets.length, 1, '只有已返回的那段应上屏');
  assert.equal(targets[0].textContent, '第二段的译文');
});

test('同一段被重复推送时不会渲染两次', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();

  const port = ctx.ports[0];
  port.push({ type: 'seg', index: 0, text: '译文' });
  // done 里会把所有结果再兜一遍，已上屏的不能重复
  port.push({ type: 'done', results: [{ text: '译文' }, { text: '另一段' }] });
  await tick(0);

  assert.equal(ctx.doc.querySelectorAll('font.ta-target').length, 2);
});

test('后台报错时，未落地的段落标记失败并给出还原入口', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();

  ctx.ports[0].push({ type: 'error', error: '额度不足' });
  await tick(0);

  const errors = ctx.doc.querySelectorAll('font.ta-target.ta-error');
  assert.equal(errors.length, 2);
  assert.match(errors[0].textContent, /额度不足/);
  assert.ok(ctx.hud.calls.some((c) => c[0] === 'setAction'), '应提供还原入口');
});

test('后台被回收导致端口断开时不会卡住计数', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();

  ctx.ports[0].dropFromOtherEnd();
  await tick(0);

  assert.equal(ctx.doc.querySelectorAll('font.ta-target.ta-error').length, 2);
});

test('还原：清空译文并让 DOM 回到原样', async () => {
  const ctx = setup(paragraphs(2));
  const before = ctx.doc.body.innerHTML;

  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], (t, i) => '译文' + i);
  await tick(0);
  assert.ok(ctx.doc.querySelectorAll('font.ta-target').length > 0);

  TA.page.restore();
  assert.equal(ctx.doc.body.innerHTML, before, '还原后应与翻译前一致');
  assert.equal(TA.page.isActive(), false);
});

test('还原时断开在途端口，停掉后台正在烧钱的请求', async () => {
  const ctx = setup(paragraphs(6), { batchSize: 2, concurrency: 3 });
  TA.page.translate();
  ctx.reveal();
  await tick();

  assert.equal(ctx.ports.length, 3, '三个请求在跑');
  TA.page.restore();

  // 不断开的话后台会把这三个请求跑完，用户已经不看了却照样计费
  assert.deepEqual(
    ctx.ports.map((p) => p.disconnected),
    [true, true, true],
    '还原后在途端口都应断开'
  );
});

test('还原后迟到的译文不会再写进页面', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();

  const port = ctx.ports[0];
  TA.page.restore();
  port.push({ type: 'seg', index: 0, text: '迟到的译文' });
  await tick(0);

  assert.equal(ctx.doc.querySelectorAll('font.ta-target').length, 0);
});

/*
 * 内容脚本会被补注入（快捷键 / popup 在 sendMessage 失败时重新执行一遍脚本），
 * 而 __taInjected 守卫只挡住 main.js，page.js 的模块状态会被重置成「未翻译」。
 * 这时页面上的译文其实还在，只看 active 的话再按一次快捷键就会叠加出第二份。
 */
test('状态丢失但译文还在时，toggle 是还原而不是再翻一遍', async () => {
  const ctx = setup(paragraphs(1));
  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '译文');
  await tick(0);

  // 手工把 active 清掉（等价于脚本被重新注入）
  TA.page.restore();
  const p = ctx.doc.querySelector('p');
  const stale = ctx.doc.createElement('font');
  stale.className = 'ta-target';
  stale.textContent = '上一轮留下的译文';
  p.appendChild(stale);

  assert.equal(TA.page.isActive(), true, '以 DOM 为准应认定已翻译');

  // 再按一次快捷键必须是还原，不能叠加
  assert.equal(TA.page.toggle(), false);
  assert.equal(ctx.doc.querySelectorAll('font.ta-target').length, 0, '残留译文应被清掉');
});

test('残留译文存在时直接调 translate 也不会叠加', async () => {
  const ctx = setup(paragraphs(1));
  const p = ctx.doc.querySelector('p');
  const stale = ctx.doc.createElement('font');
  stale.className = 'ta-target';
  stale.textContent = '上一轮留下的译文';
  p.appendChild(stale);

  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '新译文');
  await tick(0);

  const targets = ctx.doc.querySelectorAll('font.ta-target');
  assert.equal(targets.length, 1, '页面上只能有一份译文');
  assert.equal(targets[0].textContent, '新译文');
});

test('toggle 往返：翻译 → 还原 → 再翻译', async () => {
  const ctx = setup(paragraphs(2));

  assert.equal(TA.page.toggle(), true);
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '译文');
  await tick(0);
  assert.ok(ctx.doc.querySelectorAll('font.ta-target').length > 0);

  assert.equal(TA.page.toggle(), false);
  assert.equal(ctx.doc.querySelectorAll('font.ta-target').length, 0);

  // 再翻译一次要能重新收集到单元（依赖 TA.dom.reset）
  assert.equal(TA.page.toggle(), true);
  ctx.reveal();
  await tick();
  assert.equal(ctx.ports.length, 2, '第二次翻译应重新发请求');
});

test('切换目标语言会整页重来', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '译文');
  await tick(0);

  const prev = Object.assign({}, ctx.settings);
  ctx.settings.targetLang = 'ja';
  TA.page.onSettingsChanged(prev, ctx.settings);
  ctx.reveal();
  await tick();

  assert.ok(ctx.ports.length >= 2, '换语言后应重新请求');
  assert.equal(ctx.ports[ctx.ports.length - 1].sent[0].targetLang, 'ja');
});

test('只改译文样式时就地更新，不重新请求', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '译文');
  await tick(0);
  const portCount = ctx.ports.length;

  const prev = Object.assign({}, ctx.settings);
  ctx.settings.translationStyle = 'quote';
  TA.page.onSettingsChanged(prev, ctx.settings);
  await tick();

  assert.equal(ctx.ports.length, portCount, '换样式不该产生新请求');
  assert.ok(ctx.doc.querySelector('font.ta-target').classList.contains('ta-style-quote'));
});

test('动态插入的内容会被跟进翻译', async () => {
  const ctx = setup(paragraphs(1));
  TA.page.translate();
  ctx.reveal();
  await tick();
  const firstRound = ctx.ports.length;

  const added = ctx.doc.createElement('p');
  added.textContent = 'Lazily loaded paragraph appears later.';
  ctx.doc.body.appendChild(added);

  // MutationObserver 有 400ms 去抖
  await tick(600);
  ctx.reveal();
  await tick();

  assert.ok(ctx.ports.length > firstRound, '新插入的段落应被翻译');
});

test('已有正文文本节点变化后会废弃旧译文并重新翻译', async () => {
  const ctx = setup('<p>Loading article content.</p>');
  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '旧译文');
  await tick(0);

  const paragraph = ctx.doc.querySelector('p');
  paragraph.firstChild.data = 'The complete article body is ready now.';
  await tick(500);
  ctx.reveal();
  await tick();

  assert.equal(ctx.ports.length, 2, '文本变化后应发起新请求');
  assert.equal(ctx.ports[1].sent[0].texts[0], 'The complete article body is ready now.');
  respondAll(ctx.ports[1], () => '新正文译文');
  await tick(0);

  const targets = paragraph.querySelectorAll('font.ta-target');
  assert.equal(targets.length, 1, '旧译文必须被清理，不能叠加');
  assert.equal(targets[0].textContent, '新正文译文');
});

test('在途请求对应的原文变化后，迟到旧译文不会覆盖新正文', async () => {
  const ctx = setup('<p>Temporary article body.</p>');
  TA.page.translate();
  ctx.reveal();
  await tick();

  const paragraph = ctx.doc.querySelector('p');
  paragraph.firstChild.data = 'Final article body after hydration.';
  await tick(500);
  ctx.reveal();
  await tick();

  respondAll(ctx.ports[0], () => '迟到的旧译文');
  await tick(0);
  assert.equal(paragraph.querySelectorAll('font.ta-target').length, 0);

  respondAll(ctx.ports[1], () => '最终正文译文');
  await tick(0);
  assert.equal(paragraph.querySelector('font.ta-target').textContent, '最终正文译文');
});

test('开放式 Shadow DOM 里的正文会翻译并可完整还原', async () => {
  const ctx = setup('<div id="shadow-host"></div>');
  const shadow = ctx.doc.querySelector('#shadow-host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<p>Article body inside a shadow root.</p>';
  const before = shadow.innerHTML;

  TA.page.translate();
  ctx.reveal();
  await tick();
  assert.equal(ctx.ports.length, 1);
  respondAll(ctx.ports[0], () => 'Shadow 正文译文');
  await tick(0);

  assert.equal(shadow.querySelector('font.ta-target').textContent, 'Shadow 正文译文');
  assert.ok(shadow.querySelector('style[data-ta-shadow-style]'), 'Shadow Root 需要局部译文样式');

  TA.page.restore();
  assert.equal(shadow.innerHTML, before, '还原时也必须移除 Shadow Root 内的样式与译文');
});

test('动态插入且带开放式 Shadow Root 的组件会被跟进翻译', async () => {
  const ctx = setup('<main></main>');
  TA.page.translate();

  const host = ctx.doc.createElement('article-card');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<p>Dynamically inserted shadow article body.</p>';
  ctx.doc.querySelector('main').appendChild(host);

  await tick(500);
  ctx.reveal();
  await tick();
  assert.equal(ctx.ports.length, 1);
  respondAll(ctx.ports[0], () => '动态 Shadow 正文译文');
  await tick(0);

  assert.equal(shadow.querySelector('font.ta-target').textContent, '动态 Shadow 正文译文');
});

test('自己写入的译文节点不会触发无限重扫', async () => {
  const ctx = setup(paragraphs(2));
  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], () => '译文');

  await tick(600);
  ctx.reveal();
  await tick();

  assert.equal(ctx.ports.length, 1, '渲染译文不该被当成页面新增内容');
});

/* ------------------------------------------------------------------ *
 * 标签页标题：不在 body 里，扫描扫不到，但多标签时全靠它辨认
 * ------------------------------------------------------------------ */

/** 标题走的是普通消息而不是端口，单独装一个替身 */
function mockTitleReply(reply) {
  const original = chromeMock.runtime.sendMessage;
  const calls = [];
  chromeMock.runtime.sendMessage = async (message) => {
    calls.push(message);
    return reply(message);
  };
  return {
    calls,
    restore() {
      chromeMock.runtime.sendMessage = original;
    }
  };
}

test('翻译整页时一并翻译标题，还原时放回原文', async () => {
  const ctx = setup(paragraphs(1));
  ctx.doc.title = 'Kaggle helps companies make decisions';
  const m = mockTitleReply(() => ({ ok: true, data: { results: [{ text: 'Kaggle 帮助企业做决策' }] } }));

  try {
    TA.page.translate();
    await tick();
    assert.equal(ctx.doc.title, 'Kaggle 帮助企业做决策');

    TA.page.restore();
    assert.equal(ctx.doc.title, 'Kaggle helps companies make decisions', '还原要放回原标题');
  } finally {
    m.restore();
  }
});

test('标题已经是目标语言时不浪费一次请求', async () => {
  const ctx = setup(paragraphs(1));
  ctx.doc.title = '这个标题本来就是中文，没必要翻译';
  const m = mockTitleReply(() => ({ ok: true, data: { results: [{ text: '不该被调用' }] } }));

  try {
    TA.page.translate();
    await tick();
    assert.equal(m.calls.length, 0, '不该为中文标题发请求');
    assert.equal(ctx.doc.title, '这个标题本来就是中文，没必要翻译');
  } finally {
    TA.page.restore();
    m.restore();
  }
});

test('标题翻译失败不影响正文翻译', async () => {
  const ctx = setup(paragraphs(2));
  ctx.doc.title = 'Some English page title here';
  const m = mockTitleReply(() => {
    throw new Error('后台挂了');
  });

  try {
    TA.page.translate();
    ctx.reveal();
    await tick();

    assert.equal(ctx.ports.length, 1, '正文照常发起请求');
    assert.equal(ctx.doc.title, 'Some English page title here', '标题保持原样');
  } finally {
    TA.page.restore();
    m.restore();
  }
});

test('还原之后标题才被译出来，不覆盖已还原的页面', async () => {
  const ctx = setup(paragraphs(1));
  ctx.doc.title = 'Late arriving title translation';
  let release;
  const gate = new Promise((r) => (release = r));
  const m = mockTitleReply(async () => {
    await gate;
    return { ok: true, data: { results: [{ text: '迟到的译文' }] } };
  });

  try {
    TA.page.translate();
    TA.page.restore();      // 用户在译文回来之前就点了还原
    release();
    await tick();
    assert.equal(ctx.doc.title, 'Late arriving title translation', '不该覆盖已还原的标题');
  } finally {
    m.restore();
  }
});

/* ------------------------------------------------------------------ *
 * 增量扫描
 *
 * MutationObserver 已经把新增节点交到手上了。过去每次变动都重扫整个 body，
 * 页面越长越慢（O(n²)），无限滚动场景下单次要 35ms 以上，直接掉帧。
 * 这里锁住的性质是：**扫描开销只跟新增内容有关，不随页面总量增长。**
 * ------------------------------------------------------------------ */

test('动态插入后只扫新增子树，不重扫整个页面', async () => {
  const ctx = setup(paragraphs(3));
  TA.page.translate();
  ctx.reveal();
  await tick();

  // 记录 collect 被调用时拿到的根节点
  const roots = [];
  const realCollect = TA.dom.collect;
  TA.dom.collect = (root, opts) => {
    roots.push(root);
    return realCollect(root, opts);
  };

  try {
    const box = ctx.doc.createElement('div');
    box.innerHTML = '<p>Freshly inserted paragraph needs translating.</p>';
    ctx.doc.body.appendChild(box);

    await tick(600);

    assert.ok(roots.length > 0, '应该发生了扫描');
    assert.ok(
      roots.every((r) => r !== ctx.doc.body),
      `不该重扫 document.body，实际扫了 ${roots.length} 个根节点，含 body`
    );
    assert.ok(roots.includes(box), '应当扫的是新插入的那棵子树');
  } finally {
    TA.dom.collect = realCollect;
  }
});

test('扫描开销不随页面总量增长', async () => {
  // 同样是插入一个段落，页面本身大 20 倍时扫到的节点数不应跟着涨
  async function scannedNodes(pageSize) {
    const ctx = setup(paragraphs(pageSize));
    TA.page.translate();
    ctx.reveal();
    await tick();

    let visited = 0;
    const realCollect = TA.dom.collect;
    TA.dom.collect = (root, opts) => {
      visited += root.querySelectorAll ? root.querySelectorAll('*').length + 1 : 1;
      return realCollect(root, opts);
    };

    try {
      const box = ctx.doc.createElement('div');
      box.innerHTML = '<p>Freshly inserted paragraph needs translating.</p>';
      ctx.doc.body.appendChild(box);
      await tick(600);
      return visited;
    } finally {
      TA.dom.collect = realCollect;
      TA.page.restore();
    }
  }

  const small = await scannedNodes(5);
  const large = await scannedNodes(100);

  assert.equal(
    small,
    large,
    `页面从 5 段涨到 100 段后，单次扫描访问的节点数从 ${small} 变成了 ${large}——说明又在重扫全页`
  );
});

test('变动铺得太散时退回整页扫描，不逐棵扫几百次', async () => {
  const ctx = setup(paragraphs(3));
  TA.page.translate();
  ctx.reveal();
  await tick();

  const roots = [];
  const realCollect = TA.dom.collect;
  TA.dom.collect = (root, opts) => {
    roots.push(root);
    return realCollect(root, opts);
  };

  try {
    // 一次性插入 60 棵互不包含的子树，超过 MAX_PENDING_ROOTS
    for (let i = 0; i < 60; i += 1) {
      const box = ctx.doc.createElement('div');
      box.innerHTML = `<p>Scattered insertion number ${i} here.</p>`;
      ctx.doc.body.appendChild(box);
    }
    await tick(600);

    assert.ok(
      roots.includes(ctx.doc.body),
      '变动过于分散时应退回整页扫描一次，而不是逐棵扫 60 次'
    );
  } finally {
    TA.dom.collect = realCollect;
  }
});

test('插入无关内容不会清掉已有译文', async () => {
  const ctx = setup(paragraphs(3));
  TA.page.translate();
  ctx.reveal();
  await tick();
  respondAll(ctx.ports[0], (t, i) => '译文' + i);

  const before = ctx.doc.querySelectorAll('font.ta-target').length;
  assert.equal(before, 3, '先确认三段都译好了');

  // 往 body 尾部插一个毫不相干的段落
  const box = ctx.doc.createElement('div');
  box.innerHTML = '<p>Unrelated paragraph appended at the end.</p>';
  ctx.doc.body.appendChild(box);
  await tick(600);

  // 曾经的 bug：nodesIntersect 是双向的，body 包含每个段落 = 全部判定为受影响，
  // 于是插一个节点就把整页译文清空重译，无限滚动时每屏闪一次
  assert.equal(
    ctx.doc.querySelectorAll('font.ta-target').length,
    before,
    '已有译文不该因为别处插入了内容而被清掉'
  );
});
