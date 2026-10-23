/**
 * HTML 画面の静的な資産（T23。FR_021・IR_003）。依存を増やさず、素の JavaScript で書く（TS の文字列として埋め込むので、ビルドで複製が要らない）。
 *
 * 描画の規則（`ui-assets.test.ts` が走査で守らせる）:
 * - 文字列は `textContent` と `createElement` だけで描く。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・`new Function`・
 *   `setAttribute`・`on*` への代入・`location` への代入・`srcdoc` は使わない。
 * - インラインの script・style・イベント属性は置かない（CSP が `'self'` だけを許す）。
 * - 人間のトークンは、読み込んだらすぐ `history.replaceState` でフラグメントを消し、メモリにだけ持つ（storage・cookie には置かない）。
 */

export const UI_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>cso 状態画面</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header><h1>cso 状態画面</h1><span id="status" class="status">未接続</span></header>
<main>
<section id="auth" hidden>
<h2>人間のトークン</h2>
<p>人間のトークンのファイルの中身を、貼り付けてください（推奨）。トークンはこのページのメモリにだけ置き、保存しません。</p>
<form id="auth-form"><input id="token" type="password" autocomplete="off" spellcheck="false" aria-label="人間のトークン"><button type="submit">接続</button></form>
</section>
<section id="view" hidden>
<h2>判断待ち</h2><div id="decisions"></div>
<h2>受信箱</h2><div id="inbox"></div>
<h2>木</h2><div id="tree"></div>
</section>
</main>
<script src="/ui/app.js"></script>
</body>
</html>
`;

export const UI_CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#59636e;--line:#d0d7de;--card:#f6f8fa;--blocking:#cf222e;--failed:#bc4c00;--ok:#1a7f37}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--card:#161b22;--blocking:#ff7b72;--failed:#ffa657;--ok:#3fb950}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:baseline;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:20px 0 8px}
main{padding:0 16px 32px;max-width:960px;margin:0 auto}
.status{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:6px 0;overflow-wrap:anywhere}
.card.blocking{border-left:4px solid var(--blocking)}.card.failed{border-left:4px solid var(--failed)}
.tag{display:inline-block;font-size:12px;color:var(--muted);margin-right:8px}
.tag.blocking{color:var(--blocking);font-weight:600}.tag.failed{color:var(--failed);font-weight:600}
.node{padding:2px 0;overflow-wrap:anywhere}.state{color:var(--muted);margin-left:8px;font-size:13px}.count{color:var(--blocking);margin-left:8px;font-size:13px}
.empty{color:var(--muted)}
input,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
form{display:flex;gap:8px;flex-wrap:wrap}input{flex:1;min-width:200px}
`;

