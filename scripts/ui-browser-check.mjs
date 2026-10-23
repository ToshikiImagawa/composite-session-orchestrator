/**
 * HTML 画面を、実際のブラウザで確かめる（T23。手動の確認用。CI には入れない。手順は docs/manual-verification-ui.md）。
 * 前提: `pnpm build` 済み。Playwright は依存に加えない（環境にあるものを、`CSO_PLAYWRIGHT` のパスで読む）。
 * 使い方: CSO_PLAYWRIGHT=$(npm root -g)/playwright node scripts/ui-browser-check.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const R = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");
const require = createRequire(import.meta.url);
const playwrightPath = process.env.CSO_PLAYWRIGHT;
if (playwrightPath === undefined) throw new Error("CSO_PLAYWRIGHT（playwright のパス）を指定する");
const { chromium } = require(playwrightPath);
const { foldEvents } = await import(`${R}/core/dist/index.js`);
const { createCredentialStore } = await import(`${R}/daemon/dist/api/credentials.js`);
const { createApiServer } = await import(`${R}/daemon/dist/api/server.js`);
const HUMAN = "human-token-human-token-human-token-1234";
let n = 0;
const ev = (b) => ({
  seq: ++n,
  at: "2026-10-20T00:00:00Z",
  requestId: `r${n}`,
  actor: { system: true },
  ...b,
});
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
const r = foldEvents([
  ev({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  }),
  ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
  ev({
    type: "node.created",
    payload: { nodeId: "m1", role: "integrator", parentId: "root", dependsOn: [] },
  }),
  ev({ type: "node.stateChanged", payload: { nodeId: "m1", event: { type: "start" } } }),
  ev({
    type: "node.created",
    payload: { nodeId: "a", role: "implement", parentId: "m1", dependsOn: [] },
  }),
  ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
  ev({ type: "inbox.added", payload: { id: "p1", kind: "progress", nodeId: "a", summary: XSS } }),
  ev({
    type: "inbox.added",
    payload: { id: "i1", kind: "info", nodeId: "a", summary: "情報です" },
  }),
]);
if (!r.ok) throw new Error(r.error.code + r.error.cause);
let state = r.value;
// Object.prototype のキーと同じ名前のノード（描画で、表の引き当てを間違えないこと）
state = {
  ...state,
  nodes: [
    ...state.nodes,
    { id: "constructor", role: "implement", parentId: "m1", state: "running", dependsOn: [] },
    // アーカイブ済みの木（T23-d。最終削除の対象）: arch1（削除できる）と arch2（できない）
    { id: "arch1", role: "integrator", parentId: null, state: "archived", dependsOn: [] },
    { id: "arch1c", role: "implement", parentId: "arch1", state: "archived", dependsOn: [] },
    { id: "arch2", role: "integrator", parentId: null, state: "archived", dependsOn: [] },
  ],
};
let kept = [
  {
    key: "k1-aaaaaaaaaaaa",
    tip: "a".repeat(40),
    nodeId: "arch1c",
    orphan: false,
    committedAt: "2026-10-01T00:00:00Z",
    untrustedSubject: `件名 \u001b[31m${XSS}`,
  },
];
state = {
  ...state,
  decisions: [
    {
      decisionId: "d1",
      nodeId: "a",
      status: "open",
      question: XSS,
      options: ["A案", XSS],
      rejected: [],
    },
    {
      decisionId: "d2",
      nodeId: "a",
      status: "open",
      question: "自由入力の判断",
      options: [],
      rejected: [],
    },
    {
      decisionId: "d3",
      nodeId: "a",
      status: "open",
      question: `長い質問。${"問".repeat(2500)}`,
      options: ["短い選択肢", "長".repeat(600)],
      rejected: [],
    },
  ],
};
// 拡張要求（T23-b）: x1 は表示してよい対象、x2 は絶対パスにあたる対象（隠れる）、x3 は XSS 文字列の理由
state = {
  ...state,
  extensions: [
    {
      extensionId: "x1",
      nodeId: "a",
      status: "open",
      reason: "テストを足したい",
      target: { kind: "write", value: "src/ok.ts" },
    },
    {
      extensionId: "x2",
      nodeId: "a",
      status: "open",
      reason: "外へ書きたい",
      target: { kind: "write", value: "../outside/secret" },
    },
    {
      extensionId: "x3",
      nodeId: "a",
      status: "open",
      reason: XSS,
      target: { kind: "command", value: "pnpm test" },
    },
  ],
};
// 操作の呼び出しの記録（画面の操作の確認用）。d2 の最初の回答は、失敗させる（失敗の表示と、同じ要求 ID での再送の確認）
const calls = [];
let failD2Once = true;
const bump = (patch) => {
  state = { ...state, ...patch, lastSeq: state.lastSeq + 1 };
};
const handlers = {
  "decision.answer": async (req) => {
    calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
    await new Promise((r) => setTimeout(r, 150));
    if (req.params.decisionId === "d2" && failD2Once) {
      failD2Once = false;
      return {
        ok: false,
        error: {
          code: "conflict",
          cause: "別の回答が先に確定している",
          nextActions: ["状態を取り直す"],
        },
      };
    }
    bump({ decisions: state.decisions.filter((d) => d.decisionId !== req.params.decisionId) });
    return { ok: true, value: { accepted: true } };
  },
};
handlers["node.purgePreview"] = async (req) => {
  calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
  const blocked = req.params.nodeId === "arch2";
  return {
    ok: true,
    value: {
      nodeIds: blocked ? ["arch2"] : ["arch1", "arch1c"],
      archivedAt: "2026-10-01T00:00:00Z",
      elapsedDays: 22,
      retentionDays: 14,
      tombstoneTitle: "削除する木",
      purgeable: !blocked,
      blockers: blocked ? [{ code: "dependedOn", cause: "木の外のノードが依存している" }] : [],
      discardedRefs: blocked ? 0 : 1,
    },
  };
};
handlers["node.purge"] = async (req) => {
  calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
  await new Promise((r) => setTimeout(r, 100));
  bump({ nodes: state.nodes.filter((n) => !["arch1", "arch1c"].includes(n.id)) });
  return { ok: true, value: { purged: ["arch1", "arch1c"] } };
};
handlers["node.purgeHold"] = async (req) => {
  calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
  return { ok: true, value: { held: true } };
};
handlers["node.discardedList"] = async (req) => {
  calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
  return { ok: true, value: { items: kept, max: 200 } };
};
handlers["node.discardedDrop"] = async (req) => {
  calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
  kept = kept.filter((k) => k.key !== req.params.target);
  return { ok: true, value: { dropped: true, key: req.params.target, tip: req.params.expectTip } };
};
handlers["scope.decide"] = async (req) => {
  calls.push({ operation: req.operation, requestId: req.requestId, params: req.params });
  await new Promise((r) => setTimeout(r, 100));
  bump({ extensions: state.extensions.filter((x) => x.extensionId !== req.params.extensionId) });
  return { ok: true, value: { state: "running" } };
};
const credentials = createCredentialStore({ humanToken: HUMAN });
const server = createApiServer({ credentials, getState: () => state, handlers });
const { url } = await server.listen(0);
const browser = await chromium.launch({
  executablePath: process.env.CSO_CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const out = {};
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({
    colorScheme: scheme,
    viewport: { width: 900, height: 900 },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("dialog", (d) => {
    errors.push(`dialog:${d.message()}`);
    d.dismiss();
  });
  await page.goto(`${url}/ui#token=${HUMAN}`);
  await page.waitForSelector("#view:not([hidden])", { timeout: 8000 });
  out[scheme] = {
    urlAfter: page.url(),
    xss: await page.evaluate(() => window.__xss ?? null),
    imgCount: await page.locator("#view img, #view script").count(),
    treeText: await page.locator("#tree").innerText(),
    status: await page.locator("#status").innerText(),
    errors,
  };
  await page.screenshot({ path: join(process.env.CSO_OUT ?? ".", `ui-${scheme}.png`) });
  await ctx.close();
}
// 貼り付けの経路
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${url}/ui`);
out.pasteFormVisible = await page.locator("#auth").isVisible();
await page.fill("#token", "wrong-token-wrong-token-wrong-token-1");
await page.click("button[type=submit]");
await page.waitForTimeout(800);
out.wrongStatus = await page.locator("#status").innerText();
// 人間以外のトークン（403）は、401 と分けて表示する
await page.fill("#token", credentials.issueNodeToken("root", "integrator"));
await page.click("button[type=submit]");
await page.waitForTimeout(800);
out.nonHumanStatus = await page.locator("#status").innerText();
const statuses = [];
page.on("response", (res) => {
  if (res.url().endsWith("/v1/ui/state")) statuses.push(res.status());
});
await page.fill("#token", HUMAN);
await page.click("button[type=submit]");
await page.waitForSelector("#view:not([hidden])", { timeout: 8000 });
await page.waitForFunction(
  () => document.getElementById("status").innerText.includes("SSE"),
  null,
  { timeout: 8000 },
);
out.pasteOk = await page.locator("#status").innerText(); // SSE で接続している
// 変化がない間は、304（描き直さない）
await page.waitForTimeout(5000);
out.statusesBeforeChange = [...statuses];
statuses.length = 0;
// 更新（状態の変化が、ポーリングで反映される）
state = {
  ...state,
  inbox: [
    ...state.inbox,
    {
      seq: 99,
      id: "f9",
      kind: "info",
      nodeId: "a",
      dependsOn: [],
      at: "2026-10-20T00:00:01Z",
      summary: "新しい項目",
    },
  ],
  lastSeq: 99,
};
const t0 = Date.now();
await page.waitForFunction(
  () => document.getElementById("inbox").innerText.includes("新しい項目"),
  null,
  { timeout: 5000 },
);
out.reflectMs = Date.now() - t0;
out.statusesAfterChange = [...statuses]; // 変わった直後は 200（新しい ETag）、そのあとは 304
// ---- 操作（T23 PR3）: 判断への回答 ----
const ops = {};
const pageO = await (await browser.newContext()).newPage();
const opErrors = [];
pageO.on("pageerror", (e) => opErrors.push(String(e)));
pageO.on("dialog", (d) => {
  opErrors.push(`dialog:${d.message()}`);
  d.dismiss();
});
await pageO.goto(`${url}/ui#token=${HUMAN}`);
await pageO.waitForSelector("#view:not([hidden])", { timeout: 8000 });
const confirmText = async () =>
  (await pageO.locator("#confirm").isVisible()) ? pageO.locator("#confirm").innerText() : "";
// (a) 選択肢で回答 → 確認画面（質問と回答が、もう一度出る）→ 戻る → もう一度 → 二重クリックでも要求は 1 回
await pageO.locator("#decisions .card").first().waitFor();
const card1 = pageO.locator("#decisions .card").first();
await card1.getByRole("button", { name: "A案", exact: true }).click();
ops.confirmShown =
  (await confirmText()).includes("A案") && (await confirmText()).includes("判断への回答");
ops.noRequestBeforeConfirm = calls.length === 0;
await pageO.getByRole("button", { name: "戻る" }).click();
ops.backHidesConfirm = !(await pageO.locator("#confirm").isVisible());
await card1.getByRole("button", { name: "A案", exact: true }).click();
await pageO.getByRole("button", { name: "この内容で送る" }).dblclick();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("回答を送りました"),
  null,
  { timeout: 5000 },
);
ops.callsAfterDoubleClick = calls.length; // 1
ops.answeredParams = calls[0]?.params;
await pageO
  .waitForFunction(
    () => ![...document.querySelectorAll("#decisions button")].some((b) => b.textContent === "A案"),
    null,
    {
      timeout: 5000,
    },
  )
  .then(
    () => {
      ops.d1Gone = true;
    },
    () => {
      ops.d1Gone = false;
    },
  );
// (b) 自由入力: 空・制御文字は、確認に進まない。改行つきの回答は、確認に出る
const card2 = pageO.locator("#decisions .card", { hasText: "自由入力の判断" });
await card2.getByRole("button", { name: "自由入力で回答する" }).click();
ops.emptyRejected =
  (await card2.innerText()).includes("回答が空です") &&
  !(await pageO.locator("#confirm").isVisible());
await card2.locator("textarea").fill("a\u0007b");
await card2.getByRole("button", { name: "自由入力で回答する" }).click();
ops.controlCharRejected =
  (await card2.innerText()).includes("使えない文字") &&
  !(await pageO.locator("#confirm").isVisible());
await card2.locator("textarea").fill("一行目\n二行目");
// 状態が更新されて再描画されても、入力中の文は残る
await new Promise((r) => setTimeout(r, 300));
bump({});
await pageO.waitForTimeout(1500);
ops.draftKeptOnRerender = (await card2.locator("textarea").inputValue()) === "一行目\n二行目";
await card2.getByRole("button", { name: "自由入力で回答する" }).click();
ops.multilineInConfirm =
  (await confirmText()).includes("一行目") && (await confirmText()).includes("二行目");
// (c) 失敗: 理由が出て、確認に戻る。同じ内容で再送でき、同じ requestId
await pageO.getByRole("button", { name: "この内容で送る" }).click();
await pageO.waitForFunction(
  () => document.getElementById("confirm").innerText.includes("conflict"),
  null,
  { timeout: 5000 },
);
ops.failureShown = (await confirmText()).includes("別の回答が先に確定している");
await pageO.getByRole("button", { name: "この内容で送る" }).click();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("回答を送りました"),
  null,
  { timeout: 5000 },
);
const d2Calls = calls.filter((c) => c.params.decisionId === "d2");
ops.retrySameRequestId = d2Calls.length === 2 && d2Calls[0].requestId === d2Calls[1].requestId;
ops.requestIdIsUuid = /^[0-9a-f-]{36}$/.test(d2Calls[0]?.requestId ?? "");
// (d) 長い質問・長い選択肢: 質問は 2,000 文字まで読め、超えたら印。長い選択肢のボタンは無効（自由入力を促す）
const card3 = pageO.locator("#decisions .card", { hasText: "長い質問" });
const q3 = await card3.innerText();
ops.longQuestionShownUpTo2000 = q3.includes("問".repeat(1990)) && q3.includes("…（省略）");
ops.shortOptionEnabled = await card3.getByRole("button", { name: "短い選択肢" }).isEnabled();
ops.longOptionDisabled = await card3.locator("button:disabled", { hasText: "…（省略）" }).count();
ops.longOptionNote = q3.includes("自由入力で回答してください");
// (e) 429: Retry-After の秒数のあいだ、送れない。時間が来たら、同じ requestId で送れる
let n429 = 0;
await pageO.route("**/v1/request", (route) => {
  n429 += 1;
  if (n429 > 1) return route.continue();
  return route.fulfill({
    status: 429,
    headers: { "retry-after": "2", "content-type": "application/json" },
    body: JSON.stringify({
      ok: false,
      error: { code: "tooManyRequests", cause: "要求が多すぎる" },
    }),
  });
});
await card3.getByRole("button", { name: "短い選択肢" }).click();
ops.longQuestionInConfirm = (await confirmText()).includes("問".repeat(1990));
await pageO.getByRole("button", { name: "この内容で送る" }).click();
await pageO.waitForFunction(
  () => document.getElementById("confirm").innerText.includes("tooManyRequests"),
  null,
  { timeout: 5000 },
);
ops.sendDisabledWhile429 = await pageO.locator("#confirm button.primary").isDisabled();
ops.sendLabelWhile429 = await pageO.locator("#confirm button.primary").innerText();
await pageO.waitForFunction(
  () => !document.querySelector("#confirm button.primary").disabled,
  null,
  { timeout: 6000 },
);
ops.sendEnabledAfterWait = await pageO.locator("#confirm button.primary").isEnabled();
await pageO.getByRole("button", { name: "この内容で送る" }).click();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("回答を送りました"),
  null,
  { timeout: 5000 },
);
await pageO.unroute("**/v1/request");
const d3Calls = calls.filter((c) => c.params.decisionId === "d3");
ops.answeredOnceAfter429 = d3Calls.length === 1; // 429 は、サーバーに届いていない（route で止めた）。待ったあとの 1 回だけが届く
// (f) 子が書いた質問・選択肢の XSS 文字列は、実行されない（確認画面でも）
ops.xssNotExecuted = (await pageO.evaluate(() => window.__xss ?? null)) === null;
// (g) 拡張要求の判定（T23-b）: 対象を表示 → 確認（対象つき）→ 送信。許可する対象は送らない（daemon が記録済みの対象を使う）
const ext1 = pageO.locator("#decisions .card", { hasText: "テストを足したい" });
await ext1.waitFor();
ops.ext1ShowsTarget = (await ext1.innerText()).includes("src/ok.ts");
await ext1.getByRole("button", { name: "承認", exact: true }).click();
const extConfirm = await confirmText();
ops.ext1ConfirmShowsTarget = extConfirm.includes("src/ok.ts") && extConfirm.includes("承認");
await pageO.getByRole("button", { name: "この内容で送る" }).click();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("拡張要求を承認しました"),
  null,
  { timeout: 5000 },
);
const decideCalls = calls.filter((c) => c.operation === "scope.decide");
ops.ext1SentOnce =
  decideCalls.length === 1 &&
  JSON.stringify(decideCalls[0].params) ===
    JSON.stringify({ extensionId: "x1", decision: "approve" });
