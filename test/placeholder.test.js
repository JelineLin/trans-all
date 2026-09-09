'use strict';

/*
 * 占位标签还原。
 *
 * 这是整个扩展最脆弱的地方：模型的输出并不规范，而任何没被识别的占位标签都会
 * 直接以文字形式出现在用户页面上（真实见过按钮被翻译成「访问 Kaggle 网站 <x1/>」）。
 * 所以这里的底线断言是：**任何输入都不能让占位标签泄漏成可见文字。**
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, loadContent, render } = require('./helpers/env');

/*
 * 句子中的图标链接：这是会产生**嵌套占位**的典型结构——
 * <a> 成为 wrap 占位，它内部的 <img> 又是一个 keep 占位。
 * （独立成段的按钮不会嵌套，见文件末尾那组用例。）
 */
const LINK_IN_PROSE = `<body><p>
  Please <a class="btn" href="/kaggle">visit the Kaggle website <img src="arrow.svg" alt=""></a> today.
</p></body>`;

/** 取出「句中图标链接」这个典型单元 */
function buttonUnit() {
  const doc = loadDom(LINK_IN_PROSE);
  const TA = loadContent();
  const unit = TA.dom.collect(doc.body, { targetLang: 'zh-CN', minTextLength: 2 })[0];
  return { TA, doc, unit };
}

/** 可见文字里是否残留了占位标签 */
function leaks(text) {
  return /<\s*\/?\s*[ixIX]\s*\d/.test(text);
}

test('提取时把内联标签与图标转成占位', () => {
  const { unit } = buttonUnit();
  assert.equal(unit.text, 'Please <i0>visit the Kaggle website <x1/></i0> today.');
  assert.deepEqual(
    unit.placeholders.map((p) => `${p.kind}/${p.node.tagName}`),
    ['wrap/A', 'keep/IMG']
  );
  // 送给模型判断语种的纯文本里不应带标签
  assert.equal(unit.plain, 'Please visit the Kaggle website today.');
});

test('规范输出：链接与图标都还原成真实节点', () => {
  const { TA, doc, unit } = buttonUnit();
  const box = render(TA.dom.buildFragment('<i0>访问 Kaggle 网站 <x1/></i0>', unit.placeholders, doc), doc);

  const link = box.querySelector('a');
  assert.ok(link, '应还原出 <a>');
  assert.equal(link.getAttribute('href'), '/kaggle', 'href 要保留');
  assert.equal(link.className, 'btn', 'class 要保留');
  assert.ok(box.querySelector('img'), '图标要保留');
  assert.equal(link.textContent, '访问 Kaggle 网站 ');
});

test('嵌套占位必须递归还原，不能当成纯文本塞进克隆节点', () => {
  const { TA, doc, unit } = buttonUnit();
  const box = render(TA.dom.buildFragment('<i0>访问 Kaggle 网站 <x1/></i0>', unit.placeholders, doc), doc);
  // 曾经的 bug：clone.textContent = 内部文本，导致 <x1/> 原样显示
  assert.equal(leaks(box.textContent), false);
  assert.equal(box.querySelector('a img') !== null, true, '图标应在链接内部');
});

/*
 * 模型实际会犯的错。每一条都必须做到「不泄漏标签」；能不能保住结构则分情况，
 * 见 keepsLink / keepsIcon 的期望值。
 */
const MALFORMED = [
  { name: '规范输出', reply: '<i0>访问 Kaggle 网站 <x1/></i0>', keepsLink: true, keepsIcon: true },
  { name: '标签变大写', reply: '<I0>访问 Kaggle 网站 <X1/></I0>', keepsLink: true, keepsIcon: true },
  { name: '闭合编号对不上', reply: '<i0>访问 Kaggle 网站 <x1/></i1>', keepsLink: true, keepsIcon: true },
  { name: '忘了闭合', reply: '<i0>访问 Kaggle 网站 <x1/>', keepsLink: true, keepsIcon: true },
  { name: '标签里多了空格', reply: '< i0 >访问 Kaggle 网站 < x1 / ></ i0 >', keepsLink: true, keepsIcon: true },
  { name: 'x 写成不带斜杠', reply: '<i0>访问 Kaggle 网站 <x1></i0>', keepsLink: true, keepsIcon: true },
  { name: '多余的孤立闭合', reply: '访问 Kaggle 网站 <x1/></i0>', keepsLink: false, keepsIcon: true },
  { name: '成对标签写成自闭合', reply: '<i0/>访问 Kaggle 网站 <x1/>', keepsLink: false, keepsIcon: true },
  { name: '编号越界', reply: '<i0>访问 Kaggle 网站 <x7/></i0>', keepsLink: true, keepsIcon: false },
  { name: '输出被截断', reply: '<i0>访问 Kaggle 网站 <x', keepsLink: true, keepsIcon: false },
  { name: '完全丢掉标签', reply: '访问 Kaggle 网站', keepsLink: false, keepsIcon: false }
];

