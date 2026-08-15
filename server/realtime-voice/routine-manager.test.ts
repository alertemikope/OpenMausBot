import { describe, expect, it, vi } from "vitest";

import type { Routine, RoutineInput } from "../routines.ts";
import { manageVoiceRoutine } from "./routine-manager.ts";

function harness(initial: Routine[] = []) {
  const routines = [...initial];
  const port = {
    listRoutines: () => routines.map((routine) => ({ ...routine })),
    create: vi.fn((input: RoutineInput) => {
      const routine = { id: `r-${routines.length + 1}`, createdAt: 1, updatedAt: 1, nextRunAt: 2, durationMinutes: 30, enabled: true, runOn: "maus" as const, ...input } as Routine;
      routines.push(routine);
      return routine;
    }),
    update: vi.fn((id: string, patch: Partial<RoutineInput>) => {
      const routine = routines.find((item) => item.id === id);
      if (!routine) return null;
      Object.assign(routine, patch);
      return routine;
    }),
    remove: vi.fn((id: string) => {
      const at = routines.findIndex((item) => item.id === id);
      if (at < 0) return false;
      routines.splice(at, 1);
      return true;
    }),
    runNow: vi.fn(() => ({ id: "run-1", routineId: "r-1" }) as never),
  };
  return { routines, port, bot: (id: string) => id === "luna" ? { id, name: "Luna Max" } : undefined };
}

describe("voice routine manager", () => {
  it("creates explicit validated recurring work", () => {
    const h = harness();
    const result = manageVoiceRoutine({ action: "create", name: "Morning brief", prompt: "Check mail", targetId: "luna", scheduleType: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] }, { ...h, routines: h.port });
    expect(result.message).toContain("Scheduled Morning brief with Luna Max");
    expect(h.port.create).toHaveBeenCalledWith(expect.objectContaining({ botId: "luna", schedule: { type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] } }));
  });

  it("rejects missing agents and past one-time work", () => {
    const h = harness();
    expect(() => manageVoiceRoutine({ action: "create", name: "Bad", prompt: "x", targetId: "missing", scheduleType: "daily", time: "08:30" }, { ...h, routines: h.port })).toThrow(/agent/i);
    expect(() => manageVoiceRoutine({ action: "create", name: "Past", prompt: "x", targetId: "luna", scheduleType: "once", at: "2024-01-01T00:00:00Z" }, { ...h, routines: h.port, now: () => Date.parse("2025-01-01T00:00:00Z") })).toThrow(/future/i);
  });

  it("manages a uniquely named routine without prompt matching", () => {
    const existing = { id: "r-1", name: "Morning brief", prompt: "x", botId: "luna", runOn: "maus", enabled: true, schedule: { type: "daily", time: "08:30", weekdays: [1] }, durationMinutes: 30, nextRunAt: 2, createdAt: 1, updatedAt: 1 } as Routine;
    const h = harness([existing]);
    expect(manageVoiceRoutine({ action: "pause", name: "morning BRIEF" }, { ...h, routines: h.port }).message).toContain("paused");
    expect(h.port.update).toHaveBeenCalledWith("r-1", { enabled: false });
    expect(manageVoiceRoutine({ action: "run_now", name: "Morning brief" }, { ...h, routines: h.port }).message).toContain("Started");
  });
});
