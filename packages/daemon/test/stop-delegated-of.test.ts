import { describe, expect, it } from "vitest";
import { stopDelegatedOf } from "../src/compose.js";
import { DesktopRuntimeAdapter } from "../src/sdk/desktop-adapter.js";
import { FakeSink } from "./sdk/fakes.js";

describe("stopDelegatedOf（画面の停止の宣言の出し分け。T22d）", () => {
  it("能力表の stopDelegated だけで決める。daemon の再起動の後（アダプタが子を管理していない）でも真", () => {
    // 再起動の直後: アダプタは新しく作られ、どの子も管理していない
    const desktop = new DesktopRuntimeAdapter({ sink: new FakeSink() });
    expect(desktop.has("a")).toBe(false);
    expect(stopDelegatedOf(desktop)("a")).toBe(true);
  });

  it("stopDelegated のない能力表（CLI）では偽", () => {
    const cli = {
      capabilities: () => ({
        send: "delayed" as const,
        stopGraceful: true,
        stopImmediate: true,
        hooks: "ok" as const,
        sessionId: true,
      }),
    };
    expect(stopDelegatedOf(cli)("a")).toBe(false);
  });
});
