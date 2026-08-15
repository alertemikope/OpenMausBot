import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentCall, deferCallCleanup, endCall, startCall } from "./call";

describe("call ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    endCall();
  });

  it("keeps one window-wide owner and refuses an overlapping call", () => {
    expect(startCall("bot-a")).toBe(true);
    expect(startCall("bot-b")).toBe(false);

    expect(endCall("bot-b")).toBe(false);
    expect(currentCall()).toBe("bot-a");
    expect(endCall("bot-a")).toBe(true);
    expect(currentCall()).toBeNull();
  });

  it("does not let StrictMode's effect probe hang up a new call", async () => {
    startCall("bot-a");
    let mounted = false;
    deferCallCleanup("bot-a", () => mounted);
    mounted = true;

    await Promise.resolve();

    expect(currentCall()).toBe("bot-a");
  });

  it("hangs up after a genuine call-screen unmount", async () => {
    startCall("bot-a");
    deferCallCleanup("bot-a", () => false);

    await Promise.resolve();

    expect(currentCall()).toBeNull();
  });
});
