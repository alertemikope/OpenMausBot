import { describe, expect, it } from "vitest";

import {
  DEFAULT_WAKE_WORD_CONFIG,
  normalizeWakeWordConfig,
  parseWakeWordLine,
} from "./wake-word-config.mjs";

describe("wake word configuration", () => {
  it("defaults to an off, local Kenpachi listener", () => {
    expect(normalizeWakeWordConfig()).toEqual(DEFAULT_WAKE_WORD_CONFIG);
  });

  it("normalizes and bounds a user phrase", () => {
    expect(normalizeWakeWordConfig({ enabled: true, phrase: "  Hey   Kenpachi  " })).toEqual({
      enabled: true,
      phrase: "Hey Kenpachi",
    });
    expect(normalizeWakeWordConfig({ enabled: true, phrase: " " }).phrase).toBe("Salut Kenpachi");
    expect(normalizeWakeWordConfig({ phrase: "x".repeat(80) }).phrase).toHaveLength(48);
  });

  it("admits only complete native wake commands", () => {
    expect(parseWakeWordLine('{"wake":true,"phrase":"Kenpachi","text":"ouvre Gmail"}')).toEqual({
      phrase: "Kenpachi",
      text: "ouvre Gmail",
    });
    expect(parseWakeWordLine('{"wake":true,"phrase":"Kenpachi","text":" "}')).toBeNull();
    expect(parseWakeWordLine('{"partial":true,"text":"Kenpachi"}')).toBeNull();
    expect(parseWakeWordLine("not json")).toBeNull();
  });
});