test('畸形输出一律不泄漏占位标签', async (t) => {
  for (const item of MALFORMED) {
    await t.test(item.name, () => {
      const { TA, doc, unit } = buttonUnit();
      const box = render(TA.dom.buildFragment(item.reply, unit.placeholders, doc), doc);

      assert.equal(leaks(box.textContent), false, `泄漏了标签：${box.textContent}`);
      // 无论结构怎么降级，译文本身必须留下
      assert.match(box.textContent, /访问 Kaggle 网站/);
      assert.equal(!!box.querySelector('a'), item.keepsLink, '链接是否保留与预期不符');
      assert.equal(!!box.querySelector('img'), item.keepsIcon, '图标是否保留与预期不符');
    });
  }
});

test('交叉嵌套不会丢文字', () => {
  const doc = loadDom('<body><p>a <b>bold</b> and <i>italic</i> end</p></body>');
  const TA = loadContent();
  const unit = TA.dom.collect(doc.body, { targetLang: 'zh-CN', minTextLength: 2 })[0];
  // 模型把 </i0> 和 </i1> 的顺序写反了
  const box = render(TA.dom.buildFragment('甲 <i0>粗 <i1>斜</i0> 体</i1> 末', unit.placeholders, doc), doc);
  assert.equal(leaks(box.textContent), false);
  assert.match(box.textContent, /甲/);
  assert.match(box.textContent, /末/);
});

test('空译文返回空片段而不是报错', () => {
  const { TA, doc, unit } = buttonUnit();
  assert.equal(render(TA.dom.buildFragment('', unit.placeholders, doc), doc).textContent, '');
  assert.equal(render(TA.dom.buildFragment(null, unit.placeholders, doc), doc).textContent, '');
});

/*
 * 独立成段的按钮 / 链接。
 *
 * 这类元素若被当成 wrap 占位，回填时会被浅克隆成第二个按钮——连站点的
 * class 一起复制过去，页面上就多出一个一模一样的蓝色按钮。
 * 正确做法是让它自己成段，译文写进元素内部。
 */
test('独立按钮不产生 wrap 占位，译文不会被克隆成第二个按钮', () => {
  const doc = loadDom('<body><div class="cta"><a class="btn" href="/k">Visit the Kaggle website</a></div></body>');
  const TA = loadContent();
  const unit = TA.dom.collect(doc.body, { targetLang: 'zh-CN', minTextLength: 2 })[0];

  assert.equal(unit.text, 'Visit the Kaggle website', '不该把自己包成 <i0>');
  assert.equal(unit.placeholders.length, 0);

  TA.render.apply(unit, '访问 Kaggle 网站', { displayMode: 'bilingual', translationStyle: 'none' });
  assert.equal(doc.querySelectorAll('a.btn').length, 1, '页面上只能有一个按钮');
  assert.ok(doc.querySelector('a.btn font.ta-target'), '译文应在按钮内部');
});

test('按钮组里每个按钮各自成段', () => {
  const doc = loadDom(`<body><div class="cta">
    <a class="btn" href="/a">Visit the Kaggle website</a>
    <a class="btn" href="/b">Read the documentation</a>
  </div></body>`);
  const TA = loadContent();
  const units = TA.dom.collect(doc.body, { targetLang: 'zh-CN', minTextLength: 2 });

  assert.equal(units.length, 2, '两个按钮应各自成段');
  assert.deepEqual(units.map((u) => u.text), ['Visit the Kaggle website', 'Read the documentation']);

  units.forEach((u, i) => TA.render.apply(u, '译文' + i, { displayMode: 'bilingual', translationStyle: 'none' }));
  assert.equal(doc.querySelectorAll('a.btn').length, 2, '不该多出克隆的按钮');
});

test('句子里的链接仍然保留成占位，译文里依旧可点击', () => {
  const doc = loadDom('<body><p>See the <a href="/docs">documentation</a> for details.</p></body>');
  const TA = loadContent();
  const unit = TA.dom.collect(doc.body, { targetLang: 'zh-CN', minTextLength: 2 })[0];

  // 句中链接是内容的一部分，必须保留成 wrap 占位
  assert.equal(unit.text, 'See the <i0>documentation</i0> for details.');
  TA.render.apply(unit, '详见<i0>文档</i0>。', { displayMode: 'bilingual', translationStyle: 'none' });

  const link = doc.querySelector('font.ta-target a');
  assert.ok(link, '译文里的链接要还原');
  assert.equal(link.getAttribute('href'), '/docs');
});

test('递归时不会因为共用正则而互相踩 lastIndex', () => {
  const doc = loadDom('<body><p>x <a href="/1">one <code>c</code> two</a> y <a href="/2">three</a> z</p></body>');
  const TA = loadContent();
  const unit = TA.dom.collect(doc.body, { targetLang: 'zh-CN', minTextLength: 2 })[0];
  const box = render(TA.dom.buildFragment(unit.text, unit.placeholders, doc), doc);
  assert.equal(box.querySelectorAll('a').length, 2, '两个链接都要还原');
  assert.equal(box.querySelectorAll('code').length, 1);
  assert.equal(leaks(box.textContent), false);
});
