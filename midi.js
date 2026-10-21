/* MIDI: Pioneer DDJ-1000 default mapping + MIDI learn */
var MIDI = (function () {
  var C = UI.C, st = document.getElementById('midiSt') || { style: {} };
  function stat(t, ok) { st.textContent = t; st.style.color = ok ? '#3e3' : ''; if (UI.midiStatus) UI.midiStatus(t, ok); }
  var map = {}; // key "n:ch:num" / "c:ch:num" -> control id
  var lsbOf = {}; // "ch:cc" (LSB) -> true when MSB mapped
  function n(ch, num, id) { map['n:' + ch + ':' + num] = id; }
  function c(ch, num, id) { map['c:' + ch + ':' + num] = id; if (num < 0x20) lsbOf[ch + ':' + (num + 0x20)] = true; }

  function defaults() {
    map = {}; lsbOf = {};
    for (var d = 0; d < 4; d++) {
      var p = 'd' + d + '.';
      // transport (deck channels 1-4 = 0..3)
      n(d, 0x0B, p + 'play'); n(d, 0x0C, p + 'cue'); n(d, 0x58, p + 'sync'); n(d, 0x3F, p + 'shift');
      n(d, 0x10, p + 'loopIn'); n(d, 0x11, p + 'loopOut'); n(d, 0x4D, p + 'reloop'); n(d, 0x14, p + 'loop');
      n(d, 0x12, p + 'loopHalf'); n(d, 0x13, p + 'loopDouble');
      // tempo slider, jog
      c(d, 0x00, p + 'pitch'); c(d, 0x21, p + 'jog'); c(d, 0x22, p + 'jog'); c(d, 0x23, p + 'jog');
      // mixer (same channel)
      c(d, 0x04, p + 'trim'); c(d, 0x07, p + 'hi'); c(d, 0x0B, p + 'mid'); c(d, 0x0F, p + 'low'); c(d, 0x13, p + 'fader');
      // filter on mixer channel 7 (0xB6)
      c(6, 0x17 + d, p + 'filter');
      // load buttons on channel 7
      n(6, 0x46 + d, p + 'load');
      // performance pads: hot cue mode, channels 8,10,12,14 (0x97,0x99,0x9B,0x9D)
      for (var h = 0; h < 8; h++) { n(7 + 2 * d, h, p + 'hot' + h); }
    }
    c(6, 0x1F, 'xfader'); c(6, 0x40, 'browse'); n(6, 0x41, 'browsePush');
  }
  defaults();
  var saved = store('midimap');
  if (saved && saved.map) { map = saved.map; lsbOf = saved.lsb || {}; }

  var shiftHeld = [false, false, false, false];
  var learning = false, target = null, inputs = [];

  function handle(ev) {
    var d = ev.data; if (!d || d.length < 2) return;
    var s = d[0] & 0xF0, ch = d[0] & 0x0F, a = d[1], v = d.length > 2 ? d[2] : 0;
    var isNote = s === 0x90 || s === 0x80, isCC = s === 0xB0;
    if (!isNote && !isCC) return;
    var key = (isNote ? 'n:' : 'c:') + ch + ':' + a;
    if (learning && target) {
      if (isNote && (s === 0x80 || v === 0)) return;
      if (isCC && lsbOf[ch + ':' + a]) return;
      Object.keys(map).forEach(function (k) { if (map[k] === target && k.charAt(0) === key.charAt(0)) delete map[k]; });
      map[key] = target; if (isCC && a < 0x20) lsbOf[ch + ':' + (a + 0x20)] = true;
      store('midimap', { map: map, lsb: lsbOf });
      UI.toast('Hozzárendelve: ' + target + ' ← ' + (isNote ? 'Note ' : 'CC ') + 'ch' + (ch + 1) + ' #' + a);
      target = null; return;
    }
    if (isCC && lsbOf[ch + ':' + a] && !map[key]) return;
    var id = map[key]; if (!id) return;
    var c = C[id]; if (!c) return;
    // shift + pad = delete hot cue
    var m = id.match(/^d(\d)\.(\w+)/), dk = m ? +m[1] : -1, k = m ? m[2] : '';
    if (k === 'shift') { UI.shift[dk] = isNote && s === 0x90 && v > 0; return; }
    if (c.type === 'btn') {
      var down = s === 0x90 && v > 0;
      if (down) c.press(); else if (c.release) c.release();
    } else if (c.type === 'rel') {
      if (!isCC) return;
      if (id === 'browse') { var r = v < 64 ? v : v - 128; if (r) c.rel(r); }
      else c.rel(v - 64);
    } else if (isCC) {
      var x = v / 127, val = c.min + x * (c.max - c.min);
      if (Math.abs(val - c.def) < (c.max - c.min) * 0.012) val = c.def; // centre detent
      c.set(val);
    } else if (s === 0x90 && v > 0 && c.def != null) c.set(c.def);
  }

  function attach(acc) {
    inputs = [];
    acc.inputs.forEach(function (i) { i.onmidimessage = handle; inputs.push(i.name); });
    stat('MIDI: ' + (inputs.length ? inputs.join(', ') : 'nincs eszköz'), inputs.length > 0);
  }
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess({ sysex: false }).then(function (acc) { attach(acc); acc.onstatechange = function () { attach(acc); }; })
      .catch(function () { stat('MIDI: nem engedélyezett'); });
  } else stat(window.AndroidBridge ? 'MIDI: csatlakoztass kontrollert' : 'MIDI: nem támogatott');

  return {
    get learning() { return learning; },
    toggleLearn: function () {
      learning = !learning; target = null;
      UI.toast(learning ? 'MIDI tanítás: válassz egy vezérlőt (OK / kattintás), majd mozdítsd meg a kontrolleren. Vissza = kilépés.' : 'MIDI tanítás vége', 4000);
    },
    learnTarget: function (id) { target = id; UI.toast('Most mozdítsd meg a kontrolleren: ' + id, 4000); },
    reset: function () { defaults(); store('midimap', null); },
    /* native Android bridge: raw MIDI bytes from android.media.midi */
    inject: function (bytes) {
      var i = 0;
      while (i < bytes.length) {
        var b = bytes[i]; if (b < 0x80) { i++; continue; }
        var hi = b & 0xF0, len = (hi === 0xC0 || hi === 0xD0) ? 2 : (b >= 0xF0 ? 1 : 3);
        if (b === 0xF0) { while (i < bytes.length && bytes[i] !== 0xF7) i++; i++; continue; }
        handle({ data: bytes.slice(i, i + len) }); i += len;
      }
    },
    device: function (name) { stat(name ? 'MIDI: ' + name : 'MIDI: nincs eszköz', !!name); if (name) UI.toast('Kontroller csatlakoztatva: ' + name); }
  };
})();
