/* Trans All — 共享常量。经典脚本，挂载到 globalThis.TA。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  TA.STORAGE_KEY = 'ta_settings';
  TA.STREAM_PORT = 'ta-stream';
  TA.BATCH_PORT = 'ta-batch';

  /** background <-> content/popup/options 之间的消息类型 */
  TA.MSG = {
    GET_SETTINGS: 'get-settings',
    TRANSLATE_BATCH: 'translate-batch',
    TEST_PROVIDER: 'test-provider',
    LIST_MODELS: 'list-models',
    TOGGLE_PAGE: 'toggle-page',
    SET_PAGE_STATE: 'set-page-state',
    GET_PAGE_STATE: 'get-page-state',
    GET_TAB_PAGE_STATE: 'get-tab-page-state',
    SET_TAB_PAGE_STATE: 'set-tab-page-state',
    TRANSLATE_SELECTION: 'translate-selection',
    SETTINGS_CHANGED: 'settings-changed',
    OPEN_OPTIONS: 'open-options',
    CLEAR_CACHE: 'clear-cache'
  };

  TA.LANGUAGES = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
    { code: 'ru', name: 'Русский' },
    { code: 'pt', name: 'Português' },
    { code: 'it', name: 'Italiano' },
    { code: 'ar', name: 'العربية' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'th', name: 'ไทย' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'id', name: 'Bahasa Indonesia' },
    { code: 'tr', name: 'Türkçe' }
  ];

  /** 译文展示方式 */
  TA.DISPLAY_MODES = [
    { value: 'bilingual', label: '双语对照（译文显示在原文下方）' },
    { value: 'replace', label: '仅显示译文（替换原文）' }
  ];

  /** 译文样式 */
  TA.TRANSLATION_STYLES = [
    { value: 'none', label: '无样式' },
    { value: 'dashed', label: '虚线下划线' },
    { value: 'dotted', label: '点状下划线' },
    { value: 'quote', label: '左侧引用条' },
    { value: 'highlight', label: '背景高亮' },
    { value: 'dim', label: '弱化（降低对比度）' },
    { value: 'blur', label: '模糊（悬停显示）' }
  ];

  /** 划词翻译触发方式 */
  TA.TRIGGER_MODES = [
    { value: 'button', label: '选中后显示翻译按钮' },
    { value: 'instant', label: '选中后直接翻译' },
    { value: 'off', label: '关闭（仅用快捷键 / 右键菜单）' }
  ];

  TA.PROVIDER_TYPES = [
    { value: 'openai', label: 'OpenAI 兼容（OpenAI / DeepSeek / Kimi / 通义 / OpenRouter / Ollama…）' },
    { value: 'anthropic', label: 'Anthropic Claude' },
    { value: 'gemini', label: 'Google Gemini' }
  ];

  /**
   * 新建服务商时的预设。models 仅用于输入框的候选提示，用户可自由填写。
   */
  TA.PROVIDER_PRESETS = [
    {
      key: 'anthropic',
      name: 'Anthropic Claude',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5',
      models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8'],
      docs: 'https://console.anthropic.com/settings/keys'
    },
    {
      key: 'openai',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
      docs: 'https://platform.openai.com/api-keys'
    },
    {
      key: 'gemini',
      name: 'Google Gemini',
      type: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.0-flash',
      models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
      docs: 'https://aistudio.google.com/app/apikey'
    },
    {
      key: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
      docs: 'https://platform.deepseek.com/api_keys'
    },
    {
      key: 'moonshot',
      name: 'Moonshot Kimi',
      type: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
      docs: 'https://platform.moonshot.cn/console/api-keys'
    },
    {
      key: 'dashscope',
      name: '阿里云百炼（通义千问）',
      type: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
      docs: 'https://bailian.console.aliyun.com/'
    },
    {
      key: 'zhipu',
      name: '智谱 GLM',
      type: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
      models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
      docs: 'https://bigmodel.cn/usercenter/apikeys'
    },
    {
      key: 'siliconflow',
      name: '硅基流动 SiliconFlow',
      type: 'openai',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
      docs: 'https://cloud.siliconflow.cn/account/ak'
    },
    {
      key: 'openrouter',
      name: 'OpenRouter',
      type: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-5',
      models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o-mini', 'google/gemini-2.0-flash-001'],
      docs: 'https://openrouter.ai/keys'
    },
    {
      key: 'ollama',
      name: 'Ollama（本地）',
      type: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b'],
      docs: 'https://ollama.com/'
    },
    {
      key: 'custom',
      name: '自定义（OpenAI 兼容）',
      type: 'openai',
      baseUrl: '',
      model: '',
      models: [],
      docs: ''
    }
  ];

  TA.DEFAULT_PROVIDER = {
    id: '',
    name: '',
    type: 'openai',
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.2,
    maxTokens: 4096,
    /** 附加请求头，形如 {"HTTP-Referer": "..."}；为空则不发送 */
    extraHeaders: {}
  };

  TA.DEFAULT_SETTINGS = {
    enabled: true,
    targetLang: 'zh-CN',
    displayMode: 'bilingual',
    translationStyle: 'dashed',
    triggerMode: 'button',
    /** 整页翻译时按可视区域懒加载，滚动到哪翻到哪 */
    lazyTranslate: true,
    /**
     * 每批次最多包含多少个段落。这是「首段体感」和「token 开销」之间的取舍：
     * 每批都要重发一遍约 1500 字符的系统提示词，批次小则提示词占比高
     * （6 段/批时提示词占输入的 61%，16 段/批降到 37%）；批次大则首段出现得晚。
     * 流式逐段渲染把大批次的等待摊薄了不少，所以默认取 16。要更快的首屏可以调低。
     */
    batchSize: 16,
    /** 每批次最多多少字符，超过则拆批。要和 batchSize 一起看，否则一个卡住另一个 */
    maxCharsPerBatch: 4000,
    /**
     * 同时在飞的 LLM 请求数上限。只在后台 service worker 一处生效，
     * 覆盖所有标签页的整页翻译与划词翻译——它贴的是 API 配额，不是单个页面。
     */
    concurrency: 8,
    /** 少于该字符数的段落不翻译 */
    minTextLength: 2,
    /** 自定义追加到系统提示词末尾的内容 */
    customPrompt: '',
    /** 打开即自动整页翻译的站点（hostname） */
    autoTranslateSites: [],
    /** 永不翻译的站点（hostname） */
    neverTranslateSites: [],
    activeProviderId: null,
    providers: []
  };

  TA.uid = function () {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  };

  TA.langName = function (code) {
    const hit = TA.LANGUAGES.find((l) => l.code === code);
    return hit ? hit.name : code;
  };

  /** 提供给模型的语言名称，用英文更稳定 */
  TA.LANG_PROMPT_NAME = {
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    ru: 'Russian',
    pt: 'Portuguese',
    it: 'Italian',
    ar: 'Arabic',
    hi: 'Hindi',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    tr: 'Turkish'
  };

  TA.promptLangName = function (code) {
    return TA.LANG_PROMPT_NAME[code] || code;
  };
})(globalThis.TA);
