import { type EventBody, foldEvents, type NodeEvent, type OrchEvent, stateOf } from "@cso/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EventStore, StoredEvent } from "../src/event-store.js";
import { EventLog, eventHash, STATE_VERSION } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
const clock = (): string => AT;

const created = (
  nodeId: string,
  role: "integrator" | "implement",
  parentId: string | null,
  dependsOn: string[] = [],
): EventBody => ({ type: "node.created", payload: { nodeId, role, parentId, dependsOn } });
const changed = (nodeId: string, event: NodeEvent): EventBody => ({
  type: "node.stateChanged",
  payload: { nodeId, event },
});

const openLog = (store: EventStore, snapshotEvery = 1000) => {
  const r = EventLog.open(store, { clock, snapshotEvery });
  if (!r.ok) throw new Error(`open failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};
const append = (log: EventLog, requestId: string, body: EventBody) =>
  log.append({ requestId, actor: SYS, body });
const must = <T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; cause: string } },
): T => {
  if (!r.ok) throw new Error(`failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};

const seed = (log: EventLog): void => {
  must(append(log, "r1", created("root", "integrator", null)));
  must(append(log, "r2", changed("root", { type: "start" })));
  must(append(log, "r3", created("a", "implement", "root")));
};

describe("追記", () => {
  it("seq は 1 から採番され、時刻は clock から付き、状態が更新される", () => {
    const store = createMemoryStore().open();
    const log = openLog(store);
    const r = must(append(log, "r1", created("root", "integrator", null)));
    expect(r.applied).toBe(true);
    expect(r.event).toMatchObject({ seq: 1, at: AT, requestId: "r1", actor: SYS });
    expect(stateOf(log.state(), "root")).toBe("pending");
    expect(store.readAll()).toHaveLength(1);
    expect(must(append(log, "r2", changed("root", { type: "start" }))).event.seq).toBe(2);
  });

  it("同じ requestId・同一内容の再試行は、行を増やさず、最初のイベントを返す（冪等）", () => {
    const store = createMemoryStore().open();
    const log = openLog(store);
    const first = must(append(log, "r1", created("root", "integrator", null)));
    const again = must(append(log, "r1", created("root", "integrator", null)));
    expect(again.applied).toBe(false);
    expect(again.event).toEqual(first.event);
    expect(store.readAll()).toHaveLength(1);
    // 採番は消費されない
    expect(must(append(log, "r2", changed("root", { type: "start" }))).event.seq).toBe(2);
  });

  it("同じ requestId で内容が違えば requestIdConflict。何も書かれない", () => {
    const store = createMemoryStore().open();
    const log = openLog(store);
    must(append(log, "r1", created("root", "integrator", null)));
    const r = append(log, "r1", created("other", "integrator", null));
    expect(r.ok ? null : r.error.code).toBe("requestIdConflict");
    expect(store.readAll()).toHaveLength(1);
  });

  it("矛盾するイベントは追記前に拒否され、何も書かれず、seq も消費されない", () => {
    const store = createMemoryStore().open();
    const log = openLog(store);
    seed(log);
    const before = store.readAll().length;
    const r = append(log, "bad", changed("a", { type: "reportDone" })); // pending からは完了できない
    expect(r.ok ? null : r.error.code).toBe("invalidTransition");
    expect(store.readAll()).toHaveLength(before);
    expect(must(append(log, "r4", changed("a", { type: "start" }))).event.seq).toBe(before + 1);
  });

  it("壊れた入力でも例外を出さず、失敗を返す", () => {
    const log = openLog(createMemoryStore().open());
    for (const bad of [
      null,
      undefined,
      1,
      {},
      { requestId: "", actor: SYS, body: created("a", "integrator", null) },
    ]) {
      const r = log.append(bad as never);
      expect(r.ok).toBe(false);
    }
    const r = log.append({
      requestId: "x",
      actor: SYS,
      body: { type: "node.exploded", payload: {} } as never,
    });
    expect(r.ok ? null : r.error.code).toBe("unknownEventType");
  });

  it("ストアの書き込みが失敗したら storeError を返し、状態も採番も変わらない。再試行できる", () => {
    const inner = createMemoryStore().open();
    let failNext = false;
    const flaky: EventStore = {
      ...inner,
      append(r: StoredEvent) {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        inner.append(r);
      },
      transaction: (fn) => inner.transaction(fn),
    };
    const log = openLog(flaky);
    must(append(log, "r1", created("root", "integrator", null)));
    failNext = true;
    const r = append(log, "r2", changed("root", { type: "start" }));
    expect(r.ok ? null : r.error.code).toBe("storeError");
    expect(stateOf(log.state(), "root")).toBe("pending");
    expect(inner.readAll()).toHaveLength(1);
    expect(must(append(log, "r2", changed("root", { type: "start" }))).event.seq).toBe(2);
  });
});

describe("時計（clock）", () => {
  it("clock が例外・不正な形式の値を返したら invalidClock で失敗し、何も書かず、seq も消費しない", () => {
    const store = createMemoryStore().open();
    let mode: "ok" | "throw" | "bad" = "throw";
    const log = EventLog.open(store, {
      clock: () => {
        if (mode === "throw") throw new Error("clock broke");
        return mode === "bad" ? "yesterday" : AT;
      },
    });
    if (!log.ok) throw new Error("open");
    const r1 = append(log.value, "r1", created("root", "integrator", null));
    expect(r1.ok ? null : r1.error.code).toBe("invalidClock");
    mode = "bad";
    const r2 = append(log.value, "r1", created("root", "integrator", null));
    expect(r2.ok ? null : r2.error.code).toBe("invalidClock");
    expect(store.readAll()).toHaveLength(0);
    mode = "ok";
    expect(must(append(log.value, "r1", created("root", "integrator", null))).event.seq).toBe(1);
  });
});

describe("復元（NFR_002）", () => {
  it("開き直すと、ログから同じ状態を導出する（foldEvents と一致）", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open());
    seed(log);
    must(append(log, "r4", changed("a", { type: "start" })));
    const restored = openLog(shared.open());
    expect(restored.state()).toEqual(log.state());
    const events = shared
      .open()
      .readAll()
      .map((r) => ({
        ...r,
        actor: JSON.parse(r.actor),
        payload: JSON.parse(r.payload),
      }));
    const folded = foldEvents(events as unknown as OrchEvent[]);
    expect(folded.ok && folded.value).toEqual(log.state());
    // 復元後の追記は、続きの seq から
    expect(must(append(restored, "r5", changed("a", { type: "reportDone" }))).event.seq).toBe(5);
  });

  it("壊れた行（不正な JSON・形の違い）は例外でなく失敗（corruptRow）として返す", () => {
    const cases: Partial<StoredEvent>[] = [
      { payload: "{not json" },
      { actor: "42" },
      { payload: "null" },
      { type: "" },
    ];
    for (const over of cases) {
      const shared = createMemoryStore();
      const s = shared.open();
      s.append({
        seq: 1,
        at: AT,
        requestId: "r1",
        actor: '{"system":true}',
        type: "node.created",
        payload: '{"nodeId":"root","role":"integrator","parentId":null,"dependsOn":[]}',
        ...over,
      });
      const r = EventLog.open(shared.open(), { clock });
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("corruptRow");
        expect(r.error.nextActions.length).toBeGreaterThan(0);
      }
    }
  });

  it("ログが矛盾していれば（順序の入れ替わり・不変条件の違反）、seq つきの失敗で開けない", () => {
    const shared = createMemoryStore();
    const s = shared.open();
    s.append({
      seq: 1,
      at: AT,
      requestId: "r1",
      actor: '{"system":true}',
      type: "node.stateChanged",
      payload: '{"nodeId":"ghost","event":{"type":"start"}}',
    });
    const r = EventLog.open(shared.open(), { clock });
    expect(r.ok ? null : r.error.code).toBe("unknownNode");
  });
});

