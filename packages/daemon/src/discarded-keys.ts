/**
 * 保管（`refs/cso/discarded/<key>`）の鍵の形と、持ち主の判定（T13f-r）。**持ち主の判定は、この関数だけを使う**
 * （一覧の `nodeId`・最終削除での掃除・事前確認の件数が、同じ判定になるように）。
 *
 * - 鍵は、`<base>` か、衝突したときの `<base>.<先端の先頭 12 桁>`。`<base>` は、ノード ID から導く名前（`<安全な部分>-<ハッシュ 12 桁>`）で、
 *   **`.` を含まない**（安全な部分は `[A-Za-z0-9_-]` だけ）。区切りに `.` を使うので、ほかのノードの `<base>` と取り違えない。
 */

const KEY = /^([A-Za-z0-9_-]+)(?:\.[0-9a-f]{12})?$/;

/** 鍵の持ち主の `<base>`。鍵の形でなければ `undefined`（誰のものでもない。掃除の対象にしない）。 */
export const ownerBaseOf = (key: string): string | undefined => KEY.exec(key)?.[1];

/** 衝突したときの鍵（別の先端の保管がすでにあるとき）。 */
export const collisionKey = (base: string, tip: string): string => `${base}.${tip.slice(0, 12)}`;

/** 鍵が、`bases` のどれかのノードの保管か。 */
export const ownedBy = (key: string, bases: ReadonlySet<string>): boolean => {
  const owner = ownerBaseOf(key);
  return owner !== undefined && bases.has(owner);
};
