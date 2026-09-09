/* Trans All — 轻量语种判定。用于跳过“已经是目标语言”的段落。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  const RE = {
    cjk: /[一-鿿㐀-䶿]/g,
    kana: /[぀-ヿ]/g,
    hangul: /[가-힯ᄀ-ᇿ]/g,
    cyrillic: /[Ѐ-ӿ]/g,
    arabic: /[؀-ۿ]/g,
    devanagari: /[ऀ-ॿ]/g,
    thai: /[฀-๿]/g,
    latin: /[A-Za-zÀ-ɏ]/g,
    letterish: /[\p{L}\p{M}]/u
  };

  function ratio(text, re) {
    re.lastIndex = 0;
    const m = text.match(re);
    return m ? m.length / text.length : 0;
  }

  /**
   * 粗略判断文本主要使用的书写系统。
   * 返回 'zh' | 'ja' | 'ko' | 'ru' | 'ar' | 'hi' | 'th' | 'latin' | 'unknown'
   */
  TA.detectScript = function (text) {
    const t = (text || '').replace(/\s+/g, '');
    if (!t) return 'unknown';

    const kana = ratio(t, RE.kana);
    // 假名一出现基本可以确定是日文，即使汉字占比更高
    if (kana > 0.03) return 'ja';
    if (ratio(t, RE.hangul) > 0.1) return 'ko';
    if (ratio(t, RE.cjk) > 0.1) return 'zh';
    if (ratio(t, RE.cyrillic) > 0.2) return 'ru';
    if (ratio(t, RE.arabic) > 0.2) return 'ar';
    if (ratio(t, RE.devanagari) > 0.2) return 'hi';
    if (ratio(t, RE.thai) > 0.2) return 'th';
    if (ratio(t, RE.latin) > 0.2) return 'latin';
    return 'unknown';
  };

  const TARGET_SCRIPT = {
    'zh-CN': 'zh',
    'zh-TW': 'zh',
    ja: 'ja',
    ko: 'ko',
    ru: 'ru',
    ar: 'ar',
    hi: 'hi',
    th: 'th',
    en: 'latin',
    fr: 'latin',
    de: 'latin',
    es: 'latin',
    pt: 'latin',
    it: 'latin',
    vi: 'latin',
    id: 'latin',
    tr: 'latin'
  };

  /**
   * 文本是否值得翻译：太短、没有字母、或已经是目标语言书写系统的都跳过。
   * 注意：拉丁字母的语言之间无法靠书写系统区分（如 en/fr），此时不跳过，交给模型判断。
   */
  TA.shouldTranslate = function (text, targetLang, minLength) {
    const t = (text || '').trim();
    if (t.length < (minLength == null ? 2 : minLength)) return false;
    if (!RE.letterish.test(t)) return false; // 纯数字 / 符号 / emoji

    const script = TA.detectScript(t);
    if (script === 'unknown') return false;

    const wanted = TARGET_SCRIPT[targetLang];
    if (!wanted) return true;

    // 目标是拉丁语系时，只有在几乎全是 ASCII 且目标是英文的情况下才跳过
    if (wanted === 'latin') {
      if (targetLang !== 'en') return true;
      return !/^[\x00-\x7F]+$/.test(t) || /[À-ɏ]/.test(t);
    }

    return script !== wanted;
  };
})(globalThis.TA);
