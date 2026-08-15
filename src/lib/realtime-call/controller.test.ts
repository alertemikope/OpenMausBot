import { describe, expect, it } from "vitest";

import { peerPhase } from "./controller";

describe("realtime provider phase mapping", () => {
  it.each([
    ["input_audio_buffer.speech_started", "hearing"],
    ["output_audio_buffer.started", "speaking"],
    ["response.output_audio_transcript.delta", "speaking"],
    ["response.function_call_arguments.done", "working"],
    ["response.done", "listening"],
    ["output_audio_buffer.stopped", "listening"],
  ] as const)("maps %s to %s", (type, phase) => {
    expect(peerPhase({ type })).toBe(phase);
  });
});
