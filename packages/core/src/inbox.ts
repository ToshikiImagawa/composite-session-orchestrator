/**
 * 受信箱の整列（FR_012）。I/O を持たない純粋関数。
 * 順序: 優先度 → 依存関係（依存先のノードの項目が先）→ 時刻 → id（決定的、NFR_007）。
 */
import { INBOX_KIND_PRIORITY, type InboxKind, PRIORITIES } from "./index.js";

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

/** 依存の深さ。依存先を持たないノードが 0。循環は打ち切る。 */
function dependencyDepths(items: readonly InboxItem[]): ReadonlyMap<string, number> {
  const deps = new Map<string, readonly string[]>();
  for (const it of items) {
    const merged = new Set([...(deps.get(it.nodeId) ?? []), ...it.dependsOn]);
    deps.set(it.nodeId, [...merged].sort());
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (node: string): number => {
    const known = depths.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) return 0;
    visiting.add(node);
    let d = 0;
    for (const dep of deps.get(node) ?? []) d = Math.max(d, 1 + depth(dep));
    visiting.delete(node);
    depths.set(node, d);
    return d;
  };
  for (const node of [...deps.keys()].sort()) depth(node);
  return depths;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function sortInbox(items: readonly InboxItem[]): InboxItem[] {
  const depths = dependencyDepths(items);
  const rank = (it: InboxItem): number => PRIORITIES.indexOf(INBOX_KIND_PRIORITY[it.kind]);
  const depthOf = (it: InboxItem): number => depths.get(it.nodeId) ?? 0;
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      depthOf(a) - depthOf(b) ||
      Date.parse(a.at) - Date.parse(b.at) ||
      cmp(a.id, b.id),
  );
}

/** 前回取得した seq より後の項目だけを整列して返す。 */
export function inboxSince(items: readonly InboxItem[], cursor: number): InboxItem[] {
  return sortInbox(items.filter((it) => it.seq > cursor));
}
