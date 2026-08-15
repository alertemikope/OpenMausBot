import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallMemoryService, extractCallMemory, type CanonicalMemoryPort } from "./call-memory.ts";
import { VoiceTranscriptStore } from "./transcript-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("post-call working memory", () => {
  it("extracts bounded candidates without executing commitments or retaining secrets", () => {
    const review = extractCallMemory([
      { role: "user", text: "On a décidé de livrer vendredi. Je vais envoyer le dossier demain.", at: 10 },
      { role: "assistant", text: "Compris.", at: 11 },
      { role: "user", text: "Je préfère des réponses courtes. Quelle validation manque ?", at: 12 },
      { role: "user", text: "Peut-être que mon équipe est à Lyon. Mon password est secret.", at: 13 },
    ], 100);

    expect(review.workingState.decisions[0]?.text).toContain("décidé");
    expect(review.workingState.commitments[0]?.text).toContain("Je vais");
    expect(review.workingState.deadlines.map((item) => item.text).join(" ")).toMatch(/vendredi|demain/);
    expect(review.workingState.openQuestions[0]?.text).toContain("validation");
    expect(review.followUpCandidates).toEqual([expect.objectContaining({ status: "proposed" })]);
    expect(review.memoryCandidates).toEqual([
      expect.objectContaining({ kind: "preference", status: "pending", text: "Je préfère des réponses courtes." }),
    ]);
    expect(JSON.stringify(review)).not.toMatch(/password est secret/i);
  });

  it("writes only after confirmation, corrects canonically, and forgets separately from transcript deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-call-memory-"));
    roots.push(root);
    const transcripts = new VoiceTranscriptStore(root);
    transcripts.save({
      sessionId: "voice-1",
      targetId: "luna",
      startedAt: 1,
      endedAt: 2,
      entries: [{ role: "user", text: "Je préfère des réponses courtes.", at: 1 }],
    });
    const memory: CanonicalMemoryPort = {
      write: vi.fn(async () => {
        expect(transcripts.get("voice-1")?.review?.memoryCandidates[0]?.status).toBe("syncing");
        return { id: "memory-1" };
      }),
      correct: vi.fn(async () => ({ id: "memory-2" })),
      forget: vi.fn(async () => {}),
    };
    let now = 10;
    const service = new CallMemoryService(transcripts, memory, () => now++);

    const processed = await service.process("voice-1");
    const candidate = processed?.review?.memoryCandidates[0];
    expect(candidate?.status).toBe("pending");
    expect(memory.write).not.toHaveBeenCalled();

    const kept = await service.review({ sessionId: "voice-1", candidateId: candidate!.id, action: "keep" });
    expect(memory.write).toHaveBeenCalledWith(expect.objectContaining({ type: "preference", content: candidate!.text }));
    expect(kept.review?.memoryCandidates[0]).toMatchObject({ status: "kept", memoryId: "memory-1" });

    const corrected = await service.review({
      sessionId: "voice-1",
      candidateId: candidate!.id,
      action: "correct",
      text: "Je préfère des réponses très concises.",
    });
    expect(memory.correct).toHaveBeenCalledWith(expect.objectContaining({ id: "memory-1", content: "Je préfère des réponses très concises." }));
    expect(corrected.review?.memoryCandidates[0]).toMatchObject({ status: "kept", memoryId: "memory-2" });

    await service.review({ sessionId: "voice-1", candidateId: candidate!.id, action: "forget" });
    expect(memory.forget).toHaveBeenCalledWith("memory-2");
    expect(transcripts.get("voice-1")?.review?.memoryCandidates[0]?.status).toBe("forgotten");
    expect(transcripts.remove("voice-1")).toBe(true);
    expect(transcripts.get("voice-1")).toBeUndefined();
  });

  it("records a failed canonical sync without losing the pending candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmaus-call-memory-"));
    roots.push(root);
    const transcripts = new VoiceTranscriptStore(root);
    transcripts.save({
      sessionId: "voice-failed-sync",
      targetId: "luna",
      startedAt: 1,
      endedAt: 2,
      entries: [{ role: "user", text: "Je préfère les réponses courtes.", at: 1 }],
    });
    const memory: CanonicalMemoryPort = {
      write: vi.fn(async () => { throw new Error("memory service offline"); }),
      correct: vi.fn(),
      forget: vi.fn(),
    };
    const service = new CallMemoryService(transcripts, memory);
    const call = await service.process("voice-failed-sync");
    const id = call!.review!.memoryCandidates[0]!.id;

    await expect(service.review({ sessionId: "voice-failed-sync", candidateId: id, action: "keep" })).rejects.toThrow("offline");
    expect(transcripts.get("voice-failed-sync")?.review?.memoryCandidates[0]).toMatchObject({
      status: "pending",
      syncError: "memory service offline",
    });
  });
});
