import { createMemoryStore } from "../src/memory-store.js";
import { describeEventStore } from "./event-store.contract.js";

describeEventStore("メモリ実装（テスト用のフェイク）", () => {
  const shared = createMemoryStore();
  return { store: shared.open(), reopen: () => shared.open(), cleanup: () => undefined };
});
