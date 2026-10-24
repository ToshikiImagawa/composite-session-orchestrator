# Desktop のランタイムアダプタ（T20）

Desktop の子は、統合セッションが Desktop のタスク生成機能で起動する。daemon は子を直接操作できないので、
`DesktopRuntimeAdapter`（`packages/daemon/src/sdk/desktop-adapter.ts`）は、次のように振る舞う。

## 能力表（実機確認の前の控えめな値）

| 項目 | 値 | 意味 |
|:--|:--|:--|
| `send` | `unsupported` | daemon から直接指示を届けない。`node.send`・判断の回答の配送・起こす（wake）・差し戻しは、記録する前に失敗する（または届けない） |
| `stopGraceful`・`stopImmediate` | `false` | 直接は止めない |
| `stopDelegated` | `true` | 停止は、受信箱を通じて親に代行を依頼する（停止未完了として記録し、受信箱の `stopIncomplete` の項目に依頼の文面を出す） |
| `hooks` | `unverified` | Desktop の子にフックが効くかは未確認（Spike 01 の項目 4） |
| `sessionId` | `false` | タスク生成の戻り値に、子のセッション識別子がない |

値は `DESKTOP_CAPABILITIES` の 1 か所にある。Spike 01 の項目 1〜7 の確認が済んだら、値を差し替えるだけでよい。

## フックのゲート

フックが確認済み（`hooks: "ok"`）でない間は、アダプタは子の起動（`start`）を拒否する。拒否の文面には、`hooks` の値（未確認・未対応）を出す。
既定は有効で、設定ファイルの `desktopRequireVerifiedHooks: false` でのみ外せる（API では変えられない）。外したときは、起動のたびに警告を記録する。

**ゲートは、子を daemon の管理下に入れないことで効く。daemon を経ない起動（統合セッションが、daemon を通さずに Desktop のタスク生成機能を直接呼ぶ）は、止められない。**
ゲートが守るのは、daemon が管理する子に、作業範囲外の拒否（FR_014）なしで作業を許すことがない、という点だけである。

## 停止の代行依頼の文面

手順を先に、対象のノードの ID を後ろに置く。受信箱の要約の上限（200 文字）で切られても、手順は残る。ID が最長（128 文字）でも、手順と ID の両方が収まる。

## 停止の宣言（`node.confirmStopped`）

親が代行依頼に従って Desktop でタスクを止めた（またはアーカイブした）ら、人間か、そのノードの祖先の統合ノードが `node.confirmStopped`
（`{ nodeId, note? }`）で宣言する。1 トランザクションで、次を記録する。

1. `node.stopDeclared`（宣言した者は封筒の `actor`、根拠は `note`）。状態の `stopDeclarations` に残る。
2. `confirmStopped`（`stopIncomplete` → `stopped`）。
3. そのノードの未解決の `stopIncomplete` の項目（代行依頼）を、すべて解決済みにする。
4. 受信箱に info（宣言者と根拠）。

対象は、能力表の `stopDelegated` が真のノードだけ（CLI のノードは `notDelegated` で失敗し、`node.stop` の再試行を案内する）。
同じ `requestId` の再送は同じ結果を返し、記録は 1 回。宣言の後、アダプタは、そのノードを管理から外す（`release`）。

人間は、cli の `cso confirm-stopped <nodeId> [--note <根拠>]` か、画面の「止めたと宣言…」（ノード ID の打ち込みが要る。`docs/ui.md`）から宣言できる。
