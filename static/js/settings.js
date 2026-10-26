/* ════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. · SETTINGS
   Backend: GET /api/config, PUT /api/config
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // 表单字段 id -> 配置点路径；secret 字段留空 = 不修改原值
  const FIELDS = [
    { id: 'cfg-llm-provider',          path: 'llm.provider',          secret: false },
    { id: 'cfg-llm-deepseek-api_key',  path: 'llm.deepseek.api_key',  secret: true  },
    { id: 'cfg-llm-deepseek-base_url', path: 'llm.deepseek.base_url', secret: false },
    { id: 'cfg-llm-deepseek-model',    path: 'llm.deepseek.model',    secret: false },
    { id: 'cfg-llm-volcark-api_key',   path: 'llm.volcark.api_key',   secret: true  },
    { id: 'cfg-llm-volcark-base_url',  path: 'llm.volcark.base_url',  secret: false },
    { id: 'cfg-llm-volcark-model',     path: 'llm.volcark.model',     secret: false },
    { id: 'cfg-tts-engine',            path: 'tts.engine',            secret: false },
    { id: 'cfg-tts-volc-app_id',       path: 'tts.volc.app_id',       secret: false },
    { id: 'cfg-tts-volc-access_key',   path: 'tts.volc.access_key',   secret: true  },
    { id: 'cfg-tts-volc-speaker',      path: 'tts.volc.speaker',      secret: false },
    { id: 'cfg-network-use_proxy',     path: 'network.use_proxy',     secret: false },
  ];

  let configData = null;

  const badgeId = (path) => 'badge-' + path.replace(/\./g, '-');

  const getPath = (path) =>
    path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : null), configData);

  function setStatus(text, isErr) {
    const el = $('settings-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
  }

  function updateBadge(path, configured) {
    const el = $(badgeId(path));
    if (!el) return;
    el.textContent = configured ? '已配置' : '未配置';
    el.classList.toggle('ok', !!configured);
  }

  function renderForm() {
    FIELDS.forEach((f) => {
      const el = $(f.id);
      if (!el) return;
      const val = getPath(f.path);
      if (f.secret) {
        el.value = '';
        const cfg = !!(val && val.configured);
        el.placeholder = cfg ? ('已配置 · ' + val.value) : '留空则不修改';
        updateBadge(f.path, cfg);
      } else {
        el.value = val == null ? '' : String(val);
      }
    });
  }

  function renderSummary() {
    const el = $('settings-summary');
    if (!el) return;
    const provider = getPath('llm.provider') || 'deepseek';
    const llmKey = getPath('llm.' + provider + '.api_key');
    const llmOk = !!(llmKey && llmKey.configured);
    const ttsKey = getPath('tts.volc.access_key');
    const ttsOk = !!(ttsKey && ttsKey.configured);
    el.innerHTML =
      '<span class="settings-chip' + (llmOk ? ' ok' : '') + '">LLM·' + provider.toUpperCase() + (llmOk ? ' ✓' : ' ✗') + '</span>' +
      '<span class="settings-chip' + (ttsOk ? ' ok' : '') + '">TTS·豆包' + (ttsOk ? ' ✓' : ' ✗') + '</span>';
  }

  async function loadConfig() {
    setStatus('加载中…', false);
    try {
      const resp = await fetch('/api/config');
      const data = await resp.json();
      if (!data.ok) { setStatus(data.error || '加载失败', true); return; }
      configData = data.config;
      renderForm();
      renderSummary();
      setStatus('就绪', false);
    } catch (e) {
      setStatus('网络错误: ' + e.message, true);
    }
  }

  function collectPatch() {
    const patch = {};
    FIELDS.forEach((f) => {
      const el = $(f.id);
      if (!el) return;
      const v = (el.value || '').trim();
      if (f.secret) {
        if (v) patch[f.path] = v;
      } else {
        patch[f.path] = v;
      }
    });
    // 平铺点路径 -> 嵌套对象
    const body = {};
    Object.keys(patch).forEach((path) => {
      const parts = path.split('.');
      let node = body;
      parts.slice(0, -1).forEach((k) => { node[k] = node[k] || {}; node = node[k]; });
      node[parts[parts.length - 1]] = patch[path];
    });
    return body;
  }

  async function saveConfig() {
    const btn = $('settings-save');
    if (btn) btn.disabled = true;
    setStatus('保存中…', false);
    try {
      const resp = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectPatch()),
      });
      const data = await resp.json();
      if (!data.ok) { setStatus(data.error || '保存失败', true); return; }
      configData = data.config;
      renderForm();
      renderSummary();
      setStatus('✓ 已保存并生效', false);
    } catch (e) {
      setStatus('网络错误: ' + e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function init() {
    const btn = $('settings-save');
    if (btn) btn.addEventListener('click', saveConfig);
    loadConfig();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