// 隠れた対象（x2）: 値は画面に出ない。承認・切り出しは無効で、却下だけ押せる
const ext2 = pageO.locator("#decisions .card", { hasText: "外へ書きたい" });
await ext2.waitFor();
ops.ext2HidesValue = !(await ext2.innerText()).includes("outside");
ops.ext2ApproveDisabled = await ext2
  .getByRole("button", { name: "承認", exact: true })
  .isDisabled();
ops.ext2SplitDisabled = await ext2
  .getByRole("button", { name: "切り出し", exact: true })
  .isDisabled();
ops.ext2RejectEnabled = await ext2.getByRole("button", { name: "却下", exact: true }).isEnabled();
// 子が書いた理由の XSS 文字列（x3）は、実行されない
ops.ext3Rendered =
  (await pageO.locator("#decisions .card", { hasText: "pnpm test" }).count()) === 1;
// (h) 最終削除（T23-d）: 打ち込むまで送れない。一致したら送れる。送る params は nodeId だけ
const sendBtn = () => pageO.locator("#confirm button.primary");
const typedArea = () => pageO.locator("#confirm textarea");
const arch1 = pageO.locator("#purge .card", { hasText: "arch1" }).first();
await arch1.waitFor();
await arch1.getByRole("button", { name: "最終削除…（墓標は既定）" }).click();
await pageO.locator("#confirm").waitFor();
const purgeConfirm = await confirmText();
ops.purgeConfirmShowsPreview =
  purgeConfirm.includes("2 件") &&
  purgeConfirm.includes("削除する木") &&
  purgeConfirm.includes("1 件の、破棄した成果");
