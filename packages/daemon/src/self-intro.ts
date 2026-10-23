/**
 * 起動の指示の先頭に置く、自分のノード ID・role・親（T10m-id）。エージェントは、自分の ID を知る手段が、ほかにない（作業ツリーの
 * ディレクトリ名は、ID を切り詰めてハッシュをつけた名前で、ID ではない）。ID を引数に取る操作（`node_spawn` の `parentId` など）で、
 * 切り詰めた名前を使って失敗するのを防ぐ。文面は固定で、ID は `isSafeId` を通ったもの（daemon が決めた識別子。子が影響できない）。
 */

import { type Failure, isSafeId, type NodeRole, type Result } from "@cso/core";
import { fail } from "./api/handlers/context.js";

export function selfIntroLines(
  nodeId: string,
  role: NodeRole,
  parentId: string | null,
): Result<string[], Failure> {
  if (!isSafeId(nodeId) || (parentId !== null && !isSafeId(parentId))) {
    return fail("internal", "ノード ID が識別子の形式でない", "管理者（人間）に知らせる");
  }
  return {
    ok: true,
    value: [
      `あなたのノード ID: ${nodeId}（role: ${role}、親: ${parentId ?? "なし"}）`,
      "ID を引数に取る操作（node_spawn の parentId など）には、この ID（または子孫の ID）を、省略・短縮せず、そのまま使う。作業ツリーのディレクトリ名は、ID ではない（切り詰めてあり、ハッシュがついている）。",
    ],
  };
}