export const UI_JS = `'use strict';
(function () {
  // 最初に、フラグメントのトークンを取り出して、アドレスから消す（履歴に残さない）。
  var token = '';
  var hash = window.location.hash;
  if (hash.length > 1) {
    var m = /(?:^|[#&])token=([^&]*)/.exec(hash);
    if (m) {
      try { token = decodeURIComponent(m[1]); } catch (e) { token = ''; }
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  var TAGS = { div: true, span: true, p: true };
  var STATE_NAMES = { pending: '未起動', running: '実行', waiting: '待機', done: '完了報告', verified: '受理', stopping: '停止中', stopIncomplete: '停止未完了', stopped: '停止', reclaimable: '回収可', archived: 'アーカイブ' };
  var PRIORITY_NAMES = { blocking: '要判断', failed: '失敗', completed: '完了', progress: '進捗', info: '情報' };
  var POLL_MS = 2000;

  var statusEl = document.getElementById('status');
  var authEl = document.getElementById('auth');
  var viewEl = document.getElementById('view');
  var timer = null;

  function name(table, key) { return Object.hasOwn(table, key) ? table[key] : key; }
  function el(tag, cls, text) {
    if (!Object.hasOwn(TAGS, tag)) throw new Error('tag');
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setStatus(text) { statusEl.textContent = text; }
  function showAuth(show) { authEl.hidden = !show; viewEl.hidden = show; }

  function renderDecisions(list) {
    var box = document.getElementById('decisions');
    clear(box);
    if (!list.length) { box.appendChild(el('p', 'empty', '判断待ちはありません')); return; }
    list.forEach(function (d) {
      var card = el('div', 'card blocking');
      card.appendChild(el('span', 'tag blocking', '判断待ち'));
      card.appendChild(el('span', 'tag', d.nodeId));
      card.appendChild(el('div', '', d.question || '（質問の記録なし）'));
      d.options.forEach(function (o) { card.appendChild(el('div', 'tag', '・' + o)); });
      box.appendChild(card);
    });
  }

  function renderExtensions(list, box) {
    list.forEach(function (x) {
      var card = el('div', 'card');
      card.appendChild(el('span', 'tag', '拡張要求'));
      card.appendChild(el('span', 'tag', x.nodeId));
      card.appendChild(el('div', '', x.reason));
      box.appendChild(card);
    });
  }

  function renderInbox(list) {
    var box = document.getElementById('inbox');
    clear(box);
    if (!list.length) { box.appendChild(el('p', 'empty', '未解決の項目はありません')); return; }
    list.forEach(function (i) {
      var card = el('div', 'card ' + (i.priority === 'blocking' || i.priority === 'failed' ? i.priority : ''));
      card.appendChild(el('span', 'tag ' + (i.priority === 'blocking' || i.priority === 'failed' ? i.priority : ''), name(PRIORITY_NAMES, i.priority)));
      card.appendChild(el('span', 'tag', i.kind));
      card.appendChild(el('span', 'tag', i.nodeId));
      card.appendChild(el('span', 'tag', i.at));
      if (i.summary) card.appendChild(el('div', '', i.summary));
      box.appendChild(card);
    });
  }

  // 描いたノードの数を返す（木にならない・深すぎるもので、描けなかった分は、呼び出し側が「一部省略」にする）。
  function renderTree(nodes) {
    var box = document.getElementById('tree');
    clear(box);
    if (!nodes.length) { box.appendChild(el('p', 'empty', 'ノードはありません')); return 0; }
    var kids = new Map();
    nodes.forEach(function (n) {
      var k = n.parentId === null ? '' : n.parentId;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k).push(n);
    });
    var seen = new Set();
    function walk(parent, depth) {
      (kids.get(parent) || []).forEach(function (n) {
        if (seen.has(n.id) || depth > 64) return;
        seen.add(n.id);
        var row = el('div', 'node');
        row.style.paddingLeft = (depth * 20) + 'px';
        row.appendChild(el('span', '', n.id));
        row.appendChild(el('span', 'state', n.role + ' / ' + name(STATE_NAMES, n.state)));
        if (n.openItems > 0) row.appendChild(el('span', 'count', '要対応 ' + n.openItems));
        box.appendChild(row);
        walk(n.id, depth + 1);
      });
    }
    walk('', 0);
    return seen.size;
  }

  function render(view) {
    renderDecisions(view.decisions);
    renderExtensions(view.extensions, document.getElementById('decisions'));
    renderInbox(view.inbox);
    var drawn = renderTree(view.nodes);
    showAuth(false);
    var partial = view.truncated.length > 0 || drawn < view.nodes.length;
    setStatus('接続中（seq ' + view.lastSeq + (partial ? '・一部省略' : '') + '）');
  }

  var etag = '';
  function refresh() {
    if (!token) { showAuth(true); setStatus('未接続'); return Promise.resolve(); }
    var headers = etag
      ? { authorization: 'Bearer ' + token, 'if-none-match': etag }
      : { authorization: 'Bearer ' + token };
    return fetch('/v1/ui/state', { headers: headers })
      .then(function (res) {
        if (res.status === 304) { return { unchanged: true }; }
        if (res.status === 401) { token = ''; etag = ''; showAuth(true); setStatus('トークンが正しくありません'); return null; }
        if (res.status === 403) { token = ''; etag = ''; showAuth(true); setStatus('人間のトークンが必要です'); return null; }
        if (!res.ok) { setStatus('取得に失敗（' + res.status + '）。再試行します'); return null; }
        etag = res.headers.get('etag') || '';
        return res.json();
      })
      .then(function (body) {
        if (body && body.unchanged) return;
        if (body && body.ok) render(body.value);
      })
      .catch(function () { setStatus('daemon に接続できません。再試行します'); });
  }

  function loop() {
    refresh().then(function () { timer = window.setTimeout(loop, POLL_MS); });
  }

  document.getElementById('auth-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = document.getElementById('token');
    token = input.value.trim();
    input.value = '';
    if (timer !== null) window.clearTimeout(timer);
    loop();
  });

  loop();
})();
`;

/** 画面の応答ヘッダー（CSP など）。インラインを許さず、同じ origin の資産と通信だけを許す。 */
export const UI_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
};

/** HTML だけに付けるヘッダー（ほかのオリジンのページと、ウィンドウを共有しない。使わない機能を許さない）。 */
export const UI_HTML_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()",
};
