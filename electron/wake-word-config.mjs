export const DEFAULT_WAKE_WORD_CONFIG = Object.freeze({
  enabled: false,
  phrase: "Kenpachi",
});

/** Keep the passive listener's persisted input narrow and predictable. */
export function normalizeWakeWordConfig(input = {}) {
  const phrase = typeof input.phrase === "string"
    ? input.phrase.trim().replace(/\s+/g, " ").slice(0, 48)
    : DEFAULT_WAKE_WORD_CONFIG.phrase;
  return {
    enabled: input.enabled === true,
    phrase: phrase || DEFAULT_WAKE_WORD_CONFIG.phrase,
  };
}

/** Accept only the one native event shape the renderer is allowed to see. */
export function parseWakeWordLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value?.wake !== true || typeof value.text !== "string" || typeof value.phrase !== "string") {
    return null;
  }
  const text = value.text.trim();
  const phrase = value.phrase.trim();
  return text && phrase ? { text, phrase } : null;
}
