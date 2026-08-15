const MAX_LINES = 4_096;
const MAX_LINE_BYTES = 4_096;
const MAX_MEDIA_SECTIONS = 8;

export function assertAudioOnlyOffer(sdp: string): void {
  const lines = sdp.split(/\r\n|\n|\r/u);
  if (lines.length > MAX_LINES) throw new Error("Realtime SDP offer has too many lines");
  let mediaSections = 0;
  let activeAudio = 0;
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Realtime SDP offer line is too large");
    if (!line.startsWith("m=")) continue;
    if (++mediaSections > MAX_MEDIA_SECTIONS) throw new Error("Realtime SDP offer has too many media sections");
    const match = /^m=([A-Za-z0-9-]+)\s+(\d+)(?:\/\d+)?(?:\s|$)/u.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Realtime SDP offer has an invalid media section");
    const media = match[1].toLowerCase();
    const active = Number(match[2]) !== 0;
    if (media === "audio") activeAudio += Number(active);
    // ChatGPT Codex V3 carries transcripts/delegations on `oai-events`.
    // Its active RTCDataChannel is represented by m=application.
    else if (media !== "application") throw new Error(`Realtime calls do not support ${media} media`);
  }
  if (!activeAudio) throw new Error("Realtime calls require active audio media");
}
