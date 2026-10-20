/**
 * daemon の窓口を呼ぶクライアントの契約（NFR_001）。実際の接続（127.0.0.1 の HTTP）は daemon の
 * 窓口の実装後に差し込む。cli は daemon に依存せず、core の契約型だけを使う。
 */
import type { DaemonRequest, DaemonResponse, RoleOperation } from "@cso/core";

/** 人間のコマンドが呼べる操作。 */
export type HumanOperation = RoleOperation<"human">;

export interface DaemonClient {
  call<Op extends HumanOperation>(
    req: Extract<DaemonRequest<"human">, { operation: Op }>,
  ): Promise<DaemonResponse<Op>>;
}
