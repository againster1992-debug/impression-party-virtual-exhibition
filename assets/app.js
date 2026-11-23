/* =========================================================
   印象·派对 · 上博东馆印象派特展线上展厅
   ========================================================= */
(() => {
  'use strict';

  const DATA = window.MUSEUM_DATA;
  if (!DATA || !Array.isArray(DATA.rooms)) {
    document.body.innerHTML = '<p style="color:#e8dcc4;font-family:serif;padding:40px">展品数据加载失败。</p>';
    return;
  }

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = n => String(n).padStart(2, '0');
  const isMobile = () => window.innerWidth <= 720;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const FLAT = [];
  DATA.rooms.forEach((room, ri) => room.exhibits.forEach((ex, ei) => {
    FLAT.push({ room, ri, ex, ei, global: FLAT.length + 1 });
  }));
  const EX_BY_ID = new Map(FLAT.map(f => [f.ex.id, f]));
  const ARTIST_BY_ID = new Map(DATA.artists.map(a => [a.id, a]));
  const ARTIST_BY_NAME = new Map(DATA.artists.map(a => [a.name, a]));

  const TAG_KIND_LABEL = { style: '流派 / 风格', subject: '题材', technique: '技法', medium: '门类 / 材质' };
  const REL_CLASS = { '师承': 'teacher', '挚友': 'friend', '同道': 'peer', '影响': 'influence', '论争': 'rival' };
  const SCHOOL_COLORS = {
    '现实主义': '#c9a45c', '巴比松画派': '#b9a06a', '印象派': '#8a9a5b',
    '新印象派': '#6fa3b8', '后印象派': '#c97b4a', '象征主义': '#8f7fb8',
    '纳比派': '#b06f8f', '野兽派': '#d08a4a', '立体主义': '#7f8fa6',
    '日本洋画': '#a88a5a', '中国西画': '#b06f8f', '当代艺术': '#8f7fb8'
  };

  const STORAGE_KEY = 'impression-party-visited-v1';
  const MUSIC_KEY = 'impression-party-music-on';

  const state = {
    started: false,
    roomIndex: 0,
    panX: 0,
    targetPan: 0,
    panRaf: 0,
    dragging: false,
    dragMoved: false,
    dragStartX: 0,
    dragStartPan: 0,
    dragLastX: 0,
    dragLastT: 0,
    dragVelocity: 0,
    visited: new Set(),
    detail: null,
    detailFrom: 'gallery',
    overlay: null,
    catalogFilter: 'all',
    catalogSchool: 'all',
    catalogArtist: 'all',
    catalogQuery: '',
    catalogScroll: 0,
    artworks: [],
    wallMax: 0,
    pointerX: null,
    depthRaf: 0,
    viewer: {
      natW: 1, natH: 1, fit: 1, scale: 1, x: 0, y: 0,
      dragging: false, startX: 0, startY: 0, origX: 0, origY: 0,
      fullscreen: false, pointers: new Map(), pinch: null
    },
    timeline: {
      scale: 1, school: 'all', built: false, dragging: false, dragX: 0, startScroll: 0
    },
    network: {
      scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0, origTx: 0, origTy: 0,
      school: 'all', built: false, active: ''
    },
    sup: { zoom: 1, item: null }
  };

  const preloaded = new Set();
  const fullPreloaded = new Set();
  let viewerLoadToken = 0;
  let supLoadToken = 0;
  let toastTimer = 0;
  let loadingDone = false;
  let mobileHintShown = false;

  /* =========================================================
     背景音乐：《Vincent》MIDI → Web Audio 钢琴合成
     ========================================================= */
  const music = {
    on: false, ctx: null, master: null, dry: null, convolver: null,
    timer: 0, scoreStart: 0, cursor: 0, started: false
  };
  const TRACK_VOL = { 1: 0.42, 2: 0.3, 3: 0.34 };
  const MIDI_FREQ = n => 440 * Math.pow(2, (n - 69) / 12);

  function loadMusicPref() {
    try {
      const stored = localStorage.getItem(MUSIC_KEY);
      music.on = stored === null ? true : stored === '1';
    } catch (e) { music.on = true; }
    updateMusicButtons();
  }
  function saveMusicPref() {
    try { localStorage.setItem(MUSIC_KEY, music.on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  function updateMusicButtons() {
    $$('.music-btn').forEach(btn => {
      btn.classList.toggle('playing', music.on);
      btn.setAttribute('aria-pressed', music.on ? 'true' : 'false');
      btn.title = music.on ? '关闭背景音乐 ·《Vincent》' : '开启背景音乐 ·《Vincent》';
    });
  }
  function makeImpulse(ctx, duration, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buffer = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buffer;
  }
  function ensureMusic() {
    if (music.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 18;
    comp.ratio.value = 2.6;
    comp.attack.value = 0.01;
    comp.release.value = 0.32;
    comp.connect(master);
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx, 3.4, 2.1);
    const wet = ctx.createGain();
    wet.gain.value = 0.34;
    convolver.connect(wet);
    wet.connect(comp);
    const dry = ctx.createGain();
    dry.gain.value = 0.72;
    dry.connect(comp);
    music.ctx = ctx;
    music.master = master;
    music.dry = dry;
    music.convolver = convolver;
    return true;
  }
  function piano(freq, time, dur, vol) {
    const ctx = music.ctx;
    if (!ctx) return;
    const out = ctx.createGain();
    const peak = Math.max(0.0004, vol);
    out.gain.setValueAtTime(0.0001, time);
    out.gain.exponentialRampToValueAtTime(peak, time + 0.012);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.36), time + 0.2);
    out.gain.exponentialRampToValueAtTime(0.0001, time + Math.max(0.5, dur * 1.5 + 0.5));
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(3800, time);
    tone.frequency.exponentialRampToValueAtTime(780, time + Math.min(2.6, dur + 0.6));
    out.connect(tone);
    tone.connect(music.dry);
    tone.connect(music.convolver);
    [[1, 0.82, 'triangle'], [2, 0.13, 'sine']].forEach(([ratio, amp, type]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * ratio;
      const g = ctx.createGain();
      g.gain.value = amp;
      osc.connect(g);
      g.connect(out);
      osc.start(time);
      osc.stop(time + Math.max(0.6, dur * 1.5 + 0.7));
    });
  }
  function scheduleMusic() {
    if (!music.on || !music.started || !music.ctx) return;
    const ctx = music.ctx;
    if (ctx.state !== 'running') { music.timer = setTimeout(scheduleMusic, 500); return; }
    if (ctx.currentTime - music.scoreStart > DATA.music.loop * 2) {
      music.scoreStart = ctx.currentTime + 0.3;
      music.cursor = 0;
    }
    const horizon = ctx.currentTime + 2.6;
    let guard = 0;
    const notes = DATA.music.notes;
    while (guard++ < 900) {
      if (music.cursor >= notes.length) {
        music.scoreStart += DATA.music.loop;
        music.cursor = 0;
      }
      const n = notes[music.cursor];
      const at = music.scoreStart + n.t;
      if (at > horizon) break;
      if (at >= ctx.currentTime - 0.1) {
        piano(MIDI_FREQ(n.n), at, n.d, (TRACK_VOL[n.tr] || 0.3) * (n.v / 100));
      }
      music.cursor++;
    }
    music.timer = setTimeout(scheduleMusic, 280);
  }
  function startMusic() {
    if (!music.on) return;
    if (!ensureMusic()) {
      music.on = false; saveMusicPref(); updateMusicButtons();
      toast('当前浏览器不支持背景音乐');
      return;
    }
    const ctx = music.ctx;
    ctx.resume().then(() => {
      music.started = true;
      const now = ctx.currentTime;
      music.master.gain.cancelScheduledValues(now);
      music.master.gain.setValueAtTime(Math.max(0.0001, music.master.gain.value), now);
      music.master.gain.exponentialRampToValueAtTime(0.58, now + 2);
      music.scoreStart = now + 0.5;
      music.cursor = 0;
      clearTimeout(music.timer);
      scheduleMusic();
    }).catch(() => { /* ignore */ });
  }
  function stopMusic() {
    clearTimeout(music.timer);
    music.timer = 0;
    music.started = false;
    if (!music.ctx) return;
    const ctx = music.ctx;
    const now = ctx.currentTime;
    music.master.gain.cancelScheduledValues(now);
    music.master.gain.setValueAtTime(Math.max(0.0001, music.master.gain.value), now);
    music.master.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
    setTimeout(() => { if (!music.on && music.ctx) music.ctx.suspend(); }, 1000);
  }
  function toggleMusic() {
    music.on = !music.on;
    saveMusicPref();
    updateMusicButtons();
    if (music.on) startMusic(); else stopMusic();
    toast(music.on ? '背景音乐《Vincent》已开启' : '背景音乐已关闭');
  }

  /* =========================================================
     进度
     ========================================================= */
  function loadVisited() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const valid = new Set(FLAT.map(f => f.ex.id));
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach(id => { if (valid.has(id)) state.visited.add(id); });
    } catch (e) { /* ignore */ }
  }
  function saveVisited() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(state.visited))); } catch (e) { /* ignore */ }
  }
  function markVisited(id) {
    if (!id || state.visited.has(id)) return;
    state.visited.add(id);
    saveVisited();
    updateProgress();
    updateRoute();
    $$('.artwork').forEach(el => { if (el.dataset.id === id) el.classList.add('visited'); });
  }

  /* =========================================================
     首页
     ========================================================= */
  function initIntro() {
    const m = DATA.meta;
    $('#introStats').innerHTML = `
      <div><b>${m.total}</b><span>组展项</span></div>
      <div><b>${m.workCount}</b><span>件作品</span></div>
      <div><b>${m.roomCount}</b><span>个单元</span></div>
      <div><b>${m.artistCount}</b><span>位艺术家</span></div>`;
    $('#introSource').innerHTML = `${esc(m.source)} <a href="${esc(m.sourceUrl)}" target="_blank" rel="noopener">查看原文 ↗</a> · 本页为非官方线上展厅，仅供学习交流。`;
    const bg = EX_BY_ID.get('e025');
    if (bg) $('#introBgImg').src = bg.ex.hero.src;

    const picks = [
      { id: 'e002', cls: 'im1' }, { id: 'e010', cls: 'im2' }, { id: 'e018', cls: 'im3' },
      { id: 'e025', cls: 'im4' }, { id: 'e040', cls: 'im5' }
    ];
    const collage = $('#introCollage');
    collage.innerHTML = picks.map(({ id, cls }) => {
      const item = EX_BY_ID.get(id);
      if (!item) return '';
      const ex = item.ex;
      return `<figure class="im ${cls}" data-id="${esc(ex.id)}" data-ri="${item.ri}" data-ei="${item.ei}" tabindex="0" role="button" aria-label="${esc(ex.name)}">
        <div class="im-media"><img loading="eager" src="${esc(ex.hero.src)}" alt="${esc(ex.name)}"></div>
        <figcaption>${esc(shortArtist(ex.artist))} · ${esc(ex.name)}</figcaption>
      </figure>`;
    }).join('');
    $$('.im', collage).forEach(el => {
      const item = EX_BY_ID.get(el.dataset.id);
      if (item) el.addEventListener('pointerenter', () => preloadFull(item.ex.hero), { once: true });
      const go = () => {
        const ri = Number(el.dataset.ri), ei = Number(el.dataset.ei);
        startGallery();
        enterRoom(ri, false, 'start');
        openDetail(ri, ei, 0, 'gallery');
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  function shortArtist(name) {
    const artist = ARTIST_BY_NAME.get(name);
    if (artist && artist.short) return artist.short;
    const parts = String(name).split('·');
    let s = parts[parts.length - 1].trim();
    if (s.length > 4) s = s.slice(-3);
    return s;
  }

  /* =========================================================
     展厅
     ========================================================= */
  function renderRoutes() {
    const route = $('#roomRoute');
    route.innerHTML = '';
    DATA.rooms.forEach((room, i) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'route-node';
      node.dataset.index = String(i);
      node.style.borderTopColor = room.sectionColor;
      node.innerHTML = `<div class="rn-top"><span>${pad2(i + 1)}</span><i style="background:${room.sectionColor}"></i></div><span class="rn-title">${esc(room.title)}</span>`;
      node.addEventListener('click', () => enterRoom(i, true, 'start'));
      route.appendChild(node);
    });
  }

  function updateProgress() {
    const n = state.visited.size;
    const total = DATA.meta.total || 1;
    $('#progressText').textContent = `${n} / ${total}`;
    $('#progressBar').style.width = `${(n / total) * 100}%`;
  }

  function updateRoute() {
    $$('.route-node').forEach((node, i) => {
      const room = DATA.rooms[i];
      node.classList.toggle('active', i === state.roomIndex);
      node.classList.toggle('visited', room.exhibits.some(ex => state.visited.has(ex.id)));
    });
    if (isMobile()) {
      const active = $('.route-node.active', $('#roomRoute'));
      if (active) requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest', inline: 'center' }));
    }
  }

  function updateTop() {
    const room = DATA.rooms[state.roomIndex];
    $('#roomChapter').textContent = isMobile()
      ? room.chapter
      : `${room.chapter} · ${pad2(state.roomIndex + 1)} / ${DATA.meta.roomCount}`;
    $('#roomTitle').textContent = room.title;
    updateProgress();
    updateRoute();
  }

  function frameSize(ex) {
    const hero = ex.hero;
    const r = (hero.w || 1000) / (hero.h || 1000);
    let fw, fh;
    if (r >= 1.8) { fw = 470; fh = fw / r; }
    else if (r >= 1.3) { fw = 450; fh = fw / r; }
    else if (r >= 1.0) { fw = 410; fh = fw / r; }
    else if (r >= 0.8) { fw = 370; fh = fw / r; }
    else if (r >= 0.62) { fw = 330; fh = fw / r; }
    else if (r >= 0.45) { fw = 300; fh = fw / r; }
    else { fw = 250; fh = fw / r; }
    const maxH = Math.max(230, window.innerHeight - 265);
    if (fh > maxH) { fh = maxH; fw = fh * r; }
    const vhScale = clamp((window.innerHeight - 170) / 720, 0.62, 1);
    fw *= vhScale; fh *= vhScale;
    if (isMobile()) { fw *= 0.72; fh *= 0.72; }
    return { w: Math.round(fw), h: Math.round(fh), r };
  }

  function buildRoomTitlePanel(room) {
    const el = document.createElement('div');
    el.className = 'room-title-panel';
    el.style.setProperty('--panel-color', room.sectionColor);
    const terms = room.knowledge.length
      ? `<div class="rt-terms">${room.knowledge.map(k => `<span>${esc(k.term)}</span>`).join('')}</div>`
      : '';
    el.innerHTML = `
      <p class="rt-chapter">${esc(room.chapter)}</p>
      <h2 class="rt-title">${esc(room.title)}</h2>
      <p class="rt-sub">${esc(room.subtitle)}</p>
      <p class="rt-intro">${esc(room.intro[0] || '')}</p>
      ${terms}
      <p class="rt-count">${room.exhibits.length} 组 · ${room.exhibits.reduce((s, e) => s + e.workCount, 0)} 件作品</p>`;
    return el;
  }

  function badgeFor(ex) {
    if (ex.workCount > 1) return `${ex.workCount} 件`;
    if (/摄影/.test(ex.medium)) return '摄影';
    if (/装置/.test(ex.medium)) return '装置';
    if (/屏风/.test(ex.medium)) return '屏风';
    return '';
  }

  function buildArtwork(ex, index, roomIndex) {
    const size = frameSize(ex);
    const badge = badgeFor(ex);
    const el = document.createElement('article');
    el.className = 'artwork' + (state.visited.has(ex.id) ? ' visited' : '');
    el.dataset.id = ex.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${ex.name}，${ex.artist}`);
    el.style.setProperty('--fw', `${size.w}px`);
    el.style.setProperty('--fh', `${size.h}px`);
    el.innerHTML = `
      <div class="artwork-inner">
        <div class="frame">
          ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
          <div class="mat"><img loading="eager" src="${esc(ex.hero.src)}" alt="${esc(ex.name)}"></div>
        </div>
        <div class="label">
          <span class="no">${pad2(index + 1)}</span>
          <span class="txt">
            <span class="name">${esc(ex.name)}<i class="visit-dot"></i></span>
            <span class="meta">${esc(shortArtist(ex.artist))} · ${esc(ex.yearLabel)}</span>
          </span>
        </div>
      </div>`;
    let opening = false;
    const open = () => {
      if (state.dragMoved || opening) return;
      opening = true;
      el.classList.add('tap-pop');
      setTimeout(() => {
        opening = false;
        if (!state.dragMoved) openDetail(roomIndex, index, 0, 'gallery');
      }, 250);
      setTimeout(() => el.classList.remove('tap-pop'), 520);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    el.addEventListener('pointerenter', () => preloadFull(ex.hero), { once: true });
    return el;
  }

  function buildDoor(roomIndex) {
    const isLast = roomIndex >= DATA.rooms.length - 1;
    const el = document.createElement('div');
    if (!isLast) {
      const next = DATA.rooms[roomIndex + 1];
      el.className = 'door-panel';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.innerHTML = `
        <span class="door-kicker">NEXT UNIT</span>
        <span class="door-title">${esc(next.title)}</span>
        <span class="door-sub">${esc(next.subtitle)}</span>
        <span class="door-arrow">→</span>
        <span class="door-sub">点击进入下一单元</span>`;
      const go = () => enterRoom(roomIndex + 1, true, 'start');
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    } else {
      el.className = 'end-panel';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.innerHTML = `
        <span class="door-kicker">END OF EXHIBITION</span>
        <span class="door-title">展览终点</span>
        <span class="door-sub">光与色彩的派对到此暂歇</span>
        <span class="door-arrow">印</span>
        <span class="door-sub">点击回看展品目录</span>`;
      const go = () => openCatalog();
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    return el;
  }

  function renderWall(index) {
    if (state.panRaf) { cancelAnimationFrame(state.panRaf); state.panRaf = 0; }
    const room = DATA.rooms[index];
    const wall = $('#wall');
    wall.style.transform = 'translate3d(0,0,0)';
    wall.innerHTML = '';
    wall.appendChild(buildRoomTitlePanel(room));
    room.exhibits.forEach((ex, ei) => wall.appendChild(buildArtwork(ex, ei, index)));
    wall.appendChild(buildDoor(index));
    const tail = document.createElement('div');
    tail.className = 'wall-tail';
    wall.appendChild(tail);
    requestAnimationFrame(() => { measureWall(); applyPanInstant(0); });
  }

  function measureWall() {
    const wall = $('#wall');
    const vp = $('#wallViewport');
    state.artworks = $$('.artwork', wall).map(el => ({
      el, inner: el.firstElementChild, left: el.offsetLeft, width: el.offsetWidth
    }));
    const last = wall.lastElementChild;
    const contentRight = last ? last.offsetLeft + last.offsetWidth : wall.scrollWidth;
    state.wallMax = Math.max(0, contentRight - vp.clientWidth);
    updateNav();
  }

  function applyPanInstant(x) {
    state.panX = clamp(x, 0, state.wallMax);
    state.targetPan = state.panX;
    $('#wall').style.transform = `translate3d(${-state.panX}px,0,0)`;
    const fill = state.wallMax ? (state.panX / state.wallMax) * 100 : 0;
    $('#panFill').style.width = `${fill}%`;
    updateDepth();
    updateNav();
  }

  function setPanTarget(x) {
    state.targetPan = clamp(x, 0, state.wallMax);
    if (!state.panRaf) state.panRaf = requestAnimationFrame(panLoop);
  }

  function panLoop() {
    const diff = state.targetPan - state.panX;
    if (Math.abs(diff) < 0.6) {
      state.panX = state.targetPan;
      applyPanInstant(state.panX);
      state.panRaf = 0;
      return;
    }
    state.panX += diff * 0.2;
    $('#wall').style.transform = `translate3d(${-state.panX}px,0,0)`;
    const fill = state.wallMax ? (state.panX / state.wallMax) * 100 : 0;
    $('#panFill').style.width = `${fill}%`;
    updateDepth();
    updateNav();
    state.panRaf = requestAnimationFrame(panLoop);
  }

  function updateDepth() {
    if (window.innerWidth < 900) return;
    const half = window.innerWidth / 2;
    const px = state.dragging ? null : state.pointerX;
    const range = 280;
    state.artworks.forEach(a => {
      const center = a.left - state.panX + a.width / 2;
      const d = (center - half) / half;
      const ry = clamp(-d * 4.2, -4.2, 4.2);
      const tz = -Math.min(Math.abs(d) * 52, 52);
      let scale = 1, lift = 0;
      if (px != null) {
        const dist = Math.abs(center - px);
        if (dist < range) {
          const k = 1 - dist / range;
          scale = 1 + 0.08 * k * k;
          lift = -12 * k * k;
        }
      }
      a.inner.style.transform = `translate3d(0,${lift.toFixed(2)}px,${tz}px) rotateY(${ry.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    });
  }

  function updateNav() {
    const atStart = state.panX <= 1;
    const atEnd = state.panX >= state.wallMax - 1;
    $('#prevBtn').disabled = atStart && state.roomIndex === 0;
    $('#nextBtn').disabled = atEnd && state.roomIndex === DATA.rooms.length - 1;
  }

  function step(dir) {
    const vw = $('#wallViewport').clientWidth;
    if (dir > 0 && state.panX >= state.wallMax - 2) {
      if (state.roomIndex < DATA.rooms.length - 1) enterRoom(state.roomIndex + 1, true, 'start');
      return;
    }
    if (dir < 0 && state.panX <= 2) {
      if (state.roomIndex > 0) enterRoom(state.roomIndex - 1, true, 'end');
      return;
    }
    setPanTarget(state.targetPan + dir * vw * 0.7);
  }

  function enterRoom(index, showThreshold = true, position = 'start') {
    if (index < 0 || index >= DATA.rooms.length) return;
    if (state.panRaf) { cancelAnimationFrame(state.panRaf); state.panRaf = 0; }
    state.roomIndex = index;
    renderWall(index);
    updateTop();
    updateRoute();
    preloadRoom(index);
    preloadRoom(index + 1);
    if (showThreshold) {
      showThresholdPanel(index);
    } else {
      $('#threshold').hidden = true;
      if (state.overlay === 'threshold') state.overlay = null;
    }
    if (position === 'end') {
      requestAnimationFrame(() => { measureWall(); applyPanInstant(state.wallMax); });
    }
  }

  function preloadFull(im) {
    if (!im || !im.full || im.full === im.src || fullPreloaded.has(im.full)) return;
    fullPreloaded.add(im.full);
    const img = new Image();
    img.decoding = 'async';
    img.src = im.full;
  }

  function preloadRoom(index) {
    if (index < 0 || index >= DATA.rooms.length || preloaded.has(index)) return;
    preloaded.add(index);
    DATA.rooms[index].exhibits.forEach(ex => { const img = new Image(); img.decoding = 'async'; img.src = ex.hero.src; });
    // 预热本厅第一件的高清图，减少首次点击等待
    const first = DATA.rooms[index].exhibits[0];
    if (first) preloadFull(first.hero);
  }

  /* =========================================================
     门槛
     ========================================================= */
  function knowledgeHtml(room) {
    if (!room.knowledge || !room.knowledge.length) return '';
    return `<div class="threshold-knowledge">
      <p class="tk-title">本单元关键词</p>
      ${room.knowledge.map((k, i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(k.term)}</summary><p>${esc(k.text)}</p></details>`).join('')}
    </div>`;
  }

  function showThresholdPanel(index) {
    const room = DATA.rooms[index];
    state.overlay = 'threshold';
    $('#threshold').hidden = false;
    $('#thresholdKicker').textContent = `${room.chapter} · ${pad2(index + 1)} / ${DATA.meta.roomCount}`;
    $('#thresholdTitle').textContent = room.title;
    $('#thresholdSub').textContent = room.subtitle;
    $('#thresholdIntro').innerHTML = room.intro.map(p => `<p>${esc(p)}</p>`).join('') + knowledgeHtml(room);
    $('#thresholdPanel').style.setProperty('--panel-color', room.sectionColor);
    $('#thresholdPanel').scrollTop = 0;
    $('#threshold').scrollTop = 0;
  }

  function skipThreshold() {
    $('#threshold').hidden = true;
    if (state.overlay === 'threshold') state.overlay = null;
    if (window.innerWidth < 720 && !mobileHintShown) {
      mobileHintShown = true;
      setTimeout(() => toast('左右拖动浏览展墙 · 点击画作查看详情'), 450);
    }
  }

  /* =========================================================
     详情
     ========================================================= */
  const DETAIL_RETURN_LABEL = { catalog: '返回目录', timeline: '返回时间轴', network: '返回关系图', gallery: '返回展厅' };

  function openDetail(ri, ei, imgIndex = 0, from = 'gallery') {
    const room = DATA.rooms[ri];
    const ex = room && room.exhibits[ei];
    if (!ex) return;
    hideToast();
    state.detail = { ri, ei, imgIndex };
    state.detailFrom = from;
    state.overlay = 'detail';
    $('#detail').hidden = false;
    $('#detailCloseBtn').innerHTML = `← <span>${DETAIL_RETURN_LABEL[from] || '返回展厅'}</span>`;
    renderDetail();
    markVisited(ex.id);
  }

  function renderDetail() {
    if (!state.detail) return;
    const { ri, ei, imgIndex } = state.detail;
    const room = DATA.rooms[ri];
    const ex = room.exhibits[ei];
    const item = FLAT.find(f => f.ri === ri && f.ei === ei);

    $('#detailKicker').textContent = `${room.chapter} · ${room.title}`;
    $('#detailName').textContent = ex.name;
    $('#detailArtist').textContent = ex.artist;
    $('#detailMeta').textContent = [ex.yearLabel, ex.school, ex.medium].filter(Boolean).join(' · ');
    $('#detailCounter').textContent = `第 ${item.global} 组 / 共 ${DATA.meta.total} 组 · ${ex.workCount} 件`;
    $('#detailBody').innerHTML = ex.intro.length
      ? ex.intro.map(p => `<p>${esc(p)}</p>`).join('')
      : '<p>本组展项暂无简介。</p>';
    $('#detailFoot').hidden = true;
    $('#detailFoot').innerHTML = '';
    $('#detailPanel').scrollTop = 0;
    $('#detailPrevBtn').disabled = item.global <= 1;
    $('#detailNextBtn').disabled = item.global >= FLAT.length;

    renderTags(ex);
    renderGraph(ex);
    renderViewer(ex, imgIndex);
  }

  function renderTags(ex) {
    const wrap = $('#detailTags');
    const tags = ex.tags || [];
    if (!tags.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <div class="dt-head"><span>特征标签</span><small>点击标签查看百科</small></div>
      <div class="tag-list">${tags.map(t => `<button type="button" class="tag-chip ${esc(t.kind)}" data-tag="${esc(t.name)}" data-kind="${esc(t.kind)}">${esc(t.name)}</button>`).join('')}</div>`;
  }

  function renderGraph(ex) {
    const wrap = $('#detailGraph');
    const rels = DATA.relations.filter(r => r.a === ex.artistId || r.b === ex.artistId);
    if (!rels.length) {
      wrap.innerHTML = '<div class="dg-head"><span>画家关系</span></div><p class="dg-empty">暂无记录在案的关系。</p>';
      return;
    }
    const neighbors = [];
    const seen = new Set();
    rels.forEach(r => {
      const oid = r.a === ex.artistId ? r.b : r.a;
      if (seen.has(oid)) return;
      seen.add(oid);
      const a = ARTIST_BY_ID.get(oid);
      if (a) neighbors.push({ artist: a, type: r.type, note: r.note });
    });
    const list = neighbors.slice(0, 6);
    const cx = 180, cy = 152, radius = 104;
    const pos = list.map((r, i) => {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / list.length);
      return { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
    });
    const edges = list.map((r, i) => `<line class="rel-edge ${REL_CLASS[r.type] || 'peer'}" x1="${cx}" y1="${cy}" x2="${pos[i].x.toFixed(1)}" y2="${pos[i].y.toFixed(1)}"/>`).join('');
    const nodes = list.map((r, i) => {
      const p = pos[i];
      return `<g class="rel-node" data-artist="${esc(r.artist.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
        <circle r="23"></circle>
        <text y="4">${esc(shortArtist(r.artist.name))}</text>
        <title>${esc(r.artist.name)} · ${esc(r.type)}：${esc(r.note)}</title>
      </g>`;
    }).join('');
    wrap.innerHTML = `
      <div class="dg-head"><span>画家关系 · 点击切换作品</span><small>${esc(shortArtist(ex.artist))}</small></div>
      <svg class="rel-graph" viewBox="0 0 360 304" role="img" aria-label="画家关系图">
        ${edges}${nodes}
        <g class="rel-center" transform="translate(${cx},${cy})">
          <circle r="32"></circle>
          <text y="4">${esc(shortArtist(ex.artist))}</text>
          <title>${esc(ex.artist)}</title>
        </g>
      </svg>
      <div class="dg-legend">
        <span><i class="teacher"></i>师承</span>
        <span><i class="friend"></i>挚友</span>
        <span><i class="peer"></i>同道</span>
        <span><i class="influence"></i>影响</span>
        <span><i class="rival"></i>论争</span>
      </div>
      <button class="ghost-btn" id="detailArtistWikiBtn" type="button" style="margin-top:10px">查看画家百科</button>`;
    $$('.rel-node', wrap).forEach(g => {
      g.addEventListener('click', () => {
        const aid = g.dataset.artist;
        const target = FLAT.find(f => f.ex.artistId === aid && f.ex.id !== ex.id)
          || FLAT.find(f => f.ex.artistId === aid);
        if (target) {
          state.detail = { ri: target.ri, ei: target.ei, imgIndex: 0 };
          renderDetail();
          markVisited(target.ex.id);
        }
      });
    });
    const btn = $('#detailArtistWikiBtn');
    if (btn) btn.addEventListener('click', () => openArtistWiki(ex.artistId));
  }

  function stepDetail(dir) {
    if (!state.detail) return;
    const idx = FLAT.findIndex(f => f.ri === state.detail.ri && f.ei === state.detail.ei);
    const next = FLAT[idx + dir];
    if (!next) return;
    if (next.ri !== state.detail.ri) enterRoom(next.ri, false);
    state.detail = { ri: next.ri, ei: next.ei, imgIndex: 0 };
    renderDetail();
    markVisited(next.ex.id);
  }

  function closeDetail() {
    viewerLoadToken++;
    setViewerFullscreen(false, true);
    state.viewer.pointers.clear();
    state.viewer.pinch = null;
    state.viewer.dragging = false;
    $('#detail').hidden = true;
    state.detail = null;
    if (state.overlay === 'detail') state.overlay = null;
  }

  /* ---------- 看图 ---------- */
  function initialViewerMode() {
    const v = state.viewer;
    const r = v.natW / v.natH;
    if (r >= 2.4) return 'width';
    if (r <= 0.55) return 'height';
    return 'all';
  }

  function renderViewer(ex, imgIndex) {
    const im = ex.images[imgIndex] || ex.hero;
    const v = state.viewer;
    v.natW = im.w || 1000;
    v.natH = im.h || 1000;
    const token = ++viewerLoadToken;
    const img = $('#viewerImg');
    // 先显示本地缩略图，保证点击后立即有画面
    img.onerror = null;
    img.src = im.src;
    img.dataset.quality = 'thumb';
    img.alt = `${ex.name} · 图 ${imgIndex + 1}`;
    fitViewer(initialViewerMode());
    renderThumbs(ex, imgIndex);

    // 后台缓冲知乎代理大图，加载完成后无缝替换
    if (im.full && im.full !== im.src) {
      const pre = new Image();
      pre.decoding = 'async';
      pre.onload = () => {
        if (token !== viewerLoadToken || !state.detail) return;
        if (state.detail.imgIndex !== imgIndex) return;
        const current = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
        if (current !== ex) return;
        img.src = im.full;
        img.dataset.quality = 'full';
      };
      pre.onerror = () => { /* 保持本地缩略图 */ };
      pre.src = im.full;
    } else {
      img.dataset.quality = 'full';
    }

    if (ex.images.length > 1) {
      const cap = im.caption ? ` · ${im.caption}` : '';
      setTimeout(() => { if (state.detail) toast(`${ex.name}${cap} · ${imgIndex + 1}/${ex.images.length}`); }, 300);
    }
  }

  function renderThumbs(ex, active) {
    const wrap = $('#viewerThumbs');
    wrap.innerHTML = '';
    if (ex.images.length <= 1) return;
    ex.images.forEach((im, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vthumb' + (i === active ? ' active' : '');
      b.innerHTML = `<img src="${esc(im.src)}" alt="">`;
      b.addEventListener('click', () => {
        if (!state.detail) return;
        state.detail.imgIndex = i;
        const ex2 = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
        renderViewer(ex2, i);
      });
      wrap.appendChild(b);
    });
    const current = wrap.children[active];
    if (current) requestAnimationFrame(() => current.scrollIntoView({ block: 'nearest', inline: 'center' }));
  }

  function fitViewer(mode) {
    const v = state.viewer;
    const stage = $('#viewerStage');
    const sw = stage.clientWidth || 800;
    const sh = stage.clientHeight || 500;
    let s;
    if (mode === 'width') s = (sw * 0.92) / v.natW;
    else if (mode === 'height') s = (sh * 0.92) / v.natH;
    else s = Math.min((sw - 70) / v.natW, (sh - 80) / v.natH);
    s = Math.max(s, 0.0001);
    v.fit = s;
    v.scale = 1;
    if (mode === 'width') {
      v.x = 0; v.y = Math.max(0, (v.natH * s - sh) / 2);
      $('#viewerHint').textContent = '上下拖动查看全图 · 滚轮缩放';
    } else if (mode === 'height') {
      v.x = Math.min(0, (v.natW * s - sw) / 2); v.y = 0;
      $('#viewerHint').textContent = '左右拖动查看全图 · 滚轮缩放';
    } else {
      v.x = 0; v.y = 0;
      $('#viewerHint').textContent = '滚轮缩放 · 拖动查看细节 · 双击放大';
    }
    clampViewer();
    applyViewer();
  }

  function applyViewer() {
    const v = state.viewer;
    const art = $('#viewerArt');
    const img = $('#viewerImg');
    const w = v.natW * v.fit * v.scale;
    const h = v.natH * v.fit * v.scale;
    art.style.width = `${w}px`;
    art.style.height = `${h}px`;
    art.style.transform = `translate(-50%, -50%) translate(${v.x}px, ${v.y}px)`;
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = 'translate(-50%, -50%)';
    updateScrollbar(w, h);
  }

  function updateScrollbar(w, h) {
    const bar = $('#viewerScrollbar');
    const thumb = bar.firstElementChild;
    const stage = $('#viewerStage');
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (w > sw + 4) {
      bar.className = 'viewer-scrollbar horizontal show';
      const tw = clamp((sw / w) * 100, 8, 100);
      const maxX = (w - sw) / 2 + 20;
      const ratio = maxX > 0 ? clamp((maxX - state.viewer.x) / (2 * maxX), 0, 1) : 0;
      thumb.style.width = `${tw}%`; thumb.style.height = '100%';
      thumb.style.left = `${ratio * (100 - tw)}%`; thumb.style.top = '0';
    } else if (h > sh + 4) {
      bar.className = 'viewer-scrollbar vertical show';
      const th = clamp((sh / h) * 100, 8, 100);
      const maxY = (h - sh) / 2 + 20;
      const ratio = maxY > 0 ? clamp((maxY - state.viewer.y) / (2 * maxY), 0, 1) : 0;
      thumb.style.height = `${th}%`; thumb.style.width = '100%';
      thumb.style.top = `${ratio * (100 - th)}%`; thumb.style.left = '0';
    } else {
      bar.className = 'viewer-scrollbar';
    }
  }

  function clampViewer() {
    const v = state.viewer;
    const stage = $('#viewerStage');
    const w = v.natW * v.fit * v.scale;
    const h = v.natH * v.fit * v.scale;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const maxX = w > sw ? (w - sw) / 2 + 20 : 0;
    const maxY = h > sh ? (h - sh) / 2 + 20 : 0;
    v.x = clamp(v.x, -maxX, maxX);
    v.y = clamp(v.y, -maxY, maxY);
  }

  function zoomViewer(factor) {
    const v = state.viewer;
    const next = clamp(v.scale * factor, 1, 10);
    if (Math.abs(next - v.scale) < 0.001) return;
    v.scale = next;
    clampViewer();
    applyViewer();
  }

  function setViewerFullscreen(on, quiet = false) {
    const v = state.viewer;
    if (!!on === v.fullscreen) return;
    v.fullscreen = !!on;
    $('#detail').classList.toggle('viewer-max', v.fullscreen);
    $('#viewerFullBtn').setAttribute('aria-pressed', v.fullscreen ? 'true' : 'false');
    if (!state.detail) return;
    requestAnimationFrame(() => fitViewer(initialViewerMode()));
    if (!quiet) toast(v.fullscreen ? '全屏查看 · 拖动浏览，双指缩放' : '已退出全屏');
  }

  /* ---------- 下载 ---------- */
  function loadDownloadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('timeout')), 25000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
      img.src = url;
    });
  }

  function drawWatermarkedCanvas(img) {
    const srcW = img.naturalWidth, srcH = img.naturalHeight;
    const maxPixels = 40e6;
    let scale = Math.min(1, 16384 / Math.max(srcW, srcH), Math.sqrt(maxPixels / (srcW * srcH)));
    const cw = Math.max(1, Math.round(srcW * scale));
    const ch = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('ctx'));
    ctx.drawImage(img, 0, 0, cw, ch);
    const fs = Math.max(20, Math.min(140, Math.round(Math.min(cw * 0.024, ch * 0.08))));
    const text = '獭的游乐场';
    const x = cw - fs * 0.7, y = ch - fs * 0.45;
    ctx.font = `${fs}px "Songti SC","STSong","SimSun",serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = fs * 0.55;
    ctx.shadowOffsetY = fs * 0.06;
    ctx.lineWidth = Math.max(1, fs * 0.07);
    ctx.strokeStyle = 'rgba(40,30,22,0.48)';
    ctx.strokeText(text, x, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = 'rgba(255,248,235,0.5)';
    ctx.fillText(text, x, y);
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('blob')), 'image/jpeg', 0.92);
    });
  }

  async function downloadWatermarked() {
    if (!state.detail) return;
    const ex = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
    const im = ex.images[state.detail.imgIndex] || ex.hero;
    const suffix = ex.images.length > 1 ? `_${state.detail.imgIndex + 1}` : '';
    const fileName = `獭的游乐场_${String(ex.name).replace(/[\\/:*?"<>|]/g, '_')}${suffix}.jpg`;
    toast('正在准备大图…');
    let img;
    try {
      img = await loadDownloadImage(im.full);
    } catch (e) {
      try { img = await loadDownloadImage(im.src); }
      catch (err) { toast('图片加载失败，暂时无法保存'); return; }
    }
    try {
      const blob = await drawWatermarkedCanvas(img);
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('已保存带水印大图');
    } catch (e) {
      toast('图片保存失败，请改用本地服务器打开页面后重试');
    }
  }

  /* =========================================================
     目录
     ========================================================= */
  function renderCatalogFilters() {
    const wrap = $('#catalogFilters');
    const schools = [];
    FLAT.forEach(f => { if (!schools.includes(f.ex.school)) schools.push(f.ex.school); });
    const artists = DATA.artists.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    wrap.innerHTML = `
      <div class="filter-row">
        <span class="filter-label">展厅</span>
        <button type="button" class="filter-chip ${state.catalogFilter === 'all' ? 'active' : ''}" data-room="all">全部 ${DATA.meta.total} 组</button>
        ${DATA.rooms.map((r, i) => `<button type="button" class="filter-chip ${state.catalogFilter === String(i) ? 'active' : ''}" data-room="${i}"><span class="dot" style="background:${r.sectionColor}"></span>${pad2(i + 1)} ${esc(r.title)} · ${r.exhibits.length}</button>`).join('')}
      </div>
      <div class="filter-row">
        <span class="filter-label">流派</span>
        <button type="button" class="filter-chip ${state.catalogSchool === 'all' ? 'active' : ''}" data-school="all">全部</button>
        ${schools.map(s => `<button type="button" class="filter-chip ${state.catalogSchool === s ? 'active' : ''}" data-school="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div class="filter-row">
        <span class="filter-label">画家</span>
        <select class="filter-chip filter-select" id="catalogArtist">
          <option value="all">全部画家</option>
          ${artists.map(a => `<option value="${esc(a.id)}"${state.catalogArtist === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
        </select>
        <button type="button" class="filter-chip" id="catalogClearBtn">清空筛选</button>
      </div>`;
    $$('.filter-chip[data-room]', wrap).forEach(b => b.addEventListener('click', () => {
      state.catalogFilter = b.dataset.room; renderCatalogFilters(); renderCatalog();
    }));
    $$('.filter-chip[data-school]', wrap).forEach(b => b.addEventListener('click', () => {
      state.catalogSchool = b.dataset.school; renderCatalogFilters(); renderCatalog();
    }));
    const sel = $('#catalogArtist');
    if (sel) sel.addEventListener('change', e => { state.catalogArtist = e.target.value; renderCatalog(); });
    const clear = $('#catalogClearBtn');
    if (clear) clear.addEventListener('click', () => {
      state.catalogFilter = 'all'; state.catalogSchool = 'all'; state.catalogArtist = 'all'; state.catalogQuery = '';
      $('#catalogSearch').value = '';
      renderCatalogFilters(); renderCatalog();
    });
  }

  function renderCatalog() {
    const grid = $('#catalogGrid');
    const q = state.catalogQuery.trim().toLowerCase();
    const items = FLAT.filter(item => {
      if (state.catalogFilter !== 'all' && String(item.ri) !== state.catalogFilter) return false;
      if (state.catalogSchool !== 'all' && item.ex.school !== state.catalogSchool) return false;
      if (state.catalogArtist !== 'all' && item.ex.artistId !== state.catalogArtist) return false;
      if (!q) return true;
      const hay = `${item.ex.name} ${item.ex.artist} ${item.ex.school} ${item.ex.yearLabel} ${item.room.title} ${item.ex.tags.map(t => t.name).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    const works = items.reduce((s, x) => s + x.ex.workCount, 0);
    $('#catalogSummary').textContent = `${items.length} 组 / ${works} 件作品${state.catalogSchool !== 'all' ? ' · ' + state.catalogSchool : ''}${state.catalogArtist !== 'all' ? ' · ' + (ARTIST_BY_ID.get(state.catalogArtist) || {}).name : ''}`;
    if (!items.length) {
      grid.innerHTML = '<div class="catalog-empty">没有找到匹配的展品，试试其他关键词。</div>';
      return;
    }
    grid.innerHTML = items.map(item => {
      const ex = item.ex;
      return `<article class="cat-card${state.visited.has(ex.id) ? ' visited' : ''}" data-id="${esc(ex.id)}" tabindex="0" role="button" aria-label="${esc(ex.name)}">
        <div class="cat-img">
          <img loading="lazy" src="${esc(ex.hero.src)}" alt="">
          <span class="cat-no">${pad2(item.global)}</span>
          ${ex.workCount > 1 ? `<span class="cat-count">${ex.workCount} 件</span>` : ''}
        </div>
        <p class="cat-name">${esc(ex.name)}</p>
        <div class="cat-meta">${esc(ex.artist)} · ${esc(ex.yearLabel)}</div>
        <div class="cat-room">${esc(ex.school)} · ${esc(item.room.title)}</div>
      </article>`;
    }).join('');
  }

  function openCatalog() {
    hideToast();
    state.catalogScroll = $('#catalog').scrollTop;
    state.overlay = 'catalog';
    $('#catalog').hidden = false;
    renderCatalogFilters();
    renderCatalog();
    $('#catalog').scrollTop = state.catalogScroll;
  }
  function closeCatalog() {
    state.catalogScroll = $('#catalog').scrollTop;
    $('#catalog').hidden = true;
    if (state.overlay === 'catalog') state.overlay = null;
  }

  /* =========================================================
     时间轴
     ========================================================= */
  const TL_PAD = 76;
  const TL_GAP = 68;          // 相邻有作品年份的间距
  const TL_EXTRA_PER_YEAR = 5; // 空档年份的轻微补偿
  const TL_EXTRA_MAX = 54;

  function tlLayout() {
    const present = [...new Set(FLAT.map(f => f.ex.year))].sort((a, b) => a - b);
    const pos = new Map();
    let x = 0;
    present.forEach((y, i) => {
      if (i) {
        const prev = present[i - 1];
        x += TL_GAP + Math.min(TL_EXTRA_MAX, Math.max(0, y - prev - 1) * TL_EXTRA_PER_YEAR);
      }
      pos.set(y, x);
    });
    return { present, pos, total: x };
  }

  function tlBuild() {
    const canvas = $('#tlCanvas');
    const items = $('#tlItems');
    const years = $('#tlYears');
    const layout = tlLayout();
    const scale = state.timeline.scale;
    const width = TL_PAD * 2 + layout.total * scale;
    canvas.style.width = `${width}px`;
    state.timeline.layout = layout;
    state.timeline.width = width;

    const pool = FLAT.filter(f => state.timeline.school === 'all' || f.ex.school === state.timeline.school);
    const byYear = new Map();
    pool.forEach(item => {
      const y = item.ex.year;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(item);
    });
    let maxStack = 1;
    byYear.forEach(arr => { maxStack = Math.max(maxStack, arr.length); });
    const height = Math.max(420, maxStack * 70 + 190);
    canvas.style.height = `${height}px`;
    const nodeW = isMobile() ? 50 : 60;
    const stackGap = 66;

    years.innerHTML = '';
    (state.timeline.school === 'all' ? layout.present : Array.from(byYear.keys()).sort((a, b) => a - b))
      .forEach(y => {
        if (!layout.pos.has(y)) return;
        const el = document.createElement('span');
        el.className = 'tl-year';
        el.style.left = `${TL_PAD + layout.pos.get(y) * scale}px`;
        el.textContent = String(y);
        years.appendChild(el);
      });
    items.innerHTML = '';
    const sorted = Array.from(byYear.keys()).sort((a, b) => a - b);
    sorted.forEach(y => {
      const arr = byYear.get(y);
      arr.forEach((item, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tl-node';
        b.style.left = `${TL_PAD + layout.pos.get(y) * scale - nodeW / 2}px`;
        b.style.bottom = `${idx * stackGap}px`;
        b.style.width = `${nodeW}px`;
        b.title = `${item.ex.name} · ${item.ex.artist} · ${item.ex.yearLabel}`;
        b.innerHTML = `<span class="tl-img"><img loading="eager" decoding="async" src="${esc(item.ex.hero.src)}" alt=""><span class="tl-count">${item.ex.workCount > 1 ? item.ex.workCount : pad2(item.global)}</span></span><span class="tl-name">${esc(item.ex.name)}</span>`;
        b.addEventListener('click', () => {
          state.overlay = 'timeline';
          openDetail(item.ri, item.ei, 0, 'timeline');
        });
        b.addEventListener('pointerenter', () => preloadFull(item.ex.hero), { once: true });
        items.appendChild(b);
      });
    });
    const works = pool.reduce((s, x) => s + x.ex.workCount, 0);
    $('#tlSummary').textContent = `${pool.length} 组 · ${works} 件作品 · 按创作年代排列 · 空白年份已压缩${state.timeline.school !== 'all' ? ' · ' + state.timeline.school : ''}`;
    $('#tlCanvas').style.height = `${height}px`;
    state.timeline.built = true;
  }

  function renderTimelineSchools() {
    const wrap = $('#tlSchoolFilters');
    const schools = [];
    FLAT.forEach(f => { if (!schools.includes(f.ex.school)) schools.push(f.ex.school); });
    wrap.innerHTML = `<button type="button" class="filter-chip ${state.timeline.school === 'all' ? 'active' : ''}" data-school="all">全部</button>` +
      schools.map(s => `<button type="button" class="filter-chip ${state.timeline.school === s ? 'active' : ''}" data-school="${esc(s)}">${esc(s)}</button>`).join('');
    $$('.filter-chip', wrap).forEach(b => b.addEventListener('click', () => {
      state.timeline.school = b.dataset.school;
      renderTimelineSchools();
      tlBuild();
    }));
  }

  function openTimeline() {
    hideToast();
    state.overlay = 'timeline';
    $('#timeline').hidden = false;
    if (!state.timeline.built) {
      state.timeline.scale = 1;
      renderTimelineSchools();
      tlBuild();
      $('#tlScroll').scrollLeft = 0;
    }
  }
  function closeTimeline() {
    $('#timeline').hidden = true;
    if (state.overlay === 'timeline') state.overlay = null;
  }

  function tlZoom(factor, clientX = null) {
    const scroll = $('#tlScroll');
    const layout = state.timeline.layout;
    if (!layout) return;
    const oldScale = state.timeline.scale;
    const newScale = clamp(oldScale * factor, 0.95, 3);
    if (Math.abs(newScale - oldScale) < 0.005) return;
    const rect = scroll.getBoundingClientRect();
    const offset = clientX == null ? scroll.clientWidth / 2 : clientX - rect.left;
    const baseX = (scroll.scrollLeft + offset - TL_PAD) / oldScale;
    let anchor = layout.present[0], best = Infinity;
    layout.present.forEach(y => {
      const d = Math.abs(layout.pos.get(y) - baseX);
      if (d < best) { best = d; anchor = y; }
    });
    state.timeline.scale = newScale;
    tlBuild();
    scroll.scrollLeft = Math.max(0, TL_PAD + layout.pos.get(anchor) * newScale - offset);
  }

  /* =========================================================
     关系图
     ========================================================= */
  function netBuild() {
    if (state.network.built) return;
    const svg = $('#netSvg');
    const nodes = DATA.graph.nodes;
    const edges = DATA.graph.edges;
    const radii = new Map(nodes.map(n => [n.id, n.r || 20]));

    const edgeHtml = edges.map(e => {
      const A = nodes.find(n => n.id === e.a);
      const B = nodes.find(n => n.id === e.b);
      if (!A || !B) return '';
      return `<line class="net-edge t-${e.type}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`;
    }).join('');

    // 标签避让：候选位置依次尝试下、上、右、左、四角
    const placed = [];
    const labelOf = new Map();
    nodes.forEach(n => {
      const r = radii.get(n.id);
      const short = shortArtist(n.name);
      const textW = Math.max(24, short.length * 12 + 6);
      const candidates = [
        { dx: 0, dy: r + 14, anchor: 'middle' },
        { dx: 0, dy: -r - 4, anchor: 'middle' },
        { dx: r + 8, dy: 4, anchor: 'start' },
        { dx: -r - 8, dy: 4, anchor: 'end' },
        { dx: r * 0.7, dy: r * 0.7 + 12, anchor: 'middle' },
        { dx: -r * 0.7, dy: r * 0.7 + 12, anchor: 'middle' },
        { dx: r * 0.7, dy: -r * 0.7 - 2, anchor: 'middle' },
        { dx: -r * 0.7, dy: -r * 0.7 - 2, anchor: 'middle' },
        { dx: 0, dy: r + 28, anchor: 'middle' },
        { dx: 0, dy: -r - 18, anchor: 'middle' }
      ];
      let chosen = null, fallback = null;
      for (const c of candidates) {
        const x = n.x + c.dx;
        const y = n.y + c.dy;
        const left = c.anchor === 'middle' ? x - textW / 2 : c.anchor === 'start' ? x : x - textW;
        const rect = { x: left, y: y - 11, w: textW, h: 14 };
        let bad = false;
        for (const o of nodes) {
          if (o.id === n.id) continue;
          const or = radii.get(o.id);
          if (rect.x < o.x + or + 4 && rect.x + rect.w > o.x - or - 4 &&
              rect.y < o.y + or + 4 && rect.y + rect.h > o.y - or - 4) { bad = true; break; }
        }
        if (!bad) {
          for (const p of placed) {
            if (rect.x < p.x + p.w + 3 && rect.x + rect.w + 3 > p.x && rect.y < p.y + p.h + 2 && rect.y + rect.h + 2 > p.y) { bad = true; break; }
          }
        }
        if (!bad) { chosen = c; placed.push(rect); break; }
        if (!fallback) fallback = { c, rect };
      }
      if (!chosen) {
        chosen = fallback ? fallback.c : candidates[0];
        if (fallback) placed.push(fallback.rect);
      }
      labelOf.set(n.id, { ...chosen, short });
    });

    const nodeHtml = nodes.map(n => {
      const r = radii.get(n.id);
      const c = labelOf.get(n.id);
      const color = SCHOOL_COLORS[n.school] || '#c9a45c';
      return `<g class="net-node" data-id="${esc(n.id)}" data-school="${esc(n.school)}" tabindex="0">
        <circle cx="${n.x}" cy="${n.y}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.2"></circle>
        <circle cx="${n.x}" cy="${n.y}" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-opacity="0.85" stroke-width="1.2"></circle>
        <text x="${n.x + c.dx}" y="${n.y + c.dy}" text-anchor="${c.anchor}">${esc(c.short)}</text>
        <title>${esc(n.name)} · ${esc(n.school)} · ${n.works} 组作品</title>
      </g>`;
    }).join('');

    svg.innerHTML = `<g id="netView">${edgeHtml}${nodeHtml}</g>`;
    state.network.built = true;
    netApply();
    bindNetworkNodes();
    renderNetworkSchools();
  }

  function netApply() {
    const g = $('#netView');
    if (!g) return;
    g.setAttribute('transform', `translate(${state.network.tx},${state.network.ty}) scale(${state.network.scale})`);
  }

  function netResetPanel() {
    const panel = $('#netPanel');
    panel.innerHTML = '<p class="net-empty">点击左侧任意画家节点，查看其简介、艺术关系与本展作品。</p>';
    panel.scrollTop = 0;
  }

  function netSelect(id) {
    const activeId = id || '';
    state.network.active = activeId;
    const adjacent = new Set();
    if (activeId) {
      DATA.relations.forEach(r => {
        if (r.a === activeId) adjacent.add(r.b);
        if (r.b === activeId) adjacent.add(r.a);
      });
    }
    $$('.net-node').forEach(g => {
      const nid = g.dataset.id;
      g.classList.toggle('active', nid === activeId);
      g.classList.toggle('related', !!activeId && adjacent.has(nid));
      g.classList.toggle('sel-dim', !!activeId && nid !== activeId && !adjacent.has(nid));
    });
    $$('.net-edge').forEach(line => {
      const on = !!activeId && (line.dataset.a === activeId || line.dataset.b === activeId);
      line.classList.toggle('active', on);
    });
    if (activeId) renderNetworkPanel(activeId);
    else netResetPanel();
  }

  function renderNetworkSchools() {
    const wrap = $('#netSchoolFilters');
    const schools = [];
    FLAT.forEach(f => { if (!schools.includes(f.ex.school)) schools.push(f.ex.school); });
    wrap.innerHTML = `<button type="button" class="filter-chip ${state.network.school === 'all' ? 'active' : ''}" data-school="all">全部</button>` +
      schools.map(s => `<button type="button" class="filter-chip ${state.network.school === s ? 'active' : ''}" data-school="${esc(s)}"><span class="dot" style="background:${SCHOOL_COLORS[s] || '#c9a45c'}"></span>${esc(s)}</button>`).join('');
    $$('.filter-chip', wrap).forEach(b => b.addEventListener('click', () => {
      state.network.school = b.dataset.school;
      renderNetworkSchools();
      $$('.net-node').forEach(g => {
        g.classList.toggle('school-dim', state.network.school !== 'all' && g.dataset.school !== state.network.school);
      });
      if (state.network.active && state.network.school !== 'all') {
        const active = ARTIST_BY_ID.get(state.network.active);
        if (!active || active.school !== state.network.school) netSelect('');
      }
    }));
  }

  function bindNetworkNodes() {
    $$('.net-node').forEach(g => {
      const activate = () => netSelect(g.dataset.id);
      g.addEventListener('click', activate);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    });
  }

  function renderNetworkPanel(id) {
    const artist = ARTIST_BY_ID.get(id);
    if (!artist) return;
    const rels = DATA.relations.filter(r => r.a === id || r.b === id);
    const works = FLAT.filter(f => f.ex.artistId === id);
    const panel = $('#netPanel');
    panel.innerHTML = `
      <h3 class="netp-name">${esc(artist.name)}</h3>
      <p class="netp-sub">${esc(artist.en)} · ${esc(artist.life)} · ${esc(artist.school)}</p>
      <p class="netp-blurb">${esc(artist.blurb)}</p>
      <div class="netp-sec">
        <h4>艺术关系 · ${rels.length}</h4>
        ${rels.map(r => {
          const oid = r.a === id ? r.b : r.a;
          const other = ARTIST_BY_ID.get(oid);
          if (!other) return '';
          return `<button type="button" class="netp-rel" data-artist="${esc(oid)}"><span>${esc(r.type)}</span><b>${esc(other.name)}</b><small>${esc(r.note)}</small></button>`;
        }).join('')}
      </div>
      <div class="netp-sec">
        <h4>本展作品 · ${works.length} 组</h4>
        ${works.map(w => `<button type="button" class="netp-work" data-id="${esc(w.ex.id)}"><img src="${esc(w.ex.hero.src)}" alt=""><span>${esc(w.ex.name)}<small>${esc(w.ex.yearLabel)} · ${esc(w.room.title)}</small></span></button>`).join('')}
      </div>
      <button type="button" class="ghost-btn netp-open" id="netOpenArtistWiki">查看画家百科</button>`;
    panel.scrollTop = 0;
    $$('.netp-rel', panel).forEach(b => b.addEventListener('click', () => {
      const oid = b.dataset.artist;
      const g = $(`.net-node[data-id="${oid}"]`);
      if (g) { g.dispatchEvent(new Event('click')); }
    }));
    $$('.netp-work', panel).forEach(b => {
      const item = EX_BY_ID.get(b.dataset.id);
      if (item) b.addEventListener('pointerenter', () => preloadFull(item.ex.hero), { once: true });
      b.addEventListener('click', () => {
        if (item) openDetail(item.ri, item.ei, 0, 'network');
      });
    });
    const wb = $('#netOpenArtistWiki');
    if (wb) wb.addEventListener('click', () => openArtistWiki(id));
  }

  function openNetwork() {
    hideToast();
    state.overlay = 'network';
    $('#network').hidden = false;
    netBuild();
    netSelect('');
  }
  function closeNetwork() {
    $('#network').hidden = true;
    if (state.overlay === 'network') state.overlay = null;
  }

  /* =========================================================
     画家百科 / 标签百科
     ========================================================= */
  function openArtistWiki(id) {
    const a = ARTIST_BY_ID.get(id);
    if (!a) return;
    $('#awName').textContent = a.name;
    $('#awSub').textContent = `${a.en} · ${a.life} · ${a.school}`;
    $('#awBody').innerHTML = `<p>${esc(a.blurb)}</p>`;
    const rels = DATA.relations.filter(r => r.a === id || r.b === id);
    $('#awRelations').innerHTML = rels.map(r => {
      const oid = r.a === id ? r.b : r.a;
      const other = ARTIST_BY_ID.get(oid);
      if (!other) return '';
      return `<button type="button" class="rel-chip" data-artist="${esc(oid)}"><span>${esc(r.type)}</span>${esc(other.name)}</button>`;
    }).join('');
    const works = FLAT.filter(f => f.ex.artistId === id);
    $('#awWorks').innerHTML = works.map(w => `
      <button type="button" class="wiki-card" data-id="${esc(w.ex.id)}">
        <span class="wc-img"><img loading="lazy" src="${esc(w.ex.hero.src)}" alt=""></span>
        <span class="wc-name">${esc(w.ex.name)}</span>
        <span class="wc-meta">${esc(w.ex.yearLabel)} · ${esc(w.room.title)}</span>
      </button>`).join('');
    $$('.rel-chip', $('#awRelations')).forEach(b => b.addEventListener('click', () => openArtistWiki(b.dataset.artist)));
    $$('.wiki-card', $('#awWorks')).forEach(b => b.addEventListener('click', () => {
      const item = EX_BY_ID.get(b.dataset.id);
      closeArtistWiki();
      if (item) openDetail(item.ri, item.ei, 0, state.detailFrom || 'gallery');
    }));
    $('#artistWiki').hidden = false;
    $('#artistWiki').scrollTop = 0;
    $('#awCloseBtn').focus({ preventScroll: true });
  }
  function closeArtistWiki() { $('#artistWiki').hidden = true; }

  function openTagWiki(name, kind) {
    if (!name) return;
    const currentId = state.detail ? DATA.rooms[state.detail.ri].exhibits[state.detail.ei].id : '';
    const related = FLAT.filter(f => f.ex.id !== currentId && f.ex.tags.some(t => t.name === name)).slice(0, 8);
    $('#twTitle').textContent = name;
    $('#twKind').textContent = TAG_KIND_LABEL[kind] || '';
    $('#twBody').innerHTML = `<p>${esc(DATA.tagWiki[name] || `“${name}”是本展用于概括作品特征的标签。`)}</p>`;
    $('#twWorks').innerHTML = related.length
      ? related.map(f => `<button type="button" class="wiki-card" data-id="${esc(f.ex.id)}"><span class="wc-img"><img loading="lazy" src="${esc(f.ex.hero.src)}" alt=""></span><span class="wc-name">${esc(f.ex.name)}</span><span class="wc-meta">${esc(f.ex.artist)} · ${esc(f.room.title)}</span></button>`).join('')
      : '<p class="dg-empty">暂无其他相关展品。</p>';
    $$('.wiki-card', $('#twWorks')).forEach(b => b.addEventListener('click', () => {
      const item = EX_BY_ID.get(b.dataset.id);
      closeTagWiki();
      if (item) openDetail(item.ri, item.ei, 0, state.detailFrom || 'gallery');
    }));
    $('#tagWiki').hidden = false;
    $('#tagWiki').scrollTop = 0;
    $('#twCloseBtn').focus({ preventScroll: true });
  }
  function closeTagWiki() { $('#tagWiki').hidden = true; }

  /* =========================================================
     补充资料
     ========================================================= */
  function renderSupplement() {
    $('#supGrid').innerHTML = DATA.supplement.map(s => `
      <button type="button" class="sup-card" data-id="${esc(s.id)}">
        <span class="sup-img"><img loading="lazy" src="${esc(s.src)}" alt="${esc(s.title)}" style="aspect-ratio:${s.w}/${s.h};object-fit:cover"></span>
        <h3>${esc(s.title)}</h3>
        <p class="sup-sub">${esc(s.subtitle)}</p>
        <p class="sup-note">${esc(s.note)}</p>
        <span class="sup-more">点击放大 ↗</span>
      </button>`).join('');
    $$('.sup-card', $('#supGrid')).forEach(b => {
      const s = DATA.supplement.find(x => x.id === b.dataset.id);
      if (s) b.addEventListener('pointerenter', () => preloadFull(s), { once: true });
      b.addEventListener('click', () => openSupViewer(b.dataset.id));
    });
  }

  function openSupplement() {
    hideToast();
    state.overlay = 'supplement';
    $('#supplement').hidden = false;
    renderSupplement();
  }
  function closeSupplement() {
    $('#supplement').hidden = true;
    if (state.overlay === 'supplement') state.overlay = null;
  }

  function openSupViewer(id) {
    const s = DATA.supplement.find(x => x.id === id);
    if (!s) return;
    state.sup.item = s;
    state.sup.zoom = 1;
    $('#svTitle').textContent = s.title;
    $('#svSub').textContent = s.subtitle;
    $('#svNote').textContent = s.note;
    const img = $('#supImg');
    const token = ++supLoadToken;
    img.onerror = null;
    img.src = s.src;
    img.dataset.quality = 'thumb';
    img.alt = s.title;
    img.style.width = 'min(1100px, 100%)';
    if (s.full && s.full !== s.src) {
      const pre = new Image();
      pre.decoding = 'async';
      pre.onload = () => {
        if (token !== supLoadToken || state.sup.item !== s) return;
        img.src = s.full;
        img.dataset.quality = 'full';
      };
      pre.onerror = () => { /* 保持本地缩略图 */ };
      pre.src = s.full;
    }
    $('#supViewer').hidden = false;
    $('#supScroll').scrollTop = 0;
  }
  function closeSupViewer() {
    supLoadToken++;
    $('#supViewer').hidden = true;
    state.sup.item = null;
  }
  function supZoom(factor) {
    state.sup.zoom = clamp(state.sup.zoom * factor, 0.6, 3.5);
    const img = $('#supImg');
    const base = Math.min(1100, $('#supScroll').clientWidth - 44);
    img.style.width = `${Math.round(base * state.sup.zoom)}px`;
  }
  function supReset() {
    state.sup.zoom = 1;
    $('#supImg').style.width = 'min(1100px, 100%)';
    $('#supScroll').scrollTop = 0;
    $('#supScroll').scrollLeft = 0;
  }

  /* =========================================================
     指南
     ========================================================= */
  function renderGuide() {
    const g = DATA.guide;
    $('#guideLede').textContent = g.lede;
    $('#guideGrid').innerHTML = g.items.map(it => `<div class="guide-item"><b>${esc(it.title)}</b><p>${esc(it.text)}</p></div>`).join('');
    $('#guideOverview').innerHTML = `<p style="font-size:10.5px;letter-spacing:.2em;color:#8f8470;margin-bottom:10px">展览概况</p>` +
      g.overview.map(p => `<p>${esc(p)}</p>`).join('');
    $('#guideNote').textContent = `${g.supplement} ${g.musicNote}`;
  }
  function openGuide() {
    hideToast();
    state.overlay = 'guide';
    $('#guide').hidden = false;
  }
  function closeGuide() {
    $('#guide').hidden = true;
    if (state.overlay === 'guide') state.overlay = null;
  }

  /* =========================================================
     首页 / 进入
     ========================================================= */
  function startGallery() {
    state.started = true;
    $('#intro').hidden = true;
    $('#gallery').hidden = false;
    $('#loadingMask').classList.add('hide');
  }
  function backHome() {
    closeDetail();
    closeCatalog();
    closeGuide();
    closeTimeline();
    closeNetwork();
    closeSupplement();
    closeSupViewer();
    $('#gallery').hidden = true;
    $('#intro').hidden = false;
    state.started = false;
    state.roomIndex = 0;
    state.overlay = null;
  }

  /* =========================================================
     通用
     ========================================================= */
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').classList.remove('show');
  }
  function anyOverlay() {
    return !$('#threshold').hidden || !$('#detail').hidden || !$('#catalog').hidden ||
      !$('#guide').hidden || !$('#tagWiki').hidden || !$('#artistWiki').hidden ||
      !$('#timeline').hidden || !$('#network').hidden || !$('#supplement').hidden || !$('#supViewer').hidden;
  }

  /* =========================================================
     事件
     ========================================================= */
  function bindEvents() {
    $('#enterBtn').addEventListener('click', () => { startGallery(); enterRoom(0, true, 'start'); });
    $('#introCatalogBtn').addEventListener('click', openCatalog);
    $('#introTimelineBtn').addEventListener('click', openTimeline);
    $('#introNetworkBtn').addEventListener('click', openNetwork);
    $('#introGuideBtn').addEventListener('click', openGuide);
    $('#introSupplementBtn').addEventListener('click', openSupplement);
    $('#introMusicBtn').addEventListener('click', toggleMusic);
    $('#galleryMusicBtn').addEventListener('click', toggleMusic);

    $('#backHomeBtn').addEventListener('click', backHome);
    $('#openCatalogBtn').addEventListener('click', openCatalog);
    $('#openGuideBtn').addEventListener('click', openGuide);
    $('#openTimelineBtn').addEventListener('click', openTimeline);
    $('#openNetworkBtn').addEventListener('click', openNetwork);
    $('#openSupplementBtn').addEventListener('click', openSupplement);

    $('#thresholdEnterBtn').addEventListener('click', skipThreshold);
    $('#threshold').addEventListener('click', e => { if (e.target === $('#threshold')) skipThreshold(); });

    $('#prevBtn').addEventListener('click', () => step(-1));
    $('#nextBtn').addEventListener('click', () => step(1));
    $('#wallViewport').addEventListener('wheel', e => {
      if (anyOverlay()) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setPanTarget(state.targetPan + delta * 1.05);
      $('#panHint').classList.add('hide');
    }, { passive: false });

    const vp = $('#wallViewport');
    vp.addEventListener('pointerdown', e => {
      if (e.button !== 0 || anyOverlay()) return;
      state.dragging = true;
      state.dragMoved = false;
      state.dragStartX = e.clientX;
      state.dragStartPan = state.panX;
      state.dragLastX = e.clientX;
      state.dragLastT = performance.now();
      state.dragVelocity = 0;
      if (state.panRaf) { cancelAnimationFrame(state.panRaf); state.panRaf = 0; }
      vp.classList.add('dragging');
    });
    vp.addEventListener('pointermove', e => {
      if (!state.dragging) return;
      const dx = e.clientX - state.dragStartX;
      if (Math.abs(dx) > 6) {
        state.dragMoved = true;
        $('#panHint').classList.add('hide');
      }
      const now = performance.now();
      const dt = Math.max(1, now - state.dragLastT);
      state.dragVelocity = (e.clientX - state.dragLastX) / dt;
      state.dragLastX = e.clientX;
      state.dragLastT = now;
      applyPanInstant(state.dragStartPan - dx);
    });
    const scheduleDepth = () => {
      if (state.depthRaf) return;
      state.depthRaf = requestAnimationFrame(() => { state.depthRaf = 0; updateDepth(); });
    };
    vp.addEventListener('pointermove', e => {
      if (state.dragging || e.pointerType === 'touch') return;
      state.pointerX = e.clientX;
      scheduleDepth();
    });
    vp.addEventListener('pointerleave', () => { state.pointerX = null; scheduleDepth(); });
    const endDrag = () => {
      if (!state.dragging) return;
      state.dragging = false;
      vp.classList.remove('dragging');
      if (state.dragMoved) {
        const momentum = clamp(-state.dragVelocity * 160, -520, 520);
        if (Math.abs(momentum) > 40) setPanTarget(state.panX + momentum);
      }
    };
    vp.addEventListener('pointerup', endDrag);
    vp.addEventListener('pointercancel', endDrag);
    vp.addEventListener('pointerleave', endDrag);
    vp.addEventListener('click', e => { if (state.dragMoved) { e.preventDefault(); e.stopPropagation(); } }, true);

    $('#detailCloseBtn').addEventListener('click', closeDetail);
    $('#detailPrevBtn').addEventListener('click', () => stepDetail(-1));
    $('#detailNextBtn').addEventListener('click', () => stepDetail(1));
    $('#detailTags').addEventListener('click', e => {
      const chip = e.target.closest('.tag-chip');
      if (chip) openTagWiki(chip.dataset.tag, chip.dataset.kind);
    });
    $('#detailArtist').addEventListener('click', () => {
      if (!state.detail) return;
      const ex = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
      openArtistWiki(ex.artistId);
    });
    $('#awCloseBtn').addEventListener('click', closeArtistWiki);
    $('#twCloseBtn').addEventListener('click', closeTagWiki);
    $('#artistWiki').addEventListener('click', e => { if (e.target === $('#artistWiki')) closeArtistWiki(); });
    $('#tagWiki').addEventListener('click', e => { if (e.target === $('#tagWiki')) closeTagWiki(); });
    $('#zoomInBtn').addEventListener('click', () => zoomViewer(1.25));
    $('#zoomOutBtn').addEventListener('click', () => zoomViewer(0.8));
    $('#zoomResetBtn').addEventListener('click', () => fitViewer('all'));
    $('#viewerOpenBtn').addEventListener('click', downloadWatermarked);
    $('#viewerFullBtn').addEventListener('click', () => setViewerFullscreen(!state.viewer.fullscreen));
    $('#viewerExitBtn').addEventListener('click', () => setViewerFullscreen(false));

    const stage = $('#viewerStage');
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      zoomViewer(e.deltaY < 0 ? 1.16 : 0.86);
    }, { passive: false });
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const v = state.viewer;
      v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (v.pointers.size === 2) {
        const pts = [...v.pointers.values()];
        v.pinch = { dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)), scale: v.scale };
        v.dragging = false;
        stage.classList.remove('dragging');
        return;
      }
      v.dragging = true;
      v.startX = e.clientX; v.startY = e.clientY;
      v.origX = v.x; v.origY = v.y;
      stage.classList.add('dragging');
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    stage.addEventListener('pointermove', e => {
      const v = state.viewer;
      if (v.pointers.has(e.pointerId)) v.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (v.pinch && v.pointers.size >= 2) {
        const pts = [...v.pointers.values()];
        const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        v.scale = clamp(v.pinch.scale * (dist / v.pinch.dist), 1, 10);
        clampViewer(); applyViewer();
        return;
      }
      if (!v.dragging) return;
      v.x = v.origX + (e.clientX - v.startX);
      v.y = v.origY + (e.clientY - v.startY);
      clampViewer(); applyViewer();
    });
    const endViewerPointer = e => {
      const v = state.viewer;
      v.pointers.delete(e.pointerId);
      if (v.pointers.size < 2) v.pinch = null;
      if (v.pointers.size === 1) {
        const p = [...v.pointers.values()][0];
        v.startX = p.x; v.startY = p.y;
        v.origX = v.x; v.origY = v.y;
        v.dragging = true;
      } else if (v.pointers.size === 0) {
        v.dragging = false;
        stage.classList.remove('dragging');
      }
    };
    stage.addEventListener('pointerup', endViewerPointer);
    stage.addEventListener('pointercancel', endViewerPointer);
    stage.addEventListener('pointerleave', endViewerPointer);
    stage.addEventListener('dblclick', () => {
      if (state.viewer.scale > 1.2) fitViewer(initialViewerMode());
      else { zoomViewer(2.6); clampViewer(); applyViewer(); }
    });

    $('#catalogCloseBtn').addEventListener('click', closeCatalog);
    $('#catalogSearch').addEventListener('input', e => {
      state.catalogQuery = e.target.value;
      renderCatalog();
      $('#catalog').scrollTop = 0;
    });
    $('#catalogGrid').addEventListener('click', e => {
      const card = e.target.closest('.cat-card');
      if (!card || card.dataset.opening === '1') return;
      const item = EX_BY_ID.get(card.dataset.id);
      if (!item) return;
      card.dataset.opening = '1';
      card.classList.add('tap-pop');
      setTimeout(() => {
        delete card.dataset.opening;
        openDetail(item.ri, item.ei, 0, 'catalog');
      }, 180);
    });
    $('#catalogGrid').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.cat-card');
      if (!card) return;
      e.preventDefault();
      const item = EX_BY_ID.get(card.dataset.id);
      if (item) openDetail(item.ri, item.ei, 0, 'catalog');
    });
    $('#catalogGrid').addEventListener('pointerover', e => {
      const card = e.target.closest('.cat-card');
      if (!card) return;
      const item = EX_BY_ID.get(card.dataset.id);
      if (item) preloadFull(item.ex.hero);
    });

    $('#timelineCloseBtn').addEventListener('click', closeTimeline);
    $('#tlZoomInBtn').addEventListener('click', () => tlZoom(1.25));
    $('#tlZoomOutBtn').addEventListener('click', () => tlZoom(0.8));
    $('#tlResetBtn').addEventListener('click', () => {
      state.timeline.scale = 1;
      tlBuild();
      $('#tlScroll').scrollLeft = 0;
    });
    const tlScroll = $('#tlScroll');
    tlScroll.addEventListener('wheel', e => {
      e.preventDefault();
      tlZoom(e.deltaY < 0 ? 1.12 : 0.9, e.clientX);
    }, { passive: false });
    tlScroll.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      state.timeline.dragging = true;
      state.timeline.dragX = e.clientX;
      state.timeline.startScroll = tlScroll.scrollLeft;
      tlScroll.classList.add('dragging');
    });
    tlScroll.addEventListener('pointermove', e => {
      if (!state.timeline.dragging) return;
      tlScroll.scrollLeft = state.timeline.startScroll - (e.clientX - state.timeline.dragX);
    });
    const endTlDrag = () => { state.timeline.dragging = false; tlScroll.classList.remove('dragging'); };
    tlScroll.addEventListener('pointerup', endTlDrag);
    tlScroll.addEventListener('pointercancel', endTlDrag);
    tlScroll.addEventListener('pointerleave', endTlDrag);

    $('#networkCloseBtn').addEventListener('click', closeNetwork);
    $('#netResetBtn').addEventListener('click', () => {
      state.network.scale = 1; state.network.tx = 0; state.network.ty = 0;
      netApply();
    });
    $('#netSupplementBtn').addEventListener('click', () => openSupViewer('sup-relation'));
    const netStage = $('#netStage');
    const netSvg = $('#netSvg');
    netSvg.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.net-node')) return;
      state.network.dragging = true;
      state.network.moved = false;
      state.network.startX = e.clientX;
      state.network.startY = e.clientY;
      state.network.origTx = state.network.tx;
      state.network.origTy = state.network.ty;
      netSvg.classList.add('dragging');
    });
    netSvg.addEventListener('pointermove', e => {
      if (!state.network.dragging) return;
      if (Math.abs(e.clientX - state.network.startX) + Math.abs(e.clientY - state.network.startY) > 5) {
        state.network.moved = true;
      }
      state.network.tx = state.network.origTx + (e.clientX - state.network.startX);
      state.network.ty = state.network.origTy + (e.clientY - state.network.startY);
      netApply();
    });
    const endNetDrag = () => { state.network.dragging = false; netSvg.classList.remove('dragging'); };
    netSvg.addEventListener('pointerup', endNetDrag);
    netSvg.addEventListener('pointercancel', endNetDrag);
    netSvg.addEventListener('pointerleave', endNetDrag);
    netSvg.addEventListener('click', e => {
      if (e.target.closest('.net-node')) return;
      if (state.network.moved) return;
      netSelect('');
    });
    netSvg.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = netStage.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const old = state.network.scale;
      const next = clamp(old * (e.deltaY < 0 ? 1.12 : 0.9), 0.6, 3);
      if (Math.abs(next - old) < 0.001) return;
      state.network.tx = mx - (mx - state.network.tx) * (next / old);
      state.network.ty = my - (my - state.network.ty) * (next / old);
      state.network.scale = next;
      netApply();
    }, { passive: false });

    $('#supplementCloseBtn').addEventListener('click', closeSupplement);
    $('#svClose').addEventListener('click', closeSupViewer);
    $('#svZoomIn').addEventListener('click', () => supZoom(1.25));
    $('#svZoomOut').addEventListener('click', () => supZoom(0.8));
    $('#svReset').addEventListener('click', supReset);
    $('#guideCloseBtn').addEventListener('click', closeGuide);
    $('#guide').addEventListener('click', e => { if (e.target === $('#guide')) closeGuide(); });

    window.addEventListener('keydown', e => {
      if (!$('#supViewer').hidden) {
        if (e.key === 'Escape') closeSupViewer();
        return;
      }
      if (!$('#artistWiki').hidden) {
        if (e.key === 'Escape') closeArtistWiki();
        return;
      }
      if (!$('#tagWiki').hidden) {
        if (e.key === 'Escape') closeTagWiki();
        return;
      }
      if (e.key === 'Escape') {
        if (state.overlay === 'detail') {
          if (state.viewer.fullscreen) { setViewerFullscreen(false); return; }
          closeDetail(); return;
        }
        if (state.overlay === 'supplement') { closeSupplement(); return; }
        if (state.overlay === 'timeline') { closeTimeline(); return; }
        if (state.overlay === 'network') { closeNetwork(); return; }
        if (state.overlay === 'catalog') { closeCatalog(); return; }
        if (state.overlay === 'guide') { closeGuide(); return; }
        if (state.overlay === 'threshold') { skipThreshold(); return; }
        return;
      }
      if (state.overlay === 'detail') {
        if (e.key === 'ArrowLeft') { e.preventDefault(); stepDetail(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); stepDetail(1); }
        return;
      }
      if (anyOverlay()) return;
      if (!state.started || $('#gallery').hidden) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'Home') { e.preventDefault(); setPanTarget(0); }
      if (e.key === 'End') { e.preventDefault(); setPanTarget(state.wallMax); }
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.started && !$('#gallery').hidden) {
          const ratio = state.wallMax ? state.panX / state.wallMax : 0;
          renderWall(state.roomIndex);
          requestAnimationFrame(() => { measureWall(); applyPanInstant(ratio * state.wallMax); });
        }
        if (state.overlay === 'detail' && state.detail) {
          const ex = DATA.rooms[state.detail.ri].exhibits[state.detail.ei];
          renderViewer(ex, state.detail.imgIndex);
        }
        if (!$('#timeline').hidden) tlBuild();
      }, 220);
    });
  }

  /* =========================================================
     启动
     ========================================================= */
  function hideLoading() {
    if (loadingDone) return;
    loadingDone = true;
    $('#loadingMask').classList.add('hide');
  }

  function boot() {
    loadVisited();
    loadMusicPref();
    initIntro();
    renderRoutes();
    renderGuide();
    updateProgress();
    updateRoute();
    bindEvents();
    document.addEventListener('pointerdown', e => {
      if (music.on && !music.started && !e.target.closest('.music-btn')) startMusic();
    }, { once: true, capture: true });

    const first = DATA.rooms[0].exhibits.map(ex => ex.hero.src);
    let loaded = 0;
    if (!first.length) hideLoading();
    first.forEach(src => {
      const img = new Image();
      const done = () => { loaded++; if (loaded >= first.length) hideLoading(); };
      img.onload = done;
      img.onerror = done;
      img.src = src;
    });
    setTimeout(hideLoading, 3000);
  }

  boot();
})();
