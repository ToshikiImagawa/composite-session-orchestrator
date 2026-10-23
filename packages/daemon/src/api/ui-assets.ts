/**
 * HTML 画面の静的な資産（T23。FR_021・IR_003）。依存を増やさず、素の JavaScript で書く（TS の文字列として埋め込むので、ビルドで複製が要らない）。
 *
 * 描画の規則（`ui-assets.test.ts` が走査で守らせる）:
 * - 文字列は `textContent` と `createElement` だけで描く。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・`new Function`・
 *   `setAttribute`・`on*` への代入・`location` への代入・`srcdoc` は使わない。
 * - インラインの script・style・イベント属性は置かない（CSP が `'self'` だけを許す）。
 * - 操作（判断への回答・拡張要求の判定）は、`<form>` を使わず、ボタンの click で、`POST /v1/request`（`Authorization: Bearer`。cookie は使わない）で送る。
 *   送る前に、必ず確認の表示（内容と回答）を挟む。確認のたびに `requestId` を新しく作り、その確認の間は同じ ID で再送する。
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
<section id="confirm" class="confirm" hidden></section>
<p id="notice" class="notice" hidden></p>
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
button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.opts{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
button.primary{background:var(--blocking);color:#fff;border-color:var(--blocking)}
textarea{display:block;width:100%;min-height:64px;margin:6px 0;font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.confirm{border:2px solid var(--blocking);border-radius:6px;padding:4px 12px 12px;margin:16px 0;background:var(--card)}
.confirm-title{font-weight:600;margin:10px 0 6px}.confirm-line{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.error{color:var(--blocking);margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.notice{color:var(--ok);margin:12px 0}
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

  var TAGS = { div: true, span: true, p: true, button: true, textarea: true };
  var TEXT_MAX = 4000;
  var FORBIDDEN = /[\\p{Cc}\\p{Cf}]/u;
  var STATE_NAMES = { pending: '未起動', running: '実行', waiting: '待機', done: '完了報告', verified: '受理', stopping: '停止中', stopIncomplete: '停止未完了', stopped: '停止', reclaimable: '回収可', archived: 'アーカイブ' };
  var PRIORITY_NAMES = { blocking: '要判断', failed: '失敗', completed: '完了', progress: '進捗', info: '情報' };
  var POLL_MS = 2000;
  var SAFETY_MS = 30000;
  var THROTTLE_MS = 1000;
  var BACKOFF_MIN = 1000;
  var BACKOFF_MAX = 30000;

  var statusEl = document.getElementById('status');
  var authEl = document.getElementById('auth');
  var viewEl = document.getElementById('view');
  var timer = null;
  var lastView = null;
  var sseUp = false;
  var generation = 0;
  var backoff = BACKOFF_MIN;
  var lastRefreshAt = 0;
  var refreshing = false;
  var again = false;
  var controller = null;
  var throttleTimer = null;
  var drafts = new Map();
  var pending = null;
  var retryMs = 0;

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

  // ---- 操作（判断への回答）----
  function hasForbidden(text) {
    return Array.from(text).some(function (ch) { return ch !== '\\t' && ch !== '\\n' && FORBIDDEN.test(ch); });
  }
  // 自由入力の回答の検査。制御文字・書式制御文字は、サーバーの検証と同じ規則（タブ・改行は可）。上限（TEXT_MAX）は、サーバー（64 KiB）より厳しい。問題がなければ ''。
  function checkAnswer(text) {
    if (text.trim() === '') return '回答が空です（空白だけは送れません）';
    var n = Array.from(text).length;
    if (n > TEXT_MAX) return '長すぎます（' + n + ' 文字。' + TEXT_MAX + ' 文字以下）';
    if (hasForbidden(text)) return '使えない文字（制御文字・書式制御文字）を含んでいます';
    return '';
  }
  function notice(text) {
    var n = document.getElementById('notice');
    n.textContent = text;
    n.hidden = !text;
  }
  // 429 のとき、送り直すまで待つ秒数（Retry-After。なければ 5 秒）。それ以外は 0。
  function waitSecondsOf(r) {
    return r.status === 429 ? (r.retry > 0 ? r.retry : 5) : 0;
  }
  function describeFailure(r) {
    var e = r.body && r.body.error;
    var base = e && typeof e.code === 'string' ? e.code + ': ' + String(e.cause || '').slice(0, 300) : 'HTTP ' + r.status;
    if (r.status === 429) base += '（' + (r.retry > 0 ? r.retry + ' 秒' : 'しばらく') + '待ってから、もう一度送る）';
    return base + '\\n同じ内容で、もう一度送れます（同じ要求として扱われ、二重には実行されません）。';
  }
  function renderConfirm() {
    var box = document.getElementById('confirm');
    clear(box);
    if (!pending) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('div', 'confirm-title', pending.title + '（確認）'));
    pending.lines.forEach(function (line) {
      var row = el('div', 'confirm-line');
      row.appendChild(el('span', 'tag', line[0]));
      row.appendChild(el('span', '', line[1]));
      box.appendChild(row);
    });
    if (pending.error) box.appendChild(el('p', 'error', pending.error));
    var actions = el('div', 'actions');
    // 429 のときは、Retry-After の秒数のあいだ、送れない（時間が来たら、自動で、押せるようになる）
    var left = pending.retryAt ? Math.ceil((pending.retryAt - Date.now()) / 1000) : 0;
    var waiting = left > 0;
    var send = el('button', 'primary', pending.sending ? '送信中…' : waiting ? 'あと ' + left + ' 秒待つ' : 'この内容で送る');
    send.disabled = pending.sending || waiting;
    if (waiting) {
      var shown = pending;
      window.setTimeout(function () { if (pending === shown) renderConfirm(); }, 500);
    }
    send.addEventListener('click', sendPending);
    var back = el('button', '', '戻る');
    back.disabled = pending.sending;
    back.addEventListener('click', function () { pending = null; renderConfirm(); });
    actions.appendChild(send);
    actions.appendChild(back);
    box.appendChild(actions);
  }
  // 確認を出す。確認のたびに requestId を新しく作る（その確認の間は、同じ ID で再送する）。
  function openConfirm(title, lines, operation, params, done) {
    if (pending && pending.sending) return;
    if (!window.crypto || !window.crypto.randomUUID) { notice('このブラウザでは、操作できません（crypto.randomUUID がありません）'); return; }
    notice('');
    pending = { title: title, lines: lines, operation: operation, params: params, done: done, requestId: window.crypto.randomUUID(), sending: false, error: '', retryAt: 0 };
    renderConfirm();
  }
  function sendPending() {
    var p = pending;
    if (!p || p.sending) return;
    p.sending = true;
    p.error = '';
    renderConfirm();
    fetch('/v1/request', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: p.requestId, operation: p.operation, params: p.params })
    })
      .then(function (res) {
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        var retry = res.status === 429 ? parseInt(res.headers.get('retry-after') || '', 10) : 0;
        return res.json().then(
          function (body) { return { status: res.status, body: body, retry: retry }; },
          function () { return { status: res.status, body: null, retry: retry }; }
        );
      })
      .then(function (r) {
        p.sending = false;
        if (r === null) { pending = null; renderConfirm(); return; }
        if (r.status === 200 && r.body && r.body.ok === true) {
          pending = null;
          renderConfirm();
          notice(p.done);
          refresh();
          return;
        }
        p.error = describeFailure(r);
        var wait = waitSecondsOf(r);
        p.retryAt = wait > 0 ? Date.now() + wait * 1000 : 0;
        if (pending === p) renderConfirm();
      })
      .catch(function () {
        p.sending = false;
        p.error = '送れませんでした（daemon に接続できません）。\\n同じ内容で、もう一度送れます（同じ要求として扱われ、二重には実行されません）。';
        if (pending === p) renderConfirm();
      });
  }

  function renderDecisions(list) {
    var box = document.getElementById('decisions');
    var active = document.activeElement;
    var keep = active && active.dataset ? active.dataset.draft : '';
    var areas = new Map();
    clear(box);
    var live = new Set();
    list.forEach(function (d) {
      live.add(d.id);
      var card = el('div', 'card blocking');
      card.appendChild(el('span', 'tag blocking', '判断待ち'));
      card.appendChild(el('span', 'tag', d.nodeId));
      var question = d.question || '（質問の記録なし）';
      card.appendChild(el('div', '', question));
      var opts = el('div', 'opts');
      var anyCut = d.optionsCut;
      d.options.forEach(function (o) {
        var b = el('button', '', o.text);
        // 切った・文字を除いた選択肢は、そのままでは choice に送れない（別の文字列を送ってしまう）。ボタンを無効にして、自由入力を促す
        b.disabled = o.truncated;
        if (o.truncated) anyCut = true;
        b.addEventListener('click', function () {
          openConfirm('判断への回答', [['ノード', d.nodeId], ['判断', question], ['回答（選択肢）', o.text]], 'decision.answer', { decisionId: d.id, choice: o.text }, '回答を送りました');
        });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (anyCut) card.appendChild(el('p', 'error', '長すぎる（または、表示できない文字を含む・数が多い）選択肢があります。長すぎるため、自由入力で回答してください'));
      var area = el('textarea', '');
      area.maxLength = TEXT_MAX;
      area.placeholder = '自由入力で回答（' + TEXT_MAX + ' 文字まで）';
      area.dataset.draft = d.id;
      area.value = drafts.get(d.id) || '';
      area.addEventListener('input', function () { drafts.set(d.id, area.value); });
      areas.set(d.id, area);
      card.appendChild(area);
      var problem = el('p', 'error', '');
      problem.hidden = true;
      var free = el('button', '', '自由入力で回答する');
      free.addEventListener('click', function () {
        var text = area.value;
        var why = checkAnswer(text);
        problem.textContent = why;
        problem.hidden = why === '';
        if (why !== '') return;
        openConfirm('判断への回答', [['ノード', d.nodeId], ['判断', question], ['回答（自由入力）', text]], 'decision.answer', { decisionId: d.id, text: text }, '回答を送りました');
      });
      card.appendChild(free);
      card.appendChild(problem);
      box.appendChild(card);
    });
    drafts.forEach(function (_v, id) { if (!live.has(id)) drafts.delete(id); });
    if (keep && areas.has(keep)) {
      var ta = areas.get(keep);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  // 拡張要求の判定（scope.decide）。許可する対象は、daemon が記録済みの対象をそのまま使う（画面の表示と一致する）。
  // 対象が隠れている（絶対パス・.. ・制御文字・長すぎる、など）ときは、承認・切り出しをさせない（却下だけ）。
  var DECISION_LABELS = { approve: '承認', reject: '却下', split: '切り出し' };
  var KIND_LABELS = { write: '書き込みの場所', command: 'コマンド' };
  function renderExtensions(list, box) {
    list.forEach(function (x) {
      var card = el('div', 'card');
      card.appendChild(el('span', 'tag', '拡張要求'));
      card.appendChild(el('span', 'tag', x.nodeId));
      if (x.kind) card.appendChild(el('span', 'tag', name(KIND_LABELS, x.kind)));
      card.appendChild(el('div', '', x.reason));
      card.appendChild(el('div', 'confirm-line', x.targetHidden ? '対象: （表示できない）' : '対象: ' + x.target));
      var opts = el('div', 'opts');
      ['approve', 'reject', 'split'].forEach(function (decision) {
        var b = el('button', '', DECISION_LABELS[decision]);
        b.disabled = x.targetHidden && decision !== 'reject';
        b.addEventListener('click', function () {
          openConfirm(
            '拡張要求の' + DECISION_LABELS[decision],
            [['ノード', x.nodeId], ['種類', x.kind ? name(KIND_LABELS, x.kind) : '（不明）'], ['対象', x.targetHidden ? '（表示できない）' : x.target], ['理由', x.reason], ['判定', DECISION_LABELS[decision]]],
            'scope.decide',
            { extensionId: x.id, decision: decision },
            '拡張要求を' + DECISION_LABELS[decision] + 'しました'
          );
        });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (x.targetHidden) card.appendChild(el('p', 'error', '対象に、表示できない文字・絶対パス・.. ・長すぎる値などが含まれるため、承認・切り出しはできません（却下だけできます）。'));
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
    if (!view.decisions.length && !view.extensions.length) document.getElementById('decisions').appendChild(el('p', 'empty', '判断待ちはありません'));
    renderInbox(view.inbox);
    var drawn = renderTree(view.nodes);
    showAuth(false);
    var partial = view.truncated.length > 0 || drawn < view.nodes.length;
    lastView = { seq: view.lastSeq, partial: partial };
    showConnected();
  }

  var etag = '';

  function showConnected() {
    if (!lastView) return;
    setStatus('接続中（' + (sseUp ? 'SSE' : 'ポーリング') + '・seq ' + lastView.seq + (lastView.partial ? '・一部省略' : '') + '）');
  }
  function rejectToken(message) {
    token = ''; etag = ''; lastView = null; generation += 1; sseUp = false;
    if (controller) controller.abort();
    showAuth(true); setStatus(message);
  }

  function fetchState() {
    var headers = etag
      ? { authorization: 'Bearer ' + token, 'if-none-match': etag }
      : { authorization: 'Bearer ' + token };
    return fetch('/v1/ui/state', { headers: headers })
      .then(function (res) {
        if (res.status === 304) { return { unchanged: true }; }
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        if (res.status === 403) { rejectToken('人間のトークンが必要です'); return null; }
        if (!res.ok) { setStatus('取得に失敗（' + res.status + '）。再試行します'); return null; }
        etag = res.headers.get('etag') || '';
        return res.json();
      })
      .then(function (body) {
        if (body && body.ok) render(body.value);
      })
      .catch(function () { setStatus('daemon に接続できません。再試行します'); });
  }

  // 同時に 1 回だけ取る。取っている間に通知が来たら、終わってからもう 1 回取る。
  function refresh() {
    if (!token) { showAuth(true); setStatus('未接続'); return Promise.resolve(); }
    if (refreshing) { again = true; return Promise.resolve(); }
    refreshing = true;
    lastRefreshAt = Date.now();
    return fetchState().then(function () {
      refreshing = false;
      if (again) { again = false; return refresh(); }
    });
  }

  // 通知が続いても、状態を取り直すのは、最短 THROTTLE_MS ごと（先頭で 1 回、間に来たものは末尾で 1 回）。
  function requestRefresh() {
    if (throttleTimer !== null) return;
    var wait = THROTTLE_MS - (Date.now() - lastRefreshAt);
    if (wait <= 0) { refresh(); return; }
    throttleTimer = window.setTimeout(function () { throttleTimer = null; refresh(); }, wait);
  }

  // SSE（変更の通知）。fetch の ReadableStream で読む（EventSource は header を付けられない）。切れたら、指数バックオフで再接続する。
  // 使えない間（接続できない・未対応）は、下の loop が、ETag つきのポーリングで取る。
  function connectEvents(gen) {
    if (!token || gen !== generation) return;
    if (typeof TextDecoder === 'undefined') return;
    controller = new AbortController();
    fetch('/v1/events', { headers: { authorization: 'Bearer ' + token }, signal: controller.signal })
      .then(function (res) {
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        if (res.status === 403) { rejectToken('人間のトークンが必要です'); return null; }
        if (res.status === 429) {
          var seconds = parseInt(res.headers.get('retry-after') || '', 10);
          retryMs = seconds > 0 ? Math.min(seconds, 300) * 1000 : 0;
        }
        if (!res.ok || !res.body || !res.body.getReader) throw new Error('sse');
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        sseUp = true;
        backoff = BACKOFF_MIN;
        showConnected();
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) throw new Error('closed');
            buf += decoder.decode(r.value, { stream: true });
            var end = buf.indexOf('\\n\\n');
            while (end >= 0) {
              var block = buf.slice(0, end);
              buf = buf.slice(end + 2);
              if (block.indexOf('event: seq') >= 0) requestRefresh();
              end = buf.indexOf('\\n\\n');
            }
            if (buf.length > 4096) buf = '';
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {})
      .then(function () {
        sseUp = false;
        showConnected();
        if (gen !== generation || !token) return;
        // 429 のときは、Retry-After の秒数より前には、再接続しない
        var wait = Math.max(backoff, retryMs) + Math.floor(Math.random() * 500);
        retryMs = 0;
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        window.setTimeout(function () { connectEvents(gen); }, wait);
      });
  }

  // SSE が上がっている間は、安全のために、まれに取り直す。上がっていない間は、POLL_MS ごと（ETag で、変化がなければ 304）。
  function loop(gen) {
    if (gen !== generation) return;
    var due = !sseUp || Date.now() - lastRefreshAt >= SAFETY_MS;
    (due ? refresh() : Promise.resolve()).then(function () { timer = window.setTimeout(function () { loop(gen); }, POLL_MS); });
  }

  function start() {
    generation += 1;
    if (controller) controller.abort();
    sseUp = false;
    backoff = BACKOFF_MIN;
    if (timer !== null) window.clearTimeout(timer);
    var gen = generation;
    // 取れなかった（トークンが拒まれた）ときは、世代が進むので、接続も周期も始めない（表示を上書きしない）。
    refresh().then(function () { connectEvents(gen); loop(gen); });
  }

  document.getElementById('auth-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = document.getElementById('token');
    token = input.value.trim();
    input.value = '';
    start();
  });

  start();
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
