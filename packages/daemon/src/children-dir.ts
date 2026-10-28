/**
 * 子の引き出しの置き場（`<stateDir>/children.noindex`。T21-d。① の順番 3）。`docs/desktop-runtime.md` の「子の引き出し」。
 *
 * - M1: 置き場（0700）と、子ごとの引き出し `<置き場>/<鍵>/`（0700）は、daemon が先に作る。すでにあれば、持ち主・権限（0700）・
 *   リンクでないことを確かめ、違っていれば直さずに失敗する（フェイルクローズ）。
 * - M4: 名前の `.noindex` で Spotlight の索引から外し、macOS では `/usr/bin/tmutil addexclusion` で Time Machine から外す
 *   （失敗は警告だけ。引数はパスだけ。数秒で打ち切る）。
 * - 鍵: ノード ID を、置き場の秘密（`<stateDir>/children.key`。0600）で HMAC-SHA256 にかけたもの（先頭 32 桁）。再起動しても
 *   同じ鍵を計算し直せる（対応を記録に持たないので、STATE_VERSION は変えない）。秘密がないのに、鍵の形の引き出しが残っている
 *   ときは、起動を止める（新しい秘密を黙って作ると、掃除で動いている子の引き出しまで消えるため）。新しい秘密を作った起動では、
 *   掃除をしない。
 * - M3: 作るのも消すのも、リンクをたどらない（lstat で確かめ、秘密のファイルは O_NOFOLLOW で開く。消すのは、リンクならリンク
 *   自身だけ。ディレクトリの中のリンクも、たどらずに消す）。置き場は、用意したときの dev・ino と同じかを、消す前に確かめる。
 *   同じユーザーの攻撃（確かめたあとの差し替え）には、完全には耐えない。
 * - M9: 起動のたびに、引き出しが要る状態（`CHILD_DIR_NEEDED`）の子の鍵でない引き出しを消す。
 * - 失敗の理由（例外の文）には、実パスを入れない（種類と、エラーの code だけ）。
 */

import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { NodeState } from "@cso/core";

export const CHILDREN_DIR = "children.noindex";
export const CHILDREN_KEY_FILE = "children.key";
/**
 * 状態ごとに、子の引き出しが要るか（起動時の掃除で残すか）。すべての状態を書く（型で網羅する）。
 * done は差し戻しで、stopped は再開で、同じ子が再び動くので残す。pending は、まだ紐付けていない（引き出しを使わない）。
 */
export const CHILD_DIR_NEEDED: Readonly<Record<NodeState, boolean>> = {
  pending: false,
  running: true,
  waiting: true,
  done: true,
  verified: false,
  stopping: true,
  stopIncomplete: true,
  stopped: true,
  reclaimable: false,
  archived: false,
};
const KEY_SHAPE = /^[0-9a-f]{32}$/;
const TMUTIL = "/usr/bin/tmutil";
const TMUTIL_TIMEOUT_MS = 5000;

/** 引き出しの置き場の失敗（文には実パスを入れない）。`recovery` は、人がとる次の操作。 */
export class ChildrenDirError extends Error {
  constructor(
    message: string,
    readonly recovery: readonly string[] = [],
  ) {
    super(message);
  }
}

/** 例外を、実パスを含まない短い理由にする（自分の例外はその文、ほかは code だけ）。 */
export const safeCause = (e: unknown): string =>
  e instanceof ChildrenDirError
    ? e.message
    : typeof (e as NodeJS.ErrnoException)?.code === "string"
      ? String((e as NodeJS.ErrnoException).code)
      : "unknown";

export interface ChildrenDirs {
  /** 置き場の実のパス。 */
  readonly root: string;
  /** この起動で、新しい秘密を作ったか（作ったら、掃除をしない）。 */
  readonly createdKey: boolean;
  /** ノードの鍵（推測できない。再起動しても同じ）。 */
  keyOf(nodeId: string): string;
  /** 子の引き出しを作る（すでにあれば、確かめるだけ）。そのパスを返す。違っていれば例外。 */
  create(nodeId: string): string;
  /** 子の引き出しを消す（なければ何もしない）。リンクはたどらない。 */
  remove(nodeId: string): void;
  /**
   * 要る子（`neededNodeIds`）の鍵でない引き出しを消す（M9）。1 件ずつ続け、消した数と、消せなかった数を返す。
   * 新しい秘密を作った起動では、何もしない。
   */
  sweep(neededNodeIds: readonly string[]): { removed: number; failed: number };
}

const uid = (): number | undefined => process.getuid?.();

/** 0700 の、自分のもので、リンクでないディレクトリか。違えば例外（直さない）。 */
function assertPrivateDir(path: string, what: string): { dev: number; ino: number } {
  const st = lstatSync(path);
  if (!st.isDirectory())
    throw new ChildrenDirError(`${what}が実のディレクトリでない（リンクなどは不可）`);
  const me = uid();
  if (me !== undefined && st.uid !== me)
    throw new ChildrenDirError(`${what}の所有者が、このプロセスのユーザーと違う`);
  if ((st.mode & 0o077) !== 0)
    throw new ChildrenDirError(`${what}の権限が 0700 でない（${(st.mode & 0o777).toString(8)}）`);
  return { dev: st.dev, ino: st.ino };
}

/** なければ 0700 で作り、確かめる。 */
function ensurePrivateDir(path: string, what: string): { dev: number; ino: number } {
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(path, { mode: 0o700 });
  }
  return assertPrivateDir(path, what);
}

