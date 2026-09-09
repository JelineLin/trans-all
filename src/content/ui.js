/* Trans All — 浮层 UI（划词按钮 / 译文面板 / 进度条）。用 Shadow DOM 隔离站点样式。 */
globalThis.TA = globalThis.TA || {};

(function (TA) {
  'use strict';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }

/* ---------------- 一次性提示 ---------------- */
/* 快捷键失败过去是完全静默的，用户分不清是「快捷键没生效」还是「没选中文字」 */
.toast {
  position: fixed;
  z-index: 2147483647;
  left: 50%;
  top: 24px;
  transform: translateX(-50%);
  display: none;
  padding: 8px 16px;
  background: rgba(31, 35, 40, 0.92);
  color: #fff;
  border-radius: 999px;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  user-select: none;
}
.toast.show { display: block; }

.trigger, .panel, .hud {
  position: fixed;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  color-scheme: light dark;
}

/* ---------------- 划词按钮 ---------------- */
.trigger {
  width: 28px; height: 28px;
  display: none;
  align-items: center; justify-content: center;
  background: #1f6feb;
  color: #fff;
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0,0,0,.28);
  font-size: 14px; font-weight: 700; line-height: 1;
  user-select: none;
  transition: transform .12s ease, background .12s ease;
}
.trigger:hover { background: #1a5fd0; transform: scale(1.06); }
.trigger.show { display: flex; }

/* ---------------- 译文面板 ---------------- */
.panel {
  display: none;
  /* 划词译文是词典式的多行内容，窄了会频繁折行 */
  width: 420px;
  max-width: calc(100vw - 24px);
  background: #ffffff;
  color: #1f2328;
  border: 1px solid #d8dee4;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,.18);
  overflow: hidden;
  font-size: 14px;
  line-height: 1.6;
}
.panel.show { display: block; }

.panel-head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  background: #f6f8fa;
  border-bottom: 1px solid #d8dee4;
  font-size: 12px;
  cursor: move;
  user-select: none;
}
.panel-title { font-weight: 600; color: #1f6feb; }
.panel-meta { color: #656d76; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-spacer { flex: 1; }
.icon-btn {
  border: none; background: transparent; cursor: pointer;
  color: #656d76; font-size: 13px; line-height: 1;
  padding: 4px 6px; border-radius: 6px;
  font-family: inherit;
}
.icon-btn:hover { background: rgba(0,0,0,.07); color: #1f2328; }

.panel-body { padding: 10px 12px; max-height: 56vh; overflow-y: auto; }
.panel-source {
  color: #656d76;
  font-size: 13px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px dashed #d8dee4;
  max-height: 6.4em;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.panel-result { white-space: pre-wrap; word-break: break-word; min-height: 1.6em; }
.panel-result.error { color: #cf222e; }
.panel-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid #d8dee4;
  font-size: 12px; color: #656d76;
}
.text-btn {
  border: none; background: transparent; cursor: pointer;
  color: #1f6feb; font-size: 12px; padding: 2px 4px; border-radius: 4px;
  font-family: inherit;
}
.text-btn:hover { background: rgba(31,111,235,.1); }

.caret {
  display: inline-block; width: 7px; height: 1em;
  background: currentColor; opacity: .5;
  vertical-align: text-bottom;
  animation: ta-blink 1s steps(2, start) infinite;
}
@keyframes ta-blink { to { visibility: hidden; } }

/* ---------------- 进度条 ---------------- */
.hud {
  display: none;
  left: 16px; bottom: 16px;
  align-items: center; gap: 10px;
  padding: 7px 12px;
  background: rgba(31,35,40,.92);
  color: #fff;
  border-radius: 999px;
  font-size: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,.3);
  user-select: none;
}
.hud.show { display: flex; }
.hud-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #3fb950;
  animation: ta-pulse 1.2s ease-in-out infinite;
}
.hud.idle .hud-dot { animation: none; background: #8b949e; }
@keyframes ta-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.hud-btn {
  border: none; background: rgba(255,255,255,.14); color: #fff;
  cursor: pointer; font-size: 11px; padding: 3px 8px; border-radius: 999px;
  font-family: inherit;
}
.hud-btn:hover { background: rgba(255,255,255,.26); }

@media (prefers-color-scheme: dark) {
  .panel { background: #1c2128; color: #e6edf3; border-color: #30363d; }
  .panel-head { background: #22272e; border-bottom-color: #30363d; }
  .panel-meta, .panel-source, .panel-foot, .icon-btn { color: #909dab; }
  .panel-source { border-bottom-color: #30363d; }
  .panel-foot { border-top-color: #30363d; }
  .icon-btn:hover { background: rgba(255,255,255,.1); color: #e6edf3; }
  .panel-title, .text-btn { color: #4493f8; }
}
`;

  let host = null;
  let root = null;
  let els = null;
  let dragState = null;
  let toastTimer = null;

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'ta-root';
    host.className = 'ta-ui';
    host.setAttribute('translate', 'no');
    host.setAttribute('data-ta-ignore', '');
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const holder = document.createElement('div');
    holder.innerHTML = `
      <div class="trigger" title="翻译选中文本">译</div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">Trans All</span>
          <span class="panel-meta"></span>
          <span class="panel-spacer"></span>
          <button class="icon-btn js-close" title="关闭">✕</button>
        </div>
        <div class="panel-body">
          <div class="panel-source"></div>
          <div class="panel-result"></div>
        </div>
        <div class="panel-foot">
          <button class="text-btn js-copy">复制译文</button>
          <button class="text-btn js-retry">重试</button>
          <span class="panel-spacer"></span>
          <span class="js-status"></span>
        </div>
      </div>
      <div class="hud">
        <span class="hud-dot"></span>
        <span class="js-hud-text">翻译中…</span>
        <button class="hud-btn js-hud-action">还原</button>
      </div>
      <div class="toast"></div>
    `;
    while (holder.firstChild) root.appendChild(holder.firstChild);

    els = {
      trigger: root.querySelector('.trigger'),
      panel: root.querySelector('.panel'),
      head: root.querySelector('.panel-head'),
      meta: root.querySelector('.panel-meta'),
      source: root.querySelector('.panel-source'),
      result: root.querySelector('.panel-result'),
      status: root.querySelector('.js-status'),
      close: root.querySelector('.js-close'),
      copy: root.querySelector('.js-copy'),
      retry: root.querySelector('.js-retry'),
      hud: root.querySelector('.hud'),
      hudText: root.querySelector('.js-hud-text'),
      hudAction: root.querySelector('.js-hud-action'),
      toast: root.querySelector('.toast')
    };

    // 挂在 documentElement 而不是 body：SPA 换页时常整个替换 body，
    // 挂 body 的话划词按钮、译文面板、进度条会一起被带走且不会自己回来
    (document.documentElement || document.body).appendChild(host);

    els.close.addEventListener('click', () => TA.ui.hidePanel());
    els.copy.addEventListener('click', () => {
      const text = els.result.textContent || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        () => {
          els.copy.textContent = '已复制';
          setTimeout(() => (els.copy.textContent = '复制译文'), 1400);
        },
        () => {
          els.copy.textContent = '复制失败';
          setTimeout(() => (els.copy.textContent = '复制译文'), 1400);
        }
      );
    });

    // 面板可拖动
    els.head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const rect = els.panel.getBoundingClientRect();
      dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      place(els.panel, e.clientX - dragState.dx, e.clientY - dragState.dy);
    });
    document.addEventListener('mouseup', () => (dragState = null));
  }

  /** 把浮层限制在视口内 */
  function place(el, left, top) {
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - 8;
    const maxTop = window.innerHeight - rect.height - 8;
    el.style.left = Math.max(8, Math.min(left, maxLeft)) + 'px';
    el.style.top = Math.max(8, Math.min(top, maxTop)) + 'px';
  }

  TA.ui = {
    init: build,

    /** 事件是否发生在我们自己的 UI 上 */
    isOwn(target) {
      return !!host && (target === host || (target && host.contains(target)));
    },

    showTrigger(rect, onClick) {
      build();
      els.trigger.classList.add('show');
      place(els.trigger, rect.right + 6, rect.bottom + 6);
      els.trigger.onclick = (e) => {
        e.stopPropagation();
        onClick();
      };
    },

    hideTrigger() {
      if (els) els.trigger.classList.remove('show');
    },

    /** 打开面板并进入等待状态 */
    openPanel(rect, options) {
      build();
      TA.ui.hideTrigger();
      els.panel.classList.add('show');
      els.meta.textContent = options.meta || '';
      els.source.textContent = options.original || '';
      els.source.style.display = options.original ? '' : 'none';
      els.result.className = 'panel-result';
      els.result.textContent = '';
      const caret = document.createElement('span');
      caret.className = 'caret';
      els.result.appendChild(caret);
      els.status.textContent = '翻译中…';
      els.retry.onclick = options.onRetry || null;
      els.retry.style.display = options.onRetry ? '' : 'none';

      // 优先显示在选区下方，空间不够则放上方
      const panelRect = els.panel.getBoundingClientRect();
      const below = rect.bottom + 8;
      const top = below + panelRect.height > window.innerHeight - 8
        ? Math.max(8, rect.top - panelRect.height - 8)
        : below;
      place(els.panel, rect.left, top);
    },

    appendDelta(delta) {
      if (!els) return;
      const caret = els.result.querySelector('.caret');
      const node = document.createTextNode(delta);
      if (caret) els.result.insertBefore(node, caret);
      else els.result.appendChild(node);
    },

    finishPanel(text) {
      if (!els) return;
      els.result.className = 'panel-result';
      els.result.textContent = text;
      els.status.textContent = '完成';
    },

    errorPanel(message) {
      if (!els) return;
      els.result.className = 'panel-result error';
      els.result.textContent = message;
      els.status.textContent = '失败';
    },

    setPanelMeta(text) {
      if (els) els.meta.textContent = text || '';
    },

    hidePanel() {
      if (!els) return;
      els.panel.classList.remove('show');
      els.result.textContent = '';
      if (TA.ui.onPanelClose) TA.ui.onPanelClose();
    },

    isPanelOpen() {
      return !!els && els.panel.classList.contains('show');
    },

    /** 短暂提示。用于把过去静默失败的路径暴露出来。 */
    toast(message) {
      build();
      els.toast.textContent = message;
      els.toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
    },

    hud: {
      show(text, actionLabel, onAction) {
        build();
        els.hud.classList.add('show');
        els.hudText.textContent = text;
        els.hudAction.textContent = actionLabel;
        els.hudAction.onclick = onAction;
      },
      update(text, idle) {
        if (!els) return;
        els.hudText.textContent = text;
        els.hud.classList.toggle('idle', !!idle);
      },
      setAction(label, onAction) {
        if (!els) return;
        els.hudAction.textContent = label;
        els.hudAction.onclick = onAction;
      },
      hide() {
        if (els) els.hud.classList.remove('show');
      }
    }
  };
})(globalThis.TA);