describe("スナップショット（キャッシュ。ログから再構築できる）", () => {
  const many = (log: EventLog, n: number): void => {
    must(append(log, "root", created("root", "integrator", null)));
    must(append(log, "root-start", changed("root", { type: "start" })));
    for (let i = 0; i < n; i++) must(append(log, `c${i}`, created(`n${i}`, "implement", "root")));
  };

  it("snapshotEvery ごとに保存され、そこから再開した状態が全体の畳み込みと一致する", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 3);
    many(log, 8); // seq 10
    const saved = shared.open().loadSnapshot();
    expect(saved?.lastSeq).toBe(9);
    expect(saved?.stateVersion).toBe(STATE_VERSION);
    expect(saved?.lastEventHash).toBe(eventHash(shared.open().findBySeq(9) as never));
    const restored = openLog(shared.open(), 3);
    expect(restored.state()).toEqual(log.state());
  });

  /** 正しい版とハッシュを持つスナップショットを保存する（状態の中身だけを差し替えられる）。 */
  const saveSnap = (
    shared: ReturnType<typeof createMemoryStore>,
    lastSeq: number,
    state: string,
    over: Partial<{ stateVersion: number; lastEventHash: string }> = {},
  ): void => {
    const s = shared.open();
    const last = s.findBySeq(lastSeq);
    s.saveSnapshot({
      lastSeq,
      state,
      stateVersion: over.stateVersion ?? STATE_VERSION,
      lastEventHash: over.lastEventHash ?? (last === undefined ? "none" : eventHash(last)),
    });
  };

  it("壊れたスナップショットは捨てて、ログ全体から再構築する", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 3);
    many(log, 8);
    for (const state of ["{not json", "null", '{"nodes":1}', "42"]) {
      saveSnap(shared, 9, state);
      expect(openLog(shared.open(), 3).state(), state).toEqual(log.state());
    }
  });

  it("ログより先まで進んだスナップショット（lastSeq が最後の seq を超える）は捨てる", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 1000);
    many(log, 3);
    saveSnap(shared, 999, JSON.stringify(log.state()));
    expect(openLog(shared.open()).state()).toEqual(log.state());
  });

  it("状態のスキーマの版が違うスナップショットは捨てる", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 3);
    many(log, 8);
    const stale = JSON.stringify({ ...log.state(), nodes: [] });
    saveSnap(shared, 9, stale, { stateVersion: STATE_VERSION + 1 });
    expect(openLog(shared.open(), 3).state()).toEqual(log.state());
  });

  it("古い形（状態のスキーマの版 1。停止の試行の記録を持たない）のスナップショットは捨てる", () => {
    expect(STATE_VERSION).toBe(8);
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 3);
    many(log, 8);
    const { stopRequests: _a, stopObservations: _b, ...oldShape } = log.state();
    // 内容は古い形で、ログとは食い違う（ノードが空）。版が 1 のままなら受け入れてしまう。
    saveSnap(shared, 9, JSON.stringify({ ...oldShape, nodes: [] }), { stateVersion: 1 });
    expect(openLog(shared.open(), 3).state()).toEqual(log.state());
  });

  it("末尾のイベントのハッシュが合わないスナップショット（ログと食い違う）は捨てる", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 3);
    many(log, 8);
    const stale = JSON.stringify({ ...log.state(), nodes: [] });
    saveSnap(shared, 9, stale, { lastEventHash: "0".repeat(64) });
    expect(openLog(shared.open(), 3).state()).toEqual(log.state());
  });

  it("版とハッシュが合っていて中身だけ違うスナップショットは、既定では受け入れ、verifySnapshot で全ログと比べて捨てる", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 3);
    many(log, 8);
    const tampered = { ...log.state(), lastSeq: 9, nodes: log.state().nodes.slice(0, 2) };
    saveSnap(shared, 9, JSON.stringify(tampered));
    expect(openLog(shared.open(), 3).state().nodes).toHaveLength(tampered.nodes.length); // 既定: 信用する（スナップショットの requests にある残りのイベントは重複として無視される）
    let mismatches = 0;
    const verified = EventLog.open(shared.open(), {
      clock,
      snapshotEvery: 3,
      verifySnapshot: true,
      onSnapshotMismatch: () => {
        mismatches++;
      },
    });
    expect(verified.ok && verified.value.state()).toEqual(log.state());
    expect(mismatches).toBe(1); // 食い違いを、運用の記録に残せる
    // 食い違いがなければ、通知しない
    const clean = createMemoryStore();
    const cleanLog = openLog(clean.open(), 3);
    many(cleanLog, 8);
    let none = 0;
    EventLog.open(clean.open(), {
      clock,
      snapshotEvery: 3,
      verifySnapshot: true,
      onSnapshotMismatch: () => {
        none++;
      },
    });
    expect(none).toBe(0);
  });

  it("eventHash は行の内容で決まり（決定的）、内容が変われば変わる", () => {
    const r = { seq: 1, at: "a", requestId: "r", actor: "{}", type: "t", payload: "{}" };
    expect(eventHash(r)).toBe(eventHash({ ...r }));
    expect(eventHash(r)).toMatch(/^[0-9a-f]{64}$/);
    for (const k of ["seq", "at", "requestId", "actor", "type", "payload"] as const) {
      expect(eventHash({ ...r, [k]: k === "seq" ? 2 : "x" })).not.toBe(eventHash(r));
    }
  });

  it("スナップショットが最新のログより古くても、残りを畳み込んで一致する", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 4);
    many(log, 10);
    expect(openLog(shared.open(), 4).state()).toEqual(log.state());
  });
});

