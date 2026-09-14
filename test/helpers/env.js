'use strict';

/*
 * 测试环境搭建。
 *
 * src 下的文件都是经典脚本（挂到 globalThis.TA），不是模块，所以这里直接 require 就能
 * 把它们加载进来。它们在“调用时”才读 document / Node / chrome 这些全局量，因此每个用例
 * 换一份 jsdom 都不需要清 require 缓存。
 */

const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/**
 * chrome API 的替身。必须在 require 任何 src 文件之前就位——storage.js 在加载时
 * 就会注册 storage.onChanged 监听。
 */
const chromeMock = {
  _onChanged: [],
  storage: {
    // 通用键值存储：设置存 ta_settings，翻译缓存存 ta_cache
    local: {
      _data: {},
      async get(key) {
        const data = chromeMock.storage.local._data;
        if (typeof key === 'string') return key in data ? { [key]: data[key] } : {};
        return Object.assign({}, data);
      },
      async set(obj) {
        Object.assign(chromeMock.storage.local._data, obj);
      },
      async remove(key) {
        delete chromeMock.storage.local._data[key];
      }
    },
    onChanged: {
      addListener(cb) {
        chromeMock._onChanged.push(cb);
      }
    },
    // 翻译缓存落在这里，用来跨 service worker 重启存活
    session: {
      _data: {},
      async get(key) {
        return key in chromeMock.storage.session._data
          ? { [key]: chromeMock.storage.session._data[key] }
          : {};
      },
      async set(obj) {
        Object.assign(chromeMock.storage.session._data, obj);
      },
      async remove(key) {
        delete chromeMock.storage.session._data[key];
      }
    }
  },
  runtime: {
    getManifest: () => require(path.join(ROOT, 'manifest.json')),
    sendMessage: async () => {
      throw new Error('用例未提供 chrome.runtime.sendMessage 实现');
    },
    connect: () => {
      throw new Error('用例未提供 chrome.runtime.connect 实现');
    }
  }
};

if (!global.chrome) global.chrome = chromeMock;

/** 建一份新的 DOM 并挂上全局量，返回 window.document */
function loadDom(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/page' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  return dom.window.document;
}

/** 按顺序加载 src 下的脚本，返回 globalThis.TA */
function load(...files) {
  files.forEach((file) => require(path.join(SRC, file)));
  return globalThis.TA;
}

/** 常用组合：DOM 分析 + 渲染 */
function loadContent() {
  return load('shared/constants.js', 'shared/lang.js', 'content/dom.js', 'content/render.js');
}

/** 把片段塞进容器，方便断言 innerHTML / textContent */
function render(frag, doc) {
  const box = (doc || global.document).createElement('div');
  box.appendChild(frag);
  return box;
}

/** 默认设置 + 一个可用的服务商，供引擎测试使用 */
function settingsWithProvider(overrides) {
  const TA = globalThis.TA;
  return Object.assign({}, TA.DEFAULT_SETTINGS, {
    activeProviderId: 'p1',
    providers: [
      Object.assign({}, TA.DEFAULT_PROVIDER, {
        id: 'p1',
        name: '测试服务',
        type: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'test-model'
      })
    ]
  }, overrides);
}

module.exports = { ROOT, SRC, chromeMock, loadDom, load, loadContent, render, settingsWithProvider };