ops.purgeSendDisabledAtFirst = await sendBtn().isDisabled();
for (const wrong of ["arch", "arch1 ", " arch1", "ARCH1", "ａｒｃｈ１"]) {
  await typedArea().fill(wrong);
  if (!(await sendBtn().isDisabled())) ops.purgeWrongTypedEnabled = wrong;
}
ops.purgeWrongTypedStayDisabled = ops.purgeWrongTypedEnabled === undefined;
await typedArea().fill("arch1");
ops.purgeSendEnabledWhenTyped = await sendBtn().isEnabled();
ops.purgeNoRequestBeforeSend = calls.filter((c) => c.operation === "node.purge").length === 0;
await sendBtn().click();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("最終削除しました"),
  null,
  { timeout: 5000 },
);
const purgeCalls = calls.filter((c) => c.operation === "node.purge");
ops.purgeSentOnce =
  purgeCalls.length === 1 &&
  JSON.stringify(purgeCalls[0].params) === JSON.stringify({ nodeId: "arch1" });
await pageO.waitForFunction(
  () => !document.getElementById("purge").innerText.includes("arch1"),
  null,
  {
    timeout: 5000,
  },
);
ops.purgeCardGone = true;
// 実行できない木（arch2）: 理由が出て、打ち込みの欄もなく、送れない
await pageO
  .locator("#purge .card", { hasText: "arch2" })
  .getByRole("button", { name: "最終削除…（墓標は既定）" })
  .click();
