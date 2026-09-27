/* Darkly: phone-only mode. Answers every Base44 server call locally so the game runs with no Base44 connection. Scores live on this phone. */
(function () {
  var APPID = '6a9d20686a8e8203f92cf3ed';
  var KEY = 'darkly_bubble_scores_v1';
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
  function isServer(u) { return u.hostname.indexOf('base44') >= 0 || u.pathname.indexOf('/api/') === 0; }
  function handle(method, url, body) {
    var u; try { u = new URL(url, location.href); } catch (e) { return null; }
    if (!isServer(u)) return null;
    method = (method || 'GET').toUpperCase();
    var p = u.pathname;
    if (/\/entities\/User\/me/.test(p)) return [401, { message: 'Not logged in', detail: 'Not logged in' }];
    if (/public-settings|\/apps\/public\//.test(p)) return [200, { id: APPID, public_settings: 'public_without_login', requires_auth: false }];
    var m = p.match(/\/entities\/Score(?:\/([^\/?]+))?/);
    if (m) {
      var all = load();
      if (method === 'POST') {
        var r = {}; try { r = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {}); } catch (e) {}
        r.id = 'l' + Date.now() + Math.random().toString(36).slice(2, 7);
        r.created_date = new Date().toISOString(); r.updated_date = r.created_date;
        all.push(r); all.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
        save(all.slice(0, 1000)); return [200, r];
      }
      if (method === 'DELETE') { save(all.filter(function (x) { return x.id !== m[1]; })); return [200, {}]; }
      if (method === 'GET') {
        if (m[1]) return [200, all.filter(function (x) { return x.id === m[1]; })[0] || {}];
        var q = {}; try { q = JSON.parse(u.searchParams.get('q') || '{}'); } catch (e) {}
        var out = all.filter(function (x) { return Object.keys(q).every(function (k) { return typeof q[k] === 'object' || x[k] === q[k]; }); });
        var s = u.searchParams.get('sort') || u.searchParams.get('sort_by') || '-score';
        var desc = s.charAt(0) === '-', f = s.replace(/^[-+]/, '');
        out.sort(function (a, b) { var A = a[f], B = b[f]; return (A > B ? 1 : A < B ? -1 : 0) * (desc ? -1 : 1); });
        var lim = parseInt(u.searchParams.get('limit') || '0', 10); if (lim > 0) out = out.slice(0, lim);
        return [200, out];
      }
      return [200, {}];
    }
    return [200, method === 'GET' ? [] : {}];
  }
  window.__darklyHandle = handle;

  /* XMLHttpRequest */
  var P = XMLHttpRequest.prototype, oOpen = P.open, oSend = P.send, oSet = P.setRequestHeader;
  P.open = function (method, url) { this.__dm = method; this.__du = url; return oOpen.apply(this, arguments); };
  P.setRequestHeader = function () { if (this.__dfake) return; try { return oSet.apply(this, arguments); } catch (e) {} };
  P.send = function (body) {
    var res = handle(this.__dm, this.__du, body);
    if (!res) return oSend.apply(this, arguments);
    var x = this, txt = JSON.stringify(res[1]);
    var val = function (v) { return { configurable: true, get: function () { return v; } }; };
    Object.defineProperty(x, 'readyState', val(4));
    Object.defineProperty(x, 'status', val(res[0]));
    Object.defineProperty(x, 'statusText', val(res[0] === 200 ? 'OK' : 'Unauthorized'));
    Object.defineProperty(x, 'responseText', val(txt));
    Object.defineProperty(x, 'response', val(x.responseType === 'json' ? res[1] : txt));
    Object.defineProperty(x, 'responseURL', val(String(x.__du)));
    x.getAllResponseHeaders = function () { return 'content-type: application/json\r\n'; };
    x.getResponseHeader = function (h) { return /content-type/i.test(h) ? 'application/json' : null; };
    setTimeout(function () {
      ['readystatechange', 'load', 'loadend'].forEach(function (t) {
        try { var h = x['on' + t]; if (h) h.call(x, new Event(t)); } catch (e) {}
        try { x.dispatchEvent(new Event(t)); } catch (e) {}
      });
    }, 0);
  };

  /* fetch */
  var oFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = (init && init.method) || (input && input.method) || 'GET';
    var res = handle(method, url, init && init.body);
    if (!res) return oFetch.apply(this, arguments);
    return Promise.resolve(new Response(JSON.stringify(res[1]), { status: res[0], headers: { 'content-type': 'application/json' } }));
  };

  /* realtime sockets to Base44: never connect */
  var OWS = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (String(url).indexOf('base44') >= 0) { var d = { readyState: 3, send: function () {}, close: function () {}, addEventListener: function () {}, removeEventListener: function () {} }; return d; }
    return p ? new OWS(url, p) : new OWS(url);
  };
  window.WebSocket.prototype = OWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k, i) { window.WebSocket[k] = i; });

  /* hide any Base44 badge that still sneaks in */
  var css = document.createElement('style');
  css.textContent = '[id*="base44" i],[class*="base44" i],a[href*="base44"],iframe[src*="base44"]{display:none!important}';
  (document.head || document.documentElement).appendChild(css);
})();
