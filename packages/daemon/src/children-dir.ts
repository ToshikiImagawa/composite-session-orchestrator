/**
 * 子の引き出しの置き場（`<stateDir>/children.noindex`。T21-d。① の順番 3）。`docs/desktop-runtime.md` の「子の引き出し」。
 *
 * - M1: 置き場（0700）と、子ごとの引き出し `<置き場>/<鍵>/`（0700）は、daemon が先に作る。すでにあれば、持ち主・権限（0700）・
 *   リンクでないことを確かめ、違っていれば直さずに失敗する（フェイルクローズ）。
 * - M4: 名前の `.noindex` で Spotlight の索引から外し、macOS では `tmutil addexclusion` で Time Machine から外す
 *   （失敗は警告だけ。引数はパスだけ）。
 * - 鍵: ノード ID から、置き場の秘密（`<stateDir>/children.key`。0600。初回に作る）で HMAC-SHA256 を取ったもの（先頭 32 桁）。
 *   推測できず、daemon を再起動しても同じ鍵を計算し直せる（対応を記録に持たないので、STATE_VERSION は変えない）。
 * - M3: 作るのも消すのも、リンクをたどらない（lstat で確かめ、秘密のファイルは O_NOFOLLOW で開く。消すのは、リンクならリンク
 *   自身だけ。ディレクトリの中のリンクも、たどらずに消す）。
 * - M9: 起動のたびに、記録で動いている子（running・waiting・stopping・stopIncomplete）の鍵でない引き出しを消す。
 */

import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
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

export const CHILDREN_DIR = "children.noindex";
export const CHILDREN_KEY_FILE = "children.key";
/** 記録で「動いている」子の状態（この状態の子の引き出しは、起動時の掃除で消さない）。 */
export const LIVE_CHILD_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "stopping",
  "stopIncomplete",
]);
const KEY_SHAPE = /^[0-9a-f]{32}$/;

export interface ChildrenDirs {
  /** 置き場の実のパス。 */
  readonly root: string;
  /** ノードの鍵（推測できない。再起動しても同じ）。 */
  keyOf(nodeId: string): string;
  /** 子の引き出しを作る（すでにあれば、確かめるだけ）。そのパスを返す。違っていれば例外。 */
  create(nodeId: string): string;
  /** 子の引き出しを消す（なければ何もしない）。リンクはたどらない。 */
  remove(nodeId: string): void;
  /** 動いている子（`liveNodeIds`）の鍵でない引き出しを消し、消した数を返す（M9）。 */
  sweep(liveNodeIds: readonly string[]): number;
}

const uid = (): number | undefined => process.getuid?.();

/** 0700 の、自分のもので、リンクでないディレクトリか。違えば例外（直さない）。 */
function assertPrivateDir(path: string, what: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new Error(`${what}が実のディレクトリでない（リンクなどは不可）`);
  const me = uid();
  if (me !== undefined && st.uid !== me)
    throw new Error(`${what}の所有者が、このプロセスのユーザーと違う`);
  if ((st.mode & 0o077) !== 0)
    throw new Error(`${what}の権限が 0700 でない（${(st.mode & 0o777).toString(8)}）`);
}

/** なければ 0700 で作り、確かめる。 */
function ensurePrivateDir(path: string, what: string): void {
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(path, { mode: 0o700 });
  }
  assertPrivateDir(path, what);
}

/** 置き場の秘密を読む（なければ作る）。O_NOFOLLOW で開き、fstat で持ち主・権限・通常のファイルを確かめる。 */
function loadSecret(path: string): Buffer {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const secret = randomBytes(32).toString("hex");
    const w = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(w, `${secret}\n`);
    } finally {
      closeSync(w);
    }
    fd = openSync(path, flags);
  }
  try {
    const st = fstatSync(fd);
    const me = uid();
    if (!st.isFile()) throw new Error("引き出しの鍵のファイルが、通常のファイルでない");
    if (me !== undefined && st.uid !== me)
      throw new Error("引き出しの鍵のファイルの所有者が、このプロセスのユーザーと違う");
    if ((st.mode & 0o077) !== 0) throw new Error("引き出しの鍵のファイルの権限が 0600 でない");
    const text = readFileSync(fd, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error("引き出しの鍵のファイルの中身が壊れている");
    return Buffer.from(text, "hex");
  } finally {
    closeSync(fd);
  }
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
 * 起動時に呼ぶ。置き場と秘密を用意する（違っていれば例外。起動を止める）。`exclude` は Time Machine から外す処理（既定は
 * macOS の `tmutil addexclusion <パス>`。ほかの OS では何もしない）で、失敗は `onWarning` に渡すだけ。
 */
export function prepareChildrenDirs(
  stateDir: string,
  options: {
    readonly exclude?: (path: string) => Promise<void>;
    readonly onWarning?: (cause: string) => void;
  } = {},
): ChildrenDirs {
  const root = join(stateDir, CHILDREN_DIR);
  ensurePrivateDir(root, "子の引き出しの置き場");
  const secret = loadSecret(join(stateDir, CHILDREN_KEY_FILE));
  const exclude = options.exclude ?? defaultExclude;
  exclude(root).catch((e) =>
    options.onWarning?.(
      `Time Machine から外せない（${String(e instanceof Error ? e.message : e)}）`,
    ),
  );
  const keyOf = (nodeId: string): string =>
    createHmac("sha256", secret).update(nodeId, "utf8").digest("hex").slice(0, 32);
  return {
    root,
    keyOf,
    create(nodeId) {
      const dir = join(root, keyOf(nodeId));
      assertPrivateDir(root, "子の引き出しの置き場");
      ensurePrivateDir(dir, "子の引き出し");
      return dir;
    },
    remove(nodeId) {
      removeNoFollow(join(root, keyOf(nodeId)));
    },
    sweep(liveNodeIds) {
      const keep = new Set(liveNodeIds.map(keyOf));
      let removed = 0;
      for (const name of readdirSync(root)) {
        if (KEY_SHAPE.test(name) && keep.has(name)) continue;
        removeNoFollow(join(root, name));
        removed += 1;
      }
      return removed;
    },
  };
}

const defaultExclude = (path: string): Promise<void> =>
  process.platform !== "darwin"
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        execFile("tmutil", ["addexclusion", path], (e) => (e ? reject(e) : resolve()));
      });
