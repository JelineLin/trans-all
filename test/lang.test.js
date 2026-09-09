'use strict';

/* 语种判定：决定一段文字要不要送去翻译。判错的代价是白花钱或漏翻。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/env');

const TA = load('shared/constants.js', 'shared/lang.js');

test('识别常见书写系统', () => {
  assert.equal(TA.detectScript('这是一段中文内容'), 'zh');
  assert.equal(TA.detectScript('これは日本語のテキストです'), 'ja');
  assert.equal(TA.detectScript('한국어 문장입니다'), 'ko');
  assert.equal(TA.detectScript('Это русский текст'), 'ru');
  assert.equal(TA.detectScript('This is English text'), 'latin');
  assert.equal(TA.detectScript('هذا نص عربي'), 'ar');
});

test('日文里的汉字不会被误判成中文', () => {
  // 假名一出现就该判日文，哪怕汉字占比更高
  assert.equal(TA.detectScript('日本語の勉強を続けています'), 'ja');
});

test('目标是中文时跳过中文、翻译英文', () => {
  assert.equal(TA.shouldTranslate('This needs translating.', 'zh-CN', 2), true);
  assert.equal(TA.shouldTranslate('这段已经是中文了。', 'zh-CN', 2), false);
  assert.equal(TA.shouldTranslate('これは日本語です', 'zh-CN', 2), true);
});

test('目标是英文时跳过纯 ASCII 英文', () => {
  assert.equal(TA.shouldTranslate('This is already English.', 'en', 2), false);
  assert.equal(TA.shouldTranslate('这段需要翻译成英文', 'en', 2), true);
});

test('拉丁语系之间不靠书写系统判断，交给模型', () => {
  // en / fr 都是拉丁字母，这里不能贸然跳过
  assert.equal(TA.shouldTranslate('Ceci est un texte français.', 'zh-CN', 2), true);
  assert.equal(TA.shouldTranslate('Bonjour le monde', 'fr', 2), true);
});

test('没有字母的内容一律跳过', () => {
  ['123', '3.14', '···', '—', '→', '$1,299.00', '🎉🎉', '   '].forEach((s) => {
    assert.equal(TA.shouldTranslate(s, 'zh-CN', 2), false, `不该翻译：${JSON.stringify(s)}`);
  });
});

test('长度低于阈值的跳过', () => {
  assert.equal(TA.shouldTranslate('Hi', 'zh-CN', 5), false);
  assert.equal(TA.shouldTranslate('Hello there', 'zh-CN', 5), true);
});

test('中英混排且以英文为主时翻译', () => {
  assert.equal(TA.shouldTranslate('Kaggle helps companies make decisions', 'zh-CN', 2), true);
});

test('目标语言的中文名与提示词用的英文名都能取到', () => {
  assert.equal(TA.langName('zh-CN'), '简体中文');
  assert.equal(TA.promptLangName('zh-CN'), 'Simplified Chinese');
  assert.equal(TA.promptLangName('ja'), 'Japanese');
  // 没收录的语言码原样返回，不至于把提示词写崩
  assert.equal(TA.promptLangName('xx'), 'xx');
});
