/**
 * 起動の指示の先頭に置く、自分のノード ID・role・親（T10m-id）。エージェントは、自分の ID を知る手段が、ほかにない（作業ツリーの
 * ディレクトリ名は、ID を切り詰めてハッシュをつけた名前で、ID ではない）。ID を引数に取る操作（`node_spawn` の `parentId` など）で、
 * 切り詰めた名前を使って失敗するのを防ぐ。文面は固定で、ID は `isSafeId` を通ったもの（daemon が決めた識別子。子が影響できない）。
 */

import { isSafeId } from "@cso/core";

export function selfIntroLines(nodeId: string, role: string, parentId: string | null): string[] {
  if (!isSafeId(nodeId) || (parentId !== null && !isSafeId(parentId))) {
    throw new Error("ノード ID が識別子の形式でない");
  }
  return [
    `あなたのノード ID: ${nodeId}（role: ${role}、親: ${parentId ?? "なし"}）`,
    "ID を引数に取る操作（node_spawn の parentId など）には、この ID（または子孫の ID）を、省略・短縮せず、そのまま使う。作業ツリーのディレクトリ名は、ID ではない（切り詰めてあり、ハッシュがついている）。",
  ];
}
