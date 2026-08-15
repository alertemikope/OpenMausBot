import { describe, expect, it, vi } from "vitest";

import { VoiceConfirmationController } from "./confirmation-controller.ts";

describe("voice confirmations", () => {
  it("binds exact one-shot consent to request, thread and summary", () => {
    const confirmations = new VoiceConfirmationController();
    confirmations.open({ requestId: "req-1", threadId: "thread-1", exactSummary: "Send email to Ada" });
    expect(confirmations.resolve("Oui, je confirme", { requestId: "req-1", threadId: "thread-1", exactSummary: "Send email to Ada" })).toBe("allow");
    expect(confirmations.resolve("oui", { requestId: "req-1", threadId: "thread-1", exactSummary: "Send email to Ada" })).toBe("none");
  });

  it("rejects ambiguous containment and changed requests", () => {
    const confirmations = new VoiceConfirmationController();
    confirmations.open({ requestId: "req-1", threadId: "thread-1", exactSummary: "Delete file A" });
    expect(confirmations.resolve("Oui mais pas maintenant", { requestId: "req-1", threadId: "thread-1", exactSummary: "Delete file A" })).toBe("ambiguous");
    expect(confirmations.resolve("Oui, je confirme", { requestId: "req-2", threadId: "thread-1", exactSummary: "Delete file B" })).toBe("mismatch");
  });

  it("expires and clears pending authority", () => {
    vi.useFakeTimers();
    try {
      const confirmations = new VoiceConfirmationController(5_000);
      confirmations.open({ requestId: "req-1", threadId: "thread-1", exactSummary: "Pay 10 euros" });
      vi.advanceTimersByTime(5_001);
      expect(confirmations.resolve("Yes, confirm", { requestId: "req-1", threadId: "thread-1", exactSummary: "Pay 10 euros" })).toBe("expired");
      expect(confirmations.current()).toEqual({ type: "none" });
    } finally {
      vi.useRealTimers();
    }
  });
});
