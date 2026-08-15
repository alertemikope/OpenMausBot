import { describe, expect, it } from "vitest";

import { voiceNavigationTarget } from "./voice-navigation";

const bots = [
  { id: "luna", name: "Luna Max" },
  { id: "codex", name: "Codex" },
  { id: "hidden", name: "Secret", hidden: true },
];

describe("voice chat navigation", () => {
  it.each([
    ["Ouvre Codex", "codex"],
    ["Va sur Luna Max", "luna"],
    ["Passe à la conversation Luna Max s'il te plaît", "luna"],
    ["Show Codex", "codex"],
  ])("routes %s", (transcript, expected) => {
    expect(voiceNavigationTarget(transcript, bots)).toBe(expected);
  });

  it("does not turn ordinary tasks or hidden bots into navigation", () => {
    expect(voiceNavigationTarget("Demande à Codex de lire mes mails", bots)).toBeNull();
    expect(voiceNavigationTarget("Ouvre Secret", bots)).toBeNull();
    expect(voiceNavigationTarget("Ouvre un fichier", bots)).toBeNull();
  });
});
