/* Track analysis: 3-band waveform, BPM + sample-accurate beatgrid, downbeat / phrase, energy map, musical key (Camelot).
   The heavy part runs in a Web Worker (js/worker.js) so the UI and the audio never stutter; it falls back to the main thread. */
var Analysis = (function () {
  var SR = 11025, WF_RATE = 300, OFPS = 200;
  var G = typeof self !== 'undefined' ? self : window;
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---- 4-band render (low / mid / high / full) at 11025 Hz – runs inside the audio engine (off the main thread) ---- */
  function render(buf) {
    var len = Math.ceil(buf.duration * SR);
    var oc = new OfflineAudioContext(4, len, SR);
    var src = oc.createBufferSource(); src.buffer = buf;
    var mg = oc.createChannelMerger(4);
    function bq(type, f, q) { var b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; }
    var lp1 = bq('lowpass', 180), lp2 = bq('lowpass', 180);
    var bh = bq('highpass', 250), bl = bq('lowpass', 2500);
    var hp1 = bq('highpass', 2800), hp2 = bq('highpass', 2800);
    src.connect(lp1); lp1.connect(lp2); lp2.connect(mg, 0, 0);
    src.connect(bh); bh.connect(bl); bl.connect(mg, 0, 1);
    src.connect(hp1); hp1.connect(hp2); hp2.connect(mg, 0, 2);
    src.connect(mg, 0, 3);
    mg.connect(oc.destination);
    src.start(0);
    return new Promise(function (res, rej) { var p = oc.startRendering(); if (p && p.then) p.then(res, rej); else oc.oncomplete = function (e) { res(e.renderedBuffer); }; });
  }
  /* channel-array wrapper so the same code runs on AudioBuffers and on plain arrays inside the worker */
  function R4(ch, sr, dur) { return { getChannelData: function (i) { return ch[i]; }, sampleRate: sr, numberOfChannels: ch.length, duration: dur, length: ch[0].length }; }

  function envelope(data, hop) {
    var n = Math.floor(data.length / hop), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var m = 0, o = i * hop;
      for (var j = 0; j < hop; j++) { var v = data[o + j]; if (v < 0) v = -v; if (v > m) m = v; }
      out[i] = m;
    }
    return out;
  }
  function energy(data, hop) {
    var n = Math.floor(data.length / hop), out = new Float32Array(n);
    for (var i = 0; i < n; i++) { var s = 0, o = i * hop; for (var j = 0; j < hop; j++) { var v = data[o + j]; s += v * v; } out[i] = Math.sqrt(s / hop); }
    return out;
  }
  function rmsRange(d, a, b) { a = Math.max(0, Math.floor(a)); b = Math.min(d.length, Math.floor(b)); var s = 0, n = 0; for (var i = a; i < b; i += 2) { s += d[i] * d[i]; n++; } return n ? Math.sqrt(s / n) : 0; }

  function waveform(r) {
    var hop = Math.round(SR / WF_RATE);
    var low = envelope(r.getChannelData(0), hop), mid = envelope(r.getChannelData(1), hop), high = envelope(r.getChannelData(2), hop);
    var mx = 1e-6, i;
    for (i = 0; i < low.length; i++) { if (low[i] > mx) mx = low[i]; if (mid[i] > mx) mx = mid[i]; if (high[i] * 1.6 > mx) mx = high[i] * 1.6; }
    var L = new Uint8Array(low.length), M = new Uint8Array(low.length), H = new Uint8Array(low.length);
    for (i = 0; i < low.length; i++) {
      L[i] = Math.min(255, Math.pow(low[i] / mx, 0.8) * 255);
      M[i] = Math.min(255, Math.pow(mid[i] / mx, 0.8) * 255);
      H[i] = Math.min(255, Math.pow(high[i] * 1.6 / mx, 0.8) * 255);
    }
    var full = r.getChannelData(3), rms = energy(full, hop), rmx = 1e-6;
    for (i = 0; i < rms.length; i++) if (rms[i] > rmx) rmx = rms[i];
    var Rm = new Uint8Array(low.length);
    for (i = 0; i < low.length; i++) Rm[i] = Math.min(255, Math.pow((rms[i] || 0) / rmx, 0.8) * 255);
    // loudness: 80th percentile of 400 ms RMS windows (dBFS)
    var win = Math.round(SR * 0.4), wins = [];
    for (var o = 0; o + win <= full.length; o += win) { var ss = 0; for (var j = o; j < o + win; j += 2) ss += full[j] * full[j]; wins.push(Math.sqrt(ss / (win / 2))); }
    wins.sort(function (a, b) { return a - b; });
    var loud = wins.length ? 20 * Math.log(Math.max(1e-5, wins[Math.floor(wins.length * 0.8)])) / Math.LN10 : -14;
    return { low: L, mid: M, high: H, rms: Rm, rate: SR / hop, loud: loud };
  }

  /* ---- tempo (coarse) ---- */
  function onsets(r) {
    var hop = Math.round(SR / OFPS), fps = SR / hop;
    var lo = energy(r.getChannelData(0), hop), mi = energy(r.getChannelData(1), hop), hi = energy(r.getChannelData(2), hop);
    var n = lo.length, f = new Float32Array(n);
    for (var i = 1; i < n; i++) f[i] = Math.max(0, lo[i] - lo[i - 1]) * 1.0 + Math.max(0, mi[i] - mi[i - 1]) * 0.6 + Math.max(0, hi[i] - hi[i - 1]) * 0.4;
    var w = 16, out = new Float32Array(n), acc = 0;
    for (i = 0; i < n; i++) {
      acc += f[i]; if (i >= 2 * w) acc -= f[i - 2 * w];
      var c = i - w; if (c >= 0) out[c] = Math.max(0, f[c] - acc / (2 * w) * 1.1);
    }
    return { f: out, fps: fps };
  }
  function combScore(f, period, phase) {
    var s = 0, n = 0;
    for (var t = phase; t < f.length - 1; t += period) { var i = Math.floor(t), fr = t - i; s += f[i] * (1 - fr) + f[i + 1] * fr; n++; }
    return n ? s / n : 0;
  }
  function bestPhase(f, period) {
    var best = 0, bs = -1, steps = Math.ceil(period * 2);
    for (var k = 0; k < steps; k++) { var ph = k * period / steps, s = combScore(f, period, ph); if (s > bs) { bs = s; best = ph; } }
    return { phase: best, score: bs };
  }
  /* coarse tempo: comb filter on several 24 s windows (robust to tempo resolution), then octave / 3:4 checks */
  function tempo(o) {
    var f = o.f, fps = o.fps, n = f.length, W = Math.round(24 * fps);
    var a = Math.floor(n * 0.12), b = Math.floor(n * 0.88), wins = [];
    if (b - a <= W * 1.2) wins.push(f.subarray(0, n));
    else { var cnt = Math.min(5, Math.max(2, Math.floor((b - a) / W))); for (var w = 0; w < cnt; w++) { var s0 = Math.floor(a + (b - a - W) * w / (cnt - 1)); wins.push(f.subarray(s0, s0 + W)); } }
    function sc(bpm) { var p = 60 * fps / bpm, s = 0; for (var i = 0; i < wins.length; i++) s += bestPhase(wins[i], p).score; return s / wins.length; }
    var best = 120, bs = -1, bpm;
    for (bpm = 70; bpm <= 190.001; bpm += 0.1) { var v = sc(bpm) * ((bpm >= 85 && bpm <= 175) ? 1 : 0.8); if (v > bs) { bs = v; best = bpm; } }
    function local(c, span, step) { var rb = c, rs = -1; for (var x = c - span; x <= c + span + 1e-9; x += step) { var s = sc(x); if (s > rs) { rs = s; rb = x; } } return { bpm: rb, s: rs }; }
    var top = local(best, 0.12, 0.02);
    // related tempi (half / double / 3:4 / 4:3 / 2:3 / 3:2): take a related tempo only if it explains the onsets clearly better
    [2, 0.5, 4 / 3, 0.75, 1.5, 2 / 3].forEach(function (r) {
      var c = top.bpm * r; if (c < 70 || c > 190) return;
      var l = local(c, 0.25, 0.02), pri = (c >= 85 && c <= 175) ? 1 : 0.8, need = r === 2 ? 0.88 : r === 0.5 ? 1.12 : 1.06;
      if (l.s * pri >= top.s * ((top.bpm >= 85 && top.bpm <= 175) ? 1 : 0.8) * need) top = l;
    });
    var rb = Math.round(top.bpm * 100) / 100, per = 60 * fps / rb;
    // phase anchor in the middle of the track
    var m0 = Math.max(0, Math.floor(n / 2 - W / 2)), mw = f.subarray(m0, Math.min(n, m0 + W)), ph = bestPhase(mw, per).phase;
    var anchor = (m0 + ph) / fps, bl = 60 / rb, first = anchor - Math.floor(anchor / bl) * bl;
    return { bpm: rb, grid0: first, anchor: anchor };
  }

  /* ---- key ---- */
  function fft(re, im) {
    var n = re.length, i, j, k, l;
    for (i = 1, j = 0; i < n; i++) { var bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (l = 2; l <= n; l <<= 1) {
      var ang = -2 * Math.PI / l, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += l) {
        var cr = 1, ci = 0;
        for (k = 0; k < l / 2; k++) {
          var a = i + k, b = a + l / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  var MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  var NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var CAM_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1], CAM_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  function corr(a, b) {
    var ma = 0, mb = 0, i; for (i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12;
    var s = 0, sa = 0, sb = 0; for (i = 0; i < 12; i++) { var x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
    return s / Math.sqrt(sa * sb + 1e-12);
  }
  function key(r) {
    var d = r.getChannelData(3), N = 8192, frames = 140, chroma = new Float64Array(12);
    var a = Math.floor(d.length * 0.05), b = d.length - N - Math.floor(d.length * 0.05);
    if (b <= a) { a = 0; b = Math.max(1, d.length - N); }
    var win = new Float32Array(N), i; for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var binPc = new Int8Array(N / 2), binW = new Float32Array(N / 2);
    for (i = 1; i < N / 2; i++) {
      var fr = i * SR / N; if (fr < 60 || fr > 2200) { binPc[i] = -1; continue; }
      var midi = 69 + 12 * Math.log(fr / 440) / Math.LN2, nm = Math.round(midi);
      if (Math.abs(midi - nm) > 0.35) { binPc[i] = -1; continue; }
      binPc[i] = ((nm % 12) + 12) % 12; binW[i] = (1 - Math.abs(midi - nm) * 2) * (fr < 260 ? 2.5 : 1);
    }
    var re = new Float32Array(N), im = new Float32Array(N);
    for (var fI = 0; fI < frames; fI++) {
      var o = Math.floor(a + (b - a) * fI / (frames - 1 || 1)); if (o + N > d.length) break;
      for (i = 0; i < N; i++) { re[i] = d[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      var fc = new Float64Array(12), tot = 0;
      for (i = 1; i < N / 2; i++) { if (binPc[i] < 0) continue; var mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * binW[i]; fc[binPc[i]] += mag; tot += mag; }
      if (tot > 0) for (i = 0; i < 12; i++) chroma[i] += fc[i] / tot;
    }
    var best = -2, bk = 0, minor = false, second = -2;
    for (var k = 0; k < 12; k++) {
      var rot = []; for (i = 0; i < 12; i++) rot.push(chroma[(i + k) % 12]);
      var cM = corr(rot, MAJ), cm = corr(rot, MIN);
      [[cM, false], [cm, true]].forEach(function (c) { if (c[0] > best) { second = best; best = c[0]; bk = k; minor = c[1]; } else if (c[0] > second) second = c[0]; });
    }
    return { key: NAMES[bk] + (minor ? 'm' : ''), camelot: (minor ? CAM_MIN[bk] : CAM_MAJ[bk]) + (minor ? 'A' : 'B'), keyConf: Math.max(0, Math.min(1, (best - second) * 8 + best * 0.3)) };
  }

  /* ---- precise grid: 1 ms onset envelope (kick body + click) ---- */
  function onsetEnv(buf, from, to) {
    var sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    var a = Math.max(0, Math.floor(from * sr)), b = Math.min(L.length, Math.ceil(to * sr)), hop = Math.max(1, Math.round(sr / 1000));
    var n = Math.max(0, Math.floor((b - a) / hop)), out = new Float32Array(n), kick = new Float32Array(n);
    var alm = 1 - Math.exp(-2 * Math.PI * Math.min(2500, sr * 0.3) / sr), lpm = 0, envM = 0, prevM = 0, alp = 1 - Math.exp(-2 * Math.PI * 170 / sr), ahp = 1 - Math.exp(-2 * Math.PI * Math.min(4000, sr * 0.36) / sr), rel = Math.exp(-1 / (sr * 0.012));
    var lp = 0, hpl = 0, envL = 0, envH = 0, prevL = 0, prevH = 0, i = a;
    for (var k = 0; k < n; k++) {
      var mL = 0, mH = 0, mM = 0;
      for (var j = 0; j < hop; j++, i++) {
        var m = (L[i] + R[i]) * 0.5; lp += alp * (m - lp); hpl += ahp * (m - hpl); lpm += alm * (m - lpm); var h = m - hpl, md = lpm - lp;
        var al = lp < 0 ? -lp : lp, ah = h < 0 ? -h : h, am = md < 0 ? -md : md;
        envL = al > envL ? al : envL * rel; envH = ah > envH ? ah : envH * rel; envM = am > envM ? am : envM * rel;
        if (envL > mL) mL = envL; if (envH > mH) mH = envH; if (envM > mM) mM = envM;
      }
      var dl = Math.max(0, mL - prevL), dh = Math.max(0, mH - prevH), dm = Math.max(0, mM - prevM); prevL = mL; prevH = mH; prevM = mM;
      out[k] = dl + 0.5 * dm + 0.2 * dh; kick[k] = dl + 0.3 * dm;
    }
    return { e: out, kick: kick, t0: a / sr, rate: sr / hop };
  }
  function gridScore(env, g0, bl, from, to, arr) {
    var e = arr || env.e, s = 0, n = 0, k0 = Math.ceil((from - g0) / bl);
    for (var t = g0 + k0 * bl; t < to; t += bl) {
      var x = (t - env.t0) * env.rate, i = Math.floor(x); if (i < 1 || i >= e.length - 2) continue;
      var f = x - i, v = e[i] * (1 - f) + e[i + 1] * f;
      v = Math.max(v, e[i - 1] * 0.7, e[i + 2] * 0.7); s += v; n++;
    }
    return n ? s / n : 0;
  }
  /* two-stage refinement over the whole track: ±0.04 BPM / ±30 ms, then ±0.006 BPM / ±2 ms at 0.1 ms */
  function refineEnv(env, dur, bpm0, grid00, wide) {
    var from = Math.min(dur * 0.05, 20), to = dur - Math.min(dur * 0.05, 10), mid = (from + to) / 2;
    var best = { s: -1, bpm: bpm0, g: grid00 };
    function evalAt(bpm, center, span, step) {
      var bl = 60 / bpm;
      for (var off = -span; off <= span + 1e-9; off += step) {
        var a2 = center + off, g0 = a2 - Math.floor(a2 / bl) * bl, sc = gridScore(env, g0, bl, from, to);
        if (sc > best.s) best = { s: sc, bpm: bpm, g: g0, c: a2 };
      }
    }
    var k = Math.round((mid - grid00) / (60 / bpm0)), anchor = grid00 + k * (60 / bpm0), db, sp = wide ? 0.12 : 0.04;
    for (db = -sp; db <= sp + 1e-4; db += 0.005) evalAt(Math.round((bpm0 + db) * 1e4) / 1e4, anchor, 0.03, 0.0005);
    var s1 = best, c1 = best.c;
    for (db = -0.006; db <= 0.00601; db += 0.0005) evalAt(Math.round((s1.bpm + db) * 1e4) / 1e4, c1, 0.002, 0.0001);
    // prefer an integer / half BPM when it scores practically the same (most electronic music)
    var cands = [Math.round(best.bpm), Math.round(best.bpm * 2) / 2], keep = best;
    for (var ci = 0; ci < cands.length; ci++) {
      var ib = cands[ci]; if (Math.abs(ib - keep.bpm) > 0.03 || ib === keep.bpm) continue;
      best = { s: -1 }; evalAt(ib, keep.c, 0.004, 0.0001);
      if (best.s >= keep.s * 0.985) { keep = best; break; } best = keep;
    }
    best = keep;
    var bl = 60 / best.bpm, g = best.g;
    // kick check: grid must sit on the kick drums, not on off-beat bass / hats
    var on = gridScore(env, g, bl, from, to, env.kick), off = gridScore(env, g + bl / 2, bl, from, to, env.kick);
    if (off > on * 1.35) g += bl / 2;
    while (g - bl > -0.0002) g -= bl; if (g < 0) g += bl;
    return { bpm: Math.round(best.bpm * 10000) / 10000, grid0: g, score: best.s };
  }
  function refineGrid(buf, an) {
    var env = onsetEnv(buf, 0, buf.duration), r = refineEnv(env, buf.duration, an.bpm, an.grid0);
    r.env = env; return r;
  }
  /* local auto-align around time t: best phase shift within ±maxMs */
  function alignLocal(buf, bpm, grid0, t, beats, maxMs) {
    var bl = 60 / bpm, from = Math.max(0, t - beats * bl / 2), to = Math.min(buf.duration, t + beats * bl / 2), env = onsetEnv(buf, from, to), best = 0, bs = -1;
    for (var off = -maxMs / 1000; off <= maxMs / 1000 + 1e-9; off += 0.0002) { var sc = gridScore(env, grid0 + off, bl, from, to); if (sc > bs) { bs = sc; best = off; } }
    return best;
  }
  /* grid accuracy at time t: mean distance (ms) of the strongest onsets to the nearest beat line */
  function gridError(buf, bpm, grid0, t, beats) {
    var bl = 60 / bpm, from = Math.max(0, t - beats * bl / 2), to = Math.min(buf.duration, t + beats * bl / 2), env = onsetEnv(buf, from, to), e = env.kick, mx = 0, i;
    for (i = 0; i < e.length; i++) if (e[i] > mx) mx = e[i];
    if (mx <= 0) return null;
    var errs = [];
    for (var k = Math.ceil((from - grid0) / bl); grid0 + k * bl < to; k++) {
      var c = (grid0 + k * bl - env.t0) * env.rate, a = Math.max(1, Math.floor(c - bl * env.rate * 0.25)), b = Math.min(e.length - 1, Math.ceil(c + bl * env.rate * 0.25)), bi = -1, bv = mx * 0.3;
      for (i = a; i < b; i++) if (e[i] > bv) { bv = e[i]; bi = i; }
      if (bi >= 0) errs.push((bi - c) / env.rate * 1000);
    }
    if (errs.length < 2) return null;
    errs.sort(function (x, y) { return x - y; });
    return { med: errs[Math.floor(errs.length / 2)], n: errs.length };
  }

  /* ---- downbeat, phrases and energy map (per bar) ---- */
  function structure(r, bpm, grid0, dur) {
    var bl = 60 / bpm, lo = r.getChannelData(0), hi = r.getChannelData(2), fu = r.getChannelData(3), sr = r.sampleRate;
    var nBeats = Math.max(0, Math.floor((dur - grid0) / bl)), bL = new Float32Array(nBeats), bH = new Float32Array(nBeats), bF = new Float32Array(nBeats), k;
    for (k = 0; k < nBeats; k++) { var a = (grid0 + k * bl) * sr, b = a + bl * sr; bL[k] = rmsRange(lo, a, b); bH[k] = rmsRange(hi, a, b); bF[k] = rmsRange(fu, a, b); }
    // downbeat: musical changes (new elements, drops, crashes) happen on the first beat of a bar
    function nov(k) { var e = 1e-4; return Math.abs(Math.log((bL[k] + e) / (bL[k - 1] + e))) + Math.abs(Math.log((bH[k] + e) / (bH[k - 1] + e))) * 0.8 + Math.abs(Math.log((bF[k] + e) / (bF[k - 1] + e))) * 0.6; }
    var sc = [0, 0, 0, 0];
    for (k = 1; k < nBeats; k++) sc[k % 4] += nov(k);
    var db = 0; for (k = 1; k < 4; k++) if (sc[k] > sc[db]) db = k;
    var sorted = sc.slice().sort(function (x, y) { return y - x; });
    if (sorted[0] < sorted[1] * 1.08) db = 0; // not convincing: keep
    var g = grid0 + db * bl, bar = 4 * bl; g = g - Math.floor(g / bar) * bar; if (g > bar - 0.0002) g -= bar;
    var shift = Math.round((g - grid0) / bl); // beats moved
    // per bar energy
    var nBars = Math.max(0, Math.floor((dur - g) / bar)), eL = new Uint8Array(nBars), eF = new Uint8Array(nBars), eH = new Uint8Array(nBars), mL = 1e-6, mF = 1e-6, mH = 1e-6, vL = [], vF = [], vH = [];
    for (k = 0; k < nBars; k++) { var a2 = (g + k * bar) * sr, b2 = a2 + bar * sr; vL.push(rmsRange(lo, a2, b2)); vF.push(rmsRange(fu, a2, b2)); vH.push(rmsRange(hi, a2, b2)); }
    function p95(v) { var s = v.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.floor(s.length * 0.95)] || s[s.length - 1] : 1; }
    mL = Math.max(1e-6, p95(vL)); mF = Math.max(1e-6, p95(vF)); mH = Math.max(1e-6, p95(vH));
    for (k = 0; k < nBars; k++) { eL[k] = Math.min(255, vL[k] / mL * 230); eF[k] = Math.min(255, vF[k] / mF * 230); eH[k] = Math.min(255, vH[k] / mH * 230); }
    // phrase offset (8-bar phrases): where the biggest bar-to-bar changes line up
    var ps = [0, 0, 0, 0, 0, 0, 0, 0];
    for (k = 1; k < nBars; k++) { var e = 1e-4, d = Math.abs(Math.log((vL[k] + e) / (vL[k - 1] + e))) + Math.abs(Math.log((vF[k] + e) / (vF[k - 1] + e))) * 0.7 + Math.abs(Math.log((vH[k] + e) / (vH[k - 1] + e))) * 0.5; ps[k % 8] += d; }
    var phr = 0; for (k = 1; k < 8; k++) if (ps[k] > ps[phr] * 1.05) phr = k;
    // sections: bars with a full kick/bass = "body"; intro / outro = before the first / after the last body bar
    var thr = 120, first = -1, last = -1;
    for (k = 0; k < nBars; k++) if (eL[k] >= thr && (k + 1 >= nBars || eL[k + 1] >= thr)) { first = k; break; }
    for (k = nBars - 1; k >= 0; k--) if (eL[k] >= thr && (k - 1 < 0 || eL[k - 1] >= thr)) { last = k; break; }
    if (first < 0) { first = 0; last = nBars - 1; }
    return { grid0: g, shift: shift, bars: nBars, eL: eL, eF: eF, eH: eH, phr: phr, introEnd: first, outroStart: last + 1 };
  }
  function energyScore(loud, bpm, st) {
    var hiAvg = 0, n = 0; if (st && st.eH) for (var k = st.introEnd; k < st.outroStart; k++) { hiAvg += st.eH[k]; n++; }
    hiAvg = n ? hiAvg / n / 230 : 0.5;
    return Math.max(1, Math.min(10, Math.round(((loud || -12) + 20) / 2.2 + (bpm - 118) / 10 + hiAvg * 2)));
  }

  /* ---- complete analysis on channel data (worker or main thread) ---- */
  function fullCore(ch, dur, stage) {
    var r = R4(ch, SR, dur);
    stage('Hullámforma…'); var wf = waveform(r);
    stage('BPM…'); var t = tempo(onsets(r));
    stage('Beatgrid…');
    var mono = R4([ch[3]], SR, dur), env = onsetEnv(mono, 0, dur), ref = refineEnv(env, dur, t.bpm, t.grid0, true);
    stage('Szerkezet…'); var st = structure(r, ref.bpm, ref.grid0, dur);
    stage('Hangnem…'); var k = key(r);
    return { wf: wf, bpm: ref.bpm, grid0: st.grid0, gridScore: ref.score, key: k.key, camelot: k.camelot, keyConf: k.keyConf, loud: wf.loud,
      st: { bars: st.bars, eL: st.eL, eF: st.eF, eH: st.eH, phr: st.phr, introEnd: st.introEnd, outroStart: st.outroStart },
      energy: energyScore(wf.loud, ref.bpm, st), v: 3 };
  }
  /* full-rate pass for the final 0.1 ms grid (main thread, uses the real 44.1/48 kHz audio) */
  function polish(buf, an) {
    var env = onsetEnv(buf, 0, buf.duration), r = refineEnv(env, buf.duration, an.bpm, an.grid0), bl = 60 / r.bpm, bar = 4 * bl;
    // keep the detected downbeat: move the polished grid to the bar phase closest to the structural one
    var g = r.grid0, best = g, bd = 1e9;
    for (var j = 0; j < 4; j++) { var c = g + j * bl; c -= Math.floor(c / bar) * bar; var dd = Math.abs(c - an.grid0); dd = Math.min(dd, bar - dd); if (dd < bd) { bd = dd; best = c; } }
    an.bpm = r.bpm; an.grid0 = best; an.gridScore = r.score; return an;
  }

  var worker = null, wSeq = 0, wCb = {}, wBroken = false;
  function getWorker() {
    if (worker || wBroken || typeof Worker === 'undefined' || G.document == null) return worker;
    try {
      // inline (blob) worker: no extra file is needed in the app package
      var url = new URL('js/analysis.js', location.href).href;
      var src = "importScripts(" + JSON.stringify(url) + ");onmessage=function(e){var m=e.data;try{var an=Analysis.fullCore(m.ch,m.dur,function(s){postMessage({id:m.id,stage:s});});var w=an.wf;postMessage({id:m.id,an:an},[w.low.buffer,w.mid.buffer,w.high.buffer,w.rms.buffer]);}catch(err){postMessage({id:m.id,error:String((err&&err.message)||err)});}};";
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      worker.onmessage = function (e) { var m = e.data, cb = wCb[m.id]; if (!cb) return; if (m.stage) { if (cb.stage) cb.stage(m.stage); return; } delete wCb[m.id]; if (m.error) cb.rej(new Error(m.error)); else cb.res(m.an); };
      worker.onerror = function () { wBroken = true; Object.keys(wCb).forEach(function (k) { wCb[k].fallback(); }); wCb = {}; worker = null; };
    } catch (e) { wBroken = true; worker = null; }
    return worker;
  }
  /* public: analyse an AudioBuffer → Promise(an) with refined grid, downbeat, energy map and key */
  function analyze(buf, onStage, opt) {
    var stage = onStage || function () {}, dur = buf.duration;
    stage('Előkészítés…');
    return render(buf).then(function (rb) {
      var ch = [0, 1, 2, 3].map(function (i) { return rb.getChannelData(i); });
      var w = getWorker();
      var main = function () { return tick().then(function () { return fullCore(ch, dur, stage); }); };
      var p = !w ? main() : new Promise(function (res, rej) {
        var id = ++wSeq, cp = ch.map(function (c) { return c.slice(); });
        wCb[id] = { res: res, rej: rej, stage: stage, fallback: function () { main().then(res, rej); } };
        w.postMessage({ id: id, ch: cp, dur: dur }, cp.map(function (c) { return c.buffer; }));
      });
      return p.then(function (an) {
        if (!opt || opt.polish !== false) { stage('Finomhangolás…'); return tick().then(function () { try { polish(buf, an); } catch (e) {} an.dur = dur; return an; }); }
        an.dur = dur; return an;
      });
    });
  }
  function compatible(c1, c2) {
    if (!c1 || !c2) return false;
    var n1 = parseInt(c1, 10), n2 = parseInt(c2, 10), l1 = c1.slice(-1), l2 = c2.slice(-1);
    if (n1 === n2) return true;
    return l1 === l2 && ((n1 % 12) + 1 === n2 || (n2 % 12) + 1 === n1);
  }
  return { analyze: analyze, compatible: compatible, refineGrid: refineGrid, alignLocal: alignLocal, onsetEnv: onsetEnv, gridError: gridError, fullCore: fullCore, structure: structure, R4: R4 };
})();
