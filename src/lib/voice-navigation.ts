type VoiceNavigationTarget = { id: string; name: string; hidden?: boolean };

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const NAVIGATION_PREFIXES = [
  "ouvre",
  "affiche",
  "montre",
  "va sur",
  "passe a",
  "bascule sur",
  "open",
  "show",
  "switch to",
];

/** Resolve only explicit UI-navigation phrases. This intentionally does not
 * interpret task requests: actions still go through the model-facing,
 * approval-aware agent router. */
export function voiceNavigationTarget(
  transcript: string,
  targets: VoiceNavigationTarget[],
): string | null {
  const spoken = normalize(transcript);
  const prefix = NAVIGATION_PREFIXES.find((candidate) => spoken === candidate || spoken.startsWith(`${candidate} `));
  if (!prefix) return null;
  const requested = spoken.slice(prefix.length).trim().replace(/^(?:le |la |les )?(?:bot |conversation |agent )?/, "");
  if (!requested) return null;
  const matches = targets
    .filter((target) => !target.hidden)
    .map((target) => ({ id: target.id, name: normalize(target.name) }))
    .filter((target) => requested === target.name || requested.startsWith(`${target.name} `))
    .sort((a, b) => b.name.length - a.name.length);
  return matches[0]?.id ?? null;
}
