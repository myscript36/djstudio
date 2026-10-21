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
  master.connect(limiter); limiter.connect(mAn); limiter.connect(ctx.destination);
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

  /* ---------- FX catalogue ---------- */
  var FX = {
    echo: 'ECHO', delay: 'DELAY', pingpong: 'PING PONG', spiral: 'SPIRAL', tape: 'TAPE DELAY', reverb: 'REVERB',
    trans: 'TRANS', filter: 'FILTER', flanger: 'FLANGER', phaser: 'PHASER', pitch: 'PITCH',
    roll: 'ROLL', reverse: 'REVERSE', brake: 'VINYL BRAKE', backspin: 'BACKSPIN',
    crush: 'BITCRUSH', distort: 'DISTORTION', ringmod: 'RING MOD', noise: 'NOISE'
  };
  var FX_ORDER = Object.keys(FX);
  var FX_TAIL = { echo: 1, delay: 1, pingpong: 1, spiral: 1, tape: 1, reverb: 1 };          // keep tails after off
  var FX_ADD = { echo: 1, delay: 1, pingpong: 1, spiral: 1, tape: 1, reverb: 1, phaser: 1, noise: 1 };
  var FX_ACTION = { roll: 1, reverse: 1, brake: 1, backspin: 1 };
  var FX_HELP = {
    echo: 'Visszhang ütemre, lecsengéssel', delay: 'Egyszeri, rövid ismétlés ütemre', pingpong: 'Bal-jobb között pattogó visszhang',
    spiral: 'Sűrű, felfelé csavarodó visszhang', tape: 'Analóg szalagos visszhang, tompuló ismétlésekkel', reverb: 'Terem-zengetés',
    trans: 'Ütemre szaggatja a hangot', filter: 'Ütemre mozgó sávszűrő', flanger: 'Sugárhajtómű-szerű söprés', phaser: 'Lebegő fázis-söprés',
    pitch: 'Hangmagasság eltolás (szint = mennyiség)', roll: 'Ütemismétlés – kikapcsoláskor ott folytatja, ahol a szám tartana',
    reverse: 'Visszafelé játszás – kikapcsoláskor ott folytatja, ahol a szám tartana', brake: 'Lemezjátszó-fék: lelassul és megáll',
    backspin: 'Visszapörgetés, majd megállás', crush: 'Lo-fi bitcsökkentés (szint = erősség)', distort: 'Torzítás (szint = erősség)',
    ringmod: 'Fémes, robotos gyűrűmoduláció (szint = frekvencia)', noise: 'Fehérzaj-söprés buildupokhoz (szint = mennyiség)'
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
    this.fader = 1; this.fxType = 'echo'; this.fxOn = false; this.fxLevel = 0.5; this.fxBeat = 0.75;
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
    this.dry = g.createGain(); this.wet = g.createGain(); this.wet.gain.value = 0;
    this.fxIn = g.createGain(); this.fxIn.gain.value = 0;
    this.sum = g.createGain(); this.fade = g.createGain(); this.xf = g.createGain();
    this.meter = g.createAnalyser(); this.meter.fftSize = 512;
    this.byG = g.createGain(); this.shG = g.createGain(); this.shG.gain.value = 0; this.shActive = false;
    this.input.connect(this.byG); this.byG.connect(this.trim);
    this.input.connect(this.shifter.in); this.shifter.out.connect(this.shG); this.shG.connect(this.trim);
    this.trim.connect(this.lowEq); this.lowEq.connect(this.midEq); this.midEq.connect(this.hiEq);
    this.hiEq.connect(this.lpf); this.lpf.connect(this.hpf);
    this.hpf.connect(this.cDry); this.cDry.connect(this.post);
    this.hpf.connect(this.cSend); this.cRet.connect(this.post);
    this.post.connect(this.dry); this.post.connect(this.fxIn);
    this.dry.connect(this.sum); this.wet.connect(this.sum);
    this.sum.connect(this.fade); this.fade.connect(this.meter); this.fade.connect(this.xf); this.xf.connect(master);
    this.fxNodes = []; this.cNodes = [];
    this.buildFx(); this.buildColor(); this.applyXf();
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
    if (this.fxOn && FX_ACTION[this.fxType]) this.fxOn = false;
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
  D.setBpm = function (b) { if (!this.an || !(b > 30 && b < 300)) return; this.an.bpm = Math.round(b * 100) / 100; this.updateFxTime(); if (this.isMaster) Engine.followMaster(); else if (this.sync) this.doSync(true); };
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
  D.fxTime = function () { return clamp(this.fxBeat * 60 / Math.max(60, this.bpmNow() || 120), 0.005, 2.9); };
  D.buildFx = function () {
    killNodes(this.fxNodes); this.fxNodes = []; this.fxFb = null; this.fxDelay = null; this.fxDelay2 = null; this.fxLfo = null; this.fxWs = null; this.fxShift = null; this.fxNoiseF = null; this.fxNoiseG = null; this.fxRingOsc = null;
    try { this.fxIn.disconnect(); } catch (e) {}
    var g = ctx, T = this.fxType, W = this.wet, I = this.fxIn, N = [], self = this;
    function bq(type, f, q) { var b = g.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; N.push(b); return b; }
    function gn(v) { var x = g.createGain(); x.gain.value = v; N.push(x); return x; }
    function dly(t) { var d = g.createDelay(3); d.delayTime.value = t; N.push(d); return d; }
    function osc(type, f, beats) { var o = g.createOscillator(); o.type = type; o.frequency.value = f; if (beats) self.startAligned(o, beats); else o.start(); N.push(o); return o; }
    var ft = this.fxTime();
    if (T === 'echo' || T === 'delay') {
      var d = dly(ft), fb = gn(T === 'echo' ? 0.55 : 0.18), hp = bq('highpass', 180), dmp = bq('lowpass', 7000);
      I.connect(d); d.connect(hp); hp.connect(dmp); dmp.connect(fb); fb.connect(d); hp.connect(W); this.fxDelay = d; this.fxFb = fb;
    } else if (T === 'pingpong') {
      var dl = dly(ft), dr = dly(ft), f1 = gn(0.6), f2 = gn(0.6), pl = g.createStereoPanner(), pr = g.createStereoPanner(); pl.pan.value = -1; pr.pan.value = 1; N.push(pl, pr);
      I.connect(dl); dl.connect(pl); pl.connect(W); dl.connect(f1); f1.connect(dr); dr.connect(pr); pr.connect(W); dr.connect(f2); f2.connect(dl);
      this.fxDelay = dl; this.fxDelay2 = dr;
    } else if (T === 'spiral') {
      var ds = dly(ft / 2), fs = gn(0.78), bp = bq('bandpass', 1500, 0.8), lf = osc('sawtooth', 1 / Math.max(0.2, ft * 8)), lg = gn(1200);
      lf.connect(lg); lg.connect(bp.frequency); I.connect(ds); ds.connect(bp); bp.connect(fs); fs.connect(ds); bp.connect(W);
      this.fxDelay = ds; this.fxLfo = lf; this.fxLfoMul = 8; this.fxDelayMul = 0.5;
    } else if (T === 'tape') {
      var dt = dly(ft), ft2 = gn(0.62), lp = bq('lowpass', 2600), hp2 = bq('highpass', 120), wow = osc('sine', 0.6), wg = gn(0.0025);
      wow.connect(wg); wg.connect(dt.delayTime); I.connect(dt); dt.connect(lp); lp.connect(hp2); hp2.connect(ft2); ft2.connect(dt); hp2.connect(W);
      this.fxDelay = dt;
    } else if (T === 'reverb') {
      var cv = g.createConvolver(); cv.buffer = IR; N.push(cv); var pre = bq('highpass', 250);
      I.connect(pre); pre.connect(cv); cv.connect(W);
    } else if (T === 'trans') {
      var vg = gn(0.5), o = osc('square', 1 / ft, this.fxBeat), sm = bq('lowpass', 180), og = gn(0.5);
      o.connect(sm); sm.connect(og); og.connect(vg.gain); I.connect(vg); vg.connect(W); this.fxLfo = o; this.fxLfoMul = 1;
    } else if (T === 'filter') {
      var bpf = bq('bandpass', 1200, 4), l2 = osc('sine', 1 / (ft * 4), this.fxBeat * 4), l2g = gn(1000);
      l2.connect(l2g); l2g.connect(bpf.frequency); I.connect(bpf); bpf.connect(W); this.fxLfo = l2; this.fxLfoMul = 4;
    } else if (T === 'flanger') {
      var d2 = dly(0.004), lfo = osc('sine', 1 / (ft * 8), this.fxBeat * 8), lgn = gn(0.0032), f3 = gn(0.7);
      lfo.connect(lgn); lgn.connect(d2.delayTime); I.connect(d2); d2.connect(f3); f3.connect(d2); d2.connect(W); I.connect(W);
      this.fxLfo = lfo; this.fxLfoMul = 8;
    } else if (T === 'phaser') {
      var ph = g.createGain(); N.push(ph); var prev = I, lfp = osc('sine', 1 / (ft * 8), this.fxBeat * 8), lpg = gn(700), fbp = gn(0.5), first = null;
      for (var k = 0; k < 4; k++) { var ap = bq('allpass', 900 + k * 250, 0.7); lfp.connect(lpg); lpg.connect(ap.frequency); prev.connect(ap); prev = ap; if (!first) first = ap; }
      prev.connect(fbp); fbp.connect(first); prev.connect(W); this.fxLfo = lfp; this.fxLfoMul = 8;
    } else if (T === 'pitch') {
      var sh = new Shifter(0.06); N.push({ disconnect: function () { sh.destroy(); } });
      I.connect(sh.in); sh.out.connect(W); this.fxShift = sh;
    } else if (T === 'crush') {
      var ws = g.createWaveShaper(); N.push(ws); var lpc = bq('lowpass', 7000);
      I.connect(ws); ws.connect(lpc); lpc.connect(W); this.fxWs = ws;
    } else if (T === 'distort') {
      var wd = g.createWaveShaper(); N.push(wd); wd.oversample = '2x'; var tone = bq('lowpass', 6000), mk = gn(0.6);
      I.connect(wd); wd.connect(tone); tone.connect(mk); mk.connect(W); this.fxWs = wd;
    } else if (T === 'ringmod') {
      var rg = gn(0), ro = osc('sine', 300); ro.connect(rg.gain); I.connect(rg); rg.connect(W); this.fxRingOsc = ro;
    } else if (T === 'noise') {
      var nsrc = g.createBufferSource(); nsrc.buffer = NOISE; nsrc.loop = true; nsrc.start(); N.push(nsrc);
      var nf = bq('highpass', 300, 1.5), ng = gn(0); nsrc.connect(nf); nf.connect(ng); ng.connect(W); this.fxNoiseF = nf; this.fxNoiseG = ng;
    }
    this.fxNodes = N;
    this.applyFxParams(); this.applyFxMix();
  };
  D.applyFxParams = function () {
    var L = this.fxLevel, t = ctx.currentTime, T = this.fxType;
    if (this.fxWs && T === 'crush') this.fxWs.curve = crushCurve(Math.round(12 - L * 10));
    if (this.fxWs && T === 'distort') this.fxWs.curve = driveCurve(1 + L * 25);
    if (this.fxShift) this.fxShift.set(Math.pow(2, Math.round((L - 0.5) * 24) / 12));
    if (this.fxRingOsc) this.fxRingOsc.frequency.setTargetAtTime(30 + L * L * 1800, t, 0.02);
    if (this.fxNoiseF) { this.fxNoiseF.frequency.setTargetAtTime(200 + L * L * 12000, t, 0.05); }
    if (this.fxNoiseG) this.fxNoiseG.gain.setTargetAtTime(this.fxOn ? 0.05 + L * 0.3 : 0, t, 0.03);
    if (this.fxFb && T === 'echo') this.fxFb.gain.setTargetAtTime(0.4 + L * 0.3, t, 0.05);
  };
  D.applyFxMix = function () {
    var t = ctx.currentTime, T = this.fxType, on = this.fxOn && !FX_ACTION[T], L = this.fxLevel;
    if (FX_ADD[T]) {
      this.dry.gain.setTargetAtTime(1, t, 0.01);
      if (FX_TAIL[T]) { this.fxIn.gain.setTargetAtTime(on ? 1 : 0, t, 0.005); this.wet.gain.setTargetAtTime(L * 0.95, t, 0.02); }
      else { this.fxIn.gain.setTargetAtTime(on ? 1 : 0, t, 0.005); this.wet.gain.setTargetAtTime(on ? (T === 'noise' ? 1 : L) : 0, t, 0.02); }
    } else if (FX_ACTION[T]) {
      this.dry.gain.setTargetAtTime(1, t, 0.01); this.wet.gain.setTargetAtTime(0, t, 0.01); this.fxIn.gain.setTargetAtTime(0, t, 0.01);
    } else {
      var full = (T === 'crush' || T === 'distort' || T === 'ringmod' || T === 'pitch');
      var mix = on ? (full ? 1 : L) : 0;
      this.fxIn.gain.setTargetAtTime(on ? 1 : 0, t, 0.005);
      this.dry.gain.setTargetAtTime(1 - mix, t, 0.01); this.wet.gain.setTargetAtTime(mix, t, 0.01);
    }
    this.applyFxParams();
  };
  D.updateFxTime = function () {
    var ft = this.fxTime(), t = ctx.currentTime;
    if (this.fxDelay) this.fxDelay.delayTime.setTargetAtTime(ft * (this.fxDelayMul || 1), t, 0.05);
    if (this.fxDelay2) this.fxDelay2.delayTime.setTargetAtTime(ft, t, 0.05);
    if (this.fxLfo) this.fxLfo.frequency.setTargetAtTime(1 / (ft * (this.fxLfoMul || 1)), t, 0.05);
  };
  D.setFx = function (o) {
    if (o.type && o.type !== this.fxType) {
      if (this.fxOn && FX_ACTION[this.fxType]) this.fxAction(false);
      this.fxType = o.type; this.fxDelayMul = 1; this.fxLfoMul = 1; this.buildFx();
    }
    if (o.beat != null) { this.fxBeat = o.beat; this.updateFxTime(); }
    if (o.level != null) this.fxLevel = o.level;
    if (o.on != null && o.on !== this.fxOn) {
      if (FX_ACTION[this.fxType]) { var ok = this.fxAction(o.on); this.fxOn = o.on && ok && (this.fxType === 'roll' || this.fxType === 'reverse'); }
      else this.fxOn = o.on;
    }
    this.applyFxMix();
  };

  /* deck-level performance FX */
  D.fxAction = function (on) {
    var T = this.fxType;
    if (!this.buf) return false;
    if (T === 'roll') {
      if (on) {
        if (!this.playing) return false;
        this.slip = { p: this.pos(), t: ctx.currentTime, prevLoop: this.loop, prevOn: this.loopOn };
        var bl = this.beatLen(), len = this.fxBeat * bl, p = this.pos(), s = p;
        if (this.an) { var g0 = this.an.grid0, q = Math.min(bl, len); s = g0 + Math.floor((p - g0) / q + 0.0001) * q; }
        this.setLoop(s, s + len); return true;
      }
      if (this.slip) {
        var sp = this.slip, target = sp.p + (ctx.currentTime - sp.t) * this.rate();
        this.exitLoop(); this.loop = sp.prevLoop; this.loopOn = false; this.slip = null;
        this.seek(target); if (sp.prevOn && sp.prevLoop) this.setLoop(sp.prevLoop.s, sp.prevLoop.e);
      }
      return true;
    }
    if (T === 'reverse') {
      if (on) { if (!this.playing) return false; return this.startSpecial('reverse', 8); }
      this.endSpecial(false); return true;
    }
    if (T === 'brake') { if (on && this.playing) this.startSpecial('brake', clamp(this.fxBeat * this.beatLen() * 2, 0.3, 4)); return false; }
    if (T === 'backspin') { if (on && this.playing) this.startSpecial('backspin', clamp(this.fxBeat * this.beatLen() * 2, 0.4, 2.5)); return false; }
    return false;
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
    else sp.timer = setTimeout(function () { if (self.special === sp) { self.fxOn = false; self.endSpecial(false); self.applyFxMix(); } }, (back / r) * 1000);
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

  for (var i = 0; i < 4; i++) decks.push(new Deck(i));

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
    ctx: ctx, decks: decks, FX: FX, FX_ORDER: FX_ORDER, FX_HELP: FX_HELP, FX_ACTION: FX_ACTION, COLOR: COLOR,
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
      decks.forEach(function (d) {
        var b = d.bpmNow();
        if (Math.abs(b - (d._fxBpm || 0)) > 0.05) { d._fxBpm = b; d.updateFxTime(); if (colorType === 'dubecho' || colorType === 'sweep') d.applyColor(); }
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
