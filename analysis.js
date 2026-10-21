/* Track analysis: 3-band waveform, BPM + beatgrid, musical key (Camelot) */
var Analysis = (function () {
  var SR = 11025, WF_RATE = 300, OFPS = 100;
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

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
    return oc.startRendering();
  }

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
    // full-band RMS (inner "body" of the waveform) + loudness for auto gain
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

  /* ---- tempo ---- */
  function onsets(r) {
    var hop = Math.round(SR / OFPS), fps = SR / hop;
    var lo = energy(r.getChannelData(0), hop), mi = energy(r.getChannelData(1), hop), hi = energy(r.getChannelData(2), hop);
    var n = lo.length, f = new Float32Array(n);
    for (var i = 1; i < n; i++) {
      var d = Math.max(0, lo[i] - lo[i - 1]) * 1.0 + Math.max(0, mi[i] - mi[i - 1]) * 0.6 + Math.max(0, hi[i] - hi[i - 1]) * 0.4;
      f[i] = d;
    }
    // remove local mean (adaptive threshold)
    var w = 16, out = new Float32Array(n), acc = 0;
    for (i = 0; i < n; i++) {
      acc += f[i]; if (i >= 2 * w) acc -= f[i - 2 * w];
      var c = i - w; if (c >= 0) out[c] = Math.max(0, f[c] - acc / (2 * w) * 1.1);
    }
    return { f: out, fps: fps };
  }

  function combScore(f, period, phase) {
    var s = 0, n = 0;
    for (var t = phase; t < f.length - 1; t += period) {
      var i = Math.floor(t), fr = t - i;
      s += f[i] * (1 - fr) + f[i + 1] * fr; n++;
    }
    return n ? s / n : 0;
  }
  function bestPhase(f, period) {
    var best = 0, bs = -1, steps = Math.ceil(period * 2);
    for (var k = 0; k < steps; k++) { var ph = k * period / steps, s = combScore(f, period, ph); if (s > bs) { bs = s; best = ph; } }
    return { phase: best, score: bs };
  }

  function tempo(o) {
    var f = o.f, fps = o.fps, n = f.length;
    // analyse middle 70% (skip intro/outro) for period estimation
    var a = Math.floor(n * 0.15), b = Math.floor(n * 0.85); if (b - a < fps * 20) { a = 0; b = n; }
    var seg = f.subarray(a, b);
    var minBpm = 70, maxBpm = 190, cands = [];
    for (var bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
      var p = 60 * fps / bpm, s = bestPhase(seg, p).score;
      cands.push([bpm, s]);
    }
    // fold octave errors: prefer 85-175 range, combine harmonic support
    var best = null, bs = -1;
    cands.forEach(function (c) {
      var bpm = c[0], s = c[1];
      var w = (bpm >= 85 && bpm <= 175) ? 1 : 0.75;
      if (bpm > 150) w *= 0.97;
      var sc = s * w;
      if (sc > bs) { bs = sc; best = bpm; }
    });
    // refine ±0.6 BPM in 0.01 steps
    var rb = best, rs = -1;
    for (var x = best - 0.6; x <= best + 0.6; x += 0.01) {
      var pr = bestPhase(seg, 60 * fps / x).score;
      if (pr > rs) { rs = pr; rb = x; }
    }
    // half-tempo check: prefer double tempo if it explains the onsets nearly as well
    if (rb * 2 <= 180) {
      var sx = bestPhase(seg, 60 * fps / rb).score, s2 = bestPhase(seg, 60 * fps / (rb * 2)).score;
      if (s2 >= sx * 0.88) rb = rb * 2;
    }
    if (Math.abs(rb - Math.round(rb)) < 0.06) rb = Math.round(rb);
    else rb = Math.round(rb * 100) / 100;
    var period = 60 * fps / rb;
    var ph = bestPhase(f, period).phase;
    var first = ph / fps;
    while (first - 60 / rb > -0.001) first -= 60 / rb;
    if (first < 0) first += 60 / rb;
    return { bpm: rb, grid0: first };
  }

  /* ---- key ---- */
  function fft(re, im) {
    var n = re.length, i, j, k, l;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (l = 2; l <= n; l <<= 1) {
      var ang = -2 * Math.PI / l, wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += l) {
        var cr = 1, ci = 0;
        for (k = 0; k < l / 2; k++) {
          var a = i + k, b = a + l / 2;
          var tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  var MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  var NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var CAM_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  var CAM_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  function corr(a, b) {
    var ma = 0, mb = 0, i; for (i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12;
    var s = 0, sa = 0, sb = 0; for (i = 0; i < 12; i++) { var x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; }
    return s / Math.sqrt(sa * sb + 1e-12);
  }
  function key(r) {
    var d = r.getChannelData(3), N = 8192, frames = 140, chroma = new Float64Array(12);
    var a = Math.floor(d.length * 0.05), b = d.length - N - Math.floor(d.length * 0.05);
    if (b <= a) { a = 0; b = Math.max(1, d.length - N); }
    var win = new Float32Array(N); for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var binPc = new Int8Array(N / 2), binW = new Float32Array(N / 2);
    for (i = 1; i < N / 2; i++) {
      var fr = i * SR / N; if (fr < 60 || fr > 2200) { binPc[i] = -1; continue; }
      var midi = 69 + 12 * Math.log(fr / 440) / Math.LN2, nm = Math.round(midi);
      if (Math.abs(midi - nm) > 0.35) { binPc[i] = -1; continue; }
      binPc[i] = ((nm % 12) + 12) % 12; binW[i] = (1 - Math.abs(midi - nm) * 2) * (fr < 260 ? 2.5 : 1);
    }
    var re = new Float32Array(N), im = new Float32Array(N);
    for (var fI = 0; fI < frames; fI++) {
      var o = Math.floor(a + (b - a) * fI / (frames - 1 || 1));
      if (o + N > d.length) break;
      for (i = 0; i < N; i++) { re[i] = d[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      var fc = new Float64Array(12), tot = 0;
      for (i = 1; i < N / 2; i++) { if (binPc[i] < 0) continue; var mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * binW[i]; fc[binPc[i]] += mag; tot += mag; }
      if (tot > 0) for (i = 0; i < 12; i++) chroma[i] += fc[i] / tot;
    }
    var best = -2, bk = 0, minor = false;
    for (var k = 0; k < 12; k++) {
      var rot = []; for (i = 0; i < 12; i++) rot.push(chroma[(i + k) % 12]);
      var cM = corr(rot, MAJ), cm = corr(rot, MIN);
      if (cM > best) { best = cM; bk = k; minor = false; }
      if (cm > best) { best = cm; bk = k; minor = true; }
    }
    return { key: NAMES[bk] + (minor ? 'm' : ''), camelot: (minor ? CAM_MIN[bk] : CAM_MAJ[bk]) + (minor ? 'A' : 'B') };
  }

  function analyze(buf, onStage) {
    if (onStage) onStage('Hullámforma…');
    var R;
    return render(buf).then(function (r) { R = r; return tick(); })
      .then(function () { var wf = waveform(R); if (onStage) onStage('BPM…'); return tick().then(function () { return wf; }); })
      .then(function (wf) { var t = tempo(onsets(R)); if (onStage) onStage('Hangnem…'); return tick().then(function () { return { wf: wf, t: t }; }); })
      .then(function (x) { var k = key(R); R = null; return { wf: x.wf, bpm: x.t.bpm, grid0: x.t.grid0, key: k.key, camelot: k.camelot, loud: x.wf.loud }; });
  }

  function compatible(c1, c2) {
    if (!c1 || !c2) return false;
    var n1 = parseInt(c1, 10), n2 = parseInt(c2, 10), l1 = c1.slice(-1), l2 = c2.slice(-1);
    if (n1 === n2) return true;
    if (l1 === l2 && ((n1 % 12) + 1 === n2 || (n2 % 12) + 1 === n1)) return true;
    return false;
  }
  return { analyze: analyze, compatible: compatible };
})();
