/* Trans All — 设置页。 */
(function (TA) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let settings = null;
  let selectedId = null;
  let saveTimer = null;
  let pendingPatch = {};

  /* ---------------------------- 通用工具 ---------------------------- */

  function flash(message, isError) {
    const node = $('saveState');
    node.textContent = message;
    node.style.color = isError ? 'var(--danger)' : 'var(--ok)';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => (node.textContent = ''), 1800);
  }

  async function commit(patch) {
    clearTimeout(saveTimer);
    const merged = Object.assign({}, pendingPatch, patch);
    pendingPatch = {};
    settings = await TA.storage.patch(merged);
    flash('已保存');
  }

  /**
   * 输入类字段防抖保存。多个字段共用一个定时器，所以要把改动合并起来，
   * 否则后一次输入会把前一个字段还没落盘的改动一起取消掉。
   */
  function debouncedCommit(patch) {
    Object.assign(pendingPatch, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => commit({}), 400);
  }

  function fillSelect(select, items, value) {
    select.innerHTML = '';
    items.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
    if (value != null) select.value = value;
  }

  function linesToList(text) {
    return String(text || '')
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /* ---------------------------- 标签页 ---------------------------- */

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  /* ---------------------------- 服务列表 ---------------------------- */

  function providerById(id) {
    return settings.providers.find((p) => p.id === id) || null;
  }

  function renderList() {
    const list = $('providerList');
    list.innerHTML = '';

    if (!settings.providers.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="p-info"><span class="p-model">还没有配置任何服务</span></span>';
      li.style.cursor = 'default';
      list.appendChild(li);
      return;
    }

    settings.providers.forEach((p) => {
      const li = document.createElement('li');
      li.className = p.id === selectedId ? 'selected' : '';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'activeProvider';
      radio.checked = settings.activeProviderId === p.id;
      radio.title = '设为当前使用的服务';
      radio.addEventListener('click', (e) => {
        e.stopPropagation();
        commit({ activeProviderId: p.id });
      });

      const info = document.createElement('span');
      info.className = 'p-info';
      const name = document.createElement('div');
      name.className = 'p-name';
      name.textContent = p.name || '(未命名)';
      const model = document.createElement('div');
      model.className = 'p-model';
      model.textContent = p.model || '未填写模型';
      info.appendChild(name);
      info.appendChild(model);

      li.appendChild(radio);
      li.appendChild(info);
      li.addEventListener('click', () => selectProvider(p.id));
      list.appendChild(li);
    });
  }

  function selectProvider(id) {
    selectedId = id;
    renderList();
    renderEditor();
  }

  function renderEditor() {
    const provider = providerById(selectedId);
    const form = $('providerForm');
    if (!provider) {
      form.hidden = true;
      $('emptyEditor').hidden = false;
      return;
    }
    $('emptyEditor').hidden = true;
    form.hidden = false;

    $('preset').value = '';
    $('pName').value = provider.name || '';
    $('pType').value = provider.type || 'openai';
    $('pBaseUrl').value = provider.baseUrl || '';
    $('pApiKey').value = provider.apiKey || '';
    $('pModel').value = provider.model || '';
    $('pMaxTokens').value = provider.maxTokens || 4096;
    $('pTemperature').value =
      typeof provider.temperature === 'number' ? provider.temperature : '';
    $('pHeaders').value = Object.keys(provider.extraHeaders || {}).length
      ? JSON.stringify(provider.extraHeaders, null, 2)
      : '';
    $('testResult').hidden = true;

    updateTypeHints(provider.type);
    updateModelOptions(provider);
  }

  function updateTypeHints(type) {
    const isAnthropic = type === 'anthropic';
    $('temperatureRow').hidden = isAnthropic;
    $('temperatureNote').hidden = !isAnthropic;

    const notes = {
      openai: '填到 /v1 为止，扩展会自动追加 /chat/completions。',
      anthropic: '填域名即可，扩展会自动追加 /v1/messages。',
      gemini: '填域名即可，扩展会自动追加 /v1beta/models/{model}:generateContent。'
    };
    $('baseUrlNote').textContent = notes[type] || '';
  }

  /** 本次会话内从服务商拉到的模型列表，providerId -> string[] */
  const fetchedModels = new Map();

  function updateModelOptions(provider) {
    const datalist = $('modelOptions');
    datalist.innerHTML = '';

    const fetched = fetchedModels.get(provider.id);
    let models = fetched;
    if (!models || !models.length) {
      const preset = TA.PROVIDER_PRESETS.find(
        (p) => p.type === provider.type && p.baseUrl && provider.baseUrl.startsWith(p.baseUrl)
      );
      models = preset ? preset.models : [];
    }

    models.forEach((m) => {
      const option = document.createElement('option');
      option.value = m;
      datalist.appendChild(option);
    });
  }

  $('fetchModels').addEventListener('click', async () => {
    const provider = readForm();
    if (!provider) return;

    const note = $('modelNote');
    const button = $('fetchModels');
    button.disabled = true;
    note.textContent = '正在向服务商查询…';

    try {
      const response = await chrome.runtime.sendMessage({
        type: TA.MSG.LIST_MODELS,
        payload: { provider }
      });
      if (response && response.ok) {
        const models = response.data.models;
        fetchedModels.set(provider.id, models);
        updateModelOptions(provider);
        note.textContent = `拉到 ${models.length} 个模型，点输入框查看。`;
      } else {
        note.textContent = '拉取失败：' + ((response && response.error) || '未知错误');
      }
    } catch (err) {
      note.textContent = '拉取失败：' + (err.message || String(err));
    } finally {
      button.disabled = false;
    }
  });

  /** 从表单读取当前编辑中的服务 */
  function readForm() {
    const base = providerById(selectedId);
    if (!base) return null;

    let extraHeaders = {};
    const rawHeaders = $('pHeaders').value.trim();
    if (rawHeaders) {
      try {
        const parsed = JSON.parse(rawHeaders);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extraHeaders = parsed;
      } catch (_) {
        // 语法未写完时保留旧值，不打断输入
        extraHeaders = base.extraHeaders || {};
      }
    }

    const temperatureRaw = $('pTemperature').value.trim();
    const provider = {
      id: base.id,
      name: $('pName').value.trim(),
      type: $('pType').value,
      baseUrl: $('pBaseUrl').value.trim(),
      apiKey: $('pApiKey').value.trim(),
      model: $('pModel').value.trim(),
      maxTokens: parseInt($('pMaxTokens').value, 10) || 4096,
      extraHeaders
    };
    if (temperatureRaw !== '' && provider.type !== 'anthropic') {
      const t = parseFloat(temperatureRaw);
      if (!Number.isNaN(t)) provider.temperature = t;
    }
    return provider;
  }

  function saveForm(immediate) {
    const provider = readForm();
    if (!provider) return;
    const providers = settings.providers.map((p) => (p.id === provider.id ? provider : p));
    if (immediate) commit({ providers });
    else debouncedCommit({ providers });
    // 让左侧列表立刻反映名称 / 模型的改动
    settings.providers = providers;
    renderList();
  }

  $('addProvider').addEventListener('click', async () => {
    const preset = TA.PROVIDER_PRESETS[0];
    const provider = Object.assign({}, TA.DEFAULT_PROVIDER, {
      id: TA.uid(),
      name: preset.name,
      type: preset.type,
      baseUrl: preset.baseUrl,
      model: preset.model
    });
    const providers = settings.providers.concat([provider]);
    const patch = { providers };
    if (!settings.activeProviderId) patch.activeProviderId = provider.id;
    await commit(patch);
    selectProvider(provider.id);
    $('pApiKey').focus();
  });

  $('deleteProvider').addEventListener('click', async () => {
    const provider = providerById(selectedId);
    if (!provider) return;
    if (!confirm(`确定删除「${provider.name || '未命名'}」？此操作无法撤销。`)) return;
    const providers = settings.providers.filter((p) => p.id !== provider.id);
    await commit({ providers });
    selectedId = settings.providers.length ? settings.providers[0].id : null;
    renderList();
    renderEditor();
  });

  $('preset').addEventListener('change', () => {
    const preset = TA.PROVIDER_PRESETS.find((p) => p.key === $('preset').value);
    if (!preset) return;
    $('pName').value = preset.name;
    $('pType').value = preset.type;
    $('pBaseUrl').value = preset.baseUrl;
    if (preset.model) $('pModel').value = preset.model;
    updateTypeHints(preset.type);
    saveForm(true);
    const provider = providerById(selectedId);
    if (provider) updateModelOptions(provider);
  });

  $('pType').addEventListener('change', () => {
    updateTypeHints($('pType').value);
    saveForm(true);
  });

  ['pName', 'pBaseUrl', 'pApiKey', 'pModel', 'pMaxTokens', 'pTemperature', 'pHeaders'].forEach(
    (id) => {
      $(id).addEventListener('input', () => saveForm(false));
    }
  );

  $('toggleKey').addEventListener('click', () => {
    const input = $('pApiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('testProvider').addEventListener('click', async () => {
    const provider = readForm();
    if (!provider) return;

    const result = $('testResult');
    result.hidden = false;
    result.className = 'test-result';
    result.textContent = '正在请求…';
    $('testProvider').disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: TA.MSG.TEST_PROVIDER,
        payload: { provider }
      });
      if (response && response.ok) {
        result.className = 'test-result ok';
        result.textContent = '连接成功 · 模型返回：' + response.data.text;
      } else {
        result.className = 'test-result err';
        result.textContent = '失败：' + ((response && response.error) || '未知错误');
      }
    } catch (err) {
      result.className = 'test-result err';
      result.textContent = '失败：' + (err.message || String(err));
    } finally {
      $('testProvider').disabled = false;
    }
  });

  /* ---------------------------- 偏好 / 高级 / 站点 ---------------------------- */

  function bindSelect(id, key) {
    $(id).addEventListener('change', () => commit({ [key]: $(id).value }));
  }

  function bindNumber(id, key, min, max) {
    $(id).addEventListener('change', () => {
      let value = parseInt($(id).value, 10);
      if (Number.isNaN(value)) value = TA.DEFAULT_SETTINGS[key];
      value = Math.max(min, Math.min(max, value));
      $(id).value = value;
      commit({ [key]: value });
    });
  }

  function bindTextarea(id, key, transform) {
    $(id).addEventListener('input', () => {
      debouncedCommit({ [key]: transform ? transform($(id).value) : $(id).value });
    });
  }

  bindSelect('targetLang', 'targetLang');
  bindSelect('displayMode', 'displayMode');
  bindSelect('translationStyle', 'translationStyle');
  bindSelect('triggerMode', 'triggerMode');
  bindTextarea('customPrompt', 'customPrompt');
  bindTextarea('autoSites', 'autoTranslateSites', linesToList);
  bindTextarea('neverSites', 'neverTranslateSites', linesToList);

  $('lazyTranslate').addEventListener('change', () =>
    commit({ lazyTranslate: $('lazyTranslate').checked })
  );
  bindNumber('batchSize', 'batchSize', 1, 40);
  bindNumber('maxCharsPerBatch', 'maxCharsPerBatch', 200, 20000);
  bindNumber('concurrency', 'concurrency', 1, 10);
  bindNumber('minTextLength', 'minTextLength', 1, 50);

  /* ---------------------------- 快捷键 ---------------------------- */

  /** Edge / Opera 的扩展页协议名和 Chrome 不一样，别写死 chrome:// */
  function shortcutsUrl() {
    const ua = navigator.userAgent;
    if (/\bEdg\//.test(ua)) return 'edge://extensions/shortcuts';
    if (/\bOPR\//.test(ua)) return 'opera://extensions/shortcuts';
    return 'chrome://extensions/shortcuts';
  }

  $('openShortcuts').addEventListener('click', () => {
    // 这类页面无法用 <a href> 跳转，只能由扩展开新标签页
    chrome.tabs.create({ url: shortcutsUrl() });
  });

  /* ---------------------------- 导入导出 ---------------------------- */

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trans-all-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());

  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object') throw new Error('文件格式不正确');
      settings = await TA.storage.set(parsed);
      selectedId = settings.providers.length ? settings.providers[0].id : null;
      render();
      flash('已导入');
    } catch (err) {
      flash('导入失败：' + (err.message || String(err)), true);
    } finally {
      event.target.value = '';
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('恢复默认设置会清除所有服务配置（含 API Key），确定继续？')) return;
    settings = await TA.storage.set(TA.DEFAULT_SETTINGS);
    selectedId = null;
    render();
    flash('已恢复默认');
  });

  /* ---------------------------- 渲染 ---------------------------- */

  function render() {
    fillSelect(
      $('targetLang'),
      TA.LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
      settings.targetLang
    );
    fillSelect($('displayMode'), TA.DISPLAY_MODES, settings.displayMode);
    fillSelect($('translationStyle'), TA.TRANSLATION_STYLES, settings.translationStyle);
    fillSelect($('triggerMode'), TA.TRIGGER_MODES, settings.triggerMode);
    fillSelect($('pType'), TA.PROVIDER_TYPES, null);
    fillSelect(
      $('preset'),
      [{ value: '', label: '— 选择预设 —' }].concat(
        TA.PROVIDER_PRESETS.map((p) => ({ value: p.key, label: p.name }))
      ),
      ''
    );

    $('customPrompt').value = settings.customPrompt || '';
    $('autoSites').value = (settings.autoTranslateSites || []).join('\n');
    $('neverSites').value = (settings.neverTranslateSites || []).join('\n');

    $('shortcutsHint').textContent = shortcutsUrl();
    $('lazyTranslate').checked = !!settings.lazyTranslate;
    $('batchSize').value = settings.batchSize;
    $('maxCharsPerBatch').value = settings.maxCharsPerBatch;
    $('concurrency').value = settings.concurrency;
    $('minTextLength').value = settings.minTextLength;

    renderList();
    renderEditor();
  }

  (async function init() {
    settings = await TA.storage.get();
    selectedId = settings.activeProviderId || (settings.providers[0] && settings.providers[0].id) || null;
    render();
  })();
})(globalThis.TA);
