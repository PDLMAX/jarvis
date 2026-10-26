/* ════════════════════════════════════════════════════════════════════════
   J.A.R.V.I.S. · CALENDAR + WEATHER ORACLE
   Month grid + Open-Meteo live forecast（浏览器定位 / 城市切换，无需 key）。
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let viewDate = new Date();                 // 当前展示的月份（year/month）
  let weatherDaily = [];                     // [{date, code, tmax, tmin}]
  let geoLabel = '定位中…';
  let currentCity = null;                    // {name, lat, lon}

  const WMO_LABEL = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '阵雨', 82: '强阵雨',
    85: '阵雪', 86: '强阵雪', 95: '雷雨', 96: '雷雨冰雹', 99: '强雷雨',
  };
  const WMO_ICON = {
    0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️', 45: '🌫', 48: '🌫',
    51: '🌦', 53: '🌦', 55: '🌦', 61: '🌧', 63: '🌧', 65: '🌧',
    71: '🌨', 73: '🌨', 75: '🌨', 77: '❄️', 80: '🌦', 81: '🌧', 82: '⛈',
    85: '🌨', 86: '🌨', 95: '⛈', 96: '⛈', 99: '⛈',
  };

  // 预设城市（默认上海）
  const CITY_PRESETS = {
    '上海': { lat: 31.2304, lon: 121.4737 },
    '北京': { lat: 39.9042, lon: 116.4074 },
    '广州': { lat: 23.1291, lon: 113.2644 },
    '深圳': { lat: 22.5431, lon: 114.0579 },
    '杭州': { lat: 30.2741, lon: 120.1551 },
    '成都': { lat: 30.5728, lon: 104.0668 },
    '武汉': { lat: 30.5928, lon: 114.3055 },
    '南京': { lat: 32.0603, lon: 118.7969 },
    '西安': { lat: 34.3416, lon: 108.9398 },
    '重庆': { lat: 29.5630, lon: 106.5516 },
    '天津': { lat: 39.3434, lon: 117.3616 },
    '苏州': { lat: 31.2989, lon: 120.5853 },
  };

  const wmoLabel = (c) => WMO_LABEL[c] || ('未知(' + c + ')');
  const wmoIcon = (c) => WMO_ICON[c] || '🌡';
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

  function renderCalendar() {
    const y = viewDate.getFullYear(), m = viewDate.getMonth();
    const monthEl = $('cal-month');
    if (monthEl) monthEl.textContent = y + ' · ' + pad2(m + 1) + '月';
    const grid = $('cal-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const firstDow = new Date(y, m, 1).getDay();        // 0=周日
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = new Date();

    const wmap = {};
    weatherDaily.forEach((d) => { if (d && d.date) wmap[d.date] = d; });

    for (let i = 0; i < firstDow; i++) {
      const e = document.createElement('div');
      e.className = 'cal-day empty';
      grid.appendChild(e);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('div');
      cell.className = 'cal-day';
      const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
      const dow = new Date(y, m, d).getDay();
      const key = y + '-' + pad2(m + 1) + '-' + pad2(d);
      if (isToday) cell.classList.add('today');
      if (dow === 0 || dow === 6) cell.classList.add('wk');
      if (wmap[key]) {
        cell.classList.add('has-weather');
        cell.title = wmoLabel(wmap[key].code) + ' ' +
          Math.round(wmap[key].tmin) + '°~' + Math.round(wmap[key].tmax) + '°';
      }
      cell.textContent = d;
      grid.appendChild(cell);
    }
  }

  function renderWeatherDays() {
    const el = $('weather-days');
    if (!el) return;
    const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
    el.innerHTML = '';
    weatherDaily.slice(0, 6).forEach((d) => {
      if (!d || !d.date) return;
      const dt = new Date(d.date + 'T00:00:00');
      const day = document.createElement('div');
      day.className = 'w-day';
      day.innerHTML =
        '<span class="dname">' + dayNames[dt.getDay()] + '</span>' +
        '<span class="dicon">' + wmoIcon(d.code) + '</span>' +
        '<span class="dtemp">' + Math.round(d.tmax) + '°<span class="min"> ' + Math.round(d.tmin) + '°</span></span>';
      el.appendChild(day);
    });
  }

  async function fetchWeather(lat, lon) {
    try {
      const url = 'https://api.open-meteo.com/v1/forecast' +
        '?latitude=' + lat + '&longitude=' + lon +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
        '&timezone=auto&forecast_days=6';
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const cur = data.current;
      const t = Math.round(cur.temperature_2m);
      const tEl = $('w-temp'); if (tEl) tEl.textContent = t + '°';
      const cEl = $('w-cond'); if (cEl) cEl.textContent = wmoLabel(cur.weather_code);
      const cityEl = $('w-city'); if (cityEl) cityEl.textContent = geoLabel;
      const meta = $('weather-meta');
      if (meta) {
        meta.innerHTML =
          '<div class="w-meta-item"><span class="label">体感</span><span class="value">' + Math.round(cur.apparent_temperature) + '°</span></div>' +
          '<div class="w-meta-item"><span class="label">湿度</span><span class="value">' + cur.relative_humidity_2m + '%</span></div>' +
          '<div class="w-meta-item"><span class="label">风速</span><span class="value">' + cur.wind_speed_10m + 'km/h</span></div>';
      }
      weatherDaily = (data.daily.time || []).map((date, i) => ({
        date,
        code: data.daily.weather_code[i],
        tmax: data.daily.temperature_2m_max[i],
        tmin: data.daily.temperature_2m_min[i],
      }));
      renderWeatherDays();
      renderCalendar();
    } catch (e) {
      const meta = $('weather-meta');
      if (meta) meta.innerHTML = '<div class="w-err">天气获取失败：' + e.message + '</div>';
    }
  }

  function showWeatherErr(msg) {
    const meta = $('weather-meta');
    if (meta) meta.innerHTML = '<div class="w-err">' + msg + '</div>';
  }

  async function geocodeCity(name) {
    try {
      const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
        encodeURIComponent(name) + '&count=1&language=zh&format=json';
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const data = await resp.json();
      const r = data.results && data.results[0];
      if (!r) return null;
      return { name: r.name || name, lat: r.latitude, lon: r.longitude };
    } catch (_) { return null; }
  }

  async function setCity(name, persist) {
    if (!name) return;
    let c = CITY_PRESETS[name]
      ? { name: name, lat: CITY_PRESETS[name].lat, lon: CITY_PRESETS[name].lon }
      : null;
    if (!c) c = await geocodeCity(name);
    if (!c) { showWeatherErr('未找到城市：' + name); return; }
    currentCity = c;
    geoLabel = '📍 ' + c.name;
    if (persist) { try { localStorage.setItem('jarvis_weather_city', c.name); } catch (_) {} }
    fetchWeather(c.lat, c.lon);
  }

  function locate() {
    // 手动使用浏览器定位
    if (!navigator.geolocation) { setCity(currentCity ? currentCity.name : '上海', false); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentCity = { name: '当前定位', lat: pos.coords.latitude, lon: pos.coords.longitude };
        geoLabel = '📍 ' + pos.coords.latitude.toFixed(2) + '°, ' + pos.coords.longitude.toFixed(2) + '°';
        fetchWeather(pos.coords.latitude, pos.coords.longitude);
      },
      () => setCity(currentCity ? currentCity.name : '上海', false),
      { timeout: 6000 }
    );
  }

  function buildCitySelector() {
    const sel = $('w-city-select');
    if (sel) {
      sel.innerHTML = '';
      Object.keys(CITY_PRESETS).forEach((n) => {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
      const cust = document.createElement('option');
      cust.value = '__custom'; cust.textContent = '自定义…';
      sel.appendChild(cust);

      sel.addEventListener('change', () => {
        if (sel.value === '__custom') { const inp = $('w-city-input'); if (inp) inp.focus(); return; }
        setCity(sel.value, true);
      });
    }
    const inp = $('w-city-input');
    if (inp) {
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = inp.value.trim();
        if (!v) return;
        inp.value = '';
        if (sel) sel.value = '__custom';
        setCity(v, true);
      });
    }
    const geo = $('w-geo');
    if (geo) geo.addEventListener('click', locate);
  }

  function loadCity() {
    let name = '上海';
    try { name = localStorage.getItem('jarvis_weather_city') || '上海'; } catch (_) {}
    const sel = $('w-city-select');
    if (sel) sel.value = CITY_PRESETS[name] ? name : '__custom';
    setCity(name, false);
  }

  function init() {
    const prev = $('cal-prev'), next = $('cal-next'), refresh = $('w-refresh');
    if (prev) prev.addEventListener('click', () => {
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
      renderCalendar();
    });
    if (next) next.addEventListener('click', () => {
      viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
      renderCalendar();
    });
    if (refresh) refresh.addEventListener('click', () => {
      if (currentCity) { geoLabel = '📍 ' + currentCity.name; fetchWeather(currentCity.lat, currentCity.lon); }
      else locate();
    });
    buildCitySelector();
    renderCalendar();
    loadCity();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
