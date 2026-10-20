/**
 * 受信箱の整列（FR_012）。I/O を持たない純粋関数。
 *
 * 規則: 優先度（要判断 > 失敗 > 完了 > 進捗 > 情報）で分け、同じ優先度の中は
 * 「依存先ノードの項目を、依存元ノードの項目より先」という制約だけを守るトポロジカル整列とする。
 * 制約のない項目どうしは時刻の昇順、同時刻は id の昇順（決定的、NFR_007）。
 *
 * 前提と扱い:
 * - `id` と `seq` は一意（`seq` は daemon が単調増加で採番する）。`id` が重複したときは `seq` が大きい方だけを残す。
 * - `at` は ISO 8601 UTC（`isValidInboxTime`）。不正な値は時刻の最後に置く。
 * - 項目を持たない中間ノードを経由する依存は、`nodeDeps`（ノード → 依存先）で渡す。`nodeDeps` は daemon が木から作る。
 * - 計算量は O(n³)（1000 件で約 541ms を実測）。Kahn 法と優先度付きキューにすれば O(n log n) にできる。
 *   現状の件数では十分なため未対応（design 9.2）。
 * - 依存が循環する（相互に先行する）ノードどうしには制約を課さない。
 */
import { INBOX_KIND_PRIORITY, type InboxKind, PRIORITIES } from "./inbox-kinds.js";

export interface InboxItem {
  /** daemon が採番する単調増加の番号。差分取得の cursor に使う。 */
  readonly seq: number;
  readonly id: string;
  readonly kind: InboxKind;
  /** 項目の発生元のノード。 */
  readonly nodeId: string;
  /** 発生元のノードが依存する先行ノード。 */
  readonly dependsOn: readonly string[];
  /** ISO 8601（UTC）。 */
  readonly at: string;
}

/** ノードの依存（ノード → 依存先）。項目を持たない中間ノードを含められる。 */
export type NodeDeps = ReadonlyMap<string, readonly string[]>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** ISO 8601 UTC（`...Z`）で、実在する日時か。 */
export function isValidInboxTime(at: string): boolean {
  if (!ISO_UTC.test(at)) return false;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return false;
  // 2026-02-30 のような繰り上がりを弾く（日付部分が往復で変わらないこと）。
  return new Date(ms).toISOString().slice(0, 10) === at.slice(0, 10);
}

const timeOf = (it: InboxItem): number =>
  isValidInboxTime(it.at) ? Date.parse(it.at) : Number.POSITIVE_INFINITY;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpTime = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

function dedupe(items: readonly InboxItem[]): InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const it of items) {
    const cur = byId.get(it.id);
    if (cur === undefined || it.seq > cur.seq) byId.set(it.id, it);
  }
  return [...byId.values()];
}

/** 各ノードが（推移的に）依存する先行ノードの集合。循環は打ち切る。 */
function reachableDeps(items: readonly InboxItem[], nodeDeps?: NodeDeps): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  const add = (node: string, deps: readonly string[]) => {
    const set = direct.get(node) ?? new Set<string>();
    for (const d of deps) set.add(d);
    direct.set(node, set);
  };
  for (const it of items) add(it.nodeId, it.dependsOn);
  for (const [node, deps] of nodeDeps ?? []) add(node, deps);

  const result = new Map<string, Set<string>>();
  const reach = (node: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(direct.get(node) ?? [])];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(direct.get(n) ?? []));
    }
    return seen;
  };
  for (const node of direct.keys()) result.set(node, reach(node));
  return result;
}

export function sortInbox(items: readonly InboxItem[], nodeDeps?: NodeDeps): InboxItem[] {
  const unique = dedupe(items);
  const anc = reachableDeps(unique, nodeDeps);
  const dependsOn = (later: string, earlier: string): boolean =>
    anc.get(later)?.has(earlier) ?? false;
  // x が y より先であるべきか: y のノードが x のノードに依存し、逆は成り立たない。
  const mustPrecede = (x: InboxItem, y: InboxItem): boolean =>
    x.nodeId !== y.nodeId && dependsOn(y.nodeId, x.nodeId) && !dependsOn(x.nodeId, y.nodeId);

  const out: InboxItem[] = [];
  for (const priority of PRIORITIES) {
    const rest = unique.filter((it) => INBOX_KIND_PRIORITY[it.kind] === priority);
    while (rest.length > 0) {
      let best = -1;
      rest.forEach((cand, i) => {
        if (rest.some((other) => other !== cand && mustPrecede(other, cand))) return;
        const b = rest[best];
        if (
          b === undefined ||
          cmpTime(timeOf(cand), timeOf(b)) < 0 ||
          (cmpTime(timeOf(cand), timeOf(b)) === 0 && cmp(cand.id, b.id) < 0)
        ) {
          best = i;
        }
      });
      // mustPrecede は狭義の半順序なので、先行のない項目は必ず存在する。
      out.push(...rest.splice(best, 1));
    }
  }
  return out;
}

/** 前回取得した seq より後の項目だけを整列して返す。 */
export function inboxSince(
  items: readonly InboxItem[],
  cursor: number,
  nodeDeps?: NodeDeps,
): InboxItem[] {
  return sortInbox(
    items.filter((it) => it.seq > cursor),
    nodeDeps,
  );
}
