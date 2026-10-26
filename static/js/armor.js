/* ════════════════════════════════════════════════════════════════════════
    J.A.R.V.I.S. · 钢铁侠战甲动态页面 ARMOR SUIT
    - 全屏 HUD 覆盖层（通过 dock 的 ARMOR 按钮开关）
    - 机甲图库切换（多套战甲配色 + 数据）
    - 电弧反应堆旋转动画
    - 四角仪表稳定数值漂移
    - 扫描线 / 网格背景 / 滚动字幕
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const overlay = $('armor-overlay');
  const closeBtn = $('armor-close');
  const statusLine = $('armor-status-line');
  const tickerTrack = $('armor-ticker-track');
  const galleryList = $('armor-gallery-list');
  const titleEl = document.querySelector('.armor-title');

  // 仪表元素
  const barRepulsor = $('armor-repulsor');
  const barFlight = $('armor-flight');
  const barPower = $('armor-power');
  const barHull = $('armor-hull');
  const readTarget = $('armor-target');
  const readCell = $('armor-cell');
  const readAlt = $('armor-alt');
  const readVel = $('armor-vel');

  // ── 机甲图库数据 ──────────────────────────────────────────────
  const SUITS = [
    { id: 'mk1',  name: 'MARK I',     accent: '#b8b8b8', power: 42, hull: 58, repulsor: 30, flight: 0,   cell: 45.2, alt: 0,       vel: 0.0,  status: 'PROTOTYPE · SUIT INTEGRITY COMPROMISED' },
    { id: 'mk3',  name: 'MARK III',   accent: '#e63946', power: 78, hull: 82, repulsor: 72, flight: 55,  cell: 74.6, alt: 8500,    vel: 1.2,  status: 'CLASSIC ARMOR · FLIGHT STABILIZED' },
    { id: 'mk7',  name: 'MARK VII',   accent: '#ff9f1c', power: 88, hull: 86, repulsor: 85, flight: 78,  cell: 86.3, alt: 11200,   vel: 1.9,  status: 'BATTLE-READY · REPULSORS ARMED' },
    { id: 'mk42', name: 'MARK XLII',  accent: '#00f0ff', power: 92, hull: 88, repulsor: 90, flight: 84,  cell: 98.7, alt: 12400,   vel: 2.4,  status: 'SYSTEMS NOMINAL · SUIT INTEGRITY 100%' },
    { id: 'mk50', name: 'MARK L',     accent: '#ff2d55', power: 96, hull: 94, repulsor: 95, flight: 92,  cell: 99.4, alt: 16500,   vel: 3.2,  status: 'NANOTECH · MAXIMUM OUTPUT ONLINE' },
    { id: 'hb',   name: 'HULKBUSTER', accent: '#d4af37', power: 98, hull: 99, repulsor: 88, flight: 60,  cell: 91.8, alt: 5200,    vel: 0.6,  status: 'HEAVY ARMOR · HULL PLATING MAXIMUM' },
  ];

  let currentSuit = SUITS.find((s) => s.id === 'mk42') || SUITS[0];
  let animRunning = false;
  let rafId = null;
  let animStart = 0;

  // 状态文案轮换（每 6 秒，避免快速跳动）
  const statusLines = [
    'SYSTEMS NOMINAL · SUIT INTEGRITY 100%',
    'ARC REACTOR STABLE · OUTPUT NOMINAL',
    'TARGETING ARRAY CALIBRATED',
    'FLIGHT SYSTEMS ARMED',
    'POWER CELL AT OPTIMAL CHARGE',
  ];

  function applySuit(suit) {
    currentSuit = suit;
    const accent = suit.accent;

    // 覆盖全局 CSS 变量 --accent（反应堆 / 标题 / 进度条配色）
    if (overlay) overlay.style.setProperty('--accent', accent);

    if (titleEl) titleEl.textContent = suit.name;
    if (statusLine) statusLine.textContent = suit.status;

    // 更新 chips active 状态
    if (galleryList) {
      Array.from(galleryList.children).forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.suit === suit.id);
      });
    }

    // 立刻刷新读数（下一帧动画会继续平滑漂移）
    setBar(barRepulsor, suit.repulsor);
    setBar(barFlight, suit.flight);
    setBar(barPower, suit.power);
    setBar(barHull, suit.hull);
  }

  function setBar(el, v) {
    if (el) el.style.width = Math.max(2, Math.min(100, v)) + '%';
  }

  function buildGallery() {
    if (!galleryList) return;
    galleryList.innerHTML = '';
    SUITS.forEach((suit) => {
      const chip = document.createElement('div');
      chip.className = 'armor-chip';
      chip.dataset.suit = suit.id;
      chip.textContent = suit.name;
      chip.addEventListener('click', () => applySuit(suit));
      galleryList.appendChild(chip);
    });
  }

  // 目标阵列准星（缓慢交替）
  function renderTarget(sec) {
    if (!readTarget) return;
    const n = 5;
    const phase = Math.floor(sec / 2); // 每 2 秒切换一次
    let s = '';
    for (let i = 0; i < n; i++) {
      s += ((i + phase) % 2 === 0) ? '● ' : '○ ';
    }
    readTarget.textContent = s.trim();
  }

  function animate(now) {
    if (!animRunning) return;
    if (!animStart) animStart = now;
    const t = (now - animStart) / 1000; // 秒

    // 仪表条：基于机甲基础值做小幅慢速漂移
    const bar = (el, base, amp, speed, phase) => {
      if (!el) return;
      const v = base + amp * Math.sin(t * speed + phase);
      el.style.width = Math.max(2, Math.min(100, v)) + '%';
    };
    bar(barRepulsor, currentSuit.repulsor, 4, 0.5, 0);
    bar(barFlight, currentSuit.flight, 6, 0.4, 1.3);
    bar(barPower, currentSuit.power, 3, 0.6, 2.1);
    bar(barHull, currentSuit.hull, 2, 0.3, 0.6);

    // 数值读数：围绕机甲基础值小幅漂移（不再疯狂跳动）
    if (readCell) {
      const v = currentSuit.cell + Math.sin(t * 0.5) * 0.4;
      readCell.textContent = Math.max(0, Math.min(100, v)).toFixed(1) + '%';
    }
    if (readAlt) {
      const v = currentSuit.alt + Math.sin(t * 0.4) * 120;
      readAlt.textContent = Math.round(Math.max(0, v)).toLocaleString() + ' M';
    }
    if (readVel) {
      const v = currentSuit.vel + Math.sin(t * 0.35) * 0.08;
      readVel.textContent = 'MACH ' + Math.max(0, v).toFixed(1);
    }
    renderTarget(t);

    // 状态行：每 6 秒切换一次机甲自带状态文案
    if (statusLine) {
      const idx = Math.floor(t / 6) % statusLines.length;
      statusLine.textContent = statusLines[idx];
    }

    rafId = requestAnimationFrame(animate);
  }

  function startAnim() {
    if (animRunning) return;
    animRunning = true;
    animStart = 0;
    rafId = requestAnimationFrame(animate);
  }

  function stopAnim() {
    animRunning = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function syncFromClosed() {
    const closed = overlay.classList.contains('closed');
    if (closed) {
      stopAnim();
    } else {
      startAnim();
    }
  }

  function close() {
    overlay.classList.add('closed');
    const btn = document.querySelector('.dock-btn[data-panel="armor"]');
    if (btn) btn.classList.remove('active');
    syncFromClosed();
  }

  function init() {
    if (!overlay) return;

    buildGallery();
    applySuit(currentSuit);

    if (closeBtn) closeBtn.addEventListener('click', close);

    // 监听 closed class 变化（dock 按钮切换时）
    const observer = new MutationObserver(syncFromClosed);
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('closed')) close();
    });

    syncFromClosed();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
