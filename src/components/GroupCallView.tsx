import type { Bot, Group } from "@/state/store";

// Jarvis is intentionally one orchestrating voice. A room can contain many
// simultaneous bot turns, so exposing it as one realtime target would make
// ownership, steering and approvals ambiguous. Call a bot (preferably the
// Chief of Staff) and let its existing ask_bot tools coordinate the room.
export function GroupCallButton(_props: { group: Group; members: Bot[] }) { return null; }
export function GroupCallOverlay(_props: { group: Group; members: Bot[] }) { return null; }
