import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VoiceTranscriptStore } from "./transcript-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("voice transcript store", () => {
  it("persists bounded committed text without audio and renders a recent-call map", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-voice-"));
    roots.push(root);
    const store = new VoiceTranscriptStore(root);
    const saved = store.save({
      sessionId: "voice-1",
      targetId: "luna",
      startedAt: 100,
      endedAt: 200,
      entries: [
        { role: "user", text: "  Vérifie   les mails ", at: 110 },
        { role: "assistant", text: "C'est fait.", at: 190 },
      ],
    });
    expect(saved?.summary).toBe("Vérifie les mails");
    expect(saved?.entries[0]).toMatchObject({ role: "user", text: "Vérifie les mails" });
    expect(JSON.stringify(saved)).not.toContain("audio");
    expect(store.get("voice-1")?.entries).toHaveLength(2);
    expect(store.recentContext()).toContain("Vérifie les mails");
    expect(store.remove("voice-1")).toBe(true);
    expect(store.get("voice-1")).toBeUndefined();
  });

  it("does not create empty call history", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-voice-"));
    roots.push(root);
    const store = new VoiceTranscriptStore(root);
    expect(store.save({ sessionId: "voice-empty", targetId: "luna", startedAt: 1, endedAt: 2, entries: [] })).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("clears the bounded local history", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-voice-"));
    roots.push(root);
    const store = new VoiceTranscriptStore(root);
    for (const sessionId of ["voice-1", "voice-2"]) {
      store.save({ sessionId, targetId: "luna", startedAt: 1, endedAt: 2, entries: [{ role: "user", text: sessionId, at: 1 }] });
    }
    expect(store.clear()).toBe(2);
    expect(store.list()).toEqual([]);
  });

  it("fences a Pi Memory mutation interrupted by application restart", () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-voice-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "voice-restart.json"), JSON.stringify({
      version: 2,
      sessionId: "voice-restart",
      targetId: "luna",
      startedAt: 1,
      endedAt: 2,
      summary: "preference",
      entries: [{ role: "user", text: "Je préfère bref.", at: 1 }],
      review: {
        status: "complete",
        updatedAt: 2,
        workingState: { decisions: [], commitments: [], openQuestions: [], deadlines: [] },
        memoryCandidates: [{ id: "candidate", text: "Je préfère bref.", sourceQuote: "Je préfère bref.", at: 1, kind: "preference", confidence: 0.9, status: "syncing", syncAction: "keep" }],
        followUpCandidates: [],
      },
    }));

    const store = new VoiceTranscriptStore(root);
    expect(store.get("voice-restart")?.review?.memoryCandidates[0]).toMatchObject({
      status: "syncing",
      syncError: expect.stringContaining("restarted"),
    });
  });
});
