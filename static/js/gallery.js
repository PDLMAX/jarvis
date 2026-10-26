/* ════════════════════════════════════════════════════════════════════════
    J.A.R.V.I.S. · 本地相册 GALLERY
    - 从 media/photos/ 读取图片列表（后端 /api/photos）
    - 网格缩略图展示
    - 全屏幻灯片播放（自动切换 + 手动前后翻页）
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let photos = [];
  let slideIdx = 0;
  let slideTimer = null;
  let slidePlaying = false;

  const grid = $('gallery-grid');
  const countEl = $('gallery-count');
  const statusEl = $('gallery-status');
  const slideBtn = $('gallery-slideshow');

  // 幻灯片元素
  const overlay = $('slideshow-overlay');
  const slideImg = $('slideshow-img');
  const slideCaption = $('slideshow-caption');
  const slideClose = $('slideshow-close');
  const slidePrev = $('slideshow-prev');
  const slideNext = $('slideshow-next');

  function photoUrl(name) {
    return '/api/photos/' + encodeURIComponent(name);
  }

  async function loadPhotos() {
    if (!grid) return;
    try {
      const resp = await fetch('/api/photos');
      const data = await resp.json();
      if (!data.ok) { setStatus('加载失败'); return; }
      photos = data.photos || [];
      renderGrid();
      countEl.textContent = photos.length + ' 张照片';
      if (photos.length === 0) {
        setStatus('相册为空 · 请把照片放入 media/photos/ 目录');
      } else {
        setStatus('就绪 · ' + photos.length + ' 张照片已就绪');
      }
    } catch (e) {
      setStatus('加载失败: ' + e.message);
    }
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  function renderGrid() {
    grid.innerHTML = '';
    if (photos.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'gallery-empty';
      empty.textContent = '📷 暂无照片 · 将图片放入 media/photos/ 目录后刷新';
      grid.appendChild(empty);
      return;
    }
    photos.forEach((p, idx) => {
      const cell = document.createElement('div');
      cell.className = 'gallery-cell';
      const img = document.createElement('img');
      img.src = photoUrl(p.name);
      img.alt = p.name;
      img.loading = 'lazy';
      img.addEventListener('click', () => openSlide(idx));
      img.addEventListener('error', () => { img.style.opacity = '0.2'; });
      const name = document.createElement('div');
      name.className = 'gallery-cell-name';
      name.textContent = p.name;
      cell.appendChild(img);
      cell.appendChild(name);
      grid.appendChild(cell);
    });
  }

  function openSlide(idx) {
    slideIdx = idx;
    slidePlaying = true;
    overlay.classList.add('active');
    showSlide();
    startAutoPlay();
  }

  function closeSlide() {
    slidePlaying = false;
    stopAutoPlay();
    overlay.classList.remove('active');
  }

  function showSlide() {
    if (!photos.length) return;
    const p = photos[slideIdx];
    slideImg.src = photoUrl(p.name);
    slideCaption.textContent = `[${slideIdx + 1} / ${photos.length}]  ${p.name}`;
  }

  function next() { if (!photos.length) return; slideIdx = (slideIdx + 1) % photos.length; showSlide(); }
  function prev() { if (!photos.length) return; slideIdx = (slideIdx - 1 + photos.length) % photos.length; showSlide(); }

  function startAutoPlay() {
    stopAutoPlay();
    slideTimer = setInterval(() => { if (slidePlaying) next(); }, 3000);
  }
  function stopAutoPlay() { if (slideTimer) { clearInterval(slideTimer); slideTimer = null; } }

  function init() {
    loadPhotos();
    if (slideBtn) {
      slideBtn.addEventListener('click', () => {
        if (!photos.length) { setStatus('相册为空，无法播放幻灯片'); return; }
        openSlide(0);
      });
    }
    if (slideClose) slideClose.addEventListener('click', closeSlide);
    if (slidePrev) slidePrev.addEventListener('click', () => { prev(); });
    if (slideNext) slideNext.addEventListener('click', () => { next(); });
    // 键盘：左右键翻页，ESC 退出
    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('active')) return;
      if (e.key === 'Escape') closeSlide();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSlide();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
