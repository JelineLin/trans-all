# Trans All · 沉浸式翻译

基于大模型的 Chrome 扩展（Manifest V3）：整页沉浸式翻译 + 划词翻译，可配置多套 LLM 服务并随时切换。

## 功能

**整页翻译**
- 两种展示方式：**双语对照**（译文插在原文下方）、**仅显示译文**（隐藏原文）
- 七种译文样式：无样式 / 虚线 / 点线 / 引用条 / 高亮 / 弱化 / 模糊（悬停显示）
- 按可视区域懒加载，滚动到哪翻到哪，不浪费 token
- 跟进动态内容：无限滚动、SPA 路由切换新加载的段落会自动补翻
- 保留内联结构：`<a>` 的链接、`<strong>` 的加粗在译文里都还在，`<code>` 与图片原样保留
- 一键还原，DOM 恢复到翻译前的状态

**划词翻译**
- 三种触发方式：选中后显示按钮 / 选中后直接翻译 / 只用快捷键
- 单词和短语给出词典式释义，第一行附读音：英语为英/美式 IPA，汉语为带声调的拼音，日语为假名
- 流式输出，边生成边显示；面板可拖动，支持复制与重试
- 支持 `<input>` / `<textarea>` 里选中的文本

**多套 LLM 配置**
- 三类接口：OpenAI 兼容、Anthropic Claude、Google Gemini
- 内置预设：Anthropic、OpenAI、Gemini、DeepSeek、Kimi、通义千问、智谱 GLM、硅基流动、OpenRouter、Ollama 本地
- 每套配置独立的地址 / 密钥 / 模型 / 参数，一键切换当前使用的服务，带连接测试
- 模型名可自由填写，也可以一键从服务商拉取当前可用的模型列表

**其它**
- 站点规则：指定域名自动翻译，或永不翻译（支持 `*.example.com` 通配）
- 快捷键：`Alt+A` 翻译/还原整页，`Alt+S` 翻译选中文本
- 右键菜单入口、译文缓存、配置导入导出

## 安装

无需构建，直接加载源码目录。Chrome 和 Edge 都可以（Edge 同为 Chromium 内核，MV3 与 `chrome.*` API 一致）：

| 浏览器 | 扩展页 |
| --- | --- |
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

1. 打开「开发者模式」（Chrome 在右上角，Edge 在左下角）
2. 点「加载已解压的扩展程序」，选择本仓库根目录
3. 首次安装会自动打开设置页

> 重新加载扩展后，之前就开着的标签页不会自动获得内容脚本。扩展会在你点翻译时自动补注入，
> 通常不用手动刷新。

打包分发时请排除 `node_modules/`、`test/`、`package.json` —— 它们只用于跑测试，与扩展运行无关。

## 开发与测试

扩展本身零构建、零运行时依赖；测试需要一个 jsdom：

```bash
npm install
npm test
```

测试跑在 Node 内置的 test runner 上（`node --test`），覆盖段落切分、占位标签还原、
译文渲染与还原、三家服务商适配、翻译引擎的分批与缓存、整页翻译的调度时序。

其中 `test/placeholder.test.js` 值得特别留意：模型输出并不规范，而任何没被识别的占位标签
都会直接以文字形式出现在用户页面上（曾出现过按钮被翻译成「访问 Kaggle 网站 `<x1/>`」）。
那个文件把模型实际会犯的 11 种错逐一列了出来，底线断言是**任何输入都不能让标签泄漏成可见文字**。

## 配置

在设置页「翻译服务」中点「+ 添加」，选一个预设模板，填入 API Key 即可。点「测试连接」确认可用。

模型一栏是自由输入框，可以直接填任意模型名，下拉里的只是建议。点「拉取列表」会向该服务的模型接口
（OpenAI 兼容为 `GET /v1/models`，Anthropic 为 `GET /v1/models`，Gemini 为 `GET /v1beta/models`）
查询当前真实可用的模型，避免内置的建议列表过期。

### token 开销与缓存

译文按**段落**缓存：key 由服务商、模型、目标语言、自定义提示词和原文共同构成，任何一项不同都不命中。
缓存落在 `chrome.storage.local`，保留 7 天，跨浏览器重启有效；设置页「高级」里可手动清空。
改译文样式、展示方式、并发数这类不影响译文内容的设置**不会**让缓存失效。

