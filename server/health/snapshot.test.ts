import { describe, expect, it } from "vitest";

import { buildRuntimeHealthSnapshot, type RuntimeHealthInput } from "./snapshot.ts";

function healthy(overrides: Partial<RuntimeHealthInput> = {}): RuntimeHealthInput {
  return {
    pid: 42,
    static: true,
    checkedAt: 100_000,
    uptimeSeconds: 12.9,
    providers: { configured: 2, loaded: 2 },
    work: { active: 0, queued: 0, waiting: 0, stale: 0, cancellationStuck: 0 },
    routines: { schedulerRunning: true, enabled: 1, active: 0, queued: 0, overdue: 0 },
    proactivity: { enabled: true, unread: 0, snoozed: 0 },
    voiceActive: false,
    integrations: { googleWorkspace: false, piMemory: false, composio: false, pennylane: false },
    ...overrides,
  };
}

describe("runtime health projection", () => {
  it("treats absent optional integrations and an idle voice as healthy", () => {
    const snapshot = buildRuntimeHealthSnapshot(healthy());
    expect(snapshot).toMatchObject({ app: "openmausbot", status: "ready", uptimeSeconds: 12, findings: [] });
    expect(snapshot.components.integrations.level).toBe("ok");
    expect(snapshot.components.voice.level).toBe("disabled");
  });

  it("reports only bounded operational facts for unavailable providers and stale work", () => {
    const snapshot = buildRuntimeHealthSnapshot(healthy({
      providers: { configured: 1, loaded: 0 },
      work: { active: 2, queued: 0, waiting: 0, stale: 1, cancellationStuck: 1 },
    }));
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.findings.map((item) => item.code)).toEqual([
      "providers.none_loaded",
      "work.stale",
      "work.cancellation_stuck",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|objective|result|token|email|bearer/i);
  });

  it("makes scheduler stoppage and overdue definitions visible without running actions", () => {
    const snapshot = buildRuntimeHealthSnapshot(healthy({
      routines: { schedulerRunning: false, enabled: 3, active: 0, queued: 1, overdue: 2 },
    }));
    expect(snapshot.components.routines.level).toBe("error");
    expect(snapshot.findings.map((item) => item.code)).toEqual([
      "routines.scheduler_stopped",
      "routines.overdue",
    ]);
  });

  it("keeps running with a loaded provider while exposing unavailable siblings", () => {
    const snapshot = buildRuntimeHealthSnapshot(healthy({ providers: { configured: 3, loaded: 2 } }));
    expect(snapshot.components.providers.level).toBe("warning");
    expect(snapshot.findings).toContainEqual(expect.objectContaining({ code: "providers.unavailable" }));
  });
});
