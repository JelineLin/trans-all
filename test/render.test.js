'use strict';

/* 译文的插入位置、双语 / 替换两种展示方式、以及整页还原的幂等性。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, loadContent } = require('./helpers/env');

const OPTS = { targetLang: 'zh-CN', minTextLength: 2 };
const BILINGUAL = { displayMode: 'bilingual', translationStyle: 'dashed' };
const REPLACE = { displayMode: 'replace', translationStyle: 'none' };

function setup(html) {
  const doc = loadDom(`<body>${html}</body>`);
  const TA = loadContent();
  TA.dom.reset();
  return { TA, doc, units: TA.dom.collect(doc.body, OPTS) };
}

test('双语模式：译文插在原文之后，原文保持可见', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '这里是原文。', BILINGUAL);

  const p = doc.querySelector('p');
  assert.match(p.textContent, /Original sentence here\./, '原文要还在');
  assert.match(p.textContent, /这里是原文。/, '译文要出现');
  assert.equal(p.querySelector('font.ta-target').textContent, '这里是原文。');
  assert.equal(doc.querySelectorAll('font.ta-source').length, 0, '双语模式不该包裹原文');
});

test('替换模式：原文被包进隐藏容器', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '这里是原文。', REPLACE);

  const source = doc.querySelector('font.ta-source');
  assert.ok(source, '原文应被包裹');
  assert.match(source.textContent, /Original sentence here\./);
  assert.ok(doc.querySelector('font.ta-target'));
});

test('译文节点带 translate="no"，避免被浏览器自带翻译二次处理', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '译文', BILINGUAL);
  const target = doc.querySelector('font.ta-target');
  assert.equal(target.getAttribute('translate'), 'no');
  assert.ok(target.classList.contains('notranslate'));
});

test('双语模式：按钮的译文换行显示，不把按钮横向撑宽', () => {
  const { TA, doc, units } = setup('<div class="cta"><a class="btn" href="/k">Visit the Kaggle website</a></div>');
  TA.render.apply(units[0], '访问 Kaggle 网站', BILINGUAL);

  const target = doc.querySelector('a.btn font.ta-target');
  assert.ok(target, '译文应在按钮内部');
  // ta-inline 会让它 display:inline，按钮就被撑成一行两语
  assert.equal(target.classList.contains('ta-inline'), false, '双语模式应换行');
});

test('替换模式：内联单元保持行内，原样占据原文的位置', () => {
  const { TA, doc, units } = setup('<div class="cta"><a class="btn" href="/k">Visit the Kaggle website</a></div>');
  TA.render.apply(units[0], '访问 Kaggle 网站', REPLACE);

  const target = doc.querySelector('a.btn font.ta-target');
  assert.ok(target.classList.contains('ta-inline'), '只剩一段文字时不该多占一行');
});

test('段落的译文在两种模式下都是块级', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '译文', BILINGUAL);
  assert.equal(doc.querySelector('font.ta-target').classList.contains('ta-inline'), false);

  TA.render.apply(units[0], '译文', REPLACE);
  assert.equal(doc.querySelector('font.ta-target').classList.contains('ta-inline'), false);
});

test('译文样式作为 class 输出，便于用 CSS 控制', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '译文', BILINGUAL);
  assert.ok(doc.querySelector('font.ta-target').classList.contains('ta-style-dashed'));
});

test('restyle 只换样式类，不动译文内容', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '译文内容', BILINGUAL);
  TA.render.restyle({ translationStyle: 'quote' });

  const target = doc.querySelector('font.ta-target');
  assert.ok(target.classList.contains('ta-style-quote'));
  assert.equal(target.classList.contains('ta-style-dashed'), false);
  assert.equal(target.textContent, '译文内容');
});

test('loading 与 error 都是可被清理的译文节点', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');

  TA.render.loading(units[0], BILINGUAL);
  assert.ok(doc.querySelector('font.ta-target.ta-loading'));

  TA.render.error(units[0], '额度不足', BILINGUAL);
  const err = doc.querySelector('font.ta-target.ta-error');
  assert.ok(err);
  assert.match(err.textContent, /额度不足/);
  assert.equal(err.getAttribute('title'), '额度不足', '完整原因放在 title 里');
  assert.equal(doc.querySelectorAll('font.ta-target').length, 1, '不应叠加多个译文节点');
});

test('重复 apply 不会叠加译文节点', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '第一版', BILINGUAL);
  TA.render.apply(units[0], '第二版', BILINGUAL);
  assert.equal(doc.querySelectorAll('font.ta-target').length, 1);
  assert.equal(doc.querySelector('font.ta-target').textContent, '第二版');
});

test('还原后 DOM 与翻译前逐字符一致（双语模式）', () => {
  const { TA, doc, units } = setup('<p>Alpha sentence one.</p><p>Beta sentence two.</p>');
  const before = doc.body.innerHTML;

  units.forEach((u, i) => TA.render.apply(u, `译文${i}`, BILINGUAL));
  assert.notEqual(doc.body.innerHTML, before);

  TA.render.clearAll(doc);
  assert.equal(doc.body.innerHTML, before, '双语模式还原后应完全一致');
});

test('还原后 DOM 与翻译前一致（替换模式，需要拆掉原文包装）', () => {
  const { TA, doc, units } = setup('<p>Alpha <strong>bold</strong> sentence.</p>');
  const before = doc.body.innerHTML;

  TA.render.apply(units[0], '译文', REPLACE);
  assert.ok(doc.querySelector('font.ta-source'));

  TA.render.clearAll(doc);
  assert.equal(doc.querySelectorAll('font.ta-source').length, 0);
  assert.equal(doc.querySelectorAll('font.ta-target').length, 0);
  assert.equal(doc.body.innerHTML, before, '替换模式还原后应完全一致');
});

test('clearAll 可重复调用', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  const before = doc.body.innerHTML;
  TA.render.apply(units[0], '译文', REPLACE);
  TA.render.clearAll(doc);
  TA.render.clearAll(doc);
  assert.equal(doc.body.innerHTML, before);
});

test('散落文字单元的译文插在该段之后，不越过后面的块级元素', () => {
  const { TA, doc, units } = setup('<div>Loose text before<p>A paragraph.</p></div>');
  const loose = units.find((u) => u.plain === 'Loose text before');
  TA.render.apply(loose, '前面的散落文字', BILINGUAL);

  const div = doc.querySelector('div');
  const targetIndex = Array.from(div.childNodes).findIndex(
    (n) => n.nodeType === 1 && n.classList && n.classList.contains('ta-target')
  );
  const pIndex = Array.from(div.childNodes).findIndex((n) => n.nodeName === 'P');
  assert.ok(targetIndex >= 0 && pIndex >= 0);
  assert.ok(targetIndex < pIndex, '译文应在 <p> 之前');
});

test('译文里的链接保留 href，可点击', () => {
  const { TA, doc, units } = setup('<p>See the <a href="/docs">documentation</a> for details.</p>');
  TA.render.apply(units[0], '详见<i0>文档</i0>。', BILINGUAL);
  const link = doc.querySelector('font.ta-target a');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), '/docs');
  assert.equal(link.textContent, '文档');
});

test('译文节点带 lang 属性，屏幕阅读器才会用对语音', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], '这里是译文。', { ...BILINGUAL, targetLang: 'zh-CN' });
  assert.equal(doc.querySelector('font.ta-target').getAttribute('lang'), 'zh-CN');
});

test('切换目标语言后 lang 跟着变', () => {
  const { TA, doc, units } = setup('<p>Original sentence here.</p>');
  TA.render.apply(units[0], 'これは訳文です。', { ...BILINGUAL, targetLang: 'ja' });
  assert.equal(doc.querySelector('font.ta-target').getAttribute('lang'), 'ja');
});
