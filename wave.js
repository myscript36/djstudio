/* Waveform renderer: pre-rendered tiles (fast scrolling) + themed, anti-aliased drawing */
var Wave = (function () {
  var TW = 1024, TH = 144, MAX_TILES = 10;
  var ZOOMS = [60, 90, 130, 190, 280, 400, 560];
  var HOTC = ['#28e214', '#e6282c', '#ff8a00', '#ffe014', '#00c3ff', '#7070ff', '#ff4fd8', '#ffffff'];
  var budget = 0;

  /* ---------- column extraction ---------- */
  function columns(wf, t0, spp, W) {
    var n = wf.low.length, rate = wf.rate, L = new Float32Array(W), M = new Float32Array(W), Hh = new Float32Array(W), R = new Float32Array(W);
    var lo = wf.low, mi = wf.mid, hi = wf.high, rm = wf.rms || wf.low;
    for (var x = 0; x < W; x++) {
      var f0 = (t0 + x * spp) * rate, f1 = f0 + spp * rate;
      if (f1 < 0 || f0 >= n) continue;
      if (f1 - f0 >= 1) {
        var a = Math.max(0, Math.floor(f0)), b = Math.min(n, Math.ceil(f1)), l = 0, m = 0, h = 0, r = 0;
        for (var i = a; i < b; i++) { if (lo[i] > l) l = lo[i]; if (mi[i] > m) m = mi[i]; if (hi[i] > h) h = hi[i]; if (rm[i] > r) r = rm[i]; }
        L[x] = l / 255; M[x] = m / 255; Hh[x] = h / 255; R[x] = r / 255;
      } else {
        var i0 = Math.max(0, Math.floor(f0)), i1 = Math.min(n - 1, i0 + 1), fr = f0 - Math.floor(f0); if (f0 < 0) fr = 0;
        L[x] = (lo[i0] * (1 - fr) + lo[i1] * fr) / 255; M[x] = (mi[i0] * (1 - fr) + mi[i1] * fr) / 255;
        Hh[x] = (hi[i0] * (1 - fr) + hi[i1] * fr) / 255; R[x] = (rm[i0] * (1 - fr) + rm[i1] * fr) / 255;
      }
    }
    return { l: L, m: M, h: Hh, r: R, W: W };
  }

  /* ---------- painters ---------- */
  function mirrorPath(g, v, W, cy, A, k) {
    g.beginPath(); g.moveTo(0, cy - v[0] * A * k);
    for (var x = 1; x < W; x++) g.lineTo(x, cy - v[x] * A * k);
    for (x = W - 1; x >= 0; x--) g.lineTo(x, cy + v[x] * A * k);
    g.closePath();
  }
  function vgrad(g, cy, A, edge, mid) { var gr = g.createLinearGradient(0, cy - A, 0, cy + A); gr.addColorStop(0, edge); gr.addColorStop(0.5, mid); gr.addColorStop(1, edge); return gr; }
  var PAINT = {
    rgb: function (g, c, W, H) {
      var cy = H / 2, A = H / 2 - 2;
      for (var x = 0; x < W; x++) {
        var l = c.l[x], m = c.m[x], h = c.h[x], amp = Math.max(l, m * 0.92, h * 0.8); if (amp < 0.004) continue;
        var mx = Math.max(l, m, h, 0.001), R = Math.round(25 + 230 * Math.pow(l / mx, 0.9)), G = Math.round(25 + 230 * Math.pow(m / mx, 0.9)), B = Math.round(25 + 230 * Math.pow(h / mx, 0.9));
        g.fillStyle = 'rgba(' + R + ',' + G + ',' + B + ',0.62)'; g.fillRect(x, cy - amp * A, 1, amp * A * 2);
        var body = Math.min(amp, c.r[x] * 0.82);
        g.fillStyle = 'rgb(' + Math.round(R + (255 - R) * 0.3) + ',' + Math.round(G + (255 - G) * 0.3) + ',' + Math.round(B + (255 - B) * 0.3) + ')';
        g.fillRect(x, cy - body * A, 1, body * A * 2);
      }
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = vgrad(g, cy, A + 2, 'rgba(0,0,0,0.5)', 'rgba(255,255,255,0.10)'); g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    },
    whitered: function (g, c, W, H) {
      var cy = H / 2, A = H / 2 - 2;
      g.fillStyle = vgrad(g, cy, A, '#5a000c', '#ff1f3d'); mirrorPath(g, c.l, W, cy, A, 1); g.fill();
      g.fillStyle = 'rgba(255,135,145,0.78)'; mirrorPath(g, c.m, W, cy, A, 0.82); g.fill();
      g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = 6;
      g.fillStyle = vgrad(g, cy, A * 0.6, 'rgba(255,230,230,0.85)', '#ffffff'); mirrorPath(g, c.h, W, cy, A, 0.62); g.fill();
      g.shadowBlur = 0;
    },
    vice: function (g, c, W, H) {
      var cy = H / 2, A = H / 2 - 4;
      g.shadowColor = '#ff2bd6'; g.shadowBlur = 14;
      g.fillStyle = vgrad(g, cy, A, '#5b00b8', '#ff2bd6'); mirrorPath(g, c.l, W, cy, A, 1); g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(255,160,240,0.9)'; g.lineWidth = 1; mirrorPath(g, c.l, W, cy, A, 1); g.stroke();
      g.fillStyle = 'rgba(170,70,255,0.85)'; mirrorPath(g, c.m, W, cy, A, 0.8); g.fill();
      g.shadowColor = '#2de2ff'; g.shadowBlur = 10;
      g.fillStyle = vgrad(g, cy, A * 0.6, 'rgba(45,226,255,0.7)', '#d9fbff'); mirrorPath(g, c.h, W, cy, A, 0.6); g.fill();
      g.shadowBlur = 0;
    },
    blue3: function (g, c, W, H) {
      var cy = H / 2, A = H / 2 - 2;
      g.fillStyle = vgrad(g, cy, A, '#0a2a8a', '#3b8bff'); mirrorPath(g, c.l, W, cy, A, 1); g.fill();
      g.fillStyle = vgrad(g, cy, A * 0.8, '#b85f00', '#ffb03a'); mirrorPath(g, c.m, W, cy, A, 0.8); g.fill();
      g.fillStyle = '#ffffff'; mirrorPath(g, c.h, W, cy, A, 0.55); g.fill();
    }
  };
  var LANE = {
    rgb: { bg: ['#000000', '#07080b'], grid: 'rgba(255,255,255,0.28)', bar: 'rgba(255,255,255,0.75)', phrase: '#ff3b3b', dim: 'rgba(0,0,0,0.32)', loop: 'rgba(60,220,60,0.2)' },
    whitered: { bg: ['#000000', '#0c0607'], grid: 'rgba(255,255,255,0.25)', bar: 'rgba(255,210,0,0.85)', phrase: '#ffd200', dim: 'rgba(0,0,0,0.35)', loop: 'rgba(255,255,255,0.12)' },
    vice: { bg: ['#0b0216', '#1a0630'], grid: 'rgba(45,226,255,0.3)', bar: 'rgba(255,230,0,0.85)', phrase: '#ffe600', dim: 'rgba(10,0,25,0.4)', loop: 'rgba(45,226,255,0.16)', horizon: true },
    blue3: { bg: ['#000000', '#090b10'], grid: 'rgba(255,255,255,0.3)', bar: 'rgba(255,60,60,0.9)', phrase: '#ff3b3b', dim: 'rgba(0,0,0,0.3)', loop: 'rgba(60,220,60,0.2)' }
  };

  /* ---------- tiles ---------- */
  function getTile(an, theme, zoom, idx, force) {
    var T = an._tiles || (an._tiles = { map: {}, order: [] }), key = theme + '|' + zoom + '|' + idx;
    var c = T.map[key]; if (c) return c;
    if (!force && budget <= 0) return null;
    budget--;
    c = document.createElement('canvas'); c.width = TW; c.height = TH;
    var g = c.getContext('2d');
    PAINT[theme](g, columns(an.wf, idx * TW / zoom, 1 / zoom, TW), TW, TH);
    T.map[key] = c; T.order.push(key);
    while (T.order.length > MAX_TILES) { var k = T.order.shift(); var old = T.map[k]; if (old) { old.width = 0; } delete T.map[k]; }
    return c;
  }
  function prewarm(an, theme, zoom, pos) {
    var idx = Math.floor(pos * zoom / TW), list = [idx, idx + 1, idx - 1, idx + 2];
    var i = 0;
    (function next() { if (i >= list.length) return; var k = list[i++]; if (k >= 0 && k * TW / zoom < an.dur) getTile(an, theme, zoom, k, true); setTimeout(next, 30); })();
  }
  function clearTiles(an) { if (an && an._tiles) { an._tiles.order.forEach(function (k) { var c = an._tiles.map[k]; if (c) c.width = 0; }); an._tiles = null; } }

  function overview(an, dur, theme, W, H) {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'), L = LANE[theme];
    g.fillStyle = L.bg[0]; g.fillRect(0, 0, W, H);
    PAINT[theme](g, columns(an.wf, 0, dur / W, W), W, H);
    return c;
  }

  /* ---------- lane drawing (called per frame when dirty) ---------- */
  function laneBg(g, theme, y, h, W, selected) {
    var L = LANE[theme], gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, L.bg[1]); gr.addColorStop(0.5, L.bg[0]); gr.addColorStop(1, L.bg[1]);
    g.fillStyle = gr; g.fillRect(0, y, W, h);
    if (L.horizon) { g.fillStyle = 'rgba(255,43,214,0.08)'; for (var i = 1; i < 4; i++) g.fillRect(0, y + h / 2 + i * h / 9, W, 1); g.fillStyle = 'rgba(45,226,255,0.06)'; for (i = 1; i < 4; i++) g.fillRect(0, y + h / 2 - i * h / 9, W, 1); }
    if (selected) { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(0, y, W, h); }
  }
  function drawLane(g, D, o) {
    var W = o.W, y = o.y, h = o.h, theme = o.theme, L = LANE[theme], cx = W / 2;
    laneBg(g, theme, y, h, W, o.selected);
    if (D.an) {
      var an = D.an, pos = D.pos(), r = Math.abs(D.rate()) || 1, zoom = o.zoom;
      var spx = r / zoom; // track seconds per screen px
      var t0 = pos - cx * spx, tp0 = t0 * zoom, span = W * r;
      // loop region (under waveform)
      if (D.loop) { var lx1 = (D.loop.s - t0) / spx, lx2 = (D.loop.e - t0) / spx; g.fillStyle = D.loopOn ? L.loop : 'rgba(128,128,128,0.10)'; g.fillRect(lx1, y, lx2 - lx1, h); }
      var i0 = Math.floor(tp0 / TW), i1 = Math.floor((tp0 + span) / TW), maxIdx = Math.ceil(an.dur * zoom / TW);
      for (var idx = Math.max(0, i0); idx <= Math.min(i1, maxIdx); idx++) {
        var tile = getTile(an, theme, zoom, idx); if (!tile) continue;
        var sx = Math.max(0, tp0 - idx * TW), ex = Math.min(TW, tp0 + span - idx * TW); if (ex <= sx) continue;
        g.drawImage(tile, sx, 0, ex - sx, TH, (idx * TW + sx - tp0) / r, y, (ex - sx) / r, h);
      }
      // played part dimmed
      g.fillStyle = L.dim; g.fillRect(0, y, cx, h);
      // beat grid, bar numbers, phrases
      var bl = 60 / an.bpm, k0 = Math.ceil((t0 - an.grid0) / bl), t1 = t0 + W * spx, barPx = 4 * bl / spx;
      g.font = 'bold 11px Arial';
      for (var k = k0; an.grid0 + k * bl < t1; k++) {
        var gx = Math.round((an.grid0 + k * bl - t0) / spx), bar = ((k % 4) + 4) % 4 === 0;
        if (bar) {
          var barNo = Math.floor(k / 4), phrase = ((barNo % 16) + 16) % 16 === 0;
          g.fillStyle = phrase ? L.phrase : L.bar; g.fillRect(gx - (phrase ? 1 : 0), y, phrase ? 3 : 1, h);
          if (barPx > 34 && barNo >= 0) { g.fillStyle = phrase ? L.phrase : 'rgba(255,255,255,0.6)'; g.fillText(barNo + 1, gx + 4, y + 12); }
        } else { g.fillStyle = L.grid; g.fillRect(gx, y, 1, 7); g.fillRect(gx, y + h - 7, 1, 7); }
      }
      // cue + hot cues
      var cxp = (D.cue - t0) / spx; g.fillStyle = '#ff8a00'; g.beginPath(); g.moveTo(cxp - 8, y + h); g.lineTo(cxp + 8, y + h); g.lineTo(cxp, y + h - 11); g.fill();
      for (var hI = 0; hI < 8; hI++) if (D.hot[hI] != null) {
        var hx = (D.hot[hI] - t0) / spx; if (hx < -20 || hx > W + 20) continue;
        g.fillStyle = HOTC[hI]; g.fillRect(hx, y, 2, h); g.fillRect(hx, y + h - 17, 17, 17);
        g.fillStyle = '#000'; g.font = 'bold 13px Arial'; g.fillText(hI + 1, hx + 4, y + h - 4);
      }
      if (D.loopInPos != null && !D.loopOn) { var li = (D.loopInPos - t0) / spx; g.fillStyle = '#2ecc40'; g.fillRect(li, y, 2, h); }
    } else {
      g.fillStyle = '#555'; g.font = (o.n === 2 ? 26 : 18) + 'px Arial';
      g.fillText(o.label + ' – ' + (o.stat || 'üres – nyomd meg a ☰ Zenék gombot'), 70, y + h / 2 + 8);
    }
    // deck tag
    g.fillStyle = o.color; g.fillRect(0, y, 40, h - 1);
    g.fillStyle = '#000'; g.font = 'bold ' + (o.n === 2 ? 34 : 26) + 'px Arial'; g.fillText(o.label, o.n === 2 ? 9 : 11, y + h / 2 + 10);
    if (D.isMaster && D.an) { g.fillStyle = '#000'; g.font = 'bold 11px Arial'; g.fillText('MST', 7, y + h - 6); }
    // playhead with glow
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(cx - 4, y, 8, h);
    g.fillStyle = '#ffffff'; g.fillRect(cx - 1, y, 2, h);
    g.fillStyle = '#1c1e22'; g.fillRect(0, y + h - 1, W, 1);
  }

  return {
    ZOOMS: ZOOMS, TW: TW, drawLane: drawLane, overview: overview, prewarm: prewarm, clearTiles: clearTiles,
    resetBudget: function (n) { budget = n; }, themes: Object.keys(PAINT)
  };
})();