/** 秘密のファイルを読む（O_NOFOLLOW で開き、fstat で持ち主・権限・通常のファイルを確かめる）。 */
function readSecret(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    const me = uid();
    if (!st.isFile()) throw new ChildrenDirError("引き出しの鍵のファイルが、通常のファイルでない");
    if (me !== undefined && st.uid !== me)
      throw new ChildrenDirError("引き出しの鍵のファイルの所有者が、このプロセスのユーザーと違う");
    if ((st.mode & 0o077) !== 0)
      throw new ChildrenDirError("引き出しの鍵のファイルの権限が 0600 でない");
    const text = readFileSync(fd, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text))
      throw new ChildrenDirError(
        "引き出しの鍵のファイルの中身が壊れている（空・形が違う）",
        RECOVERY,
      );
    return Buffer.from(text, "hex");
  } finally {
    closeSync(fd);
  }
}

const RECOVERY = [
  "鍵のファイル（stateDir の children.key）を、前の中身に戻せるなら戻して起動し直す",
  "戻せず、動いている子がいないなら、置き場（stateDir の children.noindex）の中を空にしてから起動し直す",
];

/**
 * 秘密を作る: 一時ファイル（O_EXCL・O_NOFOLLOW・0600）に書いてから、link で置く（すでにあれば置かない。同時に起動した
 * 2 つの daemon は、先に置いたほうの秘密を使う）。
 */
function createSecret(path: string): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${randomBytes(32).toString("hex")}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/** 中身に u+rwx を付ける（リンクはたどらない）。消せなかったときの、もう一度の試みの前に使う。 */
function grantOwner(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, (st.mode & 0o7777) | 0o700);
  if (st.isDirectory()) for (const n of readdirSync(path)) grantOwner(join(path, n));
}

/** リンクをたどらずに消す（リンク・ファイルは unlink、ディレクトリは中身ごと。rm は中のリンクをたどらない）。 */
function removeNoFollow(path: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (st.isDirectory()) rmSync(path, { recursive: true, force: true });
  else unlinkSync(path);
}

/**
 * 起動時に呼ぶ。置き場と秘密を用意する（違っていれば `ChildrenDirError`。起動を止める）。`exclude` は Time Machine から外す
 * 処理（既定は macOS の `/usr/bin/tmutil addexclusion <パス>`。ほかの OS では何もしない）で、失敗は `onWarning` に渡すだけ。
 */
export function prepareChildrenDirs(
  stateDir: string,
  options: {
    readonly exclude?: (path: string) => Promise<void>;
    readonly onWarning?: (cause: string) => void;
  } = {},
): ChildrenDirs {
  const root = join(stateDir, CHILDREN_DIR);
  const id = ensurePrivateDir(root, "子の引き出しの置き場");
  const keyPath = join(stateDir, CHILDREN_KEY_FILE);
  let createdKey = false;
  let secret: Buffer;
  try {
    secret = readSecret(keyPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // 秘密がないのに、鍵の形の引き出しが残っている: 黙って新しい秘密を作らない（掃除で消してしまうため）
    if (readdirSync(root).some((n) => KEY_SHAPE.test(n)))
      throw new ChildrenDirError(
        "引き出しの鍵のファイルがないのに、子の引き出しが残っている（鍵を作り直すと、動いている子の引き出しを消してしまう）",
        RECOVERY,
      );
    createSecret(keyPath);
    createdKey = true;
    secret = readSecret(keyPath);
  }
  const exclude = options.exclude ?? defaultExclude;
  exclude(root).catch((e) => options.onWarning?.(`Time Machine から外せない（${safeCause(e)}）`));
  const keyOf = (nodeId: string): string =>
    createHmac("sha256", secret).update(nodeId, "utf8").digest("hex").slice(0, 32);
  /** 置き場が、用意したときと同じ実のディレクトリか（差し替えられていないか）。 */
  const assertSameRoot = (): void => {
    const now = assertPrivateDir(root, "子の引き出しの置き場");
    if (now.dev !== id.dev || now.ino !== id.ino)
      throw new ChildrenDirError("子の引き出しの置き場が、起動のあとで差し替えられた");
  };
  return {
    root,
    createdKey,
    keyOf,
    create(nodeId) {
      assertSameRoot();
      const dir = join(root, keyOf(nodeId));
      ensurePrivateDir(dir, "子の引き出し");
      return dir;
    },
    remove(nodeId) {
      assertSameRoot();
      removeNoFollow(join(root, keyOf(nodeId)));
    },
    sweep(neededNodeIds) {
      if (createdKey) return { removed: 0, failed: 0 };
      assertSameRoot();
      const keep = new Set(neededNodeIds.map(keyOf));
      let removed = 0;
      let failed = 0;
      for (const name of readdirSync(root)) {
        if (KEY_SHAPE.test(name) && keep.has(name)) continue;
        const path = join(root, name);
        try {
          removeNoFollow(path);
          removed += 1;
        } catch {
          try {
            grantOwner(path);
            removeNoFollow(path);
            removed += 1;
          } catch {
            failed += 1;
          }
        }
      }
      return { removed, failed };
    },
  };
}

const defaultExclude = (path: string): Promise<void> =>
  process.platform !== "darwin"
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        execFile(TMUTIL, ["addexclusion", path], { timeout: TMUTIL_TIMEOUT_MS }, (e) =>
          e ? reject(e) : resolve(),
        );
      });