await pageO.locator("#confirm").waitFor();
const blockedText = await confirmText();
ops.blockedShowsReason =
  blockedText.includes("木の外のノードが依存している") &&
  blockedText.includes("いま最終削除できません");
ops.blockedSendDisabled = await sendBtn().isDisabled();
ops.blockedNoTypedArea = (await typedArea().count()) === 0;
await pageO.getByRole("button", { name: "戻る" }).click();
// 保留（取り消せる操作。打ち込みなしの通常の確認）
await pageO
  .locator("#purge .card", { hasText: "arch2" })
  .getByRole("button", { name: "自動削除を保留（30 日）…" })
  .click();
await pageO.locator("#confirm").waitFor();
ops.holdNoTypedArea = (await typedArea().count()) === 0;
await sendBtn().click();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("保留しました"),
  null,
  { timeout: 5000 },
);
const holdCalls = calls.filter((c) => c.operation === "node.purgeHold");
ops.holdUntilIsIso30Days =
  holdCalls.length === 1 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(holdCalls[0].params.until) &&
  Math.abs(Date.parse(holdCalls[0].params.until) - (Date.now() + 30 * 86400000)) < 120000;
// (i) 保管（T23-d）: 一覧は、読み込みボタンで取る。件名は信頼できない入力（制御文字を除き、実行されない）
ops.keptNotLoadedAtFirst = (await pageO.locator("#kept .card").count()) === 0;
await pageO.getByRole("button", { name: "一覧を読み込む" }).click();
await pageO.locator("#kept .card").first().waitFor();
const keptText = await pageO.locator("#kept").innerText();
ops.keptShowsFields =
  keptText.includes("k1-aaaaaaaaaaaa") &&
  keptText.includes("arch1c") &&
  keptText.includes("先端 aaaaaaaaaaaa");
