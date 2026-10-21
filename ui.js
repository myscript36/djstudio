/* DJ Studio 2.0 – touch UI for Android phones and tablets */
var UI = (function () {
  var E = Engine, DK = E.decks;
  var LET = ['A', 'B', 'C', 'D'], COL = ['#00c3ff', '#ff8a00', '#38d838', '#e040fb'];
  var HOTC = ['#28e214', '#e6282c', '#ff8a00', '#ffe014', '#00c3ff', '#7070ff', '#ff4fd8', '#ffffff'];
  var BEATS = [1 / 16, 1 / 8, 0.25, 0.5, 0.75, 1, 2, 4, 8], BEATL = ['1/16', '1/8', '1/4', '1/2', '3/4', '1', '2', '4', '8'];
  var RANGES = [0.06, 0.10, 0.16, 0.5], JUMPS = [1, 2, 4, 8, 16, 32], COLORS = ['filter', 'space', 'dubecho', 'sweep', 'noise', 'crush'];
  var COLOR_PARAM = { filter: 'Rezonancia', space: 'Lecsengés', dubecho: 'Visszacsatolás', sweep: 'Sebesség', noise: 'Zaj színe', crush: 'Bitmélység' };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(s) { if (!(s >= 0)) return '0:00'; s = Math.floor(s); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function toast(t, ms) { var e = $('#toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(function () { e.style.display = 'none'; }, ms || 2300); }
  function buzz() { if (S.vib === '1' && navigator.vibrate) try { navigator.vibrate(10); } catch (e) {} }

  var S = store('settings_m') || {};
  var DEF = { theme: 'rgb', color: 'filter', mt: '1', ag: '1', jog: 'nudge', vib: '1', zoomI: 3, cp: 0.5 };
  Object.keys(DEF).forEach(function (k) { if (S[k] == null) S[k] = DEF[k]; });
  function saveS() { store('settings_m', S); }
  E.setColorType(S.color); E.setColorParam(S.cp);
  DK.forEach(function (D) { D.keyLock = S.mt === '1'; });

  var side = [0, 1], sel = 0, shift = [false, false, false, false], stat = ['', '', '', ''], prog = [0, 0, 0, 0], loading = [false, false, false, false];
  var tabSel = ['hot', 'hot', 'hot', 'hot'];

  /* ---------- control registry ---------- */
  var C = {};
  function reg(id, o) { C[id] = o; }
  function btn(id, press, on, release) { reg(id, { type: 'btn', press: press, release: release, on: on }); }
  function knob(id, min, max, def, get, set) { reg(id, { type: 'knob', min: min, max: max, def: def, get: get, set: set }); }
  DK.forEach(function (D, d) {
    var p = 'd' + d + '.';
    btn(p + 'play', function () { E.resume(); D.toggle(); }, function () { return D.playing || !!D.special; });
    btn(p + 'cue', function () { E.resume(); D.cueDown(); }, function () { return !D.playing && D.buf && Math.abs(D.pos() - D.cue) < 0.02; }, function () { D.cueUp(); });
    btn(p + 'sync', function () {
      if (!D.an) { toast('Előbb tölts be egy számot'); return; }
      D.sync = !D.sync;
      if (D.sync) { if (D.isMaster) { var o = DK.filter(function (x) { return x !== D && x.an && x.playing; })[0]; if (o) E.setMaster(o); } if (!E.masterDeck() || E.masterDeck() === D) toast('Nincs másik deck, amihez igazodhatna'); D.doSync(true); }
      else { D.corr = 0; D.updateRate(); }
    }, function () { return D.sync; });
    btn(p + 'master', function () { if (D.an) E.setMaster(D); }, function () { return D.isMaster; });
    btn(p + 'quant', function () { D.quant = !D.quant; }, function () { return D.quant; });
    for (var h = 0; h < 8; h++) (function (h) { btn(p + 'hot' + h, function () { E.resume(); if (D.buf) D.hotCue(h, shift[d]); }, function () { return D.hot[h] != null; }); })(h);
    btn(p + 'loop', function () { D.autoLoop(); }, function () { return D.loopOn; });
    btn(p + 'loopHalf', function () { D.loopResize(0.5); }); btn(p + 'loopDouble', function () { D.loopResize(2); });
    btn(p + 'loopIn', function () { D.loopIn(); }, function () { return D.loopInPos != null && !D.loopOn; });
    btn(p + 'loopOut', function () { D.loopOut(); }); btn(p + 'reloop', function () { D.reloop(); });
    btn(p + 'jumpB', function () { D.beatJump(-1); }); btn(p + 'jumpF', function () { D.beatJump(1); });
    btn(p + 'jumpSize', function () { D.jumpBeats = JUMPS[(JUMPS.indexOf(D.jumpBeats) + 1) % JUMPS.length]; });
    btn(p + 'bendDown', function () { D.setBend(-0.04); }, null, function () { D.setBend(0); });
    btn(p + 'bendUp', function () { D.setBend(0.04); }, null, function () { D.setBend(0); });
    btn(p + 'range', function () { D.setRange(RANGES[(RANGES.indexOf(D.range) + 1) % RANGES.length]); });
    btn(p + 'pitch0', function () { if (!(D.sync && !D.isMaster)) D.setPitch(0); });
    btn(p + 'mt', function () { D.setKeyLock(!D.keyLock); }, function () { return D.keyLock; });
    btn(p + 'keyDown', function () { D.setKeyShift(D.keyShift - 1); }); btn(p + 'keyUp', function () { D.setKeyShift(D.keyShift + 1); });
    btn(p + 'key0', function () { D.setKeyShift(0); });
    btn(p + 'keySync', function () { if (!D.keySync()) toast('KEY SYNC-hez kell egy másik MASTER deck'); else toast(LET[d] + ' hangnem: ' + D.camelotNow()); });
    btn(p + 'grid', function () { openGrid(d); });
    reg(p + 'pitch', { type: 'sld', min: -1, max: 1, def: 0, get: function () { return D.pitch / D.range; }, set: function (v) { if (D.sync && !D.isMaster) { toast('SYNC bekapcsolva – a tempót a MASTER adja'); return; } D.setPitch(v * D.range); } });
    ['trim', 'hi', 'mid', 'low', 'filter'].forEach(function (k) { knob(p + k, -1, 1, 0, function () { return D.vals[k]; }, function (v) { D.setVal(k, v); }); });
    reg(p + 'fader', { type: 'vsld', min: 0, max: 1, def: 1, get: function () { return D.fader; }, set: function (v) { D.setFader(v); } });
    btn(p + 'xf', function () { D.xfAssign = D.xfAssign === 'A' ? 'THRU' : D.xfAssign === 'THRU' ? 'B' : 'A'; D.applyXf(); });
    btn(p + 'load', function () { selectDeck(d); openSheet('lib'); });
    btn(p + 'empty', function () { selectDeck(d); openSheet('lib'); });
    btn(p + 'swap', function () { swapSide(d); });
    btn(p + 'shift', function () { shift[d] = true; }, null, function () { shift[d] = false; });
    reg(p + 'jog', { type: 'rel', rel: function (v) {
      if (!D.buf) return;
      if (D.playing && S.jog === 'nudge') { D.setBend(clamp(v * 0.006, -0.3, 0.3)); clearTimeout(D.jogT); D.jogT = setTimeout(function () { D.setBend(0); }, 90); }
      else D.seek(D.pos() + v * 0.012);
    } });
  });
  /* ---- Pioneer-style BEAT FX unit (global, channel select A–D / MASTER) ---- */
  var FXS = E.fxState, taps = [];
  btn('fx.type', function () { openFxPick(); });
  btn('fx.on', function () { E.resume(); E.fx({ on: !FXS.on }); }, function () { return FXS.on; });
  btn('fx.prev', function () { E.fx({ paramStep: -1 }); });
  btn('fx.next', function () { E.fx({ paramStep: 1 }); });
  btn('fx.tap', function () {
    var now = performance.now(); if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now); if (taps.length > 8) taps.shift();
    if (taps.length >= 3) { var bpm = 60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)); E.fx({ tap: Math.round(bpm * 10) / 10 }); }
  }, function () { return !!FXS.tap; });
  btn('fx.auto', function () { taps = []; E.fx({ tap: 0 }); }, function () { return !FXS.tap; });
  [0, 1, 2, 3, 4].forEach(function (c) { btn('fx.ch' + c, function () { E.fx({ ch: c }); }, function () { return FXS.ch === c; }); });
  reg('fx.level', { type: 'sld', min: 0, max: 1, def: 0.5, get: function () { return FXS.level; }, set: function (v) { E.fx({ level: v }); } });
  E.fx({});
  reg('xfader', { type: 'sld', min: -1, max: 1, def: 0, get: function () { return E.getXfader(); }, set: function (v) { E.setXfader(v); } });
  var mvol = store('mvol_m'); if (mvol == null) mvol = 0.8; E.setMasterVol(mvol);
  knob('masterVol', 0, 1, 0.8, function () { return mvol; }, function (v) { mvol = v; E.setMasterVol(v); store('mvol_m', v); });
  knob('colorParam', 0, 1, 0.5, function () { return E.getColorParam(); }, function (v) { E.setColorParam(v); S.cp = v; saveS(); });
  btn('colorType', function () { setColor(COLORS[(COLORS.indexOf(S.color) + 1) % COLORS.length]); });
  btn('rec', function () {
    if (E.rec) { E.stopRec(); toast('Felvétel mentve a Letöltések mappába'); return; }
    if (!E.startRec()) toast('A felvétel ezen az eszközön nem támogatott', 3500); else toast('Felvétel indult');
  }, function () { return !!E.rec; });
  btn('lib', function () { openSheet('lib'); });
  btn('settings', function () { openSheet('settings'); });
  btn('help', function () { openSheet('help'); });
  btn('zoomIn', function () { S.zoomI = Math.min(Wave.ZOOMS.length - 1, S.zoomI + 1); saveS(); invalidate(); });
  btn('zoomOut', function () { S.zoomI = Math.max(0, S.zoomI - 1); saveS(); invalidate(); });
  btn('learn', function () { if (window.MIDI) { MIDI.toggleLearn(); closeSheets(); } }, function () { return window.MIDI && MIDI.learning; });
  reg('browse', { type: 'rel', rel: function (v) { browse(v > 0 ? 1 : -1); } });
  btn('browsePush', function () { if (!isOpen('lib')) openSheet('lib'); else loadFocused(sel); });
  function setColor(t) { S.color = t; saveS(); E.setColorType(t); toast('COLOR FX: ' + E.COLOR[t] + ' · PARAM = ' + COLOR_PARAM[t]); syncSettings(); }

  /* ---------- build UI ---------- */
  function deckHTML(d) {
    var p = 'd' + d + '.';
    function b(id, txt, cls) { return '<button class="b ' + (cls || '') + '" data-c="' + p + id + '">' + txt + '</button>'; }
    var h = '<div class="dh"><button class="dl" data-c="' + p + 'swap" style="background:' + COL[d] + '">' + LET[d] + '</button><div class="dt"><div class="tt">Üres deck</div><div class="ta">Koppints a ＋ gombra</div></div>' +
      '<div class="bpmw"><div class="bpm">–</div><div class="sub"><span class="pct">0.0%</span> · <span class="key">–</span></div></div><div class="tm">0:00</div></div>' +
      '<div class="prog"><div></div></div><canvas class="ov"></canvas><button class="empty" data-c="' + p + 'empty">＋ Szám betöltése a(z) ' + LET[d] + ' deckre</button>' +
      '<div class="dbody"><div class="jogw"><canvas class="jog" data-jog="' + d + '"></canvas></div><div class="ctl">' +
      '<div class="row">' + b('cue', 'CUE', 'cue big') + b('play', '▶', 'play big') + '</div>' +
      '<div class="row">' + b('sync', 'SYNC') + b('master', 'MASTER', 'mst') + b('quant', 'Q', 'sm') + b('grid', 'GRID', 'sm') + '</div>' +
      '<div class="tabs"><button class="tab on" data-tab="hot">HOT CUE</button><button class="tab" data-tab="loop">LOOP</button><button class="tab" data-tab="fx">FX</button><button class="tab" data-tab="tempo">TEMPO</button></div>' +
      '<div class="pane on" data-pane="hot"><div class="pads">';
    for (var i = 0; i < 8; i++) h += '<button class="pad" data-c="' + p + 'hot' + i + '">' + (i + 1) + '</button>';
    h += '</div></div>' +
      '<div class="pane" data-pane="loop"><div class="row">' + b('loopHalf', '½', 'sm') + b('loop', 'LOOP 4', 'lp') + b('loopDouble', '2×', 'sm') + b('loopIn', 'IN') + b('loopOut', 'OUT') + '</div>' +
      '<div class="row">' + b('jumpB', '◀◀') + b('jumpSize', '4 ütem') + b('jumpF', '▶▶') + b('reloop', 'EXIT') + '</div>' +
      '<div class="row">' + b('bendDown', '◁ lassít') + b('bendUp', 'gyorsít ▷') + '</div></div>' +
      '<div class="pane fxpane" data-pane="fx"><div class="row"><button class="b fxn" data-c="fx.type">ECHO ▾</button><button class="b fxon" data-c="fx.on">ON</button></div>' +
      '<div class="row"><button class="b sm" data-c="fx.prev">◀</button><button class="b fxbeat" data-c="fx.type" data-fxbeat="1">1/2</button><button class="b sm" data-c="fx.next">▶</button><button class="b" data-c="fx.tap">TAP</button><button class="b fxauto" data-c="fx.auto">AUTO</button></div>' +
      '<div class="row fxch"><span class="lbl">CH</span>' + ['A', 'B', 'C', 'D', 'M'].map(function (l, c) { return '<button class="b" data-c="fx.ch' + c + '">' + (c === 4 ? 'MST' : l) + '</button>'; }).join('') + '</div>' +
      '<div class="row"><span class="lbl">LEVEL</span><div class="sld" data-c="fx.level"><div class="tr"></div><div class="th"></div></div><span class="fxlv">50%</span></div></div>' +
      '<div class="pane" data-pane="tempo"><div class="row"><span class="lbl">TEMPO</span><div class="sld" data-c="' + p + 'pitch"><div class="tr"></div><div class="ctr"></div><div class="th"></div></div></div>' +
      '<div class="row">' + b('range', '±8%') + b('pitch0', '0%') + b('mt', 'MT', 'lp') + b('keySync', 'K-SYNC') + '</div>' +
      '<div class="row">' + b('keyDown', '♭ −') + b('key0', 'KEY 0') + b('keyUp', '♯ +') + '</div></div>' +
      '</div></div>';
    return h;
  }
  function stripHTML(d) {
    var p = 'd' + d + '.';
    function k(id, l) { return '<div class="kw"><div class="knob" data-c="' + p + id + '"><i></i></div><span>' + l + '</span></div>'; }
    return '<div class="sl" style="background:' + COL[d] + '">' + LET[d] + '</div><div class="kcol"><div class="ks">' + k('trim', 'TRIM') + k('hi', 'HI') + k('mid', 'MID') + k('low', 'LOW') + k('filter', 'COLOR') + '</div>' +
      '<div class="vfw"><div class="vsld" data-c="' + p + 'fader"><div class="tr"></div><div class="th"></div></div><div class="mt"><div></div></div></div></div>' +
      '<button class="b" data-c="' + p + 'xf" style="flex:none;width:100%;height:22px;font-size:10px;margin:4px 0 0">X: A</button>';
  }
  var deckEl = [], stripEl = [], R = [];
  DK.forEach(function (D, d) {
    var el = document.createElement('div'); el.className = 'deck isEmpty' + (d % 2 ? ' mirror' : ''); el.innerHTML = deckHTML(d);
    (d % 2 ? $('#slotR') : $('#slotL')).appendChild(el); deckEl.push(el);
    var st = document.createElement('div'); st.className = 'strip'; st.innerHTML = stripHTML(d); $('#strips').appendChild(st); stripEl.push(st);
    R.push({ bpm: $('.bpm', el), pct: $('.pct', el), key: $('.key', el), tm: $('.tm', el), tt: $('.tt', el), ta: $('.ta', el), prog: $('.prog', el), progIn: $('.prog div', el), ov: $('.ov', el), jog: $('.jog', el), mt: $('.mt div', st), ovImg: null, ovSig: '', jogSig: '' });
    el.addEventListener('pointerdown', function () { selectDeck(d); }, true);
    $$('.tab', el).forEach(function (t) { t.addEventListener('pointerdown', function () { tabSel[d] = t.getAttribute('data-tab'); if (tabSel[d] === 'fx' && !FXS.on && FXS.ch !== 4) E.fx({ ch: d }); $$('.tab', el).forEach(function (x) { x.classList.toggle('on', x === t); }); $$('.pane', el).forEach(function (pn) { pn.classList.toggle('on', pn.getAttribute('data-pane') === tabSel[d]); }); buzz(); setTimeout(function () { ctrlEls.forEach(function (o) { o.el._v = undefined; }); }, 0); }); });
    R[d].ov.addEventListener('pointerdown', function (e) { if (!D.buf) return; var r = this.getBoundingClientRect(); D.seek((e.clientX - r.left) / r.width * D.duration()); });
  });
  function swapSide(d) {
    var s = d % 2, cur = side[s], nd = cur === s ? s + 2 : s;
    side[s] = nd; applySides(); selectDeck(nd); toast(LET[nd] + ' deck', 900); buzz();
  }
  function applySides() {
    DK.forEach(function (D, d) { var vis = side.indexOf(d) >= 0; deckEl[d].classList.toggle('hide', !vis); stripEl[d].classList.toggle('hide', !vis); });
    invalidate(); setTimeout(resize, 0);
  }
  function selectDeck(d) {
    sel = d; deckEl.forEach(function (el, i) { el.classList.toggle('sel', i === d); el.style.borderTopColor = i === d ? COL[i] : 'transparent'; });
    if (side.indexOf(d) < 0) { side[d % 2] = d; applySides(); }
    renderLibMarks();
  }

  /* ---------- touch / pointer controls (multi-touch) ---------- */
  var scale = 1;
  function ctlOf(el) { return C[el.getAttribute('data-c')]; }
  var lastTap = {};
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest ? e.target.closest('[data-c]') : null; if (!el) return;
    var c = ctlOf(el); if (!c) return; E.resume();
    var id = el.getAttribute('data-c');
    if (window.MIDI && MIDI.learning) { MIDI.learnTarget(id); e.preventDefault(); return; }
    var now = Date.now(), dbl = lastTap[id] && now - lastTap[id] < 300; lastTap[id] = now;
    if (c.type === 'btn') {
      buzz(); c.press(); el.classList.add('down');
      var lp = null;
      if (/\.hot\d$/.test(id)) { var d = +id.charAt(1), hn = +id.slice(-1); lp = setTimeout(function () { DK[d].hot[hn] = null; if (navigator.vibrate) try { navigator.vibrate([20, 40, 20]); } catch (x) {} toast('Hot cue ' + (hn + 1) + ' törölve', 1200); }, 600); }
      var up = function (ev) { if (ev.pointerId !== e.pointerId) return; clearTimeout(lp); el.classList.remove('down'); if (c.release) c.release(); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
      document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
      e.preventDefault(); return;
    }
    if ((c.type === 'knob' || c.type === 'sld' || c.type === 'vsld') && dbl && c.def != null) { c.set(c.def); buzz(); e.preventDefault(); return; }
    try { el.setPointerCapture(e.pointerId); } catch (x) {}
    if (c.type === 'knob') {
      var y0 = e.clientY, v0 = c.get(); el.classList.add('active');
      var mv = function (ev) { if (ev.pointerId !== e.pointerId) return; c.set(clamp(v0 + (y0 - ev.clientY) / scale / 130 * (c.max - c.min), c.min, c.max)); };
      var up2 = function (ev) { if (ev.pointerId !== e.pointerId) return; el.classList.remove('active'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up2); el.removeEventListener('pointercancel', up2); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up2); el.addEventListener('pointercancel', up2); e.preventDefault(); return;
    }
    if (c.type === 'sld' || c.type === 'vsld') {
      var tr = el.querySelector('.tr').getBoundingClientRect(), vert = c.type === 'vsld';
      // relative drag for tempo (no jump on touch), absolute for faders
      var rel = /\.pitch$/.test(id), sx = e.clientX, sy = e.clientY, sv = c.get();
      var mv2 = function (ev) {
        if (ev.pointerId !== e.pointerId) return;
        var x;
        if (rel) { var dx = (ev.clientX - sx) / tr.width; c.set(clamp(sv + dx * (c.max - c.min) * 0.5, c.min, c.max)); return; }
        x = vert ? 1 - clamp((ev.clientY - tr.top) / tr.height, 0, 1) : clamp((ev.clientX - tr.left) / tr.width, 0, 1);
        c.set(c.min + x * (c.max - c.min));
      };
      mv2(e);
      var up3 = function (ev) { if (ev.pointerId !== e.pointerId) return; el.removeEventListener('pointermove', mv2); el.removeEventListener('pointerup', up3); el.removeEventListener('pointercancel', up3); };
      el.addEventListener('pointermove', mv2); el.addEventListener('pointerup', up3); el.addEventListener('pointercancel', up3); e.preventDefault();
    }
  });
  /* jog wheels */
  $$('.jog').forEach(function (cv) {
    var d = +cv.getAttribute('data-jog'), D = DK[d];
    cv.addEventListener('pointerdown', function (e) {
      if (!D.buf) return; E.resume(); try { cv.setPointerCapture(e.pointerId); } catch (x) {}
      var r = cv.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, a0 = Math.atan2(e.clientY - cy, e.clientX - cx), t0 = performance.now();
      D.jogTouch = true;
      var mv = function (ev) {
        if (ev.pointerId !== e.pointerId) return;
        var a = Math.atan2(ev.clientY - cy, ev.clientX - cx), da = a - a0; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; a0 = a;
        var now = performance.now(), dt = Math.max(8, now - t0); t0 = now;
        if (D.playing && S.jog === 'nudge') { D.setBend(clamp(da / dt * 6, -0.25, 0.25)); clearTimeout(D.jogT); D.jogT = setTimeout(function () { D.setBend(0); }, 70); }
        else D.seek(D.pos() + da / (Math.PI * 2) * 1.8);
      };
      var up = function (ev) { if (ev.pointerId !== e.pointerId) return; D.jogTouch = false; cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); };
      cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up); e.preventDefault();
    });
  });
  /* waveform scrub + double tap zoom */
  var wv = $('#wave'), wx = wv.getContext('2d'), wTap = 0;
  wv.addEventListener('pointerdown', function (e) {
    var r = wv.getBoundingClientRect(), li = (e.clientY - r.top) < r.height / 2 ? 0 : 1, d = side[li], D = DK[d];
    var now = Date.now(); if (now - wTap < 300) { S.zoomI = (S.zoomI + 1) % Wave.ZOOMS.length; saveS(); invalidate(); toast('Nagyítás ' + (S.zoomI + 1) + '/' + Wave.ZOOMS.length, 800); return; } wTap = now;
    if (!D.buf) return; selectDeck(d); try { wv.setPointerCapture(e.pointerId); } catch (x) {}
    var x0 = e.clientX, p0 = D.pos(), was = D.playing, moved = false;
    var mv = function (ev) { if (ev.pointerId !== e.pointerId) return; if (!moved && Math.abs(ev.clientX - x0) > 6) { moved = true; if (was) D.pause(); } if (moved) D.seek(p0 - (ev.clientX - x0) / scale / Wave.ZOOMS[S.zoomI] * D.rate()); };
    var up = function (ev) { if (ev.pointerId !== e.pointerId) return; wv.removeEventListener('pointermove', mv); wv.removeEventListener('pointerup', up); wv.removeEventListener('pointercancel', up); if (moved && was) D.play(); };
    wv.addEventListener('pointermove', mv); wv.addEventListener('pointerup', up); wv.addEventListener('pointercancel', up);
  });

  /* ---------- layout / scaling ---------- */
  var app = $('#app'), RW = 1000, RH = 470, WH = 96, dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    var w = window.innerWidth, h = window.innerHeight, s = w / 1000, rw = 1000, rh = h / s;
    if (rh < 470) { s = h / 470; rh = 470; rw = w / s; }
    scale = s; RW = rw; RH = rh;
    app.style.width = rw + 'px'; app.style.height = rh + 'px'; app.style.transform = 'scale(' + s + ')';
    var k = s * dpr;
    WH = Math.round(96 + Math.max(0, rh - 470) * 0.45); wv.style.height = WH + 'px';
    wv.width = Math.round(rw * k); wv.height = Math.round(WH * k);
    R.forEach(function (r, d) {
      var ow = r.ov.clientWidth || 300; r.ov.width = Math.round(ow * k); r.ov.height = Math.round(22 * k); r.ovSig = ''; r.ovImg = null;
      var jw = deckEl[d].querySelector('.dbody'), bh = jw.clientHeight || 160, bw = deckEl[d].clientWidth || 380, js = Math.max(90, Math.min(bh, bw * 0.44));
      r.jog.style.width = js + 'px'; r.jog.style.height = js + 'px'; r.jog.width = Math.round(js * k); r.jog.height = Math.round(js * k); r.jogSig = '';
    });
    DK.forEach(function (D, d) { if (D.an) prerenderOverview(d); });
    invalidate(); ctrlEls.forEach(function (o) { o.el._v = undefined; });
  }
  window.addEventListener('resize', function () { setTimeout(resize, 60); });

  /* ---------- drawing ---------- */
  var laneSig = [];
  function invalidate() { laneSig = []; R.forEach(function (r) { r.ovSig = ''; r.jogSig = ''; }); }
  function prerenderOverview(d) { var D = DK[d], r = R[d]; r.ovImg = D.an ? Wave.overview(D.an, D.duration(), S.theme, r.ov.width, r.ov.height) : null; r.ovSig = ''; }
  function drawLanes() {
    var k = scale * dpr, z = Wave.ZOOMS[S.zoomI];
    Wave.resetBudget(2);
    wx.setTransform(k, 0, 0, k, 0, 0);
    for (var li = 0; li < 2; li++) {
      var d = side[li], D = DK[d];
      var sig = d + '|' + RW + '|' + WH + '|' + S.theme + '|' + z + '|' + (d === sel) + '|' + stat[d] + '|' + (D.an ? Math.round(D.pos() * z / Math.max(0.05, Math.abs(D.rate())) * 2) + '|' + D.rate().toFixed(4) + '|' + D.cue + '|' + D.hot.join(',') + '|' + (D.loop ? D.loop.s + ':' + D.loop.e + D.loopOn : '') + D.loopInPos + D.isMaster + D.an.bpm + D.an.grid0 : 'e');
      if (laneSig[li] === sig) continue; laneSig[li] = sig;
      Wave.drawLane(wx, D, { W: RW, y: li * WH / 2, h: WH / 2, theme: S.theme, zoom: z, selected: d === sel, label: LET[d], color: COL[d], n: 4, stat: stat[d] || 'üres – koppints a ☰ Zenék gombra' });
    }
    wx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function drawOverview(d) {
    var D = DK[d], r = R[d], c = r.ov, W = c.width, H = c.height, dur = D.duration() || 1, px = Math.round(D.pos() / dur * W);
    var sig = (D.an ? 1 : 0) + '|' + px + '|' + (D.loop ? D.loop.s + D.loopOn : '') + D.hot.join(',') + D.cue + S.theme;
    if (sig === r.ovSig) return; r.ovSig = sig;
    var g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (!D.an || !r.ovImg) return;
    g.drawImage(r.ovImg, 0, 0); g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, px, H);
    if (D.loop) { g.fillStyle = D.loopOn ? 'rgba(60,220,60,.4)' : 'rgba(150,150,150,.3)'; g.fillRect(D.loop.s / dur * W, 0, Math.max(3, (D.loop.e - D.loop.s) / dur * W), H); }
    for (var h = 0; h < 8; h++) if (D.hot[h] != null) { g.fillStyle = HOTC[h]; g.fillRect(D.hot[h] / dur * W, 0, 3, H * 0.4); }
    g.fillStyle = '#ff8a00'; g.fillRect(D.cue / dur * W, H * 0.6, 3, H * 0.4);
    g.fillStyle = '#fff'; g.fillRect(px - 1, 0, 3, H);
  }
  function drawJog(d) {
    var D = DK[d], r = R[d], c = r.jog, S2 = c.width; if (!S2) return;
    var ang = D.an ? (D.pos() * 0.5556 * Math.PI * 2) % (Math.PI * 2) : 0, bi = D.beatInBar(), ph = D.an ? D.phase() : 0;
    var sig = Math.round(ang * 60) + '|' + bi + '|' + Math.round(ph * 20) + '|' + (!!D.jogTouch) + (D.playing ? 1 : 0) + (D.an ? 1 : 0) + (D.loopOn ? 1 : 0);
    if (sig === r.jogSig) return; r.jogSig = sig;
    var g = c.getContext('2d'), m = S2 / 2, Rr = m - 2;
    g.clearRect(0, 0, S2, S2);
    var gr = g.createRadialGradient(m, m * 0.85, Rr * 0.1, m, m, Rr); gr.addColorStop(0, '#30343b'); gr.addColorStop(1, '#14161a');
    g.fillStyle = gr; g.beginPath(); g.arc(m, m, Rr, 0, 7); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1; for (var i = 0.45; i < 0.95; i += 0.06) { g.beginPath(); g.arc(m, m, Rr * i, 0, 7); g.stroke(); }
    g.strokeStyle = D.jogTouch ? '#fff' : COL[d]; g.lineWidth = Rr * 0.07; g.beginPath(); g.arc(m, m, Rr * 0.95, 0, 7); g.stroke();
    if (D.an) { // beat-in-bar segments
      for (var s = 0; s < 4; s++) { g.strokeStyle = s === bi && (D.playing || D.special) ? (s === 0 ? '#ff3b3b' : '#fff') : 'rgba(255,255,255,0.12)'; g.lineWidth = Rr * 0.06; g.beginPath(); g.arc(m, m, Rr * 0.82, -Math.PI / 2 + s * Math.PI / 2 + 0.06, -Math.PI / 2 + (s + 1) * Math.PI / 2 - 0.06); g.stroke(); }
    }
    g.save(); g.translate(m, m); g.rotate(ang);
    g.fillStyle = '#e8e8e8'; g.fillRect(-Rr * 0.025, -Rr * 0.92, Rr * 0.05, Rr * 0.32); g.restore();
    g.fillStyle = D.loopOn ? '#2ecc40' : '#0b0c0f'; g.beginPath(); g.arc(m, m, Rr * 0.3, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold ' + Math.round(Rr * 0.26) + 'px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(LET[d], m, m + 1);
  }
  var ctrlEls = [];
  function collect() { ctrlEls = $$('[data-c]').map(function (el) { return { el: el, c: C[el.getAttribute('data-c')], id: el.getAttribute('data-c') }; }); }
  function setText(el, t) { if (el._tx !== t) { el._tx = t; el.textContent = t; } }
  var frame = 0, avgDt = 16, lastTs = 0, slow = false;
  function refresh(ts) {
    requestAnimationFrame(refresh);
    if (lastTs) avgDt = avgDt * 0.95 + (ts - lastTs) * 0.05; lastTs = ts; frame++;
    slow = avgDt > 26; if (slow && frame % 2) return;
    try { drawLanes(); } catch (e) { if (!refresh.e) { refresh.e = 1; console.error(e); } }
    side.forEach(function (d) { drawJog(d); });
    if (frame % (slow ? 4 : 2)) return;
    var m = E.masterDeck();
    side.forEach(function (d) {
      var D = DK[d], r = R[d];
      drawOverview(d);
      var empty = !D.buf && !loading[d]; if (deckEl[d]._e !== empty) { deckEl[d]._e = empty; deckEl[d].classList.toggle('isEmpty', empty); }
      setText(r.bpm, D.an ? D.bpmNow().toFixed(1) : '–');
      var pc = D.pitch * 100; setText(r.pct, (pc >= 0 ? '+' : '') + pc.toFixed(1) + '%');
      var cam = D.camelotNow(); setText(r.key, D.an ? cam + (D.keyShift ? (D.keyShift > 0 ? ' +' : ' ') + D.keyShift : '') : '–');
      var ref = DK[sel] !== D ? DK[sel] : m, kc = D.an && ref && ref.an && ref !== D ? (E.compat(cam, ref.camelotNow()) ? '#3e3' : '#e66') : '#7fd';
      if (r.key._c !== kc) { r.key._c = kc; r.key.style.color = kc; }
      var rem = D.duration() - D.pos(); setText(r.tm, D.buf ? '-' + fmt(rem) : '0:00');
      var warn = !!(D.buf && D.playing && rem < 30 && frame % 30 < 15); if (r.tm._w !== warn) { r.tm._w = warn; r.tm.classList.toggle('warn', warn); }
      if (loading[d] || stat[d]) setText(r.ta, stat[d] || '');
      var pv = loading[d] ? 'visible' : 'hidden'; if (r.prog._v !== pv) { r.prog._v = pv; r.prog.style.visibility = pv; }
      if (loading[d]) r.progIn.style.width = Math.round(prog[d] * 100) + '%';
      var lv = Math.min(100, Math.round(D.level() * 100)); if (r.mt._l !== lv) { r.mt._l = lv; r.mt.style.height = lv + '%'; r.mt.style.background = lv > 95 ? '#f33' : lv > 70 ? '#ee2' : '#2c2'; }
    });
    var lvT = Math.round(FXS.level * 100) + '%'; $$('.fxlv').forEach(function (e) { setText(e, lvT); });
    var ml = Math.min(100, Math.round(E.masterLevel() * 100)), mm = $('#mMeter div'); if (mm._l !== ml) { mm._l = ml; mm.style.height = ml + '%'; mm.style.background = ml > 95 ? '#f33' : ml > 70 ? '#ee2' : '#2c2'; }
    ctrlEls.forEach(function (o) {
      var c = o.c, el = o.el; if (!c) return;
      var dI = o.id.charAt(0) === 'd' && o.id.charAt(2) === '.' ? +o.id.charAt(1) : -1;
      if (dI >= 0 && side.indexOf(dI) < 0) return;
      if (c.type === 'btn') {
        var on = c.on ? !!c.on() : false; if (el._on !== on) { el._on = on; el.classList.toggle('on', on); }
        var D = dI >= 0 ? DK[dI] : null, k = o.id.slice(3), txt = null;
        if (D) {
          if (k === 'loop') txt = 'LOOP ' + (D.loopBeats < 1 ? '1/' + Math.round(1 / D.loopBeats) : D.loopBeats);
          else if (k === 'range') txt = D.range === 0.5 ? 'WIDE' : '±' + Math.round(D.range * 100) + '%';
          else if (k === 'xf') txt = 'X: ' + D.xfAssign;
          else if (k === 'jumpSize') txt = D.jumpBeats + ' ütem';
          else if (k === 'play') txt = D.playing ? '❚❚' : '▶';
          else if (k.indexOf('hot') === 0) { var hn = +k.slice(3), set = D.hot[hn] != null; if (el._set !== set) { el._set = set; el.classList.toggle('set', set); el.style.background = set ? HOTC[hn] : ''; } }
        } else if (o.id === 'colorType') txt = 'COLOR: ' + E.COLOR[S.color];
        else if (o.id === 'fx.type') { var pv = E.fxParamValue(), ms = E.fxMs(); txt = el.getAttribute('data-fxbeat') ? E.fxLabel(FXS.type, pv) + (ms != null ? ' · ' + ms + ' ms' : '') : E.FX[FXS.type].name + ' ▾'; }
        else if (o.id === 'fx.auto') txt = FXS.tap ? 'AUTO' : E.fxBpm().toFixed(1);
        else if (o.id === 'fx.tap') txt = FXS.tap ? FXS.tap.toFixed(1) : 'TAP';
        else if (o.id === 'fx.on') { var bp = E.fxBeatPos(), blink = FXS.on && bp != null && (bp - Math.floor(bp)) > 0.5; if (el._bl !== blink) { el._bl = blink; el.classList.toggle('blink', blink); } }
        if (txt != null) setText(el, txt);
      } else if (c.type === 'knob') {
        var v = c.get(); if (el._v !== v) { el._v = v; el.firstChild.style.transform = 'rotate(' + ((v - c.min) / (c.max - c.min) * 270 - 135) + 'deg)'; el.classList.toggle('mod', Math.abs(v - c.def) > 0.02); el.classList.toggle('kill', c.min === -1 && v <= -0.99); }
      } else if (c.type === 'sld' || c.type === 'vsld') {
        var v2 = c.get(), x = clamp((v2 - c.min) / (c.max - c.min), 0, 1);
        if (el._v !== v2 && el.clientWidth) { el._v = v2; var th = el.querySelector('.th'); if (c.type === 'vsld') { var hh = el.clientHeight - 20; th.style.top = (10 + (1 - x) * hh) + 'px'; } else { var tw = el.clientWidth - 20; th.style.left = (10 + x * tw) + 'px'; } }
      }
    });
  }

  /* ---------- sheets ---------- */
  function isOpen(id) { return $('#' + id).classList.contains('show'); }
  function closeSheets() { $$('.sheet').forEach(function (s) { s.classList.remove('show'); }); }
  var sheetAt = 0;
  // swallow the "ghost click" that follows the touch which opened a sheet
  var downAt = 0;
  document.addEventListener('pointerdown', function () { downAt = Date.now(); }, true);
  document.addEventListener('click', function (e) { if (downAt <= sheetAt && Date.now() - sheetAt < 1000 && e.target.closest && e.target.closest('.sheet')) { e.stopPropagation(); e.preventDefault(); } }, true);
  function openSheet(id) { closeSheets(); sheetAt = Date.now(); $('#' + id).classList.add('show'); if (id === 'settings') syncSettings(); if (id === 'lib') renderLibMarks(); buzz(); }
  $$('[data-close]').forEach(function (b) { b.addEventListener('click', function () { $('#' + b.getAttribute('data-close')).classList.remove('show'); }); });

  /* FX picker */
  function openFxPick() {
    $('#fxPickT').textContent = 'BEAT FX – ' + (FXS.ch === 4 ? 'MASTER' : LET[FXS.ch] + ' csatorna');
    var html = '';
    [['Pioneer BEAT FX', false], ['Extra', true]].forEach(function (grp) {
      html += '<div class="fxgh">' + grp[0] + '</div>';
      E.FX_ORDER.forEach(function (k) { var f = E.FX[k]; if (!!f.x !== grp[1]) return; html += '<button class="fxc' + (FXS.type === k ? ' on' : '') + '" data-fx="' + k + '"><b>' + f.name + '</b><span>' + esc(f.help) + '</span></button>'; });
    });
    $('#fxGrid').innerHTML = html;
    $$('#fxGrid [data-fx]').forEach(function (b) { b.addEventListener('click', function () { E.fx({ type: b.getAttribute('data-fx') }); closeSheets(); buzz(); toast('BEAT FX: ' + E.FX[b.getAttribute('data-fx')].name, 1200); }); });
    openSheet('fxPick');
  }
  /* ---------- professional beatgrid editor ---------- */
  var G = { d: 0, focus: 0, span: 2, follow: true, metro: false, undo: [], taps: [], drag: null, lastDraw: 0, sig: '' };
  var SPANS = [0.25, 0.5, 1, 2, 4, 8];
  var gc = $('#gCanvas');
  function gD() { return DK[G.d]; }
  function openGrid(d) {
    var D = DK[d]; if (!D.an || !D.buf) { toast('Előbb tölts be egy számot'); return; }
    G.d = d; G.undo = []; G.follow = D.playing; G.focus = D.playing ? D.pos() : D.an.grid0 + D.beatLen() * 0.5;
    if (!D.an.orig) D.an.orig = { bpm: D.an.bpm, grid0: D.an.grid0 };
    $('#gridT').textContent = 'BEATGRID – ' + LET[d] + ': ' + (D.meta ? D.meta.title : '');
    $('#gBpmIn').value = D.an.bpm.toFixed(3);
    openSheet('gridPanel'); setTimeout(function () { sizeGrid(); drawGrid(true); }, 30);
  }
  function sizeGrid() { var r = gc.getBoundingClientRect(), k = Math.min(2, window.devicePixelRatio || 1); gc.width = Math.max(100, Math.round(r.width * k)); gc.height = Math.max(60, Math.round(r.height * k)); G.sig = ''; }
  function pushUndo() { var D = gD(); G.undo.push({ bpm: D.an.bpm, grid0: D.an.grid0 }); if (G.undo.length > 50) G.undo.shift(); }
  function gridChanged() { invalidate(); G.sig = ''; drawGrid(true); }
  function drawGrid(force) {
    if (!isOpen('gridPanel')) return;
    var D = gD(); if (!D.an || !D.buf) return;
    if (G.follow && D.playing) G.focus = D.pos();
    var W = gc.width, H = gc.height, g = gc.getContext('2d'), span = G.span, t0 = G.focus - span / 2, t1 = t0 + span;
    var sig = [W, H, Math.round(t0 * 2000), span, D.an.bpm, D.an.grid0, Math.round(D.pos() * 200), D.cue].join('|');
    if (!force && sig === G.sig) return; G.sig = sig;
    g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
    var buf = D.buf, sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    var spp = span * sr / W, step = Math.max(1, Math.floor(spp / 48)), cy = H * 0.55, A = H * 0.42;
    // sample-accurate min/max waveform
    for (var x = 0; x < W; x++) {
      var a = Math.floor((t0 + x * span / W) * sr), b = Math.floor((t0 + (x + 1) * span / W) * sr), mn = 0, mx = 0;
      if (b <= 0 || a >= L.length) continue;
      a = Math.max(0, a); b = Math.min(L.length, Math.max(b, a + 1));
      for (var i = a; i < b; i += step) { var v = (L[i] + R[i]) * 0.5; if (v < mn) mn = v; if (v > mx) mx = v; }
      g.fillStyle = 'rgba(80,170,255,0.9)'; g.fillRect(x, cy - mx * A, 1, Math.max(1, (mx - mn) * A));
    }
    // transient markers (kick/onset peaks)
    var env = Analysis.onsetEnv(buf, Math.max(0, t0), Math.min(buf.duration, t1)), e = env.e, mxE = 0, j;
    for (j = 0; j < e.length; j++) if (e[j] > mxE) mxE = e[j];
    g.fillStyle = '#2de2ff';
    for (j = 2; j < e.length - 2; j++) {
      if (e[j] > mxE * 0.35 && e[j] >= e[j - 1] && e[j] >= e[j + 1] && e[j] >= e[j - 2] && e[j] >= e[j + 2]) {
        var tx = (env.t0 + j / env.rate - t0) / span * W; g.beginPath(); g.moveTo(tx, H - 2); g.lineTo(tx - 6, H - 12); g.lineTo(tx + 6, H - 12); g.fill(); j += 20;
      }
    }
    // beat grid
    var bl = 60 / D.an.bpm, k0 = Math.ceil((t0 - D.an.grid0) / bl);
    g.font = 'bold ' + Math.round(H * 0.07) + 'px Arial';
    for (var k = k0; D.an.grid0 + k * bl < t1; k++) {
      var gx = (D.an.grid0 + k * bl - t0) / span * W, bar = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = bar ? '#ff3b3b' : 'rgba(255,255,255,0.75)'; g.fillRect(Math.round(gx) - (bar ? 1 : 0), 0, bar ? 3 : 1, H);
      g.fillStyle = bar ? '#ff8a8a' : '#aaa'; g.fillText(bar ? 'Ü' + (Math.floor(k / 4) + 1) : String(((k % 4) + 4) % 4 + 1), gx + 4, H * 0.1);
    }
    // ms scale
    g.fillStyle = 'rgba(255,255,255,0.35)'; var tick = span <= 0.5 ? 0.01 : span <= 2 ? 0.05 : 0.25;
    for (var tt = Math.ceil(t0 / tick) * tick; tt < t1; tt += tick) { var sx = (tt - t0) / span * W; g.fillRect(sx, H - 4, 1, 4); }
    // cue + playhead + focus
    var cx = (D.cue - t0) / span * W; g.fillStyle = '#ff8a00'; g.fillRect(cx - 1, 0, 2, H * 0.15);
    var px = (D.pos() - t0) / span * W; if (px >= 0 && px <= W) { g.fillStyle = 'rgba(255,170,0,0.25)'; g.fillRect(px - 4, 0, 8, H); g.fillStyle = '#ffaa00'; g.fillRect(px - 1, 0, 2, H); }
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(W / 2, H * 0.94, 1, H * 0.06);
    setText($('#gBpm'), D.an.bpm.toFixed(3)); setText($('#gOff'), (D.an.grid0 * 1000).toFixed(1) + ' ms'); setText($('#gPos'), fmt(G.focus) + '.' + ('00' + Math.floor((G.focus % 1) * 1000)).slice(-3));
    $$('#gridPanel [data-g="follow"]').forEach(function (b) { b.classList.toggle('on', G.follow); });
    $$('#gridPanel [data-g="metro"]').forEach(function (b) { b.classList.toggle('on', G.metro); });
  }
  setInterval(function () { if (isOpen('gridPanel') && (gD().playing || G.follow)) drawGrid(false); }, 66);
  // drag on the waveform moves the grid (precise)
  gc.addEventListener('pointerdown', function (e) {
    var D = gD(); if (!D.an) return; try { gc.setPointerCapture(e.pointerId); } catch (x) {}
    pushUndo(); G.drag = { x: e.clientX, g0: D.an.grid0, w: gc.getBoundingClientRect().width };
    var mv = function (ev) { if (ev.pointerId !== e.pointerId || !G.drag) return; var dt = (ev.clientX - G.drag.x) / G.drag.w * G.span; D.an.grid0 = G.drag.g0; D.gridShift(dt); gridChanged(); };
    var up = function (ev) { if (ev.pointerId !== e.pointerId) return; G.drag = null; gc.removeEventListener('pointermove', mv); gc.removeEventListener('pointerup', up); gc.removeEventListener('pointercancel', up); };
    gc.addEventListener('pointermove', mv); gc.addEventListener('pointerup', up); gc.addEventListener('pointercancel', up);
  });
  $$('#gridPanel [data-g]').forEach(function (b) {
    b.addEventListener('click', function () {
      var D = gD(), a = b.getAttribute('data-g'); if (!D.an) return;
      var bl = D.beatLen(), edit = /^(l10|l1|r1|r10|lh|rh|lb|rb|half|dbl|m1|m01|m001|p001|p01|p1|setbpm|tap|auto|downbeat|reanalyze|reset)$/.test(a);
      if (edit && a !== 'tap') pushUndo();
      if (a === 'start') { G.follow = false; G.focus = D.an.grid0 + bl * 0.5; }
      else if (a === 'back') { G.follow = false; G.focus = Math.max(0, G.focus - 16 * bl); }
      else if (a === 'fwd') { G.follow = false; G.focus = Math.min(D.duration(), G.focus + 16 * bl); }
      else if (a === 'here') { G.focus = D.pos(); }
      else if (a === 'follow') { G.follow = !G.follow; }
      else if (a === 'zin') { G.span = SPANS[Math.max(0, SPANS.indexOf(G.span) - 1)]; }
      else if (a === 'zout') { G.span = SPANS[Math.min(SPANS.length - 1, SPANS.indexOf(G.span) + 1)]; }
      else if (a === 'play') { E.resume(); if (!D.playing && !G.follow) D.seek(Math.max(0, G.focus - bl)); D.toggle(); }
      else if (a === 'metro') { G.metro = !G.metro; G.mk = -1; }
      else if (a === 'l10') D.gridShift(-0.010); else if (a === 'r10') D.gridShift(0.010);
      else if (a === 'l1') D.gridShift(-0.001); else if (a === 'r1') D.gridShift(0.001);
      else if (a === 'lh') D.gridShift(-bl / 2); else if (a === 'rh') D.gridShift(bl / 2);
      else if (a === 'lb') D.gridShift(-bl); else if (a === 'rb') D.gridShift(bl);
      else if (a === 'half' || a === 'dbl' || /^[mp]\d/.test(a)) {
        // change tempo around the focus point so the grid stays locked there
        var nb = a === 'half' ? D.an.bpm / 2 : a === 'dbl' ? D.an.bpm * 2 : D.an.bpm + { m1: -0.1, m01: -0.01, m001: -0.001, p001: 0.001, p01: 0.01, p1: 0.1 }[a];
        setBpmAround(D, nb);
      }
      else if (a === 'setbpm') { var v = parseFloat(String($('#gBpmIn').value).replace(',', '.')); if (v > 40 && v < 250) setBpmAround(D, v); else toast('Érvénytelen BPM'); }
      else if (a === 'tap') {
        var now = performance.now(); if (G.taps.length && now - G.taps[G.taps.length - 1] > 2000) G.taps = [];
        G.taps.push(now); if (G.taps.length > 12) G.taps.shift();
        if (G.taps.length >= 4) { pushUndo(); var bpm = 60000 / ((G.taps[G.taps.length - 1] - G.taps[0]) / (G.taps.length - 1)) / D.tempoRate(); setBpmAround(D, Math.round(bpm * 100) / 100); }
        b.textContent = 'TAP ' + G.taps.length;
      }
      else if (a === 'auto') { var off = Analysis.alignLocal(D.buf, D.an.bpm, D.an.grid0, G.focus, 16, 40); D.gridShift(off); toast('AUTO igazítás: ' + (off >= 0 ? '+' : '') + (off * 1000).toFixed(1) + ' ms', 1800); }
      else if (a === 'downbeat') { var bar = bl * 4, nearest = D.an.grid0 + Math.round((G.focus - D.an.grid0) / bl) * bl; D.an.grid0 = nearest - Math.floor(nearest / bar) * bar; }
      else if (a === 'reanalyze') { toast('Pontosítás…', 1200); setTimeout(function () { var r = Analysis.refineGrid(D.buf, D.an); D.an.grid0 = r.grid0; D.setBpm(r.bpm); toast('Pontosítva: ' + r.bpm.toFixed(3) + ' BPM', 2000); gridChanged(); }, 30); }
      else if (a === 'undo') { var u = G.undo.pop(); if (u) { D.an.grid0 = u.grid0; D.setBpm(u.bpm); } else toast('Nincs mit visszavonni'); }
      else if (a === 'reset') { D.an.grid0 = D.an.orig.grid0; D.setBpm(D.an.orig.bpm); }
      $('#gBpmIn').value = D.an.bpm.toFixed(3);
      buzz(); gridChanged();
    });
  });
  function setBpmAround(D, nb) {
    if (!(nb > 30 && nb < 300)) return;
    var bl = D.beatLen(), k = Math.round((G.focus - D.an.grid0) / bl), anchor = D.an.grid0 + k * bl;
    D.setBpm(nb); var nbl = D.beatLen(), bar = nbl * 4; D.an.grid0 = anchor - Math.floor(anchor / bar) * bar;
    if (D.sync) D.doSync(true);
  }
  // metronome: sample-accurate clicks on the grid while the deck plays
  (function () {
    var actx = E.ctx, out = actx.createGain(); out.gain.value = 0.35; out.connect(actx.destination);
    setInterval(function () {
      if (!G.metro || !isOpen('gridPanel')) return;
      var D = gD(); if (!D.playing || !D.an) { G.mk = -1; return; }
      var now = actx.currentTime, pos = D.pos(), r = D.rate(), bl = D.beatLen(), horizon = 0.25;
      var k = Math.ceil((pos - D.an.grid0) / bl - 1e-6);
      for (; ; k++) {
        var tb = D.an.grid0 + k * bl, when = now + (tb - pos) / r; if (when > now + horizon) break;
        if (k <= G.mk || when < now) continue; G.mk = k;
        var o = actx.createOscillator(), env = actx.createGain(), down = ((k % 4) + 4) % 4 === 0;
        o.frequency.value = down ? 1760 : 1175; env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(1, when + 0.001); env.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
        o.connect(env); env.connect(out); o.start(when); o.stop(when + 0.05);
      }
    }, 40);
  })();
  window.addEventListener('resize', function () { if (isOpen('gridPanel')) setTimeout(function () { sizeGrid(); drawGrid(true); }, 80); });
  /* settings */
  function syncSettings() { $$('#settings [data-set]').forEach(function (g) { var k = g.getAttribute('data-set'); $$('[data-v]', g).forEach(function (b) { b.classList.toggle('on', String(S[k]) === b.getAttribute('data-v')); }); }); }
  $$('#settings [data-set] [data-v]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.parentNode.getAttribute('data-set'), v = b.getAttribute('data-v');
      if (k === 'color') { setColor(v); return; }
      S[k] = v; saveS();
      if (k === 'theme') { DK.forEach(function (D, d) { prerenderOverview(d); }); invalidate(); }
      if (k === 'mt') DK.forEach(function (D) { D.setKeyLock(v === '1'); });
      syncSettings(); buzz();
    });
  });
  $('#midiReset').onclick = function () { if (window.MIDI) { MIDI.reset(); toast('MIDI alaphelyzet'); } };
  $('#scDiag').onclick = function () {
    var out = $('#scDiagOut'); out.innerHTML = ''; var rows = {};
    SC.diagnose(function (name, st, msg) {
      var r = rows[name]; if (!r) { r = rows[name] = document.createElement('div'); out.appendChild(r); }
      r.className = 'dg ' + st; r.textContent = (st === 'ok' ? '✓ ' : st === 'hiba' ? '✕ ' : '… ') + name + (msg ? ' – ' + msg : '');
    }).then(function () { var l = SC.log(); if (l.length) { var pre = document.createElement('div'); pre.className = 'dglog'; pre.textContent = l.slice(-8).join('\n'); out.appendChild(pre); } });
  };

  /* ---------- library ---------- */
  var libItems = [], libRaw = [], libNext = null, libLoader = null, sortMode = 0, onlyMatch = false, cache = {}, cacheKeys = [], analyzed = store('analyzed') || {};
  function meta(t) { if (t.local) return { id: t.id, title: t.title, artist: 'Saját zene', dur: 0 }; return { id: 'sc' + t.id, title: t.title, artist: t.user ? t.user.username : '', dur: (t.full_duration || t.duration || 0) / 1000, art: t.artwork_url }; }
  function refCam() { var D = DK[sel]; return D.an ? D.camelotNow() : null; }
  function setTab(t) { $$('#lib [data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); }); }
  function renderLib(items, msg, append) {
    if (items) libRaw = append ? libRaw.concat(items) : items;
    var L = $('#libList'); if (!append) L.innerHTML = '';
    if (msg) { libItems = []; L.innerHTML = '<div class="msg">' + esc(msg) + '</div>'; return; }
    var rc = refCam(), arr = libRaw.slice();
    if (onlyMatch && rc) arr = arr.filter(function (t) { var a = analyzed[meta(t).id]; return a && E.compat(a.camelot, rc); });
    if (sortMode === 1) arr.sort(function (a, b) { var x = analyzed[meta(a).id], y = analyzed[meta(b).id]; return (x ? x.bpm : 999) - (y ? y.bpm : 999); });
    if (sortMode === 2) arr.sort(function (a, b) { var x = analyzed[meta(a).id], y = analyzed[meta(b).id]; return (x ? parseInt(x.camelot, 10) * 2 + (x.camelot.slice(-1) === 'B') : 99) - (y ? parseInt(y.camelot, 10) * 2 + (y.camelot.slice(-1) === 'B') : 99); });
    var start = append && libItems.length && sortMode === 0 && !onlyMatch ? libItems.length : 0; if (!start) L.innerHTML = '';
    libItems = arr;
    if (!arr.length) { L.innerHTML = '<div class="msg">' + (onlyMatch ? 'Nincs illő, már elemzett szám.' : 'Nincs találat.') + '</div>'; return; }
    var frag = document.createDocumentFragment();
    for (var i = start; i < arr.length; i++) (function (t, i) {
      var m = meta(t), a = analyzed[m.id], r = document.createElement('div'); r.className = 'lr'; r.setAttribute('data-i', i);
      var art = m.art ? m.art.replace('-large', '-t67x67') : '';
      r.innerHTML = (art ? '<img loading="lazy" src="' + esc(art) + '">' : '<div class="ph"></div>') + '<span class="c1"><div><span class="dotw"></span>' + esc(m.title) + '</div><div class="a">' + esc(m.artist) + '</div></span>' +
        '<span class="c2">' + (a ? (a.bpm % 1 ? a.bpm.toFixed(1) : a.bpm) : '') + '</span><span class="c3">' + (a ? a.camelot + ' ' + a.key : '') + '</span><span class="c4">' + (m.dur ? fmt(m.dur) : '') + '</span>' +
        LET.map(function (l, d) { return '<button class="ld" data-d="' + d + '" style="color:' + COL[d] + '">' + l + '</button>'; }).join('');
      r.addEventListener('click', function (e) { var b = e.target.closest('.ld'); loadTrack(b ? +b.getAttribute('data-d') : sel, t); });
      frag.appendChild(r);
    })(arr[i], i);
    L.appendChild(frag); renderLibMarks();
  }
  function renderLibMarks() {
    var rc = refCam();
    $$('#libList .lr').forEach(function (r) {
      var t = libItems[+r.getAttribute('data-i')]; if (!t) return;
      var a = analyzed[meta(t).id], ok = rc && a && E.compat(a.camelot, rc);
      r.querySelector('.dotw').innerHTML = ok ? '<span class="dot"></span>' : ''; r.querySelector('.c3').classList.toggle('ok', !!ok);
      r.classList.toggle('loaded', DK.some(function (D) { return D.meta && D.meta.id === meta(t).id; }));
    });
  }
  function startList(loader, label) {
    libLoader = loader; libNext = null; renderLib(null, label || 'Betöltés…');
    loader(null).then(function (r) { if (libLoader !== loader) return; libNext = r.next; renderLib(r.items); }).catch(function (e) { renderLib(null, 'Hiba: ' + e.message + ' – ellenőrizd az internetet.'); });
  }
  var moreBusy = false;
  $('#libList').addEventListener('scroll', function () {
    var L = this; if (moreBusy || !libNext || !libLoader || L.scrollTop + L.clientHeight < L.scrollHeight - 400) return;
    moreBusy = true; var ld = libLoader;
    ld(libNext).then(function (r) { if (libLoader !== ld) return; libNext = r.next; renderLib(r.items, null, true); }).catch(function () {}).then(function () { moreBusy = false; });
  });
  function doSearch() { var q = $('#q').value.trim(); if (!q) return; $('#q').blur(); setTab(''); startList(SC.lister('/search/tracks?q=' + encodeURIComponent(q) + '&limit=50'), 'Keresés: „' + q + '”…'); }
  $('#qGo').onclick = doSearch;
  $('#q').addEventListener('keydown', function (e) { if (e.keyCode === 13) doSearch(); });
  var DEFAULT_PROFILE = 'https://on.soundcloud.com/IksJix2hoZMxvHOaxx';
  function getUser() { var u = store('user'); if (u) return Promise.resolve(u); return SC.resolveProfile(DEFAULT_PROFILE).then(function (us) { var x = { id: us.id, name: us.username, permalink: us.permalink }; store('user', x); return x; }); }
  function showLikes() { setTab('likes'); renderLib(null, 'Kedvelt számok betöltése…'); getUser().then(function (u) { startList(SC.lister('/users/' + u.id + '/track_likes?limit=50', SC.likeTrack), u.name + ' kedvelt számai…'); }).catch(function () { showProfile('Az alapértelmezett profilt nem sikerült megnyitni. Add meg a felhasználóneved.'); }); }
  function showProfile(msg) {
    setTab('profile'); var u = store('user'); libItems = []; libLoader = null;
    $('#libList').innerHTML = '<div class="msg">' + esc(msg || ('Jelenlegi profil: ' + (u ? u.name : 'nincs'))) + '</div><div style="display:flex;padding:0 16px"><input class="txt" id="pIn" placeholder="felhasználónév vagy profil link"><button class="sb pri" id="pSave">Mentés</button></div>';
    var save = function () { var v = $('#pIn').value.trim(); if (!v) return; renderLib(null, 'Profil keresése…'); SC.resolveProfile(v).then(function (us) { store('user', { id: us.id, name: us.username, permalink: us.permalink }); toast('Profil: ' + us.username); showLikes(); }).catch(function (e) { showProfile('Hiba: ' + e.message); }); };
    $('#pSave').onclick = save; $('#pIn').addEventListener('keydown', function (e) { if (e.keyCode === 13) save(); });
  }
  function showAnalyzed() {
    setTab('analyzed'); libLoader = null; libNext = null;
    var arr = Object.keys(analyzed).map(function (k) { return analyzed[k]; }).filter(function (a) { return a.sc; }).sort(function (a, b) { return b.ts - a.ts; });
    if (!arr.length) renderLib(null, 'Még nincs elemzett szám.'); else renderLib(arr.map(function (a) { return a.sc; }));
  }
  $$('#lib [data-tab]').forEach(function (b) { b.addEventListener('click', function () { var t = b.getAttribute('data-tab'); if (t === 'likes') showLikes(); else if (t === 'analyzed') showAnalyzed(); else showProfile(); }); });
  $('#fileBtn').onclick = function () { $('#file').click(); };
  $('#file').addEventListener('change', function () { var f = [].slice.call(this.files || []); if (!f.length) return; setTab(''); libLoader = null; libNext = null; renderLib(f.map(function (x) { return { local: true, file: x, id: 'f:' + x.name + ':' + x.size, title: x.name.replace(/\.[^.]+$/, '') }; })); this.value = ''; });
  $('#sortBtn').onclick = function () { sortMode = (sortMode + 1) % 3; this.textContent = 'Rendezés: ' + ['alap', 'BPM', 'hangnem'][sortMode]; renderLib(); };
  $('#matchBtn').onclick = function () { onlyMatch = !onlyMatch; this.classList.toggle('on', onlyMatch); if (onlyMatch && !refCam()) toast('A kiválasztott decken nincs elemzett szám'); renderLib(); };
  var anaRun = null;
  $('#anaBtn').onclick = function () {
    var btnEl = this;
    if (anaRun) { anaRun.stop = true; anaRun = null; btnEl.textContent = '⚡ Lista elemzése'; return; }
    var q = libRaw.filter(function (t) { return !analyzed[meta(t).id]; }); if (!q.length) { toast('Minden szám elemezve'); return; }
    var run = { stop: false }, i = 0; anaRun = run; toast('Háttérelemzés: ' + q.length + ' szám');
    (function next() {
      if (run.stop) return; if (i >= q.length) { anaRun = null; btnEl.textContent = '⚡ Lista elemzése'; toast('Elemzés kész'); return; }
      var t = q[i++], id = meta(t).id; btnEl.textContent = '■ ' + i + '/' + q.length;
      (t.local ? readFile(t.file) : SC.download(t).then(function (r) { return r.data; })).then(function (ab) { return E.decode(ab); }).then(function (buf) { return Analysis.analyze(buf); })
        .then(function (an) { analyzed[id] = { bpm: an.bpm, key: an.key, camelot: an.camelot, ts: Date.now(), sc: t.local ? null : { id: t.id, title: t.title, artwork_url: t.artwork_url, user: t.user ? { username: t.user.username } : null, full_duration: t.full_duration } }; store('analyzed', analyzed); renderLib(); })
        .catch(function () {}).then(function () { setTimeout(next, 250); });
    })();
  };
  function browse(dir) { if (!isOpen('lib')) openSheet('lib'); var rows = $$('#libList .lr'); if (!rows.length) return; browse.i = clamp((browse.i == null ? -1 : browse.i) + dir, 0, rows.length - 1); rows.forEach(function (r, i) { r.style.outline = i === browse.i ? '2px solid #00c3ff' : ''; }); rows[browse.i].scrollIntoView({ block: 'nearest' }); }
  function loadFocused(d) { var rows = $$('#libList .lr'), r = rows[browse.i || 0]; if (r) loadTrack(d, libItems[+r.getAttribute('data-i')]); }
  function readFile(f) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(new Error('Fájl olvasási hiba')); }; fr.readAsArrayBuffer(f); }); }

  /* ---------- per-track memory ---------- */
  var mem = store('mem') || {}, memSig = ['', '', '', ''];
  function restoreMem(D) { var m = D.meta && mem[D.meta.id]; memSig[D.i] = ''; if (!m) return; if (m.hot) D.hot = m.hot.slice(0, 8); if (m.cue != null) { D.cue = m.cue; D.startPos = m.cue; } if (m.bpm && D.an) { D.an.orig = D.an.orig || { bpm: D.an.bpm, grid0: D.an.grid0 }; D.an.bpm = m.bpm; D.an.grid0 = m.grid0; } }
  setInterval(function () {
    var ch = false;
    DK.forEach(function (D, d) { if (!D.meta || !D.an) return; var sig = JSON.stringify([D.hot, D.cue, D.an.bpm, D.an.grid0]); if (sig !== memSig[d]) { if (memSig[d] !== '' || D.hot.some(function (x) { return x != null; })) { mem[D.meta.id] = { hot: D.hot, cue: D.cue, bpm: D.an.bpm, grid0: D.an.grid0, ts: Date.now() }; ch = true; } memSig[d] = sig; } });
    if (ch) { var ks = Object.keys(mem); if (ks.length > 300) { ks.sort(function (a, b) { return mem[a].ts - mem[b].ts; }); ks.slice(0, ks.length - 300).forEach(function (k) { delete mem[k]; }); } store('mem', mem); }
  }, 2000);

  function cacheSet(id, an) { cache[id] = an; cacheKeys.push(id); if (cacheKeys.length > 8) delete cache[cacheKeys.shift()]; }
  function loadTrack(d, t) {
    if (!t) return; var D = DK[d];
    if (D.playing || D.special) { toast('A(z) ' + LET[d] + ' deck szól – előbb állítsd meg', 3000); return; }
    if (loading[d]) { toast('A(z) ' + LET[d] + ' deck még tölt…'); return; }
    E.resume(); buzz();
    if (side.indexOf(d) < 0) { side[d % 2] = d; applySides(); }
    closeSheets(); selectDeck(d);
    loading[d] = true; prog[d] = 0; var m = meta(t), r = R[d];
    r.tt.textContent = m.title; stat[d] = 'Letöltés…';
    var p = t.local ? readFile(t.file) : SC.download(t, function (f) { prog[d] = f * 0.7; stat[d] = 'Letöltés ' + Math.round(f * 100) + '%'; }).then(function (x) { if (x.snip) toast('Csak 30 mp-es előnézet (Go+ szám)', 4000); return x.data; });
    p.then(function (ab) { stat[d] = 'Dekódolás…'; prog[d] = 0.75; return E.decode(ab); })
      .then(function (buf) {
        var c = cache[m.id]; if (c && Math.abs(c.dur - buf.duration) < 1) return [buf, c];
        stat[d] = 'Elemzés…'; prog[d] = 0.85;
        return new Promise(function (z) { setTimeout(z, 30); }).then(function () { return Analysis.analyze(buf, function (s) { stat[d] = 'Elemzés: ' + s; prog[d] = Math.min(0.98, prog[d] + 0.04); }); })
          .then(function (an) {
            stat[d] = 'Beatgrid pontosítás…';
            return new Promise(function (z) { setTimeout(z, 20); }).then(function () {
              try { var r = Analysis.refineGrid(buf, an); an.bpm = r.bpm; an.grid0 = r.grid0; } catch (e) { }
              an.dur = buf.duration; cacheSet(m.id, an); return [buf, an];
            });
          });
      })
      .then(function (x) {
        var buf = x[0], an = x[1]; if (D.playing) throw new Error('A deck közben elindult');
        m.dur = buf.duration; D.load(buf, m, an); D.keyLock = S.mt === '1'; D.applyShift(); restoreMem(D);
        if (S.ag === '1' && an.loud != null) D.setVal('trim', clamp(-10 - an.loud, -12, 12) / 12);
        prerenderOverview(d); Wave.prewarm(an, S.theme, Wave.ZOOMS[S.zoomI], D.pos()); invalidate();
        analyzed[m.id] = { bpm: an.bpm, key: an.key, camelot: an.camelot, ts: Date.now(), sc: t.local ? null : { id: t.id, title: t.title, artwork_url: t.artwork_url, user: t.user ? { username: t.user.username } : null, full_duration: m.dur * 1000 } };
        store('analyzed', analyzed);
        stat[d] = ''; r.tt.textContent = m.title; r.ta.textContent = m.artist; renderLibMarks();
        if (!E.masterDeck()) E.electMaster();
        toast(LET[d] + ': ' + an.bpm + ' BPM · ' + an.camelot);
      })
      .catch(function (e) { stat[d] = 'Hiba – próbáld újra'; toast('Betöltési hiba: ' + (e && e.message ? e.message : e), 4500); })
      .then(function () { loading[d] = false; prog[d] = 0; });
  }

  /* ---------- Android back button ---------- */
  window.onAndroidBack = function () {
    if (window.MIDI && MIDI.learning) { MIDI.toggleLearn(); return true; }
    var open = $$('.sheet.show'); if (open.length) { closeSheets(); return true; }
    if (DK.some(function (D) { return D.playing; })) { toast('Kilépéshez előbb állítsd le a lejátszást'); return true; }
    return false;
  };
  document.addEventListener('keydown', function (e) { if (e.keyCode === 27) window.onAndroidBack(); if (e.keyCode === 32 && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); C['d' + sel + '.play'].press(); } });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) E.resume(); });

  /* ---------- init ---------- */
  collect(); applySides(); selectDeck(0); resize(); requestAnimationFrame(refresh);
  renderLib(null, 'Keress a SoundCloudon, nyisd meg a kedvelt számaidat (♥), vagy válassz saját zenét (📁).');
  SC.ensureCid().catch(function () {});
  setTimeout(function () { if (!store('seenHelp_m')) { store('seenHelp_m', 1); openSheet('help'); } }, 500);

  return { C: C, toast: toast, shift: shift, sel: function () { return sel; }, loadTrack: loadTrack, midiStatus: function (t, ok) { var s = $('#midiSt'); s.textContent = t; s.style.color = ok ? '#3e3' : ''; } };
})();
