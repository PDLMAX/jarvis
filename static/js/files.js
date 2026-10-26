/* ════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. · LOCAL ARCHIVE
   Home-restricted folder browser + filename search + text preview.
   Backend: GET /api/browse, /api/search, /api/read
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentPath = '~';
  let homeRoot = null;
  let mode = 'browse';                       // 'browse' | 'search'

  const TEXT_EXTS = [
    'txt', 'md', 'py', 'js', 'ts', 'json', 'csv', 'log', 'html', 'css',
    'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bat', 'rst', 'rtf',
    'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'sql', 'swift', 'kt',
  ];

  const fmtSize = (b) => {
    if (b == null || b === 0) return '';
    if (b < 1024) return b + 'B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K';
    return (b / 1024 / 1024).toFixed(1) + 'M';
  };
  const extOf = (name) => {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
  };
  const childPath = (name) => currentPath.replace(/\/$/, '') + '/' + name;

  function setStatus(text, isErr) {
    const el = $('files-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
  }
  function setPath(text) { const el = $('files-path'); if (el) el.textContent = text; }

  /* ── 浏览目录 ─────────────────────────────────────────────── */
  async function browse(path) {
    mode = 'browse';
    setStatus('加载中…');
    try {
      const resp = await fetch('/api/browse?path=' + encodeURIComponent(path));
      const data = await resp.json();
      if (!data.ok) { setStatus(data.error || '浏览失败', true); return; }
      currentPath = data.path;
      if (!homeRoot) homeRoot = data.path;
      setPath(data.path);
      renderBrowse(data.items || []);
    } catch (e) {
      setStatus('网络错误: ' + e.message, true);
    }
  }

  function renderBrowse(items) {
    const body = $('files-body');
    if (!body) return;
    body.innerHTML = '';
    if (items.length === 0) {
      body.innerHTML = '<div class="files-empty">— 空目录 —</div>';
      setStatus('0 项');
      return;
    }
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'file-row' + (it.is_dir ? ' dir' : '');
      row.innerHTML =
        '<span class="f-icon">' + (it.is_dir ? '📁' : '📄') + '</span>' +
        '<span class="f-name"></span>' +
        '<span class="f-size">' + (it.is_dir ? '' : fmtSize(it.size)) + '</span>';
      row.querySelector('.f-name').textContent = it.name;
      row.addEventListener('click', () => {
        if (it.is_dir) browse(childPath(it.name));
        else openFile(childPath(it.name), it.name);
      });
      body.appendChild(row);
    });
    setStatus(items.length + ' 项');
  }

  /* ── 搜索 ────────────────────────────────────────────────── */
  async function search(q) {
    mode = 'search';
    setStatus('搜索中…');
    try {
      const resp = await fetch('/api/search?q=' + encodeURIComponent(q) +
        '&path=' + encodeURIComponent(currentPath));
      const data = await resp.json();
      if (!data.ok) { setStatus(data.error || '搜索失败', true); return; }
      renderSearch(data.results || [], data.total || 0);
    } catch (e) {
      setStatus('网络错误: ' + e.message, true);
    }
  }

  function renderSearch(results, total) {
    const body = $('files-body');
    if (!body) return;
    body.innerHTML = '';
    if (results.length === 0) {
      body.innerHTML = '<div class="files-empty">— 无匹配 —</div>';
      setStatus('0 项');
      return;
    }
    results.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'file-row' + (r.is_dir ? ' dir' : '');
      row.innerHTML =
        '<span class="f-icon">' + (r.is_dir ? '📁' : '📄') + '</span>' +
        '<span class="f-name"></span>' +
        '<span class="f-size">' + (r.is_dir ? '' : fmtSize(r.size)) + '</span>';
      row.querySelector('.f-name').textContent = r.path || r.name;
      row.addEventListener('click', () => {
        if (r.is_dir) browse(r.path);
        else openFile(r.path, r.name);
      });
      body.appendChild(row);
    });
    setStatus(total + ' 项');
  }

  /* ── 打开文件（文本预览） ─────────────────────────────────── */
  async function openFile(path, name) {
    const ext = extOf(name);
    if (!TEXT_EXTS.includes(ext)) {
      setStatus('不支持预览: ' + (ext || '无扩展名'), true);
      return;
    }
    setStatus('读取中…');
    try {
      const resp = await fetch('/api/read?path=' + encodeURIComponent(path));
      const data = await resp.json();
      if (!data.ok) { setStatus(data.error || '读取失败', true); return; }
      setStatus('');
      showPreview(data);
    } catch (e) {
      setStatus('网络错误: ' + e.message, true);
    }
  }

  function showPreview(data) {
    let overlay = $('file-preview');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'file-preview';
      overlay.className = 'file-preview hidden';
      overlay.innerHTML =
        '<div class="file-preview-box">' +
        '<div class="file-preview-head"><span id="fp-title">—</span><span class="fp-close" id="fp-close">×</span></div>' +
        '<pre class="file-preview-content" id="fp-content"></pre>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closePreview(); });
      const close = $('fp-close');
      if (close) close.addEventListener('click', closePreview);
    }
    $('fp-title').textContent = data.name;
    $('fp-content').textContent = data.content || '(空文件)';
    overlay.classList.remove('hidden');
  }
  function closePreview() {
    const o = $('file-preview');
    if (o) o.classList.add('hidden');
  }

  /* ── 上级目录 / HOME ──────────────────────────────────────── */
  function goUp() {
    if (mode !== 'browse') { browse(currentPath); return; }
    if (!currentPath || currentPath === '/' || currentPath === homeRoot) {
      setStatus('已在 HOME 根目录');
      return;
    }
    const parent = currentPath.replace(/\/[^/]+$/, '') || '/';
    if (homeRoot && !parent.startsWith(homeRoot)) { setStatus('已在 HOME 根目录'); return; }
    browse(parent);
  }

  function init() {
    const up = $('files-up'), home = $('files-home');
    const input = $('files-search-input'), btn = $('files-search-btn');
    if (up) up.addEventListener('click', goUp);
    if (home) home.addEventListener('click', () => browse('~'));
    const doSearch = () => {
      const q = (input ? input.value : '').trim();
      if (!q) { browse(currentPath); return; }
      search(q);
    };
    if (btn) btn.addEventListener('click', doSearch);
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    browse('~');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