ops.keptSubjectCleaned = !keptText.includes("\u001b");
ops.keptTipNotFull = !keptText.includes("a".repeat(13));
await pageO.locator("#kept .card").first().getByRole("button", { name: "保管を消す…" }).click();
await pageO.locator("#confirm").waitFor();
ops.dropSendDisabledAtFirst = await sendBtn().isDisabled();
await typedArea().fill("k1-aaaaaaaaaaa");
ops.dropShortStillDisabled = await sendBtn().isDisabled();
await typedArea().fill("k1-aaaaaaaaaaaa");
await sendBtn().click();
await pageO.waitForFunction(
  () => document.getElementById("notice").innerText.includes("保管を消しました"),
  null,
  { timeout: 5000 },
);
const dropCalls = calls.filter((c) => c.operation === "node.discardedDrop");
ops.dropSentWithExpectTip =
  dropCalls.length === 1 &&
  JSON.stringify(dropCalls[0].params) ===
    JSON.stringify({ target: "k1-aaaaaaaaaaaa", expectTip: "a".repeat(40) });
await pageO.waitForFunction(
  () => document.getElementById("kept").innerText.includes("保管: 0 件"),
  null,
  {
    timeout: 5000,
  },
);
ops.keptReloadedAfterDrop = true;
ops.errors = opErrors;
out.operations = ops;

