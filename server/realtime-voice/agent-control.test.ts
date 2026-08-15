import { describe, expect, it } from "vitest";

import { classifyAgentControl } from "./agent-control.ts";

describe("spoken agent control", () => {
  it.each([
    ["Où tu en es ?", "status"],
    ["what is the status?", "status"],
    ["Annule cette tâche", "cancel"],
    ["cancel the task", "cancel"],
    ["Après ça, vérifie aussi juillet", "followup"],
    ["when done, check July too", "followup"],
    ["Ne touche plus à Drive, regarde seulement Gmail", "steer"],
    ["Use Gmail instead of Drive", "steer"],
  ] as const)("classifies %s", (text, mode) => expect(classifyAgentControl(text)?.mode).toBe(mode));

  it("does not turn ordinary conversation into cancellation", () => {
    expect(classifyAgentControl("Explique comment annuler une tâche")).toBeNull();
    expect(classifyAgentControl("Sois plus bref")).toBeNull();
  });

  it("accepts the explicit GPT-Live control envelope even when its text is paraphrased", () => {
    expect(classifyAgentControl("[OPENMAUS_CONTROL:status] Statut de la demande précédente, est-elle terminée ?"))
      .toEqual({ mode: "status", text: "Statut de la demande précédente, est-elle terminée ?" });
    expect(classifyAgentControl("[OPENMAUS_CONTROL:steer] Limite désormais la recherche aux factures de juillet."))
      .toEqual({ mode: "steer", text: "Limite désormais la recherche aux factures de juillet." });
  });
});
