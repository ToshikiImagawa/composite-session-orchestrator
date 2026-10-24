// CSO のフック（T22-h）。Claude Code のフック入力（標準入力の JSON）を、daemon の受け口（パス v1/hook。POST）に送り、判定を返す。依存なし。
// - 受け口の URL とトークンは、環境変数 `CSO_DAEMON_URL`・`CSO_NODE_TOKEN` で受ける（パスを埋め込まない。NFR_012）。
// - どちらもないときは、CSO の子ではないセッションとみなし、素通しする（標準エラーに一言出す）。片方だけなら、設定の誤りとして拒否する。
// - PreToolUse は、フェイルクローズ: daemon に届かない・時間切れ・200 以外・応答の形が違う、のどれでも拒否する（終了コード 2）。
// - PostToolUse・Stop は（それ以外のイベント名・欠けた入力は、PreToolUse と同じく拒否する）、判定しない（拒否すると、作業を止められなくなるため）。失敗は、標準エラーに出すだけ（終了コード 0）。
// 終了コード 2 のとき、標準エラーの文が、拒否の理由として、モデルに伝わる。

import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 5000;
const PREFIX = "[cso-hook]";

/** フックを 1 回実行する。`{ code, stderr }` を返す（例外を出さない）。 */
export async function runHook({ env, input, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  let event;
  let body;
  try {
    body = JSON.parse(input);
    event = body?.hook_event_name;
  } catch {
    body = undefined;
  }
  // 受動のイベント（判定しない）だけを列挙し、それ以外（欠けている・未知・表記が違う）は、判定するものとして扱う（フェイルクローズ）。
  const passive = event === "PostToolUse" || event === "Stop";
  const guarding = !passive;
  const fail = (why) =>
    guarding
      ? { code: 2, stderr: `${PREFIX} 拒否: ${why}` }
      : { code: 0, stderr: `${PREFIX} ${event} を記録できなかった: ${why}` };

  const url = env.CSO_DAEMON_URL ?? "";
  const token = env.CSO_NODE_TOKEN ?? "";
  if (url === "" && token === "") {
    return {
      code: 0,
      stderr: `${PREFIX} CSO_DAEMON_URL と CSO_NODE_TOKEN がないため、CSO のフックは働いていない（CSO の子でなければ、問題ない）`,
    };
  }
  if (url === "" || token === "") {
    return fail("CSO_DAEMON_URL と CSO_NODE_TOKEN の片方だけが設定されている（両方を設定して起動する）");
  }
  if (body === undefined) return fail("フック入力が JSON でない");

  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/+$/, "")}/v1/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: input,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail(`daemon の受け口に届かない（${e?.name ?? "error"}）。daemon が動いているか確かめる`);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (res.status !== 200 || json?.ok !== true) {
    const cause = typeof json?.error?.cause === "string" ? `: ${json.error.cause}` : "";
    return fail(`daemon が拒否した（HTTP ${res.status}${cause}）`);
  }
  const decision = json.value?.decision;
  if (decision === "allow") return { code: 0, stderr: "" };
  if (decision === "deny" && guarding) {
    const reason = typeof json.value.reason === "string" ? json.value.reason : "範囲外の操作";
    return { code: 2, stderr: reason };
  }
  return fail("daemon の応答の形が正しくない");
}

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await runHook({ env: process.env, input: await readStdin() });
  if (r.stderr !== "") process.stderr.write(`${r.stderr}\n`);
  process.exit(r.code);
}
