/**
 * 子（CLI）に渡す環境変数。親の環境変数から、セッション識別子に関わる変数を除く。
 * 除かないと、子のセッション識別子が親と同一になり、記録（NFR_011）と覗き見（FR_035）に影響する（Spike 02 #6）。
 *
 * 規則: 名前が `CLAUDE` で始まり `SESSION` を含む変数（大文字小文字を問わない）を除く。認証用など、それ以外は残す。
 * 検証環境固有の名前が他の環境で違う可能性があるため、名前の列挙ではなく規則で除く。除いた名前は呼び出し側が
 * 起動の記録に残す（値は返さない）。
 */

const SESSION_VARIABLE = /^claude.*session/i;

export interface ChildEnv {
  readonly env: Record<string, string>;
  /** 除いた変数の名前（値は含めない）。 */
  readonly removed: readonly string[];
}

export function childEnv(parent: Readonly<Record<string, string | undefined>>): ChildEnv {
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (SESSION_VARIABLE.test(name)) removed.push(name);
    else env[name] = value;
  }
  return { env, removed };
}