每次请求都要重发一遍约 1500 字符的系统提示词，所以批次大小直接决定开销：
6 段/批时提示词占输入的 61%，默认的 16 段/批降到 37%。批次越大首段出现得越晚，
要更快的首屏可以在「高级」里调低 `每批段落数`。

Anthropic 接口的系统提示词已标记 `cache_control`，但服务端缓存有最小前缀门槛
（Opus 5 为 512 token，Sonnet / Opus 4.8 为 1024），默认提示词约 380 token 达不到，
只有加了较长的自定义提示词之后才会真正命中。

各家 API Key 的申请入口：

| 服务 | 地址 |
| --- | --- |
| Anthropic | https://console.anthropic.com/settings/keys |
| OpenAI | https://platform.openai.com/api-keys |
| Gemini | https://aistudio.google.com/app/apikey |
| DeepSeek | https://platform.deepseek.com/api_keys |
| 硅基流动 | https://cloud.siliconflow.cn/account/ak |
| OpenRouter | https://openrouter.ai/keys |

Ollama 等本地服务不需要 Key，把接口地址填成 `http://localhost:11434/v1` 即可。

> API Key 只写入本机的 `chrome.storage.local`，不参与浏览器账号同步，也不会发往除你所配置的接口之外的任何地址。导出的配置文件包含明文 Key，不要分享。

## 使用

| 操作 | 方式 |
| --- | --- |
| 翻译 / 还原整页 | 点扩展图标 → 「翻译此页面」，或 `Alt+A`，或右键菜单 |
| 翻译选中文本 | 选中后点浮出的「译」按钮，或 `Alt+S`，或右键菜单 |
| 切换目标语言 / 展示方式 | 扩展弹窗里直接改，已翻译的页面会自动重刷 |
| 让某站点自动翻译 | 扩展弹窗里勾选「打开此站点时自动翻译」 |

## 项目结构

```
manifest.json
src/
  shared/          三个上下文共用（经典脚本，挂在 globalThis.TA 上）
    constants.js   默认设置、语言表、服务商预设
    lang.js        书写系统判定，跳过已是目标语言的段落
    storage.js     设置读写与跨上下文同步
    providers.js   OpenAI / Anthropic / Gemini 适配与 SSE 解析
    engine.js      提示词、分批协议、译文缓存、并发控制
  background/
    service-worker.js   消息路由、右键菜单、快捷键、流式端口
  content/
    dom.js         段落切分与内联占位标签提取
    render.js      译文插入 / 原文隐藏 / 还原
    ui.js          浮层 UI（Shadow DOM 隔离站点样式）
    selection.js   划词翻译
    page.js        整页翻译调度（懒加载、合批、动态内容）
    main.js        内容脚本入口
  popup/           扩展弹窗
  options/         设置页
```

没有构建步骤，也没有运行时依赖。`shared/` 下的文件在三处以不同方式加载：service worker 用 `importScripts`，内容脚本靠 manifest 的多文件数组共享作用域，扩展页面用 `<script src>`——所以它们都写成经典脚本而非 ES module。

## 实现要点

**分批协议。** 整页翻译把多个段落合成一个请求，用 `<seg id="N">…</seg>` 包裹。模型漏段或格式跑偏时，缺失的段落会自动降级为逐条重试；单段翻译则完全不套这层协议。

**内联结构保留。** 段落文本在送给模型前，`<a>`/`<strong>` 这类元素被替换成 `<i0>…</i0>` 占位（内部文字仍需翻译），`<code>`/`<img>` 被替换成 `<x0/>`（原样保留）。回填时按占位序号克隆原节点，`href`、`class` 等属性都在。模型如果丢掉了标签，会降级成纯文本，不会报错。

**Anthropic 的 `temperature`。** Claude Opus 5 / Opus 4.8 等模型已移除该参数，传入会返回 400，所以 Anthropic 接口一律不发送它，设置页也会隐藏该输入框。

## 已知限制

- 支持普通 iframe、`about:blank`、`data:` 与 `blob:` 等关联 frame；浏览器禁止扩展注入的受限 frame 仍无法处理
- 支持开放式 Shadow DOM；页面创建的 closed Shadow Root 无法从扩展侧读取
- 不翻译 `<pre>` 代码块、表单控件的值、`title` / `alt` 等属性文本
- 拉丁字母的语言之间无法靠书写系统区分，英译法这类任务会把已是目标语言的段落也发给模型（由模型自己判断是否原样返回）
- 未做 token 用量统计