// SSE が使えないとき（上限 0 で、429）は、ポーリング（ETag）に切り替わる
const poll = createApiServer({
  credentials,
  getState: () => state,
  handlers: {},
  sse: { maxConnections: 0 },
});
const pollUrl = (await poll.listen(0)).url;
const page2 = await (await browser.newContext()).newPage();
const pollStatuses = [];
page2.on("response", (res) => {
  if (res.url().endsWith("/v1/ui/state")) pollStatuses.push(res.status());
});
await page2.goto(`${pollUrl}/ui#token=${HUMAN}`);
await page2.waitForFunction(
  () => document.getElementById("status").innerText.includes("ポーリング"),
  null,
  { timeout: 8000 },
);
out.fallbackStatus = await page2.locator("#status").innerText();
await page2.waitForTimeout(5000);
out.fallbackStatuses = [...pollStatuses]; // 200 のあと 304
// 429 のときは、Retry-After（5 秒）より前に、再接続しない
let retryRequests = 0;
const page4 = await (await browser.newContext()).newPage();
page4.on("request", (req) => {
  if (req.url().endsWith("/v1/events")) retryRequests += 1;
});
await page4.goto(`${pollUrl}/ui#token=${HUMAN}`);
await page4.waitForTimeout(4000);
out.eventRequestsWithin4sOf429 = retryRequests; // 1（Retry-After の 5 秒より前には、再接続しない）
// 通知が続いても、状態の取り直しは、最短 1 秒ごと（間引き）
const pageT = await (await browser.newContext()).newPage();
let stateRequests = 0;
pageT.on("request", (req) => {
  if (req.url().endsWith("/v1/ui/state")) stateRequests += 1;
});
await pageT.goto(`${url}/ui#token=${HUMAN}`);
await pageT.waitForFunction(
  () => document.getElementById("status").innerText.includes("SSE"),
  null,
  { timeout: 8000 },
);
await pageT.waitForTimeout(1500);
stateRequests = 0;
const tt = Date.now();
for (let i = 0; i < 30; i++) {
  state = { ...state, lastSeq: state.lastSeq + 1 };
  await pageT.waitForTimeout(100); // 3 秒の間、100ms ごとに変える（SSE の通知は 250ms ごと）
}
out.stateRequestsDuring3sOfChanges = stateRequests; // 最短 1 秒ごとなので、4 回前後（30 回ではない）
out.throttleWindowMs = Date.now() - tt;
// 切れたら、指数バックオフで再接続する（1 回目を中断させる）
let eventRequests = 0;
const page3 = await (await browser.newContext()).newPage();
await page3.route("**/v1/events", (route) => {
  eventRequests += 1;
  return eventRequests === 1 ? route.abort() : route.continue();
});
await page3.goto(`${url}/ui#token=${HUMAN}`);
const t1 = Date.now();
await page3.waitForFunction(
  () => document.getElementById("status").innerText.includes("SSE"),
  null,
  { timeout: 10000 },
);
out.reconnectMs = Date.now() - t1;
out.eventRequests = eventRequests;
await browser.close();
await poll.close();
await server.close();
console.log(JSON.stringify(out, null, 1));
