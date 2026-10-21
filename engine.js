/* Audio engine: 4 decks, mixer, EQ, Color FX, Beat FX, master tempo, key shift, sync, loops, cues, recording */
var Engine = (function () {
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx;
  try { ctx = new AC({ sampleRate: 44100, latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
  var SR = ctx.sampleRate;

  function db(x) { return Math.pow(10, x / 20); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  /* ---------- master ---------- */
  var master = ctx.createGain(); master.gain.value = db(-3);
  var limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  var mAn = ctx.createAnalyser(); mAn.fftSize = 1024;
  limiter.connect(mAn); limiter.connect(ctx.destination);
  var recDest = ctx.createMediaStreamDestination ? ctx.createMediaStreamDestination() : null;
  if (recDest) limiter.connect(recDest);

  var xfader = 0, decks = [], colorType = 'filter';

  /* ---------- shared buffers ---------- */
  function impulse(sec, decay, damp) {
    var n = Math.floor(SR * sec), b = ctx.createBuffer(2, n, SR);
    damp = damp == null ? 0.6 : damp;
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c), lp = 0;
      // early reflections
      for (var e = 0; e < 9; e++) { var at = Math.floor(SR * (0.007 + Math.random() * 0.06)); if (at < n) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - e * 0.06); }
      for (var i = 0; i < n; i++) {
        var p = i / n, coef = 0.15 + damp * 0.8 * p; // tail gets darker over time
        lp += (Math.random() * 2 - 1 - lp) * (1 - coef);
        d[i] += lp * Math.pow(1 - p, decay) * (i < SR * 0.012 ? i / (SR * 0.012) : 1);
      }
    }
    return b;
  }
  var IR = impulse(2.8, 2.4), IR_SHORT = impulse(1.6, 2.8);
  var colorParam = 0.5, spaceIR = IR_SHORT, spaceIRp = -1;
  function getSpaceIR() {
    if (Math.abs(spaceIRp - colorParam) > 0.04) { spaceIR = impulse(0.6 + colorParam * 4.2, 2.2 + (1 - colorParam) * 1.5, 0.5); spaceIRp = colorParam; }
    return spaceIR;
  }
  var NOISE = (function () { var n = SR * 2, b = ctx.createBuffer(1, n, SR), d = b.getChannelData(0); for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; return b; })();
  function crushCurve(bits) {
    var n = 4096, c = new Float32Array(n), steps = Math.pow(2, bits);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps / 2) / (steps / 2); }
    return c;
  }
  function driveCurve(k) {
    var n = 2048, c = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
    return c;
  }

  /* ---------- granular pitch shifter (native nodes): used for Master Tempo, key shift, Pitch FX ---------- */
  function Shifter(P) {
    P = P || 0.07;
    var n = Math.round(P * SR), saw = ctx.createBuffer(1, n, SR), fade = ctx.createBuffer(1, n, SR);
    var s = saw.getChannelData(0), f = fade.getChannelData(0);
    for (var i = 0; i < n; i++) { s[i] = i / n; var w = Math.sin(Math.PI * i / n); f[i] = w * w; }
    this.in = ctx.createGain(); this.out = ctx.createGain(); this.P = P; this.base = 0.004; this.taps = []; this.srcs = [];
    var t = ctx.currentTime + 0.03;
    for (var k = 0; k < 2; k++) {
      var d = ctx.createDelay(1), g = ctx.createGain(), ms = ctx.createBufferSource(), mg = ctx.createGain(), fs = ctx.createBufferSource();
      g.gain.value = 0; mg.gain.value = 0; ms.buffer = saw; ms.loop = true; fs.buffer = fade; fs.loop = true;
      ms.connect(mg); mg.connect(d.delayTime); fs.connect(g.gain);
      this.in.connect(d); d.connect(g); g.connect(this.out);
      ms.start(t, k * P / 2); fs.start(t, k * P / 2);
      this.taps.push({ d: d, mg: mg }); this.srcs.push(ms, fs);
    }
    this.f = 1; this.set(1);
  }
  Shifter.prototype.set = function (f) {
    this.f = f;
    var amp = (1 - f) * this.P, t = ctx.currentTime, base = this.base;
    this.taps.forEach(function (tp) { tp.mg.gain.setValueAtTime(amp, t); tp.d.delayTime.setValueAtTime(base + (amp < 0 ? -amp : 0), t); });
  };
  Shifter.prototype.destroy = function () { this.srcs.forEach(function (s) { try { s.stop(); } catch (e) {} }); try { this.in.disconnect(); this.out.disconnect(); } catch (e) {} };

  /* ---------- Pioneer DJM-style BEAT FX ---------- */
  var B16 = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16], B8 = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16], B64 = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64];
  var FX = {
    delay: { name: 'DELAY', p: B8, d: 3 / 4, u: 'b', mix: 'tail', help: 'Egyetlen késleltetett ismétlés, ütemre. LEVEL = effekt aránya.' },
    echo: { name: 'ECHO', p: B8, d: 1 / 2, u: 'b', mix: 'tail', help: 'Lecsengő visszhang ütemre; kikapcsolás után szépen kifut. LEVEL = arány és visszacsatolás.' },
    pingpong: { name: 'PING PONG', p: B16, d: 1 / 2, u: 'b', mix: 'tail', help: 'Bal–jobb oldal között pattogó visszhang. LEVEL = arány.' },
    spiral: { name: 'SPIRAL', p: B8, d: 1 / 2, u: 'b', mix: 'tail', help: 'Sűrű, spirálisan emelkedő visszhang-zengetés. LEVEL = arány és visszacsatolás.' },
    reverb: { name: 'REVERB', p: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], d: 60, u: '%', mix: 'tail', help: 'Zengetés; a ◀ ▶ a terem méretét állítja (1–100%). LEVEL = arány.' },
    trans: { name: 'TRANS', p: B16, d: 1 / 4, u: 'b', mix: 'insert', help: 'Ütemre kapuzza (szaggatja) a hangot. LEVEL = vágás mélysége.' },
    filter: { name: 'FILTER', p: B64, d: 4, u: 'b', mix: 'blend', help: 'Rezonáns szűrő söprés; a ◀ ▶ a ciklus hossza ütemben. LEVEL = mélység.' },
    flanger: { name: 'FLANGER', p: B64, d: 8, u: 'b', mix: 'blend', help: 'Sugárhajtómű-söprés; ciklus ütemben. LEVEL = mélység / visszacsatolás.' },
    phaser: { name: 'PHASER', p: B64, d: 4, u: 'b', mix: 'blend', help: 'Lebegő fázis-söprés; ciklus ütemben. LEVEL = mélység.' },
    pitch: { name: 'PITCH', p: [-50, -25, -12, -6, 6, 12, 25, 50, 100], d: 25, u: 'pct', mix: 'blend', help: 'Hangmagasság-eltolás (−50% … +100%). LEVEL = arány.' },
    sliproll: { name: 'SLIP ROLL', p: B16, d: 1 / 4, u: 'b', mix: 'roll', help: 'Ütemrész ismétlése; ütemváltáskor újra rögzít. A szám a háttérben fut tovább.' },
    roll: { name: 'ROLL', p: B16, d: 1 / 4, u: 'b', mix: 'roll', help: 'A bekapcsoláskor rögzített ütemrészt ismétli. LEVEL = arány.' },
    vinylbrake: { name: 'VINYL BRAKE', p: B16, d: 1, u: 'b', mix: 'action', help: 'Lemezjátszó-fék: a megadott ütemhossz alatt lelassul és megáll.' },
    helix: { name: 'HELIX', p: B16, d: 1 / 2, u: 'b', mix: 'roll', help: 'Rögzíti és ismétli a hangot, minden körben eltolt hangmagassággal. LEVEL = irány és mérték.' },
    backspin: { name: 'BACKSPIN', p: B16, d: 1, u: 'b', mix: 'action', x: 1, help: 'Visszapörgetés, majd megállás (extra).' },
    reverse: { name: 'REVERSE', p: [1], d: 1, u: '', mix: 'action', x: 1, help: 'Visszafelé játszás, kikapcsoláskor ott folytatja, ahol a szám tartana (extra).' },
    bitcrush: { name: 'BITCRUSH', p: [12, 10, 8, 6, 5, 4, 3, 2], d: 6, u: 'bit', mix: 'blend', x: 1, help: 'Lo-fi bitcsökkentés (extra). LEVEL = arány.' },
    distortion: { name: 'DISTORTION', p: [1, 2, 4, 8, 16, 32], d: 8, u: 'x', mix: 'blend', x: 1, help: 'Torzítás, a ◀ ▶ az erősség (extra).' },
    ringmod: { name: 'RING MOD', p: [30, 60, 120, 250, 500, 1000, 2000], d: 250, u: 'Hz', mix: 'blend', x: 1, help: 'Fémes, robotos gyűrűmoduláció (extra).' },
    noise: { name: 'NOISE', p: [200, 500, 1000, 2000, 4000, 8000, 12000], d: 2000, u: 'Hz', mix: 'add', x: 1, help: 'Fehérzaj buildupokhoz; ◀ ▶ = szín (extra). LEVEL = mennyiség.' }
  };
  var FX_ORDER = Object.keys(FX);
  function fmtBeat(v) { if (v >= 1) return String(v); var n = Math.round(1 / v); return Math.abs(1 / n - v) < 1e-6 ? '1/' + n : '3/4'; }
  function fxLabel(type, v) { var u = FX[type].u; return u === 'b' ? fmtBeat(v) : u === '%' ? v + '%' : u === 'pct' ? (v > 0 ? '+' : '') + v + '%' : u === '' ? '–' : v + ' ' + u; }
  var irCache = {};
  function reverbIR(pct) { if (!irCache[pct]) irCache[pct] = impulse(0.35 + pct / 100 * 5.2, 3.2 - pct / 100 * 1.4, 0.55); return irCache[pct]; }

  function FxUnit(o) {
    var g = ctx;
    this.o = o; this.N = []; this.h = {}; this.type = null; this.on = false; this.level = 0.5; this.param = 1;
    this.input = g.createGain(); this.output = g.createGain();
    this.dry = g.createGain(); this.send = g.createGain(); this.send.gain.value = 0; this.wet = g.createGain(); this.wet.gain.value = 0;
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.send); this.wet.connect(this.output);
  }
  var F = FxUnit.prototype;
  F.bpm = function () { var b = this.o.bpm(); return b > 30 ? b : 120; };
  F.beatSec = function () { return 60 / this.bpm(); };
  F.secs = function () { return clamp(this.param * this.beatSec(), 0.004, 28); };
  F.waitFor = function (cycleBeats) { // seconds until the next multiple of cycleBeats on the beat grid
    var bp = this.o.beatPos(); if (bp == null || !this.o.playing()) return 0;
    var r = bp - Math.floor(bp / cycleBeats) * cycleBeats; return ((cycleBeats - r) % cycleBeats) * this.beatSec();
  };
  F.lfo = function (type, cycleBeats) { var o = ctx.createOscillator(); o.type = type; o.frequency.value = 1 / (cycleBeats * this.beatSec()); o.start(ctx.currentTime + 0.003 + this.waitFor(cycleBeats)); this.N.push(o); return o; };
  F.setType = function (type) {
    if (type === this.type) return;
    killNodes(this.N); this.N = []; this.h = {};
    try { this.send.disconnect(); } catch (e) {}
    this.type = type; this.param = FX[type].d;
    var g = ctx, S = this.send, W = this.wet, h = this.h, N = this.N, self = this;
    function bq(t, f, q) { var b = g.createBiquadFilter(); b.type = t; b.frequency.value = f; if (q != null) b.Q.value = q; N.push(b); return b; }
    function gn(v) { var x = g.createGain(); x.gain.value = v; N.push(x); return x; }
    function dl(t, max) { var d = g.createDelay(max || 30); d.delayTime.value = t; N.push(d); return d; }
    var T = this.secs();
    if (type === 'delay' || type === 'echo') {
      var d = dl(T), fb = gn(type === 'echo' ? 0.55 : 0), hp = bq('highpass', 160, 0.5), lp = bq('lowpass', type === 'echo' ? 6500 : 12000, 0.5);
      S.connect(d); d.connect(hp); hp.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(W); h.d = d; h.fb = fb;
    } else if (type === 'pingpong') {
      var l = dl(T), r = dl(T), f1 = gn(0.6), f2 = gn(0.6), pl = g.createStereoPanner(), pr = g.createStereoPanner(), lpp = bq('lowpass', 7000, 0.5); pl.pan.value = -1; pr.pan.value = 1; N.push(pl, pr);
      S.connect(lpp); lpp.connect(l); l.connect(pl); pl.connect(W); l.connect(f1); f1.connect(r); r.connect(pr); pr.connect(W); r.connect(f2); f2.connect(l);
      h.d = l; h.d2 = r; h.fb = f1; h.fb2 = f2;
    } else if (type === 'spiral') {
      var sd = dl(T), sf = gn(0.75), bp = bq('bandpass', 1400, 0.7), sw = this.lfo('sawtooth', 8), swg = gn(2400);
      sw.connect(swg); swg.connect(bp.detune); S.connect(sd); sd.connect(bp); bp.connect(sf); sf.connect(sd); bp.connect(W); h.d = sd; h.fb = sf; h.l = sw; h.lb = 8;
    } else if (type === 'reverb') {
      var cv = g.createConvolver(); cv.buffer = reverbIR(this.param); N.push(cv); var pre = bq('highpass', 220, 0.6), pd = dl(0.012, 1);
      S.connect(pre); pre.connect(pd); pd.connect(cv); cv.connect(W); h.cv = cv;
    } else if (type === 'trans') {
      var vg = gn(0.5), sq = this.lfo('square', this.param), sm = bq('lowpass', 220), dg = gn(0.5);
      sq.connect(sm); sm.connect(dg); dg.connect(vg.gain); S.connect(vg); vg.connect(W); h.l = sq; h.lt = sm; h.lb = this.param; h.vg = vg; h.dg = dg; h.trans = 1;
    } else if (type === 'filter') {
      var fl = bq('lowpass', 900, 7), ls = this.lfo('sine', this.param), lg = gn(0);
      ls.connect(lg); lg.connect(fl.detune); S.connect(fl); fl.connect(W); h.l = ls; h.lt = lg; h.lb = this.param; h.lg = lg; h.lgMax = 3600; h.flt = fl;
    } else if (type === 'flanger') {
      var fd = dl(0.004, 0.05), ll = this.lfo('triangle', this.param), lgg = gn(0.0034), ff = gn(0.6);
      ll.connect(lgg); lgg.connect(fd.delayTime); S.connect(fd); fd.connect(ff); ff.connect(fd); fd.connect(W); S.connect(W); h.l = ll; h.lt = lgg; h.lb = this.param; h.fb = ff;
    } else if (type === 'phaser') {
      var pl2 = this.lfo('sine', this.param), pg = gn(1500), pf = gn(0.5), prev = S, first = null;
      pl2.connect(pg);
      for (var k = 0; k < 6; k++) { var ap = bq('allpass', 500 + k * 180, 0.6); pg.connect(ap.detune); prev.connect(ap); prev = ap; if (!first) first = ap; }
      prev.connect(pf); pf.connect(first); prev.connect(W); S.connect(W); h.l = pl2; h.lt = pg; h.lb = this.param; h.fb = pf;
    } else if (type === 'pitch') {
      var sh = new Shifter(0.06); N.push({ disconnect: function () { sh.destroy(); } }); S.connect(sh.in); sh.out.connect(W); h.sh = sh;
    } else if (type === 'sliproll' || type === 'roll' || type === 'helix') {
      var rin = gn(0), rd = dl(T, 30), rfb = gn(0), lpr = bq('lowpass', type === 'helix' ? 9000 : 20000, 0.5);
      S.connect(rin); rin.connect(rd); rd.connect(lpr); lpr.connect(W);
      if (type === 'helix') { var hs = new Shifter(0.05); N.push({ disconnect: function () { hs.destroy(); } }); lpr.connect(hs.in); hs.out.connect(rfb); h.sh = hs; }
      else lpr.connect(rfb);
      rfb.connect(rd); h.rin = rin; h.d = rd; h.fb = rfb; h.roll = 1;
    } else if (type === 'bitcrush') {
      var ws = g.createWaveShaper(); N.push(ws); var lc = bq('lowpass', 9000, 0.5); S.connect(ws); ws.connect(lc); lc.connect(W); h.ws = ws;
    } else if (type === 'distortion') {
      var wd = g.createWaveShaper(); wd.oversample = '2x'; N.push(wd); var tone = bq('lowpass', 7000, 0.5), mk = gn(0.6); S.connect(wd); wd.connect(tone); tone.connect(mk); mk.connect(W); h.ws = wd; h.mk = mk;
    } else if (type === 'ringmod') {
      var rg = gn(0), ro = g.createOscillator(); ro.frequency.value = this.param; ro.start(); N.push(ro); ro.connect(rg.gain); S.connect(rg); rg.connect(W); h.ro = ro;
    } else if (type === 'noise') {
      var ns = g.createBufferSource(); ns.buffer = NOISE; ns.loop = true; ns.start(); N.push(ns); var nf = bq('highpass', this.param, 1.6), ng = gn(0); ns.connect(nf); nf.connect(ng); ng.connect(W); h.nf = nf; h.ng = ng;
    }
    this.on = false; this.apply(); this.retime();
  };
  F.retime = function () {
    var h = this.h, t = ctx.currentTime, T = this.secs(), bs = this.beatSec();
    if (h.d && !h.roll) h.d.delayTime.setTargetAtTime(this.type === 'spiral' ? Math.max(0.02, T) : T, t, 0.04);
    if (h.d2) h.d2.delayTime.setTargetAtTime(T, t, 0.04);
    if (h.l) h.l.frequency.setTargetAtTime(1 / (h.lb * bs), t, 0.05);
  };
  F.setParam = function (v) {
    var T = this.type; if (!T) return; this.param = v; var h = this.h, t = ctx.currentTime;
    if (h.l && T !== 'spiral') h.lb = v;
    if (T === 'reverb' && h.cv) h.cv.buffer = reverbIR(v);
    if (h.roll && this.on && (T === 'sliproll' || T === 'helix')) this.capture();
    else if (h.roll && this.on) { h.d.delayTime.setValueAtTime(this.secs(), t); }
    this.retime(); this.apply();
  };
  F.setLevel = function (v) { this.level = clamp(v, 0, 1); this.apply(); };
  F.capture = function () {
    var h = this.h, t = ctx.currentTime, L = this.secs(), q = Math.min(L, this.beatSec()), w = this.o.quant() ? this.waitFor(q / this.beatSec()) : 0, t0 = t + w;
    if (w > q * 0.85) { t0 = t; w = 0; } // pressed right on the grid line
    h.d.delayTime.cancelScheduledValues(t); h.d.delayTime.setValueAtTime(this.type === 'helix' ? Math.max(0.01, L - 0.004) : L, t);
    h.rin.gain.cancelScheduledValues(t); h.rin.gain.setValueAtTime(0, t); h.rin.gain.setValueAtTime(1, t0); h.rin.gain.setValueAtTime(0, t0 + L);
    h.fb.gain.cancelScheduledValues(t); h.fb.gain.setValueAtTime(0, t); h.fb.gain.setValueAtTime(this.type === 'helix' ? 0.93 : 1, t0 + L);
    var lv = this.level, mixT = t0 + L;
    this.dry.gain.cancelScheduledValues(t); this.wet.gain.cancelScheduledValues(t);
    this.dry.gain.setValueAtTime(this.dry.gain.value, t); this.wet.gain.setValueAtTime(this.wet.gain.value, t);
    this.dry.gain.setValueAtTime(1, mixT); this.dry.gain.linearRampToValueAtTime(1 - lv, mixT + 0.008);
    this.wet.gain.setValueAtTime(0, mixT); this.wet.gain.linearRampToValueAtTime(lv, mixT + 0.008);
    if (h.sh) h.sh.set(Math.pow(2, (lv - 0.5) * 2 / 12));
  };
  F.apply = function () {
    var T = this.type; if (!T) return;
    var m = FX[T].mix, on = this.on, L = this.level, t = ctx.currentTime, h = this.h, P = this.param;
    function set(p, v) { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, 0.012); }
    if (m === 'roll') {
      set(this.send.gain, 1);
      if (!on) { set(this.dry.gain, 1); set(this.wet.gain, 0); set(h.fb.gain, 0); set(h.rin.gain, 0); }
      else if (h.sh) h.sh.set(Math.pow(2, (L - 0.5) * 2 / 12));
      if (on && this.wet.gain.value > 0.001) { set(this.dry.gain, 1 - L); set(this.wet.gain, L); }
      return;
    }
    if (m === 'tail') {
      set(this.dry.gain, 1); set(this.send.gain, on ? 1 : 0); set(this.wet.gain, L * (T === 'reverb' ? 1.1 : 0.95));
      if (h.fb && T === 'echo') set(h.fb.gain, 0.3 + L * 0.45);
      if (h.fb && T === 'spiral') set(h.fb.gain, 0.55 + L * 0.35);
      if (h.fb && T === 'pingpong') { set(h.fb.gain, 0.35 + L * 0.35); set(h.fb2.gain, 0.35 + L * 0.35); }
      return;
    }
    if (m === 'insert') { // TRANS: full signal through the gate
      set(this.dry.gain, on ? 0 : 1); set(this.send.gain, on ? 1 : 0); set(this.wet.gain, on ? 1 : 0);
      set(h.vg.gain, 1 - L / 2); set(h.dg.gain, L / 2);
      return;
    }
    if (m === 'add') { set(this.dry.gain, 1); set(this.send.gain, 0); set(this.wet.gain, on ? 1 : 0); if (h.ng) set(h.ng.gain, on ? L * 0.35 : 0); if (h.nf) h.nf.frequency.setTargetAtTime(P, t, 0.05); return; }
    if (m === 'blend') {
      var mixw = L, mixd = 1 - L;
      if (T === 'flanger' || T === 'phaser') { mixd = 1 - L * 0.5; mixw = 0.35 + L * 0.35; if (h.fb) set(h.fb.gain, T === 'flanger' ? 0.3 + L * 0.6 : 0.2 + L * 0.6); }
      if (T === 'filter') { set(h.lg.gain, h.lgMax * (0.35 + L * 0.65)); mixd = 0; mixw = 1; }
      if (T === 'pitch' && h.sh) h.sh.set(clamp(1 + P / 100, 0.5, 2));
      if (T === 'bitcrush' && h.ws) h.ws.curve = crushCurve(P);
      if (T === 'distortion' && h.ws) { h.ws.curve = driveCurve(1 + P * 1.5); }
      if (T === 'ringmod' && h.ro) h.ro.frequency.setTargetAtTime(P, t, 0.02);
      set(this.dry.gain, on ? mixd : 1); set(this.send.gain, on ? 1 : 0); set(this.wet.gain, on ? mixw : 0);
      return;
    }
  };
  /* returns the resulting on-state (one-shot FX return false) */
  F.setOn = function (on) {
    var T = this.type; if (!T) return false;
    var m = FX[T].mix;
    if (m === 'action') {
      var len = clamp(this.param * this.beatSec(), 0.08, 12), res = false;
      this.o.decks().forEach(function (D) {
        if (!D.buf) return;
        if (T === 'vinylbrake' && on && D.playing) D.startSpecial('brake', len);
        else if (T === 'backspin' && on && D.playing) D.startSpecial('backspin', clamp(len, 0.3, 3));
        else if (T === 'reverse') { if (on && D.playing) { if (D.startSpecial('reverse', 8)) res = true; } else if (!on && D.special && D.special.kind === 'reverse') D.endSpecial(false); }
      });
      this.on = res; return res;
    }
    if (on === this.on) return on;
    this.on = on;
    if (this.h.roll && on) { this.retime(); this.capture(); return true; }
    if (this.h.l && on && (T === 'trans' || T === 'filter' || T === 'flanger' || T === 'phaser')) {
      // restart the LFO so the cycle starts on the beat grid (Pioneer quantised FX)
      var old = this.h.l, nl = this.lfo(old.type, this.h.lb);
      try { old.disconnect(); old.stop(); } catch (e) {}
      nl.connect(this.h.lt);
      this.h.l = nl;
    }
    this.apply();
    return on;
  };
  var COLOR = { filter: 'FILTER', space: 'SPACE', dubecho: 'DUB ECHO', sweep: 'SWEEP', noise: 'NOISE', crush: 'CRUSH' };

  /* ---------- Deck ---------- */
  function Deck(i) {
    this.i = i; this.buf = null; this.meta = null; this.an = null;
    this.src = null; this.srcGain = null; this.playing = false;
    this.startCtx = 0; this.startPos = 0;
    this.pitch = 0; this.range = 0.08; this.bend = 0; this.corr = 0;
    this.keyLock = false; this.keyShift = 0;
    this.cue = 0; this.hot = [null, null, null, null, null, null, null, null];
    this.loop = null; this.loopOn = false; this.loopBeats = 4; this.loopInPos = null;
    this.sync = false; this.isMaster = false; this.quant = true; this.jumpBeats = 4;
    this.xfAssign = i % 2 === 0 ? 'A' : 'B';
    this.fader = 1;
    this.vals = { trim: 0, hi: 0, mid: 0, low: 0, filter: 0 };
    this.special = null; // brake / backspin / reverse state

    var g = ctx;
    this.input = g.createGain();
    this.shifter = new Shifter();
    this.trim = g.createGain();
    this.lowEq = g.createBiquadFilter(); this.lowEq.type = 'lowshelf'; this.lowEq.frequency.value = 220;
    this.midEq = g.createBiquadFilter(); this.midEq.type = 'peaking'; this.midEq.frequency.value = 1000; this.midEq.Q.value = 0.6;
    this.hiEq = g.createBiquadFilter(); this.hiEq.type = 'highshelf'; this.hiEq.frequency.value = 3200;
    this.lpf = g.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.frequency.value = 22000; this.lpf.Q.value = 0.7;
    this.hpf = g.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 10; this.hpf.Q.value = 0.7;
    this.cDry = g.createGain(); this.cSend = g.createGain(); this.cSend.gain.value = 0; this.cRet = g.createGain();
    this.post = g.createGain();
    this.sum = g.createGain(); this.fade = g.createGain(); this.xf = g.createGain();
    this.meter = g.createAnalyser(); this.meter.fftSize = 512;
    this.byG = g.createGain(); this.shG = g.createGain(); this.shG.gain.value = 0; this.shActive = false;
    this.input.connect(this.byG); this.byG.connect(this.trim);
    this.input.connect(this.shifter.in); this.shifter.out.connect(this.shG); this.shG.connect(this.trim);
    this.trim.connect(this.lowEq); this.lowEq.connect(this.midEq); this.midEq.connect(this.hiEq);
    this.hiEq.connect(this.lpf); this.lpf.connect(this.hpf);
    this.hpf.connect(this.cDry); this.cDry.connect(this.post);
    this.hpf.connect(this.cSend); this.cRet.connect(this.post);
    var self = this;
    this.fxu = new FxUnit({
      bpm: function () { return FXS.tap || self.bpmNow(); }, playing: function () { return self.playing; }, quant: function () { return self.quant; },
      beatPos: function () { return self.an ? (self.pos() - self.an.grid0) / self.beatLen() : null; }, decks: function () { return [self]; }
    });
    this.post.connect(this.fxu.input); this.fxu.output.connect(this.sum);
    this.sum.connect(this.fade); this.fade.connect(this.meter); this.fade.connect(this.xf); this.xf.connect(master);
    this.cNodes = [];
    this.buildColor(); this.applyXf();
  }
  var D = Deck.prototype;

  D.rate = function () { return 1 + this.pitch + this.bend + this.corr; };
  D.tempoRate = function () { return 1 + this.pitch; };
  D.bpmNow = function () { return this.an ? this.an.bpm * this.tempoRate() : 0; };
  D.beatLen = function () { return this.an ? 60 / this.an.bpm : 0.5; };
  D.duration = function () { return this.buf ? this.buf.duration : 0; };

  D.pos = function () {
    var now = ctx.currentTime, sp = this.special;
    if (sp) {
      var dt = Math.max(0, now - sp.t0);
      if (sp.kind === 'brake') { var tt = Math.min(dt, sp.len); return clamp(sp.p0 + sp.r * (tt - tt * tt / (2 * sp.len)), 0, this.duration()); }
      if (sp.kind === 'backspin') { var t2 = Math.min(dt, sp.len); return clamp(sp.p0 - sp.r * (t2 - t2 * t2 / (2 * sp.len)), 0, this.duration()); }
      if (sp.kind === 'reverse') return clamp(sp.p0 - dt * sp.r, 0, this.duration());
    }
    if (!this.playing) return this.startPos;
    var p = this.startPos + (now - this.startCtx) * this.rate();
    if (this.loopOn && this.loop && p > this.loop.e) { var L = this.loop.e - this.loop.s; p = this.loop.s + ((p - this.loop.s) % L); }
    if (p > this.duration()) p = this.duration();
    return p;
  };
  D.anchor = function () { var p = this.pos(); this.startPos = p; this.startCtx = ctx.currentTime; };

  D.load = function (buf, meta, an) {
    this.endSpecial(true); this.stopSrc(); this.playing = false;
    this.buf = buf; this.meta = meta; this.an = an;
    this.startPos = an ? Math.max(0, an.grid0) : 0; this.cue = this.startPos;
    this.hot = [null, null, null, null, null, null, null, null];
    this.loop = null; this.loopOn = false; this.loopInPos = null; this.corr = 0; this.bend = 0; this.keyShift = 0;
    this.applyShift();
    if (this.sync) this.doSync(false);
  };

  D.stopSrc = function () {
    if (!this.src) return;
    var s = this.src, sg = this.srcGain, t = ctx.currentTime;
    s.onended = null;
    try { sg.gain.cancelScheduledValues(t); sg.gain.setValueAtTime(sg.gain.value, t); sg.gain.linearRampToValueAtTime(0, t + 0.012); s.stop(t + 0.015); } catch (e) { try { s.stop(); } catch (e2) {} }
    setTimeout(function () { try { sg.disconnect(); } catch (e) {} }, 100);
    this.src = null; this.srcGain = null;
  };
  D.startSrc = function (at) {
    if (!this.buf) return;
    var s = ctx.createBufferSource(), sg = ctx.createGain(), t = ctx.currentTime;
    s.buffer = this.buf; s.playbackRate.value = this.rate();
    if (this.loopOn && this.loop) { s.loop = true; s.loopStart = this.loop.s; s.loopEnd = this.loop.e; }
    sg.gain.setValueAtTime(0, t); sg.gain.linearRampToValueAtTime(1, t + 0.012);
    s.connect(sg); sg.connect(this.input);
    at = clamp(at, 0, this.buf.duration - 0.01);
    s.start(t, at);
    var self = this;
    s.onended = function () {
      if (self.src === s) { self.playing = false; self.startPos = self.duration(); self.src = null; self.corr = 0; Engine.electMaster(); }
    };
    this.src = s; this.srcGain = sg; this.startPos = at; this.startCtx = t;
  };
  D.play = function () {
    if (this.special) this.endSpecial(true);
    if (!this.buf || this.playing) return;
    if (this.startPos >= this.duration() - 0.05) this.startPos = this.cue;
    this.playing = true; this.startSrc(this.startPos);
    if (this.sync) this.doSync(true);
    Engine.electMaster();
  };
  D.pause = function () {
    if (this.special) { this.endSpecial(true); }
    if (!this.playing) return;
    this.anchor(); this.stopSrc(); this.playing = false; this.corr = 0; this.updateRate(); Engine.electMaster();
  };
  D.toggle = function () { if (this.playing || this.special) this.pause(); else this.play(); };
  D.seek = function (p) {
    if (!this.buf) return;
    p = clamp(p, 0, this.duration() - 0.01);
    if (this.loopOn && this.loop && (p < this.loop.s - 0.001 || p > this.loop.e + 0.001)) { this.loopOn = false; }
    if (this.playing) { this.stopSrc(); this.startSrc(p); } else this.startPos = p;
  };
  D.snap = function (p) {
    if (!this.an || !this.quant) return p;
    var bl = this.beatLen(), g = this.an.grid0;
    return g + Math.round((p - g) / bl) * bl;
  };
  D.phaseShiftTo = function (p) {
    if (!this.quant || !this.an || !this.playing) return p;
    var bl = this.beatLen(), g = this.an.grid0, cur = this.pos();
    var off = ((cur - g) / bl) % 1; if (off < 0) off += 1;
    var base = g + Math.round((p - g) / bl) * bl;
    if (off > 0.5) { off -= 1; }
    return base + off * bl;
  };

  /* CDJ cue */
  D.cueDown = function () {
    if (!this.buf) return;
    if (this.playing) { this.pause(); this.seek(this.cue); this.cueHeld = false; return; }
    var p = this.pos();
    if (Math.abs(p - this.cue) > 0.01) { this.cue = this.snap(p); this.seek(this.cue); this.cueHeld = false; return; }
    this.cueHeld = true; this.play();
  };
  D.cueUp = function () { if (this.cueHeld) { this.cueHeld = false; this.pause(); this.seek(this.cue); } };

  D.hotCue = function (n, del) {
    if (!this.buf) return;
    if (del) { this.hot[n] = null; return; }
    if (this.hot[n] == null) { this.hot[n] = this.snap(this.pos()); return; }
    var target = this.hot[n];
    if (this.playing) this.seek(this.phaseShiftTo(target)); else { this.seek(target); this.play(); }
  };

  /* loops */
  D.setLoop = function (s, e) {
    this.anchor();
    s = Math.max(0, s); e = Math.min(this.duration(), e);
    if (e - s < 0.01) return;
    this.loop = { s: s, e: e }; this.loopOn = true;
    if (this.src) { this.src.loopStart = s; this.src.loopEnd = e; this.src.loop = true; }
    var p = this.pos(); if (p > e || p < s) this.seek(s);
  };
  D.autoLoop = function (beats) {
    if (!this.buf) return;
    if (beats) this.loopBeats = beats;
    if (this.loopOn) { this.exitLoop(); if (!beats) return; }
    var bl = this.beatLen(), p = this.pos(), s;
    if (this.an && this.quant) { var g = this.an.grid0; s = g + Math.floor((p - g) / bl + 0.0001) * bl; } else s = p;
    this.setLoop(s, s + this.loopBeats * bl);
  };
  D.loopIn = function () { if (!this.buf) return; this.loopInPos = this.snap(this.pos()); };
  D.loopOut = function () {
    if (!this.buf) return;
    var s = this.loopInPos != null ? this.loopInPos : this.cue, e = this.snap(this.pos());
    if (e - s < 0.05) return; this.setLoop(s, e); this.loopInPos = null;
  };
  D.exitLoop = function () {
    if (!this.loopOn) return;
    this.anchor(); this.loopOn = false;
    if (this.src) this.src.loop = false;
  };
  D.reloop = function () { if (this.loopOn) this.exitLoop(); else if (this.loop) { var l = this.loop; this.setLoop(l.s, l.e); this.seek(l.s); } };
  D.loopResize = function (f) {
    this.loopBeats = clamp(this.loopBeats * f, 1 / 32, 64);
    if (this.loopOn && this.loop) { var L = (this.loop.e - this.loop.s) * f; if (L < 0.01) return; this.setLoop(this.loop.s, this.loop.s + L); }
  };
  D.beatJump = function (dir) {
    if (!this.buf) return;
    var d = dir * this.jumpBeats * this.beatLen();
    if (this.loopOn && this.loop) { var p = this.pos(); this.setLoop(this.loop.s + d, this.loop.e + d); this.seek(p + d); }
    else this.seek(this.pos() + d);
  };

  /* tempo, master tempo, key */
  D.applyShift = function () {
    var f = Math.pow(2, this.keyShift / 12);
    if (this.keyLock) f /= this.tempoRate();
    var need = Math.abs(f - 1) > 0.0004;
    if (need && Math.abs(f - this.shifter.f) > 1e-5) this.shifter.set(f);
    if (need !== this.shActive) {
      // bypass the granular shifter when it is not needed (saves CPU, cleanest sound)
      this.shActive = need; var t = ctx.currentTime;
      this.byG.gain.setTargetAtTime(need ? 0 : 1, t, 0.008); this.shG.gain.setTargetAtTime(need ? 1 : 0, t, 0.008);
    }
  };
  /* beatgrid editing */
  D.gridShift = function (sec) { if (!this.an) return; this.an.grid0 += sec; var bar = this.beatLen() * 4; while (this.an.grid0 - bar > -0.001) this.an.grid0 -= bar; while (this.an.grid0 < -0.001) this.an.grid0 += bar; };
  D.setBpm = function (b) { if (!this.an || !(b > 30 && b < 300)) return; this.an.bpm = Math.round(b * 1000) / 1000; Engine.fxRetime(); if (this.isMaster) Engine.followMaster(); else if (this.sync) this.doSync(true); };
  D.gridHere = function () { if (!this.an) return; var p = this.pos(), bar = this.beatLen() * 4; this.an.grid0 = p - Math.floor(p / bar) * bar; };
  D.updateRate = function () {
    this.anchor();
    if (this.src) this.src.playbackRate.setValueAtTime(this.rate(), ctx.currentTime);
    this.applyShift();
  };
  D.setPitch = function (p) { this.pitch = clamp(p, -this.range, this.range); this.updateRate(); if (this.isMaster) Engine.followMaster(); };
  D.setRange = function (r) { this.range = r; this.setPitch(this.pitch); };
  D.setBend = function (b) { this.bend = b; this.updateRate(); };
  D.setKeyLock = function (on) { this.keyLock = on; this.applyShift(); };
  D.setKeyShift = function (st) { this.keyShift = clamp(Math.round(st), -12, 12); this.applyShift(); };
  D.camelotNow = function () {
    if (!this.an) return null;
    var semis = this.keyShift + (this.keyLock ? 0 : Math.round(12 * Math.log(this.tempoRate()) / Math.LN2));
    return Engine.shiftCamelot(this.an.camelot, semis);
  };
  D.keySync = function () {
    var m = Engine.masterDeck(); if (!m || m === this || !m.an || !this.an) return false;
    var target = m.camelotNow(), best = 0, bd = 99;
    for (var s = -6; s <= 6; s++) {
      var c = Engine.shiftCamelot(this.an.camelot, s + (this.keyLock ? 0 : Math.round(12 * Math.log(this.tempoRate()) / Math.LN2)));
      if (Engine.compat(c, target)) { if (Math.abs(s) < bd) { bd = Math.abs(s); best = s; } }
    }
    this.setKeyShift(best); return true;
  };
  D.doSync = function (phase) {
    var m = Engine.masterDeck();
    if (!m || m === this || !m.an || !this.an) return;
    var target = m.bpmNow(), ratio = target / this.an.bpm;
    // half/double tempo matching
    if (ratio > 1.45) ratio /= 2; else if (ratio < 0.69) ratio *= 2;
    this.pitch = clamp(ratio - 1, -0.5, 0.5);
    if (Math.abs(this.pitch) > this.range) this.range = Math.abs(this.pitch) > 0.16 ? 0.5 : 0.16;
    this.updateRate();
    if (phase !== false && this.playing && m.playing) this.alignPhase(m);
  };
  D.phase = function () { if (!this.an) return 0; var x = (this.pos() - this.an.grid0) / this.beatLen(); return x - Math.floor(x); };
  D.beatInBar = function () { if (!this.an) return -1; var x = Math.floor((this.pos() - this.an.grid0) / this.beatLen() + 0.0001); return ((x % 4) + 4) % 4; };
  D.phaseDelta = function (m) { var d = m.phase() - this.phase(); if (d > 0.5) d -= 1; if (d < -0.5) d += 1; return d; };
  D.alignPhase = function (m) { var d = this.phaseDelta(m); if (Math.abs(d) > 0.004) this.seek(this.pos() + d * this.beatLen()); };

  /* mixer */
  D.setVal = function (k, v) {
    this.vals[k] = v; var t = ctx.currentTime;
    function eq(x) { return x <= -0.99 ? -40 : x < 0 ? x * 26 : x * 6; }
    if (k === 'trim') this.trim.gain.setTargetAtTime(db(v * 12), t, 0.01);
    if (k === 'hi') this.hiEq.gain.setTargetAtTime(eq(v), t, 0.01);
    if (k === 'mid') this.midEq.gain.setTargetAtTime(eq(v), t, 0.01);
    if (k === 'low') this.lowEq.gain.setTargetAtTime(eq(v), t, 0.01);
    if (k === 'filter') this.applyColor();
  };
  D.setFader = function (v) { this.fader = v; this.fade.gain.setTargetAtTime(v * v, ctx.currentTime, 0.01); };
  D.applyXf = function () {
    var x = (xfader + 1) / 2, gA = Math.min(1, Math.cos(x * Math.PI / 2) * 1.41), gB = Math.min(1, Math.sin(x * Math.PI / 2) * 1.41);
    var g = this.xfAssign === 'A' ? gA : this.xfAssign === 'B' ? gB : 1;
    this.xf.gain.setTargetAtTime(g, ctx.currentTime, 0.005);
  };
  D.level = function () {
    var a = this.levelArr || (this.levelArr = new Float32Array(this.meter.fftSize));
    this.meter.getFloatTimeDomainData(a); var m = 0; for (var i = 0; i < a.length; i++) { var v = Math.abs(a[i]); if (v > m) m = v; } return m;
  };

  /* ---------- Color FX (per channel, DJM-style) ---------- */
  function killNodes(arr) { arr.forEach(function (n) { try { if (n.stop) n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} }); }
  D.buildColor = function () {
    killNodes(this.cNodes); this.cNodes = [];
    try { this.cSend.disconnect(); } catch (e) {}
    var T = colorType, g = ctx, n = [];
    this.cFilt = g.createBiquadFilter(); this.cFilt.Q.value = 1.2; n.push(this.cFilt);
    this.cDelay = null; this.cFb = null; this.cWs = null; this.cLfo = null; this.cConv = null;
    if (T === 'space') { var cv = g.createConvolver(); cv.buffer = getSpaceIR(); this.cSend.connect(cv); cv.connect(this.cFilt); this.cConv = cv; n.push(cv); }
    else if (T === 'dubecho') { var dl = g.createDelay(2), fb = g.createGain(), lp = g.createBiquadFilter(), hp0 = g.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; hp0.type = 'highpass'; hp0.frequency.value = 150; fb.gain.value = 0.62; this.cSend.connect(dl); dl.connect(lp); lp.connect(hp0); hp0.connect(fb); fb.connect(dl); hp0.connect(this.cFilt); this.cDelay = dl; this.cFb = fb; n.push(dl, fb, lp, hp0); }
    else if (T === 'noise') { var ns = g.createBufferSource(); ns.buffer = NOISE; ns.loop = true; ns.start(); ns.connect(this.cSend); this.cSend.connect(this.cFilt); n.push(ns); }
    else if (T === 'crush') { var ws = g.createWaveShaper(); ws.curve = crushCurve(4); this.cSend.connect(ws); ws.connect(this.cFilt); this.cWs = ws; n.push(ws); }
    else if (T === 'sweep') { var gt = g.createGain(), lfo = g.createOscillator(), sm = g.createBiquadFilter(), lg = g.createGain(); lfo.type = 'square'; lfo.frequency.value = 4; sm.type = 'lowpass'; sm.frequency.value = 150; lg.gain.value = 0.5; gt.gain.value = 0.5; lfo.connect(sm); sm.connect(lg); lg.connect(gt.gain); this.startAligned(lfo, 0.25); this.cSend.connect(gt); gt.connect(this.cFilt); this.cLfo = lfo; n.push(gt, lfo, sm, lg); }
    this.cFilt.connect(this.cRet);
    this.cNodes = n; this.applyColor();
  };
  D.applyColor = function () {
    var v = this.vals.filter, a = Math.abs(v), t = ctx.currentTime, T = colorType;
    var on = a > 0.03, lp = 22000, hp = 10, q = 0.7, P = colorParam, bpm = Math.max(60, this.bpmNow() || 120);
    if (T === 'filter' || T === 'sweep') {
      lp = v < -0.03 ? 20000 * Math.pow(60 / 20000, a - 0.03) : 22000;
      hp = v > 0.03 ? 10 * Math.pow(9000 / 10, a - 0.03) : 10; q = on ? (T === 'filter' ? 0.7 + P * P * 9 : 1.5) : 0.7;
    }
    if (T === 'sweep') {
      this.cDry.gain.setTargetAtTime(on ? 1 - a * 0.9 : 1, t, 0.01); this.cSend.gain.setTargetAtTime(on ? a : 0, t, 0.01);
      this.cFilt.type = 'allpass';
      var beats = [1 / 8, 1 / 4, 1 / 2, 1][Math.min(3, Math.floor(P * 4))];
      if (this.cLfo) this.cLfo.frequency.setTargetAtTime(bpm / 60 / beats, t, 0.05);
    } else if (T !== 'filter') {
      // send effects: filter applies only to the effect return; dry stays clean (crush blends)
      this.cFilt.type = v < 0 ? 'lowpass' : 'highpass';
      this.cFilt.frequency.setTargetAtTime(v < 0 ? 18000 * Math.pow(250 / 18000, a) : 20 * Math.pow(6000 / 20, a), t, 0.02);
      var send = T === 'noise' ? a * 0.22 : T === 'crush' ? a : a * 1.1;
      this.cSend.gain.setTargetAtTime(on ? send : 0, t, 0.02);
      this.cDry.gain.setTargetAtTime(T === 'crush' && on ? 1 - a : 1, t, 0.02);
      if (T === 'noise') this.cFilt.Q.value = 0.5 + P * 9;
      else this.cFilt.Q.value = 1.2;
      if (T === 'crush' && this.cWs) {
        var bits = Math.max(2, Math.round(12 - a * (3 + P * 7)));
        if (bits !== this.cBits) { this.cBits = bits; this.cWs.curve = crushCurve(bits); }
        if (v > 0) { this.cFilt.type = 'lowpass'; this.cFilt.frequency.setTargetAtTime(16000 - a * P * 12000, t, 0.02); }
      }
      if (T === 'dubecho' && this.cDelay) { this.cDelay.delayTime.setTargetAtTime(clamp(0.75 * 60 / bpm, 0.05, 1.9), t, 0.05); this.cFb.gain.setTargetAtTime(0.3 + P * 0.6, t, 0.05); }
      if (T === 'space' && this.cConv && Math.abs(spaceIRp - P) > 0.04) this.cConv.buffer = getSpaceIR();
    } else { this.cDry.gain.setTargetAtTime(1, t, 0.01); this.cSend.gain.setTargetAtTime(0, t, 0.01); }
    this.lpf.frequency.setTargetAtTime(Math.max(60, lp), t, 0.02);
    this.hpf.frequency.setTargetAtTime(Math.min(9000, hp), t, 0.02);
    this.lpf.Q.value = q; this.hpf.Q.value = q;
  };

  /* ---------- Beat FX ---------- */
  D.startAligned = function (osc, beatsPerCycle) {
    // start an LFO so its cycle begins on the beat grid
    var t = ctx.currentTime + 0.01;
    if (this.an && this.playing) {
      var bl = this.beatLen() / this.rate(), cyc = bl * beatsPerCycle, ph = this.phase() * bl;
      var wait = (cyc - (ph % cyc)) % cyc; osc.start(t + wait);
    } else osc.start(t);
  };
  D.startSpecial = function (kind, len) {
    var p0 = this.pos(), r = this.rate(), t = ctx.currentTime, self = this;
    var sp = { kind: kind, p0: p0, t0: t, r: r, len: len, wasPlaying: this.playing };
    if (kind === 'brake') {
      if (this.src) { this.src.playbackRate.cancelScheduledValues(t); this.src.playbackRate.setValueAtTime(r, t); this.src.playbackRate.linearRampToValueAtTime(0.0001, t + len); }
      this.special = sp; sp.timer = setTimeout(function () { self.endSpecial(true); }, len * 1000);
      return true;
    }
    // reversed audio chunk
    var back = kind === 'backspin' ? Math.min(p0, r * len / 2 + 0.2) : Math.min(p0, len * r + 0.1);
    if (back < 0.1) return false;
    var n = Math.floor(back * SR), ch = this.buf.numberOfChannels, rb = ctx.createBuffer(ch, n, SR), e = Math.floor(p0 * this.buf.sampleRate);
    for (var c = 0; c < ch; c++) { var src = this.buf.getChannelData(c), dst = rb.getChannelData(c); for (var i = 0; i < n; i++) dst[i] = src[Math.max(0, e - 1 - i)] || 0; }
    var s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = rb; s.connect(g); g.connect(this.input);
    if (kind === 'backspin') { s.playbackRate.setValueAtTime(r * 2.6, t); s.playbackRate.linearRampToValueAtTime(0.01, t + len); sp.r = r * 2.6; }
    else s.playbackRate.value = r;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.01);
    this.stopSrc(); this.playing = false;
    s.start(t); sp.src = s; sp.g = g;
    this.special = sp;
    if (kind === 'backspin') sp.timer = setTimeout(function () { self.endSpecial(true); }, len * 1000);
    else sp.timer = setTimeout(function () { if (self.special === sp) { self.endSpecial(false); Engine.fxSpecialEnded(self); } }, (back / r) * 1000);
    return true;
  };
  D.endSpecial = function (stopAfter) {
    var sp = this.special; if (!sp) return;
    clearTimeout(sp.timer);
    var t = ctx.currentTime;
    if (sp.src) { try { sp.g.gain.setValueAtTime(sp.g.gain.value, t); sp.g.gain.linearRampToValueAtTime(0, t + 0.01); sp.src.stop(t + 0.02); } catch (e) {} }
    if (sp.kind === 'brake') {
      var p = this.pos(); this.special = null;
      this.stopSrc(); this.playing = false; this.startPos = p; this.fxOn = false; return;
    }
    if (sp.kind === 'backspin') { var pb = this.pos(); this.special = null; this.playing = false; this.startPos = pb; this.fxOn = false; return; }
    // reverse: slip back to where the track would be
    var target = sp.p0 + (t - sp.t0) * sp.r;
    this.special = null;
    if (stopAfter) { this.playing = false; this.startPos = clamp(target, 0, this.duration() - 0.01); return; }
    this.playing = true; this.startSrc(clamp(target, 0, this.duration() - 0.01));
  };

  var FXS = { ch: 0, type: 'echo', level: 0.5, params: {}, on: false, tap: 0 };
  for (var i = 0; i < 4; i++) decks.push(new Deck(i));
  var masterFx = new FxUnit({
    bpm: function () { var m = Engine.masterDeck(); return FXS.tap || (m ? m.bpmNow() : 120); },
    playing: function () { var m = Engine.masterDeck(); return !!(m && m.playing); },
    quant: function () { return true; },
    beatPos: function () { var m = Engine.masterDeck(); return m && m.an ? (m.pos() - m.an.grid0) / m.beatLen() : null; },
    decks: function () { return decks.filter(function (d) { return d.playing || d.special; }); }
  });
  master.connect(masterFx.input); masterFx.output.connect(limiter);
  function fxUnit(ch) { return ch === 4 ? masterFx : decks[ch].fxu; }
  function fxParam(t) { return FXS.params[t] != null ? FXS.params[t] : FX[t].d; }
  function fxConfigure(u) { u.setType(FXS.type); u.setParam(fxParam(FXS.type)); u.setLevel(FXS.level); }

  /* ---------- camelot helpers ---------- */
  function shiftCamelot(c, semis) {
    if (!c) return c; var n = parseInt(c, 10), l = c.slice(-1);
    var s = ((semis % 12) + 12) % 12; n = ((n - 1 + s * 7) % 12) + 1; return n + l;
  }
  function compat(c1, c2) {
    if (!c1 || !c2) return false;
    var n1 = parseInt(c1, 10), n2 = parseInt(c2, 10), l1 = c1.slice(-1), l2 = c2.slice(-1);
    if (n1 === n2) return true;
    return l1 === l2 && ((n1 % 12) + 1 === n2 || (n2 % 12) + 1 === n1);
  }

  /* ---------- master / sync ---------- */
  var explicitMaster = null;
  var Engine = {
    ctx: ctx, decks: decks, FX: FX, FX_ORDER: FX_ORDER, COLOR: COLOR, fxState: FXS, fxLabel: fxLabel, fmtBeat: fmtBeat,
    /* Beat FX unit control (Pioneer DJM style): {ch, type, level, param, paramStep, on, tap} */
    fx: function (o) {
      var u = fxUnit(FXS.ch);
      if (o.ch != null && o.ch !== FXS.ch) { var was = FXS.on; if (was) u.setOn(false); FXS.ch = o.ch; FXS.on = false; u = fxUnit(FXS.ch); fxConfigure(u); if (was && FX[FXS.type].mix !== 'action') FXS.on = u.setOn(true); }
      if (o.type && o.type !== FXS.type) { var w2 = FXS.on; if (w2) u.setOn(false); FXS.type = o.type; FXS.on = false; fxConfigure(u); if (w2 && FX[o.type].mix !== 'action') FXS.on = u.setOn(true); }
      if (u.type !== FXS.type) fxConfigure(u);
      if (o.paramStep) { var P = FX[FXS.type].p, i = P.indexOf(fxParam(FXS.type)); if (i < 0) i = P.indexOf(FX[FXS.type].d); i = clamp(i + o.paramStep, 0, P.length - 1); FXS.params[FXS.type] = P[i]; u.setParam(P[i]); }
      if (o.param != null) { FXS.params[FXS.type] = o.param; u.setParam(o.param); }
      if (o.level != null) { FXS.level = clamp(o.level, 0, 1); u.setLevel(FXS.level); }
      if (o.tap !== undefined) { FXS.tap = o.tap; u.retime(); }
      if (o.on != null) FXS.on = u.setOn(o.on);
      return FXS;
    },
    fxParamValue: function () { return fxParam(FXS.type); },
    fxMs: function () { var u = fxUnit(FXS.ch); if (FX[FXS.type].u !== 'b') return null; return Math.round(fxParam(FXS.type) * 60000 / u.bpm()); },
    fxBpm: function () { return fxUnit(FXS.ch).bpm(); },
    fxBeatPos: function () { return fxUnit(FXS.ch).o.beatPos(); },
    fxRetime: function () { [0, 1, 2, 3, 4].forEach(function (c) { fxUnit(c).retime(); }); },
    fxSpecialEnded: function () { if (FXS.on && FX[FXS.type].mix === 'action') FXS.on = false; },
    shiftCamelot: shiftCamelot, compat: compat,
    masterDeck: function () {
      if (explicitMaster && explicitMaster.an) return explicitMaster;
      for (var i = 0; i < 4; i++) if (decks[i].isMaster && decks[i].an) return decks[i];
      return null;
    },
    setMaster: function (d) {
      decks.forEach(function (x) { x.isMaster = x === d; });
      explicitMaster = d;
      if (d && d.sync) { d.sync = false; d.corr = 0; d.updateRate(); }
      Engine.followMaster();
    },
    electMaster: function () {
      var m = Engine.masterDeck();
      if (m && (m.playing || m.special)) return;
      var cand = null;
      decks.forEach(function (d) { if (d.playing && d.an && !d.sync && !cand) cand = d; });
      if (!cand) decks.forEach(function (d) { if (d.playing && d.an && !cand) cand = d; });
      if (!cand && !m) decks.forEach(function (d) { if (d.an && !cand) cand = d; });
      if (cand && cand !== m) { decks.forEach(function (x) { x.isMaster = x === cand; }); explicitMaster = cand; if (cand.sync) { cand.sync = false; cand.corr = 0; cand.updateRate(); } Engine.followMaster(); }
    },
    followMaster: function () { decks.forEach(function (d) { if (d.sync && !d.isMaster) d.doSync(false); }); },
    setXfader: function (x) { xfader = clamp(x, -1, 1); decks.forEach(function (d) { d.applyXf(); }); },
    getXfader: function () { return xfader; },
    setMasterVol: function (v) { master.gain.setTargetAtTime(v * v * 1.2, ctx.currentTime, 0.01); },
    setColorType: function (t) { colorType = t; decks.forEach(function (d) { d.buildColor(); }); },
    setColorParam: function (v) { colorParam = clamp(v, 0, 1); decks.forEach(function (d) { d.applyColor(); }); },
    getColorParam: function () { return colorParam; },
    getColorType: function () { return colorType; },
    masterLevel: function () {
      var a = this._ml || (this._ml = new Float32Array(mAn.fftSize)); mAn.getFloatTimeDomainData(a);
      var m = 0; for (var i = 0; i < a.length; i++) { var v = Math.abs(a[i]); if (v > m) m = v; } return m;
    },
    tickSync: function () {
      var m = Engine.masterDeck();
      decks.forEach(function (d) {
        var want = 0;
        if (m && m.playing && d.sync && d !== m && d.playing && d.an && !d.special && !d.slip) {
          var pd = d.phaseDelta(m);
          if (Math.abs(pd) > 0.15) d.alignPhase(m);
          else if (Math.abs(pd) > 0.003) want = clamp(pd * 0.25, -0.01, 0.01);
        }
        if (Math.abs(want - d.corr) > 0.0005 || (want === 0 && d.corr !== 0)) { d.corr = want; d.updateRate(); }
      });
      // tempo-synced FX follow the current BPM
      var mb = masterFx.bpm(); if (Math.abs(mb - (masterFx._b || 0)) > 0.05) { masterFx._b = mb; masterFx.retime(); }
      if (FXS.on && FX[FXS.type].mix === 'action' && FXS.type !== 'reverse') FXS.on = false;
      if (FXS.on && FXS.type === 'reverse' && !decks.some(function (d) { return d.special && d.special.kind === 'reverse'; })) FXS.on = false;
      decks.forEach(function (d) {
        var b = d.bpmNow();
        if (Math.abs(b - (d._fxBpm || 0)) > 0.05) { d._fxBpm = b; d.fxu.retime(); if (colorType === 'dubecho' || colorType === 'sweep') d.applyColor(); }
      });
    },
    decode: function (ab) { return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); }); },
    resume: function () { if (ctx.state !== 'running') ctx.resume(); },
    canRecord: function () { return !!(recDest && window.MediaRecorder); },
    startRec: function () {
      if (!Engine.canRecord()) return false;
      var chunks = [], mt = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      var r = new MediaRecorder(recDest.stream, mt ? { mimeType: mt, audioBitsPerSecond: 256000 } : undefined);
      r.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      r.onstop = function () {
        var blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        if (window.AndroidBridge && AndroidBridge.beginFile) { // Android app: stream the file to native code in chunks
          var name = 'DJStudio-mix-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.webm', CH = 384 * 1024, off = 0;
          AndroidBridge.beginFile(name);
          (function next() {
            if (off >= blob.size) { var where = AndroidBridge.endFile(); if (window.UI && UI.toast) UI.toast('Mix mentve: ' + where, 5000); return; }
            var fr = new FileReader(); fr.onload = function () { AndroidBridge.appendChunk(String(fr.result).split(',')[1] || ''); off += CH; setTimeout(next, 0); };
            fr.readAsDataURL(blob.slice(off, off + CH));
          })();
          return;
        }
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'mix-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.webm'; document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); }, 1000);
      };
      r.start(1000); Engine.rec = r; Engine.recStart = Date.now(); return true;
    },
    stopRec: function () { if (Engine.rec) { Engine.rec.stop(); Engine.rec = null; } }
  };
  setInterval(Engine.tickSync, 250);
  return Engine;
})();
