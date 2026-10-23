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
  ],
};
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
  ],
};
const credentials = createCredentialStore({ humanToken: HUMAN });
const server = createApiServer({ credentials, getState: () => state, handlers: {} });
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