describe("性質（fast-check）", () => {
  const stepArb = fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 40 });
  const NODE_EVENTS: NodeEvent[] = [
    { type: "start" },
    { type: "reportDone" },
    { type: "accept" },
    { type: "stop", mode: "immediate" },
    { type: "confirmStopped" },
  ];

  it("どんな追記列でも、再開した状態は、追記した状態・全体の畳み込みと一致し、再送は行を増やさない", () => {
    fc.assert(
      fc.property(stepArb, fc.integer({ min: 1, max: 6 }), (steps, every) => {
        const shared = createMemoryStore();
        const log = openLog(shared.open(), every);
        must(append(log, "root", created("root", "integrator", null)));
        must(append(log, "root-start", changed("root", { type: "start" })));
        const ids = ["root"];
        steps.forEach(([a, b, retry], i) => {
          const id = `n${i}`;
          const r =
            b % 3 === 0
              ? append(log, `q${i}`, created(id, "implement", "root"))
              : append(
                  log,
                  `q${i}`,
                  changed(
                    ids[a % ids.length] as string,
                    NODE_EVENTS[b % NODE_EVENTS.length] as NodeEvent,
                  ),
                );
          if (r.ok && b % 3 === 0) ids.push(id);
          if (retry && r.ok) {
            const rows = shared.open().readAll().length;
            const body = b % 3 === 0 ? created(id, "implement", "root") : undefined;
            if (body) expect(must(append(log, `q${i}`, body)).applied).toBe(false);
            expect(shared.open().readAll().length).toBe(rows);
          }
        });
        const restored = openLog(shared.open(), every);
        expect(restored.state()).toEqual(log.state());
        const events = shared
          .open()
          .readAll()
          .map((r) => ({ ...r, actor: JSON.parse(r.actor), payload: JSON.parse(r.payload) }));
        const folded = foldEvents(events as unknown as OrchEvent[]);
        expect(folded.ok && folded.value).toEqual(log.state());
      }),
    );
  });
});

