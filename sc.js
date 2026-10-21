/* SoundCloud: client_id, search, likes, download + decode */
var SC = (function () {
  var API = 'https://api-v2.soundcloud.com';
  var CID = store('cid');

  function getText(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }); }
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); }); }

  function findId(pages) {
    var i = 0;
    function nextPage() {
      if (i >= pages.length) return Promise.reject(new Error('Nem sikerült SoundCloud kliens azonosítót szerezni'));
      var base = pages[i++];
      return getText(base[0]).then(function (html) {
        var re = /<script[^>]+src="([^"]+\.js)"/g, m, srcs = [];
        while ((m = re.exec(html))) srcs.push(m[1].indexOf('http') === 0 ? m[1] : base[1] + m[1]);
        srcs.reverse(); var j = 0;
        function nextJs() {
          if (j >= srcs.length) return nextPage();
          return getText(srcs[j++]).then(function (js) {
            var mm = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
            return mm ? mm[1] : nextJs();
          }, nextJs);
        }
        return nextJs();
      }, nextPage);
    }
    return nextPage();
  }
  function ensureCid(force) {
    if (CID && !force) return Promise.resolve(CID);
    return findId([
      ['https://soundcloud.com/', 'https://soundcloud.com'],
      ['https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/', 'https://w.soundcloud.com'],
      ['https://m.soundcloud.com/', 'https://m.soundcloud.com']
    ]).then(function (id) { CID = id; store('cid', id); return id; });
  }
  function withCid(u) { return u + (u.indexOf('?') < 0 ? '?' : '&') + 'client_id=' + CID; }
  function api(path, retried) {
    return ensureCid(false).then(function () {
      return getJSON(withCid(path.indexOf('http') === 0 ? path : API + path)).catch(function (e) {
        if ((e.status === 401 || e.status === 403) && !retried) {
          CID = null; store('cid', null);
          return ensureCid(true).then(function () { return api(path, true); });
        }
        throw e;
      });
    });
  }

  /* paged list: returns {items, next} ; next = absolute next_href or null */
  var pcache = {};
  function page(pathOrUrl, map) {
    var key = pathOrUrl;
    if (pcache[key]) return Promise.resolve(pcache[key]);
    return api(pathOrUrl).then(function (d) {
      var items = (d.collection || []); if (map) items = items.map(map).filter(Boolean);
      var res = { items: items, next: d.next_href || null };
      pcache[key] = res; var ks = Object.keys(pcache); if (ks.length > 80) delete pcache[ks[0]];
      return res;
    });
  }
  function likeTrack(x) { return x.track || null; }
  function lister(path, map) { return function (next) { return page(next || path, map); }; }
  function search(q) { return api('/search/tracks?q=' + encodeURIComponent(q) + '&limit=50').then(function (d) { return d.collection || []; }); }
  function likes(uid) { return api('/users/' + uid + '/track_likes?limit=100').then(function (d) { return (d.collection || []).map(function (x) { return x.track; }).filter(Boolean); }); }
  function userTracks(uid) { return api('/users/' + uid + '/tracks?limit=100').then(function (d) { return d.collection || []; }); }

  function toUser(o) {
    if (o.kind === 'user') return o;
    if (o.user && o.user.id) return api('/users/' + o.user.id);
    throw new Error('A link nem profilra mutat');
  }
  function resolveProfile(v) {
    var url = /^https?:\/\//.test(v) ? v : (v.indexOf('soundcloud.com') >= 0 ? 'https://' + v : 'https://soundcloud.com/' + v.replace(/^@/, ''));
    url = url.split('?')[0];
    return api('/resolve?url=' + encodeURIComponent(url)).then(toUser).catch(function (e) {
      if (url.indexOf('on.soundcloud.com') < 0) throw new Error('Nem található ilyen profil');
      return fetch(url).then(function (r) {
        if (r.url && r.url.indexOf('on.soundcloud.com') < 0) return r.url;
        return r.text().then(function (h) { var m = h.match(/https:\/\/soundcloud\.com\/[\w-]+(\/[\w-]+)?/); if (!m) throw e; return m[0]; });
      }).then(function (full) { return api('/resolve?url=' + encodeURIComponent(full.split('?')[0])).then(toUser); });
    });
  }

  function fetchBuf(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }); }
  function concat(bufs) {
    var n = 0, i; for (i = 0; i < bufs.length; i++) n += bufs[i].byteLength;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < bufs.length; i++) { out.set(new Uint8Array(bufs[i]), o); o += bufs[i].byteLength; }
    return out.buffer;
  }
  function absUrl(u, base) { if (/^https?:/.test(u)) return u; var b = base.split('?')[0]; return u.charAt(0) === '/' ? b.replace(/^(https?:\/\/[^/]+).*/, '$1') + u : b.replace(/[^/]*$/, '') + u; }

  function downloadHls(m3uUrl, onP, onPartial) {
    return getText(m3uUrl).then(function (txt) {
      var lines = txt.split(/\r?\n/), segs = [], init = null, durs = [], curDur = 0;
      lines.forEach(function (l) {
        l = l.trim(); if (!l) return;
        var m = l.match(/^#EXT-X-MAP:.*URI="([^"]+)"/); if (m) { init = absUrl(m[1], m3uUrl); return; }
        if (/^#EXT-X-KEY:.*METHOD=(?!NONE)/.test(l)) throw new Error('Titkosított stream');
        var di = l.match(/^#EXTINF:([\d.]+)/); if (di) { curDur = parseFloat(di[1]); return; }
        if (l.charAt(0) !== '#') { segs.push(absUrl(l, m3uUrl)); durs.push(curDur || 10); }
      });
      // how many leading segments give ~25 s of audio (fast start)
      var need = 0, acc = 0; while (need < durs.length && acc < 25) acc += durs[need++];
      if (init) { segs.unshift(init); need++; }
      var partialSent = !onPartial || need >= segs.length;
      var out = new Array(segs.length), done = 0, next = 0;
      return new Promise(function (res, rej) {
        var active = 0, failed = false;
        function pump() {
          if (failed) return;
          if (done === segs.length) { res(concat(out)); return; }
          while (active < 6 && next < segs.length) {
            (function (k) {
              active++;
              fetchBuf(segs[k]).then(function (b) {
                out[k] = b; active--; done++; if (onP) onP(done / segs.length);
                if (!partialSent) { var ok = true; for (var z = 0; z < need; z++) if (!out[z]) { ok = false; break; } if (ok) { partialSent = true; try { onPartial(concat(out.slice(0, need))); } catch (e) {} } }
                pump();
              })
                .catch(function (e) { failed = true; rej(e); });
            })(next++);
          }
        }
        pump();
      });
    });
  }

  function scoreT(x) {
    var f = x.format || {}, m = f.mime_type || '', p = f.protocol || '';
    if (p.indexOf('encrypted') >= 0) return -1;
    if (p === 'progressive') return 6;
    if (p === 'hls' && m.indexOf('mpeg') >= 0) return 5;
    if (p === 'hls' && m.indexOf('mp4') >= 0) return 4;
    if (p === 'hls' && m.indexOf('ogg') >= 0) return 2;
    return 0;
  }

  /* returns Promise<ArrayBuffer of encoded audio> ; onP(fraction, label) */
  function download(track, onP, onPartial) {
    var fresh = !(track.media && track.track_authorization);
    var tp = fresh ? api('/tracks/' + track.id) : Promise.resolve(track);
    return tp.then(function (t) {
      var list = ((t.media && t.media.transcodings) || []).filter(function (x) { return scoreT(x) > 0; })
        .sort(function (a, b) { return scoreT(b) - scoreT(a); });
      if (!list.length) throw new Error('Ehhez a számhoz nincs letölthető stream');
      var snip = t.policy === 'SNIP' || list.every(function (x) { return x.snipped; });
      var i = 0, lastErr;
      function tryNext() {
        if (i >= list.length) throw lastErr || new Error('Letöltés sikertelen');
        var x = list[i++];
        var u = withCid(x.url) + (t.track_authorization ? '&track_authorization=' + t.track_authorization : '');
        return getJSON(u).then(function (j) {
          if (x.format.protocol === 'progressive') { if (onP) onP(0.5); return fetchBuf(j.url); }
          return downloadHls(j.url, onP, onPartial);
        }).then(function (ab) { return { data: ab, track: t, snip: snip, mime: x.format.mime_type }; })
          .catch(function (e) { lastErr = e; return tryNext(); });
      }
      return ensureCid(false).then(tryNext);
    }).catch(function (e) {
      if (fresh) throw e; // stale stream authorisation: fetch the track again once
      var t2 = {}; for (var k in track) t2[k] = track[k]; t2.media = null; t2.track_authorization = null;
      return download(t2, onP, onPartial);
    });
  }

  return { page: page, lister: lister, likeTrack: likeTrack, clearCache: function () { pcache = {}; }, ensureCid: ensureCid, search: search, likes: likes, userTracks: userTracks, resolveProfile: resolveProfile, download: download, api: api };
})();
