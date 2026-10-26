/* ════════════════════════════════════════════════════════════════════════
    J.A.R.V.I.S. · 前端主逻辑
    - Three.js 背景球体 + 实时频谱环
    - Web Speech API 语音识别（中英双向）
    - Web Audio API 麦克风采集 + 提示音
    - Socket.IO 后端通信
    - PTT 按压对讲
    - 全息 HUD 系统（可拖动面板 + 工具库）
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const bgCanvas       = $('bg-canvas');
  const spectrumCanvas = $('core-spectrum');
  const statusLight    = $('status-light');
  const statusText     = $('status-text');
  const tickerInner    = $('ticker-inner');
  const consoleBody    = $('console-body');
  const coreBtn        = $('core-btn');
  const pttOverlay     = $('ptt-overlay');
  const pttText        = $('ptt-text');
  const btnDoubao      = $('engine-doubao');
  const btnEdge        = $('engine-edge');
  const btnPy          = $('engine-pyttsx3');

  let socket, recognition = null, audioCtx = null, analyser = null, micStream = null;
  let ttsEngine = 'doubao', isRecording = false;
  let scene, camera, renderer, icosa, particles, clock;
  let mouseX = 0, mouseY = 0;
  const spectrumCtx = spectrumCanvas.getContext('2d');

  const setStatus = (state, label) => {
    statusLight.className = 'status-light' + (state === 'idle' ? '' : ' ' + state);
    statusText.textContent = label || state.toUpperCase();
  };
  let setBackendStatus = (state, label) => {
    statusLight.className = 'status-light' + (state === 'idle' ? '' : ' ' + state);
    statusText.textContent = label || state.toUpperCase();
  };
  const logTo = (text, cls) => {
    // Route legacy console_log messages into the chat panel
    if (!text || !chatBody) return;
    if (cls === "user") {
      chatAddMsg("user", text.replace(/^\[识别\]\s*/, ""));
    } else if (cls === "bot" || cls === "speaking") {
      chatAddMsg("bot", text.replace(/^\[J·A·R·V·I·S\]\s*/, ""));
    } else if (cls === "error") {
      chatAddErr(text);
    }
  };
  const setTicker = (text) => { tickerInner.textContent = '⌬ ' + text; };
  // 暴露给原生 App 桥接：语音错误提示（Swift 经 evaluateJavaScript 调用）
  window.jarvisVoiceError = (msg) => { logTo('[语音] ' + msg, 'error'); };

  /* ══════════════════════════════════════════════════════════════
      1) Three.js 背景
     ══════════════════════════════════════════════════════════════ */
  function initThree() {
    scene    = new THREE.Scene();
    camera   = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 100);
    camera.position.z = 5.5;
    renderer = new THREE.WebGLRenderer({ canvas: bgCanvas, alpha: true, antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const geo = new THREE.IcosahedronGeometry(2, 3);
    const mat = new THREE.ShaderMaterial({
      uniforms:     { uTime: { value: 0 }, uVol: { value: 0 } },
      vertexShader:   'varying vec3 vPos; void main(){ vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying vec3 vPos; uniform float uTime; uniform float uVol; void main(){ float f=0.5+0.5*sin(uTime*1.4+vPos.y*4.0+uVol*1.5); vec3 c=mix(vec3(0.0,0.5,0.85),vec3(0.0,0.94,1.0),f); gl_FragColor=vec4(c,0.85); }',
      transparent: true, side: THREE.DoubleSide, wireframe: true,
    });
    icosa = new THREE.Mesh(geo, mat);
    scene.add(icosa);
    const N = 2000, pos = new Float32Array(N*3), orig = new Float32Array(N*3), R = 2.0;
    for (let i = 0; i < N; i++) {
      const t = Math.acos(2*Math.random()-1), p = 2*Math.PI*Math.random();
      const x = R*Math.sin(t)*Math.cos(p), y = R*Math.sin(t)*Math.sin(p), z = R*Math.cos(t);
      pos.set([x,y,z], i*3); orig.set([x,y,z], i*3);
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pGeo.userData.orig = orig;
    particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0x00f0ff, size: 0.025, transparent: true, opacity: 0.7 }));
    scene.add(particles);
    clock = new THREE.Clock();
    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
    animate();
  }
  function onResize() { camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); }
  function onMouseMove(e) { mouseX = (e.clientX/innerWidth)*2-1; mouseY = (e.clientY/innerHeight)*2-1; }

  let vol = 0;
  const _volBuf = new Uint8Array(128);
  function currentVolume() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(_volBuf);
    let sum = 0;
    for (let i = 0; i < _volBuf.length; i++) { const v = (_volBuf[i]-128)/128; sum += v*v; }
    return Math.sqrt(sum / _volBuf.length);
  }
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    icosa.rotation.x += (mouseY*0.4 - icosa.rotation.x)*0.04;
    icosa.rotation.y += (mouseX*0.6 - icosa.rotation.y)*0.04;
    icosa.rotation.z += 0.0015;
    const attr = particles.geometry.getAttribute('position'), orig = particles.geometry.userData.orig;
    vol = analyser ? currentVolume() : 0;
    const push = 1 + vol*1.8;
    for (let i = 0; i < attr.count; i++) attr.setXYZ(i, orig[i*3]*push, orig[i*3+1]*push, orig[i*3+2]*push);
    attr.needsUpdate = true;
    icosa.material.uniforms.uTime.value = t;
    icosa.material.uniforms.uVol.value  = vol;
    renderer.render(scene, camera);
    drawSpectrum(vol);
  }
  function drawSpectrum(level) {
    const w = spectrumCanvas.width, h = spectrumCanvas.height;
    spectrumCtx.clearRect(0,0,w,h);
    spectrumCtx.save(); spectrumCtx.translate(w/2, h/2);
    const R = 120, SEG = 36;
    for (let i = 0; i < SEG; i++) {
      const ang = (i/SEG)*Math.PI*2, barH = 4 + level*40 + Math.sin(performance.now()*0.004+i*0.7)*level*12;
      const a = Math.max(0.2, level+0.3);
      spectrumCtx.strokeStyle = 'rgba(0,240,255,'+a+')';
      spectrumCtx.lineWidth = 4; spectrumCtx.shadowBlur = 10; spectrumCtx.shadowColor = '#00f0ff';
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(Math.cos(ang)*R, Math.sin(ang)*R);
      spectrumCtx.lineTo(Math.cos(ang)*(R+barH), Math.sin(ang)*(R+barH));
      spectrumCtx.stroke();
    }
    spectrumCtx.restore();
  }

  /* ══════════════════════════════════════════════════════════════
      2) Web Audio API — microphone & beep
     ══════════════════════════════════════════════════════════════ */
  // 初始化麦克风可视化（频谱环）。失败不影响语音识别——Web Speech 与 getUserMedia 相互独立。
  async function initAudioVisualizer() {
    if (audioCtx) return;
    try {
      audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      analyser  = audioCtx.createAnalyser(); analyser.fftSize = 128;
      audioCtx.createMediaStreamSource(micStream).connect(analyser);
    } catch (e) {
      // 麦克风权限被拒或不可用时，仅跳过可视化，不阻断录音
    }
  }
  function playBeep(freq = 1200) {
    initAudioVisualizer();
    if (!audioCtx) return;  // 无音频上下文时静默跳过提示音
    const o1 = audioCtx.createOscillator(), o2 = audioCtx.createOscillator(), g = audioCtx.createGain();
    o1.type = 'sine'; o1.frequency.value = freq;
    o2.type = 'square'; o2.frequency.value = freq*2.01;
    const t = audioCtx.currentTime;
    o1.connect(g); o2.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t+0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t+0.18);
    o1.start(t); o2.start(t); o1.stop(t+0.2); o2.stop(t+0.2);
  }

  /* ══════════════════════════════════════════════════════════════
      3) Web Speech API
     ══════════════════════════════════════════════════════════════ */
  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { logTo('[浏览器不支持 Web Speech API]', 'error'); return; }
    recognition = new SR();
    recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = true;
    recognition.onstart   = () => markRecording(true);
    recognition.onerror   = (e) => { logTo('⚠：'+(e.error||'?'), 'error'); stopRecord(); };
    recognition.onend     = () => { stopRecord(); };
    recognition.onresult  = (event) => {
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) final += event.results[i][0].transcript;
      if (event.results[event.results.length-1].isFinal) {
        const text = final.trim();
        if (!text) return;
        playBeep(880);
        setBackendStatus('thinking', 'PROCESSING');
        socket.emit('transcript', { text, engine: ttsEngine });
      }
    };
  }
  // 原生 App（WKWebView）桥接：空格/中间圈走 SFSpeechRecognizer（原生 ASR，无需 VPN）
  function isNativeVoice() {
    return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.voice);
  }
  function markRecording(on) {
    isRecording = on;
    coreBtn.classList.toggle('pressed', on);
    pttOverlay.classList.toggle('active', on);
    voiceWaveSetActive('listening', on);
    if (on && pttText) pttText.textContent = '● RECORDING';
    if (on) { playBeep(1400); logTo('▶ 聆听中…'); }
  }
  function startRecord() {
    if (isRecording) return;
    if (isNativeVoice()) { window.webkit.messageHandlers.voice.postMessage({ action: 'start' }); markRecording(true); return; }
    if (!recognition) { logTo('⚠ 当前浏览器不支持语音识别（请用桌面 Chrome/Edge，或原生 App 标题栏「按住说话」）', 'error'); return; }
    try { recognition.start(); } catch (e) { logTo('⚠ 无法启动语音识别：' + ((e && e.message) || e), 'error'); return; }
    initAudioVisualizer();  // 可视化独立启动，不阻塞、不影响录音
  }
  function stopRecord() {
    if (!isRecording) return;
    markRecording(false);
    if (isNativeVoice()) { window.webkit.messageHandlers.voice.postMessage({ action: 'stop' }); setBackendStatus('idle', 'STANDBY'); return; }
    try { recognition.stop(); } catch(_){}
    setBackendStatus('idle', 'STANDBY');
  }

  /* ══════════════════════════════════════════════════════════════
      4) Socket.IO client
     ══════════════════════════════════════════════════════════════ */
  function initSocket() {
    socket = io();
    socket.on('connect',     () => logTo('✓ 后端已连接', 'bot'));
    socket.on('disconnect',  () => logTo('⚠ 后端断开', 'error'));
    socket.on('status',      (d) => setBackendStatus(d.state, d.label));
    socket.on('console_log', (d) => { logTo(d.text, d.cls); setTicker(d.text); });
    socket.on('tts_audio',   (d) => playTTSAudio(d.audio));
    socket.on('music_event', (d) => { logTo('[音乐] '+d.text, 'bot'); setTicker(d.text); });
    socket.on('error',       (d) => logTo('[错误] '+d.text, 'error'));
    // 原生 App 语音识别（火山引擎 ASR，后端推流）：边说边出字
    socket.on('asr_partial', (d) => {
      if (!d || !d.text) return;
      if (pttText) pttText.textContent = d.text;
      setTicker(d.text);
    });
    socket.on('asr_final', (d) => {
      const text = (d && d.text) || '';
      if (pttText && text) pttText.textContent = text;
    });
    socket.on('stats_update', (d) => {
      // 遥测数据仍后台接收，但 NAV 面板已改为语音波纹展示，不再绘制仪表
    });
  }
  function playTTSAudio(b64) {
    if (!b64) return;
    setBackendStatus('speaking', 'SPEAKING');
    voiceWaveSetActive('speaking', true);
    const a = new Audio('data:audio/mp3;base64,'+b64);
    a.onended = a.onerror = () => { setBackendStatus('idle', 'STANDBY'); voiceWaveSetActive('speaking', false); };
    a.play().catch(() => { setBackendStatus('idle', 'STANDBY'); voiceWaveSetActive('speaking', false); });
  }

  /* ══════════════════════════════════════════════════════════════
      5) PTT
     ══════════════════════════════════════════════════════════════ */
  // 判断焦点是否在可输入元素上（文本框/下拉/可编辑区）——避免空格对讲干扰打字
  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable;
  }

  function initPTT() {
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || isEditableTarget(document.activeElement)) return;
      e.preventDefault();          // 始终阻止空格默认行为（含系统按键重复提示音）
      if (e.repeat) return;        // 但不重复触发 startRecord
      startRecord();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || !isRecording) return;
      e.preventDefault();
      stopRecord();
    });
    coreBtn.addEventListener('mousedown',  (e) => { e.preventDefault(); startRecord(); });
    coreBtn.addEventListener('mouseup',    stopRecord);
    coreBtn.addEventListener('mouseleave', stopRecord);
    coreBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecord(); });
    coreBtn.addEventListener('touchend',   stopRecord);
  }

  /* ══════════════════════════════════════════════════════════════
      6) TTS 引擎切换
     ══════════════════════════════════════════════════════════════ */
  function initEngineToggle() {
    btnDoubao.addEventListener('click', () => { ttsEngine = 'doubao'; btnDoubao.classList.add('active'); btnEdge.classList.remove('active'); btnPy.classList.remove('active'); logTo('⚙ 豆包 m191 uranus (online)', 'bot'); });
    btnEdge.addEventListener('click',   () => { ttsEngine = 'edge';   btnEdge.classList.add('active');   btnDoubao.classList.remove('active'); btnPy.classList.remove('active'); logTo('⚙ EDGE (online)', 'bot'); });
    btnPy.addEventListener('click',     () => { ttsEngine = 'pyttsx3'; btnPy.classList.add('active');    btnDoubao.classList.remove('active'); btnEdge.classList.remove('active'); logTo('⚙ Mac 本地男声 (offline)', 'bot'); });
  }

  /* ══════════════════════════════════════════════════════════════
      7) HUD：时钟 / GPS / 仪表 / 拖动 / 工具库
     ══════════════════════════════════════════════════════════════ */
  const hudTime = $('hud-live-time');

  function startHudClock() {
    const tick = () => {
      const d = new Date();
      hudTime.textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0') + '.' + String(d.getMilliseconds()).padStart(3,'0');
    };
    tick(); setInterval(tick, 50);
  }

  // ── 语音波纹（NAV 面板）：根据录音/朗读状态驱动波纹动画 ──
  const navWave = $('nav-wave');
  const navWaveCtx = navWave ? navWave.getContext('2d') : null;
  const voiceWaveLabel = $('voice-wave-label');
  // 两个活动源：listening=用户说话，speaking=贾维斯朗读
  let voiceWaveActive = { listening: false, speaking: false };
  let _voiceWaveBar = new Array(48).fill(0);

  // 由外部调用来设置活动状态（markRecording / playTTSAudio 调用）
  window.voiceWaveSetActive = (which, on) => {
    voiceWaveActive[which] = !!on;
    if (voiceWaveLabel) {
      if (voiceWaveActive.listening) {
        voiceWaveLabel.textContent = '▸ VOICE CHANNEL · LISTENING';
        voiceWaveLabel.className = 'voice-wave-label listening';
      } else if (voiceWaveActive.speaking) {
        voiceWaveLabel.textContent = '▸ VOICE CHANNEL · SPEAKING';
        voiceWaveLabel.className = 'voice-wave-label speaking';
      } else {
        voiceWaveLabel.textContent = '▸ VOICE CHANNEL · IDLE';
        voiceWaveLabel.className = 'voice-wave-label';
      }
    }
  };

  function drawVoiceWave() {
    if (!navWaveCtx) return;
    const w = navWave.width, h = navWave.height, n = _voiceWaveBar.length;
    const active = voiceWaveActive.listening || voiceWaveActive.speaking;
    const t = performance.now() * 0.001;
    const base = active ? 0.45 : 0.10;   // 活动时高振幅，空闲时轻微呼吸
    const speed = active ? 9.0 : 2.0;
    navWaveCtx.clearRect(0, 0, w, h);
    const step = w / n;
    const cx = w / 2;
    // 平滑目标值（正弦叠加噪声），并趋向 base
    for (let i = 0; i < n; i++) {
      const env = Math.sin(i / n * Math.PI);            // 中间高两边低
      const noise = Math.sin(t * speed + i * 0.55) * 0.5 + Math.sin(t * speed * 1.7 + i * 0.23) * 0.3 + Math.sin(t * speed * 0.6 + i * 1.1) * 0.2;
      const target = base + (active ? Math.abs(noise) * 0.5 : 0);
      _voiceWaveBar[i] += (target - _voiceWaveBar[i]) * 0.35;
    }
    // 绘制渐变填充波形
    const grad = navWaveCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, active ? 'rgba(0,240,255,0.55)' : 'rgba(0,240,255,0.3)');
    grad.addColorStop(1, 'rgba(0,240,255,0)');
    navWaveCtx.beginPath();
    navWaveCtx.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const amp = _voiceWaveBar[i] * (h - 6);
      navWaveCtx.lineTo(x, h - amp);
    }
    navWaveCtx.lineTo(w, h);
    navWaveCtx.closePath();
    navWaveCtx.fillStyle = grad;
    navWaveCtx.fill();
    // 顶部描边
    navWaveCtx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const amp = _voiceWaveBar[i] * (h - 6);
      if (i === 0) navWaveCtx.moveTo(x, h - amp); else navWaveCtx.lineTo(x, h - amp);
    }
    navWaveCtx.strokeStyle = '#00f0ff';
    navWaveCtx.lineWidth = 1.5;
    navWaveCtx.shadowColor = 'rgba(0,240,255,0.8)';
    navWaveCtx.shadowBlur = 6;
    navWaveCtx.stroke();
    navWaveCtx.shadowBlur = 0;
    requestAnimationFrame(drawVoiceWave);
  }
  if (navWaveCtx) drawVoiceWave();
  function initPanelDrag() {
    let drag = null;
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.hud-panel-title')) return;
      const panel = e.target.closest('[data-panel]'); if (!panel) return;
      panel.classList.add('dragging');
      drag = { panel, dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop };
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      drag.panel.style.left = (e.clientX - drag.dx) + 'px';
      drag.panel.style.top  = (e.clientY - drag.dy) + 'px';
      drag.panel.style.right = 'auto'; drag.panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { if (drag) { drag.panel.classList.remove('dragging'); drag = null; } });
  }
  function initPanelClose() {
    document.querySelectorAll('.hud-close').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = btn.closest('[data-panel]');
        if (!p) return;
        p.classList.add('closed');
        // Sync dock button state
        const panelName = p.dataset.panel;
        const dockBtn = document.querySelector(`.dock-btn[data-panel="${panelName}"]`);
        if (dockBtn) dockBtn.classList.remove('active');
        if (dockState.panels) dockState.panels[panelName] = false;
        try { localStorage.setItem('jarvis_dock', JSON.stringify(dockState)); } catch (_) {}
      });
    });
  }
  function initToolLibrary() {
    // Legacy: old .hud-tool-btn may still exist; wire them to dock behavior
    document.querySelectorAll('.hud-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = document.querySelector('[data-panel="'+btn.dataset.panel+'"]'); if (p) p.classList.remove('closed');
        const dockBtn = document.querySelector(`.dock-btn[data-panel="${btn.dataset.panel}"]`);
        if (dockBtn) dockBtn.classList.add('active');
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════
      8) Enhanced Ring System — build DOM + state reactivity
     ══════════════════════════════════════════════════════════════ */
  function initRings() {
    const rs = $('ring-system');
    if (!rs) return;

    // Inner ring: arc segments + particles
    const inner = document.createElement('div');
    inner.className = 'ring ring-inner';
    inner.innerHTML =
      '<div class="arc-seg"></div><div class="arc-seg"></div><div class="arc-seg"></div>' +
      '<div class="particle"></div><div class="particle"></div><div class="particle"></div>';
    rs.appendChild(inner);

    // Mid ring: dashed + tick marks
    const mid = document.createElement('div');
    mid.className = 'ring ring-mid';
    rs.appendChild(mid);

    const ticks = document.createElement('div');
    ticks.className = 'ring-mid-ticks';
    for (let i = 0; i < 60; i++) {
      const t = document.createElement('div');
      t.className = 'tick';
      t.style.transform = `rotate(${i * 6}deg)`;
      if (i % 5 === 0) { t.style.height = '12px'; t.style.background = 'rgba(0,240,255,0.7)'; }
      ticks.appendChild(t);
    }
    rs.appendChild(ticks);

    // Outer ring: hexagonal + pulse nodes
    const outer = document.createElement('div');
    outer.className = 'ring ring-outer';
    outer.innerHTML =
      '<div class="ring-outer-hex"></div>' +
      '<div class="ring-outer-node"></div><div class="ring-outer-node"></div>' +
      '<div class="ring-outer-node"></div><div class="ring-outer-node"></div>';
    rs.appendChild(outer);

    // Ellipse rings (counter-orbit)
    const ellipseA = document.createElement('div');
    ellipseA.className = 'ring ring-ellipse';
    rs.appendChild(ellipseA);
    const ellipseB = document.createElement('div');
    ellipseB.className = 'ring ring-ellipse ring-ellipse-b';
    rs.appendChild(ellipseB);
  }

  // Sync ring state with core state (called by setBackendStatus)
  const _origSetBackendStatus = setBackendStatus;
  setBackendStatus = (state, label) => {
    _origSetBackendStatus(state, label);
    const coreEl = document.getElementById('core-main');
    if (!coreEl) return;
    coreEl.classList.remove('listening', 'speaking', 'thinking');
    if (state !== 'idle') coreEl.classList.add(state);
  };

  /* ══════════════════════════════════════════════════════════════
      9) Boot Screen Sequence
     ══════════════════════════════════════════════════════════════ */
  function initBoot() {
    const screen = $('boot-screen');
    const checks = $('boot-checks');
    const fill  = $('boot-progress-fill');
    const pct   = $('boot-pct');
    const skip  = $('boot-skip');
    const entrance = $('boot-entrance');
    if (!screen) return;

    const bootLines = [
      { text: '▸ ARC REACTOR',           status: 'ONLINE',   cls: 'status-ok' },
      { text: '▸ NEURAL CORE',           status: 'LOADED',   cls: 'status-ok' },
      { text: '▸ OPTICS.v6',             status: 'ACTIVE',   cls: 'status-ok' },
      { text: '▸ AUDIO.UPLINK',          status: 'SYNCED',   cls: 'status-ok' },
      { text: '▸ TTS.ENGINE',            status: 'READY',    cls: 'status-ok' },
      { text: '▸ BIOMETRIC.LOCK',        status: 'VERIFIED', cls: 'status-ok' },
      { text: '▸ DEEPSEEK.LLM',          status: 'ONLINE',   cls: 'status-ok' },
      { text: '▸ SYSTEM DIAGNOSTICS',    status: 'NOMINAL',  cls: 'status-ok' },
    ];

    let lineIdx  = 0;
    let cancelled = false;
    let finished = false;

    function updateProgress(pctVal) {
      const v = Math.min(100, Math.max(0, pctVal));
      fill.style.width = v + '%';
      pct.textContent = Math.round(v) + '%';
      if (v >= 100) fill.classList.add('complete');
    }

    function addLine(text, status, cls) {
      const div = document.createElement('div');
      div.className = 'boot-line';
      div.innerHTML = `<span class="prompt">></span>${text}<span class="${cls}">${status}</span>`;
      checks.appendChild(div);
      checks.scrollTop = checks.scrollHeight;
    }

    function finishBoot() {
      if (finished || cancelled) return;
      finished = true;
      updateProgress(100);
      // Small delay so user sees 100%, then play entrance animation
      setTimeout(() => {
        entrance.classList.add('active');
        setTimeout(() => {
          screen.classList.add('hidden');
          startHudClock();
        }, 900);
      }, 400);
    }

    // Single unified tick: show a line + update progress together
    const STEP_MS = 380;
    const tick = () => {
      if (cancelled || finished) return;
      if (lineIdx < bootLines.length) {
        const l = bootLines[lineIdx];
        addLine(l.text, l.status, l.cls);
        lineIdx++;
        // Progress is directly proportional to lines shown
        updateProgress((lineIdx / bootLines.length) * 100);
      }
      if (lineIdx >= bootLines.length) {
        // All lines shown — finish after a brief pause
        setTimeout(finishBoot, 300);
      } else {
        setTimeout(tick, STEP_MS);
      }
    };

    // Kick off after initial delay
    setTimeout(tick, 500);

    // Skip handler — flush everything and finish
    skip.addEventListener('click', () => {
      if (finished) return;
      cancelled = true;
      // Show remaining lines instantly
      while (lineIdx < bootLines.length) {
        const l = bootLines[lineIdx];
        addLine(l.text, l.status, l.cls);
        lineIdx++;
      }
      finishBoot();
    });
  }

  /* ══════════════════════════════════════════════════════════════
      10) Chat Panel — text input, file/image upload, drag & drop
     ══════════════════════════════════════════════════════════════ */
  const chatBody = $('chat-body');
  const chatInput = $('chat-input');
  const chatSendBtn = $('chat-send-btn');
  const chatUploadBtn = $('chat-upload-btn');
  const chatFileInput = $('chat-file-input');
  const chatPreview = $('chat-preview');
  const chatPanel = $('chat-panel');
  const chatClearBtn = $('chat-clear-btn');
  let _pendingFiles = [];   // {name, size, kind, content, previewUrl}

  function chatScroll() { chatBody.scrollTop = chatBody.scrollHeight; }

  function chatAddMsg(role, text, attachment, id) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    if (id) div.dataset.id = id;
    const roleLabel = role === 'user' ? 'YOU' : 'J·A·R·V·I·S';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    let html = `<span class="msg-role">${roleLabel}</span>`;
    if (text) html += text.replace(/\n/g, '<br>');
    if (attachment) {
      if (attachment.kind === 'image' && attachment.previewUrl) {
        html += `<div class="chat-attachment"><span class="att-icon">🖼️</span><div class="att-info"><span class="att-name">${attachment.name}</span><span class="att-meta">${attachment.size}</span></div><img src="${attachment.previewUrl}" /></div>`;
      } else {
        html += `<div class="chat-attachment"><span class="att-icon">📄</span><div class="att-info"><span class="att-name">${attachment.name}</span><span class="att-meta">${attachment.size}</span></div></div>`;
      }
    }
    html += `<span class="msg-time">${time}</span>`;
    if (id) html += `<button class="chat-del" title="删除本条">×</button>`;
    div.innerHTML = html;
    chatBody.appendChild(div);
    chatScroll();
    return div;
  }

  function tagChatMsg(el, id) {
    if (!el || !id || el.dataset.id) return;
    el.dataset.id = id;
    const btn = document.createElement('button');
    btn.className = 'chat-del';
    btn.title = '删除本条';
    btn.textContent = '×';
    el.appendChild(btn);
  }

  function chatAddSys(text) {
    const div = document.createElement('div');
    div.className = 'chat-sys';
    div.textContent = text;
    chatBody.appendChild(div);
    chatScroll();
  }

  function chatAddErr(text) {
    const div = document.createElement('div');
    div.className = 'chat-err';
    div.textContent = '⚠ ' + text;
    chatBody.appendChild(div);
    chatScroll();
  }

  async function loadChatHistory() {
    try {
      const resp = await fetch('/api/history');
      const data = await resp.json();
      if (!data.ok || !Array.isArray(data.messages) || !data.messages.length) return;
      for (const m of data.messages) {
        if (m && m.text && (m.role === 'user' || m.role === 'assistant')) {
          chatAddMsg(m.role === 'user' ? 'user' : 'bot', m.text, null, m.id);
        }
      }
    } catch (_) {}
  }

  function clearChatHistory() {
    fetch('/api/history', { method: 'DELETE' })
      .then(() => {
        chatBody.querySelectorAll('.chat-msg').forEach((el) => el.remove());
        chatAddSys('🧹 聊天记录已清空');
      })
      .catch(() => chatAddErr('清空失败'));
  }

  function chatShowTyping() {
    const div = document.createElement('div');
    div.className = 'chat-typing';
    div.id = 'chat-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    chatBody.appendChild(div);
    chatScroll();
  }
  function chatRemoveTyping() { const t = $('chat-typing'); if (t) t.remove(); }

  function chatRenderPreview() {
    chatPreview.innerHTML = '';
    _pendingFiles.forEach((f, i) => {
      const chip = document.createElement('div');
      chip.className = 'preview-chip';
      const thumb = f.kind === 'image' && f.previewUrl
        ? `<img src="${f.previewUrl}" />`
        : `<span>📄</span>`;
      chip.innerHTML = `${thumb}<span>${f.name}</span><span class="rm-btn" data-idx="${i}">×</span>`;
      chatPreview.appendChild(chip);
    });
    chatPreview.querySelectorAll('.rm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        _pendingFiles.splice(idx, 1);
        chatRenderPreview();
      });
    });
  }

  async function chatUploadFiles(files) {
    for (const file of files) {
      const ext = '.' + (file.name.split('.').pop() || '').lower();
      const allowed = ['txt','md','py','js','json','csv','log','html','css','xml','yaml','yml','sh','pdf','png','jpg','jpeg','gif','webp'];
      if (!allowed.includes(ext.replace('.',''))) { chatAddErr(`不支持的格式: ${ext}`); continue; }
      if (file.size > 10 * 1024 * 1024) { chatAddErr('文件超过 10MB'); continue; }

      const fd = new FormData();
      fd.append('file', file);
      try {
        chatAddSys(`⤴ 上传 ${file.name}…`);
        const resp = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!data.ok) { chatAddErr(data.error || '上传失败'); continue; }
        const f = data.file;
        const pending = { name: f.name, size: fmtSize(f.size), kind: f.kind, content: f.content };
        if (f.kind === 'image') {
          // For images, create a preview URL from the uploaded file directly
          pending.previewUrl = URL.createObjectURL(file);
        }
        _pendingFiles.push(pending);
        chatRenderPreview();
      } catch (e) {
        chatAddErr('上传失败: ' + e.message);
      }
    }
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function chatSend() {
    const text = chatInput.value.trim();
    if (!text && _pendingFiles.length === 0) return;

    // Build message: text + file contents
    let fullText = text;
    const attachments = [];
    for (const f of _pendingFiles) {
      attachments.push(f);
      if (f.content) {
        fullText += (fullText ? '\n\n' : '') + `[文件: ${f.name}]\n${f.content}`;
      }
    }

    const userEl = chatAddMsg('user', text || '(上传文件)', attachments[0]);
    chatInput.value = '';
    _pendingFiles = [];
    chatRenderPreview();
    chatShowTyping();
    setBackendStatus('thinking', 'PROCESSING');

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fullText, engine: ttsEngine }),
      });
      const data = await resp.json();
      chatRemoveTyping();
      if (data.ok) {
        tagChatMsg(userEl, data.user_id);
        chatAddMsg('bot', data.answer, null, data.answer_id);
        setBackendStatus('idle', 'STANDBY');
      } else {
        chatAddErr(data.error || 'LLM 调用失败');
        setBackendStatus('idle', 'STANDBY');
      }
    } catch (e) {
      chatRemoveTyping();
      chatAddErr('网络错误: ' + e.message);
      setBackendStatus('idle', 'STANDBY');
    }
  }

  function initChat() {
    if (!chatInput) return;
    chatSendBtn.addEventListener('click', chatSend);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
    });
    // Auto-resize textarea
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
    });
    // Upload button
    chatUploadBtn.addEventListener('click', () => chatFileInput.click());
    chatFileInput.addEventListener('change', (e) => {
      if (e.target.files.length) chatUploadFiles(Array.from(e.target.files));
      chatFileInput.value = '';
    });
    // Drag & drop
    chatPanel.addEventListener('dragover', (e) => { e.preventDefault(); chatPanel.classList.add('drag-over'); });
    chatPanel.addEventListener('dragleave', () => chatPanel.classList.remove('drag-over'));
    chatPanel.addEventListener('drop', (e) => {
      e.preventDefault();
      chatPanel.classList.remove('drag-over');
      if (e.dataTransfer.files.length) chatUploadFiles(Array.from(e.dataTransfer.files));
    });
    // 清空聊天记录
    if (chatClearBtn) chatClearBtn.addEventListener('click', clearChatHistory);
    // 单条删除（事件委托）
    chatBody.addEventListener('click', (e) => {
      const btn = e.target.closest('.chat-del');
      if (!btn) return;
      const msg = btn.closest('.chat-msg');
      const id = msg && msg.dataset.id;
      if (!id) return;
      fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
      msg.remove();
    });
  }

  /* ══════════════════════════════════════════════════════════════
      11) Skill & Permission Dock
     ══════════════════════════════════════════════════════════════ */
  const dockState = {
    panels: { chat: true, nav: true, calendar: true, files: true, gallery: false, armor: false },
    perms: { mic: false, geo: false },
    collapsed: true,
  };

  function initDock() {
    // Handle: expand / collapse the dock
    const dockEl = $('skill-dock');
    const handle = $('dock-handle');
    if (dockEl && handle) {
      handle.addEventListener('click', () => {
        dockState.collapsed = !dockState.collapsed;
        dockEl.classList.toggle('collapsed', dockState.collapsed);
        try { localStorage.setItem('jarvis_dock', JSON.stringify(dockState)); } catch (_) {}
      });
    }

    // Panel toggles
    document.querySelectorAll('.dock-btn[data-panel]').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = btn.dataset.panel;
        const el = document.querySelector(`[data-panel="${panel}"]`);
        if (!el) return;
        dockState.panels[panel] = !dockState.panels[panel];
        if (dockState.panels[panel]) {
          el.classList.remove('closed');
          btn.classList.add('active');
        } else {
          el.classList.add('closed');
          btn.classList.remove('active');
        }
        try { localStorage.setItem('jarvis_dock', JSON.stringify(dockState)); } catch (_) {}
      });
    });

    // Permission toggles
    document.querySelectorAll('.dock-btn[data-perm]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const perm = btn.dataset.perm;
        if (perm === 'mic') {
          try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            dockState.perms.mic = true;
            btn.classList.add('perm-granted');
            btn.classList.add('active');
            chatAddSys('🎤 麦克风权限已授权');
          } catch (e) {
            chatAddErr('麦克风权限被拒绝');
          }
        } else if (perm === 'geo') {
          if (!navigator.geolocation) { chatAddErr('浏览器不支持定位'); return; }
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              dockState.perms.geo = true;
              btn.classList.add('perm-granted');
              btn.classList.add('active');
              chatAddSys(`📍 定位已锁定 ${pos.coords.latitude.toFixed(4)}° ${pos.coords.longitude.toFixed(4)}°`);
            },
            () => { chatAddErr('定位权限被拒绝'); }
          );
        }
        try { localStorage.setItem('jarvis_dock', JSON.stringify(dockState)); } catch (_) {}
      });
    });

    // Restore state from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem('jarvis_dock') || '{}');
      dockState.collapsed = saved.collapsed !== undefined ? saved.collapsed : true;
      const dockEl2 = $('skill-dock');
      if (dockEl2) dockEl2.classList.toggle('collapsed', dockState.collapsed);
      if (saved.panels) {
        Object.entries(saved.panels).forEach(([p, open]) => {
          const el = document.querySelector(`[data-panel="${p}"]`);
          const btn = document.querySelector(`.dock-btn[data-panel="${p}"]`);
          if (el && btn) {
            if (open) { el.classList.remove('closed'); btn.classList.add('active'); }
            else { el.classList.add('closed'); btn.classList.remove('active'); }
            dockState.panels[p] = open;
          }
        });
      }
      if (saved.perms) {
        Object.entries(saved.perms).forEach(([p, granted]) => {
          if (granted) {
            const btn = document.querySelector(`.dock-btn[data-perm="${p}"]`);
            if (btn) { btn.classList.add('perm-granted'); btn.classList.add('active'); }
            dockState.perms[p] = granted;
          }
        });
      }
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     DOMContentLoaded
     ══════════════════════════════════════════════════════════════ */
  window.addEventListener('DOMContentLoaded', async () => {
    try { initThree(); } catch (e) { console.warn('Three.js 加载失败', e); }
    initRings();
    initSpeech(); initSocket(); initPTT(); initEngineToggle();
    initPanelDrag(); initPanelClose(); initToolLibrary();
    initChat(); initDock();
    loadChatHistory();
    const refreshBtn = $('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => location.reload());
    initBoot();
    setStatus('idle', 'STANDBY');
  });
})();