describe("appendAll（複数イベントを 1 トランザクションで。全件を事前に検査する）", () => {
  const req = (requestId: string, body: EventBody) => ({ requestId, actor: SYS, body });

  it("seq を連番で採番して全件を追記し、状態は 1 回で更新される。再起動しても同じ", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open());
    const outcomes = must(
      log.appendAll([
        req("a1", created("root", "integrator", null)),
        req("a2", changed("root", { type: "start" })),
        req("a3", created("a", "implement", "root")),
      ]),
    );
    expect(outcomes.map((o) => [o.event.seq, o.applied])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
    expect(log.state().lastSeq).toBe(3);
    expect(log.state().nodes.map((n) => n.id)).toEqual(["root", "a"]);
    expect(openLog(shared.open()).state()).toEqual(log.state());
  });

  it("途中で検査に失敗したら、何も書かず、状態も seq も変えない（全件がロールバック）", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open());
    seed(log);
    const before = log.state();
    const rows = shared.open().readAll().length;
    const r = log.appendAll([
      req("b1", changed("a", { type: "start" })),
      req("b2", changed("a", { type: "start" })), // 2 回目は不正（running からの start）
    ]);
    expect(r.ok).toBe(false);
    expect(log.state()).toEqual(before);
    expect(shared.open().readAll()).toHaveLength(rows);
    expect(must(append(log, "after", changed("a", { type: "start" }))).event.seq).toBe(
      before.lastSeq + 1,
    );
  });

  it("追記済みの要求は重複として最初のイベントを返し、残りを追記する（再試行で完了する）", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open());
    must(append(log, "c1", created("root", "integrator", null)));
    const outcomes = must(
      log.appendAll([
        req("c1", created("root", "integrator", null)),
        req("c2", changed("root", { type: "start" })),
      ]),
    );
    expect(outcomes.map((o) => o.applied)).toEqual([false, true]);
    expect(outcomes[0]?.event.seq).toBe(1);
    expect(outcomes[1]?.event.seq).toBe(2);
  });

  it("要求の形が不正・空の配列は失敗する。スナップショットは、境界の seq を含むときに保存される", () => {
    const shared = createMemoryStore();
    const log = openLog(shared.open(), 2);
    expect(log.appendAll([{ requestId: 5 } as never]).ok).toBe(false);
    expect(log.appendAll([]).ok).toBe(false);
    must(
      log.appendAll([
        req("d1", created("root", "integrator", null)),
        req("d2", changed("root", { type: "start" })),
        req("d3", created("a", "implement", "root")),
      ]),
    );
    expect(shared.open().loadSnapshot()?.lastSeq).toBe(2);
    expect(openLog(shared.open(), 2).state()).toEqual(log.state());
  });
});
