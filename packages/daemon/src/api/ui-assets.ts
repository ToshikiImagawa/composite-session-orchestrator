/**
 * HTML 画面の静的な資産（T23。FR_021・IR_003）。依存を増やさず、素の JavaScript で書く（TS の文字列として埋め込むので、ビルドで複製が要らない）。
 *
 * 描画の規則（`ui-assets.test.ts` が走査で守らせる）:
 * - 文字列は `textContent` と `createElement` だけで描く。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・`new Function`・
 *   `setAttribute`・`on*` への代入・`location` への代入・`srcdoc` は使わない。
 * - インラインの script・style・イベント属性は置かない（CSP が `'self'` だけを許す）。
 * - 取り消せない操作（最終削除・保管の削除。T23-d）は、確認の表示で、対象の ID を打ち込ませ、完全に一致するまで送れない（`typedMatches`）。
 *   通信は `callOperation` の 1 か所だけ（事前確認・一覧の読み取りも同じ）。
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
<h2>最終削除（アーカイブ済みの木）</h2><div id="purge"></div>
<h2>破棄した成果の保管</h2><div id="kept"></div>
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
.node button{margin-left:8px;padding:2px 8px;font-size:13px}.node{padding:2px 0;overflow-wrap:anywhere}.state{color:var(--muted);margin-left:8px;font-size:13px}.count{color:var(--blocking);margin-left:8px;font-size:13px}
.empty{color:var(--muted)}
button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.opts{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
button.primary{background:var(--blocking);color:#fff;border-color:var(--blocking)}
textarea{display:block;width:100%;min-height:64px;margin:6px 0;font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.confirm{border:2px solid var(--blocking);border-radius:6px;padding:4px 12px 12px;margin:16px 0;background:var(--card)}
.confirm-title{font-weight:600;margin:10px 0 6px}.confirm-line{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.error{color:var(--blocking);margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.notice{color:var(--ok);margin:12px 0}.notice.bad{color:var(--blocking)}
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
  // 通知。bad が真なら、失敗として赤で出す。
  function notice(text, bad) {
    var n = document.getElementById('notice');
    n.textContent = text;
    n.className = bad ? 'notice bad' : 'notice';
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
    var hint = failureHint(e && e.code);
    // 先端が変わった（または確かめられない）ときは、同じ内容では、何度送っても通らない。確かめ直させる
    if (hint) return base + '\\n' + hint;
    // 再送して意味があるのは、待てば通りうるもの（429。ネットワークの失敗は、sendPending の catch）だけ。判断の失敗（4xx）は、同じ内容では、結果が変わらない
    if (r.status === 429) return base + '\\n同じ内容で、もう一度送れます（同じ要求として扱われ、二重には実行されません）。';
    return base + '\\n同じ内容を送り直しても、結果は変わりません。「戻る」で、状態を確かめてから、やり直してください。';
  }
  // 失敗の種類ごとの案内。なければ ''。
  function failureHint(code) {
    if (code === 'tipMismatch' || code === 'tipUnknown') return '表示したあとで、先端が変わった（または確かめられない）ため、何も指示していません。もう一度、「破棄して回収を指示…」から、内容を確かめ直してください。';
    return '';
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
    if (pending.blocked) box.appendChild(el('p', 'error', pending.blocked));
    var typedBox = null;
    if (pending.typed !== undefined && !pending.blocked) {
      box.appendChild(el('p', '', '取り消せません。確認のため、次の文字列を、そのまま打ち込んでください: ' + pending.typed));
      typedBox = el('textarea', '');
      typedBox.rows = 1;
      typedBox.maxLength = 300;
      typedBox.value = pending.typedValue;
      typedBox.disabled = pending.sending;
      box.appendChild(typedBox);
    }
    if (pending.error) box.appendChild(el('p', 'error', pending.error));
    var actions = el('div', 'actions');
    // 429 のときは、Retry-After の秒数のあいだ、送れない（時間が来たら、自動で、押せるようになる）
    var left = pending.retryAt ? Math.ceil((pending.retryAt - Date.now()) / 1000) : 0;
    var waiting = left > 0;
    var send = el('button', 'primary', pending.sending ? '送信中…' : waiting ? 'あと ' + left + ' 秒待つ' : 'この内容で送る');
    var refreshSend = function () {
      send.disabled = pending.sending || waiting || Boolean(pending.blocked) || (pending.typed !== undefined && !typedMatches(pending.typed, pending.typedValue));
    };
    refreshSend();
    if (typedBox) {
      var current = pending;
      typedBox.addEventListener('input', function () {
        if (pending !== current) return;
        current.typedValue = typedBox.value;
        refreshSend();
      });
    }
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
  // opts.typed: 打ち込ませる文字列（取り消せない操作）。opts.blocked: 送れない理由（出して、送らせない）。opts.after: 成功のあとに呼ぶ関数。
  function openConfirm(title, lines, operation, params, done, opts) {
    if (pending && pending.sending) return;
    if (!window.crypto || !window.crypto.randomUUID) { notice('このブラウザでは、操作できません（crypto.randomUUID がありません）', true); return; }
    notice('');
    var o = opts || {};
    pending = { title: title, lines: lines, operation: operation, params: params, done: done, requestId: window.crypto.randomUUID(), sending: false, error: '', retryAt: 0, typed: o.typed, typedValue: '', blocked: o.blocked || '', after: o.after };
    renderConfirm();
  }
  // 打ち込みの確認: 打ち込む文字列が決まっていて、入力が完全に一致するときだけ（前後の空白・大文字小文字・全角の違いは、すべて不一致）。
  function typedMatches(typed, input) {
    return typeof typed === 'string' && typed !== '' && typeof input === 'string' && input === typed;
  }
  // 通信は、ここだけ。要求の識別子は、呼び出し側が決める（確認の間は同じ ID で再送する）。401 はトークンを破棄して null。
  function callOperation(operation, params, requestId) {
    return fetch('/v1/request', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestId, operation: operation, params: params })
    })
      .then(function (res) {
        if (res.status === 401) { rejectToken('トークンが正しくありません'); return null; }
        var retry = res.status === 429 ? parseInt(res.headers.get('retry-after') || '', 10) : 0;
        return res.json().then(
          function (body) { return { status: res.status, body: body, retry: retry }; },
          function () { return { status: res.status, body: null, retry: retry }; }
        );
      });
  }
  // 読み取りの操作（事前確認・一覧）の結果。{ ok: true, value } か { ok: false, error: { code, cause, status } }（通知は出さない。
  // 失敗の種類（tipMismatch など）を、呼び出し側が区別できる）。ネットワークの失敗は code が 'network'、401 はトークンを破棄して null。
  function readOperationResult(operation, params) {
    if (!window.crypto || !window.crypto.randomUUID) return Promise.resolve({ ok: false, error: { code: 'unsupported', cause: 'このブラウザでは、操作できません（crypto.randomUUID がありません）', status: 0 } });
    return callOperation(operation, params, window.crypto.randomUUID())
      .then(function (r) {
        if (r === null) return null;
        if (r.status === 200 && r.body && r.body.ok === true) return { ok: true, value: r.body.value };
        var e = r.body && r.body.error;
        return { ok: false, error: { code: e && typeof e.code === 'string' ? e.code : 'http', cause: e ? String(e.cause || '').slice(0, 300) : 'HTTP ' + r.status, status: r.status } };
      })
      .catch(function () { return { ok: false, error: { code: 'network', cause: 'daemon に接続できません', status: 0 } }; });
  }
  // 読み取りの操作。成功なら値、失敗なら通知（赤）に理由を出して null。
  function readOperation(operation, params) {
    return readOperationResult(operation, params).then(function (r) {
      if (r === null) return null;
      if (r.ok) return r.value;
      notice('失敗: ' + r.error.code + ': ' + r.error.cause, true);
      return null;
    });
  }
  function sendPending() {
    var p = pending;
    if (!p || p.sending) return;
    if (p.blocked || (p.typed !== undefined && !typedMatches(p.typed, p.typedValue))) return; // 打ち込みが一致しない・送れない理由があるときは、送らない
    p.sending = true;
    p.error = '';
    renderConfirm();
    callOperation(p.operation, p.params, p.requestId)
      .then(function (r) {
        p.sending = false;
        if (r === null) { pending = null; renderConfirm(); return; }
        if (r.status === 200 && r.body && r.body.ok === true) {
          pending = null;
          renderConfirm();
          notice(p.done);
          if (p.after) p.after();
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
  var DECISION_NOTES = { split: 'この対象は許可しない。子には、作業を切り出して進めるよう通知される' };
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
            [['ノード', x.nodeId], ['種類', x.kind ? name(KIND_LABELS, x.kind) : '（不明）'], ['対象', x.targetHidden ? '（表示できない）' : x.target], ['理由', x.reason], ['判定', DECISION_LABELS[decision] + (Object.hasOwn(DECISION_NOTES, decision) ? '（' + DECISION_NOTES[decision] + '）' : '')]],
            'scope.decide',
            { extensionId: x.id, decision: decision },
            '拡張要求を' + DECISION_LABELS[decision] + 'しました'
          );
        });
        opts.appendChild(b);
      });
      card.appendChild(opts);
      if (x.targetHidden) card.appendChild(el('p', 'error', '対象に、表示できない文字・絶対パス・.. ・長すぎる値などが含まれるため、承認・切り出しはできません（却下だけできます）。子に、相対パス・単純なコマンドで要求し直すよう依頼してください。'));
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
        // 停止したノードだけ、破棄の判断（回収の指示。T23-c）ができる。指示済みなら、もう一度は出さない
        if (n.state === 'stopped') {
          if (n.discarded) row.appendChild(el('span', 'tag', '破棄を指示済み（回収は統合ノードが行う）'));
          else if (ID_RE.test(n.id)) {
            var reclaim = el('button', '', '破棄して回収を指示…');
            reclaim.addEventListener('click', function () { startReclaim(n.id); });
            row.appendChild(reclaim);
          }
        }
        box.appendChild(row);
        walk(n.id, depth + 1);
      });
    }
    walk('', 0);
    return seen.size;
  }

  // ---- 回収の指示（T23-c。人間による破棄の判断。取り消せない）----
  var EXPECT_TIPS_MAX = 256;
  var CLI_HINT = 'cli（cso reclaim <ノード ID>）で、確かめてください。';
  var UNMET_NAMES = {
    stateNotEligible: '状態が、回収の対象でない', discardRequired: '破棄の判断が要る', factsMissing: '事実が足りない',
    notMerged: '統合されていない', dirty: '未保存の変更がある', dependentsIncomplete: '依存先が未完了', openDecision: '未回答の判断がある',
    descendantsNotReclaimable: '配下が回収できない', processesRunning: 'プロセスが動いている', processesUnknown: 'プロセスを調べられない'
  };
  // 事前確認（node.reclaimPreview）の結果の形。tips は、あれば、ノード ID から先端（文字列）への対応。
  function isReclaimPreview(v) {
    if (!v || typeof v !== 'object' || typeof v.reclaimable !== 'boolean' || !Array.isArray(v.unmet) || !Array.isArray(v.blockers)) return false;
    if (v.loss !== undefined && !Array.isArray(v.loss)) return false;
    if (v.tips !== undefined) {
      if (!v.tips || typeof v.tips !== 'object' || Array.isArray(v.tips)) return false;
      if (!Object.keys(v.tips).every(function (k) { return typeof v.tips[k] === 'string'; })) return false;
    }
    return true;
  }
  // 送れない理由（フェイルクローズ）。送れるなら ''。失われるものが分からないまま、取り消せない指示は出さない。
  function reclaimBlocked(v) {
    if (v.loss === undefined) return '失われるものの情報が得られませんでした（古い daemon です）。' + CLI_HINT;
    var unknown = v.loss.filter(function (l) { return l && (l.unknown === true || l.workingTreeUnknown === true); });
    if (unknown.length) {
      var ids = unknown.map(function (l) { return cleanText(String(l.nodeId), 128); }).join('、');
      return '失われるものを調べられなかったノードがあります（' + ids + '）。失われるものが分からないまま、破棄は指示できません。' + CLI_HINT;
    }
    var n = v.tips ? Object.keys(v.tips).length : 0;
    if (n > EXPECT_TIPS_MAX) return 'ノードが多すぎて、先端の照合ができません（' + n + ' 件。' + EXPECT_TIPS_MAX + ' 件まで）。' + CLI_HINT;
    return '';
  }
  function lossText(l) {
    var parts = [];
    parts.push(typeof l.aheadCommits === 'number' ? '統合されていないコミット ' + l.aheadCommits + ' 件' : '統合されていないコミットの数は不明');
    parts.push(l.uncommitted ? '追跡中のファイルの未保存の変更あり' : '未保存の変更なし');
    parts.push('未追跡のファイル ' + Number(l.untracked) + ' 件');
    return parts.join('。');
  }
  // 確認の表示（事前確認の結果）。パスは含まれない。件名は、信頼できない入力なので、整える。
  function reclaimLines(nodeId, v) {
    var lines = [
      ['対象', nodeId],
      ['内容', '破棄の判断は、取り消せません。停止したノードの作業ツリーとブランチが、強制して消えます。記録されるのは、この対象だけです（配下の停止ノードは、別に指示が必要です）']
    ];
    v.unmet.slice(0, 10).forEach(function (u) { lines.push(['満たしていない条件', name(UNMET_NAMES, String(u))]); });
    if (v.unmet.length > 10) lines.push(['満たしていない条件', 'ほか ' + (v.unmet.length - 10) + ' 件']);
    v.blockers.slice(0, 10).forEach(function (b) {
      var who = b && b.kind === 'process' ? 'プロセス ' + Number(b.pid) : 'ノード ' + cleanText(String(b && b.nodeId), 128);
      lines.push(['原因', who + '（' + name(UNMET_NAMES, String(b && b.reason)) + '）']);
    });
    if (v.blockers.length > 10) lines.push(['原因', 'ほか ' + (v.blockers.length - 10) + ' 件']);
    var loss = v.loss || [];
    var lossHead = '失われるもの（この対象と配下。配下は、それぞれの指示のときに失われる）';
    if (!loss.length) lines.push([lossHead, 'なし']);
    else lines.push([lossHead, loss.length + ' 件のノード']);
    loss.slice(0, NODE_LIST_MAX).forEach(function (l) {
      lines.push(['  ノード ' + cleanText(String(l.nodeId), 128), lossText(l)]);
      (Array.isArray(l.untrustedSubjects) ? l.untrustedSubjects : []).slice(0, 5).forEach(function (subject) {
        lines.push(['  コミットの件名（信頼できない入力）', cleanText(String(subject), 100)]);
      });
    });
    if (loss.length > NODE_LIST_MAX) lines.push(['  失われるもの', 'ほか ' + (loss.length - NODE_LIST_MAX) + ' 件（表示を省略。破棄の対象には、すべて含まれる）']);
    var tips = v.tips || {};
    var tipIds = Object.keys(tips).sort();
    tipIds.slice(0, NODE_LIST_MAX).forEach(function (k) {
      lines.push(['ブランチの先端（' + cleanText(k, 128) + '）', cleanText(tips[k].slice(0, 12), 12)]);
    });
    if (tipIds.length > NODE_LIST_MAX) lines.push(['ブランチの先端', 'ほか ' + (tipIds.length - NODE_LIST_MAX) + ' 件（すべて、照合に含める）']);
    lines.push(['照合', '見せた先端を、そのまま、指示に添えます。指示の時点で、先端が変わっていたら、何も記録されません']);
    return lines;
  }
  function startReclaim(nodeId) {
    readOperationResult('node.reclaimPreview', { nodeId: nodeId }).then(function (r) {
      if (r === null) return;
      if (!r.ok) { notice('失敗: ' + r.error.code + ': ' + r.error.cause, true); return; }
      var v = r.value;
      if (!isReclaimPreview(v)) { notice('事前確認の結果の形が不正です', true); return; }
      // 見せた先端（tips）を、作り直さずに、そのまま渡す。daemon が、今の先端と照合する（違えば tipMismatch）。
      var params = { nodeId: nodeId, expectTips: v.tips || {} };
      openConfirm('回収の指示（破棄）', reclaimLines(nodeId, v), 'node.reclaimInstruct', params, '破棄を指示しました（' + nodeId + '）。実際の回収は、統合ノードが行います', { typed: nodeId, blocked: reclaimBlocked(v) });
    });
  }

  // ---- 最終削除・保留・保管（T23-d。取り消せない操作は、対象の ID を打ち込ませる）----
  var REASON_MAX = 200;
  var HOLD_CHOICES = [{ label: '無期限', days: 0 }, { label: '30 日', days: 30 }, { label: '90 日', days: 90 }];
  var NODE_LIST_MAX = 20;
  var EXPECT_NODE_IDS_MAX = 2000;
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
  var reasonDrafts = new Map();
  var keptList = null;
  var purgeSignature = null;
  var keptLoading = false;
  // 最終削除の対象になりうる木の根: アーカイブ済みで、親がないか、親がアーカイブされていないノード。
  function purgeRoots(nodes) {
    var byId = new Map();
    nodes.forEach(function (n) { byId.set(n.id, n); });
    return nodes.filter(function (n) {
      if (n.state !== 'archived') return false;
      if (n.parentId === null) return true;
      var parent = byId.get(n.parentId);
      return !parent || parent.state !== 'archived';
    });
  }
  // 保留の期限（ISO 8601 UTC。ミリ秒なし）。days が 0 なら、期限なし（undefined）。
  function holdUntil(days, nowMs) {
    if (!(days > 0)) return undefined;
    return new Date(nowMs + days * 86400000).toISOString().replace(/\\.\\d{3}Z$/, 'Z');
  }
  // 保留の理由の検査（任意。空は可）。問題がなければ ''。
  function checkReason(text) {
    if (text.trim() === '') return '';
    if (Array.from(text).length > REASON_MAX) return '理由が長すぎます（' + REASON_MAX + ' 文字以下）';
    if (Array.from(text).some(function (ch) { return FORBIDDEN.test(ch); })) return '理由に、使えない文字（制御文字・書式制御文字）が含まれています';
    return '';
  }
  // 信頼できない文字列（コミットの件名・タイトル）を、端末・画面に出す前に整える（制御文字・書式制御文字を空白に。1 行。長さを切る）。
  function cleanText(text, max) {
    var flat = Array.from(String(text)).map(function (ch) { return FORBIDDEN.test(ch) ? ' ' : ch; }).join('').replace(/\\s+/g, ' ').trim();
    var chars = Array.from(flat);
    return chars.length <= max ? flat : chars.slice(0, max - 1).join('') + '…';
  }
  function isPurgePreview(v) {
    return v && typeof v === 'object' && Array.isArray(v.nodeIds) && v.nodeIds.every(function (x) { return typeof x === 'string'; }) &&
      typeof v.archivedAt === 'string' && typeof v.elapsedDays === 'number' && typeof v.retentionDays === 'number' &&
      typeof v.tombstoneTitle === 'string' && typeof v.purgeable === 'boolean' && Array.isArray(v.blockers);
  }
  // 最終削除の確認の表示（事前確認の結果）。
  function purgeLines(rootId, v, tombstone) {
    var ids = v.nodeIds.slice(0, NODE_LIST_MAX).map(function (x) { return cleanText(x, 128); }).join('、');
    var more = v.nodeIds.length > NODE_LIST_MAX ? '、ほか ' + (v.nodeIds.length - NODE_LIST_MAX) + ' 件' : '';
    var lines = [
      ['木の根', rootId],
      ['削除されるノード', v.nodeIds.length + ' 件（' + ids + more + '）'],
      ['アーカイブ日', cleanText(v.archivedAt, 40) + '（経過 ' + v.elapsedDays + ' 日 / 保持期間 ' + v.retentionDays + ' 日）'],
      ['墓標', (tombstone === false ? '残さない' : tombstone === true ? '残す' : '保持ポリシーの既定に従う') + '（タイトル: ' + cleanText(v.tombstoneTitle, 100) + '）']
    ];
    if (typeof v.discardedRefs === 'number' && v.discardedRefs > 0) lines.push(['一緒に消える保管', v.discardedRefs + ' 件の、破棄した成果（取り出すなら、先に保管の一覧から）']);
    if (v.hold && typeof v.hold === 'object') lines.push(['保留', '保留中（ノード ' + cleanText(String(v.hold.nodeId || ''), 128) + (v.hold.until ? '。' + cleanText(String(v.hold.until), 40) + ' まで' : '。無期限') + '）。保留は自動の削除だけを止める。この最終削除は、保留を無視して消す']);
    v.blockers.slice(0, 10).forEach(function (b) {
      lines.push(['実行できない理由', cleanText(String(b && b.code), 60) + ': ' + cleanText(String(b && b.cause), 300)]);
    });
    return lines;
  }
  // 今の保留の状態（事前確認の hold）。取れなければ、取れなかったと出す（なし、とは言わない）。
  function holdStatusLine(rootId) {
    return readOperationResult('node.purgePreview', { nodeId: rootId }).then(function (r) {
      if (r === null || !r.ok) return '（取得できなかった）';
      var h = r.value && r.value.hold;
      if (!h || typeof h !== 'object') return 'なし';
      var until = typeof h.until === 'string' ? cleanText(h.until, 40) + ' まで' : '無期限';
      var reason = typeof h.reason === 'string' && h.reason !== '' ? '。理由: ' + cleanText(h.reason, 200) : '';
      return '保留中（ノード ' + cleanText(String(h.nodeId || ''), 128) + '。' + until + reason + '）';
    });
  }
  function startPurge(rootId, tombstone) {
    readOperation('node.purgePreview', { nodeId: rootId }).then(function (v) {
      if (v === null) return;
      if (!isPurgePreview(v)) { notice('事前確認の結果の形が不正です', true); return; }
      // 見せた木（削除されるノード）を渡す。見せたあとで木が変わっていたら、daemon が消さない（purgeStale）。
      var params = tombstone === undefined ? { nodeId: rootId } : { nodeId: rootId, tombstone: tombstone };
      params.expectNodeIds = v.nodeIds;
      var blocked = v.purgeable ? '' : 'この木は、いま最終削除できません（上の理由を取り除いてから、もう一度確認してください）';
      if (v.nodeIds.length > EXPECT_NODE_IDS_MAX) blocked = '木のノードが多すぎて、安全に確認できません（' + v.nodeIds.length + ' 件。' + EXPECT_NODE_IDS_MAX + ' 件まで）';
      openConfirm('最終削除', purgeLines(rootId, v, tombstone), 'node.purge', params, '最終削除しました（' + rootId + '）', { typed: rootId, blocked: blocked });
    });
  }
  function renderPurge(nodes) {
    var roots = purgeRoots(nodes).map(function (n) { return n.id; });
    var signature = roots.join('\\n');
    if (signature === purgeSignature) return; // 根の集合が変わらなければ、描き直さない（入力中の理由を消さない）
    purgeSignature = signature;
    reasonDrafts.forEach(function (_v, key) { if (roots.indexOf(key) < 0) reasonDrafts.delete(key); });
    var box = document.getElementById('purge');
    clear(box);
    if (!roots.length) { box.appendChild(el('p', 'empty', '最終削除の対象になりうる、アーカイブ済みの木はありません')); return; }
    roots.forEach(function (id) {
      var card = el('div', 'card');
      card.appendChild(el('span', 'tag', 'アーカイブ済みの木'));
      card.appendChild(el('span', '', id));
      var del = el('div', 'opts');
      var b1 = el('button', '', '最終削除…（墓標は既定）');
      b1.addEventListener('click', function () { startPurge(id, undefined); });
      var b2 = el('button', '', '墓標を残さずに最終削除…');
      b2.addEventListener('click', function () { startPurge(id, false); });
      del.appendChild(b1);
      del.appendChild(b2);
      card.appendChild(del);
      var area = el('textarea', '');
      area.maxLength = REASON_MAX;
      area.placeholder = '自動の最終削除を保留する理由（任意。' + REASON_MAX + ' 文字まで）';
      area.value = reasonDrafts.get(id) || '';
      area.addEventListener('input', function () { reasonDrafts.set(id, area.value); });
      card.appendChild(area);
      var problem = el('p', 'error', '');
      problem.hidden = true;
      var hold = el('div', 'opts');
      HOLD_CHOICES.forEach(function (c) {
        var b = el('button', '', '自動削除を保留（' + c.label + '）…');
        b.addEventListener('click', function () {
          var why = checkReason(area.value);
          problem.textContent = why;
          problem.hidden = why === '';
          if (why !== '') return;
          var until = holdUntil(c.days, Date.now());
          var params = { nodeId: id };
          if (until !== undefined) params.until = until;
          if (area.value.trim() !== '') params.reason = area.value;
          var reason = area.value;
          holdStatusLine(id).then(function (current) {
            openConfirm('自動の最終削除の保留', [['木の根', id], ['今の保留', current], ['新しい期限', until === undefined ? '無期限' : until + ' まで（' + c.label + '）。今の保留は、置き換わる'], ['理由', reason.trim() === '' ? '（なし）' : reason]], 'node.purgeHold', params, '保留しました（' + id + '）');
          });
        });
        hold.appendChild(b);
      });
      var rel = el('button', '', '保留を解除…');
      rel.addEventListener('click', function () {
        holdStatusLine(id).then(function (current) {
          openConfirm('保留の解除', [['木の根', id], ['今の保留', current], ['内容', '保留を解除する（解除後は、保持期間と予告の条件を、改めて満たすまで消えない）']], 'node.purgeRelease', { nodeId: id }, '保留を解除しました（' + id + '）');
        });
      });
      hold.appendChild(rel);
      card.appendChild(hold);
      card.appendChild(problem);
      box.appendChild(card);
    });
  }
  function loadKept() {
    if (keptLoading) return;
    keptLoading = true;
    readOperation('node.discardedList', {}).then(function (v) {
      keptLoading = false;
      if (v === null) return;
      if (!v || !Array.isArray(v.items) || typeof v.max !== 'number') { notice('保管の一覧の形が不正です', true); return; }
      keptList = v;
      renderKept();
    });
  }
  function renderKept() {
    var box = document.getElementById('kept');
    clear(box);
    var load = el('button', '', keptList ? '一覧を読み込み直す' : '一覧を読み込む');
    load.addEventListener('click', loadKept);
    box.appendChild(load);
    if (!keptList) return;
    box.appendChild(el('p', 'empty', '保管: ' + keptList.items.length + ' 件 / 上限 ' + keptList.max + ' 件（自動では更新しません。取り出す・消すのあとは、読み込み直します）'));
    keptList.items.forEach(function (i) {
      if (typeof i.key !== 'string' || typeof i.tip !== 'string') return;
      var keyOk = ID_RE.test(i.key); // ID の形でない key には、操作を出さない（daemon も、ID の形でない target を拒む）
      var card = el('div', 'card');
      card.appendChild(el('span', 'tag', cleanText(i.key, 128)));
      card.appendChild(el('span', 'tag', i.nodeId ? 'ノード ' + cleanText(i.nodeId, 128) : '孤立'));
      card.appendChild(el('span', 'tag', '先端 ' + cleanText(i.tip.slice(0, 12), 12)));
      if (i.committedAt) card.appendChild(el('span', 'tag', cleanText(i.committedAt, 40)));
      if (i.untrustedSubject) card.appendChild(el('div', '', '件名（信頼できない入力）: 「' + cleanText(i.untrustedSubject, 100) + '」'));
      var opts = el('div', 'opts');
      var restore = el('button', '', 'ブランチに取り出す…');
      restore.addEventListener('click', function () {
        openConfirm('保管の取り出し', [['保管', cleanText(i.key, 128)], ['先端', cleanText(i.tip.slice(0, 12), 12)], ['内容', '新しいブランチ（cso/restored/<保管の名前>）を作る。既存のブランチは上書きしない。保管は残る']], 'node.discardedRestore', { target: i.key }, 'ブランチを作りました', { after: loadKept });
      });
      var drop = el('button', '', '保管を消す…');
      drop.addEventListener('click', function () {
        openConfirm('保管の削除', [['保管', cleanText(i.key, 128)], ['ノード', i.nodeId ? cleanText(i.nodeId, 128) : '孤立'], ['先端', cleanText(i.tip.slice(0, 12), 12) + '（一覧で見た先端と今の先端が違えば、消さない）']], 'node.discardedDrop', { target: i.key, expectTip: i.tip }, '保管を消しました', { typed: i.key, after: loadKept });
      });
      if (keyOk) {
        opts.appendChild(restore);
        opts.appendChild(drop);
        card.appendChild(opts);
      } else {
        card.appendChild(el('p', 'error', 'この保管の名前は、ID の形でないため、画面からは操作できません（cso discarded で操作してください）'));
      }
      box.appendChild(card);
    });
  }

  function render(view) {
    renderDecisions(view.decisions);
    renderExtensions(view.extensions, document.getElementById('decisions'));
    if (!view.decisions.length && !view.extensions.length) document.getElementById('decisions').appendChild(el('p', 'empty', '判断待ちはありません'));
    renderInbox(view.inbox);
    var drawn = renderTree(view.nodes);
    renderPurge(view.nodes);
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
    token = ''; etag = ''; lastView = null; generation += 1; sseUp = false; keptList = null; purgeSignature = null; pending = null;
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

  renderKept();
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
