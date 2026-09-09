'use strict';

/* 段落切分与文本提取。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, loadContent } = require('./helpers/env');

const OPTS = { targetLang: 'zh-CN', minTextLength: 2 };

function collect(html) {
  const doc = loadDom(`<body>${html}</body>`);
  const TA = loadContent();
  TA.dom.reset();
  return { TA, doc, units: TA.dom.collect(doc.body, OPTS) };
}

function texts(units) {
  return units.map((u) => u.plain);
}

test('相邻段落各自成为一个单元', () => {
  const { units } = collect('<p>First paragraph here.</p><p>Second paragraph here.</p>');
  assert.deepEqual(texts(units), ['First paragraph here.', 'Second paragraph here.']);
});

test('嵌套容器只取最内层的段落，不重复', () => {
  const { units } = collect('<div><div><section><p>Only this text counts.</p></section></div></div>');
  assert.deepEqual(texts(units), ['Only this text counts.']);
});

test('块级子元素之间的散落文字单独成段', () => {
  const { units } = collect('<div>Loose leading text<p>A real paragraph.</p>Loose trailing text</div>');
  assert.deepEqual(texts(units), ['Loose leading text', 'A real paragraph.', 'Loose trailing text']);
});

test('script / style / pre / textarea 整棵子树跳过', () => {
  const { units } = collect(`
    <p>Visible sentence.</p>
    <script>var hidden = "do not translate";</script>
    <style>.x { content: "nope"; }</style>
    <pre>code block stays</pre>
    <textarea>user input</textarea>
  `);
  assert.deepEqual(texts(units), ['Visible sentence.']);
});

test('svg 子树跳过——外来元素的 tagName 是小写，不能漏判', () => {
  const { units } = collect('<p>Chart caption text.</p><svg><title>should not translate</title><text>nor this</text></svg>');
  assert.deepEqual(texts(units), ['Chart caption text.']);
});

test('svg 出现在段落内时保留成占位，图标不会消失', () => {
  const { units } = collect('<p>Download the report <svg viewBox="0 0 8 8"><title>icon</title></svg></p>');
  assert.equal(units.length, 1);
  assert.equal(units[0].plain, 'Download the report');
  assert.deepEqual(units[0].placeholders.map((p) => p.kind), ['keep']);
});

test('translate="no" / .notranslate 跳过', () => {
  const { units } = collect('<p>Translate this one.</p><p translate="no">Keep as is.</p><p class="notranslate">Keep this too.</p>');
  assert.deepEqual(texts(units), ['Translate this one.']);
});

test('可编辑区域跳过，避免破坏用户输入', () => {
  const { units } = collect('<p>Normal text here.</p><div contenteditable="true">Draft content here.</div>');
  assert.deepEqual(texts(units), ['Normal text here.']);
});

test('已是目标语言的段落跳过', () => {
  const { units } = collect('<p>English sentence that needs translating.</p><p>这段本来就是中文，不需要翻译。</p>');
  assert.deepEqual(texts(units), ['English sentence that needs translating.']);
});

test('纯数字 / 符号 / 过短的内容跳过', () => {
  const { units } = collect('<p>123</p><p>·</p><p>—</p><p>OK</p><p>Real sentence to translate.</p>');
  assert.ok(texts(units).includes('Real sentence to translate.'));
  assert.equal(texts(units).includes('123'), false);
  assert.equal(texts(units).includes('·'), false);
});

test('code 保留原样、strong 保留标签', () => {
  const { units } = collect('<p>Run <code>npm install</code> and then read the <strong>manual</strong>.</p>');
  assert.equal(units.length, 1);
  assert.equal(units[0].text, 'Run <x0/> and then read the <i1>manual</i1>.');
  assert.equal(units[0].plain, 'Run and then read the manual.');
});

test('br 转成换行', () => {
  const { units } = collect('<p>First line here<br>Second line here</p>');
  assert.equal(units[0].text, 'First line here\nSecond line here');
});

test('span / font 这类无语义容器被拍平，不产生多余标签', () => {
  const { units } = collect('<p><span class="a">Wrapped <font>text</font> inside</span> a span.</p>');
  assert.equal(units[0].text, 'Wrapped text inside a span.');
  assert.equal(units[0].placeholders.length, 0);
});

test('列表项与表格单元格各自成段', () => {
  const { units } = collect('<ul><li>First list item.</li><li>Second list item.</li></ul><table><tr><td>Cell one here.</td><td>Cell two here.</td></tr></table>');
  assert.deepEqual(texts(units), ['First list item.', 'Second list item.', 'Cell one here.', 'Cell two here.']);
});

test('同一节点重复扫描不会产生重复单元', () => {
  const { TA, doc } = collect('<p>Repeated scanning test sentence.</p>');
  const again = TA.dom.collect(doc.body, OPTS);
  assert.equal(again.length, 0, '第二次扫描不应再产出');
});

test('reset 之后可以重新收集（对应整页还原再翻译）', () => {
  const { TA, doc } = collect('<p>Reset behaviour test sentence.</p>');
  assert.equal(TA.dom.collect(doc.body, OPTS).length, 0);
  TA.dom.reset();
  assert.equal(TA.dom.collect(doc.body, OPTS).length, 1);
});

test('句中的 svg 图标不会把句子劈成两段', () => {
  // 图标若被当成块级元素，"Click" 和 "here" 会被拆成两个单元分别送翻译，句子就断了
  const { units } = collect('<p>Click <svg viewBox="0 0 8 8"><title>icon</title></svg> here to continue.</p>');
  assert.equal(units.length, 1, '整句应保持为一个单元');
  assert.equal(units[0].plain, 'Click here to continue.');
});

test('句中的公式同样不拆句', () => {
  const { units } = collect('<p>The value of <math><mi>x</mi></math> is unknown here.</p>');
  assert.equal(units.length, 1);
  assert.match(units[0].plain, /The value of\s+is unknown here\./);
});
